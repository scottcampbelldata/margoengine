// Tile content formats of 3D Tiles 1.1: glTF / GLB, and the 1.0 formats 1.1 still accepts: Batched 3D Model (b3dm),
// Point Cloud (pnts), Instanced 3D Model (i3dm) and Composite (cmpt), with their feature and batch tables. Written
// from the OGC 3D Tiles specification. Every length is checked against the bytes, so truncated or corrupt input
// throws a RangeError or TypeError and never reads out of bounds.

/** A component type of feature and batch table binary bodies. */
export type ComponentType =
  | 'BYTE'
  | 'UNSIGNED_BYTE'
  | 'SHORT'
  | 'UNSIGNED_SHORT'
  | 'INT'
  | 'UNSIGNED_INT'
  | 'FLOAT'
  | 'DOUBLE';
/** An element type of feature and batch table binary bodies. */
export type ElementType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4';

import { glbChunks, isGLB } from '../../shared/glb.js';
import { eastNorthUpToEcef } from './wgs84.js';

const COMPONENT_SIZE: Record<ComponentType, number> = {
  BYTE: 1,
  UNSIGNED_BYTE: 1,
  SHORT: 2,
  UNSIGNED_SHORT: 2,
  INT: 4,
  UNSIGNED_INT: 4,
  FLOAT: 4,
  DOUBLE: 8,
};
const ELEMENT_SIZE: Record<ElementType, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Reads `count` elements of a component type at a byte offset into a new array (no alignment requirement). */
export function readComponents(
  bytes: Uint8Array,
  byteOffset: number,
  componentType: ComponentType,
  count: number,
): Float64Array | Float32Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array {
  const size = COMPONENT_SIZE[componentType];
  if (!size)
    throw new TypeError(`Unknown componentType ${componentType}; use one of ${Object.keys(COMPONENT_SIZE).join(', ')}`);
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || !Number.isInteger(count) || count < 0)
    throw new RangeError('Invalid binary reference; byteOffset and counts must be whole numbers of 0 or more');
  if (byteOffset + size * count > bytes.byteLength)
    throw new RangeError(
      `Binary body too short: ${count} ${componentType} at ${byteOffset} pass its ${bytes.byteLength} bytes; the file is truncated or corrupt`,
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, size * count);
  switch (componentType) {
    case 'BYTE':
      return Int8Array.from({ length: count }, (_, i) => view.getInt8(i));
    case 'UNSIGNED_BYTE':
      return Uint8Array.from({ length: count }, (_, i) => view.getUint8(i));
    case 'SHORT':
      return Int16Array.from({ length: count }, (_, i) => view.getInt16(i * 2, true));
    case 'UNSIGNED_SHORT':
      return Uint16Array.from({ length: count }, (_, i) => view.getUint16(i * 2, true));
    case 'INT':
      return Int32Array.from({ length: count }, (_, i) => view.getInt32(i * 4, true));
    case 'UNSIGNED_INT':
      return Uint32Array.from({ length: count }, (_, i) => view.getUint32(i * 4, true));
    case 'FLOAT':
      return Float32Array.from({ length: count }, (_, i) => view.getFloat32(i * 4, true));
    default:
      return Float64Array.from({ length: count }, (_, i) => view.getFloat64(i * 8, true));
  }
}

const decoder = /* @__PURE__ */ new TextDecoder();
function parseJSON(bytes: Uint8Array, what: string): Record<string, unknown> {
  if (bytes.byteLength === 0) return {};
  let text = decoder.decode(bytes);
  // JSON headers are padded with spaces (or, in old writers, zero bytes) to an 8-byte boundary.
  text = text.replace(/[\0\s]+$/, '');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`Invalid ${what} JSON (${(error as Error).message}); the tile content is corrupt`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`Invalid ${what} JSON; it must be an object`);
  return value as Record<string, unknown>;
}

