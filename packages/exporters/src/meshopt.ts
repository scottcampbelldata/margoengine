// compressMeshopt: a GLB in, the same GLB with EXT_meshopt_compression geometry and, by default, KHR_mesh_quantization
// vertices out. Both are plain code, so this needs no Wasm, no worker and no download.
import { inProcess } from './encoder-host.js';
import {
  columnOf,
  compacted,
  dropUnreadAccessors,
  elementsOf,
  packed,
  reordered,
  SIZES,
  type Column,
} from './glb-columns.js';
import { joinGLB, readAccessor, splitGLB } from './glb.js';
import { packGLB, useExtension, type JSONObject, type NewViews } from './glb-pack.js';
import { encodeTriangles, encodeVertexBuffer } from './meshopt-encode.js';

export { encodeTriangles, encodeVertexBuffer } from './meshopt-encode.js';

const EXTENSION = 'EXT_meshopt_compression';
const QUANTIZATION = 'KHR_mesh_quantization';

/** Options for {@link compressMeshopt}. */
export interface CompressMeshoptOptions {
  /**
   * Stores vertices as small integers (KHR_mesh_quantization): positions in 16 bits on one grid for the whole mesh, with
   * the grid folded into the node's transform; normals and tangents in `normalBits`; texture coordinates from 0 to 1 in
   * 16 bits; colours and skin weights in 8. Default true.
   */
  quantize?: boolean;
  /** Bits of NORMAL and TANGENT when quantizing: 8 or 16. Default 8. */
  normalBits?: 8 | 16;
  /** Stops between primitives. */
  signal?: AbortSignal;
}

/** A primitive {@link compressMeshopt} left as it was, and why. */
export interface MeshoptSkippedPrimitive {
  /** Index in `meshes`. */
  mesh: number;
  /** Index in the mesh's `primitives`. */
  primitive: number;
  reason: 'draco' | 'no-position';
}

/** What {@link compressMeshopt} returns. */
export interface CompressMeshoptResult {
  /** The compressed file. The input bytes when nothing could be compressed. */
  glb: Uint8Array;
  /** Buffer views now held in meshopt streams. */
  compressed: number;
  /** Vertex attributes now held as integers. */
  quantized: number;
  /** Primitives left uncompressed. */
  skipped: MeshoptSkippedPrimitive[];
}

const rounded = (value: number, most: number): number => Math.max(-most, Math.min(most, Math.round(value * most)));

/** Signed normalized integers, for values from -1 to 1. */
function signed(column: Column, bits: 8 | 16): Column {
  const most = bits === 8 ? 127 : 32767,
    out = bits === 8 ? new Int8Array(column.values.length) : new Int16Array(column.values.length);
  for (let i = 0; i < out.length; i++) out[i] = rounded(column.values[i], most);
  return { ...column, values: out, componentType: bits === 8 ? 5120 : 5122, normalized: true };
}

/** Unsigned 16-bit normalized texture coordinates, or undefined when the values leave 0 to 1, which they then cannot hold. */
function texcoords(column: Column): Column | undefined {
  const out = new Uint16Array(column.values.length);
  for (let i = 0; i < out.length; i++) {
    const value = column.values[i];
    if (value < 0 || value > 1) return undefined;
    out[i] = Math.round(value * 65535);
  }
  return { ...column, values: out, componentType: 5123, normalized: true };
}

/** Unsigned 8-bit normalized colours. RGB gains an alpha of 1, because a VEC3 of bytes would need padding anyway. */
function colors(column: Column): Column {
  const count = elementsOf(column),
    out = new Uint8Array(count * 4),
    byte = (value: number): number => Math.max(0, Math.min(255, Math.round(value * 255)));
  for (let v = 0; v < count; v++) {
    for (let c = 0; c < 3; c++) out[v * 4 + c] = byte(column.values[v * column.width + c]);
    out[v * 4 + 3] = column.width === 4 ? byte(column.values[v * 4 + 3]) : 255;
  }
  return { ...column, values: out, width: 4, type: 'VEC4', componentType: 5121, normalized: true };
}

