/**
 * Read-only scan primitives for the pure-JS sync engine.
 *
 * This is the first parity step: it must reproduce what `dsh-session-sync.ps1`
 * counts in `-Status`, without writing anything.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** Encode a cwd the same way the persistence layer names project folders. */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '_no-cwd';
  let readable = '';
  let separatorRun = false;
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  readable = readable.replace(/^-+/u, '');
  if (readable === '') readable = 'root';
  if (readable.length > 251) readable = readable.slice(0, 251);
  return `--${readable}--`;
}

/** Generation number of one artifact name; -1 when it is not a session log. */
export function artifactGeneration(name) {
  const versioned = /^session\.v(\d+)\.jsonl\.zstd$/u.exec(name);
  if (versioned !== null) return Number(versioned[1]);
  if (name === 'session.jsonl.zstd') return 0;
  return -1;
}

async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Scan one sessions root; keeps the newest generation per session id. */
export async function scanSessions(root) {
  const sessions = new Map();
  for (const project of await readDirSafe(root)) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    for (const entry of await readDirSafe(projectDir)) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const dir = path.join(projectDir, id);
      let best = null;
      for (const file of await readDirSafe(dir)) {
        if (!file.isFile()) continue;
        const generation = artifactGeneration(file.name);
        if (generation < 0) continue;
        const full = path.join(dir, file.name);
        let stat;
        try { stat = await fsp.stat(full); } catch { continue; }
        if (best === null || generation > best.generation
          || (generation === best.generation && stat.mtimeMs > best.mtime)) {
          best = { id, dir, file: full, name: file.name, generation, mtime: stat.mtimeMs, size: stat.size, projectKey: project.name };
        }
      }
      if (best !== null) sessions.set(id, best);
    }
  }
  return sessions;
}

/** Every session directory with all of its generations, for pruning. */
export async function scanSessionGroups(root) {
  const groups = new Map();
  for (const project of await readDirSafe(root)) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    for (const entry of await readDirSafe(projectDir)) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(projectDir, entry.name);
      const files = [];
      for (const file of await readDirSafe(dir)) {
        if (!file.isFile()) continue;
        const generation = artifactGeneration(file.name);
        if (generation < 0) continue;
        const full = path.join(dir, file.name);
        const stat = await fsp.stat(full).catch(() => undefined);
        if (stat === undefined) continue;
        files.push({ name: file.name, path: full, generation, mtime: stat.mtimeMs, size: stat.size });
      }
      if (files.length > 0) groups.set(entry.name, { id: entry.name, dir, projectKey: project.name, files });
    }
  }
  return groups;
}

const CONFIG_ITEMS = (profile) => [  `profiles/${profile}/cordis.patch.yml`,
  'skills',
  'AGENTS.md',
  '.credentials.yaml',
];

/** List one config item as relative file paths. */
export async function scanConfigItem(baseDir, relPath) {
  const root = path.join(baseDir, ...relPath.split('/'));
  const files = [];
  async function walk(dir, prefix) {
    for (const entry of await readDirSafe(dir)) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else files.push(`${relPath}/${rel}`);
    }
  }
  try {
    const stat = await fsp.stat(root);
    if (stat.isFile()) return [relPath];
  } catch {
    return [];
  }
  await walk(root, '');
  return files;
}

/** All configuration files the engine is allowed to sync. */
export async function scanConfig(baseDir, profile = 'desktop') {
  const files = [];
  for (const item of CONFIG_ITEMS(profile)) {
    files.push(...await scanConfigItem(baseDir, item));
  }
  return files;
}

/** Count attachment objects by the three synced trees. */
export async function scanAttachments(root) {
  const result = { objects: 0, fileObjects: 0, files: 0 };
  for (const [key, name] of [['objects', 'objects'], ['fileObjects', 'file-objects'], ['files', 'files']]) {
    const dir = path.join(root, name);
    for (const bucket of await readDirSafe(dir)) {
      if (!bucket.isDirectory()) continue;
      const bucketDir = path.join(dir, bucket.name);
      for (const entry of await readDirSafe(bucketDir)) {
        if (entry.isDirectory()) {
          if (key === 'files') {
            for (const inner of await readDirSafe(path.join(bucketDir, entry.name))) {
              if (inner.isFile()) result[key] += 1;
            }
          }
          continue;
        }
        result[key] += 1;
      }
    }
  }
  return result;
}

/** The same numbers `-Status` prints, for parity comparison. */
export async function statusReport({ dshHome, syncDir, profile = 'desktop' }) {
  const local = await scanSessions(path.join(dshHome, 'sessions'));
  const shared = await scanSessions(path.join(syncDir, 'sessions'));
  const localConfig = await scanConfig(path.join(dshHome), profile);
  const sharedConfig = await scanConfig(path.join(syncDir, 'config'), profile);
  const localAtt = await scanAttachments(path.join(dshHome, 'attachments', 'v1'));
  const sharedAtt = await scanAttachments(path.join(syncDir, 'attachments', 'v1'));
  return {
    sessions: { local: local.size, shared: shared.size },
    config: { local: localConfig.length, shared: sharedConfig.length },
    attachments: { local: localAtt, shared: sharedAtt },
  };
}
