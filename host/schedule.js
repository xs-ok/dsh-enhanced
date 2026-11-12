/**
 * Automatic sync scheduling for DSH增强.
 *
 * Three triggers share one serial runner:
 *   - interval: every N minutes (settings.syncIntervalMinutes, 0 = off)
 *   - daily:    one run per day at HH:MM (settings.syncDailyAt)
 *   - idle:     the first time every agent leaves the running state
 *
 * A run never starts while a session is running, never overlaps another run, and
 * backs off after repeated failures. The engine itself stays the PowerShell
 * script; this module only decides when to call it.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readSettings } from './trash.js';
import { runSync } from './sync.js';
import { restartApplication } from './restart.js';

const TICK_MS = 60_000;
const IDLE_DELAY_MS = 30_000;
const FAILURE_LIMIT = 3;

function localDateKey(date) {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localClock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Local timestamp with offset, e.g. 2026-11-04 15:17:25+08:00 (human-readable log). */
function localStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hours}${minutes}`;
}

/**
 * Install the scheduler.
 * @param ctx - owning Cordis context.
 * @param deps - resolved paths and the agent registry.
 * @returns disposer that clears every timer and listener.
 */
export function installSyncScheduler(ctx, deps) {
  const { paths, agents } = deps;
  // One small trace file makes "why did it not run" answerable without a debugger.
  // It is trimmed to the newest 500 lines so it can stay on permanently.
  const traceFile = path.join(paths.base, 'scheduler.log');
  const TRACE_MAX_LINES = 500;
  let traceWrites = 0;
  const trimTrace = async () => {
    try {
      const text = await fsp.readFile(traceFile, 'utf8');
      const lines = text.split('\n');
      if (lines.length <= TRACE_MAX_LINES + 20) return;
      const kept = lines.slice(-(TRACE_MAX_LINES + 1));
      await fsp.writeFile(traceFile, kept.join('\n'), 'utf8');
    } catch {
      // Tracing is diagnostic only; never let it interfere.
    }
  };
  const trace = (message) => {
    void (async () => {
      try {
        await fsp.appendFile(traceFile, `${localStamp(new Date())} ${message}\n`, 'utf8');
        traceWrites += 1;
        if (traceWrites % 20 === 0) await trimTrace();
      } catch {
        // Ignore: the log is best effort.
      }
    })();
  };
  void trimTrace();
  trace(`install agents=${agents === undefined ? 'missing' : 'ok'} syncDir=${String(deps.settings?.syncDir ?? '')}`);
  let tick = null;
  let idleTimer = null;
  let retryTimer = null;
  let disposed = false;
  let running = false;
  let cooldownUntil = 0;
  let failures = 0;
  let paused = false;
  let pausedAt = null;
  let startupTimer = null;
  let lastIntervalAt = 0;
  let lastDailyKey = '';

  const note = (message, level = 'warn') => {
    const line = `dsh-enhanced sync: ${message}`;
    const logger = ctx.logger;
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](line);
    else if (level === 'error') console.error(line);
    else console.warn(line);
  };

  const busy = () => {
    try {
      return (agents?.list?.() ?? []).some((agent) => agent?.status === 'running');
    } catch {
      return false;
    }
  };

  /**
 * Restart so newly synced sessions become visible, but only when nobody is
 * working and the last automatic restart was long enough ago.
 */
async function restartForNewSessions(record, context) {
  const pulled = Number(record?.summary?.sessions?.pulled) || Number(record?.summary?.sessions?.created) || 0;
  if (pulled <= 0) return false;
  const { paths, settings, agents } = context;
  const busy = (agents?.list?.() ?? []).some((agent) => agent?.status === 'running');
  if (busy) {
    trace(`restart skipped: a session is running (${String(pulled)} new)`);
    return false;
  }
  const marker = path.join(paths.base, 'restart-last.json');
  let last = 0;
  try {
    const stored = JSON.parse(await fsp.readFile(marker, 'utf8'));
    if (Number.isFinite(Number(stored?.at))) last = Number(stored.at);
  } catch {
    last = 0;
  }
  // Reuse the sync cooldown: it already describes how often this machine acts.
  const gapMs = Math.max(0, Number(settings.syncCooldownMinutes) || 0) * 60_000;
  if (last > 0 && Date.now() - last < gapMs) {
    trace(`restart skipped: only ${String(Math.round((Date.now() - last) / 1000))}s since the last one`);
    return false;
  }
  try {
    await fsp.writeFile(marker, JSON.stringify({ at: Date.now(), pulled }), 'utf8');
  } catch {
    // A missing marker only means the next run may restart sooner.
  }
  trace(`restarting for ${String(pulled)} new sessions`);
  await restartApplication(paths);
  return true;
}

async function autoRun(reason) {
    if (disposed || running || paused) {
      trace(`autoRun ${reason}: ignored (disposed=${String(disposed)} running=${String(running)} paused=${String(paused)})`);
      return false;
    }
    if (Date.now() < cooldownUntil) {
      trace(`autoRun ${reason}: cooldown until ${new Date(cooldownUntil).toISOString()}`);
      // The cooldown is the only thing blocking; without this the run is lost,
      // because an idle that lasts minutes produces no further idle edge.
      if (retryTimer === null && !disposed) {
        const delay = Math.max(1000, cooldownUntil - Date.now() + 500);
        trace(`retry scheduled in ${String(Math.round(delay / 1000))}s (after cooldown)`);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void autoRun('cooldown-retry');
        }, delay);
      }
      return false;
    }
    let settings;
    try {
      settings = await readSettings(paths);
    } catch {
      trace(`autoRun ${reason}: settings unreadable`);
      return false;
    }
    if (settings.syncEnabled !== true) {
      trace(`autoRun ${reason}: syncEnabled is false`);
      return false;
    }
    if (busy()) {
      note(`${reason}: skipped, a session is running`);
      trace(`autoRun ${reason}: skipped, a session is running`);
      return false;
    }
    running = true;
    trace(`autoRun ${reason}: start`);
    try {
      const record = await runSync({ paths, settings, agents }, { probe: false });
      if (record.ok === true) {
        failures = 0;
        note(`${reason}: ok in ${String(record.durationMs)} ms`, 'info');
        await restartForNewSessions(record, { paths, settings, agents }).catch(() => {});
      } else {
        failures += 1;
        paused = failures >= FAILURE_LIMIT;
      if (paused && pausedAt === null) pausedAt = new Date().toISOString();
        if (paused && pausedAt === null) pausedAt = new Date().toISOString();
        note(`${reason}: failed (${String(failures)}/${String(FAILURE_LIMIT)})${paused ? ', auto sync paused' : ''}`, 'error');
      }
    } catch (error) {
      if (error?.code === 'webdav-throttled') {
        // The cloud asked us to back off: skip quietly instead of counting a failure.
        const minutes = Math.max(1, Math.ceil((Number(error.until) - Date.now()) / 60_000));
        note(`${reason}: throttled, waiting ${String(minutes)} min`, 'info');
        trace(`autoRun ${reason}: throttled until ${new Date(Number(error.until)).toISOString()}`);
        return false;
      }
      failures += 1;
      paused = failures >= FAILURE_LIMIT;
      if (paused && pausedAt === null) pausedAt = new Date().toISOString();
      trace(`autoRun ${reason} failed: ${String(error?.code ?? '')} ${String(error?.message ?? error)}`);
      if (!paused && retryTimer === null) {
        trace('retry scheduled in 60s');
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void autoRun('retry');
        }, 60_000);
      }
      note(`${reason}: ${String(error?.message ?? error)}${paused ? ', auto sync paused' : ''}`, 'error');
    } finally {
      running = false;
      cooldownUntil = Date.now() + Math.max(1, Number(settings.syncCooldownMinutes) || 5) * 60_000;
    }
  }

  async function onTick() {
    if (disposed || paused) return;
    let settings;
    try {
      settings = await readSettings(paths);
    } catch {
      return;
    }
    if (settings.syncEnabled !== true) return;

    const now = new Date();
    const intervalMinutes = Number(settings.syncIntervalMinutes) || 0;
    if (intervalMinutes > 0) {
      const due = lastIntervalAt === 0 ? false : Date.now() - lastIntervalAt >= intervalMinutes * 60_000;
      if (due && (await autoRun('interval'))) lastIntervalAt = Date.now();
    }

    const dailyAt = typeof settings.syncDailyAt === 'string' ? settings.syncDailyAt : '';
    if (dailyAt !== '' && localClock(now) === dailyAt && lastDailyKey !== localDateKey(now)) {
      // 只有真的跑起来才记日期，被忙碌/草稿挡住时下一分钟还会再试
      if (await autoRun('daily')) lastDailyKey = localDateKey(now);
    }
  }

  /** Arm one idle run; a later idle edge (or an emptied composer) replaces it. */
  function armIdle() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    trace('idle armed (+30s)');
    idleTimer = setTimeout(() => {
      idleTimer = null;
      trace('idle timer fired');
      void autoRun('idle');
    }, IDLE_DELAY_MS);
  }

  const status = () => ({ paused, failures, pausedAt, cooldownUntil, running });

  const resume = () => {
    failures = 0;
    paused = false;
    pausedAt = null;
    cooldownUntil = 0;
    trace('auto sync resumed by the user');
    return status();
  };

  // Catch up with other machines right after launch: the first idle edge may be
  // minutes away. The cooldown still applies, so a restart right after a sync
  // costs nothing.
  startupTimer = setTimeout(() => {
    void autoRun('startup');
  }, 5000);

  const statusListener = ctx.on('agent/status', (payload) => {
    trace(`agent/status=${String(payload?.status)}`);
    if (payload?.status === 'running' && retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
      trace('retry cancelled: a new task started');
    }
    if (payload?.status !== 'idle') return;
    armIdle();
  });

  tick = setInterval(() => { void onTick(); }, TICK_MS);

  const dispose = () => {
    disposed = true;
    if (tick !== null) clearInterval(tick);
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (startupTimer !== null) clearTimeout(startupTimer);
    if (typeof statusListener === 'function') statusListener();
  };

  return { dispose, status, resume };
}
