/**
 * One-way overrides: replace the cloud with this machine's data, or this machine
 * with the cloud's data. No merge runs in either direction.
 *
 * The two commands still keep the coordination files working: after the copy the
 * per-machine snapshot describes what this machine now holds, and both deletion
 * ledgers are reset, so the next ordinary sync does not replay stale deletions.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { mergeWorkspaceDocuments } from './engine/workspace.js';
import { readLedger, writeJsonAtomic, writeLedger, SESSION_LEDGER, WORKSPACE_LEDGER } from './engine/ledger.js';
import { projectKey } from './engine/scan.js';
import { readSessionFile, rewriteCwd, writeSessionFile } from './engine/session.js';
import { pullMirror, pushMirror } from './mirror.js';
import { listRemoteTree, deleteRemoteFile } from './webdav.js';

/** Areas that always mirror between this machine and the sync folder. */
function areas(paths, profile) {
  return [
    { from: path.join(paths.home, 'sessions'), to: 'sessions' },
    { from: path.join(paths.home, 'storages', 'session_projcache'), to: 'config/storages/session_projcache' },
    { from: path.join(paths.home, 'storages', 'workspace.json'), to: 'config/storages/workspace.json', file: true },
    { from: path.join(paths.home, 'profiles', profile, 'cordis.patch.yml'), to: `config/profiles/${profile}/cordis.patch.yml`, file: true },
    { from: path.join(paths.home, 'skills'), to: 'config/skills' },
    { from: path.join(paths.home, 'AGENTS.md'), to: 'config/AGENTS.md', file: true },
    { from: path.join(paths.home, '.credentials.yaml'), to: 'config/.credentials.yaml', file: true },
    { from: path.join(paths.home, 'attachments', 'v1', 'objects'), to: 'attachments/v1/objects' },
    { from: path.join(paths.home, 'attachments', 'v1', 'file-objects'), to: 'attachments/v1/file-objects' },
    { from: path.join(paths.home, 'attachments', 'v1', 'files'), to: 'attachments/v1/files' },
    { from: paths.trashDir, to: 'trash' },
  ];
}

/** Copy one file or directory over the other side, replacing what was there. */
async function replaceFrom(source, target) {
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  let stat;
  try {
    stat = await fsp.stat(source);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    await fsp.cp(source, target, { recursive: true, force: true });
  } else {
    await fsp.copyFile(source, target);
    await fsp.utimes(target, stat.atimeMs / 1000, stat.mtimeMs / 1000).catch(() => {});
  }
  return true;
}

/** Every file the mirror holds, as relative paths. */
async function mirrorFiles(root) {
  const out = new Set();
  const walk = async (dir, prefix) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out.add(rel);
    }
  };
  await walk(root, '');
  return out;
}

/**
 * Delete remote files the mirror no longer holds, in paced batches.
 *
 * Pacing keeps a large removal under the provider's request-rate limit; a 503 is
 * retried by the transport itself, and anything still failing is reported so the
 * next run can finish the job.
 */
