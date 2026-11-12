/**
 * Multi-frame zstd container used by DSH session logs.
 *
 * Node's zstd decoder stops at the first frame, so the frame boundaries have to
 * be walked by hand. The algorithm matches `tools/dsh-zstd-helper.js` and DSH's
 * own `scanZstdFrames`: a truncated tail (an append interrupted by a crash) is
 * dropped instead of failing the whole file.
 */
import zlib from 'node:zlib';

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 little-endian

/** Frame byte ranges of one buffer; empty when the file holds no complete frame. */
export function scanFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4 || buf.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buf.length) break;
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buf.length - offset < 3) return frames;
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return frames;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buf.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** Concatenated plaintext of every complete frame. */
export function decodeFrames(buf, frames = scanFrames(buf)) {
  const parts = [];
  for (const frame of frames) {
    parts.push(zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)));
  }
  return Buffer.concat(parts);
}

/** Whole-file decode; a plain .jsonl file is returned as-is. */
export function decodeBuffer(buf, isZstd = true) {
  if (!isZstd) return buf;
  const frames = scanFrames(buf);
  if (frames.length === 0) throw Object.assign(new Error('文件中没有完整的 zstd 帧（可能是残缺写入）'), { code: 'zstd-empty' });
  return decodeFrames(buf, frames);
}

/** Compress one frame's plaintext as a single zstd frame. */
export function encodeFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

/** Compress one line as its own frame, matching the append semantics. */
export function encodeLine(line) {
  return zlib.zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'));
}

/** Compress a list of lines into one multi-frame container. */
export function encodeLines(lines) {
  return Buffer.concat(lines.map((line) => encodeLine(line)));
}

/** Split decoded text into non-empty lines. */
export function splitLines(text) {
  return text.split('\n').filter((line) => line !== '');
}
