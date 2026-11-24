// 3D Studio .3ds files: the chunk tree, triangle meshes, UVs, materials, the face lists that assign them, cameras, lights
// and the keyframer's nodes and tracks.
import { LoaderError, type LoadedGeometry, type LoadedGroup, type ParseLimits } from './types.js';
import { floats, latin1, limits, toBytes, uints, type BinaryInput } from './util.js';

const F = '3DS';
const MAX_DEPTH = 32;

/** Options of {@link parse3DS}: the shared size limits. */
export interface ThreeDSOptions extends ParseLimits {}

/** One material of a {@link ThreeDSResult}. Colours are sRGB in [0,1]. */
export interface ThreeDSMaterial {
  name: string;
  /** `[r, g, b, a]`, the alpha from the file's transparency. */
  color: [number, number, number, number];
  /** The diffuse map's file name, as written. */
  texture?: string;
}

/** A group of a {@link ThreeDSResult}: the faces of one object in one material. */
export interface ThreeDSGroup extends LoadedGroup {
  /** Index into `materials`. */
  material?: number;
}

/** A camera of a {@link ThreeDSResult}. */
export interface ThreeDSCamera {
  name: string;
  position: [number, number, number];
  /** The point it looks at. */
  target: [number, number, number];
  /** Bank about the view direction, in degrees. */
  roll: number;
  /** Lens focal length in millimetres, on 3D Studio's 35 mm film. */
  lens: number;
}

/** A light of a {@link ThreeDSResult}. A light with no `spot` shines every way from `position`. */
export interface ThreeDSLight {
  name: string;
  position: [number, number, number];
  /** Linear `[r, g, b]`, as the file gives it. */
  color: [number, number, number];
  /** False when the file has the light switched off. */
  on: boolean;
  /** The file's multiplier, 1 when it has none. */
  multiplier: number;
  /** Spotlight data: the point aimed at and the two cone angles in degrees. */
  spot?: { target: [number, number, number]; hotspot: number; falloff: number };
}

/** One key of a {@link ThreeDSTrack}. The spline values are there only when the file stores them. */
export interface ThreeDSKey {
  frame: number;
  /** The track's value: xyz for `position` and `scale`, `[radians, x, y, z]` for `rotation`, rgb for `color`, else one number. */
  value: number[];
  tension?: number;
  continuity?: number;
  bias?: number;
  easeTo?: number;
  easeFrom?: number;
}

/** A keyframe track of a {@link ThreeDSNode}, in the order of its frames. */
export interface ThreeDSTrack {
  /** The file's track flags: bits 0 and 1 are 2 for a repeating track, 3 for a looping one. */
  flags: number;
  keys: ThreeDSKey[];
}

/** One node of the keyframer. Rotation keys are axis and angle, each relative to the key before it, as 3D Studio saves them. */
export interface ThreeDSNode {
  /** The file's node id, or the node's position in the list when it has none. */
  id: number;
  kind: 'ambient' | 'object' | 'camera' | 'cameraTarget' | 'light' | 'spotTarget' | 'spot';
  /** The object, camera or light this node animates. `$$$DUMMY` is a dummy node, and `$AMBIENT$` the ambient light. */
  name: string;
  /** The instance name a dummy or a repeated object has. */
  instance?: string;
  /** The `id` of the parent node, -1 at the root. */
  parent: number;
  /** The pivot, in the object's coordinates. */
  pivot: [number, number, number];
  tracks: { [K in 'position' | 'rotation' | 'scale' | 'fov' | 'roll' | 'color' | 'hotspot' | 'falloff']?: ThreeDSTrack };
}

/** The keyframer's data of a {@link ThreeDSResult}. */
export interface ThreeDSKeyframes {
  /** The first and last frame of the active segment. */
  start: number;
  end: number;
  /** Frames in the whole animation. */
  length: number;
  nodes: ThreeDSNode[];
}

/** What {@link parse3DS} returns. Coordinates are the file's: no unit, Z up, as 3D Studio saved them. */
export interface ThreeDSResult extends LoadedGeometry {
  kind: 'mesh';
  groups: ThreeDSGroup[];
  materials: ThreeDSMaterial[];
  /** The file's master scale, 1 when it has none. */
  masterScale: number;
  cameras: ThreeDSCamera[];
  lights: ThreeDSLight[];
  /** The ambient light's linear `[r, g, b]`, when the file sets one. */
  ambient?: [number, number, number];
  /** The keyframer's data, when the file has any. */
  keyframes?: ThreeDSKeyframes;
}

