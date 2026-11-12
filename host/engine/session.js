/**
 * Session log read/write for the pure-JS engine.
 *
 * A session file is a multi-frame zstd container of JSONL rows: the app appends
 * one frame per write, and a frame may hold several rows. The first row of the
 * first frame is the header carrying `id` and `cwd`. Rewriting a session keeps
 * the original frame segmentation and touches only that header row, which is what
 * `dsh-zstd-helper.js copy` does — anything else changes the byte layout the
 * desktop app expects.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { decodeFrames, encodeFrame, scanFrames } from './zstd.js';

/** Split one frame's plaintext into JSONL rows. */
function rowsOf(text) {
  return text.split('\n').filter((line) => line !== '');
}

/** Parse one session buffer: header plus per-frame plaintext. */
export function parseSession(buffer) {
  const frames = scanFrames(buffer);
  if (frames.length === 0) throw Object.assign(new Error('文件中没有完整的 zstd 帧'), { code: 'zstd-empty' });
  const texts = frames.map((frame) => decodeFrames(buffer, [frame]).toString('utf8'));
  const firstRows = rowsOf(texts[0]);
  if (firstRows.length === 0) throw Object.assign(new Error('会话首帧为空'), { code: 'session-empty' });
  let header;
  try {
    header = JSON.parse(firstRows[0]);
  } catch {
    throw Object.assign(new Error('会话首行不是合法 JSON'), { code: 'session-header-invalid' });
  }
  if (header === null || typeof header !== 'object' || typeof header.id !== 'string') {
    throw Object.assign(new Error('会话首行缺少 id'), { code: 'session-header-invalid' });
  }
  return { header, texts, frames: frames.length };
}

/** Read one session file from disk. */
export async function readSessionFile(file) {
  return parseSession(await fsp.readFile(file));
}

/** Rewrite only the header's cwd, keeping frame boundaries and every other row. */
export function rewriteCwd(parsed, cwd) {
  const texts = [...parsed.texts];
  const rows = rowsOf(texts[0]);
  const header = { ...JSON.parse(rows[0]), cwd };
  rows[0] = JSON.stringify(header);
  texts[0] = `${rows.join('\n')}\n`;
  return { header, texts };
}

/** Encode per-frame plaintext back into one multi-frame container. */
export function encodeSession(texts) {
  return Buffer.concat(texts.map((text) => encodeFrame(text)));
}

/** Write rows as a multi-frame container, replacing the target atomically. */
export async function writeSessionFile(file, texts) {
  const buffer = encodeSession(texts);
  const temporary = `${file}.engine-${String(process.pid)}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(temporary, buffer);
  await fsp.rename(temporary, file);
  return buffer.length;
}

/** Copy one session with a rewritten cwd; frames stay as they were. */
export async function copySessionWithCwd(sourceFile, targetFile, cwd) {
  const parsed = await readSessionFile(sourceFile);
  const { header, texts } = rewriteCwd(parsed, cwd);
  await writeSessionFile(targetFile, texts);
  return header;
}

/** Last event seq in a session file, or -1 when it cannot be read. */
export async function lastEventSeq(file) {
  try {
    const buffer = await fsp.readFile(file);
    const frames = scanFrames(buffer);
    if (frames.length === 0) return -1;
    const text = decodeFrames(buffer, [frames[frames.length - 1]]).toString('utf8');
    const rows = text.split('\n').filter((line) => line !== '');
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(rows[index]);
        if (Number.isInteger(parsed?.seq)) return parsed.seq;
      } catch {
        // A torn row carries no seq; keep looking backwards.
      }
    }
    return -1;
  } catch {
    return -1;
  }
}

/**
 * Seq of the last event that carries conversation content.
 *
 * Bookkeeping events (seed markers, job registration, sandbox or approval state)
 * are appended by the app on its own — opening a session can add one — and must
 * not make a log look newer than the other side.
 */
const CONTENT_EVENTS = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'developer/message',
  'system/message',
  'assistant/attempt',
]);

export async function lastContentSeq(file) {
  try {
    const buffer = await fsp.readFile(file);
    const frames = scanFrames(buffer);
    if (frames.length === 0) return -1;
    const tail = frames.slice(-12);
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const text = decodeFrames(buffer, [tail[index]]).toString('utf8');
      const rows = text.split('\n').filter((line) => line !== '');
      for (let row = rows.length - 1; row >= 0; row -= 1) {
        try {
          const parsed = JSON.parse(rows[row]);
          if (CONTENT_EVENTS.has(parsed?.type) && Number.isInteger(parsed?.seq)) return parsed.seq;
        } catch {
          // Torn rows are skipped.
        }
      }
    }
    return -1;
  } catch {
    return -1;
  }
}
