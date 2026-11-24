// LightWave .lwo objects: LWO2 and the older LWOB, with layers, polygons, surfaces, image maps, UV maps, bones and weights.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { CornerWelder, floats, latin1, limits, toBytes, triangulate, uints, type BinaryInput } from './util.js';

const F = 'LWO';
const NONE = 0xffffffff;

/** Options of {@link parseLWO}: the shared size limits. */
export interface LWOOptions extends ParseLimits {}

/** One still image of an LWO2 `CLIP`. */
export interface LWOImage {
  /** The clip's number, which a surface's image map points at. */
  clip: number;
  /** The path as written, in LightWave's form such as `Images:wall.jpg` or `D:/maps/wall.tga`. */
  path: string;
}

/** One image layer of a {@link LWOSurface}. */
export interface LWOImageMap {
  /** What the image drives: `COLR`, `DIFF`, `LUMI`, `SPEC`, `GLOS`, `REFL`, `TRAN`, `RIND`, `TRNL` or `BUMP`. */
  channel: string;
  /** The image's path, absent when the map names a clip the file does not hold. */
  path?: string;
  projection: 'planar' | 'cylindrical' | 'spherical' | 'cubic' | 'front' | 'uv';
  /** The name of the map in {@link LWOModel.uvMaps} a `uv` projection reads. */
  uvMap?: string;
  /** False when the layer is switched off in the file. */
  enabled: boolean;
}

/** One `SURF` of a {@link LWOModel}: the name is the `name` of the groups that use it. */
export interface LWOSurface {
  name: string;
  /** Base colour `[r, g, b]`, when the file gives one. */
  color?: [number, number, number];
  maps: LWOImageMap[];
}

/** One bone: a two-point `BONE` polygon, a skelegon. Coordinates are those of `positions`. */
export interface LWOBone {
  /** The name a `BONE` tag gives it. */
  name?: string;
  start: [number, number, number];
  end: [number, number, number];
  /** Index in `bones` of the bone whose end is this one's start, -1 at a root. */
  parent: number;
  /** The name of its map in {@link LWOModel.weightMaps}. */
  weightMap?: string;
  /** The name of its layer. */
  layer: string;
}

