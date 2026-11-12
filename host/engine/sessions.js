/**
 * Session synchronization for the pure-JS engine.
 *
 * Two directions, one arbitration rule: a higher artifact generation always wins,
 * and only equal generations compare by mtime (matching the PowerShell engine).
 * Deletions ride on tombstones, and a copy newer than its tombstone revives it.
 */
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { scanSessions, projectKey } from './scan.js';
import { lastContentSeq, readSessionFile, rewriteCwd, writeSessionFile } from './session.js';
import {
  SESSION_LEDGER,
  mergeJournal,
  readJson as readLedgerJson,
  readLedger,
  writeJsonAtomic,
  writeLedger,
} from './ledger.js';

/**
 * Distinguish "missing" from "corrupt": a damaged tombstone table used to read
 * as empty, which resurrects every deleted session.
 */
async function readJsonStrict(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return { value: JSON.parse(text), corrupt: false };
  } catch (error) {
    return { value: undefined, corrupt: error?.code !== 'ENOENT' };
  }
}

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

/** Delete copies of one session that sit under a different project key. */
async function dropOtherCopies(localRoot, id, keepDir) {
  let projects;
  try {
    projects = await fsp.readdir(localRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(localRoot, project.name, id);
    if (candidate === keepDir) continue;
    try {
      await fsp.stat(candidate);
    } catch {
      continue;
    }
    await fsp.rm(candidate, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Move a shared session copy into the shared recycle bin instead of deleting it.
 * The other machine can then restore the newest content, not just the fact that
 * the session once existed.
 */
async function sessionTitle(sharedRoot, id) {
  try {
    const file = path.join(path.dirname(sharedRoot), 'config', 'storages', 'session_projcache', 'sessions', `${id}.json`);
    const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
    const value = doc?.record?.rows?.title?.val;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
  } catch {
    return '';
  }
}

async function moveToTrash(entry, trashRoot, ledgerEntry) {
  const bucketName = typeof ledgerEntry?.workspace === 'string' && ledgerEntry.workspace !== ''
    ? ledgerEntry.workspace
    : '_ungrouped';
  const target = path.join(trashRoot, bucketName, entry.id);
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(entry.dir, path.join(target, 'log'), { recursive: true, force: true });
  await fsp.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  const title = await sessionTitle(path.dirname(trashRoot), entry.id);
  await writeJsonAtomic(path.join(target, 'meta.json'), {
    version: 1,
    sessionId: entry.id,
    title: title === '' ? entry.id : title,
    workspaceId: bucketName,
    deletedAt: ledgerEntry?.at ?? new Date().toISOString(),
    sizeBytes: ledgerEntry?.size ?? 0,
    mtime: ledgerEntry?.mtime ?? entry.mtime,
    source: 'sync',
  });
}

/** True when `candidate` should replace `current` (generation first, then mtime). */
export function wins(candidate, current) {
  if (current === undefined) return true;
  if (candidate.generation !== current.generation) return candidate.generation > current.generation;
  // File systems and utimes round sub-millisecond stamps; treat that as a tie.
  return candidate.mtime > current.mtime + 1;
}

/** Copy one session into a target root under the project key of its cwd. */
async function copySessionTo(source, targetRoot) {
  const parsed = await readSessionFile(source.file);
  const cwd = parsed.header.cwd;
  const key = projectKey(cwd);
  const dir = path.join(targetRoot, key, source.id);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, path.basename(source.file));
  await writeSessionFile(target, parsed.texts);
  // Preserve the source timestamp: equal mtimes are what stop push/pull ping-pong.
  const seconds = source.mtime / 1000;
  await fsp.utimes(target, seconds, seconds).catch(() => {});
  return target;
}

/**
 * Run the session half of a sync.
 * @returns counters plus the ids that were skipped or failed.
 */
export async function syncSessions(deps) {
  const {
    localRoot,
    sharedRoot,
    stateDir,
    machineId,
    resolveCwd = async (cwd) => ({ path: cwd, action: 'existed' }),
    skipIds = new Set(),
    apply = true,
    journalFile = null,
    sharedTrashRoot = path.join(path.dirname(sharedRoot), 'trash'),
  } = deps;

  const local = await scanSessions(localRoot);
  const shared = await scanSessions(sharedRoot);
  const legacyFile = path.join(stateDir, 'deleted-sessions.json');
  const machineFile = path.join(stateDir, `machine-${machineId}.json`);

  const ledger = await readLedger(stateDir, SESSION_LEDGER);
  if (journalFile !== null && apply) await mergeJournal(stateDir, journalFile, ledger, 'sessions');

  // Old tombstone documents only carry an id and a time; fold them in once so a
  // deleted session cannot come back merely because the format changed.
  const legacyRead = await readJsonStrict(legacyFile);
  if (legacyRead.corrupt) {
    throw Object.assign(
      new Error('deleted-sessions.json 已损坏，为避免已删除的会话复活，本轮同步已中止'),
      { code: 'tombstone-corrupt' },
    );
  }
  for (const [id, iso] of Object.entries(legacyRead.value?.deleted ?? {})) {
    if (typeof id !== 'string') continue;
    if (ledger.deleted[id] !== undefined) continue;
    ledger.deleted[id] = { at: String(iso), legacy: true };
  }

  const previous = await readJson(machineFile, { version: 1, keys: {} });
  const previousIds = new Set(Object.keys(previous.keys ?? {}));

  let pushed = 0;
  let pulled = 0;
  let skipped = 0;
  let revived = 0;
  let tombstoned = 0;
  const failed = [];
  const pushedIds = [];
  const pulledIds = [];

  // 1. Local deletions become ledger entries, with the file facts of the copy
  //    this machine still knows about (mtime/size) so the recycle bin can pick
  //    the newest version later.
  const now = new Date().toISOString();
  for (const id of previousIds) {
    if (local.has(id) || ledger.deleted[id] !== undefined) continue;
    const sharedCopy = shared.get(id);
    ledger.deleted[id] = {
      at: now,
      mtime: sharedCopy?.mtime ?? 0,
      size: sharedCopy?.size ?? 0,
      by: machineId,
    };
    tombstoned += 1;
  }

  // A run where the local root was unreadable looks exactly like "every session
  // was deleted". Refuse only when the directory cannot be read, or when the whole
  // home looks wiped — deleting the last session must still propagate.
  let readable = true;
  try {
    await fsp.readdir(localRoot);
  } catch {
    readable = false;
  }
  let homeEvidence = false;
  try {
    await fsp.stat(path.join(path.dirname(localRoot), 'storages', 'workspace.json'));
    homeEvidence = true;
  } catch {
    homeEvidence = false;
  }
  if (apply && !readable) {
    return {
      pushed: 0, pulled: 0, skipped: 0, revived: 0, tombstoned: 0,
      created: 0, missing: 0, failed: [],
      aborted: '本机会话目录不可读，已中止并保留删除记录',
    };
  }
  if (apply && previousIds.size > 0 && local.size === 0 && !homeEvidence) {
    return {
      pushed: 0, pulled: 0, skipped: 0, revived: 0, tombstoned: 0,
      created: 0, missing: 0, failed: [],
      aborted: '本机看起来已被清空（缺少 workspace.json），已中止本轮以防误删',
    };
  }

  // 2. A local copy newer than its deletion record means the user restored it.
  for (const [id, record] of [...Object.entries(ledger.deleted)]) {
    const entry = local.get(id);
    if (entry === undefined) continue;
    const deletedAt = Date.parse(record.at ?? '');
    if (!Number.isFinite(deletedAt) || entry.mtime > deletedAt + 1) {
      delete ledger.deleted[id];
      revived += 1;
    }
  }

  // 3. Apply the remaining deletions. Shared copies move into the shared recycle
  //    bin so the other machine can still restore them; local copies go away.
  for (const [id, record] of Object.entries(ledger.deleted)) {
    const sharedEntry = shared.get(id);
    if (sharedEntry !== undefined) {
      if (apply) await moveToTrash(sharedEntry, sharedTrashRoot, record).catch(() => {});
      shared.delete(id);
    }
    const localEntry = local.get(id);
    if (localEntry !== undefined) {
      if (apply) await fsp.rm(localEntry.dir, { recursive: true, force: true }).catch(() => {});
      local.delete(id);
    }
  }

  // 3. Push local sessions the share does not have (or has in an older state).
  for (const [id, entry] of local) {
    if (ledger.deleted[id] !== undefined) continue;
    if (skipIds.has(id)) {
      skipped += 1;
      continue;
    }
    const sharedEntry = shared.get(id);
    // Append-only logs: the one holding more events is the newer one. Upload and
    // download timestamps are meaningless here because each transfer rewrites them.
    if (sharedEntry !== undefined) {
      const localSeq = await lastContentSeq(entry.file);
      const sharedSeq = await lastContentSeq(sharedEntry.file);
      if (sharedSeq >= 0 && localSeq >= 0) {
        if (sharedSeq >= localSeq) {
          skipped += 1;
          continue;
        }
      } else if (!wins(entry, sharedEntry)) {
        skipped += 1;
        continue;
      }
    }
    try {
      if (apply) await copySessionTo(entry, sharedRoot);
      pushed += 1;
      if (pushedIds.length < 300) pushedIds.push(id);
    } catch (error) {
      failed.push({ id, error: String(error?.message ?? error) });
    }
  }

  const refreshedShare = await scanSessions(sharedRoot);

  // 4. Pull shared sessions this machine lacks or holds in an older state.
  let created = 0;
  let missing = 0;
  for (const [id, entry] of refreshedShare) {
    if (ledger.deleted[id] !== undefined) continue;
    if (skipIds.has(id)) continue;
    const localEntry = local.get(id);
    if (localEntry !== undefined) {
      const sharedSeq = await lastContentSeq(entry.file);
      const localSeq = await lastContentSeq(localEntry.file);
      if (sharedSeq >= 0 && localSeq >= 0) {
        // Same event count means the only difference is this machine's cwd, which
        // is not worth a transfer.
        if (sharedSeq <= localSeq) continue;
      } else if (!wins(entry, localEntry)) {
        continue;
      }
    }
    try {
      const parsed = await readSessionFile(entry.file);
      const resolved = await resolveCwd(parsed.header.cwd);
      if (resolved.action === 'created') created += 1;
      if (resolved.action === 'missing') {
        missing += 1;
        continue;
      }
      const texts = rewriteCwd(parsed, resolved.path).texts;
      const dir = path.join(localRoot, projectKey(resolved.path), id);
      const target = path.join(dir, path.basename(entry.file));
      if (apply) await dropOtherCopies(localRoot, id, dir);
      if (apply) {
        await fsp.mkdir(dir, { recursive: true });
        await writeSessionFile(target, texts);
        const seconds = entry.mtime / 1000;
        await fsp.utimes(target, seconds, seconds).catch(() => {});
      }
      pulled += 1;
      if (pulledIds.length < 300) pulledIds.push(id);
    } catch (error) {
      failed.push({ id, error: String(error?.message ?? error) });
    }
  }

  // 5. Remember what this machine holds so the next run can spot deletions.
  const keys = {};
  for (const [id, entry] of (await scanSessions(localRoot))) keys[id] = new Date(entry.mtime).toISOString();
  if (apply) await writeJson(machineFile, { version: 1, machine: machineId, updatedAt: now, keys });
  if (apply) await writeLedger(stateDir, SESSION_LEDGER, ledger);
  if (apply && (tombstoned > 0 || revived > 0) && legacyRead.value !== undefined) {
    // The legacy document is superseded; keep only its shape so an older build
    // does not treat the missing file as "nothing was ever deleted".
    await writeJsonAtomic(legacyFile, { version: 1, deleted: {} });
  }

  return { pushed, pulled, skipped, revived, tombstoned, created, missing, failed, trashed: Object.keys(ledger.deleted).length, pushedIds, pulledIds };
}