/** Unsigned 8-bit normalized weights. Their sum must stay 1, so the rounding error goes on the largest. */
function weights(column: Column): Column {
  const out = new Uint8Array(column.values.length);
  for (let at = 0; at < out.length; at += 4) {
    let sum = 0,
      largest = at;
    for (let c = at; c < at + 4; c++) {
      out[c] = Math.max(0, Math.min(255, Math.round(column.values[c] * 255)));
      sum += out[c];
      if (out[c] > out[largest]) largest = c;
    }
    if (sum > 0) out[largest] = Math.max(0, Math.min(255, out[largest] + 255 - sum));
  }
  return { ...column, values: out, componentType: 5121, normalized: true };
}

/** One attribute of a mesh in its quantized form, or undefined when it stays as it is. */
function quantized(name: string, column: Column, normalBits: 8 | 16): Column | undefined {
  if (column.componentType !== 5126) return undefined;
  if (name === 'NORMAL' || name === 'TANGENT') return signed(column, normalBits);
  if (/^TEXCOORD_\d+$/.test(name)) return texcoords(column);
  if (/^COLOR_\d+$/.test(name)) return colors(column);
  if (/^WEIGHTS_\d+$/.test(name) && column.width === 4) return weights(column);
  return undefined;
}

/** The grid of a mesh's positions: its centre and the half width of its widest axis, the same on all three axes. */
function gridOf(positions: readonly Column[]): { centre: number[]; half: number } | undefined {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const { values } of positions)
    for (let i = 0; i < values.length; i++) {
      const axis = i % 3;
      if (values[i] < min[axis]) min[axis] = values[i];
      if (values[i] > max[axis]) max[axis] = values[i];
    }
  if (!min.every(Number.isFinite)) return undefined;
  // One scale for all axes: a renderer turns normals by the node's inverse transpose, so an uneven scale would skew them.
  return {
    centre: min.map((low, axis) => (low + max[axis]) / 2),
    half: Math.max(...min.map((low, axis) => (max[axis] - low) / 2)) || 1,
  };
}

/** Positions on `grid`, as 16-bit normalized integers a node's scale and translation turn back into metres. */
function gridded(column: Column, { centre, half }: { centre: number[]; half: number }): Column {
  const out = new Int16Array(column.values.length);
  for (let i = 0; i < out.length; i++) out[i] = rounded((column.values[i] - centre[i % 3]) / half, 32767);
  return { ...column, values: out, componentType: 5122, normalized: true };
}

/** `v` turned by quaternion `q`. */
function turned([x, y, z, w]: readonly number[], v: readonly number[]): number[] {
  const cx = y * v[2] - z * v[1] + w * v[0],
    cy = z * v[0] - x * v[2] + w * v[1],
    cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
}

/**
 * Makes node `index` draw grid-space positions: position = centre + half * stored. The grid joins the node's own transform
 * when nothing else depends on that; otherwise the mesh moves to a new child that holds the grid.
 */
function foldGrid(
  json: JSONObject,
  index: number,
  { centre, half }: { centre: number[]; half: number },
  fixed: boolean,
): void {
  const node = json.nodes[index];
  if (fixed) {
    json.nodes.push({
      ...(node.name === undefined ? {} : { name: `${node.name}_mesh` }),
      mesh: node.mesh,
      translation: centre,
      scale: [half, half, half],
    });
    delete node.mesh;
    (node.children ??= []).push(json.nodes.length - 1);
    return;
  }
  if (node.matrix) {
    const m: number[] = node.matrix,
      moved = [0, 1, 2].map((r) => m[r] * centre[0] + m[4 + r] * centre[1] + m[8 + r] * centre[2] + m[12 + r]);
    node.matrix = [...m.slice(0, 12).map((value) => value * half), ...moved, m[15]];
    return;
  }
  const scale = node.scale ?? [1, 1, 1],
    translation = node.translation ?? [0, 0, 0],
    offset = turned(node.rotation ?? [0, 0, 0, 1], [scale[0] * centre[0], scale[1] * centre[1], scale[2] * centre[2]]);
  node.translation = translation.map((value: number, axis: number) => value + offset[axis]);
  node.scale = scale.map((value: number) => value * half);
}

