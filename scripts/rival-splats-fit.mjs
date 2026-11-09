// Prefix of a degree-3 Gaussian PLY that fits the WebGPU minimum storage binding.
// Splats.attach keeps 16 coefficients per channel as float32 (192 bytes). Engine.create
// leaves maxStorageBufferBindingSize at the 128 MiB minimum, so a longer cloud is refused.
// The slice keeps the file's own vertex order. It does not read a rival library.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';

export const STORAGE_BINDING_BYTES = 134_217_728;
export const DEGREE3_SH_BYTES = 16 * 3 * 4;

const SIZES = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

/** Largest degree-3 cloud whose SH buffer fits `limit` bytes. */
export function fitDegree3Count(limit = STORAGE_BINDING_BYTES) {
  if (!Number.isInteger(limit) || limit < DEGREE3_SH_BYTES) throw new Error('storage limit');
  return Math.floor(limit / DEGREE3_SH_BYTES);
}

/** Header text, byte length of one vertex, and the vertex count the header names. */
export function readPlyPrefix(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(65_536);
    const n = readSync(fd, head, 0, head.length, 0);
    const text = head.subarray(0, n).toString('latin1');
    const end = text.indexOf('end_header\n');
    if (end < 0) throw new Error('PLY header is longer than 64 KiB or has no end_header');
    const header = text.slice(0, end + 'end_header\n'.length);
    if (!header.includes('format binary_little_endian 1.0')) throw new Error('PLY is not binary little endian');
    const count = Number(/^element vertex (\d+)$/m.exec(header)?.[1]);
    if (!Number.isInteger(count) || count < 1) throw new Error('PLY vertex count');
    let stride = 0;
    let inVertex = false;
    for (const line of header.split('\n')) {
      if (line.startsWith('element ')) inVertex = line.startsWith('element vertex ');
      else if (inVertex && line.startsWith('property ')) {
        const type = line.split(/\s+/)[1];
        const size = SIZES[type];
        if (!size) throw new Error(`PLY property type ${type} is not a scalar`);
        stride += size;
      }
    }
    if (stride < 1) throw new Error('PLY vertex has no properties');
    return { header, headerBytes: Buffer.byteLength(header, 'latin1'), stride, count };
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes the first `count` vertices of `source` to `dest`, with the header count rewritten.
 * A dest of the right size is left as it is.
 * @returns {Promise<{ count: number, sourceCount: number, stride: number, bytes: number }>}
 */
export async function writePlyPrefix(source, dest, count) {
  const info = readPlyPrefix(source);
  const keep = Math.min(count, info.count);
  const header = info.header.replace(/^element vertex \d+$/m, `element vertex ${keep}`);
  const bytes = Buffer.byteLength(header, 'latin1') + keep * info.stride;
  const result = { count: keep, sourceCount: info.count, stride: info.stride, bytes };
  if (existsSync(dest) && statSync(dest).size === bytes) return result;
  const src = await open(source, 'r');
  const dst = await open(dest, 'w');
  try {
    const head = Buffer.from(header, 'latin1');
    await dst.write(head, 0, head.length, 0);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    let left = keep * info.stride;
    let at = info.headerBytes;
    let outAt = head.length;
    while (left > 0) {
      const want = Math.min(chunk.length, left);
      const { bytesRead } = await src.read(chunk, 0, want, at);
      if (bytesRead !== want) throw new Error('PLY body ended before the vertex count');
      await dst.write(chunk, 0, bytesRead, outAt);
      at += bytesRead;
      outAt += bytesRead;
      left -= bytesRead;
    }
  } finally {
    await src.close();
    await dst.close();
  }
  return result;
}
