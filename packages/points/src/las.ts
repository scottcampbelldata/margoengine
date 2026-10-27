// ASPRS LAS 1.0 to 1.4 reader and writer: the public header block, VLRs and EVLRs, point data record formats 0 to 10,
// extra bytes (the LASF_Spec record 4 descriptors) and the coordinate reference system records (OGC WKT 2112 and the
// GeoTIFF keys 34735 to 34737). Written from the ASPRS LAS specifications 1.2 (2008), 1.3 R11 (2010) and 1.4 R15
// (2019). Every offset is checked against the bytes: truncated or corrupt files throw a TypeError or RangeError that
// names the problem, and never read out of bounds. LAZ (compressed) files need a decoder: see `LazDecoder`.
import { MargoError } from '@margoengine/math/errors';

/** One variable length record (VLR) or extended VLR (EVLR). */
export interface LASRecord {
  readonly userId: string;
  readonly recordId: number;
  readonly description: string;
  readonly data: Uint8Array;
  readonly extended: boolean;
}

/** An extra bytes attribute (LASF_Spec record 4). */
export interface LASExtraBytes {
  readonly name: string;
  readonly description: string;
  /** 1 u8, 2 i8, 3 u16, 4 i16, 5 u32, 6 i32, 7 u64, 8 i64, 9 f32, 10 f64; 0 = undocumented bytes. */
  readonly dataType: number;
  /** Byte offset inside the extra bytes of each record, and size. */
  readonly offset: number;
  readonly size: number;
  readonly scale: number;
  readonly addOffset: number;
  readonly noData?: number;
}

