/**
 * Sync runner for DSH增强 — JavaScript engine only.
 *
 * One run is: resolve the target, verify this machine's identity, (WebDAV) pull
 * the mirror down, run the engine, sync the recycle bin, (WebDAV) push the mirror
 * back, then record the outcome. The PowerShell engine and its zstd helper are
 * gone; everything below the transport layer lives in `host/engine/`.
 */
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { runSyncJs } from './engine/index.js';
import { syncTrash } from './trashsync.js';
import { measureMirror, pullMirror, pullMirrorFast, pushMirror } from './mirror.js';

const TAIL_LINES = 400;
const HISTORY_CAP = 1000;

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
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file).catch(async () => {
    await fsp.rm(file, { force: true }).catch(() => {});
    await fsp.rename(temporary, file);
  });
}

function tailLines(text, limit = TAIL_LINES) {
  const lines = String(text).split(/\r?\n/u);
  return lines.slice(Math.max(0, lines.length - limit));
}

/** Read (or create) the per-installation id used to detect id collisions. */
async function readInstanceId(baseDir) {
  const file = path.join(baseDir, 'instance-id.txt');
  try {
    const text = await fsp.readFile(file, 'utf8');
    if (text.trim() !== '') return text.trim();
  } catch {
    // First run on this installation.
  }
  const id = randomUUID();
  await fsp.mkdir(baseDir, { recursive: true }).catch(() => {});
  await fsp.writeFile(file, id, 'utf8').catch(() => {});
  return id;
}

/**
 * Refuse to sync when this machine id is already claimed by a different
 * installation: two devices with one id overwrite each other's baseline and
 * tombstone each other's sessions.
 */
export async function checkIdentity(shareDir, machineId, baseDir) {
  const stateDir = path.join(shareDir, 'config', 'sync-state');
  const file = path.join(stateDir, 'instances.json');
  const registry = (await readJson(file)) ?? {};
  const machines = registry.machines !== null && typeof registry.machines === 'object' ? registry.machines : {};
  const instanceId = await readInstanceId(baseDir);
  const existing = machines[machineId];
  if (typeof existing === 'string' && existing !== instanceId) {
    return { ok: false, machines: Object.keys(machines).sort() };
  }
  machines[machineId] = instanceId;
  await writeJson(file, { version: 1, updatedAt: new Date().toISOString(), machines }).catch(() => {});
  return { ok: true, machines: Object.keys(machines).sort() };
}

/** The folder the engine reads and writes for the active mode. */
export function effectiveShareDir(settings) {
  const mode = settings.syncMode === 'webdav' ? 'webdav' : 'local';
  const raw = mode === 'webdav' ? settings.mirrorDir : settings.syncDir;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Resolve the share root and identity for one run. */
export function resolveSyncTarget(paths, settings) {
  const mode = settings.syncMode === 'webdav' ? 'webdav' : 'local';
  const syncDir = effectiveShareDir(settings);
  const machineId = (typeof settings.syncMachineId === 'string' && settings.syncMachineId.trim() !== '')
    ? settings.syncMachineId.trim()
    : path.basename(process.env.USERPROFILE ?? '') || os.userInfo().username;
  const profile = process.env.DSH_PROFILE ?? 'desktop';
  return {
    mode,
    syncDir,
    machineId,
    profile,
    stateFile: path.join(paths.base, 'sync-state.json'),
    logFile: path.join(paths.base, 'sync-last.log'),
    historyFile: path.join(paths.base, 'sync-history.json'),
  };
}

/** Session id -> title, read from the mirrored projection shards. */
async function readTitles(syncDir) {
  const titles = new Map();
  const dir = path.join(syncDir, 'config', 'storages', 'session_projcache', 'sessions');
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return titles;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    try {
      const doc = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      const value = doc?.record?.rows?.title?.val;
      if (typeof value === 'string' && value.trim() !== '') titles.set(id, value.trim());
    } catch {
      // An unreadable shard simply has no title.
    }
  }
  return titles;
}

