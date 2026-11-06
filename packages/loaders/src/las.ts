// ASPRS LAS point clouds, 1.0 to 1.4, point formats 0 to 10. LAZ goes through a caller-owned decompressor.
import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { latin1, limits, throwIfAborted, toBytes, type BinaryInput } from './util.js';

const F = 'LAS';
/** Bytes of each point format before any extra bytes. */
const RECORD = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
/** Where the gps time and the first colour channel sit in each point format; -1 for none. */
const GPS = [-1, 20, -1, 20, 20, 20, 22, 22, 22, 22, 22];
const RGB = [-1, -1, 20, 28, -1, 28, -1, 30, 30, -1, 30];
const COMPRESSED_BIT = 0x80;

/** A Variable Length Record of the file: its ids and bytes. */
export interface LASRecord {
  userId: string;
  recordId: number;
  description: string;
  data: Uint8Array;
}

/** The public header of a LAS file. */
export interface LASHeader {
  /** `[major, minor]`. */
  version: [number, number];
  pointFormat: number;
  pointRecordLength: number;
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  /** The software that wrote the file. */
  generator: string;
  /** True when the points are LAZ compressed. */
  compressed: boolean;
}

/** What a LAZ decompressor is given: the whole file with its header read. */
export interface LAZSource {
  bytes: Uint8Array;
  header: LASHeader;
  /** Where the compressed points start. */
  pointOffset: number;
  records: LASRecord[];
}

/** Options of {@link parseLAS}. `maxVertices` counts points. */
export interface LASOptions extends ParseLimits {
  /**
   * Turns LAZ points into plain point records, `pointRecordLength` bytes each and `pointCount` of them. Wrap the decoder
   * you load, such as a LASzip or laz-perf Wasm build. Without it a LAZ file is refused.
   */
  decompress?: (source: LAZSource) => Uint8Array | Promise<Uint8Array>;
  /** Keep every `step`th point. Default 1, all of them. */
  step?: number;
  signal?: AbortSignal;
}

/** What {@link parseLAS} returns: a point cloud with the survey's own attributes. */
export interface LASCloud extends LoadedGeometry {
  kind: 'points';
  header: LASHeader;
  /** The header's minimum corner. `positions` hold each point less this, so survey coordinates stay exact in 32 bits. */
  origin: [number, number, number];
  /** Pulse return strength per point, as stored. */
  intensity: Uint16Array;
  /** ASPRS class per point, such as 2 for ground. */
  classification: Uint8Array;
  /** Which return this point is, from 1. */
  returnNumber: Uint8Array;
  /** How many returns its pulse gave. */
  returnCount: Uint8Array;
  /** GPS time per point, in the formats that have it. */
  gpsTime?: Float64Array;
  records: LASRecord[];
}

function text(bytes: Uint8Array, start: number, size: number): string {
  let end = start;
  while (end < start + size && bytes[end]) end++;
  return latin1(bytes, start, end);
}

