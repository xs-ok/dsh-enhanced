/**
 * `storages/workspace.json` merge for the pure-JS engine.
 *
 * Rules, matching `Merge-WorkspaceJson` in the PowerShell engine:
 *   - entries join by (localized) path, not by uuid;
 *   - the newer `updatedAt` is the base record, older unknowns fill the gaps;
 *   - `sessionIds` is a union, `createdAt` the earliest, tombstoned ids dropped;
 *   - the share gets every group, this machine only groups whose folder exists;
 *   - `global` keeps the union of archived/pinned, unknown fields preserved.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_LEDGER, readJson as readLedgerJson, readLedger, writeJsonAtomic, writeLedger } from './ledger.js';

async function readJson(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return { doc: JSON.parse(text), valid: true };
  } catch (error) {
    return { doc: null, valid: error?.code === 'ENOENT' };
  }
}

function entriesOf(doc, source) {
  const table = doc?.tables?.workspaces;
  if (table === null || typeof table !== 'object') return [];
  return Object.entries(table).map(([uuid, value]) => ({
    uuid,
    path: typeof value?.path === 'string' ? value.path : '',
    title: typeof value?.title === 'string' ? value.title : '',
    sessionIds: Array.isArray(value?.sessionIds) ? value.sessionIds.filter(Boolean) : [],
    createdAt: typeof value?.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
    source,
    raw: value,
  }));
}

function timeOf(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function unionInto(target, values) {
  for (const value of values) {
    if (value !== undefined && value !== null && !target.includes(value)) target.push(value);
  }
  return target;
}

/**
 * Merge both documents.
 * @param options - `resolvePath` localizes a remote path, `isDirectory` decides
 *   whether the group is registered locally, `tombstones` is a Set of session ids.
 */
