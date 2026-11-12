/**
 * `session_projcache` title merge for the pure-JS engine.
 *
 * Each session has one shard document under `storages/session_projcache/sessions/`
 * holding `{ version, record: { identity, rows: { title: { val, seq } } } }`.
 * The title is the only field that travels: statistics and targets are per machine.
 * A newer `seq` wins, otherwise the side that has a title wins; a shared mirror is
 * written for every local shard so the other machine can pick it up.
 *
 * The merge is incremental: a shard whose mtime matches the previous snapshot on
 * both sides is skipped without parsing, which is what keeps large caches cheap.
 */
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  await fsp.rename(temporary, file);
}

/** Title row of one shard, tolerating both document shapes. */
export function titleOf(doc) {
  if (doc === null || typeof doc !== 'object') return undefined;
  const record = doc.record !== undefined && doc.record !== null ? doc.record : doc;
  const title = record?.rows?.title;
  return title !== undefined && title !== null && title.val !== undefined ? title : undefined;
}

/** Newer `seq` wins; otherwise the side that has a title wins. */
export function pickTitle(localTitle, sharedTitle) {
  if (sharedTitle === undefined) return localTitle;
  if (localTitle === undefined) return sharedTitle;
  return Number(localTitle.seq) >= Number(sharedTitle.seq) ? localTitle : sharedTitle;
}

function sameTitle(current, winner) {
  return current !== undefined
    && String(current.val) === String(winner.val)
    && Number(current.seq) === Number(winner.seq);
}

function setTitle(doc, winner) {
  const record = doc.record !== undefined && doc.record !== null ? doc.record : doc;
  record.rows = record.rows ?? {};
  record.rows.title = winner;
}

/** Map of session id -> { file, mtime } for one shard directory. */
async function indexShards(dir) {
  const map = new Map();
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('session-') || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = await fsp.stat(file);
      map.set(entry.name.slice(0, -5), { file, mtime: stat.mtimeMs });
    } catch {
      // A shard that vanished mid-scan is simply absent.
    }
  }
  return map;
}

/**
 * Merge titles between the local cache and its shared mirror.
 * @returns counters for the run summary.
 */
export async function mergeProjcacheTitles(deps) {
  const { localDir, sharedDir, stateDir, machineId, force = false, apply = true } = deps;
  const localIndex = await indexShards(localDir);
  const sharedIndex = await indexShards(sharedDir);
  if (localIndex.size === 0 && sharedIndex.size === 0) {
    return { parsed: 0, updated: 0, mirrored: 0, untouched: 0 };
  }

  const stateFile = path.join(stateDir, `projcache-state-${machineId}.json`);
  const previous = force ? {} : ((await readJson(stateFile)) ?? {});
  const previousLocal = previous.local ?? {};
  const previousShared = previous.shared ?? {};

  let parsed = 0;
  let updated = 0;
  let mirrored = 0;
  let untouched = 0;

  for (const id of new Set([...localIndex.keys(), ...sharedIndex.keys()])) {
    const localEntry = localIndex.get(id);
    const sharedEntry = sharedIndex.get(id);
    const currentLocal = localEntry === undefined ? -1 : localEntry.mtime;
    const currentShared = sharedEntry === undefined ? -1 : sharedEntry.mtime;
    if (!force && currentLocal === previousLocal[id] && currentShared === previousShared[id]) {
      untouched += 1;
      continue;
    }

    const localDoc = localEntry === undefined ? undefined : await readJson(localEntry.file);
    if (localEntry !== undefined) parsed += 1;
    const sharedDoc = sharedEntry === undefined ? undefined : await readJson(sharedEntry.file);
    if (sharedEntry !== undefined) parsed += 1;

    const localTitle = titleOf(localDoc);
    const sharedTitle = titleOf(sharedDoc);
    const winner = pickTitle(localTitle, sharedTitle);

    if (winner !== undefined && localEntry !== undefined && localDoc !== undefined && !sameTitle(localTitle, winner)) {
      setTitle(localDoc, winner);
      if (apply) await writeJson(localEntry.file, localDoc);
      updated += 1;
    }
    if (winner !== undefined && sharedEntry !== undefined && sharedDoc !== undefined && !sameTitle(sharedTitle, winner)) {
      setTitle(sharedDoc, winner);
      if (apply) await writeJson(sharedEntry.file, sharedDoc);
      updated += 1;
    }
    if (sharedEntry === undefined && localEntry !== undefined) {
      // No mirror yet: copy the whole shard so the share knows the session.
      await fsp.mkdir(sharedDir, { recursive: true });
      const target = path.join(sharedDir, `${id}.json`);
      if (apply) {
        try {
          await fsp.copyFile(localEntry.file, target);
          await fsp.utimes(target, new Date(localEntry.mtime), new Date(localEntry.mtime)).catch(() => {});
          mirrored += 1;
        } catch {
          // A shard that cannot be mirrored is retried next round; never abort.
        }
      } else {
        mirrored += 1;
      }
    }
  }

  if (apply && !force) {
    const nextLocal = {};
    for (const [id, entry] of await indexShards(localDir)) nextLocal[id] = entry.mtime;
    const nextShared = {};
    for (const [id, entry] of await indexShards(sharedDir)) nextShared[id] = entry.mtime;
    await writeJson(stateFile, {
      version: 1,
      machine: machineId,
      updatedAt: new Date().toISOString(),
      local: nextLocal,
      shared: nextShared,
    }).catch(() => {});
  }

  return { parsed, updated, mirrored, untouched };
}
