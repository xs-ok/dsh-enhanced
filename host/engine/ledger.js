/**
 * Deletion ledgers shared through the sync folder.
 *
 * Two documents describe what has been deleted, so that a deletion is a fact
 * recorded on both machines rather than a file that quietly disappears:
 *
 *   session-ledger.json    sessionId -> { at, workspace, mtime, size, by }
 *   workspace-ledger.json  workspaceUuid -> { at, path, title, sessions }
 *
 * A session that reappears locally with a newer log than `at` counts as restored
 * and is removed from the ledger again. Deleted sessions are kept in the shared
 * recycle bin (`<sync>/trash/...`), so the other machine can restore the newest
 * content instead of an older copy.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const SESSION_LEDGER = 'session-ledger.json';
export const WORKSPACE_LEDGER = 'workspace-ledger.json';

/** Upper bound on records kept in one ledger (oldest dropped first). */
const LEDGER_LIMIT = 500;

/** Read JSON, returning `fallback` for a missing or unreadable file. */
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON through a temporary file so a crash never leaves half a document. */
export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
}

/** One ledger document, normalised. */
export async function readLedger(stateDir, name) {
  const doc = await readJson(path.join(stateDir, name), undefined);
  if (doc === null || typeof doc !== 'object') return { version: 1, deleted: {} };
  const deleted = doc.deleted !== null && typeof doc.deleted === 'object' ? doc.deleted : {};
  return { version: 1, deleted };
}

/** Persist a ledger, sorted so diffs stay readable. */
export async function writeLedger(stateDir, name, doc) {
  const entries = Object.entries(doc.deleted ?? {});
  // Bound the document: 500 records is plenty of history and keeps the file small.
  if (entries.length > LEDGER_LIMIT) {
    entries.sort((a, b) => Date.parse(b[1]?.at ?? '') - Date.parse(a[1]?.at ?? ''));
    entries.length = LEDGER_LIMIT;
  }
  const ordered = {};
  for (const key of entries.map(([key]) => key).sort()) ordered[key] = doc.deleted[key];
  await writeJsonAtomic(path.join(stateDir, name), { version: 1, deleted: ordered, updatedAt: new Date().toISOString() });
}

/** SHA-256 of a file, or `''` when it cannot be read. */
export async function hashFile(file) {
  try {
    return createHash('sha256').update(await fsp.readFile(file)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Fold offline deletions into a ledger.
 *
 * The plugin writes local actions into a journal while the sync is not running
 * (deleting a session must not require the cloud to be reachable). Each sync
 * merges those entries and truncates the journal.
 *
 * @returns number of entries taken from the journal.
 */
export async function mergeJournal(stateDir, journalFile, ledger, kind = 'sessions') {
  const journal = await readJson(journalFile, undefined);
  if (journal === null || typeof journal !== 'object') return 0;
  const entries = journal[kind] ?? {};
  let taken = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || typeof value !== 'object') continue;
    const at = typeof value.at === 'string' ? value.at : new Date().toISOString();
    const current = ledger.deleted[key];
    if (current !== undefined && Date.parse(current.at ?? '') > Date.parse(at)) continue;
    ledger.deleted[key] = { ...(current ?? {}), ...value, at };
    taken += 1;
  }
  if (taken > 0) {
    const rest = { ...journal };
    rest[kind] = {};
    await writeJsonAtomic(journalFile, rest);
  }
  return taken;
}

/** Remove entries the caller already handled, leaving the journal otherwise intact. */
export async function clearJournalKind(journalFile, kind) {
  const journal = await readJson(journalFile, undefined);
  if (journal === null || typeof journal !== 'object') return;
  journal[kind] = {};
  await writeJsonAtomic(journalFile, journal);
}
