/**
 * Path resolution for the pure-JS engine, mirroring `Resolve-LocalPath` in the
 * PowerShell script: explicit path-map entry, then a user-name rewrite, then
 * "create it if the drive exists", otherwise report the path as unreachable.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** Parse `config/path-map.txt`: `<machine> <remote> <local>` per line, `#` comments. */
export function parsePathMap(text, machineId) {
  const entries = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/u);
    if (parts.length < 3) continue;
    const [machine, remote, local] = parts;
    if (machine !== '*' && machine.toLowerCase() !== machineId.toLowerCase()) continue;
    entries.push({ remotePath: remote.replace(/\\+$/u, ''), localPath: local });
  }
  entries.sort((a, b) => b.remotePath.length - a.remotePath.length);
  return entries;
}

/** Load the path map from a share, tolerating a missing file. */
export async function loadPathMap(shareDir, machineId) {
  try {
    return parsePathMap(await fsp.readFile(path.join(shareDir, 'config', 'path-map.txt'), 'utf8'), machineId);
  } catch {
    return [];
  }
}

/**
 * Resolve one remote cwd for this machine.
 * @returns {{path: string, action: 'mapped'|'user'|'existed'|'created'|'missing'}}
 */
export async function resolveLocalPath(remotePath, options = {}) {
  const { mappings = [], currentUser = '', create = true, exists = defaultExists, mkdir = defaultMkdir } = options;
  if (typeof remotePath !== 'string' || remotePath === '') return { path: remotePath, action: 'existed' };

  const normalized = remotePath.replace(/\\+$/u, '');
  for (const mapping of mappings) {
    if (normalized === mapping.remotePath || normalized.toLowerCase().startsWith(`${mapping.remotePath.toLowerCase()}\\`)) {
      return { path: mapping.localPath + remotePath.slice(mapping.remotePath.length), action: 'mapped' };
    }
  }

  let resolved = remotePath;
  const userMatch = /^([A-Za-z]:\\Users\\)([^\\]+)(\\.*)$/u.exec(remotePath);
  if (userMatch !== null && currentUser !== '' && userMatch[2] !== currentUser) {
    resolved = `${userMatch[1]}${currentUser}${userMatch[3]}`;
  }

  if (await exists(resolved)) return { path: resolved, action: resolved === remotePath ? 'existed' : 'user' };

  const root = path.parse(resolved).root;
  if (root !== '' && (await exists(root))) {
    if (!create) return { path: resolved, action: 'missing' };
    try {
      await mkdir(resolved);
      return { path: resolved, action: 'created' };
    } catch {
      return { path: resolved, action: 'missing' };
    }
  }
  return { path: resolved, action: 'missing' };
}

async function defaultExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function defaultMkdir(target) {
  await fsp.mkdir(target, { recursive: true });
}