/** Group paths by session: the log first, then its projection shard. */
function sessionRels(list) {
  const of = (rel) => {
    const match = /session-([0-9a-f-]{8,})/iu.exec(rel);
    return match === null ? '' : match[1];
  };
  const rank = (rel) => (rel.startsWith('sessions/') ? 0 : (rel.includes('session_projcache') ? 1 : 2));
  return [...list].sort((left, right) => {
    const a = of(left);
    const b = of(right);
    if (a !== '' && b !== '' && a === b) return rank(left) - rank(right) || left.localeCompare(right);
    if (a === '' && b === '') return left.localeCompare(right);
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b) || rank(left) - rank(right);
  });
}

/** Name one path: session files carry the session title in front of the path. */
function describePath(rel, titleMap) {
  const match = /(^|\/)session-([^/]+)\//u.exec(rel) ?? /session-(.+)\.json$/u.exec(rel);
  const id = match === null ? '' : `session-${match[2] ?? match[1]}`;
  const title = id === '' ? '' : titleMap.get(id);
  return title === undefined || title === '' ? rel : `${title} · ${rel}`;
}

/**
 * Badge numbers for ⬆ / ⬇ / 🗑: session files only.
 *
 * The transport moves more than sessions (title shards under
 * config/storages/session_projcache, config, attachments, trash), but the badge
 * answers "how many sessions moved", so only the `sessions/` bucket is counted.
 * Other categories still show up in the log lines and their own category line.
 */
export function sessionBadgeCounts(transport, summary) {
  const uploaded = Number(transport?.pushed?.uploaded) || 0;
  const downloaded = Number(transport?.pulled?.downloaded) || 0;
  const sessionUploaded = Number(transport?.pushed?.categories?.sessions) || 0;
  const sessionDownloaded = Number(transport?.pulled?.categories?.sessions) || 0;
  const sessionDeleted = Number(transport?.pushed?.deletedCategories?.sessions) || 0;
  return {
    up: uploaded > 0 ? sessionUploaded : Number(summary?.sessions?.pushed) || 0,
    down: downloaded > 0 ? sessionDownloaded : Number(summary?.sessions?.pulled) || 0,
    del: sessionDeleted,
  };
}

