/**
 * Configuration file sync for the pure-JS engine.
 *
 * The synced set is deliberately small — `profiles/<p>/cordis.patch.yml`,
 * `skills/`, `AGENTS.md`, `.credentials.yaml` — because everything else is either
 * machine-specific or rewritten by the app at startup. Per file the newer side
 * wins; a pulled text file has foreign home paths rewritten to this user, and a
 * `.json` payload is parsed before it is kept (the app may be mid-write).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function configItems(profile = 'desktop') {
  return [
    `profiles/${profile}/cordis.patch.yml`,
    'skills',
    'AGENTS.md',
    '.credentials.yaml',
  ];
}

async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Relative path -> { file, mtime } for one config item. */
export async function indexConfigItem(base, relPath) {
  const map = new Map();
  const root = path.join(base, ...relPath.split('/'));
  let stat;
  try { stat = await fsp.stat(root); } catch { return map; }
  if (stat.isFile()) {
    map.set(relPath, { file: root, mtime: stat.mtimeMs, size: stat.size });
    return map;
  }
  async function walk(dir, rel) {
    for (const entry of await readDirSafe(dir)) {
      const childRel = `${rel}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, childRel);
        continue;
      }
      try {
        const info = await fsp.stat(full);
        map.set(childRel, { file: full, mtime: info.mtimeMs, size: info.size });
      } catch {
        // A file that vanished mid-scan is simply absent.
      }
    }
  }
  await walk(root, relPath);
  return map;
}

/** Index every synced config item. */
export async function indexConfig(base, profile = 'desktop') {
  const map = new Map();
  for (const item of configItems(profile)) {
    for (const [rel, entry] of await indexConfigItem(base, item)) map.set(rel, entry);
  }
  return map;
}

/**
 * Replace another user's home directory with this machine's user.
 * Handles both separators, since config files are hand-edited.
 */
export function rewriteUserPath(text, currentUser) {
  if (typeof text !== 'string' || currentUser === '') return text;
  return text.replace(/([A-Za-z]:[\\/]Users[\\/])([^\\/\s"'`:]+)/gu, (match, prefix, user) => (
    user.toLowerCase() === currentUser.toLowerCase() ? match : `${prefix}${currentUser}`
  ));
}

async function copyFile(source, target, mtimeMs) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fsp.copyFile(source, temporary);
  await fsp.rename(temporary, target);
  if (Number.isFinite(mtimeMs)) await fsp.utimes(target, mtimeMs / 1000, mtimeMs / 1000).catch(() => {});
}

// WebDAV keeps timestamps to the second, so anything inside one second is the
// same revision; comparing raw milliseconds only produces copies.
const MTIME_TOLERANCE_MS = 1000;

/** Only these extensions get the user-path rewrite; everything else is copied byte for byte. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.yml', '.yaml', '.json', '.jsonl', '.toml', '.ini', '.cfg',
  '.ps1', '.psm1', '.sh', '.bat', '.cmd', '.py', '.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.xml',
]);

function isTextConfig(rel) {
  return TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

async function sameContent(a, b, sizeA, sizeB) {
  if (Number.isFinite(sizeA) && Number.isFinite(sizeB) && sizeA !== sizeB) return false;
  try {
    const [left, right] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
    return createHash('sha256').update(left).digest('hex') === createHash('sha256').update(right).digest('hex');
  } catch {
    return false;
  }
}

async function isValidJson(file) {
  try {
    JSON.parse(await fsp.readFile(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync the config set in both directions.
 * @returns counters plus the relative paths that were rejected as invalid JSON.
 */
export async function syncConfigFiles(deps) {
  const { localBase, sharedBase, profile = 'desktop', currentUser = '', stagingDir = '' } = deps;
  const local = await indexConfig(localBase, profile);
  const shared = await indexConfig(sharedBase, profile);

  let copied = 0;
  let skipped = 0;
  const invalid = [];
  const details = [];

  const push = async (rel, entry, other) => {
    const target = path.join(sharedBase, ...rel.split('/'));
    await copyFile(entry.file, target, entry.mtime);
    if (rel.endsWith('.json') && !(await isValidJson(target))) {
      // The app may be mid-write; never keep a half-written document.
      await fsp.rm(target, { force: true }).catch(() => {});
      invalid.push(rel);
      return;
    }
    details.push({ action: 'push', rel, deltaMs: other === undefined ? null : Math.round(entry.mtime - other.mtime) });
    copied += 1;
  };

  /** The app rewrites its own patch file, so a live write is lost; stage it instead. */
  const isProfilePatch = (rel) => rel === `profiles/${profile}/cordis.patch.yml`;

  const pull = async (rel, entry, other) => {
    if (isProfilePatch(rel) && stagingDir !== '') {
      const staged = path.join(stagingDir, ...rel.split('/'));
      await fsp.mkdir(path.dirname(staged), { recursive: true });
      await fsp.copyFile(entry.file, staged);
      details.push({ action: 'staged', rel, deltaMs: other === undefined ? null : Math.round(entry.mtime - other.mtime) });
      copied += 1;
      return;
    }
    const target = path.join(localBase, ...rel.split('/'));
    await copyFile(entry.file, target, entry.mtime);
    if (rel.endsWith('.json') === false && isTextConfig(rel)) {
      const text = await fsp.readFile(target, 'utf8').catch(() => '');
      const rewritten = rewriteUserPath(text, currentUser);
      if (rewritten !== text) {
        await fsp.writeFile(target, rewritten, 'utf8');
        // Rewriting the body resets mtime to "now"; restore the source stamp or
        // the next run would push the file straight back.
        if (Number.isFinite(entry.mtime)) await fsp.utimes(target, entry.mtime / 1000, entry.mtime / 1000).catch(() => {});
      }
    }
    if (rel.endsWith('.json') && !(await isValidJson(target))) {
      // The app may be mid-write; never keep a half-written document.
      await fsp.rm(target, { force: true }).catch(() => {});
      invalid.push(rel);
      return;
    }
    details.push({ action: 'pull', rel, deltaMs: other === undefined ? null : Math.round(entry.mtime - other.mtime) });
    copied += 1;
  };

  const align = async (a, b, newerMtime) => {
    await fsp.utimes(a, newerMtime / 1000, newerMtime / 1000).catch(() => {});
    await fsp.utimes(b, newerMtime / 1000, newerMtime / 1000).catch(() => {});
  };

  for (const [rel, entry] of local) {
    const other = shared.get(rel);
    if (other === undefined) {
      await push(rel, entry, other);
      continue;
    }
    const changed = entry.mtime > other.mtime + MTIME_TOLERANCE_MS || other.mtime > entry.mtime + MTIME_TOLERANCE_MS;
    if (!changed) {
      skipped += 1;
      continue;
    }
    if (await sameContent(entry.file, other.file, entry.size, other.size)) {
      // Same bytes, different stamps: keep the newer one and stop reporting it.
      await align(entry.file, other.file, Math.max(entry.mtime, other.mtime));
      skipped += 1;
      continue;
    }
    if (entry.mtime > other.mtime) await push(rel, entry, other);
    else await pull(rel, entry, other);
  }
  for (const [rel, entry] of shared) {
    if (local.has(rel)) continue;
    await pull(rel, entry, undefined);
  }

  return { copied, skipped, invalid, details };
}
