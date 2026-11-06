// 3D Studio .3ds files: the chunk tree, triangle meshes, UVs, materials and the face lists that assign them.
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

/** What {@link parse3DS} returns. Coordinates are the file's: no unit, Z up, as 3D Studio saved them. */
export interface ThreeDSResult extends LoadedGeometry {
  kind: 'mesh';
  groups: ThreeDSGroup[];
  materials: ThreeDSMaterial[];
  /** The file's master scale, 1 when it has none. */
  masterScale: number;
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

function color(reader: Reader, chunk: Chunk): [number, number, number] | undefined {
  let found: [number, number, number] | undefined;
  for (const { id, start, end } of reader.chunks(chunk.start, chunk.end)) {
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
      const rgb = color(reader, part);
      if (rgb) out.color = [...rgb, out.color[3]];
    } else if (part.id === 0xa050) out.color[3] = 1 - percent(reader, part);
    else if (part.id === 0xa200)
      for (const map of reader.chunks(part.start, part.end))
        if (map.id === 0xa300) [out.texture] = reader.name(map.start, map.end);
  }
  return out;
}

/**
 * Reads a 3D Studio `.3ds` file: every triangle mesh with its UVs, one group per object and material, and the materials'
 * colours, transparency and diffuse map names. Vertices are saved in world space, so no transform applies. Cameras,
 * lights and keyframes are skipped.
 *
 * @param input The file's bytes.
 * @param options The shared size limits.
 * @returns The merged mesh, its materials and the master scale.
 * @throws LoaderError with code `header`, `truncated`, `range`, `limit` or `syntax` (no mesh in the file).
 *
 * @example
 * ```ts
 * import { parse3DS } from '@margoengine/loaders/3ds';
 *
 * const bytes = await (await fetch('/models/teapot.3ds')).arrayBuffer();
 * const { groups, materials } = parse3DS(bytes);
 * console.log(groups.length, materials[0]?.texture);
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
    pending: { name: string; base: number; faces: Uint32Array; lists: { material: string; faces: number[] }[] }[] = [];
  let masterScale = 1,
    textured = false;

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
      else if (chunk.id === 0x0100) {
        reader.need(chunk.start, 4, chunk.end, 'the master scale');
        masterScale = view.getFloat32(chunk.start, true);
      } else if (chunk.id === 0x4000) {
        const [name, after] = reader.name(chunk.start, chunk.end);
        for (const part of reader.chunks(after, chunk.end)) if (part.id === 0x4100) trimesh(name, part);
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
  };
  if (textured) {
    while (uvs.length < result.positions.length / 3 * 2) uvs.push(0);
    result.uvs = uvs.result();
  }
  return result;
}