/** Human-readable summary lines for the settings page. */
function logLines(summary, transport, titleMap = new Map()) {
  const counts = (value) => String(Number(value) || 0);
  const pushed = Number(summary.sessions?.pushed) || 0;
  const pulled = Number(summary.sessions?.pulled) || 0;
  const configCopied = Number(summary.config?.copied) || 0;
  const attachCopied = Number(summary.attachments?.copied) || 0;
  const prunedLocal = Number(summary.prune?.quarantined) || 0;
  const prunedCloud = Number(summary.prune?.sharedDeleted) || 0;
  const prunedKept = Number(summary.prune?.kept) || 0;
  const titles = Number(summary.titleMerge?.updated) || 0;
  const localGroups = Number(summary.workspace?.local) || 0;
  const sharedGroups = Number(summary.workspace?.shared) || 0;

  const entries = [];
  const push = (line, files) => entries.push({ line, files: Array.isArray(files) ? files.slice(0, 300) : [] });
  push(pushed === 0 && pulled === 0
    ? '会话：双端一致，无传输'
    : `会话：云端推送 ${counts(pushed)} 个，云端取回 ${counts(pulled)} 个`,
  [
    ...(summary.sessions?.pushedIds ?? []).map((id) => `推送上云：${titleMap.get(id) ?? id}`),
    ...(summary.sessions?.pulledIds ?? []).map((id) => `从云取回：${titleMap.get(id) ?? id}`),
  ]);
  push(configCopied === 0 && attachCopied === 0
    ? '配置附件：双端一致，无更新'
    : `配置附件：更新配置 ${counts(configCopied)} 个、附件 ${counts(attachCopied)} 个`,
  (summary.configDetails ?? []).map((item) => `${item.action === 'push' ? '上云' : '下载'}：${item.rel}`));
  push(`工作区：本机 ${counts(localGroups)} 个、云端 ${counts(sharedGroups)} 个${titles > 0 ? `，对齐会话标题 ${counts(titles)} 个` : ''}`);
  push(prunedLocal === 0 && prunedCloud === 0 && prunedKept === 0
    ? '失效清理：无需清理'
    : `失效清理：移入隔离区 ${counts(prunedLocal)} 个、云端删除 ${counts(prunedCloud)} 个、保留 ${counts(prunedKept)} 个`,
  (summary.prune?.sharedDeletedRels ?? []).map((rel) => `云端删除：${rel}`));
  push(Number(summary.plugins) === 0
    ? '插件清单：无需更新'
    : `插件清单：本机 ${counts(summary.plugins)} 个，已推送云端`,
  Number(summary.plugins) > 0 ? ['config/plugin-list.txt'] : []);
  if (Number(summary.archive?.released) > 0) {
    push(`会话归档：从云端解除会话归档 ${counts(summary.archive.released)} 个`);
  }
  if (transport !== null && transport !== undefined) {
    const uploaded = Number(transport.pushed?.uploaded) || 0;
    const downloaded = Number(transport.pulled?.downloaded) || 0;
    if (uploaded > 0 || downloaded > 0) {
      push(`云端传输：上传 ${counts(uploaded)} 个、下载 ${counts(downloaded)} 个文件`,
        [
          ...sessionRels(transport.pushed?.uploadedRels ?? []).map((rel) => `上传：${describePath(rel, titleMap)}`),
          ...sessionRels(transport.pushed?.deletedRels ?? []).map((rel) => `云端删除：${describePath(rel, titleMap)}`),
          ...sessionRels(transport.pulled?.downloadedRels ?? []).map((rel) => `下载：${describePath(rel, titleMap)}`),
        ]);
      const parts = [];
      const categories = transport.pushed?.categories ?? {};
      const labels = { sessions: '会话文件', config: '配置文件', titles: '标题文件', trash: '回收站文件', attachments: '附件', other: '其他文件' };
      for (const [key, label] of Object.entries(labels)) {
        const value = Number(categories[key]) || 0;
        if (value > 0) parts.push(`${label} ${counts(value)} 个`);
      }
      if (parts.length > 0) push(`  其中上传：${parts.join('、')}`);
    }
  }
  for (const item of (summary.configDetails ?? []).slice(0, 10)) {
    const delta = item.deltaMs === null
      ? '只有一侧存在'
      : (Math.abs(item.deltaMs) >= 3_600_000
        ? `相差 ${counts(Math.round(Math.abs(item.deltaMs) / 3_600_000))} 小时`
        : (Math.abs(item.deltaMs) >= 60_000
          ? `相差 ${counts(Math.round(Math.abs(item.deltaMs) / 60_000))} 分钟`
          : `相差 ${counts(Math.max(1, Math.round(Math.abs(item.deltaMs) / 1000)))} 秒`));
    push(`更新配置：${item.rel}（${item.action === 'push' ? '本机较新' : (item.action === 'staged' ? '云端较新，重启应用后生效' : '云端较新')}，${delta}）`, [`${item.action === 'push' ? '上云' : '下载'}：${item.rel}`]);
  }
  if (Array.isArray(summary.phases) && summary.ok === false) {
    push(`中止：阶段 ${summary.failed?.phase ?? '未知'}，${summary.failed?.error ?? ''}`);
  }
  const kept = entries.slice(Math.max(0, entries.length - TAIL_LINES));
  return { lines: kept.map((entry) => entry.line), details: kept.map((entry) => entry.files) };
}

/** Map a failure to a short diagnosis and an actionable hint. */
export function diagnose(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error);
  const cause = String(error?.cause?.code ?? '');
  const network = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EHOSTUNREACH'];
  if (network.includes(cause) || network.includes(code) || message.includes('fetch failed') || message.includes('无法连接')) {
    return { summary: '网络不可达', hint: '检查网络、代理或 VPN；确认 WebDAV 地址可访问。' };
  }
  if (code === 'webdav-pull-failed' || message.includes('503') || message.includes('429')) {
    return { summary: '云端限流或暂时不可用', hint: '等待 10 分钟后重试；连续出现时降低同步频率。' };
  }
  if (message.includes('401') || message.includes('403')) {
    return { summary: '云端认证失败', hint: '检查 WebDAV 账号与应用密码（坚果云需用应用密码）。' };
  }
  if (message.includes('404')) {
    return { summary: '远程目录不存在', hint: '确认远程根目录写法正确，或打开“自动创建远程目录”。' };
  }
  if (code === 'machine-id-conflict') {
    return { summary: '机器标识冲突', hint: '在设置里换一个未被占用的机器标识。' };
  }
  if (code === 'sync-dir-missing') {
    return { summary: '未配置同步目录', hint: '填写共享目录（本地模式）或本地镜像目录（WebDAV 模式）。' };
  }
  if (code === 'sessions-root-missing') {
    return { summary: '会话目录不可读', hint: '检查 DSH 主目录是否被移动或权限不足。' };
  }
  if (code === 'tombstone-corrupt') {
    return { summary: '删除记录文件损坏', hint: '先备份并移走 deleted-sessions.json，再重新同步。' };
  }
  if (code === 'sync-busy') {
    return { summary: '已有同步正在进行', hint: '等上一轮结束再试。' };
  }
  if (code === 'webdav-throttled') {
    return { summary: '云端处于限流冷却期', hint: '等冷却结束（约 10 分钟）后自动恢复。' };
  }
  if (code === 'phase-failed' || error?.phase !== undefined) {
    return { summary: `同步在阶段“${String(error?.phase ?? '未知')}”失败`, hint: '查看下方日志定位具体文件；下一次同步会自动续做。' };
  }
  return { summary: '同步未完成', hint: '查看下方原因；必要时运行“环境检测”。' };
}

