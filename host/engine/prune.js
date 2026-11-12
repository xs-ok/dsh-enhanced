/**
 * Old-generation cleanup for the pure-JS engine.
 *
 * The desktop app only reads the highest `session.v<N>` of a session, so older
 * artifacts are dead weight. Removing them is destructive, so every rule below
 * must hold before a file is touched:
 *
 *   1. the highest generation decodes cleanly (a corrupt newest copy means keep everything);
 *   2. that generation is not newer than the app understands;
 *   3. no older file is *newer* than the highest (an older app may have written it);
 *   4. every candidate is older than the grace window.
 *
 * Local files go to `<dshHome>/.sync-quarantine/<stamp>/…` (or straight away with
 * `hard`); shared copies are backed up the same way and then deleted. Runs are
 * throttled to once per 24 hours.
 */
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { scanSessionGroups } from './scan.js';
import { decodeBuffer, scanFrames } from './zstd.js';

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

/** Structural check: frames parse and every frame decompresses. */
export async function isHealthy(file) {
  try {
    const buffer = await fsp.readFile(file);
    const frames = scanFrames(buffer);
    if (frames.length === 0) return false;
    decodeBuffer(buffer);
    return true;
  } catch {
    return false;
  }
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Decide what to do with one session group; never mutates anything. */
export async function planGroup(group, options) {
  const { appGen, graceDays = 0, now = Date.now(), healthy } = options;
  const sorted = [...group.files].sort((a, b) => b.generation - a.generation || b.mtime - a.mtime);
  const high = sorted[0];
  const lows = sorted.filter((file) => file.generation < high.generation);
  if (lows.length === 0) return { action: 'skip', reason: 'single-generation' };

  const ok = healthy === undefined ? await isHealthy(high.path) : await healthy(high.path);
  if (!ok) return { action: 'keep', reason: 'highest generation failed verification', high, lows };
  if (appGen !== undefined && high.generation > appGen) {
    return { action: 'keep', reason: `app only supports v${String(appGen)}`, high, lows };
  }
  if (lows.some((file) => file.mtime > high.mtime)) {
    return { action: 'keep', reason: 'an older artifact is newer than the highest', high, lows };
  }
  if (graceDays > 0 && lows.some((file) => now - file.mtime < graceDays * 86_400_000)) {
    return { action: 'keep', reason: 'within the grace window', high, lows };
  }
  return { action: 'prune', high, lows };
}

/** Move one file into the quarantine tree, keeping side/project/session layout. */
async function quarantine(file, quarantineRoot, group, stampText, side) {
  const target = path.join(quarantineRoot, stampText, side, group.projectKey, group.id, path.basename(file.path));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(file.path, target).catch(async () => {
    await fsp.copyFile(file.path, `${target}.retry`);
    await fsp.rename(`${target}.retry`, target);
  });
  await fsp.rm(file.path, { force: true });
  return target;
}

/** Remove quarantine snapshots older than the retention window. */
export async function purgeQuarantine(quarantineRoot, days, apply = true) {
  if (!(days > 0)) return 0;
  let entries;
  try {
    entries = await fsp.readdir(quarantineRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(quarantineRoot, entry.name);
    const stat = await fsp.stat(dir).catch(() => undefined);
    if (stat === undefined || stat.mtimeMs >= cutoff) continue;
    removed += 1;
    if (apply) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return removed;
}

/**
 * Run the pruning pass.
 * @returns counters matching the PowerShell summary (`quarantined`, `hardDeleted`,
 *   `sharedDeleted`, `kept`, `throttled`, `quarantinePurged`) plus per-file reasons.
 */
export async function pruneOldGenerations(deps) {
  const {
    localRoot,
    sharedRoot,
    dshHome,
    stateDir,
    machineId,
    appGen,
    throttleHours = 24,
    graceDays = 7,
    quarantineDays = 15,
    hard = false,
    pruneNow = false,
    apply = true,
    now = Date.now(),
  } = deps;

  const stats = { quarantined: 0, hardDeleted: 0, sharedDeleted: 0, kept: 0, throttled: 0, quarantinePurged: 0, details: [] };
  const stateFile = path.join(stateDir, `prune-${machineId}.json`);

  if (!pruneNow && throttleHours > 0) {
    const last = await readJson(stateFile, undefined);
    const lastAt = typeof last?.at === 'string' ? Date.parse(last.at) : Number.NaN;
    if (Number.isFinite(lastAt) && (now - lastAt) < throttleHours * 3_600_000) {
      stats.throttled = 1;
      return stats;
    }
  }

  const local = await scanSessionGroups(localRoot);
  const shared = await scanSessionGroups(sharedRoot);
  const quarantineRoot = path.join(dshHome, '.sync-quarantine');
  const stampText = stamp(new Date(now));

  for (const [side, groups] of [['local', local], ['shared', shared]]) {
    for (const group of groups.values()) {
      const plan = await planGroup(group, { appGen, graceDays, now });
      if (plan.action === 'skip') continue;
      if (plan.action === 'keep') {
        stats.kept += 1;
        stats.details.push({ side, id: group.id, action: 'keep', reason: plan.reason });
        continue;
      }
      for (const file of plan.lows) {
        if (!apply) {
          stats.details.push({ side, id: group.id, action: 'dry-run', file: file.name });
          if (side === 'local') stats.quarantined += 1;
          else stats.sharedDeleted += 1;
          continue;
        }
        if (hard) {
          await fsp.rm(file.path, { force: true }).catch(() => {});
          if (side === 'local') stats.hardDeleted += 1;
          else stats.sharedDeleted += 1;
          stats.details.push({ side, id: group.id, action: 'hard-deleted', file: file.name });
          continue;
        }
        await quarantine(file, quarantineRoot, group, stampText, side).catch(() => {});
        if (side === 'local') stats.quarantined += 1;
        else stats.sharedDeleted += 1;
        stats.details.push({ side, id: group.id, action: 'quarantined', file: file.name });
      }
    }
  }

  if (apply) {
    stats.quarantinePurged = await purgeQuarantine(quarantineRoot, quarantineDays, apply);
    await writeJson(stateFile, { version: 1, machine: machineId, at: new Date(now).toISOString() }).catch(() => {});
  }
  return stats;
}
