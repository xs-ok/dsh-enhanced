/**
 * WebDAV mirror layer for DSH增强.
 *
 * The sync engine is filesystem-bound, so WebDAV mode needs a real local folder
 * that mirrors the share: pull remote changes into it, run the engine against it,
 * then push the differences back. This module starts with the read-only half —
 * a diff preview — so the comparison can be trusted before anything is uploaded.
 */
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  deleteEmptyRemoteDir,
  deleteRemoteFile,
  fetchRemoteFile,
  listRemoteTree,
  readRemoteManifest,
  uploadRemoteFile,
  writeRemoteManifest,
} from './webdav.js';

const IGNORED = new Set(['_sync-manifest.json']);
// Bookkeeping the engine rewrites every run: still transferred, never counted as
// user content on the settings page.
const INTERNAL_PREFIX = 'config/sync-state/';
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MTIME_TOLERANCE_MS = 2000;

function isInternal(rel) {
  return IGNORED.has(rel) || rel.startsWith(INTERNAL_PREFIX);
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Walk one local folder, keyed by the relative path with forward slashes. */
export async function scanLocalTree(root) {
  const files = new Map();
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(target, rel);
        continue;
      }
      try {
        const stat = await fsp.stat(target);
        files.set(rel, { size: stat.size, mtime: stat.mtimeMs });
      } catch {
        // A file that vanished mid-walk is simply absent.
      }
    }
  }
  await walk(root, '');
  return files;
}

function differs(remote, local) {
  if (remote.size !== local.size) return true;
  return Math.abs((remote.mtime || 0) - (local.mtime || 0)) > MTIME_TOLERANCE_MS;
}

function localPathFor(mirror, rel) {
  return path.join(mirror, ...rel.split('/'));
}

/** Bucket one relative path into the category shown in the log. */
function categoryOf(rel) {
  if (rel.startsWith('sessions/')) return 'sessions';
  if (rel.includes('session_projcache')) return 'titles';
  if (rel.startsWith('trash/')) return 'trash';
  if (rel.startsWith('attachments/')) return 'attachments';
  if (rel.startsWith('config/')) return 'config';
  return 'other';
}

/** Total size and file count of the mirror folder. */
export async function measureMirror(root) {
  const result = { bytes: 0, files: 0 };
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const stat = await fsp.stat(full);
        result.bytes += stat.size;
        result.files += 1;
      } catch {
        // A file that vanished mid-walk is simply absent.
      }
    }
  }
  await walk(root);
  return result;
}

/** Attachment objects are named after their own sha256. */
function isContentAddressed(rel) {
  return /^attachments\/v1\/objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/u.test(rel);
}

/** Content hash used to decide whether a file really changed. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Download remote files that the mirror is missing or holds in an older copy.
 * Read-only for the share: nothing is uploaded or deleted.
 */
/**
 * Pull using the remote manifest as the index instead of walking the whole tree.
 *
 * A full PROPFIND tour costs one request per folder (about 100 on a normal corpus,
 * several seconds). The manifest is written by every push from any machine and
 * carries size, mtime and hash per file, so comparing against it needs a single GET.
 * A periodic full scan still catches changes made outside the plugin.
 */
