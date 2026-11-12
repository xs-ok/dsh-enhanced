/**
 * Environment self-check for DSH增强.
 *
 * Everything the plugin relies on but does not own is probed here: host services,
 * the Node features the engine needs, and the on-disk formats it reads and writes.
 * A failed check never throws; it is reported so the user can export a report.
 */
import { promises as fsp } from 'node:fs';
import { pluginVersion } from './version.js';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { scanFrames } from './engine/zstd.js';
import { scanSessions, projectKey } from './engine/scan.js';



async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort host application version: env first, then the packaged manifest. */
export async function appVersion() {
  const candidates = [
    process.env.DSH_CLIENT_VERSION,
    process.env.DSH_APP_VERSION,
    process.env.DSH_VERSION,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return { version: value.trim(), source: 'env' };
  }
  const resources = [
    typeof process.resourcesPath === 'string' ? process.resourcesPath : null,
    process.execPath === undefined ? null : path.join(path.dirname(process.execPath), 'resources'),
  ].filter(Boolean);
  for (const base of resources) {
    for (const entry of ['app.asar', 'app']) {
      const manifest = path.join(base, entry, 'package.json');
      const doc = await readJson(manifest);
      if (typeof doc?.version === 'string' && doc.version !== '') {
        return { version: doc.version, source: manifest };
      }
    }
  }
  return { version: null, source: 'unknown' };
}

function check(id, label, ok, detail, severity = 'high') {
  return { id, label, ok, detail, severity };
}

/**
 * Run every probe.
 * @returns `{ ok, checks, appVersion, pluginVersion, checkedAt }`.
 */
export async function runEnvironmentCheck(deps) {
  const { paths, ctx } = deps;
  const checks = [];

  // 1. host services the plugin injects
  const services = ['webServer', 'connection', 'sessionPersistence', 'workspaceRegistry'];
  for (const key of services) {
    const service = ctx?.get?.(key);
    checks.push(check(`service:${key}`, `宿主服务 ${key}`, service !== undefined, service === undefined ? '未注册（插件可能无法正常工作）' : '可用'));
  }

  const registry = ctx?.get?.('workspaceRegistry');
  const registryMethods = ['get', 'list', 'resolveByPath', 'unpinSession', 'unarchiveSession'];
  const missingRegistry = registry === undefined ? registryMethods : registryMethods.filter((name) => typeof registry[name] !== 'function');
  checks.push(check('methods:workspaceRegistry', '工作区注册表方法完整', missingRegistry.length === 0, missingRegistry.length === 0 ? '全部存在' : `缺少：${missingRegistry.join('、')}`));

  // Membership edits live on one Workspace instance, not on the registry.
  const workspaceMethods = ['attachSession', 'detachSession', 'insertSessionBefore'];
  let sampleWorkspace;
  try {
    sampleWorkspace = registry?.list?.()[0];
  } catch {
    sampleWorkspace = undefined;
  }
  if (sampleWorkspace === undefined) {
    checks.push(check('methods:workspace', '工作区成员接口', true, '暂无工作区，跳过该项', 'low'));
  } else {
    const missingWorkspace = workspaceMethods.filter((name) => typeof sampleWorkspace[name] !== 'function');
    checks.push(check('methods:workspace', '工作区成员接口', missingWorkspace.length === 0, missingWorkspace.length === 0 ? '全部存在' : `缺少：${missingWorkspace.join('、')}`));
  }

  const agents = ctx?.get?.('agents');
  const agentSample = Array.isArray(agents?.list?.()) ? agents.list()[0] : undefined;
  checks.push(check(
    'methods:agents',
    '会话状态接口可用',
    typeof agents?.list === 'function' && (agentSample === undefined || 'status' in agentSample),
    typeof agents?.list === 'function' ? '可读取 status' : '缺少 agents.list',
    'medium',
  ));

  // 2. runtime features the engine needs
  checks.push(check(
    'node:zstd',
    'Node zstd 能力',
    typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function',
    typeof zlib.zstdCompressSync === 'function' ? '可用' : '当前 Node 缺少 zstd，会话读写不可用',
  ));
  checks.push(check('node:fetch', 'Node fetch 可用', typeof fetch === 'function', typeof fetch === 'function' ? '可用' : '缺少 fetch，WebDAV 不可用'));

  // 3. session format
  const sessionsRoot = path.join(paths.home, 'sessions');
  const sessions = await scanSessions(sessionsRoot);
  if (sessions.size === 0) {
    checks.push(check('format:sessions', '会话文件格式', false, '未找到任何会话，无法验证格式', 'medium'));
  } else {
    const sample = sessions.values().next().value;
    let detail = '无法读取样本会话';
    let ok = false;
    try {
      const buffer = await fsp.readFile(sample.file);
      const frames = scanFrames(buffer);
      const text = frames.length === 0 ? '' : zlib.zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8');
      const header = text.split('\n').find((line) => line.trim() !== '');
      const parsed = header === undefined ? undefined : JSON.parse(header);
      ok = frames.length > 0 && parsed?.type === 'session' && typeof parsed.id === 'string' && typeof parsed.cwd === 'string';
      detail = ok
        ? `帧数 ${String(frames.length)}，首行字段齐全`
        : `帧数 ${String(frames.length)}，首行 ${ok ? '正常' : '缺少 type/id/cwd'}`;
    } catch (error) {
      detail = `读取失败：${String(error?.message ?? error)}`;
    }
    checks.push(check('format:sessions', '会话文件格式', ok, detail));

    // projectKey must still match the folder the host chose
    const expected = projectKey(sample.projectKey.startsWith('--') ? sample.projectKey : '');
    const dirName = path.basename(path.dirname(path.dirname(sample.file)));
    checks.push(check(
      'format:projectKey',
      '项目目录命名规则',
      dirName === sample.projectKey || expected === '',
      `目录 ${dirName}，记录 ${sample.projectKey}`,
      'medium',
    ));
  }

  // 4. workspace.json schema
  const workspaceFile = path.join(paths.home, 'storages', 'workspace.json');
  const workspaceDoc = await readJson(workspaceFile);
  if (workspaceDoc === undefined) {
    checks.push(check('format:workspace', 'workspace.json 结构', false, '文件缺失或无法解析', 'medium'));
  } else {
    const unitVersion = Number(workspaceDoc.unit?.version);
    const table = workspaceDoc.tables?.workspaces;
    const records = table !== null && typeof table === 'object' ? Object.values(table) : [];
    const badPaths = records.filter((record) => typeof record?.path !== 'string' || record.path === '').length;
    checks.push(check(
      'format:workspace',
      'workspace.json 结构',
      records.length > 0 && badPaths === 0 && Number.isFinite(unitVersion),
      `版本 ${String(unitVersion)}，分组 ${String(records.length)} 个${badPaths > 0 ? `，其中 ${String(badPaths)} 个 path 非法` : ''}`,
    ));
  }

  // 5. title cache shape (optional)
  const shardDir = path.join(paths.home, 'storages', 'session_projcache', 'sessions');
  if (await exists(shardDir)) {
    let entries = [];
    try {
      entries = (await fsp.readdir(shardDir)).filter((name) => name.endsWith('.json')).slice(0, 3);
    } catch {
      entries = [];
    }
    let ok = entries.length === 0;
    let detail = '暂无缓存分片';
    for (const name of entries) {
      const doc = await readJson(path.join(shardDir, name));
      const rows = doc?.record?.rows ?? doc?.rows;
      if (rows !== undefined && rows !== null) {
        ok = true;
        detail = 'record.rows 结构可读';
        break;
      }
    }
    checks.push(check('format:titles', '会话标题缓存结构', ok, detail, 'low'));
  }

  // 6. attachments layout (optional)
  const attachmentsRoot = path.join(paths.home, 'attachments', 'v1');
  checks.push(check(
    'format:attachments',
    '附件目录结构',
    await exists(attachmentsRoot),
    (await exists(path.join(attachmentsRoot, 'objects'))) ? 'objects 目录存在' : '尚无附件对象',
    'low',
  ));

  // 7. profile config used by the sync
  const profile = process.env.DSH_PROFILE ?? 'desktop';
  const patchFile = path.join(paths.home, 'profiles', profile, 'cordis.patch.yml');
  checks.push(check('file:profile', '当前 profile 补丁文件', await exists(patchFile), patchFile, 'low'));

  // 8. data directory writable
  let writable = false;
  try {
    const probe = path.join(paths.base, `.env-check-${String(process.pid)}.tmp`);
    await fsp.writeFile(probe, 'ok', 'utf8');
    await fsp.rm(probe, { force: true });
    writable = true;
  } catch {
    writable = false;
  }
  checks.push(check('fs:data', '插件数据目录可写', writable, paths.base));

  // 9. host version detectable
  const version = await appVersion();
  checks.push(check('app:version', '主程序版本可识别', version.version !== null, version.version ?? '无法读取（版本变化提醒不可用，其余检测不受影响）', 'low'));

  const failed = checks.filter((item) => item.ok !== true);
  return {
    ok: failed.length === 0,
    checkedAt: new Date().toISOString(),
    pluginVersion: pluginVersion(),
    appVersion: version.version,
    appVersionSource: version.source,
    checks,
    failedCount: failed.length,
  };
}