/** A feature table: the JSON header and binary body of b3dm, i3dm and pnts content. */
export class FeatureTable {
  constructor(
    /** The JSON header. */
    readonly json: Record<string, unknown>,
    /** The binary body. */
    readonly binary: Uint8Array,
  ) {}
  /** A global (per tile) property: a JSON value, or `count` components read from a `{byteOffset}` reference. */
  global(name: string, componentType: ComponentType, count: number): ArrayLike<number> | number | undefined {
    const value = this.json[name];
    if (value === undefined) return undefined;
    if (typeof value === 'number') return value;
    if (Array.isArray(value)) return value as number[];
    if (value && typeof value === 'object' && 'byteOffset' in value)
      return readComponents(this.binary, (value as { byteOffset: number }).byteOffset, componentType, count);
    throw new TypeError(`Invalid feature table property ${name}; give a number, an array or a {byteOffset} reference`);
  }
  /** A per-feature property: `length` elements of `size` components from a `{byteOffset, componentType?}` reference. */
  property(name: string, length: number, size: number, componentType: ComponentType): ArrayLike<number> | undefined {
    const value = this.json[name] as { byteOffset?: number; componentType?: ComponentType } | undefined;
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || typeof value.byteOffset !== 'number')
      throw new TypeError(
        `Invalid feature table property ${name}; per-feature properties must be {byteOffset} references`,
      );
    return readComponents(this.binary, value.byteOffset, value.componentType ?? componentType, length * size);
  }
}

/** A batch table: per-feature properties of b3dm, i3dm and pnts content (the "properties" of each feature). */
export class BatchTable {
  /** Property names, excluding `extensions` and `extras`. */
  readonly names: readonly string[];
  private readonly cache = new Map<string, ArrayLike<unknown>>();
  constructor(
    /** The JSON header. */
    readonly json: Record<string, unknown>,
    /** The binary body. */
    readonly binary: Uint8Array,
    /** Number of features (BATCH_LENGTH, INSTANCES_LENGTH or the pnts BATCH_LENGTH). */
    readonly length: number,
  ) {
    this.names = Object.keys(json).filter((name) => name !== 'extensions' && name !== 'extras');
  }
  /** All values of one property, one entry per feature (an array of numbers for VEC types). */
  values(name: string): ArrayLike<unknown> | undefined {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const value = this.json[name];
    if (value === undefined) return undefined;
    let result: ArrayLike<unknown>;
    if (Array.isArray(value)) result = value;
    else if (value && typeof value === 'object' && 'byteOffset' in value) {
      const ref = value as { byteOffset: number; componentType: ComponentType; type: ElementType };
      const size = ELEMENT_SIZE[ref.type];
      if (!size) throw new TypeError(`Invalid batch table property ${name}; type must be SCALAR, VEC2, VEC3 or VEC4`);
      const flat = readComponents(this.binary, ref.byteOffset, ref.componentType, this.length * size);
      result =
        size === 1
          ? flat
          : Array.from({ length: this.length }, (_, i) => Array.from(flat.subarray(i * size, i * size + size)));
    } else
      throw new TypeError(
        `Invalid batch table property ${name}; give an array or a {byteOffset, componentType, type} reference`,
      );
    this.cache.set(name, result);
    return result;
  }
  /** One feature's value of a property, or undefined. */
  get(batchId: number, name: string): unknown {
    if (!Number.isInteger(batchId) || batchId < 0 || batchId >= this.length) return undefined;
    return this.values(name)?.[batchId];
  }
  /** Every property of one feature as an object. */
  feature(batchId: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const name of this.names) out[name] = this.get(batchId, name);
    return out;
  }
}

/** Parsed point cloud (pnts) content: positions relative to `rtcCenter`, colours 0..1, all decoded. */
export interface PointsContent {
  readonly type: 'pnts';
  /** xyz per point, float32, relative to `rtcCenter` (or to the quantized volume offset, already applied). */
  readonly positions: Float32Array;
  /** RGBA per point, 0..255, or undefined. */
  readonly colors?: Uint8Array;
  /** xyz unit normals, or undefined. */
  readonly normals?: Float32Array;
  /** BATCH_ID per point, or undefined. */
  readonly batchIds?: Uint32Array;
  /** CONSTANT_RGBA when present. */
  readonly constantColor?: readonly [number, number, number, number];
  readonly rtcCenter?: readonly [number, number, number];
  readonly featureTable: FeatureTable;
  readonly batchTable?: BatchTable;
  readonly byteLength: number;
}

/** glTF content: a GLB (or glTF JSON) to draw, with the b3dm wrapper's RTC_CENTER and batch table when present. */
export interface ModelContent {
  readonly type: 'glb' | 'gltf' | 'b3dm';
  /** The GLB bytes (or glTF JSON bytes for `type: 'gltf'`). */
  readonly gltf: Uint8Array;
  readonly rtcCenter?: readonly [number, number, number];
  readonly featureTable?: FeatureTable;
  readonly batchTable?: BatchTable;
  readonly byteLength: number;
}

