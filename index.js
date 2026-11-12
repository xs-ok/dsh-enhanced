/**
 * DSH增强 — Host half.
 *
 * Owns one exact Connection fetch route (`POST /api/dsh-enhanced/rpc`) that the
 * browser half calls. Connection applies its Host/Origin fence and browser
 * authentication before this handler runs, and only an owner principal reaches
 * an exact route, so the handler itself carries no token logic.
 *
 * The plugin adds no session events, no model-facing tools, and no prompt text:
 * it only reads session logs, moves local files, and mutates workspace
 * accounting through the official registry write path.
 */
import {
  clearTrash,
  deleteSession,
  failure,
  listTrash,
  purgeSession,
  purgeWorkspace,
  readSettings,
  restoreSession,
  resolvePaths,
  writeSettings,
} from './host/trash.js';
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { createSearch } from './host/search.js';
import { restartApplication } from './host/restart.js';
import { inspectOverride, overwriteCloud, overwriteLocal } from './host/overwrite.js';
import { moveCandidates, moveSession, readAllEvents } from './host/move.js';
import { inspectSyncTarget, readSyncHistory, readSyncState, recordOverwrite, resolveSyncTarget, runSync } from './host/sync.js';
import { installSyncScheduler } from './host/schedule.js';
import { appVersion, readEnvRecord, runEnvironmentCheck, writeEnvironmentReport, writeEnvRecord } from './host/envcheck.js';
import { testConnection } from './host/webdav.js';
import { pullMirror, pushMirror } from './host/mirror.js';

/** Stable Cordis plugin name. */
export const name = 'dsh-enhanced';

/** Host services this plugin needs before or while it activates. */
export const inject = ['webServer', 'connection', 'sessionPersistence', 'workspaceRegistry'];

const ROUTE_PATH = '/api/dsh-enhanced/rpc';
const SESSION_ID_PATTERN = /^session-[A-Za-z0-9._-]+$/u;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function requireSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw failure('bad-session-id', '会话标识无效。');
  }
  return value;
}

/**
 * Mount the Host half.
 * @param ctx - owning Cordis context.
 * @param config - optional path overrides (`root`, `sessionsRoot`, `projcacheRoot`).
 */
