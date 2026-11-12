/**
 * Full-corpus session text search for DSH增强.
 *
 * The shipped composition mounts `session-query-sqlite` with `openAt: never`
 * and an in-memory index, so full-text search is off by default; its
 * `unicode61` tokenizer would also split Chinese poorly. This module keeps its
 * own derived text cache instead: one plain document per session, rebuilt only
 * when the persistence revision changes, matched by literal substring.
 *
 * Nothing here writes to a session log or activates an Agent.
 */
const MAX_SEGMENT_CHARS = 24000;
const MAX_MATCHES_PER_SESSION = Number.POSITIVE_INFINITY;
const MAX_TOTAL_MATCHES = 500;
const CONTEXT_CHARS = 42;

/** Text blocks of one message, tolerating every message shape the log stores. */
function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function clip(text) {
  if (text.length <= MAX_SEGMENT_CHARS) return text;
  return text.slice(0, MAX_SEGMENT_CHARS);
}

/** Fold one stored log into the searchable shape, keeping seq for citations. */
function buildDocument(sessionId, header, events) {
  const segments = [];
  let title = '';
  let updatedAt = typeof header.createdAt === 'number' ? header.createdAt : 0;
  let firstUserText = '';
  for (const event of events) {
    if (typeof event.time === 'number' && event.time > updatedAt) updatedAt = event.time;
    if (event.type === 'user/message') {
      const text = messageText(event.data);
      if (text !== '') {
        if (firstUserText === '') firstUserText = text;
        segments.push({ seq: event.seq, role: 'user', text: clip(text) });
      }
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message);
      if (text !== '') segments.push({ seq: event.seq, role: 'assistant', text: clip(text) });
    } else if (event.type === 'tool/result') {
      const text = messageText(event.data?.message);
      if (text !== '') segments.push({ seq: event.seq, role: 'tool', text: clip(text) });
    } else if (event.type === 'session/title') {
      const value = event.data?.title;
      if (typeof value === 'string' && value.trim() !== '') title = value.trim();
    }
  }
  if (title === '' && firstUserText !== '') title = firstUserText.split('\n', 1)[0].slice(0, 60);
  return { sessionId, title, updatedAt, segments };
}

async function readDocument(persistence, sessionId, header, signal) {
  const handle = await persistence.open(sessionId, 'read', { signal });
  try {
    const result = await handle.read(undefined, undefined, { signal });
    return buildDocument(sessionId, header, result.events);
  } finally {
    await handle.close();
  }
}

function snippetAround(text, index, length) {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + CONTEXT_CHARS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/** One document's matches, capped per session. */
function matchDocument(document, needle, settings, budget) {
  const matches = [];
  if (settings.matchTitle === true && document.title !== '') {
    if (document.title.toLowerCase().includes(needle)) {
      matches.push({ kind: 'title', role: 'title', snippet: document.title, at: document.title.toLowerCase().indexOf(needle) });
      budget.total += 1;
    }
  }
  if (settings.matchBody !== true && settings.matchTools !== true) return matches;
  for (const segment of document.segments) {
    if (matches.length >= MAX_MATCHES_PER_SESSION) break;
    if (segment.role === 'tool' && settings.matchTools !== true) continue;
    if (segment.role !== 'tool' && settings.matchBody !== true) continue;
    if (budget.total >= MAX_TOTAL_MATCHES) break;
    const haystack = segment.text.toLowerCase();
    let from = 0;
    while (matches.length < MAX_MATCHES_PER_SESSION && budget.total < MAX_TOTAL_MATCHES) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      matches.push({
        kind: 'body',
        role: segment.role,
        seq: segment.seq,
        snippet: snippetAround(segment.text, at, needle.length),
        at,
      });
      budget.total += 1;
      from = at + needle.length;
    }
  }
  return matches;
}

/**
 * Build the search service: one document cache keyed by persistence revision.
 * @param options - Host services the document builder reads.
 * @returns search, plus a cache reset for settings changes.
 */
export function createSearch(options) {
  const { persistence } = options;
  const cache = new Map();

  async function ensureDocument(snapshot, signal) {
    const sessionId = snapshot.header.id;
    const revision = String(snapshot.revision ?? '');
    const cached = cache.get(sessionId);
    if (cached !== undefined && cached.revision === revision) return cached.document;
    const document = await readDocument(persistence, sessionId, snapshot.header, signal);
    cache.set(sessionId, { revision, document });
    return document;
  }

  async function search(query, settings, signal) {
    const started = Date.now();
    const trimmed = query.trim();
    if (trimmed === '') return { groups: [], scanned: 0, truncated: false, tookMs: 0 };
    const needle = trimmed.toLowerCase();
    const snapshotList = await persistence.list({ signal });
    const budget = { total: 0 };
    const groups = [];
    const seen = new Set();
    for (const snapshot of snapshotList) {
      if (signal?.aborted === true) throw Object.assign(new Error('搜索已取消'), { code: 'cancelled' });
      if (snapshot.formatStatus === 'migration-required') continue;
      let document;
      try {
        document = await ensureDocument(snapshot, signal);
      } catch {
        continue;
      }
      seen.add(document.sessionId);
      const matches = matchDocument(document, needle, settings, budget);
      if (matches.length === 0) continue;
      groups.push({
        sessionId: document.sessionId,
        title: document.title !== '' ? document.title : '未命名会话',
        updatedAt: document.updatedAt,
        cwd: typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : undefined,
        matches,
      });
      if (budget.total >= MAX_TOTAL_MATCHES) break;
    }
    // Drop cache rows whose session log no longer exists.
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    groups.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      groups,
      scanned: snapshotList.length,
      truncated: budget.total >= MAX_TOTAL_MATCHES,
      tookMs: Date.now() - started,
    };
  }

  function reset() {
    cache.clear();
  }

  return { search, reset };
}
