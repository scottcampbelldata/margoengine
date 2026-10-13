import {LoaderError} from './types.js';
import {throwIfAborted, toBytes, type BinaryInput} from './util.js';

const F = 'ZIP';

export interface ZipEntry {
  /** Entry path as stored (forward slashes). */
  name: string;
  /** 0 stored, 8 deflate. */
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  /** Offset of the local file header. */
  headerOffset: number;
}

export interface ZipOptions {
  /** Maximum entries in the central directory. Default 10,000. */
  maxEntries?: number;
  /** Maximum uncompressed size of one entry. Default 512 MiB. */
  maxEntryBytes?: number;
  signal?: AbortSignal;
}

let table: Uint32Array | undefined;
/** CRC-32 (IEEE) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0;}
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Lists the entries of a ZIP archive from its central directory. ZIP64, encryption and multi-disk archives are rejected. */
export function readZipDirectory(input: BinaryInput, options: ZipOptions = {}): ZipEntry[] {
  const bytes = toBytes(input, F), maxEntries = options.maxEntries ?? 10_000;
  throwIfAborted(options.signal, F);
  if (Number.isNaN(maxEntries)) throw new LoaderError(F, 'range', 'maxEntries must not be NaN');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw new LoaderError(F, 'truncated', 'file is too small to be a ZIP archive');
  let eocd = -1;
  for (let i = bytes.length - 22, stop = Math.max(0, bytes.length - 22 - 65535); i >= stop; i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) <= bytes.length) {eocd = i; break;}
  }
  if (eocd < 0) throw new LoaderError(F, 'zip', 'end of central directory not found (not a ZIP archive or truncated)');
  const disk = view.getUint16(eocd + 4, true), cdDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true), cdSize = view.getUint32(eocd + 12, true), cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new LoaderError(F, 'unsupported', 'ZIP64 archives are not supported');
  if (disk !== 0 || cdDisk !== 0) throw new LoaderError(F, 'unsupported', 'multi-disk archives are not supported');
  if (count > maxEntries) throw new LoaderError(F, 'limit', `archive has ${count} entries, more than the limit of ${maxEntries}`);
  if (cdOffset + cdSize > eocd) throw new LoaderError(F, 'zip', 'central directory lies outside the archive');
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || view.getUint32(p, true) !== 0x02014b50) throw new LoaderError(F, 'zip', `central directory entry ${i} is corrupt`);
    const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true);
    const nameLength = view.getUint16(p + 28, true), extraLength = view.getUint16(p + 30, true), commentLength = view.getUint16(p + 32, true);
    if (p + 46 + nameLength + extraLength + commentLength > cdOffset + cdSize) throw new LoaderError(F, 'zip', `central directory entry ${i} name, extra field or comment overflows`);
    const entry: ZipEntry = {
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)), method,
      crc32: view.getUint32(p + 16, true), compressedSize: view.getUint32(p + 20, true), size: view.getUint32(p + 24, true),
      headerOffset: view.getUint32(p + 42, true),
    };
    if (flags & 1) throw new LoaderError(F, 'unsupported', `entry "${entry.name}" is encrypted`);
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.headerOffset === 0xffffffff) throw new LoaderError(F, 'unsupported', 'ZIP64 entries are not supported');
    entries.push(entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflate(data: Uint8Array, size: number, name: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new LoaderError(F, 'unsupported', 'DecompressionStream is not available in this runtime');
  const stream = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(data); controller.close();}}).pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader(), output = new Uint8Array(size);
  let length = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new LoaderError(F, 'aborted', 'aborted');
      const {done, value} = await reader.read();
      if (done) break;
      if (length + value.length > size) throw new LoaderError(F, 'zip', `entry "${name}" inflates past its declared size of ${size} bytes`);
      output.set(value, length);
      length += value.length;
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof LoaderError) throw error;
    throw new LoaderError(F, 'zip', `entry "${name}" has corrupt deflate data (${(error as Error)?.message ?? error})`);
  }
  if (length !== size) throw new LoaderError(F, 'zip', `entry "${name}" inflated to ${length} bytes, expected ${size}`);
  return output;
}

/** Reads and verifies (size and CRC-32) one entry. Supports stored (0) and deflate (8) entries. */
export async function readZipEntry(input: BinaryInput, entry: ZipEntry, options: ZipOptions = {}): Promise<Uint8Array> {
  const bytes = toBytes(input, F), maxBytes = options.maxEntryBytes ?? 512 * 1024 * 1024;
  throwIfAborted(options.signal, F);
  if (Number.isNaN(maxBytes)) throw new LoaderError(F, 'range', 'maxEntryBytes must not be NaN');
  if (entry.size > maxBytes) throw new LoaderError(F, 'limit', `entry "${entry.name}" is ${entry.size} bytes, more than the limit of ${maxBytes}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), p = entry.headerOffset;
  if (p + 30 > bytes.length || view.getUint32(p, true) !== 0x04034b50) throw new LoaderError(F, 'zip', `local header of "${entry.name}" is missing`);
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true), end = start + entry.compressedSize;
  if (end > bytes.length) throw new LoaderError(F, 'truncated', `data of "${entry.name}" runs past the end of the archive`);
  const data = bytes.subarray(start, end);
  let output: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new LoaderError(F, 'zip', `stored entry "${entry.name}" has mismatched sizes`);
    output = data;
  } else if (entry.method === 8) output = await inflate(data, entry.size, entry.name, options.signal);
  else throw new LoaderError(F, 'unsupported', `entry "${entry.name}" uses compression method ${entry.method}; only stored and deflate are supported`);
  if (crc32(output) !== entry.crc32) throw new LoaderError(F, 'zip', `entry "${entry.name}" fails its CRC-32 check`);
  return output;
}
