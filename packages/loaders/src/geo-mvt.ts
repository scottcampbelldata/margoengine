import { LoaderError } from './types.js';
import { toBytes, throwIfAborted, type BinaryInput } from './util.js';
import {
  buildGeo,
  geoLimit,
  GEO,
  area,
  ringPolygons,
  type GeoFeature,
  type GeoGeometry,
  type GeoOptions,
  type GeoPosition,
  type GeoResult,
} from './geo-model.js';

/** Vector tile coordinates and optional layer selection. */
export interface MVTOptions extends GeoOptions {
  /** With a tile address, return WGS84 lon/lat; otherwise retain local tile coordinates (y down). */
  tile?: { x: number; y: number; z: number };
  /** Read only these named layers. Default all. */
  layers?: readonly string[];
}
class PBF {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  integer(): bigint {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.at >= this.bytes.length) throw new LoaderError(GEO, 'truncated', 'protobuf varint ends early');
      const byte = this.bytes[this.at++];
      if (i === 9 && byte > 1) throw new LoaderError(GEO, 'range', 'protobuf varint exceeds uint64');
      n |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return n;
    }
    throw new LoaderError(GEO, 'syntax', 'unterminated protobuf varint');
  }
  number(): number {
    const n = this.integer();
    if (n > BigInt(Number.MAX_SAFE_INTEGER))
      throw new LoaderError(GEO, 'range', 'protobuf number exceeds exact precision');
    return Number(n);
  }
  data(): Uint8Array {
    const n = this.number();
    if (n > this.bytes.length - this.at) throw new LoaderError(GEO, 'truncated', 'protobuf payload ends early');
    const bytes = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return bytes;
  }
  string(): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(this.data());
    } catch (e) {
      if (e instanceof LoaderError) throw e;
      throw new LoaderError(GEO, 'syntax', 'protobuf string is not UTF-8');
    }
  }
  fixed(n: number): DataView {
    if (this.at + n > this.bytes.length) throw new LoaderError(GEO, 'truncated', 'protobuf fixed value ends early');
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, n);
    this.at += n;
    return view;
  }
  skip(wire: number): void {
    if (wire === 0) this.integer();
    else if (wire === 1) this.fixed(8);
    else if (wire === 2) this.data();
    else if (wire === 5) this.fixed(4);
    else throw new LoaderError(GEO, 'unsupported', `protobuf wire type ${wire} is unsupported`);
  }
  fields(each: (field: number, wire: number) => boolean): void {
    while (this.at < this.bytes.length) {
      const tag = this.number(),
        field = Math.floor(tag / 8),
        wire = tag % 8;
      if (!field) throw new LoaderError(GEO, 'syntax', 'protobuf field number is zero');
      if (!each(field, wire)) this.skip(wire);
    }
  }
}
const exact = (n: bigint): number | string =>
  n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : String(n);