/** Instanced 3D Model (i3dm) content: per-instance transforms around one glTF. */
export interface InstancesContent {
  readonly type: 'i3dm';
  /** The embedded GLB, or the glTF URI (`gltfUri`) when gltfFormat is 0. */
  readonly gltf?: Uint8Array;
  readonly gltfUri?: string;
  /** Column-major float64 4x4 per instance, relative to `rtcCenter`, in tileset (z-up) coordinates. */
  readonly matrices: Float64Array;
  readonly length: number;
  readonly rtcCenter?: readonly [number, number, number];
  readonly featureTable: FeatureTable;
  readonly batchTable?: BatchTable;
  readonly byteLength: number;
}

/** Composite (cmpt) content: inner tiles, each with its own format. */
export interface CompositeContent {
  readonly type: 'cmpt';
  readonly tiles: readonly TileContent[];
  readonly byteLength: number;
}

/** Any parsed tile content. */
export type TileContent = ModelContent | PointsContent | InstancesContent | CompositeContent;

/** The four-character magic of binary content, or 'json' for JSON (tileset or glTF), or undefined. */
export function contentMagic(
  bytes: Uint8Array,
): 'b3dm' | 'pnts' | 'i3dm' | 'cmpt' | 'glTF' | 'subt' | 'json' | undefined {
  if (bytes.byteLength >= 4) {
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (
      magic === 'b3dm' ||
      magic === 'pnts' ||
      magic === 'i3dm' ||
      magic === 'cmpt' ||
      magic === 'glTF' ||
      magic === 'subt'
    )
      return magic;
  }
  for (let i = 0; i < bytes.byteLength; i++) {
    const c = bytes[i];
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0xef || c === 0xbb || c === 0xbf) continue;
    return c === 0x7b ? 'json' : undefined;
  }
  return undefined;
}

interface Header {
  byteLength: number;
  featureTable: FeatureTable;
  batchTableJSON: Record<string, unknown>;
  batchTableBinary: Uint8Array;
  body: Uint8Array;
}

/** Reads the shared 28-byte (32 for i3dm) header and the tables of b3dm, pnts and i3dm. */
function readHeader(bytes: Uint8Array, magic: string, headerLength: number): Header & { view: DataView } {
  if (bytes.byteLength < headerLength)
    throw new RangeError(`${magic} content too short for its ${headerLength}-byte header; the file is truncated`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true),
    byteLength = view.getUint32(8, true);
  if (version !== 1) throw new TypeError(`Unsupported ${magic} version ${version}; only version 1 is defined`);
  if (byteLength < headerLength || byteLength > bytes.byteLength)
    throw new RangeError(
      `${magic} byteLength ${byteLength} does not fit the ${bytes.byteLength} bytes given; the file is truncated or corrupt`,
    );
  const lengths = [12, 16, 20, 24].map((offset) => view.getUint32(offset, true));
  let offset = headerLength;
  const take = (length: number, what: string): Uint8Array => {
    if (offset + length > byteLength)
      throw new RangeError(
        `${magic} ${what} runs past the content (${offset + length} > ${byteLength}); the file is truncated or corrupt`,
      );
    const out = bytes.subarray(offset, offset + length);
    offset += length;
    return out;
  };
  const featureTableJSON = parseJSON(take(lengths[0], 'feature table JSON'), `${magic} feature table`),
    featureTableBinary = take(lengths[1], 'feature table binary'),
    batchTableJSON = parseJSON(take(lengths[2], 'batch table JSON'), `${magic} batch table`),
    batchTableBinary = take(lengths[3], 'batch table binary');
  return {
    view,
    byteLength,
    featureTable: new FeatureTable(featureTableJSON, featureTableBinary),
    batchTableJSON,
    batchTableBinary,
    body: bytes.subarray(offset, byteLength),
  };
}

