/**
 * Shared plugin inventory (`config/plugin-list.txt`).
 *
 * Each machine appends its own rows and only ever replaces its own lines, so the
 * other machine can read "what is installed over there" and copy the command.
 * Format: `machine | plugin | version | command`, `#` lines are the header.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic.js';

const HEADER = [
  '# DSH 插件清单（同步脚本自动维护，请勿手改格式；列之间用 | 分隔）',
  '# 列：机器代号 | 插件 | 版本 | 安装命令',
];

async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Exact installed version from the profile lockfile, when it can be found. */
async function exactVersion(profileDir, plugin) {
  try {
    const lock = await fsp.readFile(path.join(profileDir, 'pnpm-lock.yaml'), 'utf8');
    const pattern = new RegExp(`^\\s{2}'?${plugin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}@([^':]+)'?:`, 'mu');
    const match = pattern.exec(lock);
    return match === null ? undefined : match[1].trim();
  } catch {
    return undefined;
  }
}

/** Installed plugins of this machine, one row per profile dependency. */
export async function collectPlugins(dshHome, machineId) {
  const rows = [];
  const profilesRoot = path.join(dshHome, 'profiles');
  for (const dir of await readDirSafe(profilesRoot)) {
    if (!dir.isDirectory()) continue;
    const profileDir = path.join(profilesRoot, dir.name);
    let doc;
    try {
      doc = JSON.parse(await fsp.readFile(path.join(profileDir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const dependencies = doc?.dependencies;
    if (dependencies === null || typeof dependencies !== 'object') continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      const version = await exactVersion(profileDir, name) ?? String(spec);
      rows.push({
        machine: machineId,
        plugin: name,
        version,
        command: `dsh plugin --profile ${dir.name} add "${name}@latest"`,
      });
    }
  }
  return rows;
}

/** Merge this machine's rows into the shared file, keeping other machines' rows. */
export async function syncPluginList(deps) {
  const { dshHome, sharedConfigDir, machineId } = deps;
  const file = path.join(sharedConfigDir, 'plugin-list.txt');
  const rows = await collectPlugins(dshHome, machineId);

  let existing = '';
  try { existing = await fsp.readFile(file, 'utf8'); } catch { existing = ''; }
  const keep = existing.split(/\r?\n/u)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .filter((line) => line.split('|')[0].trim() !== machineId);

  const lines = [...HEADER, ...keep, ...rows.map((row) => `${row.machine} | ${row.plugin} | ${row.version} | ${row.command}`)];
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${lines.join('\n')}\n`, 'utf8');
  return { count: rows.length, file };
}
