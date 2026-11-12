/**
 * Cross-machine recycle-bin sync for DSH增强.
 *
 * The PowerShell engine syncs sessions, config and attachments, but the recycle
 * bin is plugin-owned data with deletes of its own, so it needs different rules:
 * a plain "copy if newer" pass would resurrect entries the user purged. This
 * module therefore keeps two small documents in the share:
 *
 *   config/sync-state/trash-tombstones.json   entry key -> deletion time
 *   config/sync-state/trash-state-<machine>.json  keys this machine held last run
 *
 * An entry that disappears locally becomes a tombstone, a tombstone removes the
 * entry on both sides, and an entry newer than its tombstone revives it (the user
 * restored the session and later deleted it again).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const UNGROUPED = '_ungrouped';

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rm(file, { force: true });
  await fsp.rename(temporary, file);
}

async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Newest mtime of any file inside one entry, so "edited then deleted" wins. */
async function newestMtime(dir) {
  let newest = 0;
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        // A file removed mid-walk is simply absent.
      }
    }
  }
  await walk(dir);
  return newest;
}

/** One entry key plus its metadata, from one side of the sync. */
async function scanTrashSide(root) {
  const entries = new Map();
  for (const bucket of await readDirSafe(root)) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = path.join(root, bucket.name);
    for (const item of await readDirSafe(bucketDir)) {
      if (!item.isDirectory()) continue;
      if (item.name.includes('.staging-')) continue;
      const dir = path.join(bucketDir, item.name);
      const meta = (await readJson(path.join(dir, 'meta.json'))) ?? {};
      let stamp = 0;
      if (typeof meta.deletedAt === 'string') {
        const parsed = Date.parse(meta.deletedAt);
        if (Number.isFinite(parsed)) stamp = parsed;
      }
      if (stamp === 0) {
        try { stamp = (await fsp.stat(dir)).mtimeMs; } catch { stamp = 0; }
      }
      const contentMtime = await newestMtime(dir);
      entries.set(`${bucket.name}/${item.name}`, { key: `${bucket.name}/${item.name}`, dir, meta, stamp, contentMtime });
    }
  }
  return entries;
}

/** Copy one entry directory next to its target, then swap it in. */
async function copyEntry(sourceDir, targetDir) {
  const staging = `${targetDir}.sync-${String(process.pid)}`;
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(targetDir), { recursive: true });
  await fsp.cp(sourceDir, staging, { recursive: true });
  await fsp.rm(targetDir, { recursive: true, force: true });
  await fsp.rename(staging, targetDir);
}

/**
 * Sync the recycle bin between this machine and the share.
 * @param deps - Host paths, sync settings and the resolved machine id.
 * @returns counters plus the tombstone count, for the run summary.
 */
export async function syncTrash(deps) {
  const { paths, settings, machineId, syncDir } = deps;
  const localRoot = paths.trashDir;
  const sharedRoot = path.join(syncDir, 'trash');
  const stateDir = path.join(syncDir, 'config', 'sync-state');
  const tombstoneFile = path.join(stateDir, 'trash-tombstones.json');
  const machineFile = path.join(stateDir, `trash-state-${machineId}.json`);

  const local = await scanTrashSide(localRoot);
  const shared = await scanTrashSide(sharedRoot);
  const tombDoc = (await readJson(tombstoneFile)) ?? { version: 1, deleted: {} };
  const tombstones = new Map(Object.entries(tombDoc.deleted ?? {}));
  const previous = (await readJson(machineFile)) ?? { version: 1, keys: {} };
  const previousKeys = new Set(Object.keys(previous.keys ?? {}));

  let tombstoneChanges = 0;
  const now = Date.now();

  // 1. Local deletions become tombstones (a key we held last run but no longer do).
  for (const key of previousKeys) {
    if (local.has(key)) continue;
    if (tombstones.has(key)) continue;
    tombstones.set(key, new Date(now).toISOString());
    tombstoneChanges += 1;
  }

  // 2. Apply tombstones on both sides; a newer entry revives instead.
  for (const [key, iso] of [...tombstones.entries()]) {
    const tombTime = Date.parse(iso);
    const sides = [local, shared];
    let revived = false;
    for (const side of sides) {
      const entry = side.get(key);
      if (entry === undefined) continue;
      if (Number.isFinite(tombTime) && entry.stamp > tombTime) {
        revived = true;
        continue;
      }
      await fsp.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
      side.delete(key);
    }
    if (revived) {
      tombstones.delete(key);
      tombstoneChanges += 1;
    }
  }

  // 3. Union both sides: missing entries are copied, differing ones keep the newer.
  let pushed = 0;
  let pulled = 0;
  const keys = new Set([...local.keys(), ...shared.keys()]);
  for (const key of keys) {
    if (tombstones.has(key)) continue;
    const left = local.get(key);
    const right = shared.get(key);
    if (left !== undefined && right === undefined) {
      await copyEntry(left.dir, path.join(sharedRoot, key));
      pushed += 1;
      continue;
    }
    if (left === undefined && right !== undefined) {
      await copyEntry(right.dir, path.join(localRoot, key));
      pulled += 1;
      continue;
    }
    if (left === undefined || right === undefined) continue;
    // "Edited, then deleted" leaves two entries with the same deletion time but
    // different content: the newer log must win on both sides.
    const newerLeft = left.contentMtime > right.contentMtime + 1
      || (Math.abs(left.contentMtime - right.contentMtime) <= 1 && left.stamp > right.stamp);
    if (newerLeft) {
      await copyEntry(left.dir, path.join(sharedRoot, key));
      pushed += 1;
    } else if (right.contentMtime > left.contentMtime + 1 || right.stamp > left.stamp) {
      await copyEntry(right.dir, path.join(localRoot, key));
      pulled += 1;
    }
  }

  // 4. Remember what this machine holds, so the next run can spot deletions.
  const keysNow = {};
  for (const [key, entry] of local.entries()) keysNow[key] = new Date(entry.stamp).toISOString();
  await writeJson(machineFile, { version: 1, machine: machineId, updatedAt: new Date().toISOString(), keys: keysNow });
  if (tombstoneChanges > 0) {
    const ordered = {};
    for (const key of [...tombstones.keys()].sort()) ordered[key] = tombstones.get(key);
    await writeJson(tombstoneFile, { version: 1, note: '回收站条目的删除墓碑，插件据此删除两端副本，请勿手改', deleted: ordered });
  }

  return { pushed, pulled, tombstones: tombstones.size, local: local.size, shared: shared.size };
}