function count(table: FeatureTable, name: string, magic: string): number {
  const value = table.json[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new TypeError(`${magic} feature table needs ${name} as a whole number of 0 or more`);
  return value;
}

function vec3(
  value: ArrayLike<number> | number | undefined,
  name: string,
): readonly [number, number, number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' || value.length !== 3 || !Array.from(value).every(Number.isFinite))
    throw new TypeError(`Invalid ${name}; give three finite numbers`);
  return [value[0], value[1], value[2]];
}

function batchTable(header: Header, length: number): BatchTable | undefined {
  return Object.keys(header.batchTableJSON).length
    ? new BatchTable(header.batchTableJSON, header.batchTableBinary, length)
    : undefined;
}

/** Parses Batched 3D Model content. */
export function parseB3dm(bytes: Uint8Array): ModelContent {
  const header = readHeader(bytes, 'b3dm', 28),
    table = header.featureTable,
    length = count(table, 'BATCH_LENGTH', 'b3dm');
  return {
    type: 'b3dm',
    gltf: checkGLB(header.body, 'b3dm'),
    rtcCenter: vec3(table.global('RTC_CENTER', 'FLOAT', 3), 'RTC_CENTER'),
    featureTable: table,
    batchTable: batchTable(header, length),
    byteLength: header.byteLength,
  };
}

/**
 * The GLB inside a tile body, cut to its own length (b3dm and i3dm pad their body to 8 bytes) and checked with the
 * shared GLB walker (header, chunk bounds and order), so a corrupt model fails here with a clear message.
 */
function checkGLB(body: Uint8Array, where: string): Uint8Array {
  if (body.byteLength < 12 || !isGLB(body))
    throw new TypeError(`${where} glTF body is not a GLB (no glTF magic or too short); the content is corrupt`);
  const length = new DataView(body.buffer, body.byteOffset, 12).getUint32(8, true);
  if (length > body.byteLength)
    throw new RangeError(
      `${where} GLB length ${length} passes the ${body.byteLength} bytes given; the file is truncated`,
    );
  const glb = body.subarray(0, length);
  glbChunks(glb);
  return glb;
}

/** Parses Point Cloud content: POSITION or POSITION_QUANTIZED, RGBA / RGB / RGB565, NORMAL / NORMAL_OCT16P, BATCH_ID. */
export function parsePnts(bytes: Uint8Array): PointsContent {
  const header = readHeader(bytes, 'pnts', 28),
    table = header.featureTable,
    n = count(table, 'POINTS_LENGTH', 'pnts');
  if (table.json.extensions && (table.json.extensions as Record<string, unknown>)['3DTILES_draco_point_compression'])
    throw new TypeError(
      'Draco-compressed pnts (3DTILES_draco_point_compression) is not supported; convert the points to uncompressed pnts or glTF',
    );
  let positions: Float32Array;
  const raw = table.property('POSITION', n, 3, 'FLOAT');
  if (raw) positions = Float32Array.from(raw);
  else {
    const q = table.property('POSITION_QUANTIZED', n, 3, 'UNSIGNED_SHORT');
    const offset = vec3(table.global('QUANTIZED_VOLUME_OFFSET', 'FLOAT', 3), 'QUANTIZED_VOLUME_OFFSET'),
      scale = vec3(table.global('QUANTIZED_VOLUME_SCALE', 'FLOAT', 3), 'QUANTIZED_VOLUME_SCALE');
    if (!q || !offset || !scale)
      throw new TypeError(
        'pnts needs POSITION, or POSITION_QUANTIZED with QUANTIZED_VOLUME_OFFSET and QUANTIZED_VOLUME_SCALE',
      );
    positions = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) positions[i] = offset[i % 3] + (q[i] / 65535) * scale[i % 3];
  }
  let colors: Uint8Array | undefined;
  const rgba = table.property('RGBA', n, 4, 'UNSIGNED_BYTE'),
    rgb = rgba ? undefined : table.property('RGB', n, 3, 'UNSIGNED_BYTE'),
    rgb565 = rgba || rgb ? undefined : table.property('RGB565', n, 1, 'UNSIGNED_SHORT');
  if (rgba) colors = Uint8Array.from(rgba);
  else if (rgb || rgb565) {
    colors = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (rgb) {
        colors[i * 4] = rgb[i * 3];
        colors[i * 4 + 1] = rgb[i * 3 + 1];
        colors[i * 4 + 2] = rgb[i * 3 + 2];
      } else {
        const c = rgb565![i];
        colors[i * 4] = Math.round((((c >> 11) & 31) * 255) / 31);
        colors[i * 4 + 1] = Math.round((((c >> 5) & 63) * 255) / 63);
        colors[i * 4 + 2] = Math.round(((c & 31) * 255) / 31);
      }
      colors[i * 4 + 3] = 255;
    }
  }
  let normals: Float32Array | undefined;
  const normal = table.property('NORMAL', n, 3, 'FLOAT');
  if (normal) normals = Float32Array.from(normal);
  else {
    const oct = table.property('NORMAL_OCT16P', n, 2, 'UNSIGNED_BYTE');
    if (oct) {
      normals = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) octDecode(oct[i * 2], oct[i * 2 + 1], 255, normals, i * 3);
    }
  }
  const batch = table.property(
    'BATCH_ID',
    n,
    1,
    (table.json.BATCH_ID as { componentType?: ComponentType })?.componentType ?? 'UNSIGNED_SHORT',
  );
  const constant = table.global('CONSTANT_RGBA', 'UNSIGNED_BYTE', 4);
  const batchLength = batch ? count(table, 'BATCH_LENGTH', 'pnts') : n;
  return {
    type: 'pnts',
    positions,
    colors,
    normals,
    batchIds: batch ? Uint32Array.from(batch) : undefined,
    constantColor:
      constant !== undefined && typeof constant !== 'number' && constant.length === 4
        ? [constant[0], constant[1], constant[2], constant[3]]
        : undefined,
    rtcCenter: vec3(table.global('RTC_CENTER', 'FLOAT', 3), 'RTC_CENTER'),
    featureTable: table,
    batchTable: batchTable(header, batchLength),
    byteLength: header.byteLength,
  };
}