export function apply(ctx, config = {}) {
  const paths = resolvePaths(config);
  const search = createSearch({ persistence: ctx.sessionPersistence });

  void (async () => {
    try {
      await appendFile(
        path.join(paths.base, 'restart.log'),
        `${new Date().toISOString()} plugin applied; execPath=${process.execPath}; ppid=${String(process.ppid)}; version=0.2.2-rc.1-1.3\n`,
        'utf8',
      );
    } catch {
      // Diagnostics only.
    }
  })();

  const dependencies = (settings) => ({
    paths,
    settings,
    registry: ctx.workspaceRegistry,
    persistence: ctx.sessionPersistence,
    query: ctx.get('sessionQuery'),
    agents: ctx.get('agents'),
  });

  async function dispatch(request, signal) {
    const action = typeof request?.action === 'string' ? request.action : '';
    switch (action) {
      case 'state': {
        const settings = await readSettings(paths);
        let listed = { count: 0, size: 0 };
        try {
          listed = await listTrash(dependencies(settings));
        } catch {
          listed = { count: 0, size: 0 };
        }
        return { settings, count: listed.count, size: listed.size };
      }
      case 'settings.get':
        return { settings: await readSettings(paths) };
      case 'settings.set': {
        const patch = request?.patch !== null && typeof request.patch === 'object' ? request.patch : {};
        return { settings: await writeSettings(paths, patch) };
      }
      case 'session.delete': {
        const sessionId = requireSessionId(request?.sessionId);
        const settings = await readSettings(paths);
        return deleteSession(dependencies(settings), sessionId);
      }
      case 'session.move': {
        const sessionId = requireSessionId(request?.sessionId);
        const workspaceId = request?.workspaceId;
        if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(workspaceId)) {
          throw failure('bad-workspace-id', '工作区标识无效。');
        }
        const settings = await readSettings(paths);
        return moveSession(dependencies(settings), sessionId, workspaceId);
      }
      case 'workspace.candidates': {
        const sessionId = requireSessionId(request?.sessionId);
        const settings = await readSettings(paths);
        return moveCandidates(dependencies(settings), sessionId);
      }
      case 'locate.event': {
        const sessionId = requireSessionId(request?.sessionId);
        const seq = Number(request?.seq);
        if (!Number.isInteger(seq) || seq < 0) throw failure('bad-seq', '事件序号无效。');
        const events = await readAllEvents(ctx.sessionPersistence, sessionId);
        let turn = null;
        for (const event of events) {
          if (event.type === 'turn/start' && typeof event.data?.turn === 'number') turn = event.data.turn;
          if (event.seq === seq) break;
        }
        return { turn };
      }
      case 'sync.state': {
        const settings = await readSettings(paths);
        const target = await inspectSyncTarget({ paths, settings });
        const state = await readSyncState({ paths, settings });
        const live = typeof ctx.get('agents')?.list === 'function'
          ? ctx.get('agents').list().filter((agent) => agent?.status === 'running').length
          : 0;
        const history = await readSyncHistory({ paths, settings });
        return { settings: { syncEnabled: settings.syncEnabled, syncDir: settings.syncDir, syncScript: settings.syncScript, syncMachineId: settings.syncMachineId, syncSkipAttachments: settings.syncSkipAttachments }, target, state, history, auto: scheduler.status(), running: live };
      }
      case 'sync.probe':
      case 'sync.run': {
        const settings = await readSettings(paths);
        return runSync({ paths, settings, agents: ctx.get('agents'), registry: ctx.workspaceRegistry }, { probe: action === 'sync.probe' });
      }
      case 'sync.history': {
        const settings = await readSettings(paths);
        return { history: await readSyncHistory({ paths, settings }) };
      }
      case 'sync.webdavTest': {
        const settings = await readSettings(paths);
        return testConnection(settings, request?.signal);
      }
      case 'sync.resume': {
        return { auto: scheduler.resume() };
      }
      case 'sync.overwrite': {
        const settings = await readSettings(paths);
        if (settings.syncMode !== 'webdav') throw failure('overwrite-mode', '只有 WebDAV 模式支持覆盖操作。');
        const target = resolveSyncTarget(paths, settings);
        const running = (ctx.get('agents')?.list?.() ?? []).filter((agent) => agent?.status === 'running').length;
        if (running > 0) throw failure('overwrite-busy', '有会话正在运行，停一会儿再覆盖。');
        const deps = {
          paths,
          settings,
          machineId: target.machineId,
          mirrorDir: target.syncDir,
          profile: target.profile,
        };
        const direction = request?.direction;
        if (direction === 'preview') return inspectOverride(deps);
        if (request?.apply !== true) throw failure('overwrite-confirm', '覆盖需要确认后才执行。');
        if (direction !== 'cloud' && direction !== 'local') throw failure('overwrite-direction', '未知的覆盖方向。');
        const startedAt = Date.now();
        const result = direction === 'cloud' ? await overwriteCloud(deps) : await overwriteLocal(deps);
        const log = direction === 'cloud'
          ? [`覆盖云端：上传 ${String(result.uploaded ?? 0)} 个文件，删除云端 ${String(result.deleted ?? 0)} 个文件`, `覆盖区域：${String(result.copied ?? 0)} 个`]
          : [`覆盖本机：复制 ${String(result.copied ?? 0)} 个区域`, `本地化会话：${String(result.localized ?? 0)} 个`];
        const record = await recordOverwrite({ paths, settings }, {
          direction,
          ok: result.ok !== false,
          durationMs: Date.now() - startedAt,
          uploaded: result.uploaded,
          localized: result.localized,
          deleted: result.deleted,
          copied: result.copied,
          log: result.warning === undefined ? log : [...log, result.warning],
        });
        return { ...result, record };
      }
      case 'app.restart': {
        const running = (ctx.get('agents')?.list?.() ?? []).filter((agent) => agent?.status === 'running').length;
        if (running > 0) throw failure('restart-busy', '有会话正在运行，稍后再重启。');
        return restartApplication(paths);
      }
      case 'env.check': {
        return runEnvironmentCheck({ paths, ctx });
      }
      case 'env.report': {
        const result = await runEnvironmentCheck({ paths, ctx });
        const written = await writeEnvironmentReport({ paths }, result);
        await writeEnvRecord(paths, { lastReport: written.path, lastCheckAt: result.checkedAt });
        return { ...written, ok: result.ok };
      }
      case 'env.version': {
        const current = await appVersion();
        const record = await readEnvRecord(paths);
        return {
          appVersion: current.version,
          pluginVersion: '0.2.2-4',
          lastAppVersion: record.lastAppVersion ?? null,
          changed: current.version !== null && record.lastAppVersion !== undefined && record.lastAppVersion !== current.version,
        };
      }
      case 'env.ack': {
        const current = await appVersion();
        if (current.version === null) return { ok: false, reason: 'version-unknown' };
        await writeEnvRecord(paths, { lastAppVersion: current.version, ackAt: new Date().toISOString() });
        return { ok: true };
      }
      case 'sync.log': {
        const settings = await readSettings(paths);
        const state = await readSyncState({ paths, settings });
        return { log: state?.log ?? [] };
      }
      case 'trash.list': {
        const settings = await readSettings(paths);
        const scope = {
          workspaceId: typeof request?.workspaceId === 'string' ? request.workspaceId : undefined,
          sessionId: typeof request?.sessionId === 'string' && SESSION_ID_PATTERN.test(request.sessionId) ? request.sessionId : undefined,
        };
        return listTrash(dependencies(settings), scope);
      }
      case 'trash.restore': {
        const sessionId = requireSessionId(request?.sessionId);
        const settings = await readSettings(paths);
        return restoreSession(dependencies(settings), sessionId);
      }
      case 'trash.purge': {
        const sessionId = requireSessionId(request?.sessionId);
        const settings = await readSettings(paths);
        return purgeSession(dependencies(settings), sessionId);
      }
      case 'trash.clear': {
        const settings = await readSettings(paths);
        const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : undefined;
        if (workspaceId !== undefined && !/^[A-Za-z0-9._-]+$/u.test(workspaceId)) {
          throw failure('bad-workspace-id', '工作区标识无效。');
        }
        return clearTrash(dependencies(settings), { workspaceId });
      }
      case 'search': {
        const settings = await readSettings(paths);
        if (settings.searchEnabled !== true) throw failure('search-disabled', '内容搜索已在设置中关闭。');
        const query = typeof request?.query === 'string' ? request.query : '';
        return search.search(query, settings, signal);
      }
      default:
        throw failure('unknown-action', `未知的请求：${action}`);
    }
  }

  const scheduler = installSyncScheduler(ctx, { paths, agents: ctx.get('agents') });
  ctx.effect(() => () => scheduler.dispose(), 'dsh-enhanced: sync scheduler');

  // Deleting a workspace drops every recycle-bin record it owned, immediately:
  // the workspace domain write that removes the record is the same commit the
  // sidebar sees. The lazy check in `listTrash` stays as a fallback for
  // deletions that happened while this plugin was unloaded.
  ctx.on('domain/changed', (change) => {
    if (change === null || typeof change !== 'object') return;
    if (change.domain !== 'workspace' || change.table !== 'workspaces' || change.operation !== 'deleted') return;
    purgeWorkspace(paths, change.key).catch((error) => {
      const message = `dsh-enhanced: purging the recycle bin of workspace ${String(change.key)} failed: ${error?.stack ?? String(error)}`;
      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message);
      else console.warn(message);
    });
  });

  ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: { code: 'bad-body', message: '请求体不是合法的 JSON。' } });
      }
      try {
        const data = await dispatch(body, request.signal);
        return jsonResponse({ ok: true, data });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'internal';
        if (code === 'internal' || code === 'workspace-detach-failed' || code === 'session-move-failed') {
          const message = `dsh-enhanced: ${String(request?.action)} failed: ${error?.stack ?? String(error)}`;
          if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message);
          else console.warn(message);
        }
        return jsonResponse({ ok: false, error: { code, message: error?.message ?? String(error), details: error?.details } });
      }
    },
  });
}
