// LAZ (LASzip compressed LAS) writer, the mirror of the decoder in laz.ts, written clean room from the same public
// descriptions: M. Isenburg, "LASzip: lossless compression of LiDAR data", Photogrammetric Engineering and Remote
// Sensing 79(2), 2013, https://doi.org/10.14358/PERS.79.2.209; the public LAZ format specification
// (https://github.com/ASPRSorg/LAS, "LAZ Specification 1.4"); ASPRS, LAS Specification 1.4 R15; and the range coding
// literature (I. H. Witten, R. M. Neal and J. G. Cleary, CACM 30(6), 1987; A. Said, HP Labs HPL-2004-76, 2004). No
// source code of LASzip, laz-perf, PDAL, lazrs or any other writer was read.
import { type LASWriteInput, readLASHeader, writeLAS } from './las.js';
import { chunk, chunkTable, itemsOf, lazRecord } from './laz-encode.js';

/** Options of {@link compressLAZ} and {@link writeLAZ}. */
export interface LazWriteOptions {
  /** Points per chunk, 1 to 4,294,967,294. Default 50,000: a reader seeks to a chunk, and smaller chunks compress less. */
  chunkSize?: number;
  /** The point count of each chunk in turn, for variable chunks (as an octree's nodes have); they add up to every point. */
  chunks?: readonly number[];
}

/** The point counts of the chunks, from the options. */
function chunkCounts(points: number, options: LazWriteOptions): number[] {
  const { chunks, chunkSize = 50_000 } = options;
  if (chunks) {
    if (options.chunkSize !== undefined) throw new RangeError('Pass chunkSize or chunks, not both');
    let sum = 0;
    for (const n of chunks) {
      if (!Number.isInteger(n) || n < 1) throw new RangeError('Every chunk needs a whole number of points, 1 or more');
      sum += n;
    }
    if (sum !== points) throw new RangeError(`chunks hold ${sum} points; the file has ${points}`);
    return [...chunks];
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize >= 0xffffffff)
    throw new RangeError('chunkSize must be a whole number from 1 to 4294967294');
  const counts: number[] = [];
  for (let left = points; left > 0; left -= chunkSize) counts.push(Math.min(chunkSize, left));
  return counts;
}

/**
 * Compresses a LAS file to LAZ, losslessly: every point record, extra bytes included, decompresses byte for byte, and
 * the header, variable length records and extended records are kept. The compressed points are the bytes LASzip writes
 * for the same records and chunks.
 *
 * @param input An uncompressed LAS file, versions 1.0 to 1.5, point formats 0 to 10.
 * @param options Points per chunk, or each chunk's count.
 * @returns The LAZ file.
 * @throws TypeError for bytes that are not an uncompressed LAS file or whose points or records are cut off.
 * @throws RangeError for a bad chunk size or chunk counts.
 *
 * @example
 * ```ts
 * import { compressLAZ } from '@margoengine/points/laz-write';
 *
 * const las = new Uint8Array(await (await fetch('/scans/site.las')).arrayBuffer());
 * const laz = compressLAZ(las);
 * console.log(laz.length / las.length);
 * ```
 */