/** Record a failed run so the log panel is not silently empty. */
async function recordFailure(deps, error, startedAt, probe) {
  try {
    const target = resolveSyncTarget(deps.paths, deps.settings);
    const diagnosis = diagnose(error);
    const record = {
      at: new Date().toISOString(),
      probe: probe === true,
      engine: 'js',
      ok: false,
      durationMs: Date.now() - startedAt,
      summary: { ok: false, failed: { phase: error?.phase ?? null, error: String(error?.message ?? error) } },
      transport: null,
      syncDir: target.syncDir,
      machineId: target.machineId,
      error: String(error?.message ?? error),
      diagnosis,
      log: [
        `同步失败：${diagnosis.summary}`,
        `原因：${String(error?.message ?? error)}`,
        `建议：${diagnosis.hint}`,
      ],
      details: [[], [], []],
    };
    await writeJson(target.stateFile, record).catch(() => {});
    await appendHistory(target.historyFile, record).catch(() => {});
  } catch {
    // Recording a failure must never mask the original error.
  }
}

/** Run one sync: transport, engine, recycle bin, transport back, record. */
export async function runSync(deps, options = {}) {
  const startedAt = Date.now();
  try {
    return await runSyncInner(deps, options, startedAt);
  } catch (error) {
    await recordFailure(deps, error, startedAt, options.probe);
    throw error;
  }
}