export async function pullMirrorFast(deps, signal) {
  const { settings } = deps;
  const mirror = requireMirror(settings);
  const manifest = await readRemoteManifest(settings, signal);
  const files = manifest !== null && manifest.json !== null && typeof manifest.json.files === 'object'
    ? manifest.json.files
    : null;
  if (files === null) return null;

  let downloaded = 0;
  let skipped = 0;
  let bytes = 0;
  const failed = [];
  const downloadedRels = [];

  for (const [rel, info] of Object.entries(files)) {
    if (IGNORED.has(rel)) continue;
    const target = localPathFor(mirror, rel);
    let local;
    try {
      local = await fsp.stat(target);
    } catch {
      local = undefined;
    }
    const size = Number(info?.size) || 0;
    const hash = typeof info?.hash === 'string' ? info.hash : '';
    if (local !== undefined && local.size === size && hash !== '') {
      try {
        if (sha256(await fsp.readFile(target)) === hash) {
          const authored = Number(info?.mtime) > 0 ? Number(info.mtime) : local.mtimeMs;
          if (Math.abs(authored - local.mtimeMs) > MTIME_TOLERANCE_MS) {
            await fsp.utimes(target, authored / 1000, authored / 1000).catch(() => {});
          }
          skipped += 1;
          continue;
        }
      } catch {
        // Unreadable local copy: download it.
      }
    }
    if (size > MAX_FILE_BYTES) {
      skipped += 1;
      failed.push(rel);
      continue;
    }
    let data;
    try {
      data = await fetchRemoteFile(settings, rel, signal);
    } catch (error) {
      failed.push({ path: rel, error: String(error?.message ?? error) });
      continue;
    }
    if (data === null) {
      failed.push({ path: rel, error: '服务器返回 404' });
      continue;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.pull-${String(process.pid)}`;
    await fsp.writeFile(temporary, data);
    await fsp.rm(target, { force: true }).catch(() => {});
    await fsp.rename(temporary, target);
    const authored = Number(info?.mtime) > 0 ? Number(info.mtime) : Date.now();
    await fsp.utimes(target, authored / 1000, authored / 1000).catch(() => {});
    downloaded += 1;
    if (!isInternal(rel)) {
      downloadedRels.push(rel);
      bytes += data.length;
    }
  }

  // Files the share no longer lists are gone from the mirror as well.
  const local = await scanLocalTree(mirror);
  let removed = 0;
  for (const rel of Object.keys(local)) {
    if (files[rel] !== undefined) continue;
    if (IGNORED.has(rel)) continue;
    try {
      await fsp.rm(path.join(mirror, ...rel.split('/')), { force: true });
      removed += 1;
    } catch {
      // A file that cannot be removed stays until the next full scan.
    }
  }

  return {
    ok: true,
    direction: 'pull',
    fast: true,
    downloaded,
    skipped,
    bytes,
    failed,
    removed,
    requested: 1,
    downloadedRels: downloadedRels.slice(0, 300),
  };
}

export async function pullMirror(deps, signal) {
  const { settings } = deps;
  const mirror = requireMirror(settings);
  const listed = await listRemoteTree(settings, signal);
  const manifest = await readRemoteManifest(settings, signal);
  const known = manifest !== null && manifest.json !== null && typeof manifest.json.files === 'object' ? manifest.json.files : {};
  let downloaded = 0;
  const downloadedRels = [];
  const categories = { sessions: 0, config: 0, titles: 0, trash: 0, attachments: 0, other: 0 };
  let skipped = 0;
  let bytes = 0;
  const failed = [];

  for (const [rel, info] of listed.files.entries()) {
    if (IGNORED.has(rel)) continue;
    const target = localPathFor(mirror, rel);
    let mine;
    try { mine = await fsp.stat(target); } catch { mine = undefined; }
    if (mine !== undefined && !differs(info, { size: mine.size, mtime: mine.mtimeMs })) {
      skipped += 1;
      continue;
    }
    // A rewritten server timestamp is not a content change: trust the manifest
    // hash before paying for a download.
    if (mine !== undefined && info.size === mine.size && isContentAddressed(rel)) {
      // attachments/v1/objects/<ab>/<sha256>: the file name is its own hash.
      try {
        if (sha256(await fsp.readFile(target)) === rel.split('/').pop()) {
          const authored = Number(known[rel]?.mtime) > 0 ? Number(known[rel].mtime) : info.mtime;
          if (authored > 0) await fsp.utimes(target, authored / 1000, authored / 1000).catch(() => {});
          skipped += 1;
          continue;
        }
      } catch {
        // Unreadable copy: fall through to the download.
      }
    }
    if (mine !== undefined && info.size === mine.size && typeof known[rel]?.hash === 'string') {
      try {
        if (sha256(await fsp.readFile(target)) === known[rel].hash) {
          // The recorded mtime is when the file was authored; the server one is
          // when it was uploaded. Trusting the server time makes every machine
          // look newer than the other one and causes endless re-downloads.
          const authored = Number(known[rel]?.mtime) > 0 ? Number(known[rel].mtime) : info.mtime;
          await fsp.utimes(target, authored / 1000, authored / 1000).catch(() => {});
          skipped += 1;
          continue;
        }
      } catch {
        // Unreadable local copy: fall through to the download.
      }
    }
    if (info.size > MAX_FILE_BYTES) {
      skipped += 1;
      failed.push(rel);
      continue;
    }
    let data;
    try {
      data = await fetchRemoteFile(settings, rel, signal);
    } catch (error) {
      failed.push({ path: rel, error: String(error?.message ?? error) });
      continue;
    }
    if (data === null) {
      failed.push({ path: rel, error: '服务器返回 404' });
      continue;
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.pull-${String(process.pid)}`;
    await fsp.writeFile(temporary, data);
    await fsp.rm(target, { force: true }).catch(() => {});
    await fsp.rename(temporary, target);
    const authored = Number(known[rel]?.mtime) > 0 ? Number(known[rel].mtime) : info.mtime;
    if (authored > 0) {
      await fsp.utimes(target, authored / 1000, authored / 1000).catch(() => {});
    }
    downloaded += isInternal(rel) ? 0 : 1;
    if (!isInternal(rel)) categories[categoryOf(rel)] += 1;
    bytes += isInternal(rel) ? 0 : data.length;
  }

  return { ok: true, direction: 'pull', downloaded, skipped, bytes, failed, requests: listed.requests, truncated: listed.truncated, downloadedRels: downloadedRels.slice(0, 300), categories };
}

/**
 * Upload mirror files that the share is missing or holds in an older copy.
 * Additive: it never deletes a remote file.
 */
export async function pushMirror(deps, signal) {
  const { settings, useManifestIndex = false } = deps;
  const mirror = requireMirror(settings);
  const local = await scanLocalTree(mirror);
  const previous = await readRemoteManifest(settings, signal);
  // The manifest already names every file the share holds, so a PROPFIND tour is
  // only needed when it is missing or a full reconciliation was requested.
  const manifestFiles = previous !== null && previous.json !== null && typeof previous.json.files === 'object'
    ? previous.json.files
    : null;
  const listed = useManifestIndex && manifestFiles !== null
    ? { files: new Map(Object.entries(manifestFiles).map(([rel, info]) => [rel, { size: Number(info?.size) || 0, mtime: Number(info?.mtime) || 0 }])), requests: 0, truncated: false }
    : await listRemoteTree(settings, signal);
  const known = previous !== null && previous.json !== null && typeof previous.json.files === 'object' ? previous.json.files : {};
  const ensured = new Set(['']);
  const manifest = {};
  const categories = { sessions: 0, config: 0, titles: 0, trash: 0, attachments: 0, other: 0 };
  let uploaded = 0;
  const uploadedRels = [];
  const deletedRels = [];
  let skipped = 0;
  let bytes = 0;
  const failed = [];

  for (const [rel, info] of local.entries()) {
    if (IGNORED.has(rel)) continue;
    const entry = known[rel];
    const remote = listed.files.get(rel);
    const entryIsCurrent = entry !== undefined
      && Number(entry.size) === info.size
      && typeof entry.mtime === 'number'
      && info.mtime <= Number(entry.mtime) + MTIME_TOLERANCE_MS;

    if (entryIsCurrent && (remote === undefined || !differs(remote, info))) {
      // Untouched locally since the last push, and the share agrees.
      let hash = entry.hash;
      if (typeof hash !== 'string') {
        // Older manifests recorded size and time only; without a hash every later
        // pull sees a differing server stamp and downloads the file again.
        try {
          hash = sha256(await fsp.readFile(localPathFor(mirror, rel)));
        } catch {
          hash = undefined;
        }
      }
      manifest[rel] = { size: info.size, mtime: info.mtime, hash };
      skipped += 1;
      continue;
    }

    if (entry === undefined && remote !== undefined && !differs(remote, info)) {
      // No manifest yet (first run or a new file), but the share already holds this
      // exact size/time pair: adopt it instead of re-uploading.
      manifest[rel] = { size: info.size, mtime: info.mtime };
      skipped += 1;
      continue;
    }

    let data;
    try {
      data = await fsp.readFile(localPathFor(mirror, rel));
    } catch (error) {
      failed.push({ path: rel, error: String(error?.message ?? error) });
      continue;
    }
    if (data.length > MAX_FILE_BYTES) {
      skipped += 1;
      failed.push({ path: rel, error: '超过 200 MB 上限' });
      continue;
    }
    const hash = sha256(data);
    if (entry !== undefined && entry.hash === hash) {
      // Content unchanged (only the timestamp moved): refresh the record, skip upload.
      manifest[rel] = { size: data.length, mtime: info.mtime, hash };
      skipped += 1;
      continue;
    }
    try {
      await uploadRemoteFile(settings, rel, data, ensured, signal);
    } catch (error) {
      failed.push({ path: rel, error: String(error?.message ?? error) });
      continue;
    }
    manifest[rel] = { size: data.length, mtime: info.mtime, hash };
    if (!isInternal(rel)) {
      categories[categoryOf(rel)] += 1;
      uploadedRels.push(rel);
    }
    uploaded += isInternal(rel) ? 0 : 1;
    bytes += isInternal(rel) ? 0 : data.length;
  }

  // Files the previous manifest listed but the mirror no longer holds were
  // deleted locally (purge, prune, trash cleanup) — remove them from the share
  // too, otherwise the cloud only ever grows. Guarded so that a wiped mirror or
  // a first run can never trigger a mass delete.
  const knownVisible = Object.keys(known).filter((rel) => !isInternal(rel));
  const localVisible = [...local.keys()].filter((rel) => !isInternal(rel));
  const removed = knownVisible.filter((rel) => !local.has(rel) && !IGNORED.has(rel));
  let deleted = 0;
  const deleteFailed = [];
  const deletedCategories = { sessions: 0, config: 0, titles: 0, trash: 0, attachments: 0, other: 0 };
  let deleteSkipped = null;
  if (removed.length > 0) {
    const cap = Math.max(20, Math.floor(knownVisible.length * 0.3));
    if (localVisible.length === 0) {
      deleteSkipped = '镜像为空，疑似被清空，已跳过云端删除';
    } else if (removed.length > cap) {
      deleteSkipped = `本轮待删除 ${String(removed.length)} 个文件，超过安全上限 ${String(cap)}，已跳过`;
    } else {
      for (const rel of removed) {
        try {
          await deleteRemoteFile(settings, rel, signal);
          deleted += 1;
          deletedRels.push(rel);
          deletedCategories[categoryOf(rel)] += 1;
        } catch (error) {
          deleteFailed.push({ path: rel, error: String(error?.message ?? error) });
        }
      }
      // DAV deletes files, not the folders that held them: prune the empty
      // session folder (and its project folder) that would otherwise linger.
      const parents = new Set();
      for (const rel of removed) {
        const parts = rel.split('/');
        for (let depth = parts.length - 1; depth >= 2; depth -= 1) parents.add(parts.slice(0, depth).join('/'));
      }
      const deepestFirst = [...parents].sort((a, b) => b.split('/').length - a.split('/').length);
      for (const dir of deepestFirst) {
        try {
          await deleteEmptyRemoteDir(settings, dir, signal);
        } catch {
          // A failed prune leaves an empty folder; the next run retries.
        }
      }
    }
  }

  // Keep manifest entries for untouched remote files too, so the next preview
  // can take the fast path instead of walking the whole tree.
  const removedSet = new Set(removed);
  for (const [rel, info] of listed.files.entries()) {
    if (removedSet.has(rel)) continue;
    if (manifest[rel] === undefined) manifest[rel] = known[rel] ?? info;
  }
  try {
    await writeRemoteManifest(settings, manifest, ensured, signal);
  } catch {
    // A missing manifest only costs a full listing next time.
  }

  return {
    ok: true,
    direction: 'push',
    uploaded,
    skipped,
    bytes,
    deleted,
    categories,
    deletedCategories,
    uploadedRels: uploadedRels.slice(0, 300),
    deletedRels: deletedRels.slice(0, 300),
    deleteFailed,
    deleteSkipped,
    failed,
    requests: listed.requests,
    truncated: listed.truncated,
  };
}

function requireMirror(settings) {
  const mirror = typeof settings.mirrorDir === 'string' ? settings.mirrorDir.trim() : '';
  if (mirror === '') throw Object.assign(new Error('请先填写本地镜像目录。'), { code: 'mirror-missing' });
  return mirror;
}

