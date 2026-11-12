/**
 * Minimal WebDAV client for DSH增强.
 *
 * Only what the sync flow needs: a directory listing (PROPFIND) for the
 * connection test now, and room for GET/PUT/MKCOL/DELETE when the mirror layer
 * lands. No dependencies: Node's fetch sends the verb, Basic auth carries the
 * credentials (坚果云 wants an application password, not the login password).
 *
 * Remote paths may contain Chinese and spaces; every segment is percent-encoded
 * before the request is built.
 */

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

/**
 * Normalize a user-typed WebDAV path: backslashes become forward slashes,
 * duplicate and leading/trailing slashes are dropped. Callers always join, so a
 * missing leading slash (or a trailing one) simply does not matter.
 */
export function normalizeRemotePath(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\\/gu, '/')
    .replace(/\/{2,}/gu, '/')
    .replace(/^\/+/u, '')
    .replace(/\/+$/u, '');
}

/** Encode one URL path, leaving already-escaped segments alone. */
export function encodePath(value) {
  return String(value)
    .split('/')
    .map((segment) => {
      if (segment === '') return '';
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join('/');
}

/** Combine the server address with a remote path, tolerating a full URL in the path. */
export function buildRemoteUrl(baseUrl, remotePath) {
  const base = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  const remote = normalizeRemotePath(typeof remotePath === 'string' ? remotePath : '');
  if (/^https?:\/\//iu.test(remote)) return remote;
  if (base === '') return remote;
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const cleanRemote = normalizeRemotePath(remote);
  try {
    const joined = new URL(normalizedBase);
    joined.pathname = `${joined.pathname.replace(/\/+$/u, '')}/${cleanRemote}`;
    return `${joined.origin}${encodePath(joined.pathname)}`;
  } catch {
    return `${normalizedBase}${encodePath(cleanRemote)}`;
  }
}

function basicAuth(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/** Split a URL into the encoded path segments that may need to be created. */
export function pathSegments(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter((segment) => segment !== '');
  } catch {
    return [];
  }
}

/** Rebuild one absolute URL from the origin plus the first `count` segments. */
function urlForSegments(url, count) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '');
  const tail = segments.slice(0, count).join('/');
  return `${parsed.origin}/${tail}`;
}

/** PROPFIND one collection without listing it. 207 is the normal exists answer. */
async function collectionExists(url, headers, signal) {
  try {
    const response = await davFetch(url, { method: 'PROPFIND', headers: { ...headers, Depth: '0' }, body: PROPFIND_BODY }, signal);
    return response.status === 207 || response.status === 200;
  } catch {
    return false;
  }
}

/**
 * Create the configured remote path, one missing segment at a time.
 * @returns the created segments plus a failure message when one cannot be made.
 */
export async function ensureRemotePath(url, headers, signal) {
  const segments = pathSegments(url);
  const created = [];
  let existing = -1;
  for (let count = segments.length; count >= 0; count -= 1) {
    if (await collectionExists(urlForSegments(url, count), headers, signal)) {
      existing = count;
      break;
    }
  }
  if (existing < 0) return { ok: false, created, message: '远程地址不可访问，连最深一级父目录都不存在。' };

  for (let count = existing + 1; count <= segments.length; count += 1) {
    const target = urlForSegments(url, count);
    let response;
    try {
      response = await davFetch(target, { method: 'MKCOL', headers }, signal);
    } catch (error) {
      return { ok: false, created, message: `创建目录失败：${error?.message ?? String(error)}` };
    }
    if (response.status === 201) {
      created.push(segments[count - 1]);
      continue;
    }
    // 405 means the collection already exists on some servers; 409 means a parent is missing.
    if (response.status === 405) continue;
    if (response.status === 409) return { ok: false, created, message: '创建目录失败：父目录不存在。' };
    if (response.status === 401 || response.status === 403) return { ok: false, created, message: '创建目录失败：账号没有写入权限。' };
    return { ok: false, created, message: `创建目录失败：HTTP ${String(response.status)}。` };
  }
  return { ok: true, created, message: created.length === 0 ? '目录已存在。' : `已自动创建 ${String(created.length)} 级目录。` };
}

/** Pull the DAV hrefs out of a multistatus body without a namespace-aware parser. */
function parseMultistatus(text) {
  const blocks = text.split(/<\/[^>]*:?response>/iu);
  const entries = [];
  for (const block of blocks) {
    const href = /<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/iu.exec(block);
    if (href === null) continue;
    const isCollection = /<[^>]*:?collection\s*\/?>/iu.test(block);
    const length = /<[^>]*:?getcontentlength[^>]*>([\s\S]*?)<\/[^>]*:?getcontentlength>/iu.exec(block);
    const modified = /<[^>]*:?getlastmodified[^>]*>([\s\S]*?)<\/[^>]*:?getlastmodified>/iu.exec(block);
    let decoded = href[1].trim();
    try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
    const name = decoded.replace(/\/+$/u, '').split('/').pop() ?? '';
    const mtime = modified === null ? 0 : Date.parse(modified[1].trim());
    entries.push({
      href: decoded,
      name,
      collection: isCollection,
      size: length === null ? 0 : Number(length[1].trim()) || 0,
      mtime: Number.isFinite(mtime) ? mtime : 0,
    });
  }
  return entries;
}

/**
 * List one remote directory.
 * @param settings - WebDAV settings (url, user, password, root).
 * @returns ok/status/entries plus a human message the panel can show.
 */
export async function testConnection(settings, signal) {
  const url = buildRemoteUrl(settings.webdavUrl, settings.webdavRoot);
  if (url === '') throw Object.assign(new Error('请先填写 WebDAV 地址。'), { code: 'webdav-url-missing' });
  if (typeof settings.webdavUser !== 'string' || settings.webdavUser.trim() === '') {
    throw Object.assign(new Error('请先填写 WebDAV 账号。'), { code: 'webdav-user-missing' });
  }

  const headers = {
    Depth: '1',
    'Content-Type': 'application/xml; charset=utf-8',
    Authorization: basicAuth(settings.webdavUser, settings.webdavPassword ?? ''),
  };

  let response;
  try {
    response = await davFetch(url, { method: 'PROPFIND', headers, body: PROPFIND_BODY }, signal);
  } catch (error) {
    throw Object.assign(new Error(`无法连接：${error?.message ?? String(error)}`), { code: 'webdav-unreachable' });
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status, url, message: '认证失败。坚果云需要填“应用密码”，不是登录密码。' };
  }
  if (response.status === 404) {
    if (settings.webdavAutoCreate === false) {
      return { ok: false, status: response.status, url, message: '路径不存在。请确认远程根目录已经在服务器上创建，或打开“自动创建目录”。' };
    }
    const made = await ensureRemotePath(url, headers, signal);
    if (made.ok !== true) return { ok: false, status: response.status, url, message: made.message };
    const retry = await davFetch(url, { method: 'PROPFIND', headers, body: PROPFIND_BODY }, signal);
    if (!retry.ok) {
      return { ok: false, status: retry.status, url, message: `${made.message}但随后无法读取该目录（HTTP ${String(retry.status)}）。` };
    }
    const entries = parseMultistatus(await retry.text());
    return {
      ok: true,
      status: retry.status,
      url,
      created: made.created,
      entries: entries.slice(0, 50),
      count: entries.length,
      message: `${made.message}目录下 ${String(Math.max(0, entries.length - 1))} 项。`,
    };
  }
  if (response.status === 405) {
    return { ok: false, status: response.status, url, message: '服务器不接受 PROPFIND，可能不是标准 WebDAV 地址。' };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, url, message: `服务器返回 HTTP ${String(response.status)}。` };
  }

  const text = await response.text();
  const entries = parseMultistatus(text);
  return {
    ok: true,
    status: response.status,
    url,
    entries: entries.slice(0, 50),
    count: entries.length,
    message: `目录下 ${String(Math.max(0, entries.length - 1))} 项。`,
  };
}