async function runSyncInner(deps, options, startedAt) {
  const { paths, settings } = deps;
  const probe = options.probe === true;
  const target = resolveSyncTarget(paths, settings);

  if (target.syncDir === '') {
    throw Object.assign(new Error('请先在设置里填写共享目录。'), { code: 'sync-dir-missing' });
  }

  let pulled = null;
  if (!probe && target.mode === 'webdav') {
    try {
      // The manifest is a complete index of the share, so the common case needs one
      // GET instead of a PROPFIND tour. A full scan runs when the manifest is
      // missing and after the freshness window, catching outside changes.
      const scanFile = path.join(paths.base, 'mirror-scan.json');
      const scan = await readJson(scanFile, { lastFullScan: 0 });
      const fresh = Number(scan?.lastFullScan) > 0 && Date.now() - Number(scan.lastFullScan) < 30 * 60 * 1000;
      pulled = fresh ? await pullMirrorFast({ settings, paths }) : null;
      if (pulled === null) {
        pulled = await pullMirror({ settings, paths });
        await writeJson(scanFile, { lastFullScan: Date.now() }).catch(() => {});
      }
    } catch (error) {
      throw Object.assign(new Error(`下载云端失败：${String(error?.message ?? error)}`), { code: 'webdav-pull-failed' });
    }
  }

  if (!probe) {
    const identity = await checkIdentity(target.syncDir, target.machineId, paths.base);
    if (identity.ok !== true) {
      throw Object.assign(
        new Error(`机器标识“${target.machineId}”已被另一台设备使用（共享中现有：${identity.machines.join('、')}）。请在设置里换一个不同的标识后重试。`),
        { code: 'machine-id-conflict', machines: identity.machines },
      );
    }
  }

  let summary;
  try {
    summary = await runSyncJs({
      dshHome: paths.home,
      syncDir: target.syncDir,
      machineId: target.machineId,
      user: target.machineId,
      profile: target.profile,
      apply: !probe,
      now: startedAt,
      skipAttachments: settings.syncSkipAttachments === true,
    });
  } catch (error) {
    summary = {
      ok: false,
      failed: { phase: error?.phase ?? null, error: String(error?.message ?? error) },
      phases: [],
      sessions: { pushed: 0, pulled: 0, skipped: 0 },
      config: { copied: 0, skipped: 0 },
      attachments: { copied: 0, skipped: 0 },
      prune: {},
      workspace: {},
      titleMerge: {},
      plugins: 0,
      archive: {},
    };
  }

  let trash = null;
  if (!probe && summary.ok !== false) {
    try {
      trash = await syncTrash({ paths, settings, machineId: target.machineId, syncDir: target.syncDir });
    } catch (error) {
      trash = { error: String(error?.message ?? error) };
    }
  }

  let pushed = null;
  if (!probe && summary.ok !== false && target.mode === 'webdav') {
    try {
      pushed = await pushMirror({ settings, paths, useManifestIndex: pulled?.fast === true });
    } catch (error) {
      pushed = { ok: false, error: String(error?.message ?? error) };
    }
  }

  const transport = !probe && target.mode === 'webdav' ? { pulled, pushed } : null;
  const titles = await readTitles(target.syncDir).catch(() => new Map());
  const logOutput = logLines(summary, transport, titles);
  // The tooltip must explain exactly the number shown, so the list and the count
  // come from the same source: transport files when there is a transport, else
  // the session ids of the engine phase.
  const uploaded = Number(transport?.pushed?.uploaded) || 0;
  const downloaded = Number(transport?.pulled?.downloaded) || 0;
  // The badge counts session files only (see sessionBadgeCounts); the lists below
  // are filtered the same way so the tooltip explains exactly the number shown.
  const sessionRels = (list) => (Array.isArray(list) ? list : [])
    .filter((rel) => typeof rel === 'string' && rel.startsWith('sessions/'));
  const upList = uploaded > 0
    ? sessionRels(transport?.pushed?.uploadedRels).map((rel) => describePath(rel, titles))
    : (summary.sessions?.pushedIds ?? []).map((id) => `会话：${titles.get(id) ?? id}`);
  const downList = downloaded > 0
    ? sessionRels(transport?.pulled?.downloadedRels).map((rel) => describePath(rel, titles))
    : (summary.sessions?.pulledIds ?? []).map((id) => `会话：${titles.get(id) ?? id}`);
  const delList = sessionRels(transport?.pushed?.deletedRels).map((rel) => describePath(rel, titles));
  const counts = sessionBadgeCounts(transport, summary);
  const countDetails = {
    up: upList.slice(0, 60),
    down: downList.slice(0, 60),
    del: delList.slice(0, 60),
  };
  const record = {
    at: new Date().toISOString(),
    probe,
    engine: 'js',
    targetLabel: describeTarget(settings, target),
    ok: summary.ok !== false && (pushed === null || pushed.ok !== false),
    durationMs: Date.now() - startedAt,
    summary,
    trash,
    transport,
    syncDir: target.syncDir,
    machineId: target.machineId,
    log: logOutput.lines,
    details: logOutput.details,
    counts,
    countDetails,
  };

  await writeJson(target.stateFile, record).catch(() => {});
  await fsp.writeFile(target.logFile, record.log.join('\n'), 'utf8').catch(() => {});
  await appendHistory(target.historyFile, record).catch(() => {});
  return record;
}

/** A short, user-chosen name for where this run sent its data. */
function describeTarget(settings, target) {
  if (target.mode !== 'webdav') return '本地目录';
  const url = typeof settings.webdavUrl === 'string' ? settings.webdavUrl.trim().replace(/\/+$/u, '') : '';
  const rootPath = typeof settings.webdavRoot === 'string' ? settings.webdavRoot.trim() : '';
  const presets = Array.isArray(settings.webdavProfiles) ? settings.webdavProfiles : [];
  const match = presets.find((item) => item.url.replace(/\/+$/u, '') === url
    && (item.root ?? '').replace(/\/+$/u, '') === rootPath.replace(/\/+$/u, ''));
  // Only a name the user chose is worth showing; the generated one is too long.
  if (match !== undefined && match.custom === true && match.name.trim() !== '') return match.name;
  return '';
}

