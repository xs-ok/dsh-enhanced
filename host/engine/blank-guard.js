/**
 * Blank-session guard.
 *
 * DSH keeps one projection shard per session under
 * `storages/session_projcache/sessions/<id>.json`, and a session that was created
 * but never used leaves `sessionListMetadata.blank = true` in it. Uploading that
 * shard while the conversation is still empty is what poisons a share: DSH may
 * never rewrite the flag once real turns arrive, so every machine that pulls the
 * shard afterwards reads "blank" and hides the conversation from its list.
 *
 * The guard runs once per sync, before anything is copied:
 *
 *  - `blank === true` and the log holds at least one turn: the shard is stale —
 *    repair it (`blank = false`, `seq` = last event) and let the session sync;
 *  - `blank === true` and the log holds no turn: a genuinely empty session —
 *    keep it, its shard and its recycle-bin copy out of the share.
 *  - a shard with no log at all: the session was created and abandoned before
 *    the first event, so the shard is the only trace of it — that shard stays
 *    out of the share too.
 *
 * A log that cannot be judged (unreadable file, Node without zstd) is left alone:
 * nothing is skipped and nothing is rewritten, so a broken file can never block a
 * real conversation.
 */
import { promises as fsp } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { scanSessions } from './scan.js';
import { writeJsonAtomic } from './ledger.js';

/** Session logs are written as concatenated zstd frames, one per append batch. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const TURN_MARK = '"turn/start"';
const MAX_REPORTED_IDS = 50;

/** Absolute path of one session's projection shard. */
export function shardPath(cacheDir, sessionId) {
  return path.join(cacheDir, `${sessionId}.json`);
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Start offsets of every zstd frame inside one log file. */
function frameStarts(buffer) {
  const starts = [];
  let at = buffer.indexOf(ZSTD_MAGIC);
  while (at >= 0) {
    starts.push(at);
    at = buffer.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length);
  }
  return starts;
}