/** Resolve one absolute URL from a DAV href (absolute path or full URL). */
function hrefToUrl(base, href) {
  if (/^https?:\/\//iu.test(href)) return href;
  const origin = new URL(base).origin;
  return `${origin}${href.startsWith('/') ? '' : '/'}${encodePath(href)}`;
}

/**
 * Relative path of one href under the configured root, decoded.
 *
 * DAV hrefs arrive percent-decoded from `parseMultistatus`, while the configured
 * root comes from `new URL(...).pathname` and is still encoded. Comparing the two
 * directly silently fails for any non-ASCII folder (坚果云 uses 我的坚果云), which
 * used to make every file look like it existed on only one side.
 */
function relativeUnder(rootPath, href) {
  let target = href;
  if (/^https?:\/\//iu.test(target)) {
    try { target = new URL(target).pathname; } catch { /* keep raw */ }
  }
  let root = rootPath;
  try { root = decodeURIComponent(root); } catch { /* keep raw */ }
  try { target = decodeURIComponent(target); } catch { /* keep raw */ }
  root = root.replace(/\/+$/u, '');
  target = target.replace(/\/+$/u, '');
  if (target === root) return '';
  if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
  return target.replace(/^\/+/u, '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch with 429/503 backoff — most WebDAV servers rate-limit per request. */
// A throttled server does not get better by hammering it: once a request ends
// in 429/503 (after its own retries) every later request fails fast for a while.
const THROTTLE_COOLDOWN_MS = 10 * 60_000;
let throttleUntil = 0;
let throttleStatus = 0;

/** Current throttle window, for diagnostics and the scheduler. */
export function throttleState() {
  return { until: throttleUntil, status: throttleStatus };
}

function throttledError() {
  const minutes = Math.max(1, Math.ceil((throttleUntil - Date.now()) / 60_000));
  return Object.assign(
    new Error(`云端限流中（HTTP ${String(throttleStatus)}），约 ${String(minutes)} 分钟后自动恢复`),
    { code: 'webdav-throttled', status: throttleStatus, until: throttleUntil },
  );
}

async function davFetch(url, init, signal, attempts = 5) {
  if (Date.now() < throttleUntil) throw throttledError();
  let response = await fetch(url, { ...init, signal });
  for (let attempt = 1; attempt < attempts && (response.status === 429 || response.status === 503); attempt += 1) {
    // Jianguoyun answers 503 when it is throttling; exponential backoff with the
    // server's own Retry-After hint is the only sane way through.
    const hinted = Number(response.headers?.get?.('retry-after'));
    const delay = Number.isFinite(hinted) && hinted > 0 ? hinted * 1000 : Math.min(8000, 500 * (2 ** attempt));
    await sleep(delay);
    response = await fetch(url, { ...init, signal });
  }
  if (response.status === 429 || response.status === 503) {
    throttleStatus = response.status;
    throttleUntil = Date.now() + THROTTLE_COOLDOWN_MS;
  }
  return response;
}

/**
 * Walk the configured remote tree, one PROPFIND per directory.
 * @returns Map keyed by the path relative to the configured root.
 */
export async function listRemoteTree(settings, signal, options = {}) {
  const base = buildRemoteUrl(settings.webdavUrl, settings.webdavRoot);
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 12;
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 20_000;
  const headers = {
    'Content-Type': 'application/xml; charset=utf-8',
    Authorization: basicAuth(settings.webdavUser, settings.webdavPassword ?? ''),
  };
  const rootPath = new URL(base).pathname.replace(/\/+$/u, '');
  const files = new Map();
  const queue = [{ url: base, rel: '', depth: 0 }];
  let requests = 0;

  while (queue.length > 0) {
    const item = queue.shift();
    let response;
    response = await davFetch(item.url, { method: 'PROPFIND', headers: { ...headers, Depth: '1' }, body: PROPFIND_BODY }, signal);
    requests += 1;
    if (response === undefined) break;
    if (response.status === 404) continue;
    if (response.status !== 207 && response.status !== 200) {
      const hint = response.status === 429 || response.status === 503
        ? '（云端限流或暂时不可用，已自动重试并进入 10 分钟冷却）'
        : (response.status >= 500 ? '（云端服务异常）' : '');
      throw Object.assign(new Error(`列目录失败：HTTP ${String(response.status)}${hint}`), { code: 'webdav-list-failed', status: response.status });
    }
    for (const entry of parseMultistatus(await response.text())) {
      const rel = relativeUnder(rootPath, entry.href);
      if (rel === '' || rel === item.rel) continue;
      if (entry.collection) {
        if (item.depth < maxDepth) queue.push({ url: hrefToUrl(base, entry.href).replace(/\/+$/u, ''), rel, depth: item.depth + 1 });
        continue;
      }
      files.set(rel, { size: entry.size, mtime: entry.mtime });
      if (files.size > maxEntries) {
        return { files, requests, truncated: true };
      }
    }
  }
  return { files, requests, truncated: false };
}

/** Read the remote manifest document, if the share has one. */
export async function readRemoteManifest(settings, signal) {
  const base = buildRemoteUrl(settings.webdavUrl, settings.webdavRoot);
  const url = `${base.replace(/\/+$/u, '')}/_sync-manifest.json`;
  const headers = { Authorization: basicAuth(settings.webdavUser, settings.webdavPassword ?? '') };
  const response = await davFetch(url, { headers }, signal);
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

/** Auth + XML headers for one configured share. */
export function shareHeaders(settings) {
  return {
    'Content-Type': 'application/xml; charset=utf-8',
    Authorization: basicAuth(settings.webdavUser, settings.webdavPassword ?? ''),
  };
}

/** Absolute URL of one path relative to the configured root. */
export function remoteUrlFor(settings, rel) {
  const base = buildRemoteUrl(settings.webdavUrl, settings.webdavRoot).replace(/\/+$/u, '');
  return `${base}/${encodePath(rel.split('/').filter(Boolean).join('/'))}`;
}

/** Download one file; null on 404. */
export async function fetchRemoteFile(settings, rel, signal) {
  const response = await davFetch(remoteUrlFor(settings, rel), { headers: shareHeaders(settings) }, signal);
  if (response.status === 404) return null;
  if (!response.ok) throw Object.assign(new Error(`下载失败 ${rel}：HTTP ${String(response.status)}`), { code: 'webdav-get-failed' });
  return new Uint8Array(await response.arrayBuffer());
}

/** Upload one file, creating its parent collections first. */
export async function uploadRemoteFile(settings, rel, bytes, ensured, signal) {
  const segments = rel.split('/');
  const parent = segments.slice(0, -1).join('/');
  if (parent !== '' && !ensured.has(parent)) {
    const parentUrl = remoteUrlFor(settings, parent);
    const made = await ensureRemotePath(parentUrl, shareHeaders(settings), signal);
    if (made.ok !== true) throw Object.assign(new Error(made.message), { code: 'webdav-mkcol-failed' });
    ensured.add(parent);
  }
  const response = await davFetch(remoteUrlFor(settings, rel), {
    method: 'PUT',
    headers: { ...shareHeaders(settings), 'Content-Type': 'application/octet-stream' },
    body: bytes,
  }, signal);
  if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
    throw Object.assign(new Error(`上传失败 ${rel}：HTTP ${String(response.status)}`), { code: 'webdav-put-failed' });
  }
  return response.status;
}

/** Delete one remote file; a missing file counts as already deleted. */
export async function deleteRemoteFile(settings, rel, signal) {
  const response = await davFetch(remoteUrlFor(settings, rel), { method: 'DELETE', headers: shareHeaders(settings) }, signal);
  if (response.status === 200 || response.status === 202 || response.status === 204) return 'deleted';
  if (response.status === 404) return 'missing';
  throw Object.assign(new Error(`删除失败 ${rel}：HTTP ${String(response.status)}`), { code: 'webdav-delete-failed' });
}

/**
 * Delete one remote directory, but only after proving it holds nothing.
 * DAV DELETE on a collection is recursive, so an unchecked call could wipe a
 * whole subtree.
 */
export async function deleteEmptyRemoteDir(settings, rel, signal) {
  const url = remoteUrlFor(settings, rel);
  const headers = shareHeaders(settings);
  const listing = await davFetch(url, { method: 'PROPFIND', headers: { ...headers, Depth: '1' }, body: PROPFIND_BODY }, signal);
  if (listing.status === 404) return 'missing';
  if (listing.status !== 207 && listing.status !== 200) return 'skipped';
  const own = decodeURIComponent(new URL(url).pathname).replace(/\/+$/u, '');
  const children = parseMultistatus(await listing.text())
    .filter((entry) => entry.href.replace(/\/+$/u, '') !== own);
  if (children.length > 0) return 'not-empty';
  const removed = await davFetch(url, { method: 'DELETE', headers }, signal);
  return removed.status === 200 || removed.status === 202 || removed.status === 204 ? 'deleted' : 'failed';
}

/** Write the remote manifest so the next run can take the fast path. */
export async function writeRemoteManifest(settings, files, ensured, signal) {
  const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), files }, null, 0);
  return uploadRemoteFile(settings, '_sync-manifest.json', new TextEncoder().encode(body), ensured, signal);
}