function value(bytes: Uint8Array): unknown {
  const r = new PBF(bytes);
  let result: unknown = null,
    seen = false;
  r.fields((f, w) => {
    if (f < 1 || f > 7) return false;
    const wire = f === 1 ? 2 : f === 2 ? 5 : f === 3 ? 1 : 0;
    if (w !== wire) throw new LoaderError(GEO, 'syntax', 'MVT value has the wrong wire type');
    if (seen) throw new LoaderError(GEO, 'syntax', 'MVT value must have exactly one value');
    seen = true;
    if (f === 1) result = r.string();
    else if (f === 2) result = r.fixed(4).getFloat32(0, true);
    else if (f === 3) result = r.fixed(8).getFloat64(0, true);
    else {
      const n = r.integer();
      result =
        f === 7
          ? n !== 0n
          : exact(f === 4 ? BigInt.asIntN(64, n) : f === 6 ? (n & 1n ? -((n + 1n) >> 1n) : n >> 1n) : n);
    }
    return true;
  });
  if (!seen || (typeof result === 'number' && !Number.isFinite(result)))
    throw new LoaderError(GEO, 'syntax', 'invalid MVT value');
  return result;
}
function packed(r: PBF, wire: number, target: number[]): void {
  if (wire === 0) target.push(r.number());
  else if (wire === 2) {
    const inner = new PBF(r.data());
    while (inner.at < inner.bytes.length) target.push(inner.number());
  } else throw new LoaderError(GEO, 'syntax', 'packed protobuf values need varints');
}
function feature(
  bytes: Uint8Array,
  keys: string[],
  values: unknown[],
  layer: string,
  extent: number,
  options: MVTOptions,
  version: number,
): GeoFeature {
  const r = new PBF(bytes),
    tags: number[] = [],
    commands: number[] = [];
  let id: string | number | undefined,
    type = 0;
  r.fields((f, w) => {
    if (f === 1) {
      if (w !== 0) throw new LoaderError(GEO, 'syntax', 'MVT id needs a varint');
      id = exact(r.integer());
    } else if (f === 2) packed(r, w, tags);
    else if (f === 3) {
      if (w !== 0) throw new LoaderError(GEO, 'syntax', 'MVT type needs a varint');
      type = r.number();
    } else if (f === 4) packed(r, w, commands);
    else return false;
    return true;
  });
  if (tags.length % 2) throw new LoaderError(GEO, 'syntax', 'MVT tags must be key/value pairs');
  const properties: Record<string, unknown> = Object.create(null);
  for (let t = 0; t < tags.length; t += 2) {
    const k = tags[t],
      v = tags[t + 1];
    if (k >= keys.length || v >= values.length) throw new LoaderError(GEO, 'range', 'MVT tag index is out of range');
    properties[keys[k]] = values[v];
  }
  if (type < 0 || type > 3) throw new LoaderError(GEO, 'unsupported', `unknown MVT geometry ${type}`);
  let x = 0,
    y = 0,
    at = 0,
    total = 0,
    closed = false;
  const paths: GeoPosition[][] = [];
  let path: GeoPosition[] | undefined;
  const position = (): GeoPosition => {
    if (at + 2 > commands.length) throw new LoaderError(GEO, 'truncated', 'MVT coordinate delta ends early');
    const dx = commands[at++],
      dy = commands[at++];
    if (dx > 0xffffffff || dy > 0xffffffff) throw new LoaderError(GEO, 'range', 'MVT deltas must be uint32');
    x += dx % 2 ? -(dx + 1) / 2 : dx / 2;
    y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y))
      throw new LoaderError(GEO, 'range', 'MVT coordinate exceeds exact precision');
    if (++total > (options.maxVertices ?? 8000000))
      throw new LoaderError(GEO, 'limit', 'MVT geometry exceeds the vertex limit');
    if (!options.tile) return [x, y];
    const tile = options.tile,
      n = 2 ** tile.z,
      longitude = ((tile.x + x / extent) / n) * 360 - 180;
    const latitude = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + y / extent)) / n))) * 180) / Math.PI;
    return [longitude, latitude];
  };
  while (at < commands.length) {
    const command = commands[at++],
      op = command % 8,
      count = Math.floor(command / 8);
    if (command > 0xffffffff || !count) throw new LoaderError(GEO, 'syntax', 'invalid MVT geometry command');
    if (op === 1 || op === 2) {
      if (count > (commands.length - at) / 2)
        throw new LoaderError(GEO, 'truncated', 'MVT command count exceeds its coordinates');
      if (op === 2 && (!path || closed || type === 1))
        throw new LoaderError(GEO, 'syntax', 'MVT LineTo needs an open line or polygon');
      if (op === 1 && type !== 1 && count !== 1)
        throw new LoaderError(GEO, 'syntax', 'line/polygon MoveTo count must be one');
      if (op === 1 && type === 3 && path && !closed)
        throw new LoaderError(GEO, 'syntax', 'MVT polygon ring was not closed');
      for (let i = 0; i < count; i++) {
        const p = position();
        if (op === 1) {
          path = [p];
          paths.push(path);
          closed = false;
        } else path!.push(p);
      }
    } else if (op === 7) {
      if (type !== 3 || count !== 1 || !path || closed || path.length < 3)
        throw new LoaderError(GEO, 'syntax', 'invalid MVT ClosePath');
      path.push([...path[0]]);
      closed = true;
    } else throw new LoaderError(GEO, 'unsupported', `unknown MVT geometry command ${op}`);
  }
  let geometry: GeoGeometry | null = null;
  if (type === 1) geometry = { type: 'MultiPoint', coordinates: paths.flat() };
  else if (type === 2) geometry = { type: 'MultiLineString', coordinates: paths };
  else if (type === 3) {
    if (path && !closed) throw new LoaderError(GEO, 'syntax', 'MVT polygon was not closed');
    const polygons: GeoPosition[][][] = [];
    // Projection reverses screen-y winding, so classify in the corresponding coordinate convention.
    for (const ring of version === 1 ? [] : paths) {
      const signed = area(ring) * (options.tile ? -1 : 1);
      if (signed > 0) polygons.push([ring]);
      else if (signed < 0 && polygons.length) polygons.at(-1)!.push(ring);
      else throw new LoaderError(GEO, 'syntax', 'MVT polygon needs a nondegenerate exterior before holes');
    }
    if (version === 1) polygons.push(...ringPolygons(paths));
    geometry = { type: 'MultiPolygon', coordinates: polygons };
  }
  const result: GeoFeature = { type: 'Feature', properties, geometry, layer, extent };
  if (id !== undefined) result.id = id;
  return result;
}
/** Reads MVT 1/2 protobuf vector tiles, preserving layers, tags, IDs, multipart lines and polygon holes. */
export function parseMVT(input: BinaryInput, options: MVTOptions = {}): GeoResult {
  throwIfAborted(options.signal, GEO);
  const bytes = toBytes(input, GEO),
    max = geoLimit(options, 'maxBytes', 256 << 20),
    maxFeatures = geoLimit(options, 'maxFeatures', 100000);
  if (bytes.length > max) throw new LoaderError(GEO, 'limit', `MVT exceeds ${max} bytes`);
  if (options.tile) {
    const { x, y, z } = options.tile;
    if (
      !Number.isSafeInteger(z) ||
      z < 0 ||
      z > 30 ||
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= 2 ** z ||
      y >= 2 ** z
    )
      throw new LoaderError(GEO, 'range', 'MVT tile address must fit zoom 0..30');
  }
  const result: GeoFeature[] = [],
    r = new PBF(bytes);
  const layerNames = new Set<string>();
  r.fields((f, w) => {
    if (f !== 3) return false;
    if (w !== 2) throw new LoaderError(GEO, 'syntax', 'MVT layer must be length-delimited');
    const layer = new PBF(r.data()),
      keys: string[] = [],
      values: unknown[] = [],
      features: Uint8Array[] = [];
    let name = '',
      extent = 4096,
      version = 1;
    layer.fields((field, wire) => {
      if (([1, 2, 3, 4].includes(field) && wire !== 2) || ([5, 15].includes(field) && wire !== 0))
        throw new LoaderError(GEO, 'syntax', 'MVT layer field has the wrong wire type');
      if (field === 1) name = layer.string();
      else if (field === 2) {
        if (features.length >= maxFeatures) throw new LoaderError(GEO, 'limit', 'MVT layer has too many features');
        features.push(layer.data());
      } else if (field === 3) keys.push(layer.string());
      else if (field === 4) values.push(value(layer.data()));
      else if (field === 5) extent = layer.number();
      else if (field === 15) version = layer.number();
      else return false;
      return true;
    });
    if (
      !name ||
      !Number.isSafeInteger(extent) ||
      extent < 1 ||
      extent > 0xffffffff ||
      version < 1 ||
      version > 2 ||
      layerNames.has(name)
    )
      throw new LoaderError(GEO, 'header', 'invalid MVT layer name, extent or version');
    layerNames.add(name);
    if (!options.layers || options.layers.includes(name))
      for (const bytes of features) {
        if (result.length >= maxFeatures) throw new LoaderError(GEO, 'limit', 'MVT has too many features');
        result.push(feature(bytes, keys, values, name, extent, options, version));
      }
    return true;
  });
  return buildGeo(result, options, options.tile ? 'OGC:CRS84' : 'tile-local');
}
