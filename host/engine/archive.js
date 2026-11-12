/**
 * Archive / unarchive event propagation.
 *
 * `workspace.json` only carries the current archived set, so "unarchive" cannot
 * travel: the other machine still holds the old archive list and would keep the
 * session archived forever. Two small documents fix that:
 *
 *   archive-events.json        session id -> { state: 'archived'|'active', at, by }
 *   archive-<machine>.json     the archived set this machine had after its last run
 *
 * A run diffs its own set against its snapshot to emit events, merges the event
 * table (newest `at` wins), then applies it: a session whose latest event is
 * `active` is dropped from the archived list even if another document lists it.
 */
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

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

/** Read the shared event table. */
export async function readArchiveEvents(stateDir) {
  const doc = await readJson(path.join(stateDir, 'archive-events.json'), { version: 1, events: {} });
  const events = doc?.events;
  return events !== null && typeof events === 'object' ? { ...events } : {};
}

/** Persist the event table, sorted for a stable diff. */
export async function writeArchiveEvents(stateDir, events) {
  const rows = {};
  for (const id of Object.keys(events).sort()) {
    rows[id] = { state: events[id].state, at: events[id].at, by: events[id].by };
  }
  await writeJson(path.join(stateDir, 'archive-events.json'), {
    version: 1,
    note: '归档/取消归档事件表：同步脚本据此让取消归档也能跨机生效，请勿手改',
    events: rows,
  });
}

/** The archived set this machine had after its last run. */
export async function readArchiveSnapshot(stateDir, machineId) {
  const doc = await readJson(path.join(stateDir, `archive-${machineId}.json`), { ids: [] });
  return new Set(Array.isArray(doc?.ids) ? doc.ids : []);
}

export async function writeArchiveSnapshot(stateDir, machineId, ids) {
  await writeJson(path.join(stateDir, `archive-${machineId}.json`), {
    version: 1,
    machine: machineId,
    updatedAt: new Date().toISOString(),
    ids: [...ids].sort(),
  });
}

/** Events for the ids that entered or left the archived set since the snapshot. */
export function diffArchiveEvents(localArchived, previousArchived, machineId, at = new Date().toISOString()) {
  const current = localArchived instanceof Set ? localArchived : new Set(localArchived);
  const events = {};
  for (const id of current) {
    if (!previousArchived.has(id)) events[id] = { state: 'archived', at, by: machineId };
  }
  for (const id of previousArchived) {
    if (!localArchived.has(id)) events[id] = { state: 'active', at, by: machineId };
  }
  return events;
}

/** Merge incoming events; the newest `at` wins per session. */
export function mergeArchiveEvents(existing, incoming) {
  const merged = { ...existing };
  for (const [id, event] of Object.entries(incoming)) {
    const current = merged[id];
    if (current === undefined || String(event.at) > String(current.at)) merged[id] = event;
  }
  return merged;
}

/**
 * Keep only events that still matter: an `archived` event states current intent
 * for every machine, while an `active` event stops mattering once no document
 * lists that session as archived. Without this the table grows forever.
 */
export function pruneArchiveEvents(events, keepIds) {
  const kept = {};
  let removed = 0;
  for (const [id, event] of Object.entries(events)) {
    if (event?.state === 'archived' || keepIds.has(id)) kept[id] = event;
    else removed += 1;
  }
  return { events: kept, removed };
}

/** Drop ids whose latest event says `active`. */
export function applyArchiveEvents(archived, events) {
  const kept = [];
  const released = [];
  for (const id of archived) {
    const event = events[id];
    if (event !== undefined && event.state === 'active') released.push(id);
    else kept.push(id);
  }
  return { kept, released };
}

/**
 * Run the archive half of a sync.
 * @returns the effective archived list plus what changed.
 */
export async function syncArchiveState(deps) {
  const { stateDir, machineId, apply = true } = deps;
  const localArchived = deps.localArchived instanceof Set ? deps.localArchived : new Set(deps.localArchived ?? []);
  const previous = await readArchiveSnapshot(stateDir, machineId);
  const existing = await readArchiveEvents(stateDir);
  const incoming = diffArchiveEvents(localArchived, previous, machineId);
  const merged = mergeArchiveEvents(existing, incoming);
  if (apply && Object.keys(incoming).length > 0) await writeArchiveEvents(stateDir, merged);
  const { kept, released } = applyArchiveEvents(localArchived, merged);
  if (apply) await writeArchiveSnapshot(stateDir, machineId, kept);
  return { archived: kept, released, emitted: incoming, events: merged };
}
