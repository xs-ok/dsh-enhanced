/**
 * Local session recycle bin for DSH增强.
 *
 * A deleted session keeps its full local log, so the only work a delete does is:
 * detach the workspace accounting through the official registry write path,
 * move the session directory into the recycle bin, and drop the projection cache
 * shard. Nothing here edits `workspace.json` directly: the workspace domain is
 * memory-authoritative, so every reference change goes through
 * `workspaceRegistry` and its domain write chain.
 *
 * Layout under `<DSH_HOME>/dsh-enhanced`:
 *
 *   settings.json
 *   trash/index.json                 derived summary, rebuildable
 *   trash/<workspaceId>/<sessionId>/meta.json
 *   trash/<workspaceId>/<sessionId>/log/...
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  deleteEnabled: true,
  trashEnabled: true,
  searchEnabled: true,
  moveEnabled: true,
  autoLoadEnabled: true,
  syncEnabled: false,
  syncDir: '',
  syncScript: '',
  syncMachineId: '',
  syncSkipAttachments: false,
  syncIntervalMinutes: 0,
  syncDailyAt: '',
  syncOnIdle: true,
  syncCooldownMinutes: 5,
  syncMode: 'local',
  webdavUrl: '',
  webdavUser: '',
  webdavPassword: '',
  webdavRoot: '',
  webdavProfiles: [],
  webdavAutoCreate: true,
  mirrorDir: path.join(os.homedir(), 'AppData', 'Local', 'dsh-enhanced', 'webdav-mirror'),
  matchTitle: true,
  matchBody: true,
  matchTools: false,
  retentionDays: 60,
});

const SETTINGS_LIMITS = {
  retentionDays: { min: 0, max: 3650 },
  syncIntervalMinutes: { min: 0, max: 1440 },
  syncCooldownMinutes: { min: 1, max: 240 },
};

const UNGROUPED = '_ungrouped';

/** Create one stable coded error the route turns into a client message. */
export function failure(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

/** Resolve the harness home directory the same way the Host was launched. */
export function resolveHome(config = {}) {
  if (typeof config.root === 'string' && config.root.trim() !== '') return path.resolve(config.root);
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/** Every path this plugin touches, derived once per call site. */
export function resolvePaths(config = {}) {
  const home = resolveHome(config);
  const base = path.join(home, 'dsh-enhanced');
  return {
    home,
    base,
    settingsFile: path.join(base, 'settings.json'),
    trashDir: path.join(base, 'trash'),
    indexFile: path.join(base, 'trash', 'index.json'),
    sessionsRoot: typeof config.sessionsRoot === 'string' && config.sessionsRoot.trim() !== ''
      ? path.resolve(config.sessionsRoot)
      : path.join(home, 'sessions'),
    projcacheRoot: typeof config.projcacheRoot === 'string' && config.projcacheRoot.trim() !== ''
      ? path.resolve(config.projcacheRoot)
      : path.join(home, 'storages', 'session_projcache'),
  };
}

async function readJson(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
}

async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function clampInteger(value, fallback, limits) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  return Math.min(limits.max, Math.max(limits.min, rounded));
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Trimmed string with the fallback for a missing or empty value. */
function normalizeText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

/** `HH:MM` in 24-hour form, or an empty string when unset or malformed. */
function normalizeClock(value) {
  if (typeof value !== 'string') return '';
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return '';
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return '';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Merge a stored or patched document over the defaults, field by field. */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    version: SETTINGS_VERSION,
    deleteEnabled: normalizeBoolean(source.deleteEnabled, DEFAULT_SETTINGS.deleteEnabled),
    trashEnabled: normalizeBoolean(source.trashEnabled, DEFAULT_SETTINGS.trashEnabled),
    searchEnabled: normalizeBoolean(source.searchEnabled, DEFAULT_SETTINGS.searchEnabled),
    moveEnabled: normalizeBoolean(source.moveEnabled, DEFAULT_SETTINGS.moveEnabled),
    autoLoadEnabled: normalizeBoolean(source.autoLoadEnabled, DEFAULT_SETTINGS.autoLoadEnabled),
    syncEnabled: normalizeBoolean(source.syncEnabled, DEFAULT_SETTINGS.syncEnabled),
    syncSkipAttachments: normalizeBoolean(source.syncSkipAttachments, DEFAULT_SETTINGS.syncSkipAttachments),
    syncDir: normalizeText(source.syncDir, DEFAULT_SETTINGS.syncDir),
    syncScript: normalizeText(source.syncScript, DEFAULT_SETTINGS.syncScript),
    syncMachineId: normalizeText(source.syncMachineId, DEFAULT_SETTINGS.syncMachineId),
    syncOnIdle: normalizeBoolean(source.syncOnIdle, DEFAULT_SETTINGS.syncOnIdle),
    syncDailyAt: normalizeClock(source.syncDailyAt),    syncIntervalMinutes: clampInteger(source.syncIntervalMinutes, DEFAULT_SETTINGS.syncIntervalMinutes, SETTINGS_LIMITS.syncIntervalMinutes),
    syncCooldownMinutes: clampInteger(source.syncCooldownMinutes, DEFAULT_SETTINGS.syncCooldownMinutes, SETTINGS_LIMITS.syncCooldownMinutes),
    syncMode: source.syncMode === 'webdav' ? 'webdav' : 'local',
    webdavUrl: normalizeText(source.webdavUrl, ''),
    webdavUser: normalizeText(source.webdavUser, ''),
    webdavPassword: typeof source.webdavPassword === 'string' ? source.webdavPassword : '',
    webdavRoot: normalizeText(source.webdavRoot, ''),
    webdavProfiles: normalizeWebdavProfiles(source.webdavProfiles),
    webdavAutoCreate: normalizeBoolean(source.webdavAutoCreate, DEFAULT_SETTINGS.webdavAutoCreate),
    mirrorDir: normalizeText(source.mirrorDir, DEFAULT_SETTINGS.mirrorDir),
    matchTitle: normalizeBoolean(source.matchTitle, DEFAULT_SETTINGS.matchTitle),
    matchBody: normalizeBoolean(source.matchBody, DEFAULT_SETTINGS.matchBody),
    matchTools: normalizeBoolean(source.matchTools, DEFAULT_SETTINGS.matchTools),
    retentionDays: clampInteger(source.retentionDays, DEFAULT_SETTINGS.retentionDays, SETTINGS_LIMITS.retentionDays),
  };
}

/** Keep at most three saved WebDAV presets, each with the four connection fields. */
function normalizeWebdavProfiles(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const url = normalizeText(item.url, '');
    if (url === '') continue;
    out.push({
      id: normalizeText(item.id, '') || `p${String(out.length + 1)}`,
      name: normalizeText(item.name, '') || 'WebDAV',
      url,
      user: normalizeText(item.user, ''),
      password: typeof item.password === 'string' ? item.password : '',
      root: normalizeText(item.root, ''),
      custom: item.custom === true,
    });
    if (out.length === 3) break;
  }
  return out;
}

