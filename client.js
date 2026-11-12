/**
 * DSH增强 — browser half.
 *
 * Registers four contributions:
 *   - one row in a session's "..." menu (delete),
 *   - one footer action beside Settings (session recovery),
 *   - two frame-wide overlay entries (search panel, dialogs + toast),
 *   - one settings section (switches and limits).
 *
 * All host work goes through a single exact Connection fetch route, which is
 * authenticated by the page's own browser session; this module never touches
 * session files or the workspace registry itself.
 */
window.__ModuleLoader__.load({
  id: '@xsok/dsh-enhanced',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dshEnhanced';

    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      console.warn('[dsh-enhanced] ui primitives are unavailable; using fallbacks', error);
      primitives = null;
    }

    /** Render into <body> so dialogs cannot cover our panels; optional. */
    let createPortal = null;
    try {
      const ReactDOM = require('react-dom');
      if (typeof ReactDOM?.createPortal === 'function') createPortal = ReactDOM.createPortal;
    } catch {
      createPortal = null;
    }

    const DEFAULTS = Object.freeze({
      version: 1,
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
      webdavAutoCreate: true,
      mirrorDir: '',
      matchTitle: true,
      matchBody: true,
      matchTools: false,
      retentionDays: 60,
    });

    const DICT = {
      en: {
        'nav.title': 'DSH Enhanced',
        'env.button': 'Environment check',
        'restart.button': 'Restart app',
        'restart.hint': 'Ctrl+Shift+Alt+R',
        'restart.desc': 'Restart the desktop app now?',
        'restart.confirm': 'Restart',
        'restart.busy': 'A turn is still running. Stop it, then restart.',
        'overwrite.cloud': 'Overwrite cloud',
        'overwrite.local': 'Overwrite this machine',
        'overwrite.awayCloud': 'Replaces the cloud with this machine\'s data. Nothing is merged.',
        'overwrite.awayLocal': 'Replaces this machine with the cloud data. Nothing is merged.',
        'overwrite.confirm': 'Start overwrite',
        'overwrite.running': 'Working…',
        'overwrite.cloudDone': 'Cloud replaced; {n} file(s) uploaded.',
        'overwrite.localDone': 'This machine replaced; {n} area(s) copied.',
        'env.busy': 'Checking…',
        'env.title': 'DSH Enhanced · Environment check',
        'env.ok': 'No problems found',
        'env.risk': '{n} risk(s) found. Export a report?',
        'env.report': 'Export report',
        'env.reported': 'Report saved to {path}',
        'env.versionLine': 'App {app} · plugin V{plugin}',
        'env.update.title': 'DSH Enhanced · host updated',
        'env.update.desc': 'The host application changed ({last} → {app}). Run the environment check to make sure the plugin still works?',
        'env.update.yes': 'Yes',
        'env.update.no': 'No',
        'pause.title': 'DSH Enhanced · automatic sync paused',
        'pause.desc': 'Automatic sync stopped after {n} consecutive failures.',
        'pause.last': 'Last failure: {summary}. {hint}',
        'pause.resume': 'Resume automatic sync',
        'pause.resumed': 'Automatic sync resumed',
        'section.title': 'DSH Enhanced',
        'section.desc': 'Session delete and restore, cross-workspace move, full-corpus search, quoting, auto-load history, and multi-device sync.',
        'section.reading': 'Reading and actions',
        'section.sessions': 'Session management',
        'section.search': 'Content search',
        'section.sync': 'Session sync',
        'sync.interval': 'Interval (minutes)',
        'sync.interval.hint': '0 turns interval sync off.',
        'sync.daily': 'Daily at',
        'sync.daily.hint': 'HH:MM in 24-hour form; empty turns it off.',
        'sync.idle': 'Sync when idle',
        'sync.idle.desc': 'Runs once the first time every session stops working.',
        'sync.cooldown': 'Minimum gap (minutes)',
        'sync.mode': 'Sync target',
        'sync.mode.local': 'Local folder',
        'sync.mode.webdav': 'WebDAV',
        'sync.webdav.url': 'WebDAV address',
        'sync.webdav.presets': 'Saved setups',
        'sync.webdav.presets.hint': 'One click fills the four fields above. Up to three.',
        'sync.webdav.presets.save': 'Save current setup',
        'sync.webdav.presets.modify': 'Edit setup',
        'sync.webdav.presets.commitModify': 'Save changes',
        'sync.webdav.presets.updated': 'Updated "{name}".',
        'sync.webdav.presets.replaced': 'Setup replaced.',
        'sync.webdav.presets.replaceTitle': 'Replace which setup?',
        'sync.webdav.presets.replaceDesc': 'Three setups are already saved. Pick the one this replaces.',
        'sync.webdav.presets.saved': 'Saved "{name}".',
        'sync.webdav.presets.rename': 'Rename',
        'sync.webdav.presets.name': 'Setup name',
        'sync.webdav.presets.confirm': 'Apply the name',
        'sync.webdav.presets.default': 'Default (current fields)',
        'sync.webdav.presets.remove': 'Delete',
        'sync.webdav.presets.unsaved': '(current fields, not saved)',
        'sync.webdav.presets.full': 'Three saved setups are the limit. Remove one first.',
        'sync.webdav.presets.empty': 'Fill in the address first.',
        'sync.webdav.user': 'Account',
        'sync.webdav.password': 'App password',
        'sync.webdav.password.hint': 'Jianguoyun requires an application password from its security page, not the login password.',
        'sync.webdav.root': 'Remote root',
        'sync.webdav.root.hint': 'Full path, e.g. https://dav.jianguoyun.com/dav/我的坚果云/DSH-Sync',
        'sync.webdav.mirror': 'Local mirror folder',
        'sync.webdav.mirror.usage': 'Currently using {size} ({files} files)',
        'sync.webdav.autoCreate': 'Create the remote folder',
        'sync.webdav.autoCreate.desc': 'When the remote path is missing, create it level by level before testing.',
        'sync.webdav.test': 'Test connection',
        'sync.webdav.testing': 'Connecting…',
        'sync.webdav.ok': 'Connected: {message}',
        'sync.webdav.fail': 'Connection failed: {message}',
        'sync.pull': 'Pull once',
        'sync.push': 'Push once',
        'sync.pull.confirm': 'Download from the cloud into the local mirror folder? Nothing is uploaded or deleted remotely.',
        'sync.push.confirm': 'Upload the mirror folder to the cloud? Existing remote files are overwritten only when they differ, never deleted.',
        'sync.pulled': 'Pulled {n} files ({bytes}), skipped {skipped}.',
        'sync.pushed': 'Pushed {n} files ({bytes}), skipped {skipped}.',
        'sync.directionFailed': '{n} files failed',
        'sync.noFailure': 'no failures',
        'switch.delete': 'Delete sessions',
        'switch.delete.desc': 'Adds "Delete session" to the session menu. A running session cannot be deleted.',
        'switch.move': 'Move between workspaces',
        'switch.move.desc': 'Adds "Move to workspace" to the session menu. Moving copies the session and permanently deletes the original.',
        'switch.autoLoad': 'Auto-load earlier messages',
        'switch.autoLoad.desc': 'Scrolling to the top of a conversation loads the next older page automatically, without clicking "Load earlier".',
        'sync.title': 'Session and config sync',
        'sync.desc': 'Runs the bundled sync engine to copy sessions, config and attachments into a shared folder.',
        'sync.needDir': 'Fill in the shared folder before syncing.',
        'sync.needMirror': 'Fill in the local mirror folder before syncing.',
        'sync.enable': 'Automatic sync',
        'sync.enable.hint': 'Idle, interval and daily triggers only; Sync now ignores this switch.',
        'sync.dir': 'Shared folder',
        'sync.machine': 'Machine id',
        'sync.machine.hint': 'Empty uses the Windows user name; a collision with an existing id refuses the sync.',
        'sync.machine.placeholder': 'System default: {id}',
        'sync.attachments': 'Sync attachments',
        'sync.probe': 'Check',
        'sync.run': 'Sync now',
        'sync.running': 'Syncing…',
        'sync.never': 'Not run yet.',
        'sync.last': 'Last run: {time} · {result} · {ms} ms',
        'sync.result.ok': 'ok',
        'sync.result.fail': 'failed',
        'sync.purged': 'trash pruned {n}',
        'sync.paths': 'dirs created {created}, failed {failed}',
        'sync.failed': '{n} files failed',
        'sync.counts': '↑ {up} · ↓ {down} · 🗑 {del}',
        'sync.transport': 'transport: {down} down, {up} up',
        'sync.transportDel': 'transport: {down} down, {up} up, {del} deleted',
        'sync.dirMissing': 'Shared folder not found: {path}',
        'sync.log': 'Show log',
        'sync.logToggle': 'Click to show or hide the run history',
        'sync.more': 'Show more',
        'sync.historyCount': '{n} runs recorded',
        'sync.logHide': 'Hide log',
        'sync.failed': 'Sync failed: {message}',
        'switch.trash': 'Session recovery',
        'switch.trash.desc': 'Shows the recovery entry in the session menu and on this page. Deleted sessions stay in the local recycle bin.',
        'switch.search': 'Content search',
        'switch.search.desc': 'Opens the search panel over any screen and matches titles and messages.',
        'switch.matchTitle': 'Match session titles',
        'switch.matchBody': 'Match user and assistant messages',
        'switch.matchTools': 'Match tool output',
        'switch.limits': 'Search scope',
        'field.retention': 'Keep deleted sessions for (days)',
        'field.retention.hint': '0 keeps them until you remove them by hand.',
        'trash.usage': '{count} sessions, {size}',
        'trash.clear': 'Empty recycle bin',
        'trash.cleared': 'Recycle bin emptied.',
        'delete.label': 'Delete session',
        'delete.running': 'Delete session (running)',
        'delete.title': 'Delete this session?',
        'delete.desc': 'The local session directory, its projection cache shard, and its workspace reference are removed. The session stays recoverable until the retention period ends.',
        'delete.confirm': 'Delete',
        'delete.done': '"{title}" was deleted.',
        'delete.failed': 'Delete failed: {message}',
        'delete.blocked': 'A running session cannot be deleted.',
        'move.label': 'Move to workspace…',
        'move.running': 'Move to workspace (running)',
        'move.title': 'Move to workspace',
        'move.desc': 'Moves the session into the target workspace in place: the session itself is unchanged and only its working directory becomes the target. Later tool calls run there. The new grouping appears after the app restarts.',
        'move.session': 'Session: {title}',
        'move.restarting': 'Moved. Restarting so the new grouping takes effect…',
        'move.current': 'Current workspace: {title}',
        'move.target': 'Target workspace',
        'move.empty': 'No other workspace is available.',
        'move.loading': 'Reading workspaces…',
        'move.busy': 'Copying the session…',
        'move.confirm': 'Move',
        'move.done': 'Moved to "{title}".',
        'move.failed': 'Move failed: {message}',
        'trash.title': 'Session deletions',
        'trash.untitled': 'Untitled',
        'trash.menu': 'Recover sessions in this workspace',
        'trash.desc': 'Sessions deleted in this workspace. Restore one, or remove it permanently.',
        'trash.empty': 'No deleted sessions.',
        'trash.restore': 'Restore',
        'trash.purge': 'Delete permanently',
        'trash.purge.confirm': 'Delete for good?',
        'trash.clear': 'Empty recycle bin',
        'trash.clear.confirm': 'Empty for good?',
        'trash.clearWorkspace': 'Empty workspace',
        'trash.clearWorkspace.confirm': 'Empty for good?',
        'trash.restored': '"{title}" was restored.',
        'trash.purged': '"{title}" was deleted permanently.',
        'trash.loading': 'Loading…',
        'search.placeholder': 'Search session titles and content',
        'search.empty': 'No matches.',
        'search.hint': 'Type to search every session. Enter opens the highlighted result.',
        'search.loading': 'Searching…',
        'search.error': 'Search failed: {message}',
        'search.meta': '{count} sessions, {matches} matches',
        'search.notLocated': 'Opened the session, but the match is not loaded yet. Click "Load earlier" and try again.',
        'search.close': 'Close search',
        'role.user': 'You',
        'role.assistant': 'Assistant',
        'role.tool': 'Tool',
        'role.title': 'Title',
        'common.close': 'Close',
        'common.cancel': 'Cancel',
        'common.retry': 'Retry',
      },
      zh: {
        'nav.title': 'DSH增强',
        'env.button': '环境检测',
        'restart.button': '重启应用',
        'restart.hint': 'Ctrl+Shift+Alt+R',
        'restart.desc': '立即重启桌面应用？',
        'restart.confirm': '重启',
        'restart.busy': '有任务正在运行，结束或停止后再重启。',
        'overwrite.cloud': '覆盖云端',
        'overwrite.local': '覆盖本机',
        'overwrite.awayCloud': '将以本机数据完全替换云端，不做合并。',
        'overwrite.awayLocal': '将以云端数据完全替换本机，不做合并。',
        'overwrite.confirm': '开始覆盖',
        'overwrite.running': '处理中…',
        'overwrite.cloudDone': '云端已覆盖；上传 {n} 个文件。',
        'overwrite.localDone': '本机已覆盖；复制 {n} 个区域。',
        'env.busy': '正在检测…',
        'env.title': 'DSH增强 · 环境检测',
        'env.ok': '环境无异常',
        'env.risk': '发现 {n} 项风险点，是否输出风险报告？',
        'env.report': '输出风险报告',
        'env.reported': '风险报告已保存到 {path}',
        'env.versionLine': '主程序 {app} · 插件 V{plugin}',
        'env.update.title': 'DSH增强 · 主程序已更新',
        'env.update.desc': '发现主程序更新（{last} → {app}），请运行“环境检测”确保插件可正确运行，是否立即检测？',
        'env.update.yes': '是',
        'env.update.no': '否',
        'pause.title': 'DSH增强 · 自动同步已暂停',
        'pause.desc': '连续 {n} 次同步失败，自动同步已暂停。',
        'pause.last': '最近一次失败：{summary}。{hint}',
        'pause.resume': '恢复自动同步',
        'pause.resumed': '自动同步已恢复',
        'section.title': 'DSH增强',
        'section.desc': '会话删除与找回、跨工作区移动、全库搜索、文字引用、自动加载历史，以及多设备同步。',
        'section.reading': '阅读与操作',
        'section.sessions': '会话管理',
        'section.search': '内容搜索',
        'section.sync': '会话同步',
        'sync.interval': '间隔同步（分钟）',
        'sync.interval.hint': '填0表示关闭间隔同步。',
        'sync.daily': '每日定时',
        'sync.daily.hint': '24小时制 HH:MM，留空表示关闭。',
        'sync.idle': '对话空闲后同步',
        'sync.idle.desc': '所有会话第一次全部进入空闲时自动同步一次。',
        'sync.cooldown': '最小间隔（分钟）',
        'sync.mode': '同步方式',
        'sync.mode.local': '本地目录',
        'sync.mode.webdav': 'WebDAV',
        'sync.webdav.url': 'WebDAV 地址',
        'sync.webdav.presets': '配置组',
        'sync.webdav.presets.hint': '点一下即填入上面四项；最多保存三组。',
        'sync.webdav.presets.save': '保存当前配置',
        'sync.webdav.presets.modify': '修改配置',
        'sync.webdav.presets.commitModify': '保存配置',
        'sync.webdav.presets.updated': '已更新“{name}”。',
        'sync.webdav.presets.replaced': '配置已替换。',
        'sync.webdav.presets.replaceTitle': '替换哪一组配置？',
        'sync.webdav.presets.replaceDesc': '已保存三组配置，请选择要被替换的一组。',
        'sync.webdav.presets.saved': '已保存“{name}”。',
        'sync.webdav.presets.rename': '重命名',
        'sync.webdav.presets.name': '配置名称',
        'sync.webdav.presets.confirm': '保存名称',
        'sync.webdav.presets.default': '默认配置',
        'sync.webdav.presets.remove': '删除',
        'sync.webdav.presets.unsaved': '（当前填写，未保存）',
        'sync.webdav.presets.full': '最多保存三组，请先删除一组。',
        'sync.webdav.presets.empty': '请先填写地址。',
        'sync.webdav.user': '账号',
        'sync.webdav.password': '应用密码',
        'sync.webdav.password.hint': '坚果云请到网页版“安全选项”生成应用密码，不要填登录密码。',
        'sync.webdav.root': '远程根目录',
        'sync.webdav.root.hint': '填完整路径，例如 https://dav.jianguoyun.com/dav/我的坚果云/DSH-Sync',
        'sync.webdav.mirror': '本地镜像目录',
        'sync.webdav.mirror.usage': '当前占用 {size}（{files} 个文件）',
        'sync.webdav.autoCreate': '自动创建远程目录',
        'sync.webdav.autoCreate.desc': '远程路径不存在时，测试连接前会逐级创建。',
        'sync.webdav.test': '测试连接',
        'sync.webdav.testing': '正在连接…',
        'sync.webdav.ok': '连接成功：{message}',
        'sync.webdav.fail': '连接失败：{message}',
        'sync.pull': '拉取一次',
        'sync.push': '推送一次',
        'sync.pull.confirm': '从云端拉取到本地镜像目录？只下载，不会上传或删除云端文件。',
        'sync.push.confirm': '把本地镜像目录推送到云端？只有内容不同时才覆盖，不会删除云端已有文件。',
        'sync.pulled': '已拉取 {n} 个文件（{bytes}），跳过 {skipped} 个。',
        'sync.pushed': '已推送 {n} 个文件（{bytes}），跳过 {skipped} 个。',
        'sync.directionFailed': '{n} 个文件失败',
        'sync.noFailure': '无失败',
        'switch.delete': '会话删除',
        'switch.delete.desc': '在会话菜单中加入“删除会话”。运行中的会话不可删除。',
        'switch.move': '会话移动',
        'switch.move.desc': '在会话菜单中加入“移动到工作区”。移动会复制成新会话并永久删除原会话。',
        'switch.autoLoad': '自动加载更早消息',
        'switch.autoLoad.desc': '对话滚动到顶部时自动加载上一页历史，不需要再点“加载更早”。',
        'sync.title': '会话与配置同步',
        'sync.desc': '调用插件自带的同步引擎，把会话、配置与附件同步到共享目录。',
        'sync.needDir': '请先填写共享目录。',
        'sync.needMirror': '请先填写本地镜像目录。',
        'sync.enable': '自动同步',
        'sync.enable.hint': '只控制空闲、间隔、定时三种自动触发；“立即同步”不受此开关限制。',
        'sync.dir': '共享目录',
        'sync.machine': '机器标识',
        'sync.machine.hint': '留空则使用系统用户名；若与共享中已有标识冲突，同步会被拒绝。',
        'sync.machine.placeholder': '当前系统默认用户名：{id}',
        'sync.attachments': '同步附件',
        'sync.probe': '检查',
        'sync.run': '立即同步',
        'sync.running': '正在同步…',
        'sync.never': '尚未运行。',
        'sync.last': '上次同步：{time} · {result} · {ms} ms',
        'sync.result.ok': '成功',
        'sync.result.fail': '失败',
        'sync.purged': '清理回收站 {n}',
        'sync.paths': '目录创建 {created}、失败 {failed}',
        'sync.failed': '{n} 个文件失败',
        'sync.counts': '↑ {up} · ↓ {down} · 🗑 {del}',
        'sync.transport': '传输：下载 {down}、上传 {up}',
        'sync.transportDel': '传输：下载 {down}、上传 {up}、删除 {del}',
        'sync.dirMissing': '共享目录不存在：{path}',
        'sync.log': '查看日志',
        'sync.logToggle': '点击展开或收起同步记录',
        'sync.more': '查看更多',
        'sync.historyCount': '共 {n} 次同步记录',
        'sync.logHide': '收起日志',
        'sync.failed': '同步失败：{message}',
        'switch.trash': '会话找回',
        'switch.trash.desc': '在会话菜单和本页显示会话找回入口，已删除会话保留在本机回收站。',
        'switch.search': '内容搜索',
        'switch.search.desc': '按 Ctrl+F 打开搜索面板，匹配标题与消息正文。',
        'switch.matchTitle': '匹配会话标题',
        'switch.matchBody': '匹配用户与助手消息',
        'switch.matchTools': '匹配工具输出',
        'switch.limits': '搜索范围',
        'field.retention': '已删除会话保留天数',
        'field.retention.hint': '填0表示一直保留，直到手动永久删除。',
        'trash.usage': '{count}个会话，占用{size}',
        'trash.clear': '清空回收站',
        'trash.cleared': '回收站已清空。',
        'delete.label': '删除会话',
        'delete.running': '删除会话（运行中）',
        'delete.title': '删除这个会话？',
        'delete.desc': '将删除本机会话目录、会话缓存分片，以及工作区中的引用。会话会保留在回收站，直到超过保留期。',
        'delete.confirm': '删除',
        'delete.done': '“{title}”已删除。',
        'delete.failed': '删除失败：{message}',
        'delete.blocked': '运行中的会话不可删除。',
        'move.label': '移动到工作区…',
        'move.running': '移动到工作区（运行中）',
        'move.title': '移动到工作区',
        'move.desc': '将该会话整体移入目标工作区：会话本身不变，只是工作目录改到目标目录，之后的工具调用会在那里执行。分组变化需要重启应用后完全生效。',
        'move.session': '会话：{title}',
        'move.restarting': '已移动，正在重启以应用新分组…',
        'move.current': '当前工作区：{title}',
        'move.target': '目标工作区',
        'move.empty': '没有其他工作区可移动。',
        'move.loading': '正在读取工作区…',
        'move.busy': '正在复制会话…',
        'move.confirm': '移动',
        'move.done': '已移动到“{title}”。',
        'move.failed': '移动失败：{message}',
        'trash.title': '删除会话管理',
        'trash.untitled': '未命名',
        'trash.menu': '本工作区会话找回',
        'trash.desc': '本工作区中已删除的会话，可恢复或永久删除。',
        'trash.empty': '暂无已删除的会话。',
        'trash.restore': '恢复',
        'trash.purge': '永久删除',
        'trash.purge.confirm': '确认永久删除？',
        'trash.clear': '清空回收站',
        'trash.clear.confirm': '确认清空？',
        'trash.clearWorkspace': '清空该工作区',
        'trash.clearWorkspace.confirm': '确认清空？',
        'trash.restored': '“{title}”已恢复。',
        'trash.purged': '“{title}”已永久删除。',
        'trash.loading': '正在读取…',
        'search.placeholder': '搜索会话标题与内容',
        'search.empty': '没有匹配结果。',
        'search.hint': '输入关键词搜索全部会话，回车打开选中结果。',
        'search.loading': '正在搜索…',
        'search.error': '搜索失败：{message}',
        'search.meta': '{count}个会话，{matches}处匹配',
        'search.notLocated': '已打开会话，但该处尚未加载。可点击“加载更早”后再试。',
        'search.close': '关闭搜索',
        'role.user': '你',
        'role.assistant': '助手',
        'role.tool': '工具',
        'role.title': '标题',
        'common.close': '关闭',
        'common.cancel': '取消',
        'common.retry': '重试',
      },
    };

    const STYLES = `
.dshe-overlay{position:fixed;inset:0;z-index:2000;display:flex;justify-content:center;align-items:flex-start;pointer-events:none}
.dshe-overlay-top{z-index:2147482000}
.dshe-backdrop{position:absolute;inset:0;background:rgba(15,18,26,.42);pointer-events:auto}
.dshe-search{position:relative;pointer-events:auto;margin-top:6vh;width:min(720px,92vw);max-height:calc(100vh - 90px);display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1b1d22);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));
  border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.28);overflow:hidden;font-size:13px}
.dshe-search-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1))}
.dshe-search-icon{display:inline-flex;color:var(--dsw-alias-label-secondary,#6b7280)}
.dshe-search-input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font-size:14px;line-height:20px;font-family:inherit}
.dshe-search-input::placeholder{color:var(--dsw-alias-label-secondary,#9aa1ad)}
.dshe-results{overflow:auto;padding:6px 6px 10px;min-height:64px;max-height:calc(100vh - 220px)}
.dshe-status{padding:14px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}
.dshe-error{color:var(--dsw-alias-state-error-primary,#c0392b)}
.dshe-group{padding:4px 0 8px}
.dshe-group-title{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1b1d22);
  font:inherit;font-weight:600;padding:6px 10px;border-radius:8px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshe-group-title:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05))}
.dshe-group-meta{color:var(--dsw-alias-label-secondary,#8a919c);font-weight:400;font-size:11px;margin-left:8px}
.dshe-match{display:flex;gap:8px;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);
  font:inherit;padding:5px 10px 5px 18px;border-radius:8px;cursor:pointer;line-height:18px}
.dshe-match:hover,.dshe-match[data-active="true"]{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
.dshe-role{flex:none;font-size:11px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));
  color:var(--dsw-alias-label-secondary,#6b7280);height:18px;line-height:18px}
.dshe-snippet{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#2b2f36)}
.dshe-mark{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef5) 26%,transparent);color:inherit;border-radius:3px;padding:0 1px}
.dshe-section{display:flex;flex-direction:column;gap:14px;width:100%;font-size:13px}
.dshe-section-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1d22)}
.dshe-subsection-title{margin:4px 0 0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1d22);
  padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.dshe-section-desc{margin:0;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:18px}
.dshe-card{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:10px;overflow:hidden}
.dshe-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.dshe-row:last-child{border-bottom:0}
.dshe-row-main{flex:1;min-width:0}
.dshe-row-title{font-size:13px;color:var(--dsw-alias-label-primary,#1b1d22)}
.dshe-row-desc{font-size:11px;color:var(--dsw-alias-label-secondary,#8a919c);margin-top:2px;line-height:16px}
.dshe-switch{flex:none;width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08));position:relative;cursor:pointer;padding:0}
.dshe-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#3b6ef5);border-color:transparent}
.dshe-switch span{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-primary,#1b1d22);transition:transform .12s ease,background .12s ease}
.dshe-switch[aria-checked="true"] span{transform:translateX(16px);background:#fff}
.dshe-number{flex:none;width:72px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1b1d22);font:inherit;font-size:12px}
.dshe-text{flex:none;width:240px;max-width:46vw;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));
  background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1b1d22);font:inherit;font-size:12px}
.dshe-sync-log{max-height:220px;overflow:auto;margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));
  color:var(--dsw-alias-label-secondary,#4b5563);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;font-family:var(--ds-font-family-code,monospace)}
  font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary,#4b5563);word-break:break-all}
.dshe-counts{display:inline-flex;align-items:center;gap:1px}
.dshe-log-body{display:block;white-space:normal}
.dshe-log-line{display:flex;align-items:baseline;line-height:18px}
.dshe-log-label{flex:0 0 5em;text-align:justify;text-align-last:justify;text-justify:inter-character;white-space:nowrap}
.dshe-log-colon{flex:0 0 auto;margin:0 1px}
.dshe-log-text{flex:1 1 auto;white-space:pre-wrap;word-break:break-all}
.dshe-log-line-plain{display:block;padding-left:0.6em;color:var(--dsw-alias-label-secondary,#6b7280)}
.dshe-log-line-more{cursor:pointer}
.dshe-log-line-more:hover .dshe-log-text{color:var(--dsw-alias-label-primary,#1b1d22)}
.dshe-log-more{margin-left:4px;opacity:.55;font-size:10px}
.dshe-log-files{margin:2px 0 4px 5.6em;padding-left:6px;border-left:2px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12))}
.dshe-log-file{font-family:var(--ds-font-family-code,monospace);font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-all}
.dshe-log-line-sub .dshe-log-label{text-align:right;text-align-last:auto;color:var(--dsw-alias-label-secondary,#6b7280)}
.dshe-log-list{display:flex;flex-direction:column;gap:4px;align-items:stretch}
.dshe-log-scroll{max-height:42vh;overflow-y:auto;overflow-x:hidden;padding-right:2px;flex:0 0 auto}
.dshe-log-toggle{background:none;border:0;padding:0;margin:0;text-align:left;cursor:pointer;font:inherit;color:inherit;display:block;width:100%}
.dshe-log-toggle:hover{color:var(--dsw-alias-label-primary,#1b1d22)}
.dshe-log-item{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px;overflow:hidden;flex:0 0 auto}
.dshe-log-row{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:6px 10px;
  background:transparent;border:0;cursor:pointer;text-align:left;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-secondary,#4b5563);font-family:var(--ds-font-family-code,monospace)}
.dshe-log-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04))}
.dshe-log-row-open{color:var(--dsw-alias-label-primary,#1b1d22)}
.dshe-log-caret{opacity:.6}
.dshe-log-item .dshe-sync-log{border-radius:0;margin:0}
.dshe-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#8a919c);padding:0 12px 10px}
.dshe-trash-body{max-height:46vh;overflow:auto;display:flex;flex-direction:column;gap:12px;min-height:80px}
.dshe-trash-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 0 6px}
.dshe-trash-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshe-trash-group-actions{display:inline-flex;gap:6px;flex:none}
.dshe-link-danger{border:0;background:transparent;padding:0;font:inherit;font-size:11px;color:var(--dsw-alias-state-error-primary,#c0392b);cursor:pointer;flex:none}
.dshe-link-danger:hover{text-decoration:underline}
.dshe-link-danger[disabled]{opacity:.5;cursor:default;text-decoration:none}
  background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));
  box-shadow:0 10px 30px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:2px}
  font:inherit;font-size:12px;padding:7px 10px;border-radius:6px;cursor:pointer}
.dshe-move-list{display:flex;flex-direction:column;gap:6px;max-height:40vh;overflow:auto}
.dshe-move-item{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:8px;cursor:pointer}
.dshe-move-item[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#3b6ef5);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04))}
.dshe-move-item input{margin-top:2px;flex:none}
.dshe-move-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshe-move-title{font-size:13px;color:var(--dsw-alias-label-primary,#1b1d22);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshe-move-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#8a919c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshe-trash-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:8px}
.dshe-trash-main{flex:1;min-width:0}
.dshe-trash-title{font-size:13px;color:var(--dsw-alias-label-primary,#1b1d22);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshe-trash-id{font-family:var(--ds-font-family-code,monospace);font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary,#8a919c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshe-trash-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#8a919c);margin-top:2px}
.dshe-action{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));background:transparent;color:var(--dsw-alias-label-primary,#1b1d22);
  font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;cursor:pointer}
.dshe-action:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
.dshe-action-active:hover,.dshe-action-active:focus-visible{background:var(--dsw-alias-brand-primary,#3b6ef5);color:#fff;filter:brightness(1.1)}
.dshe-action-danger:hover,.dshe-action-danger:focus-visible{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 12%,transparent)}
.dshe-action[disabled]{opacity:.5;cursor:default}
.dshe-presets{display:flex;flex-direction:column;gap:6px;padding:6px 0 2px}
.dshe-presets-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1d22)}
.dshe-presets-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dshe-select{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));background:var(--dsw-alias-bg-overlay,#fff);
  color:var(--dsw-alias-label-primary,#1b1d22);font:inherit;font-size:12px;padding:4px 8px;border-radius:8px;min-width:160px}
.dshe-preset-chip{display:inline-flex;align-items:center;gap:4px}
.dshe-action-active{background:var(--dsw-alias-brand-primary,#3b6ef5);color:#fff;border-color:transparent}
.dshe-action-danger{color:var(--dsw-alias-state-error-primary,#c0392b);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 45%,transparent)}
.dshe-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);pointer-events:auto;z-index:2010;  background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1b1d22);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));
  border-radius:10px;padding:8px 14px;font-size:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);max-width:70vw}
.dshe-toast[data-kind="error"]{color:var(--dsw-alias-state-error-primary,#c0392b)}
`;

    // ── store ────────────────────────────────────────────────────────────────

    function createStore() {
      let state = {
        ready: false,
        settings: { ...DEFAULTS },
        toast: null,
        search: { open: false, query: '', status: 'idle', groups: [], error: null, tookMs: 0, truncated: false, scanned: 0 },
        trash: { open: false, loading: false, groups: [], error: null, busy: null, confirmPurge: null, confirmClear: false, confirmWorkspace: null, count: 0, size: 0, scopeSession: null, scopeWorkspace: null },
        pendingDelete: null,
        deleteBusy: false,
        deleteError: null,
        move: { open: false, sessionId: null, title: '', loading: false, current: null, workspaces: [], targetId: null, error: null, busy: false },
        sync: { loading: false, busy: false, target: null, state: null, error: null, showLog: false, webdav: null, webdavBusy: false, history: [], historyOpen: null, historyLimit: 5, auto: null },
        overwrite: { open: false, direction: 'cloud', busy: false, preview: null, error: null },
        restartConfirm: false,
    presetEdit: null,
        presetReplace: null,
        pauseOpen: false,
        pauseShownAt: null,
        envCheck: { busy: false, open: false, result: null, reportPath: null },
        updatePrompt: { open: false, appVersion: null, lastAppVersion: null },
      };
      const listeners = new Set();
      let toastTimer = null;
      let searchTimer = null;
      let searchController = null;
      let searchSeq = 0;

      /** Saved setups match only when all four connection fields agree. */
  function matchesPreset(item, settings) {
    const trim = (value) => String(value ?? '').trim().replace(/[\\/]+$/u, '');
    return trim(item.url) === trim(settings.webdavUrl)
      && String(item.user ?? '').trim() === String(settings.webdavUser ?? '').trim()
      && String(item.password ?? '') === String(settings.webdavPassword ?? '')
      && trim(item.root) === trim(settings.webdavRoot);
  }

  const store = {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set(patch) {
          state = { ...state, ...patch };
          for (const listener of listeners) listener();
        },
        patchSearch(patch) {
          store.set({ search: { ...state.search, ...patch } });
        },
        patchTrash(patch) {
          store.set({ trash: { ...state.trash, ...patch } });
        },
        patchTrashState(patch) {
          store.patchTrash(patch);
        },
        toast(kind, text) {
          if (toastTimer !== null) clearTimeout(toastTimer);
          store.set({ toast: { kind, text, id: Date.now() } });
          toastTimer = setTimeout(() => store.set({ toast: null }), kind === 'error' ? 6000 : 3500);
        },
        async init() {
          try {
            const data = await runtime.rpc('state');
            store.set({
              ready: true,
              settings: { ...DEFAULTS, ...data.settings },
              trash: { ...state.trash, count: Number(data.count) || 0, size: Number(data.size) || 0 },
            });
          } catch (error) {
            store.set({ ready: true });
            console.warn('[dsh-enhanced] initial state failed:', error);
          }
        },
        async refreshCount() {
          try {
            const data = await runtime.rpc('state');
            store.patchTrash({ count: Number(data.count) || 0, size: Number(data.size) || 0 });
            store.set({ settings: { ...DEFAULTS, ...data.settings } });
          } catch {
            // The badge is decorative; a failed refresh changes nothing.
          }
        },
        async saveSettings(rawPatch) {
          // Master/sub switch coupling:
          //   master off + any sub turned on  -> master on
          //   master turned off               -> every sub off
          //   master turned on                -> subs keep their state
          const patch = { ...rawPatch };
          if (Object.prototype.hasOwnProperty.call(patch, 'syncEnabled')) {
            if (patch.syncEnabled !== true) {
              patch.syncOnIdle = false;
              patch.syncIntervalMinutes = 0;
              patch.syncDailyAt = '';
            }
          } else {
            const merged = { ...state.settings, ...patch };
            const anySub = merged.syncOnIdle === true
              || Number(merged.syncIntervalMinutes) > 0
              || (typeof merged.syncDailyAt === 'string' && merged.syncDailyAt.trim() !== '');
            if (anySub && merged.syncEnabled !== true) patch.syncEnabled = true;
          }
          const next = { ...state.settings, ...patch };
          store.set({ settings: next });
          try {
            const data = await runtime.rpc('settings.set', { patch });
            store.set({ settings: { ...DEFAULTS, ...data.settings } });
          } catch (error) {
            store.toast('error', String(error?.message ?? error));
            await store.init();
          }
        },
        openSearch() {
          store.patchSearch({ open: true });
          const query = state.search.query;
          if (query.trim() !== '' && state.search.status === 'idle') store.runSearch(query);
        },
        closeSearch() {
          if (searchTimer !== null) clearTimeout(searchTimer);
          searchTimer = null;
          if (searchController !== null) searchController.abort();
          searchController = null;
          store.patchSearch({ open: false, status: 'idle' });
        },
        setQuery(query) {
          store.patchSearch({ query });
          if (searchTimer !== null) clearTimeout(searchTimer);
          if (query.trim() === '') {
            if (searchController !== null) searchController.abort();
            searchController = null;
            store.patchSearch({ status: 'idle', groups: [], error: null, scanned: 0 });
            return;
          }
          searchTimer = setTimeout(() => {
            searchTimer = null;
            store.runSearch(query);
          }, 220);
        },
        async runSearch(query) {
          const seq = ++searchSeq;
          if (searchController !== null) searchController.abort();
          const controller = new AbortController();
          searchController = controller;
          store.patchSearch({ status: 'loading', error: null });
          try {
            const data = await runtime.rpc('search', { query }, controller.signal);
            if (seq !== searchSeq) return;
            store.patchSearch({
              status: 'done',
              groups: Array.isArray(data.groups) ? data.groups : [],
              error: null,
              tookMs: Number(data.tookMs) || 0,
              truncated: data.truncated === true,
              scanned: Number(data.scanned) || 0,
            });
          } catch (error) {
            if (seq !== searchSeq || controller.signal.aborted) return;
            store.patchSearch({ status: 'error', error: String(error?.message ?? error), groups: [] });
          } finally {
            if (searchController === controller) searchController = null;
          }
        },
        requestDelete(sessionId, title, running) {
          store.set({ pendingDelete: { sessionId, title, running: running === true }, deleteError: null, deleteBusy: false });
        },
        cancelDelete() {
          if (state.deleteBusy) return;
          store.set({ pendingDelete: null, deleteError: null });
        },
        async confirmDelete() {
          const pending = state.pendingDelete;
          if (pending === null) return;
          store.set({ deleteBusy: true, deleteError: null });
          try {
            const data = await runtime.rpc('session.delete', { sessionId: pending.sessionId });
            store.set({ pendingDelete: null, deleteBusy: false });
            store.toast('success', runtime.t('delete.done', { title: data?.title ?? pending.title }));
            await store.refreshCount();
            store.restartApp();
          } catch (error) {
            store.set({ deleteBusy: false, deleteError: String(error?.message ?? error) });
          }
        },
        async openTrash() {
          store.patchTrash({ open: true, loading: true, error: null, scopeSession: null, scopeWorkspace: null, confirmPurge: null, confirmClear: false, confirmWorkspace: null });
          await store.loadTrash();
        },
        async openTrashForSession(sessionId) {
          store.patchTrash({ open: true, loading: true, error: null, scopeSession: sessionId, scopeWorkspace: null, confirmPurge: null, confirmClear: false, confirmWorkspace: null });
          await store.loadTrash();
        },
        closeTrash() {
          if (state.trash.busy !== null) return;
          store.patchTrash({ open: false, confirmPurge: null, confirmClear: false, confirmWorkspace: null, scopeSession: null, scopeWorkspace: null });
        },
        async loadTrash() {
          store.patchTrash({ loading: true, error: null });
          try {
            const scope = { sessionId: state.trash.scopeSession, workspaceId: state.trash.scopeWorkspace };
            const data = await runtime.rpc('trash.list', scope);
            store.patchTrash({
              loading: false,
              groups: Array.isArray(data.groups) ? data.groups : [],
              count: Number(data.count) || 0,
              size: Number(data.size) || 0,
            });
          } catch (error) {
            store.patchTrash({ loading: false, error: String(error?.message ?? error) });
          }
        },
        requestPurge(sessionId) {
          store.patchTrash({ confirmPurge: sessionId, confirmClear: false, confirmWorkspace: null });
        },
        async restore(sessionId, title) {
          store.patchTrash({ busy: sessionId });
          try {
            const data = await runtime.rpc('trash.restore', { sessionId });
            await store.loadTrash();
            const warning = typeof data?.warning === 'string' && data.warning !== '' ? data.warning : null;
            store.toast(warning === null ? 'success' : 'info', warning ?? runtime.t('trash.restored', { title }));
            store.patchTrash({ open: false, confirmPurge: null, confirmClear: false });
            if (typeof data?.workspaceId === 'string' && data.workspaceId !== '') {
              await runtime.refreshWorkspace(data.workspaceId);
            }
            store.restartApp();
          } catch (error) {
            store.toast('error', String(error?.message ?? error));
          } finally {
            store.patchTrash({ busy: null });
          }
        },
        async purge(sessionId, title) {
          store.patchTrash({ busy: sessionId, confirmPurge: null });
          try {
            await runtime.rpc('trash.purge', { sessionId });
            await store.loadTrash();
            store.toast('success', runtime.t('trash.purged', { title }));
          } catch (error) {
            store.toast('error', String(error?.message ?? error));
          } finally {
            store.patchTrash({ busy: null });
          }
        },
        requestClear() {
          store.patchTrash({ confirmClear: true, confirmPurge: null, confirmWorkspace: null });
        },
        async clearTrash() {
          store.patchTrash({ busy: '*', confirmClear: false });
          try {
            await runtime.rpc('trash.clear');
            await store.loadTrash();
            store.toast('success', runtime.t('trash.cleared'));
          } catch (error) {
            store.toast('error', String(error?.message ?? error));
          } finally {
            store.patchTrash({ busy: null });
          }
        },
        requestClearWorkspace(workspaceId) {
          store.patchTrash({ confirmWorkspace: workspaceId, confirmClear: false, confirmPurge: null });
        }, async clearWorkspace(workspaceId) {
          store.patchTrash({ busy: workspaceId, confirmWorkspace: null });
          try {
            const data = await runtime.rpc('trash.clear', { workspaceId });
            await store.loadTrash();
            store.toast('success', `${runtime.t('trash.clearWorkspace')} · ${String(Number(data?.removed) || 0)}`);
          } catch (error) {
            store.toast('error', String(error?.message ?? error));
          } finally {
            store.patchTrash({ busy: null });
          }
        },
        async openMove(sessionId, title) {
          store.set({
            move: {
              open: true,
              sessionId,
              title: title === '' ? '未命名会话' : title,
              loading: true,
              current: null,
              workspaces: [],
              targetId: null,
              error: null,
              busy: false,
            },
          });
          try {
            const data = await runtime.rpc('workspace.candidates', { sessionId });
            const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
            store.set({
              move: { ...state.move, loading: false, current: data.current ?? null, workspaces, targetId: workspaces[0]?.id ?? null },
            });
          } catch (error) {
            store.set({ move: { ...state.move, loading: false, error: String(error?.message ?? error) } });
          }
        },
        closeMove() {
          if (state.move.busy) return;
          store.set({ move: { ...state.move, open: false } });
        },
        setMoveTarget(targetId) {
          store.set({ move: { ...state.move, targetId } });
        },
        async confirmMove() {
          const move = state.move;
          if (move.busy || move.targetId === null) return;
          store.set({ move: { ...move, busy: true, error: null } });
          try {
            const data = await runtime.rpc('session.move', { sessionId: move.sessionId, workspaceId: move.targetId });
            const target = move.workspaces.find((workspace) => workspace.id === move.targetId);
            store.set({ move: { ...state.move, open: false, busy: false } });
            const warning = typeof data?.warning === 'string' && data.warning !== '' ? data.warning : null;
            store.toast(warning === null ? 'success' : 'info', warning ?? runtime.t('move.done', { title: target?.title ?? '' }));
            await store.refreshCount();
            if (data?.needsRestart === true) store.restartApp();
          } catch (error) {
            store.set({ move: { ...state.move, busy: false, error: String(error?.message ?? error) } });
          }
        },
        async loadSync() {
          try {
            const data = await runtime.rpc('sync.state');
            const auto = data?.auto ?? null;
            if (auto?.paused === true && auto.pausedAt !== null && auto.pausedAt !== state.pauseShownAt) {
              store.set({ pauseOpen: true, pauseShownAt: auto.pausedAt });
            }
            store.set({
              sync: {
                ...state.sync,
                loading: false,
                error: null,
                target: data?.target ?? null,
                state: data?.state ?? null,
                auto,
                history: Array.isArray(data?.history) ? data.history : [],
              },
            });
          } catch (error) {
            store.set({ sync: { ...state.sync, loading: false, error: String(error?.message ?? error) } });
          }
        },
        async probeSync() {
          if (state.sync.busy) return;
          store.set({ sync: { ...state.sync, busy: true, error: null } });
          try {
            const data = await runtime.rpc('sync.probe');
            store.set({
              sync: { ...state.sync, busy: false, state: data, error: data?.ok === false ? String(data?.summary?.error ?? runtime.t('sync.result.fail')) : null },
            });
          } catch (error) {
            store.set({ sync: { ...state.sync, busy: false, error: String(error?.message ?? error) } });
          }
        },
        async runSyncNow() {
          if (state.sync.busy) return;
          store.set({ sync: { ...state.sync, busy: true, error: null } });
          try {
            const data = await runtime.rpc('sync.run');
            store.set({ sync: { ...state.sync, busy: false, state: data, error: null } });
            store.toast(
              data?.ok === false ? 'error' : 'success',
              data?.ok === false
                ? runtime.t('sync.failed', { message: String(data?.summary?.error ?? data?.exitCode ?? '?') })
                : runtime.t('sync.result.ok'),
            );
            await store.loadSync();
            const pulled = Number(data?.summary?.sessions?.pulled) || Number(data?.summary?.sessions?.created) || 0;
            if (pulled > 0) {
              store.toast('success', `${runtime.t('sync.result.ok')}${runtime.t('sync.restartingSoon')}`);
              store.restartApp();
            }
          } catch (error) {
            store.set({ sync: { ...state.sync, busy: false, error: String(error?.message ?? error) } });
            store.toast('error', String(error?.message ?? error));
            await store.loadSync();
          }
        },
        /** Restart the app so a structural change becomes visible. */
        restartApp() {
          window.setTimeout(() => {
            void runtime.rpc('app.restart').catch((error) => {
              const message = String(error?.message ?? error);
              // The host refuses while a turn is running; say so instead of
              // looking like the button did nothing.
              store.toast('error', message.includes('restart-busy')
                ? runtime.t('restart.busy')
                : message);
            });
          }, 400);
        },
        openRestart() {
          store.set({ restartConfirm: true });
        },
        startPresetRename() {
          const settings = state.settings ?? {};
          const presets = Array.isArray(settings.webdavProfiles) ? settings.webdavProfiles : [];
          const active = presets.find((item) => matchesPreset(item, settings)) ?? null;
          if (active === null) return;
          store.set({ presetEdit: { mode: 'rename', id: active.id, name: active.name } });
        },
        startPresetSave() {
          const settings = state.settings ?? {};
          const url = String(settings.webdavUrl ?? '').trim();
          if (url === '') return;
          const presets = Array.isArray(settings.webdavProfiles) ? settings.webdavProfiles : [];
          if (presets.length >= 3) {
            store.set({ presetReplace: { open: true } });
            return;
          }
          store.set({ presetEdit: { mode: 'save', id: null, name: '' } });
        },
        startPresetModify() {
          const settings = state.settings ?? {};
          const presets = Array.isArray(settings.webdavProfiles) ? settings.webdavProfiles : [];
          const active = presets.find((item) => matchesPreset(item, settings)) ?? null;
          if (active === null) return;
          store.set({ presetEdit: { mode: 'modify', id: active.id, name: active.name } });
        },
        commitPresetModify() {
          const current = state.presetEdit;
          if (current === null) return;
          const settings = state.settings ?? {};
          const presets = Array.isArray(settings.webdavProfiles) ? settings.webdavProfiles : [];
          const list = presets.map((item) => (item.id === current.id
            ? {
              ...item,
              url: settings.webdavUrl ?? '',
              user: settings.webdavUser ?? '',
              password: settings.webdavPassword ?? '',
              root: settings.webdavRoot ?? '',
            }
            : item));
          store.set({ presetEdit: null });
          void runtime.store.saveSettings({ webdavProfiles: list })
            .then(() => runtime.store.toast('success', runtime.t('sync.webdav.presets.updated', { name: current.name })))
            .catch((error) => runtime.store.toast('error', String(error?.message ?? error)));
        },
        closePresetReplace() {
          store.set({ presetReplace: null });
        },
        confirmPresetReplace(id) {
          const settings = state.settings ?? {};
          const presets = Array.isArray(settings.webdavProfiles) ? settings.webdavProfiles : [];
          const list = presets.map((item) => (item.id === id
            ? {
              ...item,
              url: settings.webdavUrl ?? '',
              user: settings.webdavUser ?? '',
              password: settings.webdavPassword ?? '',
              root: settings.webdavRoot ?? '',
              custom: true,
            }
            : item));
          store.set({ presetReplace: null });
          void runtime.store.saveSettings({ webdavProfiles: list })
            .then(() => runtime.store.toast('success', runtime.t('sync.webdav.presets.replaced')))
            .catch((error) => runtime.store.toast('error', String(error?.message ?? error)));
        },
        setPresetName(name) {
          const current = state.presetEdit;
          if (current === null) return;
          store.set({ presetEdit: { ...current, name } });
        },
        cancelPresetEdit() {
          store.set({ presetEdit: null });
        },
        dropActivePreset() {
          const settings = state.settings ?? {};
          const presets = Array.isArray(settings.webdavProfiles) ? settings.webdavProfiles : [];
          const active = presets.find((item) => matchesPreset(item, settings)) ?? null;
          if (active === null) return;
          const rest = presets.filter((item) => item.id !== active.id);
          const next = rest[0];
          void runtime.store.saveSettings(next === undefined
            ? { webdavProfiles: rest }
            : { webdavProfiles: rest, webdavUrl: next.url, webdavUser: next.user, webdavPassword: next.password, webdavRoot: next.root });
        },
        commitPresetEdit() {
          const current = state.presetEdit;
          if (current === null) return;
          let name = String(current.name ?? '').trim();
          if (name === '') {
            const url = String(state.settings?.webdavUrl ?? '').trim();
            let host = 'WebDAV';
            try { host = new URL(url).host; } catch { host = url.replace(/^https?:\/\//u, '').split('/')[0] || 'WebDAV'; }
            const root = String(state.settings?.webdavRoot ?? '').trim();
            name = root === '' || root === '/' ? host : `${host} · ${root}`;
          }
          const settings = state.settings ?? {};
          const presets = Array.isArray(settings.webdavProfiles) ? settings.webdavProfiles : [];
          if (current.mode === 'rename') {
            const list = presets.map((item) => (item.id === current.id ? { ...item, name, custom: true } : item));
            store.set({ presetEdit: null });
            void runtime.store.saveSettings({ webdavProfiles: list });
            return;
          }
          const entry = {
            id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
            name,
            url: settings.webdavUrl ?? '',
            user: settings.webdavUser ?? '',
            password: settings.webdavPassword ?? '',
            root: settings.webdavRoot ?? '',
            custom: true,
          };
          if (presets.length >= 3) {
            runtime.store.toast('error', runtime.t('sync.webdav.presets.full'));
            return;
          }
          store.set({ presetEdit: null });
          void runtime.store.saveSettings({ webdavProfiles: [...presets, entry] })
            .then(() => runtime.store.toast('success', runtime.t('sync.webdav.presets.saved', { name })))
            .catch((error) => runtime.store.toast('error', String(error?.message ?? error)));
        },
        closeRestart() {
          store.set({ restartConfirm: false });
        },
        confirmRestart() {
          store.set({ restartConfirm: false });
          store.restartApp();
        },
        openOverwrite(direction) {
          store.set({ overwrite: { open: true, direction, busy: false, preview: null, error: null } });
        },
        closeOverwrite() {
          if (state.overwrite.busy === true) return;
          store.set({ overwrite: { ...state.overwrite, open: false } });
        },
        async confirmOverwrite() {
          const direction = state.overwrite.direction;
          store.set({ overwrite: { ...state.overwrite, busy: true, error: null } });
          try {
            const result = await runtime.rpc('sync.overwrite', { direction, apply: true });
            store.set({ overwrite: { ...state.overwrite, open: false, busy: false } });
            store.toast('success', direction === 'cloud'
              ? runtime.t('overwrite.cloudDone', { n: String(result?.uploaded ?? 0) })
              : runtime.t('overwrite.localDone', { n: String(result?.copied ?? 0) }));
            await store.loadSync();
            // Replacing this machine wholesale only takes effect after a restart.
            if (direction === 'local') store.restartApp();
          } catch (error) {
            store.set({ overwrite: { ...state.overwrite, busy: false, error: String(error?.message ?? error) } });
          }
        },
        dismissPauseNotice() {
          store.set({ pauseOpen: false });
        },
        async resumeAutoSync() {
          try {
            const data = await runtime.rpc('sync.resume');
            store.set({ pauseOpen: false, sync: { ...state.sync, auto: data?.auto ?? null } });
            store.toast('success', runtime.t('pause.resumed'));
          } catch (error) {
            store.toast('error', String(error?.message ?? error));
          }
        },
        async runEnvCheck() {
          store.set({ envCheck: { ...state.envCheck, busy: true, open: true, result: null, reportPath: null } });
          try {
            const result = await runtime.rpc('env.check');
            store.set({ envCheck: { ...state.envCheck, busy: false, open: true, result } });
            // A deliberate check counts as "I have seen this version".
            void runtime.rpc('env.ack').catch(() => {});
          } catch (error) {
            store.set({ envCheck: { ...state.envCheck, busy: false, open: true, result: { ok: false, failedCount: 1, checks: [{ label: '检测失败', ok: false, detail: String(error?.message ?? error), severity: 'high' }] } } });
          }
        },
        closeEnvCheck() {
          store.set({ envCheck: { ...state.envCheck, open: false } });
        },
        async writeEnvReport() {
          try {
            const written = await runtime.rpc('env.report');
            store.set({ envCheck: { ...state.envCheck, open: false, reportPath: written?.path ?? null } });
            store.toast('success', runtime.t('env.reported', { path: written?.path ?? '' }));
          } catch (error) {
            store.toast('error', String(error?.message ?? error));
          }
        },
        async checkAppVersion() {
          try {
            const info = await runtime.rpc('env.version');
            if (info?.changed === true) {
              store.set({ updatePrompt: { open: true, appVersion: info.appVersion, lastAppVersion: info.lastAppVersion } });
              return;
            }
            if (info?.appVersion !== null && info?.appVersion !== undefined) {
              await runtime.rpc('env.ack');
            }
          } catch {
            // Version probing is advisory only.
          }
        },
        async acceptUpdatePrompt() {
          store.set({ updatePrompt: { ...state.updatePrompt, open: false } });
          await store.runEnvCheck();
        },
        dismissUpdatePrompt() {
          // No ack: the reminder returns on the next start until a check runs.
          store.set({ updatePrompt: { ...state.updatePrompt, open: false } });
        },
        toggleSyncLog() {
          const open = state.sync.showLog !== true;
          store.set({ sync: { ...state.sync, showLog: open, historyOpen: open ? 0 : null, historyLimit: 5 } });
        },
        showMoreHistory() {
          store.set({ sync: { ...state.sync, historyLimit: (Number(state.sync.historyLimit) || 5) + 50 } });
        },
        openHistory(index) {
          const next = state.sync.historyOpen === index ? null : index;
          store.set({ sync: { ...state.sync, historyOpen: next } });
        },
        async testWebdav() {
          if (state.sync.webdavBusy === true) return;
          store.set({ sync: { ...state.sync, webdavBusy: true, webdav: null } });
          try {
            const data = await runtime.rpc('sync.webdavTest');
            store.set({ sync: { ...state.sync, webdavBusy: false, webdav: data } });
          } catch (error) {
            store.set({ sync: { ...state.sync, webdavBusy: false, webdav: { ok: false, message: String(error?.message ?? error) } } });
          }
        },
      };
      return store;
    }

    const runtime = {
      store: null,
      t: (key) => key,
      rpc: async () => {
        throw new Error('DSH增强尚未初始化。');
      },
      openSession: () => {},
      jumpToAnchor: () => {},
      focusMatch: () => {},
      composer: null,
      composerDraft: '',
    };

    function useStore() {
      const store = runtime.store;
      return React.useSyncExternalStore(store.subscribe, store.get, store.get);
    }

    // ── shared pieces ────────────────────────────────────────────────────────

    function icon(name, props) {
      const Component = primitives?.[name];
      if (Component === undefined) return null;
      return h(Component, props ?? {});
    }

    function MenuRow(props) {
      const { danger, disabled, separatorBefore, iconName, onSelect, children } = props;
      if (primitives?.MenuItemButton !== undefined) {
        return h(primitives.MenuItemButton, {
          danger,
          disabled,
          separatorBefore,
          icon: icon(iconName ?? 'IconTrashOutlineRegular', { size: 14 }),
          onSelect,
        }, children);
      }
      return h('button', {
        type: 'button',
        role: 'menuitem',
        disabled,
        className: `dshe-match${danger === true ? ' dshe-action-danger' : ''}`,
        onClick: onSelect,
      }, children);
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'dshe-switch',
        'aria-checked': props.checked === true,
        'aria-label': props.label,
        disabled: props.disabled === true,
        onClick: () => props.onChange(!(props.checked === true)),
      }, h('span', {}));
    }

    function formatSize(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${String(value)} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function formatWhen(iso) {
      const time = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
      if (!Number.isFinite(time)) return '';
      return new Date(time).toLocaleString();
    }

    function highlight(text, query) {
      const needle = typeof query === 'string' ? query.trim() : '';
      if (needle === '') return text;
      const lower = text.toLowerCase();
      const target = needle.toLowerCase();
      const parts = [];
      let from = 0;
      let index = lower.indexOf(target);
      let key = 0;
      while (index >= 0) {
        if (index > from) parts.push(text.slice(from, index));
        parts.push(h('mark', { className: 'dshe-mark', key: `m${String(key)}` }, text.slice(index, index + target.length)));
        key += 1;
        from = index + target.length;
        index = lower.indexOf(target, from);
      }
      if (from < text.length) parts.push(text.slice(from));
      return parts;
    }

    // ── session menu row ─────────────────────────────────────────────────────

    function SessionTrashRow(props) {
      const state = useStore();
      const { sessionId, useMenuOpenState } = props;
      const closeMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : null;
      if (state.settings.trashEnabled !== true) return null;
      return h(MenuRow, {
        disabled: false,
        separatorBefore: false,
        iconName: 'IconArchiveOutlineRegular',
        onSelect: () => {
          if (typeof closeMenu === 'function') closeMenu(false);
          runtime.store.openTrashForSession(sessionId);
        },
      }, runtime.t('trash.menu'));
    }

    function SessionMoveRow(props) {
      const state = useStore();
      const { sessionId, displayTitle, useMenuOpenState } = props;
      const closeMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : null;
      const statuses = typeof props.useSessionStatus === 'function' ? props.useSessionStatus((value) => value) : null;
      let running = false;
      try {
        running = statuses?.get?.(sessionId)?.running === true;
      } catch {
        running = false;
      }
      if (state.settings.moveEnabled !== true) return null;
      return h(MenuRow, {
        disabled: running,
        separatorBefore: false,
        iconName: 'IconFolderOpenRegular',
        onSelect: () => {
          if (typeof closeMenu === 'function') closeMenu(false);
          runtime.store.openMove(sessionId, displayTitle);
        },
      }, running ? runtime.t('move.running') : runtime.t('move.label'));
    }

    function SessionDeleteRow(props) {      const state = useStore();
      const { sessionId, displayTitle, useMenuOpenState } = props;
      const closeMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : null;
      const statuses = typeof props.useSessionStatus === 'function' ? props.useSessionStatus((value) => value) : null;
      let running = false;
      try {
        running = statuses?.get?.(sessionId)?.running === true;
      } catch {
        running = false;
      }
      if (state.settings.deleteEnabled !== true) return null;
      return h(MenuRow, {
        danger: true,
        disabled: running,
        separatorBefore: true,
        onSelect: () => {
          if (typeof closeMenu === 'function') closeMenu(false);
          runtime.store.requestDelete(sessionId, displayTitle, running);
        },
      }, running ? runtime.t('delete.running') : runtime.t('delete.label'));
    }

    // ── delete confirmation ──────────────────────────────────────────────────

const displayName = (value) => {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text === '' || /^session-[0-9a-f-]{8,}$/iu.test(text)) return runtime.t('trash.untitled');
        return text;
      };

    function DeleteDialog() {
      const state = useStore();
      const pending = state.pendingDelete;
      if (pending === null) return null;
      const body = h('div', { className: 'dshe-section' },
        h('div', { className: 'dshe-card' },
          h('div', { className: 'dshe-row' },
            h('div', { className: 'dshe-row-main' },
              h('div', { className: 'dshe-row-title' }, displayName(pending.title)),
              h('div', { className: 'dshe-row-desc' }, runtime.t('delete.desc')),
            ),
          ),
        ),
        state.deleteError === null ? null : h('div', { className: 'dshe-status dshe-error', role: 'alert' }, state.deleteError),
        state.deleteBusy === true ? h('div', { className: 'dshe-status', role: 'status' }, `${runtime.t('delete.confirm')}…`) : null,
      );
      const footer = h(React.Fragment, {},
        h('button', { type: 'button', className: 'dshe-action', disabled: state.deleteBusy, onClick: () => runtime.store.cancelDelete() }, runtime.t('common.cancel')),
        h('button', {
          type: 'button',
          className: 'dshe-action dshe-action-danger',
          disabled: state.deleteBusy,
          onClick: () => runtime.store.confirmDelete(),
        }, runtime.t('delete.confirm')),
      );
      if (primitives?.Modal === undefined) return null;
      return h(primitives.Modal, {
        open: true,
        onClose: () => runtime.store.cancelDelete(),
        closeLabel: runtime.t('common.close'),
        title: runtime.t('delete.title'),
        footer,
      }, body);
    }

    // ── composer bridge ──────────────────────────────────────────────────────

    function ComposerBridge(props) {
      const { inputActions, useInput } = props;
      const input = typeof useInput === 'function' ? useInput((value) => value) : undefined;
      const draft = typeof input?.draft === 'string' ? input.draft : '';
      React.useEffect(() => {
        runtime.composer = inputActions ?? null;
        runtime.composerDraft = draft;
        return () => {
          if (runtime.composer === inputActions) runtime.composer = null;
        };
      }, [inputActions, draft]);
      return null;
    }

    // ── move dialog ──────────────────────────────────────────────────────────

    function MoveDialog() {
      const state = useStore();
      const move = state.move;
      if (move.open !== true) return null;
      if (primitives?.Modal === undefined) return null;
      const body = h('div', { className: 'dshe-section' },
        h('div', { className: 'dshe-row-desc' }, runtime.t('move.session', { title: move.title })),
        move.current === null ? null : h('div', { className: 'dshe-row-desc' }, runtime.t('move.current', { title: move.current.title })),
        move.loading === true
          ? h('div', { className: 'dshe-status', role: 'status' }, runtime.t('move.loading'))
          : move.error !== null
            ? h('div', { className: 'dshe-status dshe-error', role: 'alert' }, runtime.t('move.failed', { message: move.error }))
            : move.workspaces.length === 0
              ? h('div', { className: 'dshe-status' }, runtime.t('move.empty'))
              : h('div', { className: 'dshe-move-list', role: 'radiogroup', 'aria-label': runtime.t('move.target') },
                  move.workspaces.map((workspace) => h('label', {
                    className: 'dshe-move-item',
                    key: workspace.id,
                    'data-active': move.targetId === workspace.id ? 'true' : 'false',
                  },
                    h('input', {
                      type: 'radio',
                      name: 'dshe-move-target',
                      checked: move.targetId === workspace.id,
                      disabled: move.busy === true,
                      onChange: () => runtime.store.setMoveTarget(workspace.id),
                    }),
                    h('span', { className: 'dshe-move-main' },
                      h('span', { className: 'dshe-move-title' }, workspace.title),
                      h('span', { className: 'dshe-move-meta' }, `${workspace.path} · ${String(workspace.sessionCount)}`),
                    ),
                  )),
                ),
        move.busy === true ? h('div', { className: 'dshe-status', role: 'status' }, runtime.t('move.busy')) : null,
      );
      const footer = h(React.Fragment, {},
        h('button', {
          type: 'button',
          className: 'dshe-action',
          disabled: move.busy === true,
          onClick: () => runtime.store.closeMove(),
        }, runtime.t('common.cancel')),
        h('button', {
          type: 'button',
          className: 'dshe-action dshe-action-danger',
          disabled: move.busy === true || move.loading === true || move.targetId === null,
          onClick: () => runtime.store.confirmMove(),
        }, runtime.t('move.confirm')),
      );
      return h(primitives.Modal, {
        open: true,
        onClose: () => runtime.store.closeMove(),
        closeLabel: runtime.t('common.close'),
        title: runtime.t('move.title'),
        footer,
      }, body);
    }

    // ── trash dialog ─────────────────────────────────────────────────────────

    function TrashDialog() {
      const state = useStore();
      const trash = state.trash;
      if (trash.open !== true) return null;
      if (primitives?.Modal === undefined) return null;
      const groups = trash.groups ?? [];
      const body = h('div', { className: 'dshe-section' },
        h('p', { className: 'dshe-section-desc' }, runtime.t('trash.desc')),
        trash.loading === true
          ? h('div', { className: 'dshe-status', role: 'status' }, runtime.t('trash.loading'))
          : trash.error !== null
            ? h('div', { className: 'dshe-status dshe-error', role: 'alert' }, trash.error)
            : groups.length === 0
              ? h('div', { className: 'dshe-status' }, runtime.t('trash.empty'))
              : h('div', { className: 'dshe-trash-body' }, groups.map((group) => h('div', { key: group.workspaceId },
                  h('div', { className: 'dshe-trash-group-head' },
                    h('span', { className: 'dshe-trash-group-title' }, group.workspaceTitle === '' || group.workspaceTitle === undefined ? '未分组' : group.workspaceTitle),
                    trash.confirmWorkspace === group.workspaceId
                      ? h('span', { className: 'dshe-trash-group-actions' },
                          h('button', {
                            type: 'button',
                            className: 'dshe-action',
                            disabled: trash.busy !== null,
                            onClick: () => runtime.store.patchTrashState({ confirmWorkspace: null }),
                          }, runtime.t('common.cancel')),
                          h('button', {
                            type: 'button',
                            className: 'dshe-action dshe-action-danger',
                            disabled: trash.busy !== null,
                            onClick: () => runtime.store.clearWorkspace(group.workspaceId),
                          }, runtime.t('trash.clearWorkspace.confirm')),
                        )
                      : group.workspaceId === '_ungrouped'
                        ? null
                        : h('button', {
                            type: 'button',
                            className: 'dshe-link-danger',
                            disabled: trash.busy !== null,
                            onClick: () => runtime.store.requestClearWorkspace(group.workspaceId),
                          }, runtime.t('trash.clearWorkspace')),
                  ),
                  (group.items ?? []).map((item) => {
                    const confirming = trash.confirmPurge === item.sessionId;
                    return h('div', { className: 'dshe-trash-row', key: item.sessionId },
                      h('div', { className: 'dshe-trash-main' },
                        h('div', { className: 'dshe-trash-title', title: displayName(item.title) }, displayName(item.title)),
                        h('div', { className: 'dshe-trash-id', title: item.sessionId }, item.sessionId),
                        h('div', { className: 'dshe-trash-meta' }, `${formatWhen(item.deletedAt)} · ${formatSize(item.sizeBytes)}`),
                      ),
                      confirming
                        ? h(React.Fragment, {},
                            h('button', {
                              type: 'button',
                              className: 'dshe-action',
                              disabled: trash.busy !== null,
                              onClick: () => runtime.store.patchTrashState({ confirmPurge: null }),
                            }, runtime.t('common.cancel')),
                            h('button', {
                              type: 'button',
                              className: 'dshe-action dshe-action-danger',
                              disabled: trash.busy !== null,
                              onClick: () => runtime.store.purge(item.sessionId, item.title),
                            }, runtime.t('trash.purge.confirm')),
                          )
                        : h(React.Fragment, {},
                            h('button', {
                              type: 'button',
                              className: 'dshe-action',
                              disabled: trash.busy !== null,
                              onClick: () => runtime.store.restore(item.sessionId, item.title),
                            }, runtime.t('trash.restore')),
                            h('button', {
                              type: 'button',
                              className: 'dshe-action dshe-action-danger',
                              disabled: trash.busy !== null,
                              onClick: () => runtime.store.requestPurge(item.sessionId),
                            }, runtime.t('trash.purge')),
                          ),
                    );
                  }),
                ))),
      );
      const footer = h(React.Fragment, {},
        trash.confirmClear === true
          ? h(React.Fragment, {},
              h('button', {
                type: 'button',
                className: 'dshe-action',
                disabled: trash.busy !== null,
                onClick: () => runtime.store.patchTrashState({ confirmClear: false }),
              }, runtime.t('common.cancel')),
              h('button', {
                type: 'button',
                className: 'dshe-action dshe-action-danger',
                disabled: trash.busy !== null,
                onClick: () => runtime.store.clearTrash(),
              }, runtime.t('trash.clear.confirm')),
            )
          : h('button', {
              type: 'button',
              className: 'dshe-action dshe-action-danger',
              disabled: trash.busy !== null || trash.count === 0 || trash.scopeSession !== null,
              onClick: () => runtime.store.requestClear(),
              style: trash.scopeSession === null ? undefined : { display: 'none' },
            }, runtime.t('trash.clear')),
        h('button', {
          type: 'button',
          className: 'dshe-action',
          disabled: trash.busy !== null,
          onClick: () => runtime.store.closeTrash(),
        }, runtime.t('common.close')),
      );
      return h(primitives.Modal, {
        open: true,
        onClose: () => runtime.store.closeTrash(),
        closeLabel: runtime.t('common.close'),
        title: runtime.t('trash.title'),
        footer,
      }, body);
    }

    // ── search overlay ───────────────────────────────────────────────────────

    /** Height of the shell's caption strip, which the page must not cover. */
    function captionHeight() {
      let bottom = 0;
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll('*'));
      } catch {
        return 0;
      }
      for (const node of nodes) {
        let style;
        try {
          style = window.getComputedStyle(node);
        } catch {
          continue;
        }
        if (style.webkitAppRegion !== 'drag') continue;
        const rect = node.getBoundingClientRect();
        if (rect.top > 80) continue;
        if (rect.bottom > bottom) bottom = rect.bottom;
      }
      return Math.max(0, Math.round(bottom));
    }

    function SearchOverlay() {
      const state = useStore();
      const search = state.search;
      const inputRef = React.useRef(null);
      const resultsRef = React.useRef(null);
      const [active, setActive] = React.useState(0);

      React.useEffect(() => {
        if (search.open !== true) return undefined;
        const focus = () => {
          const node = inputRef.current;
          if (node !== null) {
            node.focus();
            node.select();
          }
        };
        focus();
        const timer = setTimeout(focus, 0);
        return () => clearTimeout(timer);
      }, [search.open]);

      React.useEffect(() => {
        if (search.open !== true) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          runtime.store.closeSearch();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [search.open]);

      const flat = React.useMemo(() => {
        const rows = [];
        for (const group of search.groups ?? []) {
          for (const match of group.matches ?? []) rows.push({ group, match });
        }
        return rows;
      }, [search.groups]);

      const offsets = React.useMemo(() => {
        const map = new Map();
        let cursor = 0;
        for (const group of search.groups ?? []) {
          map.set(group.sessionId, cursor);
          cursor += (group.matches ?? []).length;
        }
        return map;
      }, [search.groups]);

      React.useEffect(() => {
        setActive(0);
      }, [search.groups]);

      React.useEffect(() => {
        if (active >= flat.length) setActive(flat.length === 0 ? 0 : flat.length - 1);
      }, [flat.length, active]);

      React.useEffect(() => {
        const node = resultsRef.current?.querySelector('.dshe-match[data-active="true"]');
        if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'nearest' });
        }
      }, [active, search.groups]);

      if (search.open !== true) return null;

      const open = (sessionId, match) => {
        const query = search.query;
        runtime.store.closeSearch();
        runtime.openSession(sessionId);
        runtime.focusMatch(sessionId, match, query);
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          runtime.store.closeSearch();
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (flat.length === 0) return;
          event.preventDefault();
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          setActive((current) => (current + delta + flat.length) % flat.length);
          return;
        }
        if (event.key === 'Enter') {
          const row = flat[active];
          if (row === undefined) return;
          event.preventDefault();
          open(row.group.sessionId, row.match);
        }
      };

      const totalMatches = flat.length;
      const meta = search.status === 'done'
        ? runtime.t('search.meta', { count: (search.groups ?? []).length, matches: totalMatches })
        : '';

      const panel = h('div', { className: 'dshe-overlay dshe-overlay-top', role: 'presentation', style: { top: `${String(captionHeight())}px` } },
        h('div', { className: 'dshe-backdrop', 'aria-hidden': 'true', onClick: () => runtime.store.closeSearch() }),
        h('div', {
          className: 'dshe-search',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': runtime.t('search.placeholder'),
          onKeyDown,
        },
          h('div', { className: 'dshe-search-head' },
            h('span', { className: 'dshe-search-icon' }, icon('IconSearchOutlineRegular', { size: 16 })),
            h('input', {
              ref: inputRef,
              className: 'dshe-search-input',
              type: 'text',
              value: search.query,
              placeholder: runtime.t('search.placeholder'),
              'aria-label': runtime.t('search.placeholder'),
              onChange: (event) => runtime.store.setQuery(event.target.value),
            }),
            h('span', { className: 'dshe-group-meta' }, meta),
            h('button', {
              type: 'button',
              className: 'dshe-action',
              onClick: () => runtime.store.closeSearch(),
            }, runtime.t('common.close')),
          ),
          h('div', { className: 'dshe-results', ref: resultsRef },
            search.status === 'loading' ? h('div', { className: 'dshe-status', role: 'status' }, runtime.t('search.loading')) : null,
            search.status === 'error' ? h('div', { className: 'dshe-status dshe-error', role: 'alert' }, runtime.t('search.error', { message: search.error })) : null,
            search.status === 'idle' ? h('div', { className: 'dshe-status' }, runtime.t('search.hint')) : null,
            search.status === 'done' && totalMatches === 0 ? h('div', { className: 'dshe-status' }, runtime.t('search.empty')) : null,
            search.status === 'done'
              ? (search.groups ?? []).map((group) => h('div', { className: 'dshe-group', key: group.sessionId },
                  h('button', {
                    type: 'button',
                    className: 'dshe-group-title',
                    title: group.title,
                    onClick: () => open(group.sessionId),
                  }, group.title, h('span', { className: 'dshe-group-meta' }, (group.matches ?? []).length + '')),
                  (group.matches ?? []).map((match, index) => {
                    const rowIndex = (offsets.get(group.sessionId) ?? 0) + index;
                    return h('button', {
                      type: 'button',
                      className: 'dshe-match',
                      key: `${group.sessionId}-${String(match.seq ?? 'title')}-${String(index)}`,
                      'data-active': rowIndex === active ? 'true' : 'false',
                      onClick: () => open(group.sessionId, match),
                    },
                      h('span', { className: 'dshe-role' }, runtime.t(`role.${match.role ?? 'body'}`)),
                      h('span', { className: 'dshe-snippet' }, highlight(match.snippet ?? '', search.query)),
                    );
                  }),
                ))
              : null,
          ),
        ),
      );
      return panel;
    }

    // ── settings section ─────────────────────────────────────────────────────

    function NumberField(props) {
      const [draft, setDraft] = React.useState(String(props.value));
      React.useEffect(() => setDraft(String(props.value)), [props.value]);
      const commit = () => {
        const parsed = Number.parseInt(draft, 10);
        if (!Number.isFinite(parsed)) {
          setDraft(String(props.value));
          return;
        }
        const clamped = Math.min(props.max, Math.max(props.min, parsed));
        setDraft(String(clamped));
        if (clamped !== props.value) props.onChange(clamped);
      };
      return h('input', {
        className: 'dshe-number',
        type: 'number',
        min: props.min,
        max: props.max,
        value: draft,
        'aria-label': props.label,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        },
      });
    }

    function TextField(props) {
      const [draft, setDraft] = React.useState(props.value ?? '');
      React.useEffect(() => setDraft(props.value ?? ''), [props.value]);
      const commit = () => {
        const next = draft.trim();
        if (next !== (props.value ?? '')) props.onChange(next);
      };
      return h('input', {
        className: 'dshe-text',
        type: props.type ?? 'text',
        value: draft,
        placeholder: props.placeholder ?? '',
        'aria-label': props.label ?? props.title,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        },
      });
    }

    function Row(props) {
      return h('div', { className: 'dshe-row' },
        h('div', { className: 'dshe-row-main' },
          h('div', { className: 'dshe-row-title' }, props.title),
          props.desc === undefined ? null : h('div', { className: 'dshe-row-desc' }, props.desc),
        ),
        props.control,
      );
    }

    function SettingsSection() {
      const state = useStore();
      const settings = state.settings;
      const set = (patch) => runtime.store.saveSettings(patch);
    const presets = Array.isArray(settings.webdavProfiles) ? settings.webdavProfiles : [];
    const trimTail = (value) => String(value ?? '').trim().replace(/[\\/]+$/u, '');
    const currentFields = {
      url: settings.webdavUrl ?? '',
      user: settings.webdavUser ?? '',
      password: settings.webdavPassword ?? '',
      root: settings.webdavRoot ?? '',
    };
    const sameFields = (a, b) => trimTail(a.url) === trimTail(b.url)
      && String(a.user ?? '').trim() === String(b.user ?? '').trim()
      && String(a.password ?? '') === String(b.password ?? '')
      && trimTail(a.root) === trimTail(b.root);
    const activePreset = presets.find((item) => sameFields(item, currentFields)) ?? null;
    const canSavePreset = trimTail(currentFields.url) !== ''
      && presets.every((item) => sameFields(item, currentFields) === false);
    const applyPreset = (item) => {
      runtime.store.cancelPresetEdit();
      set({ webdavUrl: item.url, webdavUser: item.user, webdavPassword: item.password, webdavRoot: item.root });
    };
      const syncDirValue = typeof settings.syncDir === 'string' ? settings.syncDir : '';
      const webdavUrlValue = typeof settings.webdavUrl === 'string' ? settings.webdavUrl : '';
      const effectiveDir = settings.syncMode === 'webdav'
        ? (typeof settings.mirrorDir === 'string' ? settings.mirrorDir : '')
        : syncDirValue;
      React.useEffect(() => {
        runtime.store.refreshCount();
        runtime.store.loadSync();
      }, []);
      return h('div', { className: 'dshe-section' },
        h('h2', { className: 'dshe-section-title' }, runtime.t('section.title')),
        h('p', { className: 'dshe-section-desc' }, runtime.t('section.desc')),

        h('h3', { className: 'dshe-subsection-title' }, runtime.t('section.reading')),
        h('div', { className: 'dshe-card' },
          h(Row, {
            title: runtime.t('switch.autoLoad'),
            desc: runtime.t('switch.autoLoad.desc'),
            control: h(Switch, { label: runtime.t('switch.autoLoad'), checked: settings.autoLoadEnabled, onChange: (value) => set({ autoLoadEnabled: value }) }),
          }),
          h(Row, {
            title: runtime.t('switch.move'),
            desc: runtime.t('switch.move.desc'),
            control: h(Switch, { label: runtime.t('switch.move'), checked: settings.moveEnabled, onChange: (value) => set({ moveEnabled: value }) }),
          }),
        ),

        h('h3', { className: 'dshe-subsection-title' }, runtime.t('section.sessions')),
        h('div', { className: 'dshe-card' },
          h(Row, {
            title: runtime.t('switch.delete'),
            desc: runtime.t('switch.delete.desc'),
            control: h(Switch, { label: runtime.t('switch.delete'), checked: settings.deleteEnabled, onChange: (value) => set({ deleteEnabled: value }) }),
          }),
          h(Row, {
            title: runtime.t('switch.trash'),
            desc: runtime.t('switch.trash.desc'),
            control: h(Switch, { label: runtime.t('switch.trash'), checked: settings.trashEnabled, onChange: (value) => set({ trashEnabled: value }) }),
          }),
        ),
        h('div', { className: 'dshe-card' },
          h(Row, {
            title: runtime.t('field.retention'),
            desc: runtime.t('field.retention.hint'),
            control: h(NumberField, { label: runtime.t('field.retention'), value: settings.retentionDays, min: 0, max: 3650, onChange: (value) => set({ retentionDays: value }) }),
          }),
        ),
        h('div', { className: 'dshe-section' },
          settings.trashEnabled === true
            ? h('button', {
                type: 'button',
                className: 'dshe-action',
                onClick: () => runtime.store.openTrash(),
              }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                icon('IconArchiveOutlineRegular', { size: 14 }),
                runtime.t('trash.title'),
              ))
            : null,
          h('div', { className: 'dshe-row-desc' }, runtime.t('trash.usage', { count: state.trash.count, size: formatSize(state.trash.size) })),
        ),

        h('h3', { className: 'dshe-subsection-title' }, runtime.t('section.search')),
        h('div', { className: 'dshe-card' },
          h(Row, {
            title: runtime.t('switch.search'),
            desc: runtime.t('switch.search.desc'),
            control: h(Switch, { label: runtime.t('switch.search'), checked: settings.searchEnabled, onChange: (value) => set({ searchEnabled: value }) }),
          }),
        ),
        h('div', { className: 'dshe-card' },
          h(Row, {
            title: runtime.t('switch.matchTitle'),
            control: h(Switch, { label: runtime.t('switch.matchTitle'), checked: settings.matchTitle, onChange: (value) => set({ matchTitle: value }) }),
          }),
          h(Row, {
            title: runtime.t('switch.matchBody'),
            control: h(Switch, { label: runtime.t('switch.matchBody'), checked: settings.matchBody, onChange: (value) => set({ matchBody: value }) }),
          }),
          h(Row, {
            title: runtime.t('switch.matchTools'),
            control: h(Switch, { label: runtime.t('switch.matchTools'), checked: settings.matchTools, onChange: (value) => set({ matchTools: value }) }),
          }),

        ),

        h('h3', { className: 'dshe-subsection-title' }, runtime.t('section.sync')),
        h('div', { className: 'dshe-card' },
          h(Row, {
            title: runtime.t('sync.enable'),
            desc: runtime.t('sync.enable.hint'),
            control: h(Switch, { label: runtime.t('sync.enable'), checked: settings.syncEnabled, onChange: (value) => set({ syncEnabled: value }) }),
          }),
          h(Row, {
            title: runtime.t('sync.mode'),
            control: h('span', { style: { display: 'inline-flex', gap: '6px' } },
              h('button', {
                type: 'button',
                className: `dshe-action${settings.syncMode === 'webdav' ? ' dshe-action-active' : ''}`,
                onClick: () => set({ syncMode: 'webdav' }),
              }, runtime.t('sync.mode.webdav')),
              h('button', {
                type: 'button',
                className: `dshe-action${settings.syncMode === 'webdav' ? '' : ' dshe-action-active'}`,
                onClick: () => set({ syncMode: 'local' }),
              }, runtime.t('sync.mode.local')),
            ),
          }),
          settings.syncMode === 'webdav'
            ? h(React.Fragment, {},
                h('div', { className: 'dshe-presets' },
                  h('div', { className: 'dshe-presets-head' }, runtime.t('sync.webdav.presets')),
                  h('div', { className: 'dshe-presets-chips' },
                    h('select', {
                      className: 'dshe-select',
                      value: activePreset === null ? '' : activePreset.id,
                      onChange: (event) => {
                        const picked = presets.find((item) => item.id === event.target.value);
                        if (picked !== undefined) applyPreset(picked);
                      },
                    },
                      activePreset === null ? h('option', { value: '' }, runtime.t('sync.webdav.presets.default')) : null,
                      presets.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
                    ),
                    state.presetEdit !== null && state.presetEdit.mode === 'modify'
                      ? h(React.Fragment, null,
                        h('button', { key: 'commit', type: 'button', className: 'dshe-action dshe-action-active', onClick: () => runtime.store.commitPresetModify() }, runtime.t('sync.webdav.presets.commitModify')),
                        h('button', { key: 'cancel', type: 'button', className: 'dshe-action', onClick: () => runtime.store.cancelPresetEdit() }, runtime.t('common.cancel')),
                      )
                      : state.presetEdit === null
                        ? h(React.Fragment, null,
                          h('button', { key: 'rename', type: 'button', className: 'dshe-action', disabled: activePreset === null, onClick: () => runtime.store.startPresetRename() }, runtime.t('sync.webdav.presets.rename')),
                          h('button', { key: 'modify', type: 'button', className: 'dshe-action', disabled: activePreset === null, onClick: () => runtime.store.startPresetModify() }, runtime.t('sync.webdav.presets.modify')),
                          h('button', { key: 'remove', type: 'button', className: 'dshe-action dshe-action-danger', disabled: activePreset === null, onClick: () => runtime.store.dropActivePreset() }, runtime.t('sync.webdav.presets.remove')),
                          h('button', { key: 'save', type: 'button', className: 'dshe-action dshe-action-active', disabled: canSavePreset === false, onClick: () => runtime.store.startPresetSave() }, runtime.t('sync.webdav.presets.save')),
                        )
                        : h(React.Fragment, null,
                          h(TextField, { key: 'name', title: runtime.t('sync.webdav.presets.name'), value: state.presetEdit.name, onChange: (value) => runtime.store.setPresetName(value) }),
                          h('button', { key: 'ok', type: 'button', className: 'dshe-action dshe-action-active', onClick: () => runtime.store.commitPresetEdit() }, '✓'),
                          h('button', { key: 'cancel', type: 'button', className: 'dshe-action', onClick: () => runtime.store.cancelPresetEdit() }, '×'),
                        ),
                  ),
                ),
                h(Row, {
                  title: runtime.t('sync.webdav.url'),
                  control: h(TextField, { title: runtime.t('sync.webdav.url'), value: webdavUrlValue, placeholder: 'https://dav.jianguoyun.com/dav/', onChange: (value) => set({ webdavUrl: value }) }),
                }),
                h(Row, {
                  title: runtime.t('sync.webdav.user'),
                  control: h(TextField, { title: runtime.t('sync.webdav.user'), value: settings.webdavUser, placeholder: 'user@example.com', onChange: (value) => set({ webdavUser: value }) }),
                }),
                h(Row, {
                  title: runtime.t('sync.webdav.password'),
                  desc: runtime.t('sync.webdav.password.hint'),
                  control: h(TextField, { title: runtime.t('sync.webdav.password'), type: 'password', value: settings.webdavPassword, onChange: (value) => set({ webdavPassword: value }) }),
                }),
                h(Row, {
                  title: runtime.t('sync.webdav.root'),
                  desc: runtime.t('sync.webdav.root.hint'),
                  control: h(TextField, { title: runtime.t('sync.webdav.root'), value: settings.webdavRoot, placeholder: '/我的坚果云/DSH-Sync', onChange: (value) => set({ webdavRoot: value }) }),
                }),
                h(Row, {
                  title: runtime.t('sync.webdav.mirror'),
                  desc: state.sync.target !== null && state.sync.target.usage !== null && state.sync.target.usage !== undefined
                    ? runtime.t('sync.webdav.mirror.usage', { size: formatSize(state.sync.target.usage.bytes), files: state.sync.target.usage.files })
                    : undefined,
                  control: h(TextField, { title: runtime.t('sync.webdav.mirror'), value: settings.mirrorDir, onChange: (value) => set({ mirrorDir: value }) }),
                }),
                h(Row, {
                  title: runtime.t('sync.webdav.autoCreate'),
                  desc: runtime.t('sync.webdav.autoCreate.desc'),
                  control: h(Switch, { label: runtime.t('sync.webdav.autoCreate'), checked: settings.webdavAutoCreate, onChange: (value) => set({ webdavAutoCreate: value }) }),
                }),
                h(Row, {
                  title: runtime.t('sync.webdav.test'),
                  desc: state.sync.webdav === null
                    ? undefined
                    : (state.sync.webdav.ok === true
                      ? runtime.t('sync.webdav.ok', { message: state.sync.webdav.message })
                      : runtime.t('sync.webdav.fail', { message: state.sync.webdav.message })),
                  control: h('button', {
                    type: 'button',
                    className: 'dshe-action',
                    disabled: state.sync.webdavBusy === true,
                    onClick: () => runtime.store.testWebdav(),
                  }, state.sync.webdavBusy === true ? runtime.t('sync.webdav.testing') : runtime.t('sync.webdav.test')),
                }),
              )
            : h(Row, {
                title: runtime.t('sync.dir'),
                control: h(TextField, { title: runtime.t('sync.dir'), value: syncDirValue, placeholder: 'D:\\Synced\\DSH', onChange: (value) => set({ syncDir: value }) }),
              }),
          h(Row, {
            title: runtime.t('sync.machine'),
            desc: runtime.t('sync.machine.hint'),
            control: h(TextField, {
              title: runtime.t('sync.machine'),
              value: settings.syncMachineId,
              placeholder: state.sync.target === null || state.sync.target.machineId === undefined
                ? ''
                : runtime.t('sync.machine.placeholder', { id: state.sync.target.machineId }),
              onChange: (value) => set({ syncMachineId: value }),
            }),
          }),
          h(Row, {
            title: runtime.t('sync.attachments'),
            control: h(Switch, { label: runtime.t('sync.attachments'), checked: settings.syncSkipAttachments !== true, onChange: (value) => set({ syncSkipAttachments: !value }) }),
          }),
          h(Row, {
            title: runtime.t('sync.idle'),
            desc: runtime.t('sync.idle.desc'),
            control: h(Switch, { label: runtime.t('sync.idle'), checked: settings.syncOnIdle, onChange: (value) => set({ syncOnIdle: value }) }),
          }),
          h(Row, {
            title: runtime.t('sync.interval'),
            desc: runtime.t('sync.interval.hint'),
            control: h(NumberField, { label: runtime.t('sync.interval'), value: settings.syncIntervalMinutes, min: 0, max: 1440, onChange: (value) => set({ syncIntervalMinutes: value }) }),
          }),
          h(Row, {
            title: runtime.t('sync.daily'),
            desc: runtime.t('sync.daily.hint'),
            control: h(TextField, { title: runtime.t('sync.daily'), value: settings.syncDailyAt, placeholder: 'HH:MM', onChange: (value) => set({ syncDailyAt: value }) }),
          }),
          h(Row, {
            title: runtime.t('sync.cooldown'),
            control: h(NumberField, { label: runtime.t('sync.cooldown'), value: settings.syncCooldownMinutes, min: 1, max: 240, onChange: (value) => set({ syncCooldownMinutes: value }) }),
          }),
        ),
        h('div', { className: 'dshe-section' },
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              className: 'dshe-action',
              disabled: state.sync.busy === true,
              onClick: () => runtime.store.runSyncNow(),
            }, runtime.t('sync.run')),
            h('button', {
              type: 'button',
              className: 'dshe-action',
              disabled: state.sync.busy === true,
              onClick: () => runtime.store.openOverwrite('cloud'),
            }, runtime.t('overwrite.cloud')),
            h('button', {
              type: 'button',
              className: 'dshe-action',
              disabled: state.sync.busy === true,
              onClick: () => runtime.store.openOverwrite('local'),
            }, runtime.t('overwrite.local')),
            h('button', {
              type: 'button',
              className: 'dshe-action',
              onClick: () => runtime.store.toggleSyncLog(),
            }, state.sync.showLog === true ? runtime.t('sync.logHide') : runtime.t('sync.log')),
            h('button', {
              type: 'button',
              className: 'dshe-action',
              disabled: state.envCheck.busy === true,
              onClick: () => runtime.store.runEnvCheck(),
            }, state.envCheck.busy === true ? runtime.t('env.busy') : runtime.t('env.button')),
            h('button', {
              type: 'button',
              className: 'dshe-action',
              title: runtime.t('restart.hint'),
              onClick: () => runtime.store.openRestart(),
            }, runtime.t('restart.button')),
          ),
          state.sync.showLog === true ? null : h('button', {
            type: 'button',
            className: 'dshe-row-desc dshe-log-toggle',
            title: runtime.t('sync.logToggle'),
            onClick: () => runtime.store.toggleSyncLog(),
          }, syncStatusLine(state, settings)),
          effectiveDir === ''
            ? h('div', { className: 'dshe-row-desc dshe-error' }, runtime.t(settings.syncMode === 'webdav' ? 'sync.needMirror' : 'sync.needDir'))
            : null,
          state.sync.target !== null
            && settings.syncMode !== 'webdav'
            && state.sync.target.syncDirConfigured === true
            && state.sync.target.syncDirExists === false
            ? h('div', { className: 'dshe-row-desc dshe-error' }, runtime.t('sync.dirMissing', { path: state.sync.target.syncDir }))
            : null,
          state.sync.error === null
            ? null
            : h('div', { className: 'dshe-row-desc dshe-error', role: 'alert' }, String(state.sync.error)),
          state.sync.showLog === true
            ? h('div', {},
                h('div', { className: 'dshe-row-desc' }, runtime.t('sync.historyCount', { n: logEntries(state).length })),
                h('div', { className: 'dshe-log-list dshe-log-scroll' },
                  logEntries(state).slice(0, Number(state.sync.historyLimit) || 5).map((item, index) => {
                    const open = state.sync.historyOpen === index;
                    return h('div', { key: item.at ?? String(index), className: 'dshe-log-item' },
                      h('button', {
                        type: 'button',
                        className: `dshe-log-row${open ? ' dshe-log-row-open' : ''}`,
                        onClick: () => runtime.store.openHistory(index),
                      },
                      h('span', {}, historyLine(item.entry)),
                      h('span', { className: 'dshe-log-caret' }, open ? '▾' : '▸')),
                      open ? h('div', { className: 'dshe-sync-log dshe-log-body' }, (item.log ?? []).map((line, lineIndex) => h(LogLine, { key: lineIndex, line, files: item.details?.[lineIndex] ?? [] }))) : null);
                  }),
                ),
                logEntries(state).length > (Number(state.sync.historyLimit) || 5)
                  ? h('button', { type: 'button', className: 'dshe-action', onClick: () => runtime.store.showMoreHistory() }, runtime.t('sync.more'))
                  : null,
              )
            : null,
        ),
      );
    }

    /** One log line: label column justified, rest flows normally. */
    function LogLine(props) {
      const [open, setOpen] = React.useState(false);
      const files = Array.isArray(props.files) ? props.files : [];
      const raw = String(props.line ?? '');
      const indent = raw.length - raw.trimStart().length;
      const text = raw.trimStart();
      const cut = text.indexOf('：');
      if (cut <= 0) {
        return h('div', { key: props.key, className: 'dshe-log-line dshe-log-line-plain' }, text);
      }
      const sub = indent > 0;
      const detail = files.length === 0
        ? null
        : h('div', { className: 'dshe-log-files' }, files.slice(0, 200).map((file, index) => h('div', { key: index, className: 'dshe-log-file' }, file)));
      return h('div', { key: props.key, className: 'dshe-log-entry' },
        h('div', {
          className: `dshe-log-line${sub ? ' dshe-log-line-sub' : ''}${files.length > 0 ? ' dshe-log-line-more' : ''}`,
          title: files.length === 0 ? undefined : files.slice(0, 15).join('\n') + (files.length > 15 ? `\n…共 ${String(files.length)} 项` : ''),
          onClick: files.length === 0 ? undefined : () => setOpen((value) => !value),
        },
        h('span', { className: 'dshe-log-label' }, text.slice(0, cut)),
        h('span', { className: 'dshe-log-colon' }, '：'),
        h('span', { className: 'dshe-log-text' }, text.slice(cut + 1)),
        files.length === 0 ? null : h('span', { className: 'dshe-log-more' }, open ? '▾' : '▸')),
        open && detail !== null ? detail : null);
    }

    /** Outline trash glyph used in the counter line (inherits text colour). */
    function TrashIcon() {
      return h('svg', {
        width: 12,
        height: 12,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { verticalAlign: '-2px', margin: '0 1px' },
      },
      h('path', { d: 'M4 7h16' }),
      h('path', { d: 'M9 7V5h6v2' }),
      h('path', { d: 'M18 7l-1 13H7L6 7' }),
      h('path', { d: 'M10 11v6' }),
      h('path', { d: 'M14 11v6' }));
    }

    /** ↑ pushed · ↓ pulled · 🗑 deleted, with the icon drawn as SVG. */
    function countsNode(up, down, deleted, details) {
      const tip = (list, label) => {
        if (!Array.isArray(list) || list.length === 0) return undefined;
        const head = list.slice(0, 15).join('\n');
        return list.length > 15 ? `${label}\n${head}\n…共 ${String(list.length)} 项` : `${label}\n${head}`;
      };
      return h('span', { className: 'dshe-counts' },
        h('span', { title: tip(details?.up, '上传') }, `⬆ ${String(Number(up) || 0)}`),
        ' · ',
        h('span', { title: tip(details?.down, '下载') }, `⬇ ${String(Number(down) || 0)}`),
        ' · ',
        h(TrashIcon, {}),
        h('span', { title: tip(details?.del, '删除') }, ` ${String(Number(deleted) || 0)}`));
    }

    /** Latest run first, then the stored history, each with its own log slice. */
    function logEntries(state) {
      const list = [];
      const current = state.sync.state;
      const history = Array.isArray(state.sync.history) ? state.sync.history : [];
      const detailOf = (...candidates) => {
        for (const candidate of candidates) {
          if (Array.isArray(candidate?.details)) return candidate.details;
        }
        return [];
      };
      if (current !== null && current !== undefined) {
        const same = history[0] !== undefined && history[0].at === current.at;
        list.push({
          at: current.at,
          entry: same ? { ...current, ...history[0] } : current,
          log: Array.isArray(current.log) ? current.log : [],
          details: detailOf(current, history[0]),
        });
      }
      for (const item of history) {
        if (list.length > 0 && item.at === list[0].at) continue;
        list.push({ at: item.at, entry: item, log: Array.isArray(item.log) ? item.log : [], details: detailOf(item) });
      }
      return list;
    }

    /** One compact line for one stored run. */
    function historyLine(item) {
      const when = typeof item.at === 'string' ? new Date(item.at).toLocaleString() : '';
      const result = item.ok === true ? runtime.t('sync.result.ok') : runtime.t('sync.result.fail');
      const up = Number(item.counts?.up ?? item.pushed ?? item.uploaded ?? 0) || 0;
      const down = Number(item.counts?.down ?? item.pulled ?? item.downloaded ?? 0) || 0;
      const del = Number(item.counts?.del ?? item.deleted ?? 0) || 0;
      const failed = Number(item.failed) > 0 ? ` · ✗${String(item.failed)}` : '';
      const label = typeof item.targetLabel === 'string' && item.targetLabel !== '' ? `${item.targetLabel} · ` : '';
      return h('span', {}, `${when} · ${result} · ${label}${String(Number(item.durationMs) || 0)} ms · `, countsNode(up, down, del, item.countDetails), failed);
    }


    /** Width of the settings panel this page is rendered in, for relative sizing. */
    function measureSettingsPanel() {
      let node = document.querySelector('.dshe-section');
      while (node !== null && node !== document.body) {
        const width = node.getBoundingClientRect().width;
        if (width > 600) return Math.round(width);
        node = node.parentElement;
      }
      return 0;
    }


    function syncStatusLine(state, settings) {
      const record = state.sync.state;
      if (record === null || record === undefined) return runtime.t('sync.never');
      const when = typeof record.at === 'string' ? new Date(record.at).toLocaleString() : '';
      const base = runtime.t('sync.last', {
        time: when,
        result: record.ok === true ? runtime.t('sync.result.ok') : runtime.t('sync.result.fail'),
        ms: Number(record.durationMs) || 0,
      });
      // One shape everywhere: ↑ pushed · ↓ pulled · 🗑 deleted.
      const pushed = record.counts?.up ?? record.summary?.sessions?.pushed ?? record.transport?.pushed?.uploaded ?? 0;
      const pulled = record.counts?.down ?? record.summary?.sessions?.pulled ?? record.transport?.pulled?.downloaded ?? 0;
      const removed = record.counts?.del ?? record.transport?.pushed?.deleted ?? record.summary?.prune?.sharedDeleted ?? 0;

      const transport = record.transport;
      const extras = [];
      if (Number(record.trashPurged) > 0) extras.push(runtime.t('sync.purged', { n: Number(record.trashPurged) }));
      const paths = record.summary?.paths;
      if (paths !== null && paths !== undefined && (Number(paths.created) > 0 || Number(paths.failed) > 0)) {
        extras.push(runtime.t('sync.paths', { created: Number(paths.created) || 0, failed: Number(paths.failed) || 0 }));
      }
      const failures = (record.transport?.pushed?.failed?.length ?? 0) + (record.transport?.pulled?.failed?.length ?? 0);
      if (failures > 0) extras.push(runtime.t('sync.failed', { n: failures }));
      const tail = extras.length === 0 ? '' : ` · ${extras.join(' · ')}`;
      const skipped = transport?.pushed?.deleteSkipped;
      const note = typeof skipped === 'string' && skipped !== '' ? ` · ${skipped}` : '';
      return h('span', {}, `${base} · 传输：`, countsNode(pushed, pulled, removed, record.countDetails), `${tail}${note}`);
    }

    // ── toast ────────────────────────────────────────────────────────────────

    /**
     * Writes the toast straight into <body>.
     *
     * The overlay slot sits inside the settings dialog's stacking context, so a
     * fixed child still renders under that dialog. Appending to body escapes it.
     */
    function Toasts() {
      const state = useStore();
      const toast = state.toast;
      React.useEffect(() => {
        let host = document.getElementById('dshe-toast-host');
        if (host === null) {
          host = document.createElement('div');
          host.id = 'dshe-toast-host';
          host.style.cssText = 'position:fixed;left:0;right:0;bottom:28px;display:flex;justify-content:center;pointer-events:none;z-index:2147483000';
          document.body.appendChild(host);
        }
        host.textContent = '';
        if (toast === null || toast === undefined) return;
        const node = document.createElement('div');
        node.className = 'dshe-toast';
        node.dataset.kind = String(toast.kind ?? 'info');
        node.setAttribute('role', toast.kind === 'error' ? 'alert' : 'status');
        node.style.position = 'static';
        node.style.transform = 'none';
        node.style.left = 'auto';
        node.style.bottom = 'auto';
        node.textContent = String(toast.text ?? '');
        host.appendChild(node);
      }, [toast]);
      return null;
    }

    /** Environment check result, including the "export report" path. */
    function EnvDialog() {
      const state = useStore();
      if (state.envCheck.open !== true) return null;
      if (primitives?.Modal === undefined) return null;
      const result = state.envCheck.result;
      const busy = state.envCheck.busy === true;
      const close = () => runtime.store.closeEnvCheck();
      if (busy) {
        return h(primitives.Modal, { open: true, onClose: close, closeLabel: runtime.t('common.close'), title: runtime.t('env.title') },
          h('p', { className: 'dshe-section-desc' }, runtime.t('env.busy')));
      }
      if (result?.ok === true) {
        return h(primitives.Modal, { open: true, onClose: close, closeLabel: runtime.t('common.close'), title: runtime.t('env.title') },
          h('p', { className: 'dshe-section-desc' }, runtime.t('env.ok')),
          h('div', { className: 'dshe-row-desc' }, runtime.t('env.versionLine', { app: result.appVersion ?? '未知', plugin: result.pluginVersion })));
      }
      const rows = (result?.checks ?? []).filter((item) => item.ok !== true);
      return h(primitives.Modal, {
        open: true,
        onClose: close,
        closeLabel: runtime.t('common.close'),
        title: runtime.t('env.title'),
        footer: h(React.Fragment, {},
          h('button', { type: 'button', className: 'dshe-action', onClick: close }, runtime.t('common.cancel')),
          h('button', { type: 'button', className: 'dshe-action dshe-action-danger', onClick: () => runtime.store.writeEnvReport() }, runtime.t('env.report'))),
      },
      h('p', { className: 'dshe-section-desc' }, runtime.t('env.risk', { n: Number(result?.failedCount) || rows.length })),
      h('div', { className: 'dshe-log-body' }, rows.slice(0, 12).map((item, index) => h('div', { key: index, className: 'dshe-log-line' },
        h('span', { className: 'dshe-log-label' }, item.label),
        h('span', { className: 'dshe-log-colon' }, '：'),
        h('span', { className: 'dshe-log-text' }, String(item.detail ?? ''))))));
    }

    /** Confirm an application restart (a running turn would be interrupted). */
    function RestartDialog() {
      const state = useStore();
      if (state.restartConfirm !== true) return null;
      if (primitives?.Modal === undefined) return null;
      return h(primitives.Modal, {
        open: true,
        onClose: () => runtime.store.closeRestart(),
        closeLabel: runtime.t('common.close'),
        title: runtime.t('restart.button'),
        footer: h(React.Fragment, {},
          h('button', { type: 'button', className: 'dshe-action', onClick: () => runtime.store.closeRestart() }, runtime.t('common.cancel')),
          h('button', { type: 'button', className: 'dshe-action dshe-action-danger', onClick: () => runtime.store.confirmRestart() }, runtime.t('restart.confirm'))),
      },
      h('p', { className: 'dshe-section-desc' }, runtime.t('restart.desc')));
    }

    /** Pick which saved setup a new one replaces when all three slots are taken. */
    function PresetReplaceDialog() {
      const state = useStore();
      if (state.presetReplace === null || state.presetReplace.open !== true) return null;
      if (primitives?.Modal === undefined) return null;
      const presets = Array.isArray(state.settings.webdavProfiles) ? state.settings.webdavProfiles : [];
      return h(primitives.Modal, {
        open: true,
        onClose: () => runtime.store.closePresetReplace(),
        closeLabel: runtime.t('common.close'),
        title: runtime.t('sync.webdav.presets.replaceTitle'),
        footer: h(React.Fragment, {},
          h('button', { type: 'button', className: 'dshe-action', onClick: () => runtime.store.closePresetReplace() }, runtime.t('common.cancel'))),
      },
      h('p', { className: 'dshe-section-desc' }, runtime.t('sync.webdav.presets.replaceDesc')),
      h('div', { className: 'dshe-presets-chips' },
        presets.map((item) => h('button', {
          key: item.id,
          type: 'button',
          className: 'dshe-action dshe-action-danger',
          onClick: () => runtime.store.confirmPresetReplace(item.id),
        }, item.name))));
    }

    /** Confirm a one-way overwrite of the cloud or of this machine. */
    function OverwriteDialog() {
      const state = useStore();
      const overwrite = state.overwrite;
      if (overwrite.open !== true) return null;
      if (primitives?.Modal === undefined) return null;
      const toCloud = overwrite.direction === 'cloud';
      const away = toCloud ? runtime.t('overwrite.awayCloud') : runtime.t('overwrite.awayLocal');
      return h(primitives.Modal, {
        open: true,
        onClose: () => runtime.store.closeOverwrite(),
        closeLabel: runtime.t('common.close'),
        title: toCloud ? runtime.t('overwrite.cloud') : runtime.t('overwrite.local'),
        footer: h(React.Fragment, {},
          h('button', { type: 'button', className: 'dshe-action', onClick: () => runtime.store.closeOverwrite() }, runtime.t('common.cancel')),
          h('button', {
            type: 'button',
            className: 'dshe-action dshe-action-danger',
            disabled: overwrite.busy === true,
            onClick: () => runtime.store.confirmOverwrite(),
          }, overwrite.busy === true ? runtime.t('overwrite.running') : runtime.t('overwrite.confirm'))),
      },
      h('p', { className: 'dshe-section-desc' }, away),
      overwrite.error === null
        ? null
        : h('div', { className: 'dshe-row-desc dshe-error', role: 'alert' }, overwrite.error));
    }

    /** Shown when automatic sync paused after repeated failures. */
    function PauseDialog() {
      const state = useStore();
      if (state.pauseOpen !== true) return null;
      if (primitives?.Modal === undefined) return null;
      const auto = state.sync.auto;
      const last = state.sync.state?.diagnosis;
      return h(primitives.Modal, {
        open: true,
        onClose: () => runtime.store.dismissPauseNotice(),
        closeLabel: runtime.t('common.close'),
        title: runtime.t('pause.title'),
        footer: h(React.Fragment, {},
          h('button', { type: 'button', className: 'dshe-action', onClick: () => runtime.store.dismissPauseNotice() }, runtime.t('common.close')),
          h('button', { type: 'button', className: 'dshe-action dshe-action-active', onClick: () => runtime.store.resumeAutoSync() }, runtime.t('pause.resume'))),
      },
      h('p', { className: 'dshe-section-desc' }, runtime.t('pause.desc', { n: Number(auto?.failures) || 0 })),
      last === null || last === undefined
        ? null
        : h('div', { className: 'dshe-row-desc' }, runtime.t('pause.last', { summary: last.summary, hint: last.hint })));
    }

    /** Shown once when the host application version changed since the last run. */
    function UpdateDialog() {
      const state = useStore();
      if (state.updatePrompt.open !== true) return null;
      if (primitives?.Modal === undefined) return null;
      return h(primitives.Modal, {
        open: true,
        onClose: () => runtime.store.dismissUpdatePrompt(),
        closeLabel: runtime.t('common.close'),
        title: runtime.t('env.update.title'),
        footer: h(React.Fragment, {},
          h('button', { type: 'button', className: 'dshe-action', onClick: () => runtime.store.dismissUpdatePrompt() }, runtime.t('env.update.no')),
          h('button', { type: 'button', className: 'dshe-action dshe-action-active', onClick: () => runtime.store.acceptUpdatePrompt() }, runtime.t('env.update.yes'))),
      },
      h('p', { className: 'dshe-section-desc' }, runtime.t('env.update.desc', {
        app: state.updatePrompt.appVersion ?? '',
        last: state.updatePrompt.lastAppVersion ?? '',
      })));
    }

    function OverlayStack() {
      return h(React.Fragment, {}, h(DeleteDialog, {}), h(MoveDialog, {}), h(TrashDialog, {}), h(EnvDialog, {}), h(UpdateDialog, {}), h(PauseDialog, {}), h(OverwriteDialog, {}), h(RestartDialog, {}), h(PresetReplaceDialog, {}), h(Toasts, {}));
    }

    // ── plugin ───────────────────────────────────────────────────────────────

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        const store = createStore();
        runtime.store = store;
        const t = ctx.locale.bind(NS);
        runtime.t = t;
        runtime.openSession = (sessionId) => {
          try {
            ctx.uiWorkspace.openSession(sessionId);
          } catch (error) {
            console.warn('[dsh-enhanced] opening the session failed:', error);
          }
        };
        /**
         * Reconnect a workspace so its session list is rebuilt by the host.
         * Reloading the page cannot be used here: a reload right after a data
         * change makes the next boot fail to import this plugin's entry.
         */
        runtime.refreshWorkspace = async (workspaceId) => {
          if (typeof workspaceId !== 'string' || workspaceId === '') return;
          try {
            await ctx.uiWorkspace.openWorkspace(workspaceId);
          } catch (error) {
            console.warn('[dsh-enhanced] refreshing the workspace failed:', error);
          }
        };
        const normalizeAnchor = (text) => (typeof text === 'string'
          ? text.replace(/[`*_#>~[\]()]/g, ' ').replace(/…/g, ' ').replace(/\s+/g, ' ').trim()
          : '');

        runtime.jumpToAnchor = (options) => {
          const needleQuery = normalizeAnchor(options?.query);
          const needleSnippet = normalizeAnchor(options?.snippet);
          const turn = Number.isInteger(options?.turn) ? options.turn : null;
          const candidates = [];
          for (const source of [needleSnippet, needleQuery]) {
            if (source === '') continue;
            for (const size of [36, 24, 16, 10]) {
              if (source.length < size && source !== needleQuery) continue;
              const value = source.length > size ? source.slice(0, size) : source;
              if (value !== '' && !candidates.includes(value)) candidates.push(value);
            }
          }
          if (candidates.length === 0) return;
          let attempts = 0;
          const tick = () => {
            attempts += 1;
            const flow = document.querySelector('[data-chat-flow]');
            if (flow !== null) {
              const nodes = turn === null
                ? flow.querySelectorAll('[data-chat-flow-key]')
                : (() => {
                    const scoped = flow.querySelectorAll(`[data-chat-turn="${String(turn)}"]`);
                    return scoped.length > 0 ? scoped : flow.querySelectorAll('[data-chat-flow-key]');
                  })();
              for (const needle of candidates) {
                for (const node of nodes) {
                  const text = normalizeAnchor(node.textContent ?? '');
                  if (text.includes(needle)) {
                    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    return;
                  }
                }
              }
            }
            if (attempts < 25) window.setTimeout(tick, 140);
            else runtime.store.toast('info', runtime.t('search.notLocated'));
          };
          window.setTimeout(tick, 60);
        };

        runtime.focusMatch = async (sessionId, match, query) => {
          let turn = null;
          if (match !== null && match !== undefined && Number.isInteger(match.seq)) {
            try {
              const data = await runtime.rpc('locate.event', { sessionId, seq: match.seq });
              if (Number.isInteger(data?.turn)) turn = data.turn;
            } catch (error) {
              console.warn('[dsh-enhanced] locating the event failed:', error);
            }
          }
          runtime.jumpToAnchor({ snippet: match?.snippet ?? '', query, turn });
        };
        runtime.rpc = async (action, payload, signal) => {
          const url = new URL('api/dsh-enhanced/rpc', document.baseURI);
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            signal,
            body: JSON.stringify({ action, ...(payload ?? {}) }),
          });
          if (!response.ok) throw new Error(`请求失败（HTTP ${String(response.status)}）`);
          const body = await response.json();
          if (body === null || typeof body !== 'object' || body.ok !== true) {
            throw new Error(body?.error?.message ?? '请求失败');
          }
          return body.data;
        };

        ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-enhanced: dictionaries');

        ctx.effect(() => {
          const id = '@xsok/dsh-enhanced/styles';
          if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return () => {};
          const tag = document.createElement('style');
          tag.dataset.plugin = '@xsok/dsh-enhanced';
          tag.dataset.pluginCss = id;
          tag.textContent = STYLES;
          document.head.appendChild(tag);
          return () => tag.remove();
        }, 'dsh-enhanced: styles');

        ctx.effect(() => {
          const onKeyDown = (event) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
            if (event.key !== 'f' && event.key !== 'F') return;
            if (runtime.store.get().settings.searchEnabled !== true) return;
            event.preventDefault();
            event.stopPropagation();
            runtime.store.openSearch();
          };
          window.addEventListener('keydown', onKeyDown, true);
          return () => window.removeEventListener('keydown', onKeyDown, true);
        }, 'dsh-enhanced: ctrl+f');


        ctx.effect(() => {
          const onKeyDown = (event) => {
            if (event.ctrlKey !== true || event.shiftKey !== true || event.altKey !== true) return;
            if (String(event.key).toLowerCase() !== 'r') return;
            event.preventDefault();
            event.stopPropagation();
            if (runtime.store.get().restartConfirm !== true) runtime.store.openRestart();
          };
          window.addEventListener('keydown', onKeyDown, true);
          return () => window.removeEventListener('keydown', onKeyDown, true);
        }, 'dsh-enhanced: restart shortcut');

        ctx.effect(() => {
          // Prefetch distance from the top of the loaded history, in pixels.
          const PREFETCH_PX = 800;
          // Do not stack requests closer than this, so one flick loads one page.
          const MIN_GAP_MS = 120;
          let cachedScroller = null;
          let loading = null;
          let scheduled = null;
          let lastStartAt = 0;

          const flowNode = () => document.querySelector('[data-chat-flow]');

          const followingTail = () => document.querySelector('[data-chat-following-tail]') !== null;

          const scrollerFor = () => {
            if (cachedScroller !== null && cachedScroller.isConnected === true) return cachedScroller;
            cachedScroller = null;
            const node = flowNode();
            if (node !== null) {
              let current = node.parentElement;
              while (current !== null && current !== document.body) {
                const style = window.getComputedStyle(current);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && current.scrollHeight > current.clientHeight + 4) {
                  cachedScroller = current;
                  return current;
                }
                current = current.parentElement;
              }
            }
            const doc = document.scrollingElement;
            if (doc instanceof Element) cachedScroller = doc;
            return cachedScroller;
          };

          const findOlderButton = () => {
            for (const button of document.querySelectorAll('button')) {
              if (button.closest('[data-chat-flow-key]') !== null) continue;
              const parent = button.parentElement;
              const className = parent === null ? '' : String(parent.className ?? '');
              const label = (button.textContent ?? '').trim();
              if (/(?:^|_)older(?:_|$)/u.test(className) || label === 'Load earlier' || label.startsWith('加载更早')) return button;
            }
            return null;
          };

          const scrollHeightOf = (scroller) => (scroller === null ? 0 : scroller.scrollHeight);

          /**
           * Load one page without moving the viewport.
           *
           * The click inserts content above; the reader keeps the same messages on
           * screen because scrollTop grows by exactly the height that was added.
           */
          const loadPage = () => {
            if (loading !== null) return;
            if (Date.now() - lastStartAt < MIN_GAP_MS) return;
            if (runtime.store.get().settings.autoLoadEnabled !== true) return;
            if (followingTail()) return;
            const button = findOlderButton();
            if (button === null || button.disabled === true) return;

            const scroller = scrollerFor();
            if (scroller === null) return;
            const before = { height: scroller.scrollHeight, top: scroller.scrollTop };

            loading = { height: before.height, top: before.top, at: Date.now() };
            lastStartAt = Date.now();
            try {
              button.blur();
            } catch {
              // A button without focus support is fine.
            }
            button.click();

            const settle = () => {
              if (loading === null) return;
              const heightNow = scroller.scrollHeight;
              const grown = heightNow - before.height;
              const elapsed = Date.now() - loading.at;
              if (grown <= 0 && elapsed < 8000) {
                window.setTimeout(settle, 100);
                return;
              }
              // The browser may already have anchored the view; only correct when it
              // did not, or the two compensations would add up into a jump.
              const moved = Math.abs(scroller.scrollTop - before.top) > 4;
              if (grown > 0 && !moved) scroller.scrollTop = before.top + grown;
              loading = null;
              // Chain straight into the next page while the reader is still near the top.
              schedule(80);
            };
            window.setTimeout(settle, 100);
          };

          const schedule = (delay) => {
            if (scheduled !== null) window.clearTimeout(scheduled);
            scheduled = window.setTimeout(() => {
              scheduled = null;
              const scroller = scrollerFor();
              if (scroller === null) return;
              if (scroller.scrollTop > PREFETCH_PX) return;
              loadPage();
            }, delay);
          };

          let framePending = false;
          let lastTop = null;
          const onScroll = () => {
            if (framePending) return;
            framePending = true;
            window.requestAnimationFrame(() => {
              framePending = false;
              if (runtime.store.get().settings.autoLoadEnabled !== true) return;
              if (followingTail()) return;
              const scroller = scrollerFor();
              if (scroller === null) return;
              const top = scroller.scrollTop;
              const goingUp = lastTop !== null && top < lastTop - 2;
              lastTop = top;
              if (!goingUp) return;
              if (top > PREFETCH_PX) return;
              loadPage();
            });
          };

          const onWheel = (event) => {
            if (event.deltaY >= 0) return;
            const scroller = scrollerFor();
            if (scroller === null) return;
            if (scroller.scrollTop > PREFETCH_PX) return;
            schedule(0);
          };

          window.addEventListener('scroll', onScroll, { capture: true, passive: true });
          window.addEventListener('wheel', onWheel, { capture: true, passive: true });
          return () => {
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('wheel', onWheel, true);
            if (scheduled !== null) window.clearTimeout(scheduled);
          };
        }, 'dsh-enhanced: auto load earlier');

        ctx.effect(() => {
          let pending = null;
          try {
            pending = window.sessionStorage.getItem('dsh-enhanced.pendingOpen');
            if (pending !== null) window.sessionStorage.removeItem('dsh-enhanced.pendingOpen');
          } catch {
            pending = null;
          }
          if (pending === null || pending === '') return () => {};
          const openWhenReady = (attempt) => {
            try {
              runtime.openSession(pending);
            } catch {
              if (attempt < 4) window.setTimeout(() => openWhenReady(attempt + 1), 500);
            }
          };
          const timer = window.setTimeout(() => openWhenReady(0), 800);
          return () => window.clearTimeout(timer);
        }, 'dsh-enhanced: open session after reload');


        ctx.effect(() => {
          runtime.store.init();
          return () => {};
        }, 'dsh-enhanced: initial state');

        ctx.effect(() => {
          const timer = setTimeout(() => { void runtime.store.checkAppVersion(); }, 1500);
          return () => clearTimeout(timer);
        }, 'dsh-enhanced: app version probe');

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-enhanced.delete-session',
          order: 500,
          locale: NS,
        }, SessionDeleteRow));

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-enhanced.trash-for-session',
          order: 510,
          locale: NS,
        }, SessionTrashRow));

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-enhanced.move-session',
          order: 520,
          locale: NS,
        }, SessionMoveRow));


        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-enhanced.search',
          order: 900,
          locale: NS,
        }, SearchOverlay));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-enhanced.dialogs',
          order: 910,
          locale: NS,
        }, OverlayStack));

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-enhanced.composer-bridge',
          order: 1000,
          locale: NS,
        }, ComposerBridge));

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-enhanced',
          order: 30,
          label: () => runtime.t('nav.title'),
          locale: NS,
        }, SettingsSection));
      },
    };
  },
});