function readHeader(bytes: Uint8Array, view: DataView): LASHeader & { pointOffset: number; headerSize: number; vlrCount: number; evlrOffset: number; evlrCount: number } {
  if (bytes.length < 227) throw new LoaderError(F, 'header', 'the file is too small');
  if (latin1(bytes, 0, 4) !== 'LASF') throw new LoaderError(F, 'header', 'missing the LASF signature');
  const major = bytes[24],
    minor = bytes[25];
  if (major !== 1 || minor > 4) throw new LoaderError(F, 'unsupported', `version ${major}.${minor} is not read`);
  const raw = bytes[104],
    pointFormat = raw & 0x3f,
    compressed = (raw & COMPRESSED_BIT) !== 0;
  if (pointFormat >= RECORD.length) throw new LoaderError(F, 'unsupported', `point format ${pointFormat} is not read`);
  const pointRecordLength = view.getUint16(105, true);
  if (pointRecordLength < RECORD[pointFormat])
    throw new LoaderError(F, 'header', `a format ${pointFormat} point needs ${RECORD[pointFormat]} bytes, not ${pointRecordLength}`);
  let pointCount = view.getUint32(107, true),
    evlrOffset = 0,
    evlrCount = 0;
  const headerSize = view.getUint16(94, true);
  if (minor >= 4) {
    if (headerSize < 375 || bytes.length < 375) throw new LoaderError(F, 'header', 'a 1.4 header is 375 bytes');
    const wide = Number(view.getBigUint64(247, true));
    if (!Number.isSafeInteger(wide)) throw new LoaderError(F, 'range', 'the point count is too large');
    if (wide) pointCount = wide;
    evlrOffset = Number(view.getBigUint64(235, true));
    evlrCount = view.getUint32(243, true);
  }
  const double = (at: number): number => view.getFloat64(at, true),
    scale: [number, number, number] = [double(131), double(139), double(147)];
  if (!scale.every((value) => value !== 0 && Number.isFinite(value)))
    throw new LoaderError(F, 'range', 'the scale must be finite and not zero');
  return {
    version: [major, minor],
    pointFormat,
    pointRecordLength,
    pointCount,
    scale,
    offset: [double(155), double(163), double(171)],
    min: [double(187), double(203), double(219)],
    max: [double(179), double(195), double(211)],
    generator: text(bytes, 58, 32),
    compressed,
    pointOffset: view.getUint32(96, true),
    headerSize,
    vlrCount: view.getUint32(100, true),
    evlrOffset,
    evlrCount,
  };
}

function readRecords(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  count: number,
  extended: boolean,
  end: number,
): LASRecord[] {
  const records: LASRecord[] = [],
    head = extended ? 60 : 54;
  let pos = start;
  for (let i = 0; i < count; i++) {
    if (pos + head > end) throw new LoaderError(F, 'truncated', `variable record ${i} runs past its space`);
    const size = extended ? Number(view.getBigUint64(pos + 20, true)) : view.getUint16(pos + 20, true),
      from = pos + head;
    if (!Number.isSafeInteger(size) || from + size > end)
      throw new LoaderError(F, 'truncated', `variable record ${i} runs past its space`);
    records.push({
      userId: text(bytes, pos + 2, 16),
      recordId: view.getUint16(pos + 18, true),
      description: text(bytes, pos + (extended ? 28 : 22), 32),
      data: bytes.subarray(from, from + size),
    });
    pos = from + size;
  }
  return records;
}

/**
 * Reads an ASPRS LAS point cloud, versions 1.0 to 1.4 and point formats 0 to 10: positions by the file's scale and
 * offset, intensity, classification, returns, GPS time and colour, with the header and its variable records. Positions
 * are relative to `origin`, because survey coordinates are too large for 32-bit floats; add it back for world
 * coordinates. Colours are scaled to [0,1] from 16 bits, or from 8 for files that fill only the low byte.
 *
 * LAZ is the same layout behind an entropy coder. Pass `decompress`, a wrapper around a decoder you load, and the rest
 * reads as LAS. This package has no LAZ decoder of its own.
 *
 * @param input The file's bytes.
 * @param options The shared size limits, a LAZ decompressor, a thinning step and an AbortSignal.
 * @returns The cloud with its attributes, header and records.
 * @throws LoaderError with code `header`, `truncated`, `range`, `limit`, `aborted` or `unsupported` (a LAZ file with no
 * `decompress`, or an unknown version or point format).
 *
 * @example
 * ```ts
 * import { parseLAS } from '@margoengine/loaders/las';
 *
 * const bytes = await (await fetch('/surveys/quarry.las')).arrayBuffer();
 * const { positions, classification, origin } = await parseLAS(bytes, { step: 4 });
 * console.log(positions.length / 3, classification[0], origin);
 * ```
 */