/** Read the persisted settings document, falling back to defaults. */
export async function readSettings(paths) {
  const stored = await readJson(paths.settingsFile);
  return normalizeSettings(stored);
}

/** Persist one settings patch and return the complete normalized document. */
export async function writeSettings(paths, patch) {
  const current = await readSettings(paths);
  const next = normalizeSettings({ ...current, ...(patch ?? {}) });
  await writeJsonAtomic(paths.settingsFile, next);
  return next;
}

/** Plain-data snapshot of one workspace entity, tolerating a missing registry. */
export function workspaceSnapshot(workspace) {
  if (workspace === undefined || workspace === null) return undefined;
  try {
    return {
      id: workspace.id,
      title: typeof workspace.title === 'string' && workspace.title.trim() !== '' ? workspace.title : workspace.path,
      path: workspace.path,
      sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [],
    };
  } catch {
    return undefined;
  }
}

/** The workspace currently accounting for one session, if any. */
export function findOwningWorkspace(registry, sessionId) {
  if (registry === undefined) return undefined;
  try {
    for (const workspace of registry.list()) {
      const snapshot = workspaceSnapshot(workspace);
      if (snapshot !== undefined && snapshot.sessionIds.includes(sessionId)) return workspace;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Find the on-disk directory of one stored session by scanning project dirs. */
export async function locateSessionDir(paths, sessionId) {
  for (const entry of await readDirSafe(paths.sessionsRoot)) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(paths.sessionsRoot, entry.name, sessionId);
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // Not this project directory.
    }
  }
  return undefined;
}

async function directorySize(dir) {
  let total = 0;
  for (const entry of await readDirSafe(dir)) {
    const target = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += await directorySize(target);
      else if (entry.isFile()) total += (await fsp.stat(target)).size;
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total;
}

async function newestMtime(dir) {
  let newest = 0;
  for (const entry of await readDirSafe(dir)) {
    const target = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(target));
      else newest = Math.max(newest, (await fsp.stat(target)).mtimeMs);
    } catch {
      // Ignore vanished entries.
    }
  }
  return newest;
}

