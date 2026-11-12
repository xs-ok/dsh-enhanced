/**
 * Attachment store sync for the pure-JS engine.
 *
 * Attachment objects are content-addressed and immutable: the same sha256 means
 * the same bytes, and a session log only references them. So the sync is a pure
 * "fill the gaps" pass in both directions — never a delete. `request-images/`
 * (rebuildable cache) and `tmp/` are deliberately out of scope.
 */
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const SUBTREES = ['objects', 'file-objects', 'files'];

async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Index one attachments root.
 * `files/` nests one more level (bucket/sha/<name>) than the other two.
 */
export async function indexAttachments(root) {
  const map = new Map();
  for (const subtree of SUBTREES) {
    const base = path.join(root, subtree);
    for (const bucket of await readDirSafe(base)) {
      if (!bucket.isDirectory()) continue;
      const bucketDir = path.join(base, bucket.name);
      for (const entry of await readDirSafe(bucketDir)) {
        if (entry.isDirectory()) {
          if (subtree !== 'files') continue;
          const inner = path.join(bucketDir, entry.name);
          for (const file of await readDirSafe(inner)) {
            if (!file.isFile()) continue;
            const full = path.join(inner, file.name);
            const stat = await fsp.stat(full).catch(() => undefined);
            if (stat !== undefined) map.set(`${subtree}/${bucket.name}/${entry.name}/${file.name}`, { file: full, mtime: stat.mtimeMs, size: stat.size });
          }
          continue;
        }
        const full = path.join(bucketDir, entry.name);
        const stat = await fsp.stat(full).catch(() => undefined);
        if (stat !== undefined) map.set(`${subtree}/${bucket.name}/${entry.name}`, { file: full, mtime: stat.mtimeMs, size: stat.size });
      }
    }
  }
  return map;
}

async function copyObject(source, target, mtimeMs) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fsp.copyFile(source, temporary);
  await fsp.rename(temporary, target).catch(async () => {
      await fsp.rename(temporary, target);
  });
  if (Number.isFinite(mtimeMs)) await fsp.utimes(target, mtimeMs / 1000, mtimeMs / 1000).catch(() => {});
}

/**
 * Fill missing objects on both sides.
 * @returns counters plus how many objects existed on each side.
 */
export async function syncAttachments(deps) {
  const { localRoot, sharedRoot, apply = true } = deps;
  const local = await indexAttachments(localRoot);
  const shared = await indexAttachments(sharedRoot);

  let pushed = 0;
  let pulled = 0;
  let skipped = 0;
  const failed = [];

  for (const [rel, entry] of local) {
    if (shared.has(rel)) {
      skipped += 1;
      continue;
    }
    try {
      if (apply) await copyObject(entry.file, path.join(sharedRoot, ...rel.split('/')), entry.mtime);
      pushed += 1;
    } catch (error) {
      failed.push({ path: rel, error: String(error?.message ?? error) });
    }
  }
  for (const [rel, entry] of shared) {
    if (local.has(rel)) continue;
    try {
      if (apply) await copyObject(entry.file, path.join(localRoot, ...rel.split('/')), entry.mtime);
      pulled += 1;
    } catch (error) {
      failed.push({ path: rel, error: String(error?.message ?? error) });
    }
  }

  return { pushed, pulled, skipped, failed, localCount: local.size, sharedCount: shared.size };
}