/** Keep the last 10 runs, newest first, each with a short log slice. */
async function appendHistory(file, record) {
  const previous = (await readJson(file)) ?? [];
  const list = Array.isArray(previous) ? previous : [];
  if (list[0] !== undefined && list[0].at === record.at) list.shift();
  list.unshift({
    at: record.at,
    targetLabel: record.targetLabel ?? '',
    ok: record.ok,
    probe: record.probe,
    engine: 'js',
    durationMs: record.durationMs,
    trashPurged: record.trashPurged ?? 0,
    pushed: record.summary?.sessions?.pushed ?? 0,
    pulled: record.summary?.sessions?.pulled ?? 0,
    uploaded: record.transport?.pushed?.uploaded ?? 0,
    downloaded: record.transport?.pulled?.downloaded ?? 0,
    deleted: record.transport?.pushed?.deleted ?? record.summary?.prune?.sharedDeleted ?? 0,
    failed: (record.transport?.pushed?.failed?.length ?? 0) + (record.transport?.pulled?.failed?.length ?? 0),
    paths: record.summary?.paths ?? null,
    missing: record.summary?.missing ?? null,
    log: Array.isArray(record.log) ? record.log.slice(-60) : [],
  });
  await writeJson(file, pruneHistory(list));
}

/** Keep the newest `HISTORY_CAP` runs; older ones are dropped. */
function pruneHistory(list) {
  const kept = [];
  for (const entry of list) {
    if (!Number.isFinite(Date.parse(entry?.at ?? ''))) continue;
    kept.push(entry);
    if (kept.length >= HISTORY_CAP) break;
  }
  return kept;
}

/** Recent runs, newest first. */
/**
 * Record a one-way overwrite so it shows up in the log panel like a normal run.
 *
 * @param deps - resolved paths and settings.
 * @param info - counters and log lines of the finished overwrite.
 * @returns the record that was written.
 */
export async function recordOverwrite(deps, info) {
  const { paths, settings } = deps;
  const target = resolveSyncTarget(paths, settings);
  const record = {
    at: new Date().toISOString(),
    kind: 'overwrite',
    direction: info.direction,
    ok: info.ok !== false,
    durationMs: info.durationMs ?? 0,
    pushed: Number(info.uploaded ?? 0),
    pulled: Number(info.localized ?? 0),
    deleted: Number(info.deleted ?? 0),
    summary: {
      ok: info.ok !== false,
      kind: 'overwrite',
      direction: info.direction,
      sessions: { pushed: Number(info.uploaded ?? 0), pulled: 0 },
      config: { copied: Number(info.copied ?? 0) },
      transport: { uploaded: Number(info.uploaded ?? 0), deleted: Number(info.deleted ?? 0) },
    },
    log: Array.isArray(info.log) ? info.log : [],
  };
  await writeJson(target.stateFile, record).catch(() => {});
  await appendHistory(target.historyFile, record).catch(() => {});
  return record;
}

export async function readSyncHistory(deps) {
  const target = resolveSyncTarget(deps.paths, deps.settings);
  const list = (await readJson(target.historyFile)) ?? [];
  return Array.isArray(list) ? list : [];
}

/** Last recorded run, or null before the first one. */
export async function readSyncState(deps) {
  const target = resolveSyncTarget(deps.paths, deps.settings);
  return (await readJson(target.stateFile)) ?? null;
}

/** Target description for the settings page. */
export async function inspectSyncTarget(deps) {
  const target = resolveSyncTarget(deps.paths, deps.settings);
  let syncDirExists = false;
  if (target.syncDir !== '') {
    try {
      syncDirExists = (await fsp.stat(target.syncDir)).isDirectory();
    } catch {
      syncDirExists = false;
    }
  }
  let usage = null;
  if (target.syncDir !== '' && syncDirExists) {
    usage = await measureMirror(target.syncDir).catch(() => null);
  }
  return {
    mode: target.mode,
    engine: 'js',
    usage,
    script: 'js-engine',
    scriptExists: true,
    syncDir: target.syncDir,
    machineId: target.machineId,
    profile: target.profile,
    syncDirExists,
    syncDirConfigured: target.syncDir !== '',
    enabled: deps.settings.syncEnabled === true,
  };
}