/** Read the latest durable title, preferring the query service when present. */
async function readTitle(query, persistence, sessionId) {
  try {
    if (query !== undefined && typeof query.readTitle === 'function') {
      const snapshot = await query.readTitle(sessionId);
      if (snapshot !== undefined && typeof snapshot.title === 'string' && snapshot.title.trim() !== '') {
        return snapshot.title.trim();
      }
    }
  } catch {
    // Fall through to a header-only best effort.
  }
  return '';
}

/** Group key and display title for one stored workspace id. */
function bucketOf(meta, registry) {
  const workspaceId = typeof meta.workspaceId === 'string' && meta.workspaceId !== '' ? meta.workspaceId : UNGROUPED;
  if (workspaceId === UNGROUPED) return { workspaceId: UNGROUPED, workspaceTitle: '' };
  let title = typeof meta.workspaceTitle === 'string' ? meta.workspaceTitle : '';
  try {
    const workspace = registry?.get?.(workspaceId);
    if (workspace !== undefined) title = workspace.title;
  } catch {
    // Keep the recorded title.
  }
  return { workspaceId, workspaceTitle: title };
}

function entryDirOf(paths, workspaceId, sessionId) {
  return path.join(paths.trashDir, workspaceId, sessionId);
}

async function scanEntries(paths, registry) {
  const buckets = await readDirSafe(paths.trashDir);
  const entries = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = path.join(paths.trashDir, bucket.name);
    for (const item of await readDirSafe(bucketDir)) {
      if (!item.isDirectory()) continue;
      const entryDir = path.join(bucketDir, item.name);
      const meta = await readJson(path.join(entryDir, 'meta.json'));
      if (meta === undefined || typeof meta.sessionId !== 'string') {
        await fsp.rm(entryDir, { recursive: true, force: true });
        continue;
      }
      entries.push({ entryDir, meta });
    }
  }
  return entries;
}

/** Whether a stored entry should be dropped because its workspace is gone. */
function workspaceLost(meta, registry) {
  const workspaceId = typeof meta.workspaceId === 'string' ? meta.workspaceId : '';
  if (workspaceId === '' || workspaceId === UNGROUPED) return false;
  if (registry === undefined) return false;
  try {
    return registry.get(workspaceId) === undefined;
  } catch {
    return false;
  }
}