/** The public header block. */
export interface LASHeader {
  readonly versionMajor: number;
  readonly versionMinor: number;
  readonly fileSourceId: number;
  readonly globalEncoding: number;
  readonly projectId: string;
  readonly systemIdentifier: string;
  readonly generatingSoftware: string;
  readonly creationDay: number;
  readonly creationYear: number;
  readonly headerSize: number;
  readonly pointDataOffset: number;
  /** Point data record format 0 to 10 (the compression bit 7 removed); see `compressed`. */
  readonly pointFormat: number;
  /** True for LAZ: bit 7 (or 6) of the format byte is set. */
  readonly compressed: boolean;
  readonly pointRecordLength: number;
  readonly pointCount: number;
  readonly pointsByReturn: readonly number[];
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** The coordinate reference system, when the file names one. */
export interface LASCrs {
  /** OGC WKT (record 2112), when present. */
  readonly wkt?: string;
  /** EPSG code of the horizontal CRS (ProjectedCSTypeGeoKey 3072 or GeographicTypeGeoKey 2048). */
  readonly epsg?: number;
  /** EPSG code of the vertical CRS (VerticalCSTypeGeoKey 4096). */
  readonly verticalEpsg?: number;
  /** All GeoTIFF keys as id to value (numbers, or text for ASCII keys). */
  readonly geoKeys?: ReadonlyMap<number, number | string | readonly number[]>;
}

/** Decoded points: float32 positions relative to `origin`, and every attribute of the format. */
export interface LASPoints {
  readonly header: LASHeader;
  readonly records: readonly LASRecord[];
  readonly crs?: LASCrs;
  readonly extraBytes: readonly LASExtraBytes[];
  /** Points decoded (fewer than header.pointCount with `maxPoints`, a stride or a file cut short when `partial`). */
  readonly count: number;
  /** World position of local [0, 0, 0] (float64): the bounding box centre unless `origin` was given. */
  readonly origin: readonly [number, number, number];
  /** xyz per point relative to `origin`, float32 (sub-millimetre for a scan a few kilometres across). */
  readonly positions: Float32Array;
  readonly intensity: Uint16Array;
  readonly returnNumber: Uint8Array;
  readonly numberOfReturns: Uint8Array;
  /** ASPRS class (0 to 31 for formats 0 to 5, 0 to 255 for 6 to 10). */
  readonly classification: Uint8Array;
  /** Bit 0 synthetic, 1 key-point, 2 withheld, 3 overlap. */
  readonly classificationFlags: Uint8Array;
  readonly scanDirection: Uint8Array;
  readonly edgeOfFlightLine: Uint8Array;
  /** Scan angle in degrees. */
  readonly scanAngle: Float32Array;
  readonly userData: Uint8Array;
  readonly pointSourceId: Uint16Array;
  readonly scannerChannel?: Uint8Array;
  readonly gpsTime?: Float64Array;
  /** RGB per point, 16-bit as stored. */
  readonly rgb?: Uint16Array;
  readonly nir?: Uint16Array;
  /** Extra bytes attributes, scaled and offset, by name. */
  readonly extra: Readonly<Record<string, Float64Array>>;
}

/** Decompresses LAZ point data into uncompressed LAS records (the decoder is not part of this package yet). */
export type LazDecoder = (
  file: Uint8Array,
  header: LASHeader,
  records: readonly LASRecord[],
  signal?: AbortSignal,
) => Uint8Array | Promise<Uint8Array>;

/** Options of `parseLAS`. */
export interface LASOptions {
  /** World position to store positions relative to. Default: the header's bounding box centre. */
  origin?: readonly [number, number, number];
  /** Decode at most this many points. Default: all. */
  maxPoints?: number;
  /** Keep every n-th point (a quick preview). Default 1. */
  stride?: number;
  /** Decompressor for LAZ files. Without it a LAZ file throws a MargoError with code `unsupported`. */
  laz?: LazDecoder;
  /** Accept a file whose point data is cut short (decode what is there). Default false: throw a RangeError. */
  partial?: boolean;
  signal?: AbortSignal;
}

/** Size in bytes of each standard point record format, 0 to 10. */
export const LAS_RECORD_SIZES: readonly number[] = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
const GPS_OFFSET = [-1, 20, -1, 20, 20, 20, 22, 22, 22, 22, 22],
  RGB_OFFSET = [-1, -1, 20, 28, -1, 28, -1, 30, 30, -1, 30];
const EXTRA_SIZE = [0, 1, 1, 2, 2, 4, 4, 8, 8, 4, 8];

const latin1 = /* @__PURE__ */ new TextDecoder('latin1');
const text = (bytes: Uint8Array, at: number, length: number) => {
  const slice = bytes.subarray(at, at + length),
    end = slice.indexOf(0);
  return latin1.decode(end < 0 ? slice : slice.subarray(0, end)).trimEnd();
};

/** Reads only the header and records (cheap: no point data is touched). */
export function readLASHeader(input: ArrayBuffer | Uint8Array): { header: LASHeader; records: LASRecord[] } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 227) throw new RangeError('LAS file shorter than its 227-byte header; the file is truncated');
  if (text(bytes, 0, 4) !== 'LASF') throw new TypeError('Not a LAS file (no LASF signature); pass a .las or .laz file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    u8 = (o: number) => view.getUint8(o),
    u16 = (o: number) => view.getUint16(o, true),
    u32 = (o: number) => view.getUint32(o, true),
    f64 = (o: number) => view.getFloat64(o, true),
    u64 = (o: number) => Number(view.getBigUint64(o, true));
  const versionMajor = u8(24),
    versionMinor = u8(25),
    headerSize = u16(94),
    pointDataOffset = u32(96),
    vlrCount = u32(100),
    formatByte = u8(104),
    pointRecordLength = u16(105);
  if (versionMajor !== 1 || versionMinor > 4)
    throw new TypeError(`Unsupported LAS version ${versionMajor}.${versionMinor}; read LAS 1.0 to 1.4`);
  if (headerSize < 227 || headerSize > bytes.byteLength || pointDataOffset < headerSize)
    throw new RangeError(
      `LAS header size ${headerSize} or point offset ${pointDataOffset} is invalid; the file is corrupt`,
    );
  const pointFormat = formatByte & 0x3f,
    compressed = (formatByte & 0xc0) !== 0;
  if (pointFormat > 10) throw new TypeError(`Unsupported LAS point format ${pointFormat}; formats 0 to 10 exist`);
  if (pointRecordLength < LAS_RECORD_SIZES[pointFormat])
    throw new RangeError(
      `LAS record length ${pointRecordLength} is shorter than format ${pointFormat}'s ${LAS_RECORD_SIZES[pointFormat]} bytes; the file is corrupt`,
    );
  let pointCount = u32(107);
  let pointsByReturn = [0, 1, 2, 3, 4].map((i) => u32(111 + i * 4));
  const v14 = versionMinor >= 4 && headerSize >= 375;
  if (v14) {
    const count64 = u64(247);
    if (count64 || !pointCount) pointCount = count64;
    pointsByReturn = Array.from({ length: 15 }, (_, i) => u64(255 + i * 8));
  }
  const header: LASHeader = {
    versionMajor,
    versionMinor,
    fileSourceId: u16(4),
    globalEncoding: u16(6),
    projectId: [...bytes.subarray(8, 24)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    systemIdentifier: text(bytes, 26, 32),
    generatingSoftware: text(bytes, 58, 32),
    creationDay: u16(90),
    creationYear: u16(92),
    headerSize,
    pointDataOffset,
    pointFormat,
    compressed,
    pointRecordLength,
    pointCount,
    pointsByReturn,
    scale: [f64(131), f64(139), f64(147)],
    offset: [f64(155), f64(163), f64(171)],
    max: [f64(179), f64(195), f64(211)],
    min: [f64(187), f64(203), f64(219)],
  };
  if (!header.scale.every((s) => Number.isFinite(s) && s !== 0) || !header.offset.every(Number.isFinite))
    throw new RangeError('LAS scale or offset is zero or not finite; the file is corrupt');
  const records: LASRecord[] = [];
  let at = headerSize;
  for (let i = 0; i < vlrCount; i++) {
    if (at + 54 > pointDataOffset || at + 54 > bytes.byteLength)
      throw new RangeError(`LAS VLR ${i} header runs past the point data offset; the file is corrupt`);
    const length = u16(at + 20);
    if (at + 54 + length > pointDataOffset || at + 54 + length > bytes.byteLength)
      throw new RangeError(`LAS VLR ${i} data runs past the point data offset; the file is corrupt`);
    records.push({
      userId: text(bytes, at + 2, 16),
      recordId: u16(at + 18),
      description: text(bytes, at + 22, 32),
      data: bytes.subarray(at + 54, at + 54 + length),
      extended: false,
    });
    at += 54 + length;
  }
  if (v14) {
    let evlr = u64(235);
    const evlrCount = u32(243);
    for (let i = 0; i < evlrCount && evlr; i++) {
      if (evlr + 60 > bytes.byteLength) {
        // EVLRs sit after the point data; a cut file loses them, which `partial` reading accepts.
        break;
      }
      const length = u64(evlr + 20);
      if (evlr + 60 + length > bytes.byteLength) break;
      records.push({
        userId: text(bytes, evlr + 2, 16),
        recordId: u16(evlr + 18),
        description: text(bytes, evlr + 28, 32),
        data: bytes.subarray(evlr + 60, evlr + 60 + length),
        extended: true,
      });
      evlr += 60 + length;
    }
  }
  return { header, records };
}

/** The extra bytes descriptors (LASF_Spec record 4), laid out in record order. */
export function lasExtraBytes(records: readonly LASRecord[], header: LASHeader): LASExtraBytes[] {
  const record = records.find((r) => r.userId === 'LASF_Spec' && r.recordId === 4);
  if (!record) return [];
  const available = header.pointRecordLength - LAS_RECORD_SIZES[header.pointFormat],
    view = new DataView(record.data.buffer, record.data.byteOffset, record.data.byteLength),
    out: LASExtraBytes[] = [];
  let offset = 0;
  for (let at = 0; at + 192 <= record.data.byteLength; at += 192) {
    const dataType = view.getUint8(at + 2),
      options = view.getUint8(at + 3);
    if (dataType > 10)
      throw new TypeError(
        `Extra bytes data type ${dataType} is deprecated or unknown; rewrite the file with scalar extra bytes (types 1 to 10)`,
      );
    const size = dataType === 0 ? options : EXTRA_SIZE[dataType];
    const name = text(record.data, at + 4, 32);
    if (offset + size > available)
      throw new RangeError(`Extra bytes ${name} pass the record length; the file is corrupt`);
    const number = (o: number) =>
      dataType >= 9
        ? view.getFloat64(o, true)
        : dataType % 2 === 0 && dataType
          ? Number(view.getBigInt64(o, true))
          : Number(view.getBigUint64(o, true));
    out.push({
      name,
      description: text(record.data, at + 160, 32),
      dataType,
      offset,
      size,
      scale: options & 8 ? view.getFloat64(at + 112, true) : 1,
      addOffset: options & 16 ? view.getFloat64(at + 136, true) : 0,
      noData: options & 1 ? number(at + 40) : undefined,
    });
    offset += size;
  }
  return out;
}

/** The CRS records: OGC WKT (2112) and GeoTIFF keys (34735, with doubles 34736 and ASCII 34737). */
export function lasCrs(records: readonly LASRecord[]): LASCrs | undefined {
  const find = (id: number) => records.find((r) => r.userId === 'LASF_Projection' && r.recordId === id);
  const wktRecord = find(2112),
    keysRecord = find(34735);
  if (!wktRecord && !keysRecord) return undefined;
  const wkt = wktRecord ? text(wktRecord.data, 0, wktRecord.data.byteLength) : undefined;
  let geoKeys: Map<number, number | string | readonly number[]> | undefined,
    epsg: number | undefined,
    verticalEpsg: number | undefined;
  if (keysRecord && keysRecord.data.byteLength >= 8) {
    const v = new DataView(keysRecord.data.buffer, keysRecord.data.byteOffset, keysRecord.data.byteLength),
      n = v.getUint16(6, true),
      doubles = find(34736),
      ascii = find(34737);
    geoKeys = new Map();
    for (let i = 0; i < n && 8 + i * 8 + 8 <= keysRecord.data.byteLength; i++) {
      const o = 8 + i * 8,
        id = v.getUint16(o, true),
        location = v.getUint16(o + 2, true),
        count = v.getUint16(o + 4, true),
        value = v.getUint16(o + 6, true);
      if (location === 0) geoKeys.set(id, value);
      else if (location === 34736 && doubles) {
        const d = new DataView(doubles.data.buffer, doubles.data.byteOffset, doubles.data.byteLength),
          values: number[] = [];
        for (let k = 0; k < count && (value + k) * 8 + 8 <= doubles.data.byteLength; k++)
          values.push(d.getFloat64((value + k) * 8, true));
        geoKeys.set(id, count === 1 ? values[0] : values);
      } else if (location === 34737 && ascii)
        geoKeys.set(id, latin1.decode(ascii.data.subarray(value, value + count)).replace(/[|\0]+$/, ''));
    }
    const projected = geoKeys.get(3072),
      geographic = geoKeys.get(2048),
      vertical = geoKeys.get(4096);
    const code = (v: unknown) => (typeof v === 'number' && v > 0 && v < 32767 ? v : undefined);
    epsg = code(projected) ?? code(geographic);
    verticalEpsg = code(vertical);
  }
  if (epsg === undefined && wkt) {
    // The outermost AUTHORITY["EPSG","n"] (WKT1) or ID["EPSG",n] (WKT2) is the CRS's own code.
    const all = [...wkt.matchAll(/(?:AUTHORITY|ID)\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/g)];
    if (all.length) epsg = Number(all[all.length - 1][1]);
  }
  return { wkt, epsg, verticalEpsg, geoKeys };
}

/** Parses a LAS file (or a LAZ file with `options.laz`). */
export async function parseLAS(input: ArrayBuffer | Uint8Array, options: LASOptions = {}): Promise<LASPoints> {
  options.signal?.throwIfAborted();
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { header, records } = readLASHeader(bytes);
  let data: Uint8Array;
  if (header.compressed) {
    if (!options.laz)
      throw new MargoError(
        'unsupported',
        'LAZ (compressed LAS) needs a decoder; pass options.laz, or decompress the file to LAS first',
      );
    data = await options.laz(bytes, header, records, options.signal);
    options.signal?.throwIfAborted();
  } else data = bytes.subarray(header.pointDataOffset);
  return decodePoints(header, records, data, options);
}

/** Decodes uncompressed point records (what a LAZ decoder returns, or the file after the point data offset). */
export function decodePoints(
  header: LASHeader,
  records: readonly LASRecord[],
  data: Uint8Array,
  options: LASOptions = {},
): LASPoints {
  const length = header.pointRecordLength,
    format = header.pointFormat,
    stride = options.stride ?? 1,
    max = options.maxPoints ?? Infinity;
  if (!Number.isInteger(stride) || stride < 1) throw new RangeError('Invalid stride; pass a whole number of 1 or more');
  if (!(max >= 0)) throw new RangeError('Invalid maxPoints; pass a number of 0 or more');
  const available = Math.floor(data.byteLength / length);
  if (available < header.pointCount && !options.partial)
    throw new RangeError(
      `LAS point data holds ${available} of ${header.pointCount} records; the file is truncated (pass partial: true to read what is there)`,
    );
  const total = Math.min(header.pointCount, available),
    count = Math.min(Math.ceil(total / stride), max);
  const extraBytes = lasExtraBytes(records, header),
    crs = lasCrs(records),
    origin = options.origin ?? ([0, 1, 2].map((i) => (header.min[i] + header.max[i]) / 2) as [number, number, number]);
  const extended = format >= 6,
    hasGps = GPS_OFFSET[format] >= 0,
    hasRgb = RGB_OFFSET[format] >= 0,
    hasNir = format === 8 || format === 10;
  const positions = new Float32Array(count * 3),
    intensity = new Uint16Array(count),
    returnNumber = new Uint8Array(count),
    numberOfReturns = new Uint8Array(count),
    classification = new Uint8Array(count),
    classificationFlags = new Uint8Array(count),
    scanDirection = new Uint8Array(count),
    edgeOfFlightLine = new Uint8Array(count),
    scanAngle = new Float32Array(count),
    userData = new Uint8Array(count),
    pointSourceId = new Uint16Array(count),
    scannerChannel = extended ? new Uint8Array(count) : undefined,
    gpsTime = hasGps ? new Float64Array(count) : undefined,
    rgb = hasRgb ? new Uint16Array(count * 3) : undefined,
    nir = hasNir ? new Uint16Array(count) : undefined,
    extra: Record<string, Float64Array> = {};
  for (const e of extraBytes) if (e.dataType) extra[e.name] = new Float64Array(count);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    [sx, sy, sz] = header.scale,
    [ox, oy, oz] = header.offset,
    base = LAS_RECORD_SIZES[format];
  for (let i = 0; i < count; i++) {
    const at = i * stride * length;
    positions[i * 3] = view.getInt32(at, true) * sx + ox - origin[0];
    positions[i * 3 + 1] = view.getInt32(at + 4, true) * sy + oy - origin[1];
    positions[i * 3 + 2] = view.getInt32(at + 8, true) * sz + oz - origin[2];
    intensity[i] = view.getUint16(at + 12, true);
    const bits = view.getUint8(at + 14);
    if (extended) {
      returnNumber[i] = bits & 15;
      numberOfReturns[i] = bits >> 4;
      const flags = view.getUint8(at + 15);
      classificationFlags[i] = flags & 15;
      scannerChannel![i] = (flags >> 4) & 3;
      scanDirection[i] = (flags >> 6) & 1;
      edgeOfFlightLine[i] = flags >> 7;
      classification[i] = view.getUint8(at + 16);
      userData[i] = view.getUint8(at + 17);
      scanAngle[i] = view.getInt16(at + 18, true) * 0.006;
      pointSourceId[i] = view.getUint16(at + 20, true);
    } else {
      returnNumber[i] = bits & 7;
      numberOfReturns[i] = (bits >> 3) & 7;
      scanDirection[i] = (bits >> 6) & 1;
      edgeOfFlightLine[i] = bits >> 7;
      const c = view.getUint8(at + 15);
      classification[i] = c & 31;
      classificationFlags[i] = (c >> 5) & 7;
      scanAngle[i] = view.getInt8(at + 16);
      userData[i] = view.getUint8(at + 17);
      pointSourceId[i] = view.getUint16(at + 18, true);
    }
    if (gpsTime) gpsTime[i] = view.getFloat64(at + GPS_OFFSET[format], true);
    if (rgb) {
      const r = at + RGB_OFFSET[format];
      rgb[i * 3] = view.getUint16(r, true);
      rgb[i * 3 + 1] = view.getUint16(r + 2, true);
      rgb[i * 3 + 2] = view.getUint16(r + 4, true);
    }
    if (nir) nir[i] = view.getUint16(at + 36, true);
    for (const e of extraBytes) {
      if (!e.dataType) continue;
      const o = at + base + e.offset;
      let v: number;
      switch (e.dataType) {
        case 1:
          v = view.getUint8(o);
          break;
        case 2:
          v = view.getInt8(o);
          break;
        case 3:
          v = view.getUint16(o, true);
          break;
        case 4:
          v = view.getInt16(o, true);
          break;
        case 5:
          v = view.getUint32(o, true);
          break;
        case 6:
          v = view.getInt32(o, true);
          break;
        case 7:
          v = Number(view.getBigUint64(o, true));
          break;
        case 8:
          v = Number(view.getBigInt64(o, true));
          break;
        case 9:
          v = view.getFloat32(o, true);
          break;
        default:
          v = view.getFloat64(o, true);
      }
      extra[e.name][i] = v === e.noData ? Number.NaN : v * e.scale + e.addOffset;
    }
  }
  return {
    header,
    records,
    crs,
    extraBytes,
    count,
    origin,
    positions,
    intensity,
    returnNumber,
    numberOfReturns,
    classification,
    classificationFlags,
    scanDirection,
    edgeOfFlightLine,
    scanAngle,
    userData,
    pointSourceId,
    scannerChannel,
    gpsTime,
    rgb,
    nir,
    extra,
  };
}

/** Fetches and parses a LAS file. Aborts with `options.signal`. */
export async function loadLAS(
  url: string | URL,
  options: LASOptions & { fetch?: typeof fetch } = {},
): Promise<LASPoints> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(url, { signal: options.signal });
  if (!response.ok)
    throw new MargoError('failed', `GET ${url} answered ${response.status}; check the URL and the server`);
  return parseLAS(await response.arrayBuffer(), options);
}