/** Octahedral unit-vector decoding (Cigolle et al., "A survey of efficient representations for independent unit vectors", JCGT 2014). */
function octDecode(u: number, v: number, range: number, out: Float32Array, at: number): void {
  let x = (u / range) * 2 - 1,
    y = (v / range) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const l = Math.hypot(x, y, z) || 1;
  out[at] = x / l;
  out[at + 1] = y / l;
  out[at + 2] = z / l;
}

/** Parses Instanced 3D Model content into one matrix per instance (POSITION, NORMAL_UP / RIGHT, SCALE, EAST_NORTH_UP). */
export function parseI3dm(
  bytes: Uint8Array,
  eastNorthUp?: (position: readonly number[]) => Float64Array,
): InstancesContent {
  const header = readHeader(bytes, 'i3dm', 32),
    table = header.featureTable,
    n = count(table, 'INSTANCES_LENGTH', 'i3dm'),
    format = header.view.getUint32(28, true);
  if (format > 1) throw new TypeError(`Invalid i3dm gltfFormat ${format}; it must be 0 (URI) or 1 (embedded GLB)`);
  let gltf: Uint8Array | undefined, gltfUri: string | undefined;
  if (format === 1) {
    gltf = checkGLB(header.body, 'i3dm');
  } else gltfUri = decoder.decode(header.body).replace(/[\0\s]+$/, '');
  const rtc = vec3(table.global('RTC_CENTER', 'FLOAT', 3), 'RTC_CENTER');
  let positions = table.property('POSITION', n, 3, 'FLOAT');
  if (!positions) {
    const q = table.property('POSITION_QUANTIZED', n, 3, 'UNSIGNED_SHORT'),
      offset = vec3(table.global('QUANTIZED_VOLUME_OFFSET', 'FLOAT', 3), 'QUANTIZED_VOLUME_OFFSET'),
      scale = vec3(table.global('QUANTIZED_VOLUME_SCALE', 'FLOAT', 3), 'QUANTIZED_VOLUME_SCALE');
    if (!q || !offset || !scale)
      throw new TypeError(
        'i3dm needs POSITION, or POSITION_QUANTIZED with QUANTIZED_VOLUME_OFFSET and QUANTIZED_VOLUME_SCALE',
      );
    positions = Float64Array.from({ length: n * 3 }, (_, i) => offset[i % 3] + (q[i] / 65535) * scale[i % 3]);
  }
  let up = table.property('NORMAL_UP', n, 3, 'FLOAT'),
    right = table.property('NORMAL_RIGHT', n, 3, 'FLOAT');
  if (!up) {
    const qu = table.property('NORMAL_UP_OCT32P', n, 2, 'UNSIGNED_SHORT'),
      qr = table.property('NORMAL_RIGHT_OCT32P', n, 2, 'UNSIGNED_SHORT');
    if (qu && qr) {
      const u = new Float32Array(n * 3),
        r = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        octDecode(qu[i * 2], qu[i * 2 + 1], 65535, u, i * 3);
        octDecode(qr[i * 2], qr[i * 2 + 1], 65535, r, i * 3);
      }
      up = u;
      right = r;
    }
  }
  const uniform = table.property('SCALE', n, 1, 'FLOAT'),
    scales = table.property('SCALE_NON_UNIFORM', n, 3, 'FLOAT'),
    enu = table.json.EAST_NORTH_UP === true;
  const matrices = new Float64Array(n * 16);
  for (let i = 0; i < n; i++) {
    const p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]],
      m = matrices.subarray(i * 16, i * 16 + 16);
    let x = [1, 0, 0],
      y = [0, 1, 0],
      z = [0, 0, 1];
    // The rotation's columns are NORMAL_RIGHT, NORMAL_UP and their cross product (the forward axis). With
    // EAST_NORTH_UP and no normals, the basis is the east-north-up frame at the instance: right (x) is east and up (y)
    // is north, so z is the ellipsoid up and a y-up glTF, turned z-up, stands upright.
    if (up && right) {
      x = [right[i * 3], right[i * 3 + 1], right[i * 3 + 2]];
      y = [up[i * 3], up[i * 3 + 1], up[i * 3 + 2]];
    } else if (enu && eastNorthUp) {
      const frame = eastNorthUp(rtc ? [p[0] + rtc[0], p[1] + rtc[1], p[2] + rtc[2]] : p);
      x = [frame[0], frame[1], frame[2]];
      y = [frame[4], frame[5], frame[6]];
    }
    z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const s = scales
      ? [scales[i * 3], scales[i * 3 + 1], scales[i * 3 + 2]]
      : uniform
        ? [uniform[i], uniform[i], uniform[i]]
        : [1, 1, 1];
    m.set([
      x[0] * s[0],
      x[1] * s[0],
      x[2] * s[0],
      0,
      y[0] * s[1],
      y[1] * s[1],
      y[2] * s[1],
      0,
      z[0] * s[2],
      z[1] * s[2],
      z[2] * s[2],
      0,
      p[0],
      p[1],
      p[2],
      1,
    ]);
  }
  return {
    type: 'i3dm',
    gltf,
    gltfUri,
    matrices,
    length: n,
    rtcCenter: rtc,
    featureTable: table,
    batchTable: batchTable(header, n),
    byteLength: header.byteLength,
  };
}