/** What {@link parseLWO} returns: one mesh with a group per layer and surface. Coordinates are in metres, Y up. */
export interface LWOModel extends LoadedGeometry {
  kind: 'mesh';
  groups: LoadedGroup[];
  /** Every `TXUV` map by name, one uv per vertex; `uvs` is each layer's first. */
  uvMaps: Record<string, Float32Array>;
  /** Every `WGHT` map by name, one weight per vertex, 0 where the map has no value. */
  weightMaps: Record<string, Float32Array>;
  /** The still images of the file's clips; `loadTextures` from `@margoengine/loaders/textures` reads them. */
  images: LWOImage[];
  surfaces: LWOSurface[];
  bones: LWOBone[];
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
/** One `VMAP` and its `VMAD` values in a layer. */
interface VertexMap {
  kind: 'TXUV' | 'WGHT';
  name: string;
  /** Values by point. */
  points: Map<number, number[]>;
  /** Discontinuous values by polygon, then point. */
  seams: Map<number, Map<number, number[]>>;
}
interface BonePolygon {
  corners: number[];
  tag?: number;
  weightTag?: number;
}
interface Layer {
  name: string;
  points: Float32Array;
  polygons: Polygon[];
  bones: BonePolygon[];
  maps: Map<string, VertexMap>;
  /** The key in `maps` of the first UV map. */
  firstUV?: string;
}
const emptyLayer = (name: string): Layer => ({
  name,
  points: new Float32Array(0),
  polygons: [],
  bones: [],
  maps: new Map(),
});
const PROJECTIONS = ['planar', 'cylindrical', 'spherical', 'cubic', 'front', 'uv'] as const;
/** Reads a sub-chunk head, checks it against its chunk and returns the sub-chunk's id, its end, and where the next starts. */
function part(reader: Reader, end: number): [string, number, number] {
  const id = reader.id(),
    size = reader.u16(),
    stop = reader.pos + size;
  if (stop > end) throw new LoaderError(F, 'truncated', `surface part ${id} runs past its chunk`);
  return [id, stop, stop + (size % 2)];
}

/** A `BLOK`: its header says what kind of layer it is, and only image maps are kept. */
function readBlock(reader: Reader, end: number): (LWOImageMap & { clip?: number }) | undefined {
  const map: LWOImageMap & { clip?: number } = { channel: 'COLR', projection: 'planar', enabled: true };
  let image = false;
  while (reader.pos + 6 <= end) {
    const [id, stop, next] = part(reader, end);
    if (id === 'IMAP') {
      image = true;
      reader.name();
      while (reader.pos + 6 <= stop) {
        const [field, , after] = part(reader, stop);
        if (field === 'CHAN') map.channel = reader.id();
        else if (field === 'ENAB') map.enabled = reader.u16() !== 0;
        reader.pos = after;
      }
    } else if (id === 'PROJ') map.projection = PROJECTIONS[reader.u16()] ?? 'planar';
    else if (id === 'IMAG') map.clip = reader.index();
    else if (id === 'VMAP') map.uvMap = reader.name();
    reader.pos = next;
  }
  return image ? map : undefined;
}

// LWOB names each texture by what it drives, and `TIMG` then gives its file.
const OLD_CHANNELS: Record<string, string> = {
  CTEX: 'COLR',
  DTEX: 'DIFF',
  STEX: 'SPEC',
  RTEX: 'REFL',
  TTEX: 'TRAN',
  LTEX: 'LUMI',
  BTEX: 'BUMP',
};

function readSurface(reader: Reader, version: number): LWOSurface & { maps: (LWOImageMap & { clip?: number })[] } {
  const surface: LWOSurface & { maps: (LWOImageMap & { clip?: number })[] } = { name: reader.name(), maps: [] };
  if (version === 2) reader.name();
  let old: LWOImageMap | undefined;
  while (reader.pos + 6 <= reader.end) {
    const [id, stop, next] = part(reader, reader.end);
    if (id === 'COLR') {
      if (version === 2) surface.color = [reader.f32(), reader.f32(), reader.f32()];
      else {
        const { bytes, pos } = reader;
        surface.color = [bytes[pos] / 255, bytes[pos + 1] / 255, bytes[pos + 2] / 255];
      }
    } else if (id === 'BLOK') {
      const map = readBlock(reader, stop);
      if (map) surface.maps.push(map);
    } else if (OLD_CHANNELS[id] && version === 1) {
      const kind = reader.name().toLowerCase();
      old = {
        channel: OLD_CHANNELS[id],
        projection: PROJECTIONS.find((name) => kind.startsWith(name.slice(0, 5))) ?? 'planar',
        enabled: true,
      };
    } else if (id === 'TIMG' && old) {
      const path = reader.name();
      if (path !== '(none)') surface.maps.push({ ...old, path });
    }
    reader.pos = next;
  }
  return surface;
}

/**
 * Reads a LightWave `.lwo` object, LWO2 or LWOB: every layer's points and face polygons, `SURF` colours and image maps,
 * every `TXUV` and `WGHT` map with its discontinuous `VMAD` values, which split a vertex along a seam, and `BONE`
 * skelegons with their names and weight maps. Polygons are fan-triangulated. There is one group per layer and surface.
 * Patch and subdivision polygons come in as their control cage, with a warning. Curves and clips that are not still
 * images are skipped with a warning. `loadTextures` from `@margoengine/loaders/textures` reads the files in `images`.
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
 * const { groups, surfaces, uvMaps, bones, warnings } = parseLWO(bytes);
 * console.log(groups[0].name, surfaces[0]?.maps[0]?.path, Object.keys(uvMaps), bones.length, warnings);
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
    images: LWOImage[] = [],
    surfaces: ReturnType<typeof readSurface>[] = [],
    warnings = new Set<string>();
  let layer = emptyLayer(''),
    total = 0,
    // PTAG and VMAD count from the start of the POLS before them, which may not be the layer's first.
    recent = { type: 'FACE', base: 0 };
  layers.push(layer);
  const nextLayer = (name: string): void => {
    layers.push((layer = emptyLayer(name)));
    recent = { type: 'FACE', base: 0 };
  };

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
        if (layer.points.length || layer.polygons.length) nextLayer(name);
        else layer.name = name;
        break;
      }
      case 'PNTS': {
        if (size % 12) throw new LoaderError(F, 'syntax', 'PNTS is not whole points');
        const count = size / 12;
        total += count;
        if (total > maxVertices) throw new LoaderError(F, 'limit', `point count exceeds the limit of ${maxVertices}`);
        if (layer.points.length) nextLayer(layer.name);
        layer.points = new Float32Array(size / 4);
        for (let i = 0; i < layer.points.length; i++) layer.points[i] = chunk.f32();
        break;
      }
      case 'POLS': {
        if (version === 2) {
          const type = chunk.id(),
            // Patches and subdivision polygons are faces of a control cage: without subdividing, the cage is the shape.
            face = type === 'FACE' || type === 'PTCH' || type === 'SUBD';
          recent = { type: face ? 'FACE' : type, base: type === 'BONE' ? layer.bones.length : layer.polygons.length };
          if (!face && type !== 'BONE') {
            warnings.add(`${type} polygons are not read`);
            break;
          }
          if (face && type !== 'FACE') warnings.add(`${type} polygons are read as their control cage`);
          while (!chunk.done) {
            const count = chunk.u16() & 0x3ff,
              corners: number[] = [];
            for (let i = 0; i < count; i++) corners.push(chunk.index());
            if (face) layer.polygons.push({ corners, surface: -1 });
            else if (count === 2) layer.bones.push({ corners });
            else throw new LoaderError(F, 'range', `a bone has ${count} points, not 2`);
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
        const type = chunk.id(),
          bones = type === 'BONE' || type === 'BNWT';
        if (recent.type !== (bones ? 'BONE' : 'FACE') || (type !== 'SURF' && !bones)) break;
        while (!chunk.done) {
          const polygon = chunk.index(),
            tag = chunk.u16(),
            target = (bones ? layer.bones : layer.polygons)[recent.base + polygon];
          if (!target) throw new LoaderError(F, 'range', `PTAG names polygon ${polygon}, which does not exist`);
          if (type === 'SURF') (target as Polygon).surface = tag;
          else if (type === 'BONE') (target as BonePolygon).tag = tag;
          else (target as BonePolygon).weightTag = tag;
        }
        break;
      }
      case 'VMAP':
      case 'VMAD': {
        const type = chunk.id(),
          dimension = chunk.u16(),
          name = chunk.name();
        if (!(type === 'TXUV' && dimension === 2) && !(type === 'WGHT' && dimension === 1)) break;
        const key = `${type}:${name}`;
        let map = layer.maps.get(key);
        if (!map) layer.maps.set(key, (map = { kind: type, name, points: new Map(), seams: new Map() }));
        if (type === 'TXUV') layer.firstUV ??= key;
        const from = recent.type === 'FACE' ? recent.base : 0;
        while (!chunk.done) {
          const point = chunk.index(),
            polygon = id === 'VMAD' ? from + chunk.index() : -1,
            value = type === 'TXUV' ? [chunk.f32(), 1 - chunk.f32()] : [chunk.f32()];
          if (id === 'VMAP') map.points.set(point, value);
          else {
            let seam = map.seams.get(polygon);
            if (!seam) map.seams.set(polygon, (seam = new Map()));
            seam.set(point, value);
          }
        }
        break;
      }
      case 'SURF':
        surfaces.push(readSurface(chunk, version));
        break;
      case 'CLIP': {
        const clip = chunk.u32();
        while (chunk.pos + 6 <= chunk.end) {
          const [kind, , next] = part(chunk, chunk.end);
          if (kind === 'STIL') images.push({ clip, path: chunk.name() });
          else if (kind === 'ISEQ' || kind === 'ANIM' || kind === 'XREF' || kind === 'STCC')
            warnings.add(`${kind} clips are not read`);
          chunk.pos = next;
        }
        break;
      }
    }
  }

  const positions = floats(),
    uvs = floats(),
    indices = uints(),
    groups: LoadedGroup[] = [],
    bones: LWOBone[] = [],
    textured = layers.some((entry) => entry.firstUV),
    outputs = new Map<string, { kind: string; name: string; size: number; values: ReturnType<typeof floats> }>();
  for (const entry of layers)
    for (const [key, { kind, name }] of entry.maps)
      if (!outputs.has(key)) outputs.set(key, { kind, name, size: kind === 'TXUV' ? 2 : 1, values: floats() });
  for (const entry of layers) {
    const pointCount = entry.points.length / 3,
      base = positions.length / 3,
      welder = new CornerWelder(pointCount),
      maps = [...entry.maps.values()],
      seamed = maps.some((map) => map.seams.size),
      // The values one corner holds apart from its point, one per map; corners that agree share a row, so a vertex.
      rows: (number[] | undefined)[][] = [],
      rowOf = new Map<string, number>(),
      bySurface = new Map<number, Polygon[]>(),
      numbered = new Map<Polygon, number>();
    entry.polygons.forEach((polygon, i) => {
      numbered.set(polygon, i);
      let list = bySurface.get(polygon.surface);
      if (!list) bySurface.set(polygon.surface, (list = []));
      list.push(polygon);
    });
    const cornerRow = (polygon: number, point: number): number => {
      if (!seamed) return NONE;
      const row = maps.map((map) => map.seams.get(polygon)?.get(point)),
        key = row.map((value) => value?.join() ?? '').join(';');
      if (!row.some(Boolean)) return NONE;
      let id = rowOf.get(key);
      if (id === undefined) {
        id = rows.push(row) - 1;
        rowOf.set(key, id);
      }
      return id;
    };
    for (const [surface, polygons] of bySurface) {
      const start = indices.length;
      for (const polygon of polygons) {
        const number = numbered.get(polygon)!;
        const corners = polygon.corners.map((point) => {
          if (!(point < pointCount))
            throw new LoaderError(F, 'range', `polygon index ${point} is outside 0..${pointCount - 1}`);
          return welder.weld(point, cornerRow(number, point), NONE, NONE);
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
        color = name === undefined ? undefined : surfaces.find((item) => item.name === name)?.color;
      if (entry.name) group.objectId = entry.name;
      if (color) group.color = [...color, 1];
      groups.push(group);
    }
    const keys = welder.keys.array,
      slots = new Map([...entry.maps.keys()].map((key, i) => [key, i]));
    for (let v = 0; v < welder.count; v++) {
      const point = keys[v * 4],
        row = keys[v * 4 + 1],
        at = point * 3;
      // LightWave is left-handed with clockwise fronts: negating z gives right-handed, counter-clockwise fronts.
      positions.push3(entry.points[at], entry.points[at + 1], -entry.points[at + 2]);
      for (const [key, { size, values }] of outputs) {
        const slot = slots.get(key),
          map = slot === undefined ? undefined : maps[slot],
          value = (row === NONE || slot === undefined ? undefined : rows[row][slot]) ?? map?.points.get(point);
        for (let c = 0; c < size; c++) values.push(value?.[c] ?? 0);
        if (key === entry.firstUV) {
          uvs.push(value?.[0] ?? 0);
          uvs.push(value?.[1] ?? 0);
        }
      }
      if (textured && !entry.firstUV) {
        uvs.push(0);
        uvs.push(0);
      }
    }
    const first = bones.length,
      place = (point: number): [number, number, number] => {
        if (!(point < pointCount))
          throw new LoaderError(F, 'range', `bone point ${point} is outside 0..${pointCount - 1}`);
        return [entry.points[point * 3], entry.points[point * 3 + 1], -entry.points[point * 3 + 2]];
      },
      tips = new Map(entry.bones.map((bone, i) => [bone.corners[1], first + i]));
    entry.bones.forEach((bone, i) => {
      const out: LWOBone = {
        start: place(bone.corners[0]),
        end: place(bone.corners[1]),
        parent: tips.get(bone.corners[0]) ?? -1,
        layer: entry.name,
      };
      // A loop of bones has no root: the bone that closes it stands alone, so every chain ends.
      for (let up = out.parent; up >= 0; up = bones[up]?.parent ?? -1)
        if (up === first + i) {
          out.parent = -1;
          break;
        }
      if (bone.tag !== undefined && tags[bone.tag] !== undefined) out.name = tags[bone.tag];
      if (bone.weightTag !== undefined && tags[bone.weightTag] !== undefined) out.weightMap = tags[bone.weightTag];
      bones.push(out);
    });
  }
  if (!indices.length) throw new LoaderError(F, 'syntax', 'the file has no polygons');
  const byClip = new Map(images.map(({ clip, path }) => [clip, path])),
    mapsOf = (kind: string): Record<string, Float32Array> =>
      Object.fromEntries(
        [...outputs.values()].filter((map) => map.kind === kind).map(({ name, values }) => [name, values.result()]),
      );
  for (const surface of surfaces)
    for (const map of surface.maps) {
      const path = map.clip === undefined ? undefined : byClip.get(map.clip);
      if (path !== undefined) map.path = path;
      delete map.clip;
    }
  const model: LWOModel = {
    kind: 'mesh',
    positions: positions.result(),
    indices: indices.result(),
    groups,
    uvMaps: mapsOf('TXUV'),
    weightMaps: mapsOf('WGHT'),
    images,
    surfaces,
    bones,
    warnings: [...warnings],
  };
  if (textured) model.uvs = uvs.result();
  return model;
}