export async function parseLAS(input: BinaryInput, options: LASOptions = {}): Promise<LASCloud> {
  const bytes = toBytes(input, F),
    { maxVertices } = limits(options, F),
    { signal, decompress } = options,
    step = options.step ?? 1;
  throwIfAborted(signal, F);
  if (!Number.isSafeInteger(step) || step < 1) throw new LoaderError(F, 'range', 'step must be a positive integer');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    { pointOffset, headerSize, vlrCount, evlrOffset, evlrCount, ...header } = readHeader(bytes, view),
    { pointFormat, pointRecordLength: size, pointCount, scale, offset } = header;
  if (pointOffset < headerSize || pointOffset > bytes.length)
    throw new LoaderError(F, 'header', `the points start at ${pointOffset}, outside the file`);
  const kept = Math.ceil(pointCount / step);
  if (kept > maxVertices) throw new LoaderError(F, 'limit', `${kept} points exceed the limit of ${maxVertices}`);
  const records = readRecords(bytes, view, headerSize, vlrCount, false, pointOffset);
  if (evlrCount) {
    if (evlrOffset < pointOffset || evlrOffset > bytes.length)
      throw new LoaderError(F, 'header', `the extended records start at ${evlrOffset}, outside the file`);
    records.push(...readRecords(bytes, view, evlrOffset, evlrCount, true, bytes.length));
  }

  let points = bytes.subarray(pointOffset),
    data = view,
    base = pointOffset;
  if (header.compressed) {
    if (!decompress)
      throw new LoaderError(F, 'unsupported', 'this is a LAZ file: pass a decompress option, or convert it to LAS');
    points = await decompress({ bytes, header, pointOffset, records });
    throwIfAborted(signal, F);
    data = new DataView(points.buffer, points.byteOffset, points.byteLength);
    base = 0;
  }
  if (points.length < pointCount * size)
    throw new LoaderError(F, 'truncated', `${points.length} bytes hold fewer than ${pointCount} points of ${size} bytes`);

  const positions = new Float32Array(kept * 3),
    intensity = new Uint16Array(kept),
    classification = new Uint8Array(kept),
    returnNumber = new Uint8Array(kept),
    returnCount = new Uint8Array(kept),
    gpsAt = GPS[pointFormat],
    rgbAt = RGB[pointFormat],
    gpsTime = gpsAt < 0 ? undefined : new Float64Array(kept),
    rgb = rgbAt < 0 ? undefined : new Uint16Array(kept * 3),
    wide = pointFormat >= 6,
    origin = header.min,
    shift = [offset[0] - origin[0], offset[1] - origin[1], offset[2] - origin[2]];
  for (let i = 0, p = 0; p < pointCount; i++, p += step) {
    if (!(i & 0xfffff)) throwIfAborted(signal, F);
    const at = base + p * size;
    // In doubles first, then less `origin`, so only the small part goes through 32 bits.
    positions[i * 3] = data.getInt32(at, true) * scale[0] + shift[0];
    positions[i * 3 + 1] = data.getInt32(at + 4, true) * scale[1] + shift[1];
    positions[i * 3 + 2] = data.getInt32(at + 8, true) * scale[2] + shift[2];
    intensity[i] = data.getUint16(at + 12, true);
    const flags = data.getUint8(at + 14);
    if (wide) {
      returnNumber[i] = flags & 15;
      returnCount[i] = flags >> 4;
      classification[i] = data.getUint8(at + 16);
    } else {
      returnNumber[i] = flags & 7;
      returnCount[i] = (flags >> 3) & 7;
      classification[i] = data.getUint8(at + 15) & 31;
    }
    if (gpsTime) gpsTime[i] = data.getFloat64(at + gpsAt, true);
    if (rgb)
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = data.getUint16(at + rgbAt + c * 2, true);
  }
  const cloud: LASCloud = {
    kind: 'points',
    positions,
    header,
    origin,
    intensity,
    classification,
    returnNumber,
    returnCount,
    records,
    attributes: { intensity: Float32Array.from(intensity), classification: Float32Array.from(classification) },
  };
  if (gpsTime) cloud.gpsTime = gpsTime;
  if (rgb) {
    let largest = 0;
    for (let i = 0; i < rgb.length; i++) if (rgb[i] > largest) largest = rgb[i];
    const full = largest > 255 ? 65535 : 255,
      colors = new Float32Array(rgb.length);
    for (let i = 0; i < rgb.length; i++) colors[i] = rgb[i] / full;
    cloud.colors = colors;
  }
  return cloud;
}