interface Chunk {
  id: number;
  start: number;
  end: number;
}

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  /** The chunks directly inside `start..end`, each checked against its parent. */
  *chunks(start: number, end: number): Generator<Chunk> {
    for (let pos = start; pos + 6 <= end; ) {
      const id = this.view.getUint16(pos, true),
        length = this.view.getUint32(pos + 2, true);
      if (length < 6 || pos + length > end)
        throw new LoaderError(F, 'truncated', `chunk 0x${id.toString(16)} at ${pos} runs past its parent`);
      yield { id, start: pos + 6, end: pos + length };
      pos += length;
    }
  }
  /** Reads a zero-ended name and returns it with the offset after it. */
  name(start: number, end: number): [string, number] {
    let pos = start;
    while (pos < end && this.bytes[pos]) pos++;
    if (pos >= end) throw new LoaderError(F, 'truncated', 'a name has no end');
    return [latin1(this.bytes, start, pos), pos + 1];
  }
  need(start: number, size: number, end: number, what: string): void {
    if (start + size > end) throw new LoaderError(F, 'truncated', `${what} run past their chunk`);
  }
}

function color(reader: Reader, from: number, to: number): [number, number, number] | undefined {
  let found: [number, number, number] | undefined;
  for (const { id, start, end } of reader.chunks(from, to)) {
    // Prefer the gamma-corrected form when a file gives both, which is the one the artist saw.
    if (id === 0x0011 || id === 0x0012) {
      reader.need(start, 3, end, 'colour bytes');
      found = [reader.bytes[start] / 255, reader.bytes[start + 1] / 255, reader.bytes[start + 2] / 255];
    } else if ((id === 0x0010 || id === 0x0013) && !found) {
      reader.need(start, 12, end, 'colour floats');
      const at = (i: number): number => reader.view.getFloat32(start + i * 4, true);
      found = [at(0), at(1), at(2)];
    }
  }
  return found;
}

function percent(reader: Reader, chunk: Chunk): number {
  for (const { id, start, end } of reader.chunks(chunk.start, chunk.end)) {
    if (id === 0x0030) {
      reader.need(start, 2, end, 'a percentage');
      return reader.view.getInt16(start, true) / 100;
    }
    if (id === 0x0031) {
      reader.need(start, 4, end, 'a percentage');
      return reader.view.getFloat32(start, true) / 100;
    }
  }
  return 0;
}

function material(reader: Reader, chunk: Chunk): ThreeDSMaterial {
  const out: ThreeDSMaterial = { name: '', color: [1, 1, 1, 1] };
  for (const part of reader.chunks(chunk.start, chunk.end)) {
    if (part.id === 0xa000) [out.name] = reader.name(part.start, part.end);
    else if (part.id === 0xa020) {
      const rgb = color(reader, part.start, part.end);
      if (rgb) out.color = [...rgb, out.color[3]];
    } else if (part.id === 0xa050) out.color[3] = 1 - percent(reader, part);
    else if (part.id === 0xa200)
      for (const map of reader.chunks(part.start, part.end))
        if (map.id === 0xa300) [out.texture] = reader.name(map.start, map.end);
  }
  return out;
}

function vector(reader: Reader, at: number, end: number, what: string): [number, number, number] {
  reader.need(at, 12, end, what);
  const { view } = reader;
  return [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)];
}

function camera(reader: Reader, name: string, chunk: Chunk): ThreeDSCamera {
  reader.need(chunk.start, 32, chunk.end, 'camera values');
  const { view } = reader;
  return {
    name,
    position: vector(reader, chunk.start, chunk.end, 'camera values'),
    target: vector(reader, chunk.start + 12, chunk.end, 'camera values'),
    roll: view.getFloat32(chunk.start + 24, true),
    lens: view.getFloat32(chunk.start + 28, true),
  };
}