async function deleteRemoteExtras(settings, keep) {
  const tree = await listRemoteTree(settings);
  const files = tree.files instanceof Map ? [...tree.files.keys()] : [];
  const stale = files.filter((rel) => !keep.has(rel)).sort((a, b) => b.length - a.length);
  let deleted = 0;
  let failed = 0;
  for (let index = 0; index < stale.length; index += 1) {
    const done = await deleteRemoteFile(settings, stale[index]).catch(() => false);
    if (done) deleted += 1;
    else failed += 1;
    if ((index + 1) % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { deleted, failed, total: stale.length };
}

/** Write the per-machine snapshot and reset the ledgers for one side. */
async function resetState(paths, machineId, sessionsRoot, sharedStateDir) {
  const sessions = {};
  let dirs = [];
  try {
    dirs = await fsp.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    dirs = [];
  }
  for (const project of dirs) {
    if (!project.isDirectory()) continue;
    let ids = [];
    try {
      ids = await fsp.readdir(path.join(sessionsRoot, project.name), { withFileTypes: true });
    } catch {
      ids = [];
    }
    for (const session of ids) {
      if (!session.isDirectory()) continue;
      sessions[session.name] = project.name;
    }
  }
  const keys = {};
  for (const [id, project] of Object.entries(sessions)) {
    try {
      const dir = path.join(sessionsRoot, project, id);
      const file = (await fsp.readdir(dir)).find((name) => name.startsWith('session.v'));
      if (file === undefined) continue;
      const stat = await fsp.stat(path.join(dir, file));
      keys[id] = new Date(stat.mtimeMs).toISOString();
    } catch {
      // A session without a readable log simply stays out of the snapshot.
    }
  }
  await writeJsonAtomic(path.join(sharedStateDir, `machine-${machineId}.json`), {
    version: 1,
    machine: machineId,
    updatedAt: new Date().toISOString(),
    keys,
  });
  await writeLedger(sharedStateDir, SESSION_LEDGER, { version: 1, deleted: {} });
  await writeLedger(sharedStateDir, WORKSPACE_LEDGER, { version: 1, deleted: {} });
}

/** Local session paths to this machine when the target directory exists. */
async function localizeSessions(paths) {
  let rewritten = 0;
  let dirs = [];
  try {
    dirs = await fsp.readdir(path.join(paths.home, 'sessions'), { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const project of dirs) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(paths.home, 'sessions', project.name);
    let ids = [];
    try {
      ids = await fsp.readdir(projectDir, { withFileTypes: true });
    } catch {
      ids = [];
    }
    for (const session of ids) {
      if (!session.isDirectory()) continue;
      const dir = path.join(projectDir, session.name);
      const file = (await fsp.readdir(dir).catch(() => [])).find((name) => name.startsWith('session.v'));
      if (file === undefined) continue;
      const source = path.join(dir, file);
      let parsed;
      try {
        parsed = await readSessionFile(source);
      } catch {
        continue;
      }
      const cwd = parsed.header.cwd;
      if (typeof cwd !== 'string' || cwd === '') continue;
      let exists = false;
      try {
        exists = (await fsp.stat(cwd)).isDirectory();
      } catch {
        exists = false;
      }
      if (!exists) continue;
      const key = projectKey(cwd);
      if (key === project.name) continue;
      const targetDir = path.join(paths.home, 'sessions', key, session.name);
      await fsp.mkdir(targetDir, { recursive: true });
      const stat = await fsp.stat(source);
      await writeSessionFile(path.join(targetDir, file), rewriteCwd(parsed, cwd).texts);
      await fsp.utimes(path.join(targetDir, file), stat.mtimeMs / 1000, stat.mtimeMs / 1000).catch(() => {});
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      rewritten += 1;
    }
  }
  return rewritten;
}

/**
 * Make the cloud identical to this machine.
 * @returns counters for the undo panel.
 */
export async function overwriteCloud(deps) {
  const { paths, settings, machineId, mirrorDir, apply = true, transport = 'webdav' } = deps;
  const profile = deps.profile ?? 'desktop';
  const sharedStateDir = path.join(mirrorDir, 'config', 'sync-state');
  const copied = [];

  for (const area of areas(paths, profile)) {
    const target = path.join(mirrorDir, ...area.to.split('/'));
    if (apply) {
      const done = await replaceFrom(area.from, target);
      if (done) copied.push(area.to);
    }
  }
  if (apply) await resetState(paths, machineId, path.join(paths.home, 'sessions'), sharedStateDir);

  let uploaded = 0;
  let deleted = 0;
  let failed = 0;
  if (apply && transport === 'webdav') {
    // Upload first: a failure here leaves the previous cloud content in place
    // instead of an empty folder. The prune below only removes what the mirror
    // does not hold.
    const result = await pushMirror({ settings });
    uploaded = result?.uploaded ?? 0;
    const keep = await mirrorFiles(mirrorDir);
    const pruned = await deleteRemoteExtras(settings, keep);
    deleted = pruned.deleted;
    failed = pruned.failed;
    if (failed > 0) {
      return {
        ok: false,
        direction: 'cloud',
        copied: copied.length,
        uploaded,
        deleted,
        failed,
        warning: `有 ${String(failed)} 个多余文件未能删除，可能被云端限流；稍后再次执行“覆盖云端”即可补齐。`,
      };
    }
  }
  return { ok: true, direction: 'cloud', copied: copied.length, uploaded, deleted };
}

/**
 * Make this machine identical to the cloud.
 * @returns counters for the undo panel.
 */
export async function overwriteLocal(deps) {
  const { paths, settings, machineId, mirrorDir, apply = true, transport = 'webdav' } = deps;
  const profile = deps.profile ?? 'desktop';
  const sharedStateDir = path.join(mirrorDir, 'config', 'sync-state');

  if (apply && transport === 'webdav') {
    // The mirror is only a cache: rebuild it from the cloud before copying back.
    await fsp.rm(mirrorDir, { recursive: true, force: true });
    await fsp.mkdir(mirrorDir, { recursive: true });
    await pullMirror({ settings });
  }

  const copied = [];
  for (const area of areas(paths, profile)) {
    const source = path.join(mirrorDir, ...area.to.split('/'));
    if (apply) {
      const done = await replaceFrom(source, area.from);
      if (done) copied.push(area.to);
    }
  }
  const localized = apply ? await localizeSessions(paths) : 0;
  if (apply) await resetState(paths, machineId, path.join(paths.home, 'sessions'), sharedStateDir);

  return { ok: true, direction: 'local', copied: copied.length, localized };
}

/** Counts for a preview: how many files each area holds right now. */
export async function inspectOverride(deps) {
  const { paths, mirrorDir } = deps;
  const profile = deps.profile ?? 'desktop';
  const rows = [];
  for (const area of areas(paths, profile)) {
    const localCount = await countFiles(area.from);
    const sharedCount = await countFiles(path.join(mirrorDir, ...area.to.split('/')));
    rows.push({ area: area.to, local: localCount, mirror: sharedCount });
  }
  return { areas: rows };
}

async function countFiles(target) {
  try {
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) return 1;
    let count = 0;
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name));
        else count += 1;
      }
    };
    await walk(target);
    return count;
  } catch {
    return 0;
  }
}