/** Parses Composite content (and nested composites, at most `depth` levels deep). */
export function parseCmpt(bytes: Uint8Array, depth = 8): CompositeContent {
  if (bytes.byteLength < 16)
    throw new RangeError('cmpt content too short for its 16-byte header; the file is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    version = view.getUint32(4, true),
    byteLength = view.getUint32(8, true),
    tilesLength = view.getUint32(12, true);
  if (version !== 1) throw new TypeError(`Unsupported cmpt version ${version}; only version 1 is defined`);
  if (byteLength < 16 || byteLength > bytes.byteLength)
    throw new RangeError(
      `cmpt byteLength ${byteLength} does not fit the ${bytes.byteLength} bytes given; the file is truncated or corrupt`,
    );
  if (depth <= 0) throw new RangeError('cmpt nested too deeply; flatten the composite to 8 levels or fewer');
  const tiles: TileContent[] = [];
  let offset = 16;
  for (let i = 0; i < tilesLength; i++) {
    if (offset + 12 > byteLength)
      throw new RangeError(`cmpt inner tile ${i} header runs past the content; the file is truncated or corrupt`);
    const inner = view.getUint32(offset + 8, true);
    if (inner < 12 || offset + inner > byteLength)
      throw new RangeError(
        `cmpt inner tile ${i} byteLength ${inner} runs past the content; the file is truncated or corrupt`,
      );
    tiles.push(parseContent(bytes.subarray(offset, offset + inner), depth - 1));
    offset += inner;
  }
  return { type: 'cmpt', tiles, byteLength };
}

/** Parses any binary tile content (b3dm, pnts, i3dm, cmpt, GLB) by its magic. JSON content is handled by the tileset. */
export function parseContent(bytes: Uint8Array, depth = 8): TileContent {
  switch (contentMagic(bytes)) {
    case 'b3dm':
      return parseB3dm(bytes);
    case 'pnts':
      return parsePnts(bytes);
    case 'i3dm':
      return parseI3dm(bytes, (p) => eastNorthUpToEcef(p[0], p[1], p[2]));
    case 'cmpt':
      return parseCmpt(bytes, depth);
    case 'glTF':
      return { type: 'glb', gltf: checkGLB(bytes, 'Tile'), byteLength: bytes.byteLength };
    case 'json':
      return { type: 'gltf', gltf: bytes, byteLength: bytes.byteLength };
    default:
      throw new TypeError(
        'Unknown tile content (no b3dm, pnts, i3dm, cmpt or glTF magic); serve glTF, GLB or a 3D Tiles 1.0 format',
      );
  }
}