function light(reader: Reader, name: string, chunk: Chunk): ThreeDSLight {
  const out: ThreeDSLight = {
    name,
    position: vector(reader, chunk.start, chunk.end, 'light values'),
    color: color(reader, chunk.start + 12, chunk.end) ?? [1, 1, 1],
    on: true,
    multiplier: 1,
  };
  for (const part of reader.chunks(chunk.start + 12, chunk.end)) {
    if (part.id === 0x4620) out.on = false;
    else if (part.id === 0x465b) {
      reader.need(part.start, 4, part.end, 'the light multiplier');
      out.multiplier = reader.view.getFloat32(part.start, true);
    } else if (part.id === 0x4610) {
      reader.need(part.start, 20, part.end, 'spotlight values');
      out.spot = {
        target: vector(reader, part.start, part.end, 'spotlight values'),
        hotspot: reader.view.getFloat32(part.start + 12, true),
        falloff: reader.view.getFloat32(part.start + 16, true),
      };
    }
  }
  return out;
}

const NODE_KINDS: Record<number, ThreeDSNode['kind']> = {
  0xb001: 'ambient',
  0xb002: 'object',
  0xb003: 'camera',
  0xb004: 'cameraTarget',
  0xb005: 'light',
  0xb006: 'spotTarget',
  0xb007: 'spot',
};
/** Each track chunk's name in {@link ThreeDSNode.tracks} and the floats one key's value holds. */
const TRACKS: Record<number, [keyof ThreeDSNode['tracks'], number]> = {
  0xb020: ['position', 3],
  0xb021: ['rotation', 4],
  0xb022: ['scale', 3],
  0xb023: ['fov', 1],
  0xb024: ['roll', 1],
  0xb025: ['color', 3],
  0xb027: ['hotspot', 1],
  0xb028: ['falloff', 1],
};
const SPLINE = ['tension', 'continuity', 'bias', 'easeTo', 'easeFrom'] as const;

function track(reader: Reader, chunk: Chunk, size: number): ThreeDSTrack {
  const { view } = reader;
  reader.need(chunk.start, 14, chunk.end, 'a track header');
  // The flags, eight bytes that mean nothing, and the key count.
  const flags = view.getUint16(chunk.start, true),
    count = view.getUint32(chunk.start + 10, true),
    keys: ThreeDSKey[] = [];
  let at = chunk.start + 14;
  for (let i = 0; i < count; i++) {
    reader.need(at, 6, chunk.end, 'track keys');
    const key: ThreeDSKey = { frame: view.getUint32(at, true), value: [] },
      used = view.getUint16(at + 4, true);
    at += 6;
    SPLINE.forEach((name, bit) => {
      if (!(used & (1 << bit))) return;
      reader.need(at, 4, chunk.end, 'track keys');
      key[name] = view.getFloat32(at, true);
      at += 4;
    });
    reader.need(at, size * 4, chunk.end, 'track keys');
    for (let k = 0; k < size; k++, at += 4) key.value.push(view.getFloat32(at, true));
    keys.push(key);
  }
  return { flags, keys };
}

function keyframes(reader: Reader, chunk: Chunk): ThreeDSKeyframes {
  const out: ThreeDSKeyframes = { start: 0, end: 0, length: 0, nodes: [] },
    { view } = reader;
  for (const part of reader.chunks(chunk.start, chunk.end)) {
    if (part.id === 0xb00a) {
      const [, after] = reader.name(part.start + 2, part.end);
      reader.need(after, 4, part.end, 'the keyframer header');
      out.length = view.getUint32(after, true);
    } else if (part.id === 0xb008) {
      reader.need(part.start, 8, part.end, 'the keyframer segment');
      out.start = view.getUint32(part.start, true);
      out.end = view.getUint32(part.start + 4, true);
    } else if (NODE_KINDS[part.id]) {
      const node: ThreeDSNode = {
        id: out.nodes.length,
        kind: NODE_KINDS[part.id],
        name: '',
        parent: -1,
        pivot: [0, 0, 0],
        tracks: {},
      };
      for (const field of reader.chunks(part.start, part.end)) {
        if (field.id === 0xb030) {
          reader.need(field.start, 2, field.end, 'a node id');
          node.id = view.getUint16(field.start, true);
        } else if (field.id === 0xb010) {
          const [name, after] = reader.name(field.start, field.end);
          reader.need(after, 6, field.end, 'a node header');
          node.name = name;
          node.parent = view.getInt16(after + 4, true);
        } else if (field.id === 0xb011) [node.instance] = reader.name(field.start, field.end);
        else if (field.id === 0xb013) node.pivot = vector(reader, field.start, field.end, 'a pivot');
        else if (TRACKS[field.id]) {
          const [name, size] = TRACKS[field.id];
          node.tracks[name] = track(reader, field, size);
        }
      }
      out.nodes.push(node);
    }
  }
  return out;
}