function decodeFrame(buffer, start, end) {
  try {
    return zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Two facts about one session log: whether any turn started, and the last event
 * sequence number. Frame decoding stops at the first turn, so a long conversation
 * costs at most one pass over its frames.
 */
async function readLogFacts(file) {
  if (typeof zlib.zstdDecompressSync !== 'function') return null;
  let buffer;
  try {
    buffer = await fsp.readFile(file);
  } catch {
    return null;
  }
  const starts = frameStarts(buffer);
  if (starts.length === 0) return null;
  const frameEnd = (index) => (index + 1 < starts.length ? starts[index + 1] : buffer.length);

  let hasTurn = false;
  for (let index = 0; index < starts.length; index += 1) {
    if (decodeFrame(buffer, starts[index], frameEnd(index)).includes(TURN_MARK)) {
      hasTurn = true;
      break;
    }
  }

  let lastSeq = -1;
  for (let index = starts.length - 1; index >= 0 && lastSeq < 0; index -= 1) {
    const lines = decodeFrame(buffer, starts[index], frameEnd(index)).split('\n');
    for (let line = lines.length - 1; line >= 0; line -= 1) {
      const text = lines[line].trim();
      if (text === '') continue;
      try {
        const event = JSON.parse(text);
        if (typeof event.seq === 'number') {
          lastSeq = event.seq;
          break;
        }
      } catch {
        // The header line carries no seq; a split tail simply retries.
      }
    }
  }
  return { hasTurn, lastSeq };
}

/** The blank flag of one shard, or `null` when the shard is missing or odd. */
async function readBlank(file) {
  const doc = await readJson(file);
  if (doc === null || typeof doc !== 'object') return null;
  const record = doc.record !== undefined && doc.record !== null ? doc.record : doc;
  const row = record?.rows?.sessionListMetadata;
  return { doc, record, blank: row?.val?.blank === true };
}

/** Rewrite only the blank row, leaving every other projection untouched. */
async function repairBlank(file, shard, seq) {
  shard.record.rows = shard.record.rows ?? {};
  shard.record.rows.sessionListMetadata = {
    ver: 1,
    seq: seq >= 0 ? seq : 0,
    val: { blank: false, lastPromptAt: null },
  };
  await writeJsonAtomic(file, shard.doc);
}

/**
 * Repair the shards of sessions that were just pulled from the share.
 *
 * The regular guard runs before the shared sessions land locally, so a session
 * whose content arrives in this very run is invisible to it. This pass only
 * looks at the files the pull step wrote, which keeps the extra work to the
 * sessions that actually changed.
 *
 * @returns how many shards were repaired.
 */
export async function repairPulledSessions(deps) {
  const { items, cacheDir, apply = true } = deps;
  const result = { repaired: 0, checked: 0 };
  for (const item of items) {
    result.checked += 1;
    const file = shardPath(cacheDir, item.id);
    if ((await shardStamp(file)) < 0) continue;
    const shard = await readBlank(file);
    if (shard === null || shard.blank !== true) continue;
    const facts = await readLogFacts(item.file);
    if (facts === null || facts.hasTurn !== true) continue;
    if (!apply) {
      result.repaired += 1;
      continue;
    }
    try {
      await repairBlank(file, shard, facts.lastSeq);
      result.repaired += 1;
    } catch {
      // A failed repair is retried on the next sync.
    }
  }
  return result;
}

/** Shape of the per-machine memo; bump when the entry fields change. */
const STATE_VERSION = 1;

async function readState(file) {
  const doc = await readJson(file);
  if (doc === null || typeof doc !== 'object' || doc.version !== STATE_VERSION) {
    return { version: STATE_VERSION, entries: {} };
  }
  const entries = doc.entries !== null && typeof doc.entries === 'object' ? doc.entries : {};
  return { version: STATE_VERSION, entries };
}

/** A shard's mtime, or -1 when the session has no shard. */
async function shardStamp(file) {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Shards that own no log at all.
 *
 * DSH writes the projection shard the moment a session is created, but only
 * appends the log once the first event lands. A session created and then
 * abandoned — or one being created right now — therefore leaves a shard that no
 * scan of the sessions root can see. It carries no conversation; mirroring it
 * plants an empty entry on every machine that pulls it later.
 */
async function orphanShardIds(cacheDir, sessions) {
  let names;
  try {
    names = await fsp.readdir(cacheDir);
  } catch {
    return [];
  }
  const ids = [];
  for (const name of names) {
    if (!name.startsWith('session-') || !name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (sessions.has(id)) continue;
    ids.push(id);
  }
  return ids.sort();
}

/**
 * Decide which sessions must stay out of the share this run.
 *
 * The caller already scans the sessions root for the sync itself, so it hands
 * that map in (`sessions`) instead of paying for a second walk; `localRoot` is
 * only the fallback for standalone callers such as tests.
 *
 * With `stateFile` the verdict is memoised per session: while a shard's mtime and
 * a log's mtime/size stay put the pair is not read again, so a steady-state run
 * costs one stat per session and nothing else. The memo is dropped for a session
 * as soon as either file moves — exactly when the answer can change.
 *
 * @returns skip set plus counters for the run summary.
 */
export async function buildBlankGuard(deps) {
  const { localRoot, cacheDir, apply = true, stateFile = null } = deps;
  const result = { skipIds: new Set(), skipped: 0, repaired: 0, unreadable: 0, orphaned: 0, details: [] };
  let sessions = deps.sessions;
  if (sessions === undefined) {
    try {
      sessions = await scanSessions(localRoot);
    } catch {
      return result;
    }
  }
  const previous = stateFile === null ? null : await readState(stateFile);
  const next = {};

  for (const [id, entry] of sessions) {
    const file = shardPath(cacheDir, id);
    const shardMtime = await shardStamp(file);
    const logStamp = `${entry.mtime}:${entry.size}`;
    const memo = previous?.entries?.[id];
    if (memo !== undefined && memo.shard === shardMtime && memo.log === logStamp) {
      // Neither the shard nor the log moved since the last verdict.
      next[id] = memo;
      if (memo.skip === true) {
        result.skipIds.add(id);
        result.skipped += 1;
        if (result.details.length < MAX_REPORTED_IDS) result.details.push(id);
      }
      continue;
    }

    let skip = false;
    let repaired = false;
    if (shardMtime >= 0) {
      const shard = await readBlank(file);
      if (shard !== null && shard.blank === true) {
        const facts = await readLogFacts(entry.file);
        if (facts === null) {
          // Unjudgeable this run: no memo, so the next sync tries again.
          result.unreadable += 1;
          continue;
        }
        if (facts.hasTurn) {
          // The conversation has turns but the shard still says blank: stale cache.
          if (apply) {
            try {
              await repairBlank(file, shard, facts.lastSeq);
              repaired = true;
            } catch {
              result.unreadable += 1;
              continue;
            }
          }
          result.repaired += 1;
        } else {
          // A session that was created and never used: nothing worth sharing yet.
          skip = true;
          result.skipIds.add(id);
          result.skipped += 1;
          if (result.details.length < MAX_REPORTED_IDS) result.details.push(id);
        }
      }
    }
    next[id] = { shard: repaired ? await shardStamp(file) : shardMtime, log: logStamp, skip };
  }

  // A shard whose session has no log holds no conversation, and the scan above
  // cannot see it; without this pass the shard would travel to the share alone.
  // No memo is kept: the verdict must be recomputed once a log appears.
  for (const id of await orphanShardIds(cacheDir, sessions)) {
    result.skipIds.add(id);
    result.skipped += 1;
    result.orphaned += 1;
    if (result.details.length < MAX_REPORTED_IDS) result.details.push(id);
  }

  if (stateFile !== null && apply && JSON.stringify(next) !== JSON.stringify(previous?.entries ?? {})) {
    await writeJsonAtomic(stateFile, {
      version: STATE_VERSION,
      updatedAt: new Date().toISOString(),
      entries: next,
    }).catch(() => {});
  }
  return result;
}