function expired(meta, retentionDays) {
  if (retentionDays <= 0) return false;
  const deletedAt = typeof meta.deletedAt === 'string' ? Date.parse(meta.deletedAt) : Number.NaN;
  if (!Number.isFinite(deletedAt)) return false;
  return Date.now() - deletedAt > retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * Delete one session into the recycle bin, or remove it for good.
 *
 * The workspace reference is released before the files move, so the sidebar
 * stops listing the session as soon as the registry write commits. Only a
 * session with an active turn is refused: a resident but idle agent is not
 * appending, so its log can be moved safely.
 *
 * @param deps - Host services and paths.
 * @param sessionId - stored session to remove.
 * @param options - `permanent` skips the recycle bin; `ignoreSettings` lets the
 * session-move flow reuse this path regardless of the delete switch.
 */
export async function deleteSession(deps, sessionId, options = {}) {
  const { paths, registry, persistence, query, agents } = deps;
  const settings = options.ignoreSettings === true ? { ...deps.settings, deleteEnabled: true } : deps.settings;
  const permanent = options.permanent === true;
  if (settings.deleteEnabled !== true) throw failure('delete-disabled', '会话删除已在设置中关闭。');
  if (agents !== undefined && typeof agents.get === 'function') {
    const agent = agents.get(sessionId);
    if (agent !== undefined && agent?.status === 'running') {
      throw failure('session-live', '该会话正在运行任务，等它结束或停止后再删除。');
    }
  }
  const snapshot = await persistence.stat(sessionId);
  if (snapshot === undefined) throw failure('session-missing', '会话不存在或已被删除。');
  const sessionDir = await locateSessionDir(paths, sessionId);
  if (sessionDir === undefined) throw failure('session-dir-missing', '找不到该会话的本机目录。');

  const workspace = findOwningWorkspace(registry, sessionId);
  const workspaceInfo = workspaceSnapshot(workspace);
  const ordered = workspaceInfo?.sessionIds ?? [];
  const at = ordered.indexOf(sessionId);
  const position = at < 0
    ? { prev: undefined, next: undefined }
    : { prev: ordered[at - 1], next: ordered[at + 1] };

  const title = await readTitle(query, persistence, sessionId);
  const workspaceId = workspaceInfo?.id ?? UNGROUPED;

  // 1. Release the durable workspace accounting last: the workspace write is what
  //    makes the sidebar re-query the session list, so the files and the cached
  //    projection must already be gone by then.
  const releaseWorkspace = async () => {
    try {
      await registry.unpinSession(sessionId);
      await registry.unarchiveSession(sessionId);
      if (workspace !== undefined) await workspace.detachSession(sessionId);
    } catch (error) {
      return `会话已删除，但从工作区移除失败：${error.message}`;
    }
    return undefined;
  };

  const shard = path.join(paths.projcacheRoot, 'sessions', `${sessionId}.json`);

  if (permanent) {
    const lastUpdatedAt = await newestMtime(sessionDir);
    const sizeBytes = await directorySize(sessionDir);
    try {
      await fsp.rm(sessionDir, { recursive: true, force: true });
    } catch (error) {
      throw failure('session-remove-failed', `无法删除会话目录：${error.message}`);
    }
    try {
      await fsp.rm(shard, { force: true });
    } catch {
      // A locked shard stays behind and is ignored as stale.
    }
    const warning = await releaseWorkspace();
    // A permanent removal (the move flow) has to be announced to the next sync as
    // well: without the journal entry the engine relies on its own snapshot, and a
    // machine without one would pull the cloud copy back as a second session.
    await appendDeleteJournal(deps, {
      kind: 'sessions',
      key: sessionId,
      value: {
        at: new Date().toISOString(),
        workspace: workspaceId,
        mtime: lastUpdatedAt > 0 ? lastUpdatedAt : Date.now(),
        size: sizeBytes,
        by: 'local',
        reason: options.reason ?? 'deleted',
      },
    });
    return { sessionId, title: title !== '' ? title : '未命名会话', workspaceId, permanent: true, warning, reason: options.reason ?? 'deleted' };
  }

  const lastUpdatedAt = await newestMtime(sessionDir);
  const sizeBytes = await directorySize(sessionDir);
  const originalPath = path.relative(paths.sessionsRoot, sessionDir);
  if (originalPath.startsWith('..')) throw failure('session-path', '会话目录不在预期的存储根目录下，已拒绝删除。');

  const deletedAt = new Date().toISOString();
  const entryDir = entryDirOf(paths, workspaceId, sessionId);
  const stagingDir = `${entryDir}.staging-${process.pid}`;

  // 2. Move the log into the recycle bin (same volume: one rename, no copy).
  await fsp.mkdir(path.dirname(stagingDir), { recursive: true });
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });
  try {
    await fsp.rename(sessionDir, path.join(stagingDir, 'log'));
  } catch (error) {
    await fsp.rm(stagingDir, { recursive: true, force: true });
    throw failure('session-move-failed', `无法移动会话目录：${error.message}`);
  }

  // 3. Drop the projection cache shard; it is derived from the log.
  try {
    await fsp.rm(shard, { force: true });
  } catch {
    // A locked shard stays behind and is ignored as stale.
  }

  const meta = {
    version: 1,
    sessionId,
    title: title !== '' ? title : '未命名会话',
    cwd: typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : undefined,
    workspaceId,
    workspaceTitle: workspaceInfo?.title,
    originalPath,
    position,
    deletedAt,
    lastUpdatedAt: lastUpdatedAt > 0 ? new Date(lastUpdatedAt).toISOString() : undefined,
    sizeBytes,
    appVersion: process.env.DSH_CLIENT_VERSION,
  };
  await writeJsonAtomic(path.join(stagingDir, 'meta.json'), meta);
  await fsp.rm(entryDir, { recursive: true, force: true });
  await fsp.rename(stagingDir, entryDir);

  // Record the deletion so the next sync announces it to the cloud instead of
  // guessing from "the file is gone".
  await appendDeleteJournal(deps, {
    kind: 'sessions',
    key: sessionId,
    value: {
      at: deletedAt,
      workspace: workspaceId,
      mtime: lastUpdatedAt > 0 ? lastUpdatedAt : Date.now(),
      size: sizeBytes,
      by: 'local',
    },
  });

  const warning = await releaseWorkspace();
  return { sessionId, title: meta.title, workspaceId, deletedAt, sizeBytes, warning };
}

