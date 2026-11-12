/**
 * Pure-JS sync engine entry point.
 *
 * Orchestrates the pieces that were ported one by one — sessions, workspace.json,
 * projcache titles, plugin list, config files, attachments, old-generation
 * pruning — and returns the same summary shape as the PowerShell engine so the
 * plugin can switch between them without touching the UI.
 */
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { syncSessions } from './sessions.js';
import { scanSessionGroups, scanSessions } from './scan.js';
import { readSessionFile } from './session.js';
import { loadPathMap, resolveLocalPath } from './paths.js';
import { mergeWorkspaceFiles } from './workspace.js';
import { pruneArchiveEvents, syncArchiveState, writeArchiveEvents } from './archive.js';
import { mergeProjcacheTitles } from './projcache.js';
import { syncConfigFiles } from './config.js';
import { syncPluginList } from './pluginlist.js';
import { syncAttachments } from './attachments.js';
import { pruneOldGenerations } from './prune.js';

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
}

/**
 * The host validates every workspace record with `path: z.string()`; one bad
 * value makes the whole registry fail to activate, so never write such a file.
 */
function validWorkspaceDoc(doc) {
  if (doc === null || typeof doc !== 'object') return false;
  const table = doc.tables?.workspaces;
  if (table === null || typeof table !== 'object') return false;
  return Object.values(table).every((record) => typeof record?.path === 'string' && record.path !== '');
}