/** A triangle list without triangles that repeat a vertex: they have no area and the triangle codec cannot hold them. */
function withoutDegenerates(indices: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(indices.length);
  let length = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i],
      b = indices[i + 1],
      c = indices[i + 2];
    if (a === b || b === c || a === c) continue;
    out[length++] = a;
    out[length++] = b;
    out[length++] = c;
  }
  return out.subarray(0, length);
}

/** What a primitive needs written: its columns by key, and the encoded triangles when it has any. */
interface Plan {
  primitives: JSONObject[];
  mesh: number;
  columns: Map<string, Column>;
  triangles?: Uint32Array;
}

const compressible = (json: JSONObject, primitive: JSONObject): boolean =>
  Number.isSafeInteger(primitive.attributes?.POSITION) && !primitive.extensions?.KHR_draco_mesh_compression;

/**
 * Stores the geometry of a GLB as EXT_meshopt_compression, with its vertices quantized by default, so a web export loads
 * fast. Skins, morph targets and animation stay; a primitive's vertices are renumbered, which the triangle codec requires.
 * A reader needs the extensions, so both become required. A primitive that keeps Draco is left as it is.
 *
 * @example
 * ```ts
 * import { exportGLB } from '@margoengine/exporters';
 * import { compressMeshopt } from '@margoengine/exporters/meshopt';
 *
 * declare const source: Parameters<typeof exportGLB>[0];
 * const { glb, compressed, quantized, skipped } = await compressMeshopt(exportGLB(source));
 * ```
 *
 * @throws TypeError when `glb` is not a valid GLB or already holds meshopt buffers; RangeError for an option out of range
 * or data that runs past its buffer; the signal's reason on an abort.
 */