/**
 * Reads a 3D Studio `.3ds` file: every triangle mesh with its UVs, one group per object and material, the materials'
 * colours, transparency and diffuse map names, the cameras and lights, and the keyframer's nodes and tracks. Vertices are
 * saved in world space, so no transform applies. Cameras, lights and keyframes are returned as the file holds them, in
 * its coordinates. `loadTextures` from `@margoengine/loaders/textures` reads the maps the materials name.
 *
 * @param input The file's bytes.
 * @param options The shared size limits.
 * @returns The merged mesh, its materials, the master scale, cameras, lights and keyframes.
 * @throws LoaderError with code `header`, `truncated`, `range`, `limit` or `syntax` (no mesh in the file).
 *
 * @example
 * ```ts
 * import { parse3DS } from '@margoengine/loaders/3ds';
 *
 * const bytes = await (await fetch('/models/teapot.3ds')).arrayBuffer();
 * const { groups, materials, cameras, keyframes } = parse3DS(bytes);
 * console.log(groups.length, materials[0]?.texture, cameras[0]?.lens, keyframes?.nodes.length);
 * ```
 */
export function parse3DS(input: BinaryInput, options: ThreeDSOptions = {}): ThreeDSResult {
  const bytes = toBytes(input, F),
    { maxVertices, maxTriangles } = limits(options, F);
  if (bytes.length < 6) throw new LoaderError(F, 'header', 'the file is too small');
  const reader = new Reader(bytes),
    { view } = reader;
  if (view.getUint16(0, true) !== 0x4d4d) throw new LoaderError(F, 'header', 'missing the 0x4D4D main chunk');
  const length = view.getUint32(2, true);
  if (length < 6 || length > bytes.length) throw new LoaderError(F, 'truncated', 'the main chunk runs past the file');
  const positions = floats(),
    uvs = floats(),
    indices = uints(),
    groups: ThreeDSGroup[] = [],
    materials: ThreeDSMaterial[] = [],
    cameras: ThreeDSCamera[] = [],
    lights: ThreeDSLight[] = [],
    pending: { name: string; base: number; faces: Uint32Array; lists: { material: string; faces: number[] }[] }[] = [];
  let masterScale = 1,
    textured = false,
    ambient: [number, number, number] | undefined,
    keyframer: ThreeDSKeyframes | undefined;

  const trimesh = (name: string, chunk: Chunk): void => {
    const base = positions.length / 3;
    let count = 0,
      faces: Uint32Array | undefined,
      coordinates = false;
    const lists: { material: string; faces: number[] }[] = [];
    for (const part of reader.chunks(chunk.start, chunk.end)) {
      if (part.id === 0x4110) {
        reader.need(part.start, 2, part.end, 'vertices');
        count = view.getUint16(part.start, true);
        reader.need(part.start + 2, count * 12, part.end, 'vertices');
        if (base + count > maxVertices)
          throw new LoaderError(F, 'limit', `vertex count exceeds the limit of ${maxVertices}`);
        for (let i = 0, at = part.start + 2; i < count; i++, at += 12)
          positions.push3(view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true));
      } else if (part.id === 0x4120) {
        reader.need(part.start, 2, part.end, 'faces');
        const total = view.getUint16(part.start, true),
          after = part.start + 2 + total * 8;
        reader.need(part.start + 2, total * 8, part.end, 'faces');
        faces = new Uint32Array(total * 3);
        for (let i = 0; i < total; i++)
          for (let k = 0; k < 3; k++) faces[i * 3 + k] = view.getUint16(part.start + 2 + i * 8 + k * 2, true);
        for (const list of reader.chunks(after, part.end)) {
          if (list.id !== 0x4130) continue;
          const [material, at] = reader.name(list.start, list.end);
          reader.need(at, 2, list.end, 'a face list');
          const size = view.getUint16(at, true);
          reader.need(at + 2, size * 2, list.end, 'a face list');
          const members: number[] = [];
          for (let i = 0; i < size; i++) {
            const face = view.getUint16(at + 2 + i * 2, true);
            if (face >= total) throw new LoaderError(F, 'range', `face ${face} of ${name.slice(0, 32)} does not exist`);
            members.push(face);
          }
          lists.push({ material, faces: members });
        }
      } else if (part.id === 0x4140) {
        reader.need(part.start, 2, part.end, 'texture coordinates');
        const total = view.getUint16(part.start, true);
        reader.need(part.start + 2, total * 8, part.end, 'texture coordinates');
        if (uvs.length < base * 2) for (let i = uvs.length; i < base * 2; i++) uvs.push(0);
        for (let i = 0, at = part.start + 2; i < total; i++, at += 8) {
          uvs.push(view.getFloat32(at, true));
          uvs.push(1 - view.getFloat32(at + 4, true));
        }
        coordinates = textured = true;
        if (count && total !== count)
          throw new LoaderError(F, 'range', `${name.slice(0, 32)} has ${total} coordinates for ${count} vertices`);
      }
    }
    if (textured && !coordinates) for (let i = 0; i < count * 2; i++) uvs.push(0);
    if (!faces) return;
    for (let i = 0; i < faces.length; i++)
      if (faces[i] >= count) throw new LoaderError(F, 'range', `face index ${faces[i]} is outside 0..${count - 1}`);
    pending.push({ name, base, faces, lists });
  };

  const walk = (start: number, end: number, depth: number): void => {
    if (depth > MAX_DEPTH) throw new LoaderError(F, 'limit', `chunks nest deeper than ${MAX_DEPTH}`);
    for (const chunk of reader.chunks(start, end)) {
      if (chunk.id === 0x3d3d) walk(chunk.start, chunk.end, depth + 1);
      else if (chunk.id === 0xafff) materials.push(material(reader, chunk));
      else if (chunk.id === 0xb000) keyframer = keyframes(reader, chunk);
      else if (chunk.id === 0x2100) ambient = color(reader, chunk.start, chunk.end);
      else if (chunk.id === 0x0100) {
        reader.need(chunk.start, 4, chunk.end, 'the master scale');
        masterScale = view.getFloat32(chunk.start, true);
      } else if (chunk.id === 0x4000) {
        const [name, after] = reader.name(chunk.start, chunk.end);
        for (const part of reader.chunks(after, chunk.end)) {
          if (part.id === 0x4100) trimesh(name, part);
          else if (part.id === 0x4600) lights.push(light(reader, name, part));
          else if (part.id === 0x4700) cameras.push(camera(reader, name, part));
        }
      }
    }
  };
  walk(6, length, 0);

  // Materials can follow the meshes that use them, so the groups are built last.
  const emit = (name: string, base: number, faces: Uint32Array, members: Iterable<number>, materialName?: string): void => {
    const start = indices.length;
    for (const face of members) {
      if (indices.length / 3 >= maxTriangles)
        throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${maxTriangles}`);
      indices.push3(base + faces[face * 3], base + faces[face * 3 + 1], base + faces[face * 3 + 2]);
    }
    if (indices.length === start) return;
    const group: ThreeDSGroup = { start, count: indices.length - start, name },
      index = materials.findIndex((entry) => entry.name === materialName);
    if (index >= 0) {
      group.material = index;
      group.color = [...materials[index].color];
    }
    groups.push(group);
  };
  for (const { name, base, faces, lists } of pending) {
    const rest = new Set(Array.from({ length: faces.length / 3 }, (_, i) => i));
    for (const list of lists) {
      const members = list.faces.filter((face) => rest.delete(face));
      emit(name, base, faces, members, list.material);
    }
    emit(name, base, faces, rest);
  }
  if (!indices.length) throw new LoaderError(F, 'syntax', 'the file holds no triangle mesh');
  const result: ThreeDSResult = {
    kind: 'mesh',
    positions: positions.result(),
    indices: indices.result(),
    groups,
    materials,
    masterScale,
    cameras,
    lights,
  };
  if (ambient) result.ambient = ambient;
  if (keyframer) result.keyframes = keyframer;
  if (textured) {
    while (uvs.length < result.positions.length / 3 * 2) uvs.push(0);
    result.uvs = uvs.result();
  }
  return result;
}
