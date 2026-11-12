/**
 * Move one session into another workspace, in place.
 *
 * DSH derives a session's project directory from the `cwd` in its header and the
 * Host keeps that header in memory for as long as it has the session loaded, so
 * attaching a rewritten session would be rejected with a cwd mismatch. The move
 * therefore edits storage directly — log header plus `workspace.json` — and takes
 * effect the next time the app reads them, which is what a restart does.
 *
 * The rewrite is guarded: no live Agent, an existing target workspace different
 * from the current one, a verified read-back before the old copy is removed, and
 * an untouched original whenever anything fails.
 */
import { promises as fsp, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  failure,
  findOwningWorkspace,
  locateSessionDir,
  workspaceSnapshot,
} from './trash.js';
import { projectKey } from './engine/scan.js';
import { readSessionFile, rewriteCwd, writeSessionFile } from './engine/session.js';

const READ_PAGE = 500;

/** Read every durable event of one cold session, paging through the log. */
export async function readAllEvents(persistence, sessionId) {
  const handle = await persistence.open(sessionId, 'read');
  try {
    const events = [];
    let offset = 0;
    while (true) {
      const page = await handle.read(offset, READ_PAGE);
      const batch = page?.events ?? [];
      if (batch.length === 0) break;
      events.push(...batch);
      offset += batch.length;
      if (batch.length < READ_PAGE) break;
    }
    return events;
  } finally {
    await handle.close();
  }
}

/** The workspaces a session may move to, plus the one currently holding it. */
export async function moveCandidates(deps, sessionId) {
  const { registry } = deps;
  const current = findOwningWorkspace(registry, sessionId);
  const currentInfo = workspaceSnapshot(current);
  const workspaces = (registry?.list?.() ?? [])
    .map((workspace) => workspaceSnapshot(workspace))
    .filter((info) => info !== undefined && info.id !== currentInfo?.id)
    .map((info) => ({
      id: info.id,
      title: info.title,
      path: info.path,
      sessionCount: info.sessionIds.length,
    }));
  return {
    current: currentInfo === undefined ? null : { id: currentInfo.id, title: currentInfo.title },
    workspaces,
  };
}

/** The newest log file of a session directory. */
function newestLogFile(dir) {
  const files = readdirSync(dir).filter((name) => name.startsWith('session.v'));
  if (files.length === 0) return null;
  files.sort((a, b) => {
    const left = Number(/session\.v(\d+)/u.exec(a)?.[1] ?? 0);
    const right = Number(/session\.v(\d+)/u.exec(b)?.[1] ?? 0);
    return left - right;
  });
  return path.join(dir, files[files.length - 1]);
}

/** Same path on Windows, ignoring case and trailing separators. */
function samePath(left, right) {
  const clean = (value) => String(value).replace(/[\\/]+$/u, '').replace(/\//gu, '\\').toLowerCase();
  return clean(left) === clean(right);
}

/**
 * Rewrite the workspace document so the session belongs to the target group.
 * The file is the single durable record of membership; writing it directly avoids
 * the Host's in-memory check that would reject a session whose header still holds
 * the old cwd.
 */
async function rewriteMembership(paths, sessionId, targetWorkspaceId, targetPath) {
  const file = path.join(paths.home, 'storages', 'workspace.json');
  let doc;
  try {
    doc = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    throw failure('move-workspace-read', `无法读取工作区登记：${error.message}`);
  }
  const table = doc?.tables?.workspaces;
  if (table === null || typeof table !== 'object' || table[targetWorkspaceId] === undefined) {
    throw failure('move-workspace-record', '工作区登记里找不到目标分组。');
  }
  for (const record of Object.values(table)) {
    if (Array.isArray(record?.sessionIds)) {
      record.sessionIds = record.sessionIds.filter((id) => id !== sessionId);
    }
  }
  const target = table[targetWorkspaceId];
  target.sessionIds = [...(target.sessionIds ?? []), sessionId];
  target.updatedAt = new Date().toISOString();
  if (typeof target.path !== 'string' || target.path === '') target.path = targetPath;

  const temporary = `${file}.${String(process.pid)}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
}

/**
 * Move one session into another workspace.
 *
 * @param deps - Host services and resolved paths.
 * @param sessionId - source session.
 * @param targetWorkspaceId - destination workspace.
 * @returns the same session id with its new workspace and cwd.
 */
export async function moveSession(deps, sessionId, targetWorkspaceId) {
  const { paths, registry, persistence, agents, settings } = deps;
  if (settings.moveEnabled !== true) throw failure('move-disabled', '会话移动已在设置中关闭。');
  if (agents !== undefined && typeof agents.get === 'function') {
    const agent = agents.get(sessionId);
    if (agent !== undefined && agent?.status === 'running') {
      throw failure('session-live', '该会话正在运行任务，等它结束或停止后再移动。');
    }
  }
  const snapshot = await persistence.stat(sessionId);
  if (snapshot === undefined) throw failure('session-missing', '会话不存在或已被删除。');
  const target = registry?.get?.(targetWorkspaceId);
  if (target === undefined) throw failure('move-target-missing', '目标工作区不存在。');
  const source = findOwningWorkspace(registry, sessionId);
  if (source !== undefined && source.id === targetWorkspaceId) {
    throw failure('move-same', '该会话已经在这个工作区中。');
  }
  const sourceDir = await locateSessionDir(paths, sessionId);
  if (sourceDir === undefined) throw failure('session-dir-missing', '找不到该会话的本机目录。');

  const sourceFile = newestLogFile(sourceDir);
  if (sourceFile === null) throw failure('move-empty', '该会话没有可移动的日志。');

  const parsed = await readSessionFile(sourceFile);
  const toCwd = target.path;
  const alreadyThere = samePath(parsed.header.cwd ?? '', toCwd);

  let targetDir = sourceDir;
  if (!alreadyThere) {
    targetDir = path.join(paths.sessionsRoot, projectKey(toCwd), sessionId);
    const targetFile = path.join(targetDir, path.basename(sourceFile));
    await fsp.mkdir(targetDir, { recursive: true });
    try {
      const texts = rewriteCwd(parsed, toCwd).texts;
      const expectedFrames = texts.length;
      await writeSessionFile(targetFile, texts);
      const stat = await fsp.stat(sourceFile);
      await fsp.utimes(targetFile, stat.mtimeMs / 1000, stat.mtimeMs / 1000).catch(() => {});
      const check = await readSessionFile(targetFile);
      if (check.header.id !== sessionId || !samePath(check.header.cwd ?? '', toCwd)) {
        throw failure('move-verify', '写入后校验失败：会话标识或路径不一致，已保留原文件。');
      }
      if (check.texts.length !== expectedFrames) {
        throw failure('move-verify', `写入后校验失败：期望${String(expectedFrames)}条，实际${String(check.texts.length)}条，已保留原文件。`);
      }
    } catch (error) {
      await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  await rewriteMembership(paths, sessionId, targetWorkspaceId, toCwd);

  if (!alreadyThere) {
    // The old copy disappears only after the new one verified and membership moved.
    await fsp.rm(sourceDir, { recursive: true, force: true }).catch(() => {});
  }

  // The projection shard still describes the old cwd; the host rebuilds it from
  // the log on the next read.
  const shard = path.join(paths.projcacheRoot, 'sessions', `${sessionId}.json`);
  await fsp.rm(shard, { force: true }).catch(() => {});

  return {
    sessionId,
    workspaceId: targetWorkspaceId,
    cwd: toCwd,
    inPlace: true,
    needsRestart: true,
  };
}