async function isDirectory(target) {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Local archived ids from this machine's workspace document. */
async function localArchivedIds(dshHome) {
  const doc = await readJson(path.join(dshHome, 'storages', 'workspace.json'), undefined);
  const ids = doc?.global?.archivedSessionIds;
  return new Set(Array.isArray(ids) ? ids : []);
}

/** Tombstoned session ids, so merged documents stop listing deleted sessions. */
async function tombstoneIds(stateDir) {
  const doc = await readJson(path.join(stateDir, 'deleted-sessions.json'), undefined);
  return new Set(Object.keys(doc?.deleted ?? {}));
}

/**
 * Run one full sync.
 * @param deps - paths plus identity; `apply: false` turns every write into a report.
 */
/** One sync at a time per process: manual and scheduled runs share this lock. */
let syncInFlight = null;

export function syncInFlightLabel() {
  return syncInFlight;
}

export async function runSyncJs(deps) {
  if (syncInFlight !== null) {
    throw Object.assign(new Error('已有同步正在进行，请等待本轮结束'), { code: 'sync-busy', since: syncInFlight });
  }
  syncInFlight = new Date().toISOString();
  try {
    return await runSyncJsInner(deps);
  } finally {
    syncInFlight = null;
  }
}

async function runSyncJsInner(deps) {
  const {
    dshHome,
    syncDir,
    machineId,
    user = '',
    profile = 'desktop',
    apply = true,
    pruneNow = false,
    now = Date.now(),
    failPhase,
  } = deps;

  const startedAt = new Date(now).toISOString();
  const stateDir = path.join(syncDir, 'config', 'sync-state');
  const localSessions = path.join(dshHome, 'sessions');
  try {
    const stat = await fsp.stat(localSessions);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw Object.assign(new Error(`会话目录不存在或不可读：${localSessions}，已中止同步`), { code: 'sessions-root-missing' });
  }

  const sharedSessions = path.join(syncDir, 'sessions');
  const sharedConfig = path.join(syncDir, 'config');
  const missingGroups = [];

  // Every phase reports its own outcome. A failure stops the run, and the record
  // says exactly which steps finished — the next sync redoes the rest, because a
  // step that already succeeded simply finds nothing left to do.
  const phases = [];
  const failedPhase = { name: null, error: null };
  const step = async (name, run) => {
    if (failPhase === name) {
      failedPhase.name = name;
      failedPhase.error = `injected failure: ${name}`;
      throw Object.assign(new Error(failedPhase.error), { code: 'phase-failed', phase: name });
    }
    try {
      const value = await run();
      phases.push({ name, ok: true });
      return value;
    } catch (error) {
      failedPhase.name = name;
      failedPhase.error = String(error?.message ?? error);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { phase: name });
    }
  };

  let sessions = { pushed: 0, pulled: 0, skipped: 0, created: 0, missing: 0, aborted: null };
  let prune = { quarantined: 0, hardDeleted: 0, sharedDeleted: 0, kept: 0, throttled: 0, quarantinePurged: 0 };
  let archive = { archived: [], released: [], events: {} };
  let workspace = { local: null, shared: null, missing: [] };
  let projcache = { parsed: 0, updated: 0, mirrored: 0, untouched: 0 };
  let pluginList = { count: 0, file: '' };
  let config = { copied: 0, skipped: 0, invalid: [], details: [] };
  let attachments = { pushed: 0, pulled: 0, skipped: 0 };
  let prunedEvents = { removed: 0 };

  try {
    const mappings = await loadPathMap(syncDir, machineId);
    const resolveCwd = async (cwd) => resolveLocalPath(cwd, { mappings, currentUser: user, create: apply });

    let appGen = deps.appGen;
    if (appGen === undefined) {
      try {
        const groups = await scanSessionGroups(localSessions);
        appGen = Math.max(0, ...[...groups.values()].flatMap((g) => g.files.map((f) => f.generation)));
      } catch {
        appGen = undefined;
      }
    }

    sessions = await step('sessions', () => syncSessions({
      localRoot: localSessions,
      sharedRoot: sharedSessions,
      stateDir,
      machineId,
      resolveCwd,
      apply,
      journalFile: path.join(dshHome, 'dsh-enhanced', 'delete-journal.json'),
    }));

    prune = await step('prune', () => pruneOldGenerations({
      localRoot: localSessions,
      sharedRoot: sharedSessions,
      dshHome,
      stateDir,
      machineId,
      appGen,
      graceDays: 7,
      apply,
      pruneNow,
      now,
    }));

    const archivedBefore = await localArchivedIds(dshHome);
    archive = await step('archive', () => syncArchiveState({ stateDir, machineId, localArchived: archivedBefore, apply }));
    const tombstones = await tombstoneIds(stateDir);

    workspace = await step('workspace', () => mergeWorkspaceFiles({
      localFile: path.join(dshHome, 'storages', 'workspace.json'),
      sharedFile: path.join(sharedConfig, 'storages', 'workspace.json'),
      tombstones,
      resolvePath: async (value) => (await resolveCwd(value)).path,
      // Lazy session lookup: only paid when a merge finds duplicate memberships.
      sessionCwd: async (id) => {
        const found = (await scanSessions(path.join(dshHome, 'sessions'))).get(id);
        if (found === undefined) return null;
        try {
          return (await readSessionFile(found.file)).header.cwd ?? null;
        } catch {
          return null;
        }
      },
      isDirectory,
      stateDir,
      machineId,
      apply,
    }));

    if (workspace.skipped === undefined) {
      missingGroups.push(...workspace.missing);
      const stillArchived = new Set();
      for (const doc of [workspace.local, workspace.shared]) {
        for (const id of doc.global?.archivedSessionIds ?? []) stillArchived.add(id);
      }
      prunedEvents = pruneArchiveEvents(archive.events, stillArchived);
      if (apply && prunedEvents.removed > 0) await writeArchiveEvents(stateDir, prunedEvents.events);

      const released = new Set(archive.released);
      const effective = archive.archived;
      for (const doc of [workspace.local, workspace.shared]) {
        doc.global = doc.global ?? {};
        const own = Array.isArray(doc.global.archivedSessionIds) ? doc.global.archivedSessionIds : [];
        const merged = new Set([...own, ...effective].filter((id) => id && !released.has(id)));
        doc.global.archivedSessionIds = [...merged].sort();
      }
      if (apply) {
        if (validWorkspaceDoc(workspace.local)) {
          await writeJson(path.join(dshHome, 'storages', 'workspace.json'), workspace.local);
        } else {
          workspace.error = '本机 workspace 合并结果含非法 path，已跳过写入';
        }
        if (validWorkspaceDoc(workspace.shared)) {
          await writeJson(path.join(sharedConfig, 'storages', 'workspace.json'), workspace.shared);
        } else {
          workspace.error = '共享 workspace 合并结果含非法 path，已跳过写入';
        }
      }
    }

    projcache = await step('titles', () => mergeProjcacheTitles({
      localDir: path.join(dshHome, 'storages', 'session_projcache', 'sessions'),
      sharedDir: path.join(sharedConfig, 'storages', 'session_projcache', 'sessions'),
      stateDir,
      machineId,
      force: !apply,
      apply,
    }));

    pluginList = await step('plugins', () => (apply
      ? syncPluginList({ dshHome, sharedConfigDir: sharedConfig, machineId })
      : { count: 0, file: '' }));

    config = await step('config', () => (apply
      ? syncConfigFiles({ localBase: dshHome, sharedBase: sharedConfig, profile, currentUser: user, stagingDir: path.join(dshHome, 'dsh-enhanced', 'pending') })
      : { copied: 0, skipped: 0, invalid: [], details: [] }));

    if (deps.skipAttachments === true) {
      phases.push({ name: 'attachments', ok: true, skipped: true });
    } else {
      attachments = await step('attachments', () => syncAttachments({
      localRoot: path.join(dshHome, 'attachments', 'v1'),
        sharedRoot: path.join(syncDir, 'attachments', 'v1'),
        apply,
      }));
    }
  } catch (error) {
    return {
      version: 1,
      ok: false,
      kind: 'sync',
      engine: 'js',
      machine: machineId,
      user,
      dshHome,
      syncDir,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - now,
      phases,
      failed: { phase: failedPhase.name, error: failedPhase.error ?? String(error?.message ?? error) },
      note: '本轮中止；已完成的步骤是幂等的，下一次同步会自动补齐剩余部分',
      sessions: { copied: sessions.pushed + sessions.pulled, skipped: sessions.skipped, pushed: sessions.pushed, pulled: sessions.pulled, pushedIds: sessions.pushedIds ?? [], pulledIds: sessions.pulledIds ?? [], aborted: sessions.aborted ?? null },
      config: { copied: config.copied, skipped: config.skipped, invalid: config.invalid.length },
      configDetails: config.details ?? [],
      attachments: { copied: attachments.pushed + attachments.pulled, skipped: attachments.skipped },
      prune: { quarantined: prune.quarantined, hardDeleted: prune.hardDeleted, sharedDeleted: prune.sharedDeleted, kept: prune.kept, throttled: prune.throttled, quarantinePurged: prune.quarantinePurged ?? 0 },
      workspace: { local: Object.keys(workspace.local?.tables?.workspaces ?? {}).length, shared: Object.keys(workspace.shared?.tables?.workspaces ?? {}).length, skipped: workspace.skipped ?? null, error: workspace.error ?? null },
      titleMerge: projcache,
      plugins: pluginList.count,
      archive: { released: archive.released.length, archived: archive.archived.length, eventsPruned: prunedEvents.removed },
      missing: { sessions: sessions.missing ?? 0, groups: missingGroups.length },
      paths: { created: sessions.created ?? 0, failed: sessions.missing ?? 0 },
    };
  }

  return {
    version: 1,
    ok: true,
    kind: 'sync',
    engine: 'js',
    machine: machineId,
    user,
    dshHome,
    syncDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - now,
    phases,
    sessions: { copied: sessions.pushed + sessions.pulled, skipped: sessions.skipped, pushed: sessions.pushed, pulled: sessions.pulled, pushedIds: sessions.pushedIds ?? [], pulledIds: sessions.pulledIds ?? [], aborted: sessions.aborted ?? null },
    config: { copied: config.copied, skipped: config.skipped, invalid: config.invalid.length },
    configDetails: config.details ?? [],
    attachments: { copied: attachments.pushed + attachments.pulled, skipped: attachments.skipped },
    prune: {
      quarantined: prune.quarantined,
      hardDeleted: prune.hardDeleted,
      sharedDeleted: prune.sharedDeleted,
      kept: prune.kept,
      throttled: prune.throttled,
      quarantinePurged: prune.quarantinePurged ?? 0,
    },
    workspace: { local: Object.keys(workspace.local?.tables?.workspaces ?? {}).length, shared: Object.keys(workspace.shared?.tables?.workspaces ?? {}).length, skipped: workspace.skipped ?? null, error: workspace.error ?? null },
    titleMerge: projcache,
    plugins: pluginList.count,
    archive: { released: archive.released.length, archived: archive.archived.length, eventsPruned: prunedEvents.removed },
    missing: { sessions: sessions.missing ?? 0, groups: missingGroups.length },
    paths: { created: sessions.created ?? 0, failed: sessions.missing ?? 0 },
  };
}
