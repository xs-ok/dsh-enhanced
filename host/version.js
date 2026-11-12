/**
 * The plugin version, read from package.json next to this module.
 *
 * Releases bump package.json, so nothing else should hard-code a version.
 */
import { readFileSync } from 'node:fs';

let cached = null;

/** Version string such as `0.2.2-5`, or `0.0.0` when unreadable. */
export function pluginVersion() {
  if (cached !== null) return cached;
  try {
    const file = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    cached = typeof parsed?.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