/** Input of `writeLAS`: world positions (float64) and any attributes of the chosen format. */
export interface LASWriteInput {
  /** xyz per point, world units. */
  positions: ArrayLike<number>;
  /** Point data record format 0 to 10. Default: 6, or 7 with rgb. */
  pointFormat?: number;
  /** LAS minor version. Default 4 (formats 6 to 10 need it); 2 or 3 for formats 0 to 5. */
  versionMinor?: number;
  /** Coordinate resolution. Default [0.001, 0.001, 0.001]. */
  scale?: readonly [number, number, number];
  intensity?: ArrayLike<number>;
  classification?: ArrayLike<number>;
  returnNumber?: ArrayLike<number>;
  numberOfReturns?: ArrayLike<number>;
  gpsTime?: ArrayLike<number>;
  /** 16-bit RGB per point. */
  rgb?: ArrayLike<number>;
  nir?: ArrayLike<number>;
  pointSourceId?: ArrayLike<number>;
  /** Scalar extra bytes attributes stored as float64 (data type 10), by name. */
  extra?: Record<string, ArrayLike<number>>;
  /** OGC WKT of the CRS (record 2112; sets the WKT global encoding bit for LAS 1.4). */
  wkt?: string;
  /** EPSG code stored as GeoTIFF keys (34735). */
  epsg?: number;
}

