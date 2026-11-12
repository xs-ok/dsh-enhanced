/**
 * Atomic write helper.
 *
 * Windows rename replaces an existing file, so there is no need to delete the
 * target first — doing that only opens a window where the file does not exist.
 * The temporary name carries a random suffix so two writers can never collide.
 */
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';

export async function writeFileAtomic(file, data, encoding) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, data, encoding);
  try {
    await fsp.rename(temporary, file);
  } catch (error) {
    // Some filesystems refuse to replace; fall back to delete+rename once.
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    await fsp.rm(file, { force: true }).catch(() => {});
    await fsp.rename(temporary, file);
  }
  return file;
}

export async function writeJsonAtomic(file, value) {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