export async function compressMeshopt(
  glb: Uint8Array,
  options: CompressMeshoptOptions = {},
): Promise<CompressMeshoptResult> {
  const { quantize = true, normalBits = 8, signal } = options;
  if (normalBits !== 8 && normalBits !== 16)
    throw new RangeError(`compressMeshopt normalBits is ${String(normalBits)}; pass 8 or 16`);
  signal?.throwIfAborted();
  const parts = splitGLB(glb),
    json = parts.json as JSONObject;
  if (json.bufferViews?.some((view: JSONObject) => view.extensions?.[EXTENSION]))
    throw new TypeError(
      'compressMeshopt cannot read meshopt buffers; this GLB is already compressed, so pass the original',
    );

  const skipped: MeshoptSkippedPrimitive[] = [],
    plans = new Map<string, Plan>(),
    meshes: JSONObject[] = json.meshes ?? [],
    nodes: JSONObject[] = json.nodes ?? [],
    held = new Set<number>();
  // Nodes whose own transform means something else too: what an animation drives, and the joints of a skin.
  for (const animation of json.animations ?? [])
    for (const channel of animation.channels ?? []) {
      if (Number.isSafeInteger(channel.target?.node)) held.add(channel.target.node);
      const pointer = /^\/nodes\/(\d+)\//.exec(channel.target?.extensions?.KHR_animation_pointer?.pointer ?? '');
      if (pointer) held.add(Number(pointer[1]));
    }
  for (const skin of json.skins ?? []) for (const joint of skin.joints ?? []) held.add(joint);

  meshes.forEach((mesh, meshIndex) => {
    (mesh.primitives as JSONObject[]).forEach((primitive, index) => {
      if (primitive.extensions?.KHR_draco_mesh_compression)
        skipped.push({ mesh: meshIndex, primitive: index, reason: 'draco' });
      else if (!Number.isSafeInteger(primitive.attributes?.POSITION))
        skipped.push({ mesh: meshIndex, primitive: index, reason: 'no-position' });
      if (!compressible(json, primitive)) return;
      const key = JSON.stringify([
          meshIndex,
          primitive.indices,
          primitive.attributes,
          primitive.targets,
          primitive.mode,
        ]),
        known = plans.get(key);
      if (known) {
        known.primitives.push(primitive);
        return;
      }
      const columns = new Map<string, Column>();
      for (const [name, accessor] of Object.entries<number>(primitive.attributes))
        columns.set(name, columnOf(parts, json, accessor, name === 'POSITION'));
      (primitive.targets ?? []).forEach((target: JSONObject, at: number) => {
        for (const [name, accessor] of Object.entries<number>(target))
          columns.set(`${at} ${name}`, columnOf(parts, json, accessor, name === 'POSITION'));
      });
      const plan: Plan = { primitives: [primitive], mesh: meshIndex, columns };
      if ((primitive.mode ?? 4) === 4 && primitive.indices !== undefined)
        plan.triangles = withoutDegenerates(readAccessor(parts, primitive.indices).values);
      plans.set(key, plan);
    });
  });
  if (!plans.size) return { glb, compressed: 0, quantized: 0, skipped };

  // Quantize mesh by mesh, because positions share a grid across the primitives of a mesh.
  let quantizedCount = 0,
    outsideCore = false;
  if (quantize)
    meshes.forEach((_, meshIndex) => {
      const own = [...plans.values()].filter((plan) => plan.mesh === meshIndex);
      if (!own.length || (meshes[meshIndex].primitives as JSONObject[]).some((p) => !compressible(json, p))) return;
      // Morph targets add to positions and normals as they are, so a mesh with targets keeps its floats.
      if (own.some(({ primitives }) => primitives[0].targets?.length)) return;
      for (const { columns } of own)
        for (const [name, column] of columns) {
          const smaller = quantized(name, column, normalBits);
          if (!smaller) continue;
          columns.set(name, smaller);
          quantizedCount++;
          // Core glTF already allows these integers for texture coordinates, colours and weights.
          outsideCore ||= name === 'NORMAL' || name === 'TANGENT';
        }
      const owners = nodes.flatMap((node, index) => (node.mesh === meshIndex ? [index] : []));
      // A skin ignores the transform of its node, and an instanced node multiplies by more than its own.
      const plain =
        owners.length > 0 && owners.every((index) => nodes[index].skin === undefined && !nodes[index].extensions);
      if (!plain || !own.every(({ columns }) => columns.get('POSITION')!.componentType === 5126)) return;
      const grid = gridOf(own.map(({ columns }) => columns.get('POSITION')!));
      if (!grid) return;
      for (const { columns } of own) {
        columns.set('POSITION', gridded(columns.get('POSITION')!, grid));
        quantizedCount++;
        outsideCore = true;
      }
      for (const index of owners) {
        const node = nodes[index],
          fixed = held.has(index) || node.children?.length > 0 || node.camera !== undefined;
        foldGrid(json, index, grid, fixed);
      }
    });

  // Vertices no triangle uses go, then the triangle codec renumbers the rest.
  const entries = [...plans.values()],
    encoded = await inProcess(
      entries,
      (plan) => {
        if (!plan.triangles?.length) return undefined;
        const indices = compacted(plan.columns, plan.triangles),
          vertices = elementsOf(plan.columns.get('POSITION')!),
          result = encodeTriangles(indices, vertices);
        for (const [name, column] of plan.columns) plan.columns.set(name, reordered(column, result.remap));
        return { ...result, vertices };
      },
      signal,
    );

  // Every other accessor that holds float data a view can stride: animation, skins, instancing.
  json.accessors ??= [];
  json.buffers ??= [];
  json.buffers[0] ??= { byteLength: 0 };
  const views: JSONObject[] = json.bufferViews ?? [],
    fresh: NewViews = new Map(),
    holder = json.buffers.length;
  let fallback = 0,
    compressed = 0;
  const addStream = (bytes: Uint8Array, stream: JSONObject, fields: JSONObject): number => {
    fallback = (fallback + 3) & ~3;
    const index = views.length;
    views.push({
      buffer: holder,
      byteOffset: fallback,
      byteLength: stream.count * stream.byteStride,
      ...fields,
      extensions: { [EXTENSION]: { buffer: 0, byteOffset: 0, byteLength: bytes.length, ...stream } },
    });
    fresh.set(index, bytes);
    fallback += stream.count * stream.byteStride;
    compressed++;
    return index;
  };
  const accessorOf = (column: Column, target: number | undefined): number => {
    const count = elementsOf(column),
      element = column.width * SIZES[column.componentType],
      byteStride = (element + 3) & ~3,
      bytes = encodeVertexBuffer(packed(column, byteStride), count, byteStride),
      bufferView = addStream(
        bytes,
        { byteStride, count, mode: 'ATTRIBUTES' },
        { ...(target ? { byteStride, target } : byteStride === element ? {} : { byteStride }) },
      ),
      accessor: JSONObject = {
        bufferView,
        componentType: column.componentType,
        count,
        type: column.type,
        ...(column.normalized ? { normalized: true } : {}),
      };
    if (column.bounds) {
      accessor.min = new Array(column.width).fill(Infinity);
      accessor.max = new Array(column.width).fill(-Infinity);
      for (let i = 0; i < column.values.length; i++) {
        const c = i % column.width;
        if (column.values[i] < accessor.min[c]) accessor.min[c] = column.values[i];
        if (column.values[i] > accessor.max[c]) accessor.max[c] = column.values[i];
      }
    }
    json.accessors.push(accessor);
    return json.accessors.length - 1;
  };

  entries.forEach((plan, i) => {
    const attributes: Record<string, number> = {},
      targets: Record<string, number>[] = [];
    for (const [name, column] of plan.columns) {
      const accessor = accessorOf(column, 34962),
        [at, semantic] = name.includes(' ') ? name.split(' ') : [undefined, name];
      if (at === undefined) attributes[semantic] = accessor;
      else (targets[Number(at)] ??= {})[semantic] = accessor;
    }
    const triangles = encoded[i];
    let indices: number | undefined;
    if (triangles) {
      const wide = triangles.vertices > 0xffff,
        byteStride = wide ? 4 : 2,
        bufferView = addStream(
          triangles.bytes,
          { byteStride, count: triangles.indices.length, mode: 'TRIANGLES' },
          { target: 34963 },
        );
      json.accessors.push({
        bufferView,
        componentType: wide ? 5125 : 5123,
        count: triangles.indices.length,
        type: 'SCALAR',
      });
      indices = json.accessors.length - 1;
    }
    for (const primitive of plan.primitives) {
      primitive.attributes = { ...attributes };
      if (targets.length) primitive.targets = targets.map((target) => ({ ...target }));
      if (triangles) primitive.indices = indices;
    }
  });

  // Skin matrices and animation samplers: float data, a whole number of 4 bytes an element.
  const carried = new Map<number, number>(),
    carry = (index: number, bounds: boolean): number => {
      let moved = carried.get(index);
      if (moved !== undefined) return moved;
      const column = columnOf(parts, json, index, bounds);
      if (column.componentType !== 5126 || !elementsOf(column)) return index;
      moved = accessorOf(column, undefined);
      carried.set(index, moved);
      return moved;
    };
  for (const skin of json.skins ?? [])
    if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = carry(skin.inverseBindMatrices, false);
  for (const animation of json.animations ?? [])
    for (const sampler of animation.samplers ?? []) {
      sampler.input = carry(sampler.input, true);
      sampler.output = carry(sampler.output, false);
    }

  dropUnreadAccessors(json);
  json.bufferViews = views;
  json.buffers.push({ byteLength: (fallback + 3) & ~3, extensions: { [EXTENSION]: { fallback: true } } });
  useExtension(json, EXTENSION, true);
  if (outsideCore) useExtension(json, QUANTIZATION, true);
  return { glb: joinGLB(packGLB(parts, fresh)), compressed, quantized: quantizedCount, skipped };
}