/** Writes uncompressed LAS. Meant for tools and round-trip tests. */
export function writeLAS(input: LASWriteInput): Uint8Array {
  const n = input.positions.length / 3;
  if (!Number.isInteger(n)) throw new RangeError('positions length must be a multiple of 3');
  const format = input.pointFormat ?? (input.rgb ? 7 : 6),
    minor = input.versionMinor ?? 4;
  if (!Number.isInteger(format) || format < 0 || format > 10) throw new RangeError('Invalid pointFormat; use 0 to 10');
  if (format >= 6 && minor < 4) throw new RangeError('Point formats 6 to 10 need LAS 1.4; set versionMinor to 4');
  const extraNames = Object.keys(input.extra ?? {}),
    base = LAS_RECORD_SIZES[format],
    recordLength = base + extraNames.length * 8,
    scale = input.scale ?? [0.001, 0.001, 0.001];
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) {
    const v = input.positions[i];
    if (!Number.isFinite(v)) throw new RangeError('positions must be finite');
    if (v < min[i % 3]) min[i % 3] = v;
    if (v > max[i % 3]) max[i % 3] = v;
  }
  if (!n) min.fill(0), max.fill(0);
  const offset = min.map((m, i) => Math.floor((m + max[i]) / 2));
  const vlrs: { user: string; id: number; data: Uint8Array }[] = [];
  if (extraNames.length) {
    const data = new Uint8Array(192 * extraNames.length),
      v = new DataView(data.buffer);
    extraNames.forEach((name, k) => {
      v.setUint8(k * 192 + 2, 10);
      data.set(new TextEncoder().encode(name.slice(0, 32)), k * 192 + 4);
    });
    vlrs.push({ user: 'LASF_Spec', id: 4, data });
  }
  if (input.wkt) vlrs.push({ user: 'LASF_Projection', id: 2112, data: new TextEncoder().encode(`${input.wkt}\0`) });
  if (input.epsg) {
    const keys = new Uint16Array([1, 1, 0, 1, 3072, 0, 1, input.epsg]);
    vlrs.push({ user: 'LASF_Projection', id: 34735, data: new Uint8Array(keys.buffer) });
  }
  const headerSize = minor >= 4 ? 375 : minor === 3 ? 235 : 227,
    vlrBytes = vlrs.reduce((s, r) => s + 54 + r.data.byteLength, 0),
    pointOffset = headerSize + vlrBytes,
    out = new Uint8Array(pointOffset + n * recordLength),
    view = new DataView(out.buffer);
  out.set([0x4c, 0x41, 0x53, 0x46]);
  view.setUint16(6, minor >= 4 && input.wkt ? 16 : 0, true);
  view.setUint8(24, 1);
  view.setUint8(25, minor);
  out.set(new TextEncoder().encode('Margo Engine'), 58);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, pointOffset, true);
  view.setUint32(100, vlrs.length, true);
  view.setUint8(104, format);
  view.setUint16(105, recordLength, true);
  view.setUint32(107, format < 6 && n < 2 ** 32 ? n : 0, true);
  for (let i = 0; i < 3; i++) {
    view.setFloat64(131 + i * 8, scale[i], true);
    view.setFloat64(155 + i * 8, offset[i], true);
    view.setFloat64(179 + i * 16, max[i], true);
    view.setFloat64(187 + i * 16, min[i], true);
  }
  if (minor >= 4) view.setBigUint64(247, BigInt(n), true);
  let at = headerSize;
  for (const r of vlrs) {
    out.set(new TextEncoder().encode(r.user), at + 2);
    view.setUint16(at + 18, r.id, true);
    view.setUint16(at + 20, r.data.byteLength, true);
    out.set(r.data, at + 54);
    at += 54 + r.data.byteLength;
  }
  const get = (a: ArrayLike<number> | undefined, i: number, d = 0) => (a ? a[i] : d);
  for (let i = 0; i < n; i++) {
    const p = pointOffset + i * recordLength;
    for (let k = 0; k < 3; k++)
      view.setInt32(p + k * 4, Math.round((input.positions[i * 3 + k] - offset[k]) / scale[k]), true);
    view.setUint16(p + 12, get(input.intensity, i), true);
    const r = get(input.returnNumber, i, 1),
      nr = get(input.numberOfReturns, i, 1);
    if (format >= 6) {
      view.setUint8(p + 14, (r & 15) | ((nr & 15) << 4));
      view.setUint8(p + 16, get(input.classification, i));
      view.setUint16(p + 20, get(input.pointSourceId, i), true);
    } else {
      view.setUint8(p + 14, (r & 7) | ((nr & 7) << 3));
      view.setUint8(p + 15, get(input.classification, i) & 31);
      view.setUint16(p + 18, get(input.pointSourceId, i), true);
    }
    if (GPS_OFFSET[format] >= 0) view.setFloat64(p + GPS_OFFSET[format], get(input.gpsTime, i), true);
    if (RGB_OFFSET[format] >= 0)
      for (let c = 0; c < 3; c++) view.setUint16(p + RGB_OFFSET[format] + c * 2, get(input.rgb, i * 3 + c), true);
    if (format === 8 || format === 10) view.setUint16(p + 36, get(input.nir, i), true);
    extraNames.forEach((name, k) => view.setFloat64(p + base + k * 8, input.extra![name][i], true));
  }
  return out;
}