/** Append one offline deletion to the journal merged at the next sync. */
async function appendDeleteJournal(deps, entry) {
  const file = path.join(deps.paths.base, 'delete-journal.json');
  let doc;
  try {
    doc = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    doc = { version: 1, sessions: {}, workspaces: {} };
  }
  const bucket = doc[entry.kind] ?? {};
  bucket[entry.key] = entry.value;
  doc[entry.kind] = bucket;
  doc.version = 1;
  await writeJsonAtomic(file, doc);
}

/** Drop entries whose retention window passed or whose workspace is gone. */
export async function purgeExpired(deps) {
  const { paths, registry, settings } = deps;
  if (settings.trashEnabled !== true) return 0;
  const entries = await scanEntries(paths, registry);
  let removed = 0;
  for (const entry of entries) {
    if (workspaceLost(entry.meta, registry) || expired(entry.meta, settings.retentionDays)) {
      await fsp.rm(entry.entryDir, { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

/** List refresh also enforces workspace cascade and retention. */
export async function listTrash(deps, scope = {}) {
  const { paths, registry, settings } = deps;
  const entries = await scanEntries(paths, registry);
  const kept = [];
  let changed = false;
  for (const entry of entries) {
    if (workspaceLost(entry.meta, registry) || expired(entry.meta, settings.retentionDays)) {
      await fsp.rm(entry.entryDir, { recursive: true, force: true });
      changed = true;
      continue;
    }
    kept.push(entry);
  }

  let order = new Map();
  try {
    order = new Map((registry?.list?.() ?? []).map((workspace, index) => [workspace.id, index]));
  } catch {
    order = new Map();
  }

  const groups = new Map();
  for (const entry of kept) {
    const bucket = bucketOf(entry.meta, registry);
    const key = bucket.workspaceId;
    let group = groups.get(key);
    if (group === undefined) {
      group = { workspaceId: key, workspaceTitle: bucket.workspaceTitle, items: [] };
      groups.set(key, group);
    }
    group.items.push({
      sessionId: entry.meta.sessionId,
      title: entry.meta.title,
      deletedAt: entry.meta.deletedAt,
      lastUpdatedAt: entry.meta.lastUpdatedAt,
      sizeBytes: entry.meta.sizeBytes,
      cwd: entry.meta.cwd,
      position: entry.meta.position,
      workspaceTitle: bucket.workspaceTitle,
    });
  }

  const list = [...groups.values()];
  for (const group of list) group.items.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  list.sort((a, b) => (order.get(a.workspaceId) ?? 9999) - (order.get(b.workspaceId) ?? 9999));

  // A Session-menu entry scopes the dialog to that Session's workspace.
  let scoped = list;
  if (typeof scope.workspaceId === 'string' && scope.workspaceId !== '') {
    scoped = list.filter((group) => group.workspaceId === scope.workspaceId);
  } else if (typeof scope.sessionId === 'string' && scope.sessionId !== '') {
    let target;
    try {
      target = findOwningWorkspace(registry, scope.sessionId)?.id ?? UNGROUPED;
    } catch {
      target = UNGROUPED;
    }
    scoped = list.filter((group) => group.workspaceId === target);
  }

  const count = scoped.reduce((total, group) => total + group.items.length, 0);
  const size = scoped.reduce((total, group) => total + group.items.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0), 0);
  if (changed) await writeJsonAtomic(paths.indexFile, { version: 1, updatedAt: new Date().toISOString(), count });
  return { groups: scoped, count, size };
}

/** Drop every recycle-bin record that belonged to one deleted workspace. */
export async function purgeWorkspace(paths, workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId === '' || workspaceId === UNGROUPED) return { removed: false };
  const bucket = path.join(paths.trashDir, workspaceId);
  try {
    await fsp.rm(bucket, { recursive: true, force: true });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

/** Locate one entry across all buckets by session id. */
async function findEntry(paths, registry, sessionId) {
  for (const entry of await scanEntries(paths, registry)) {
    if (entry.meta.sessionId === sessionId) return entry;
  }
  return undefined;
}

/** Restamp every file under one restored session directory with the current time. */
async function touchTree(dir) {
  const now = new Date();
  for (const entry of await readDirSafe(dir)) {
    const target = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) await touchTree(target);
      await fsp.utimes(target, now, now);
    } catch {
      // A file that vanished or is locked keeps its old timestamp.
    }
  }
  try {
    await fsp.utimes(dir, now, now);
  } catch {
    // The directory timestamp is not used by the engine.
  }
}

/** Move one entry's log back and re-account it in its original workspace. */export async function restoreSession(deps, sessionId) {
  const { paths, registry, settings } = deps;
  if (settings.trashEnabled !== true) throw failure('trash-disabled', '会话找回已在设置中关闭。');
  const entry = await findEntry(paths, registry, sessionId);
  if (entry === undefined) throw failure('trash-missing', '回收站中找不到该会话。');
  const meta = entry.meta;
  const originalPath = typeof meta.originalPath === 'string' ? meta.originalPath : undefined;
  if (originalPath === undefined || originalPath.startsWith('..') || path.isAbsolute(originalPath)) {
    throw failure('trash-corrupt', '删除记录的原始路径无效，无法恢复。');
  }
  const target = path.join(paths.sessionsRoot, originalPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rename(path.join(entry.entryDir, 'log'), target);
  // The sync engine revives a session instead of deleting it when its log is
  // newer than the deletion tombstone; a restored log inherits the original
  // mtime, so stamp it now to make the restore visible across machines.
  await touchTree(target);

  let attached = false;
  let warning;
  let workspace;
  try {
    workspace = registry?.get?.(meta.workspaceId);
  } catch {
    workspace = undefined;
  }
  if (workspace === undefined && typeof meta.cwd === 'string' && meta.cwd !== '') {
    // Workspace ids can differ between machines after a workspace.json merge;
    // fall back to the recorded directory.
    try {
      workspace = registry?.resolveByPath?.(meta.cwd);
    } catch {
      workspace = undefined;
    }
  }
  if (workspace === undefined) {
    warning = meta.workspaceId === UNGROUPED ? undefined : '原工作区已不存在，会话已恢复为未分组状态。';
  } else {
    try {
      await workspace.attachSession(sessionId);
      attached = true;
    } catch (error) {
      warning = `会话已恢复，但无法挂回原工作区：${error.message}`;
    }
  }
  if (attached && typeof meta.position?.next === 'string') {
    try {
      await workspace.insertSessionBefore(sessionId, meta.position.next);
    } catch {
      // Order restoration is best effort; membership already succeeded.
    }
  }
  await fsp.rm(entry.entryDir, { recursive: true, force: true });
  return { sessionId, workspaceId: meta.workspaceId, attached, warning };
}

/** Remove one entry's files for good. */
export async function purgeSession(deps, sessionId) {
  const { paths, registry } = deps;
  const entry = await findEntry(paths, registry, sessionId);
  if (entry === undefined) throw failure('trash-missing', '回收站中找不到该会话。');
  await fsp.rm(entry.entryDir, { recursive: true, force: true });
  return { sessionId };
}

/** Remove every entry, or every entry of one workspace. */
export async function clearTrash(deps, scope = {}) {
  const { paths, registry } = deps;
  const workspaceId = typeof scope.workspaceId === 'string' ? scope.workspaceId : '';
  if (workspaceId !== '') {
    if (!/^[A-Za-z0-9._-]+$/u.test(workspaceId)) throw failure('bad-workspace-id', '工作区标识无效。');
    const bucket = path.join(paths.trashDir, workspaceId);
    let removed = 0;
    for (const item of await readDirSafe(bucket)) {
      if (!item.isDirectory()) continue;
      await fsp.rm(path.join(bucket, item.name), { recursive: true, force: true });
      removed += 1;
    }
    return { removed };
  }
  const entries = await scanEntries(paths, registry);
  let removed = 0;
  for (const entry of entries) {
    await fsp.rm(entry.entryDir, { recursive: true, force: true });
    removed += 1;
  }
  return { removed };
}