export function compressLAZ(input: ArrayBuffer | Uint8Array, options: LazWriteOptions = {}): Uint8Array {
  const file = input instanceof Uint8Array ? input : new Uint8Array(input),
    { header } = readLASHeader(file);
  if (file[104] & 0xc0)
    throw new TypeError('The file is already compressed; compressLAZ takes an uncompressed LAS file');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    { pointDataOffset, pointRecordLength: length, pointFormat: format, pointCount: count } = header,
    pointsEnd = pointDataOffset + count * length,
    headerSize = view.getUint16(94, true),
    minor = header.versionMinor;
  if (!Number.isSafeInteger(pointsEnd) || pointsEnd > file.length)
    throw new TypeError(`The LAS file ends before its ${count} points of ${length} bytes; it is cut off`);
  // The records before the points, without a stale LASzip record, then whatever pads them to the points.
  const records: Uint8Array[] = [];
  let next = headerSize,
    kept = 0;
  for (let i = 0, total = view.getUint32(100, true); i < total; i++) {
    const size = next + 54 <= pointDataOffset ? 54 + view.getUint16(next + 20, true) : Number.POSITIVE_INFINITY;
    if (next + size > pointDataOffset) throw new TypeError('A variable length record runs into the points; the LAS file is damaged, so pass an intact one');
    if (view.getUint16(next + 18, true) !== 22204) {
      records.push(file.subarray(next, next + size));
      kept++;
    }
    next += size;
  }
  const items = itemsOf(format, length),
    counts = chunkCounts(count, options),
    record = lazRecord(items, options.chunks ? 0xffffffff : (options.chunkSize ?? 50_000));
  const head = file.slice(0, headerSize),
    padding = file.subarray(next, pointDataOffset),
    before = [head, ...records, record, padding],
    start = before.reduce((sum, part) => sum + part.length, 0),
    points = file.subarray(pointDataOffset, pointsEnd),
    pointView = new DataView(points.buffer, points.byteOffset, points.byteLength),
    body: Uint8Array[] = [],
    sizes: number[] = [];
  let first = 0,
    compressed = 0;
  for (const n of counts) {
    let size = 0;
    for (const part of chunk(points, pointView, first * length, n, length, items)) {
      // A coder's bytes are a view of its larger buffer; the copy lets the buffer go.
      const held = part.byteLength === part.buffer.byteLength ? part : part.slice();
      body.push(held);
      size += held.length;
    }
    sizes.push(size);
    compressed += size;
    first += n;
  }
  const table = chunkTable(sizes, options.chunks ? counts : undefined),
    tableOffset = start + 8 + compressed,
    offset = new DataView(new ArrayBuffer(8));
  offset.setBigInt64(0, BigInt(tableOffset), true);
  const end = tableOffset + table.reduce((sum, part) => sum + part.length, 0),
    out = new DataView(head.buffer);
  // What follows the points (extended records, waveform packets) moves to follow the chunk table.
  const starts: [field: number, at: number][] = [];
  if (minor >= 3 && headerSize >= 235) {
    const wave = Number(view.getBigUint64(227, true));
    if (wave) starts.push([227, wave]);
  }
  if (minor >= 4 && headerSize >= 375 && view.getUint32(243, true))
    starts.push([235, Number(view.getBigUint64(235, true))]);
  let tail = file.length;
  for (const [, from] of starts) {
    if (from < pointsEnd || from > file.length)
      throw new TypeError('The header places extended records outside the bytes after the points; the file is corrupt');
    tail = Math.min(tail, from);
  }
  for (const [field, from] of starts) out.setBigUint64(field, BigInt(end + from - tail), true);
  out.setUint32(96, start, true);
  out.setUint32(100, kept + 1, true);
  out.setUint8(104, format | 0x80);
  const parts = [...before, new Uint8Array(offset.buffer), ...body, ...table, file.subarray(tail)],
    result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let to = 0;
  for (const part of parts) {
    result.set(part, to);
    to += part.length;
  }
  return result;
}

/**
 * Writes points as LAZ: {@link writeLAS}'s file, compressed by {@link compressLAZ}.
 *
 * @param input World positions and any attributes of the point format, as `writeLAS` takes them.
 * @param options Points per chunk, or each chunk's count.
 * @returns The LAZ file.
 * @throws RangeError for input `writeLAS` refuses and for bad chunk options.
 *
 * @example
 * ```ts
 * import { writeLAZ } from '@margoengine/points/laz-write';
 *
 * const laz = writeLAZ({ positions: [0, 0, 0, 1, 2, 3], wkt: 'GEOGCS["WGS 84"]' });
 * console.log(laz.length);
 * ```
 */
export function writeLAZ(input: LASWriteInput, options: LazWriteOptions = {}): Uint8Array {
  return compressLAZ(writeLAS(input), options);
}