export async function mergeWorkspaceDocuments(localDoc, sharedDoc, options = {}) {
  const {
    resolvePath = (value) => value,
    isDirectory = () => false,
    tombstones = new Set(),
    stateDir = null,
    machineId = null,
    apply = true,
  } = options;

  // Workspace deletions used to be silent: the other machine's document still
  // listed the path, so the union added it back. A ledger plus a per-machine
  // snapshot fixes that, and a workspace that reappears counts as restored.
  const localEntries = entriesOf(localDoc, 'local');
  let workspaceLedger = { version: 1, deleted: {} };
  let snapshot = { paths: {} };
  if (stateDir !== null && machineId !== null) {
    workspaceLedger = await readLedger(stateDir, WORKSPACE_LEDGER);
    snapshot = (await readLedgerJson(path.join(stateDir, `workspace-${machineId}.json`), undefined)) ?? { paths: {} };
    const localByPath = new Map(localEntries.map((entry) => [entry.path, entry]));
    const now = new Date().toISOString();
    for (const [entryPath, info] of Object.entries(snapshot.paths ?? {})) {
      if (entryPath === '') continue;
      if (localByPath.has(entryPath)) continue;
      const uuid = typeof info?.uuid === 'string' && info.uuid !== '' ? info.uuid : entryPath;
      if (workspaceLedger.deleted[uuid] !== undefined) continue;
      workspaceLedger.deleted[uuid] = { at: now, path: entryPath, title: info?.title ?? '', source: 'local' };
    }
    const localByUuid = new Map(localEntries.map((entry) => [entry.uuid, entry]));
    for (const [uuid, record] of Object.entries(workspaceLedger.deleted)) {
      const entry = localByUuid.get(uuid) ?? localByPath.get(record.path ?? '');
      if (entry === undefined) continue;
      if (timeOf(entry.updatedAt) > timeOf(record.at) + 1) delete workspaceLedger.deleted[uuid];
    }
  }

  const deletedPaths = new Set(Object.values(workspaceLedger.deleted).map((record) => record.path).filter(Boolean));
  const deletedUuids = new Set(Object.keys(workspaceLedger.deleted));

  const merged = new Map();
  for (const entry of [...localEntries, ...entriesOf(sharedDoc, 'shared')]) {
    if (deletedUuids.has(entry.uuid) || (entry.path !== '' && deletedPaths.has(entry.path))) continue;
    // The resolver is allowed to be async (the JS engine localizes remote
    // paths through `fs.realpath`). Awaiting it is mandatory: a Promise stored
    // in `path` serializes to `{}`, which the host's workspace schema rejects
    // and then refuses to activate the whole registry.
    const key = await resolvePath(entry.path);
    if (typeof key !== 'string' || key === '') continue;
    const current = merged.get(key);
    if (current === undefined) {
      merged.set(key, { ...entry, path: key, others: [] });
      continue;
    }
    const newer = timeOf(entry.updatedAt) > timeOf(current.updatedAt);
    if (newer) {
      if (current.raw !== undefined) current.others.push(current.raw);
      current.uuid = entry.uuid;
      current.title = entry.title;
      current.updatedAt = entry.updatedAt;
      current.raw = entry.raw;
    } else if (entry.raw !== undefined) {
      current.others.push(entry.raw);
    }
    unionInto(current.sessionIds, entry.sessionIds);
    if (timeOf(entry.createdAt) < timeOf(current.createdAt)) current.createdAt = entry.createdAt;
  }

  const shared = {};
  const local = {};
  const missing = [];
  for (const entry of merged.values()) {
    const ids = entry.sessionIds.filter((id) => !tombstones.has(id));
    const record = { ...(entry.raw ?? {}) };
    for (const other of entry.others) {
      for (const [field, value] of Object.entries(other ?? {})) {
        if (!(field in record)) record[field] = value;
      }
    }
    record.path = entry.path;
    // Never let a non-string path reach the document: the host validates every
    // record with `path: z.string()` at startup, and a single bad value kills
    // the whole workspace registry service.
    if (typeof record.path !== 'string' || record.path === '') continue;
    record.title = entry.title;
    record.sessionIds = ids;
    if (entry.createdAt !== '') record.createdAt = entry.createdAt;
    if (entry.updatedAt !== '') record.updatedAt = entry.updatedAt;
    shared[entry.uuid] = record;
    if (await isDirectory(entry.path)) local[entry.uuid] = record;
    else missing.push({ title: entry.title, path: entry.path });
  }

  const archived = [];
  const pinned = [];
  let initialized = false;
  const extraGlobal = {};
  for (const doc of [localDoc, sharedDoc]) {
    const global = doc?.global;
    if (global === null || typeof global !== 'object') continue;
    if (global.initialized === true) initialized = true;
    unionInto(archived, (Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []).filter((id) => id && !tombstones.has(id)));
    unionInto(pinned, (Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : []).filter((id) => id && !tombstones.has(id)));
    for (const [field, value] of Object.entries(global)) {
      if (['initialized', 'workspaceIds', 'archivedSessionIds', 'pinnedSessionIds'].includes(field)) continue;
      if (!(field in extraGlobal)) extraGlobal[field] = value;
    }
  }

  // The document schema version must never go backwards: a newer app would
  // otherwise re-run its migration against data it already migrated.
  let unitName = 'workspace';
  let unitVersion = 2;
  for (const doc of [localDoc, sharedDoc]) {
    if (doc?.unit === null || typeof doc?.unit !== 'object') continue;
    if (typeof doc.unit.name === 'string' && doc.unit.name !== '') unitName = doc.unit.name;
    if (Number(doc.unit.version) > unitVersion) unitVersion = Number(doc.unit.version);
  }

  const preferredOrder = (() => {
    const fromLocal = Array.isArray(localDoc?.global?.workspaceIds) ? localDoc.global.workspaceIds : [];
    const fromShared = Array.isArray(sharedDoc?.global?.workspaceIds) ? sharedDoc.global.workspaceIds : [];
    return fromLocal.length > 0 ? fromLocal : fromShared;
  })();
  const orderOf = (workspaces) => {
    const present = Object.keys(workspaces);
    const ordered = preferredOrder.filter((id) => present.includes(id));
    for (const id of present) if (!ordered.includes(id)) ordered.push(id);
    return ordered;
  };

  const build = (workspaces) => {
    const doc = JSON.parse(JSON.stringify(localDoc ?? sharedDoc ?? {}));
    doc.unit = { name: unitName, version: unitVersion };
    doc.tables = doc.tables ?? {};
    doc.tables.workspaces = workspaces;
    doc.global = { ...(doc.global ?? {}), ...extraGlobal, initialized, workspaceIds: orderOf(workspaces), archivedSessionIds: archived, pinnedSessionIds: pinned };
    return doc;
  };

  if (apply && stateDir !== null && machineId !== null) {
    const pathsNow = {};
    for (const entry of entriesOf(localDoc, 'local')) {
      if (entry.path !== '') pathsNow[entry.path] = { uuid: entry.uuid, title: entry.title };
    }
    // Re-read the local document after the merge so a restored group is recorded.
    for (const value of Object.values(local)) {
      if (typeof value?.path === 'string' && value.path !== '') {
        pathsNow[value.path] = { uuid: pathsNow[value.path]?.uuid ?? '', title: value.title ?? '' };
      }
    }
    await writeJsonAtomic(path.join(stateDir, `workspace-${machineId}.json`), { version: 1, machine: machineId, paths: pathsNow, updatedAt: new Date().toISOString() });
    await writeLedger(stateDir, WORKSPACE_LEDGER, workspaceLedger);
  }

  return { shared: build(shared), local: build(local), missing, unitVersion, deleted: deletedUuids.size };
}

/** Read both files, merge, and return the two documents plus the missing folders. */
export async function mergeWorkspaceFiles(deps) {
  const { localFile, sharedFile, ...rest } = deps;
  const localRead = await readJson(localFile);
  const sharedRead = await readJson(sharedFile);
  if (!localRead.valid || !sharedRead.valid) {
    return { skipped: 'workspace.json 无效或正在写入，本次不合并', missing: [] };
  }
  if (localRead.doc === null && sharedRead.doc === null) return { skipped: '两侧都没有 workspace.json', missing: [] };
  return await mergeWorkspaceDocuments(localRead.doc, sharedRead.doc, rest);
}
