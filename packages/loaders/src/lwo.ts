// LightWave .lwo objects: LWO2 and the older LWOB, with layers, polygons, surfaces and UV maps.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { CornerWelder, floats, latin1, limits, toBytes, triangulate, uints, type BinaryInput } from './util.js';

const F = 'LWO';
const NONE = 0xffffffff;

/** Options of {@link parseLWO}: the shared size limits. */
export interface LWOOptions extends ParseLimits {}

/** What {@link parseLWO} returns: one mesh with a group per layer and surface. Coordinates are in metres, Y up. */
export interface LWOModel extends LoadedGeometry {
  kind: 'mesh';
  groups: LoadedGroup[];
  /** Things the parser moved past, each listed once. */
  warnings: string[];
}

class Reader {
  readonly view: DataView;
  pos: number;
  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
  need(size: number): void {
    if (this.pos + size > this.end) throw new LoaderError(F, 'truncated', 'a chunk ends early');
  }
  u16(): number {
    this.need(2);
    this.pos += 2;
    return this.view.getUint16(this.pos - 2);
  }
  i16(): number {
    this.need(2);
    this.pos += 2;
    return this.view.getInt16(this.pos - 2);
  }
  u32(): number {
    this.need(4);
    this.pos += 4;
    return this.view.getUint32(this.pos - 4);
  }
  f32(): number {
    this.need(4);
    this.pos += 4;
    return this.view.getFloat32(this.pos - 4);
  }
  id(): string {
    this.need(4);
    this.pos += 4;
    return latin1(this.bytes, this.pos - 4, this.pos);
  }
  /** A zero-ended name padded to an even length. */
  name(): string {
    const start = this.pos;
    while (this.pos < this.end && this.bytes[this.pos]) this.pos++;
    if (this.pos >= this.end) throw new LoaderError(F, 'truncated', 'a name has no end');
    const text = latin1(this.bytes, start, this.pos);
    this.pos += (this.pos - start) % 2 ? 1 : 2;
    return text;
  }
  /** A variable-length index: two bytes, or four when the first byte is 0xFF. */
  index(): number {
    this.need(2);
    if (this.bytes[this.pos] !== 0xff) return this.u16();
    return this.u32() & 0xffffff;
  }
}

interface Polygon {
  corners: number[];
  surface: number;
}
interface Layer {
  name: string;
  points: Float32Array;
  polygons: Polygon[];
  /** First UV map: uv by point. */
  uvs: Map<number, [number, number]>;
  /** Discontinuous UVs by polygon, then point. */
  seams: Map<number, Map<number, [number, number]>>;
  uvName?: string;
}
const emptyLayer = (name: string): Layer => ({
  name,
  points: new Float32Array(0),
  polygons: [],
  uvs: new Map(),
  seams: new Map(),
});

function readSurface(reader: Reader, version: number, colors: Map<string, [number, number, number]>): void {
  const name = reader.name();
  if (version === 2) reader.name();
  while (reader.pos + 6 <= reader.end) {
    const id = reader.id(),
      size = reader.u16(),
      next = reader.pos + size + (size % 2);
    if (reader.pos + size > reader.end) throw new LoaderError(F, 'truncated', `surface part ${id} runs past its chunk`);
    if (id === 'COLR') {
      if (version === 2) colors.set(name, [reader.f32(), reader.f32(), reader.f32()]);
      else {
        const { bytes, pos } = reader;
        colors.set(name, [bytes[pos] / 255, bytes[pos + 1] / 255, bytes[pos + 2] / 255]);
      }
    }
    reader.pos = next;
  }
}