/** Where the desktop report is written. */
function desktopDirectory() {
  const desktop = path.join(os.homedir(), 'Desktop');
  return desktop;
}

/** Where the last-seen application version is remembered. */
function recordFile(paths) {
  return path.join(paths.base, 'env-check.json');
}

/** Read the remembered version. */
export async function readEnvRecord(paths) {
  return (await readJson(recordFile(paths))) ?? {};
}

/** Remember the current application version. */
export async function writeEnvRecord(paths, patch) {
  const current = await readEnvRecord(paths);
  await fsp.writeFile(recordFile(paths), `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, 'utf8');
  return { ...current, ...patch };
}

/** Write the report and return its path. */
export async function writeEnvironmentReport(deps, result) {
  const target = desktopDirectory();
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
  const file = path.join(target, `DSH增强-环境检测-${stamp}.md`);
  const lines = [
    '# DSH增强 · 环境检测报告',
    '',
    `- 检测时间：${result.checkedAt}`,
    `- 插件版本：V${result.pluginVersion}`,
    `- 主程序版本：${result.appVersion ?? '未知'}`,
    `- 结论：${result.ok ? '全部通过' : `发现 ${String(result.failedCount)} 项风险`}`,
    '',
    '## 检测明细',
    '',
    '| 结果 | 项目 | 说明 | 严重度 |',
    '| --- | --- | --- | --- |',
    ...result.checks.map((item) => `| ${item.ok ? '通过' : '**异常**'} | ${item.label} | ${String(item.detail ?? '').replace(/\|/gu, '\\|')} | ${item.severity} |`),
    '',
    '## 说明',
    '',
    '- 异常项按严重度排序观察：high 表示可能直接影响会话数据，medium 表示部分功能失效，low 表示可忽略。',
    '- 若“会话文件格式”或“workspace.json 结构”异常，建议升级插件版本，而不要继续同步。',
  ];
  await fsp.mkdir(target, { recursive: true }).catch(() => {});
  await fsp.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return { ok: true, path: file };
}