/**
 * Reads a LightWave `.lwo` object, LWO2 or LWOB: every layer's points and face polygons, `SURF` colours, and the first
 * `TXUV` map with its discontinuous `VMAD` values, which split a vertex along a seam. Polygons are fan-triangulated. There
 * is one group per layer and surface. Curves, patches, bones and image maps are skipped with a warning.
 *
 * @param input The file's bytes.
 * @param options The shared size limits.
 * @returns The merged mesh.
 * @throws LoaderError with code `header`, `truncated`, `range`, `limit` or `syntax` (no polygons).
 *
 * @example
 * ```ts
 * import { parseLWO } from '@margoengine/loaders/lwo';
 *
 * const bytes = await (await fetch('/models/lamp.lwo')).arrayBuffer();
 * const { groups, warnings } = parseLWO(bytes);
 * console.log(groups[0].name, groups[0].color, warnings);
 * ```
 */
export function parseLWO(input: BinaryInput, options: LWOOptions = {}): LWOModel {
  const bytes = toBytes(input, F),
    { maxVertices, maxTriangles } = limits(options, F);
  if (bytes.length < 12) throw new LoaderError(F, 'header', 'the file is too small');
  const top = new Reader(bytes, 0, bytes.length);
  if (top.id() !== 'FORM') throw new LoaderError(F, 'header', 'missing the FORM header');
  const end = Math.min(top.u32() + 8, bytes.length),
    form = top.id();
  if (form !== 'LWO2' && form !== 'LWOB') throw new LoaderError(F, 'header', `form type ${form.slice(0, 4)} is not LWO2 or LWOB`);
  const version = form === 'LWO2' ? 2 : 1,
    layers: Layer[] = [],
    tags: string[] = [],
    colors = new Map<string, [number, number, number]>(),
    warnings = new Set<string>();
  let layer = emptyLayer(''),
    total = 0;
  layers.push(layer);

  for (let pos = 12; pos + 8 <= end; ) {
    const head = new Reader(bytes, pos, end),
      id = head.id(),
      size = head.u32(),
      start = pos + 8,
      stop = start + size;
    if (stop > end) throw new LoaderError(F, 'truncated', `chunk ${id} runs past the file`);
    pos = stop + (size % 2);
    const chunk = new Reader(bytes, start, stop);
    switch (id) {
      case 'TAGS':
      case 'SRFS':
        while (!chunk.done) tags.push(chunk.name());
        break;
      case 'LAYR': {
        chunk.u16();
        chunk.u16();
        chunk.need(12);
        chunk.pos += 12;
        const name = chunk.name();
        // The points before the first LAYR belong to that layer, so an empty opening layer is replaced.
        if (layer.points.length || layer.polygons.length) layers.push((layer = emptyLayer(name)));
        else layer.name = name;
        break;
      }
      case 'PNTS': {
        if (size % 12) throw new LoaderError(F, 'syntax', 'PNTS is not whole points');
        const count = size / 12;
        total += count;
        if (total > maxVertices) throw new LoaderError(F, 'limit', `point count exceeds the limit of ${maxVertices}`);
        if (layer.points.length) layers.push((layer = emptyLayer(layer.name)));
        layer.points = new Float32Array(size / 4);
        for (let i = 0; i < layer.points.length; i++) layer.points[i] = chunk.f32();
        break;
      }
      case 'POLS': {
        if (version === 2) {
          const type = chunk.id();
          if (type !== 'FACE') {
            warnings.add(`${type} polygons are not read`);
            break;
          }
          while (!chunk.done) {
            const count = chunk.u16() & 0x3ff,
              corners: number[] = [];
            for (let i = 0; i < count; i++) corners.push(chunk.index());
            layer.polygons.push({ corners, surface: -1 });
          }
        } else
          while (!chunk.done) {
            const count = chunk.u16(),
              corners: number[] = [];
            for (let i = 0; i < count; i++) corners.push(chunk.u16());
            let surface = chunk.i16();
            // A negative surface means detail polygons follow, under a count of their own.
            if (surface < 0) {
              surface = -surface;
              chunk.u16();
            }
            layer.polygons.push({ corners, surface: surface - 1 });
          }
        break;
      }
      case 'PTAG': {
        if (chunk.id() !== 'SURF') break;
        while (!chunk.done) {
          const polygon = chunk.index(),
            tag = chunk.u16(),
            target = layer.polygons[polygon];
          if (!target) throw new LoaderError(F, 'range', `PTAG names polygon ${polygon}, which does not exist`);
          target.surface = tag;
        }
        break;
      }
      case 'VMAP':
      case 'VMAD': {
        const type = chunk.id(),
          dimension = chunk.u16(),
          name = chunk.name();
        if (type !== 'TXUV' || dimension !== 2) break;
        layer.uvName ??= name;
        if (layer.uvName !== name) {
          warnings.add('only the first UV map is read');
          break;
        }
        while (!chunk.done) {
          const point = chunk.index(),
            polygon = id === 'VMAD' ? chunk.index() : -1,
            uv: [number, number] = [chunk.f32(), 1 - chunk.f32()];
          if (id === 'VMAP') layer.uvs.set(point, uv);
          else {
            let seam = layer.seams.get(polygon);
            if (!seam) layer.seams.set(polygon, (seam = new Map()));
            seam.set(point, uv);
          }
        }
        break;
      }
      case 'SURF':
        readSurface(chunk, version, colors);
        break;
      case 'CLIP':
        warnings.add('image maps are not read');
        break;
    }
  }

  const positions = floats(),
    uvs = floats(),
    indices = uints(),
    groups: LoadedGroup[] = [],
    textured = layers.some((entry) => entry.uvs.size || entry.seams.size);
  for (const entry of layers) {
    const pointCount = entry.points.length / 3,
      base = positions.length / 3,
      welder = new CornerWelder(pointCount),
      seamUVs: [number, number][] = [],
      bySurface = new Map<number, Polygon[]>(),
      numbered = new Map<Polygon, number>();
    entry.polygons.forEach((polygon, i) => {
      numbered.set(polygon, i);
      let list = bySurface.get(polygon.surface);
      if (!list) bySurface.set(polygon.surface, (list = []));
      list.push(polygon);
    });
    for (const [surface, polygons] of bySurface) {
      const start = indices.length;
      for (const polygon of polygons) {
        const seam = entry.seams.get(numbered.get(polygon)!);
        const corners = polygon.corners.map((point) => {
          if (!(point < pointCount))
            throw new LoaderError(F, 'range', `polygon index ${point} is outside 0..${pointCount - 1}`);
          const uv = seam?.get(point);
          if (!uv) return welder.weld(point, NONE, NONE, NONE);
          seamUVs.push(uv);
          return welder.weld(point, seamUVs.length - 1, NONE, NONE);
        });
        if (base + welder.count > maxVertices)
          throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
        const before = indices.length;
        triangulate(indices, corners.length, (c) => corners[c], welder.count, F, maxTriangles);
        for (let i = before; i < indices.length; i++) indices.array[i] += base;
      }
      if (indices.length === start) continue;
      const name = tags[surface],
        group: LoadedGroup = { start, count: indices.length - start, name: name ?? entry.name },
        color = name === undefined ? undefined : colors.get(name);
      if (entry.name) group.objectId = entry.name;
      if (color) group.color = [...color, 1];
      groups.push(group);
    }
    const keys = welder.keys.array;
    for (let v = 0; v < welder.count; v++) {
      const point = keys[v * 4] * 3,
        seam = keys[v * 4 + 1];
      // LightWave is left-handed with clockwise fronts: negating z gives right-handed, counter-clockwise fronts.
      positions.push3(entry.points[point], entry.points[point + 1], -entry.points[point + 2]);
      if (textured) {
        const [u, w] = seam === NONE ? (entry.uvs.get(keys[v * 4]) ?? [0, 0]) : seamUVs[seam];
        uvs.push(u);
        uvs.push(w);
      }
    }
  }
  if (!indices.length) throw new LoaderError(F, 'syntax', 'the file has no polygons');
  const model: LWOModel = {
    kind: 'mesh',
    positions: positions.result(),
    indices: indices.result(),
    groups,
    warnings: [...warnings],
  };
  if (textured) model.uvs = uvs.result();
  return model;
}
