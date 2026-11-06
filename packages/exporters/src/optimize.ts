// optimizeGLB: the clean-up a file needs before it ships, GLB in, GLB out. Duplicate images, textures, materials, accessors
// and meshes merge, identical vertices weld, and meshes simplify or gain MSFT_lod levels. Every simplified level is a subset
// of the vertices it came from, so skin weights, morph targets, UVs and normals stay the source's own.
import { columnOf, compacted, dropUnreadAccessors, gathered, packed, SIZES, type Column } from './glb-columns.js';
import { joinGLB, readAccessor, splitGLB, type GLBParts } from './glb.js';
import { addView, packGLB, useExtension, type JSONObject, type NewViews } from './glb-pack.js';
import { sha256 } from './hash.js';
import { inProcess } from './encoder-host.js';

const LOD = 'MSFT_lod';
/** What mesh-edit's simplifier takes in one piece, in vertices or faces. */
const SIMPLIFY_LIMIT = 200_000;
/** Row width of `simplifyAttributes`, and where its fields sit: what it compares, and the normals it rewrites on a flat level. */
const ROW = 20;
const FIELDS: readonly (readonly [name: string, at: number, width: number])[] = [
  ['POSITION', 0, 3],
  ['NORMAL', 4, 3],
  ['TANGENT', 8, 4],
  ['TEXCOORD_0', 12, 2],
  ['TEXCOORD_1', 14, 2],
  ['COLOR_0', 16, 4],
];
/** Largest value of each normalized integer component type. */
const MOST: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
/** Weights closer than 1/32 and deltas closer than 1/1024 of the mesh count as equal when vertices at one spot are told apart. */
const WEIGHT_STEPS = 32,
  DELTA_STEPS = 1024;
/** Extensions that name materials, textures or meshes in ways this pass cannot follow, so those keep their indices. */
const NAMED_ELSEWHERE = ['KHR_animation_pointer', 'KHR_interactivity', LOD];

/** Options for {@link optimizeGLB}. */
export interface OptimizeGLBOptions {
  /** Merges identical images, samplers, textures, materials, accessors and meshes. Default true. */
  dedupe?: boolean;
  /** Merges vertices equal in every attribute and morph target, and drops triangles with no area. Default true. */
  weld?: boolean;
  /** Fraction of each primitive's triangles to keep, above 0 and below 1. Default: nothing is simplified. */
  simplify?: number;
  /**
   * Fraction of the triangles of the file's own meshes each further level keeps, decreasing, above 0 and below 1: written
   * as `MSFT_lod` level nodes. With `simplify`, a fraction of what that leaves. Default: no levels.
   */
  lods?: readonly number[];
  /** `MSFT_screencoverage`: decreasing, 0 to 1, at most one more than `lods`. Default: the reader's own switches. */
  screenCoverage?: readonly number[];
  /** Stops between primitives. */
  signal?: AbortSignal;
}

/** A primitive {@link optimizeGLB} did not weld or simplify, and why. */
export interface OptimizeSkippedPrimitive {
  /** Index in the input's `meshes`. */
  mesh: number;
  /** Index in the mesh's `primitives`. */
  primitive: number;
  /** `'too-large'`: welded, but past the simplifier's 200,000 vertices or faces. `'not-triangles'`: points, lines, strips and fans. */
  reason: 'draco' | 'no-position' | 'not-triangles' | 'too-large';
}

/** What changed, in totals for the file. */
export interface OptimizeStats {
  verticesBefore: number;
  verticesAfter: number;
  trianglesBefore: number;
  trianglesAfter: number;
  /** Duplicates removed, of each kind. Accessors count the ones whose data another accessor already holds. */
  images: number;
  textures: number;
  materials: number;
  accessors: number;
  meshes: number;
  /** Level nodes written. */
  levels: number;
}

/** What {@link optimizeGLB} returns. */
export interface OptimizeGLBResult {
  glb: Uint8Array;
  stats: OptimizeStats;
  skipped: OptimizeSkippedPrimitive[];
}

const uses = (json: JSONObject, name: string): boolean => !!json.extensionsUsed?.includes(name);
const pinned = (json: JSONObject): boolean => NAMED_ELSEWHERE.some((name) => uses(json, name));

/** Sees each item once: every index maps to the first item with its key. */
function firstOf<T>(list: readonly T[], key: (item: T, index: number) => string): number[] {
  const seen = new Map<string, number>();
  return list.map((item, index) => {
    const name = key(item, index),
      first = seen.get(name);
    if (first !== undefined) return first;
    seen.set(name, index);
    return index;
  });
}

/**
 * Removes the items `to` maps elsewhere. Returns how many went and leaves `to` holding each old index's new one.
 */
function squeezed<T>(list: T[], to: number[]): number {
  const kept: T[] = [],
    placed = new Map<number, number>();
  list.forEach((item, index) => {
    if (to[index] !== index) return;
    placed.set(index, kept.length);
    kept.push(item);
  });
  const removed = list.length - kept.length;
  list.length = 0;
  for (const item of kept) list.push(item);
  to.forEach((first, index) => {
    to[index] = placed.get(first)!;
  });
  return removed;
}

/** Calls `visit` on every texture reference of a material, inside any extension: objects under a name ending in Texture. */
function eachTextureInfo(value: unknown, visit: (info: JSONObject) => void): void {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, field] of Object.entries(value)) {
    if (key.endsWith('Texture') && Number.isSafeInteger((field as JSONObject)?.index)) visit(field as JSONObject);
    eachTextureInfo(field, visit);
  }
}

/** Calls `visit` on every object of a texture that names an image: the texture and its image-format extensions. */
function eachImageReference(texture: JSONObject, visit: (holder: JSONObject) => void): void {
  if (Number.isSafeInteger(texture.source)) visit(texture);
  for (const extension of Object.values<JSONObject>(texture.extensions ?? {}))
    if (Number.isSafeInteger(extension?.source)) visit(extension);
}

/** Calls `visit` on every place that names a material. */
function eachMaterialReference(json: JSONObject, visit: (holder: JSONObject) => void): void {
  for (const mesh of json.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      if (Number.isSafeInteger(primitive.material)) visit(primitive);
      for (const mapping of primitive.extensions?.KHR_materials_variants?.mappings ?? [])
        if (Number.isSafeInteger(mapping.material)) visit(mapping);
    }
}

/** Merges images with the same bytes, then what the merge makes equal: samplers, textures, materials. */
function dedupeResources(parts: GLBParts, stats: OptimizeStats): void {
  const json = parts.json as JSONObject,
    textures: JSONObject[] = json.textures ?? [],
    images: JSONObject[] = json.images ?? [],
    bytes = (image: JSONObject): string => {
      if (image.bufferView === undefined) return JSON.stringify(image);
      const view = json.bufferViews[image.bufferView],
        start = view.byteOffset ?? 0;
      return `${image.mimeType}:${sha256(parts.bin!.subarray(start, start + view.byteLength))}`;
    },
    // EXT_lights_image_based names images by index from the file's root.
    toImage = uses(json, 'EXT_lights_image_based') ? images.map((_, i) => i) : firstOf(images, bytes);
  stats.images += squeezed(images, toImage);
  for (const texture of textures)
    eachImageReference(texture, (holder) => {
      holder.source = toImage[holder.source];
    });
  const samplers: JSONObject[] = json.samplers ?? [],
    toSampler = firstOf(samplers, (sampler) => JSON.stringify(sampler));
  squeezed(samplers, toSampler);
  for (const texture of textures) if (texture.sampler !== undefined) texture.sampler = toSampler[texture.sampler];
  if (pinned(json)) return;
  const materials: JSONObject[] = json.materials ?? [],
    toTexture = firstOf(textures, (texture) => JSON.stringify(texture));
  stats.textures += squeezed(textures, toTexture);
  for (const material of materials)
    eachTextureInfo(material, (info) => {
      info.index = toTexture[info.index];
    });
  const toMaterial = firstOf(materials, (material) => JSON.stringify(material));
  stats.materials += squeezed(materials, toMaterial);
  eachMaterialReference(json, (holder) => {
    holder.material = toMaterial[holder.material];
  });
}

/** A triangle list of a primitive with no index accessor. */
const allOf = (count: number): Uint32Array => Uint32Array.from({ length: count - (count % 3) }, (_, i) => i);

/**
 * Merges vertices equal in every given array. Triangles that repeat a vertex go, before and after, and only the vertices
 * the rest use stay, numbered in order of first use. Zero and minus zero count as equal.
 * @returns `keep[new]` is the old vertex, `indices` the triangles in the new numbering.
 */
export function weldVertices(
  arrays: readonly { readonly values: ArrayLike<number>; readonly width: number }[],
  indices: ArrayLike<number>,
  vertexCount: number,
): { keep: number[]; indices: Uint32Array } {
  const scratch = new Float64Array(1),
    bits = new Uint32Array(scratch.buffer),
    hashOf = (vertex: number): number => {
      let hash = 2166136261;
      for (const { values, width } of arrays)
        for (let k = 0; k < width; k++) {
          scratch[0] = values[vertex * width + k] + 0;
          hash = Math.imul(hash ^ bits[0], 16777619);
          hash = Math.imul(hash ^ bits[1], 16777619);
        }
      return hash >>> 0;
    },
    same = (a: number, b: number): boolean => {
      for (const { values, width } of arrays)
        for (let k = 0; k < width; k++) if (values[a * width + k] !== values[b * width + k]) return false;
      return true;
    },
    known = new Int32Array(vertexCount).fill(-1),
    buckets = new Map<number, number[]>(),
    merged = new Uint32Array(indices.length),
    source: number[] = [];
  for (let i = 0; i < indices.length; i++) {
    const vertex = indices[i];
    let id = known[vertex];
    if (id < 0) {
      const hash = hashOf(vertex);
      let bucket = buckets.get(hash);
      if (!bucket) buckets.set(hash, (bucket = []));
      id = bucket.find((other) => same(source[other], vertex)) ?? -1;
      if (id < 0) {
        id = source.length;
        source.push(vertex);
        bucket.push(id);
      }
      known[vertex] = id;
    }
    merged[i] = id;
  }
  const placed = new Int32Array(source.length).fill(-1),
    keep: number[] = [],
    out = new Uint32Array(merged.length);
  let length = 0;
  for (let i = 0; i + 2 < merged.length; i += 3) {
    const a = merged[i],
      b = merged[i + 1],
      c = merged[i + 2];
    if (a === b || b === c || a === c) continue;
    for (const id of [a, b, c]) {
      if (placed[id] < 0) placed[id] = keep.push(source[id]) - 1;
      out[length++] = placed[id];
    }
  }
  return { keep, indices: out.slice(0, length) };
}

/** One distinct primitive: its attributes and morph targets by key, its triangles, and the simplified levels. */
interface Piece {
  primitives: { primitive: JSONObject; mesh: number; index: number }[];
  columns: Map<string, Column>;
  indices: Uint32Array;
  /** Its first level replaces it when `simplify` is set; the rest are the LOD levels. */
  levels: { columns: Map<string, Column>; indices: Uint32Array }[];
}

/**
 * Names what tells vertex `v` apart beyond the packed row: its skin, its morphs and any attribute past the row. Exporters
 * write a seam's two sides with the same skin and morphs up to rounding, so those compare in steps, and a seam stays closed
 * while a shut mouth's lips stay two.
 */
function apartOf(columns: Map<string, Column>): (vertex: number) => string {
  const position = columns.get('POSITION')!,
    low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  position.values.forEach((value, i) => {
    low[i % 3] = Math.min(low[i % 3], value);
    high[i % 3] = Math.max(high[i % 3], value);
  });
  const step = DELTA_STEPS / (Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) || 1),
    skins: [Column, Column][] = [],
    deltas: Column[] = [],
    others: Column[] = [];
  for (const [name, column] of columns) {
    if (name.endsWith(' POSITION')) deltas.push(column);
    else if (name.startsWith('JOINTS_')) skins.push([column, columns.get(name.replace('JOINTS', 'WEIGHTS'))!]);
    else if (!name.startsWith('WEIGHTS_') && !/^\d+ /.test(name) && !FIELDS.some(([field]) => field === name))
      others.push(column);
  }
  return (vertex) => {
    const named: number[] = [];
    for (const [joints, weights] of skins) {
      const scale = weights.normalized ? 1 / MOST[weights.componentType] : 1;
      for (let k = vertex * 4; k < vertex * 4 + 4; k++) {
        const weight = Math.round(weights.values[k] * scale * WEIGHT_STEPS);
        if (weight) named.push(joints.values[k], weight);
      }
    }
    for (const { values, width, normalized, componentType } of deltas) {
      const scale = step / (normalized ? MOST[componentType] : 1);
      for (let k = vertex * width; k < (vertex + 1) * width; k++) named.push(Math.round(values[k] * scale));
    }
    for (const { values, width } of others)
      for (let k = vertex * width; k < (vertex + 1) * width; k++) named.push(values[k]);
    return named.join();
  };
}

/** The levels of a piece, finest first, from the simplifier that keeps every vertex's identity. */
async function simplified(piece: Piece, ratios: readonly number[], signal?: AbortSignal): Promise<Piece['levels']> {
  const { simplifyAttributes } = await import('@margoengine/lod/auto');
  const count = piece.columns.get('POSITION')!.values.length / 3,
    rows = new Float32Array(count * ROW);
  for (const [name, at, room] of FIELDS) {
    const column = piece.columns.get(name);
    if (!column) continue;
    const { values, width, normalized, componentType } = column,
      scale = normalized ? 1 / MOST[componentType] : 1;
    for (let v = 0; v < count; v++)
      for (let k = 0; k < Math.min(width, room); k++) rows[v * ROW + at + k] = values[v * width + k] * scale;
  }
  const levels = await simplifyAttributes({ vertices: rows, indices: piece.indices }, ratios, {
    signal,
    apart: apartOf(piece.columns),
  });
  return levels.map(({ vertices, indices, sources }) => {
    // No sources: a part too small to reach the ratio, kept as it was.
    if (!sources) return { columns: piece.columns, indices: piece.indices };
    const keep = Array.from(sources),
      columns = new Map<string, Column>();
    for (const [name, column] of piece.columns) columns.set(name, gathered(column, keep));
    // A flat-shaded level is the one case with values a source vertex does not hold: each triangle's own normal.
    for (const [name, at, width] of FIELDS.slice(1, 3)) {
      const column = columns.get(name);
      if (!column) continue;
      const most = column.normalized ? MOST[column.componentType] : 0;
      for (let v = 0; v < keep.length; v++)
        for (let k = 0; k < width; k++) {
          const value = vertices[v * ROW + at + k];
          column.values[v * width + k] = most ? Math.round(value * most) : value;
        }
    }
    return { columns, indices };
  });
}

/** Writes a list of triangles and attributes as accessors, sharing what is already written when `shared` is given. */
class Writer {
  private readonly known = new Map<string, number>();
  /** Accessors not written because one already holds their data. */
  reused = 0;
  constructor(
    private readonly json: JSONObject,
    readonly fresh: NewViews,
    private readonly shared: boolean,
  ) {}
  private accessor(key: string, build: () => number): number {
    if (!this.shared) return build();
    let at = this.known.get(key);
    if (at === undefined) this.known.set(key, (at = build()));
    else this.reused++;
    return at;
  }
  column(column: Column): number {
    const element = column.width * SIZES[column.componentType],
      byteStride = (element + 3) & ~3,
      bytes = packed(column, byteStride);
    return this.accessor(
      `${column.type}:${column.componentType}:${column.normalized}:${column.bounds}:${sha256(bytes)}`,
      () => {
        const bufferView = addView(this.json, this.fresh, bytes, {
            target: 34962,
            ...(byteStride === element ? {} : { byteStride }),
          }),
          accessor: JSONObject = {
            bufferView,
            componentType: column.componentType,
            count: column.values.length / column.width,
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
        return this.json.accessors.push(accessor) - 1;
      },
    );
  }
  triangles(indices: Uint32Array, vertices: number): number {
    const wide = vertices > 0xffff,
      values = wide ? indices : Uint16Array.from(indices),
      bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    return this.accessor(`indices:${wide}:${sha256(bytes)}`, () => {
      const bufferView = addView(this.json, this.fresh, bytes, { target: 34963 });
      return (
        this.json.accessors.push({
          bufferView,
          componentType: wide ? 5125 : 5123,
          count: indices.length,
          type: 'SCALAR',
        }) - 1
      );
    });
  }
}

/** The primitive's fields for `columns` and `indices`, as written accessors. */
function accessorFields(
  writer: Writer,
  columns: Map<string, Column>,
  indices: Uint32Array,
): { attributes: Record<string, number>; targets: Record<string, number>[]; indices: number } {
  const attributes: Record<string, number> = {},
    targets: Record<string, number>[] = [];
  let vertices = 0;
  for (const [name, column] of columns) {
    const accessor = writer.column(column),
      target = /^(\d+) (.+)$/.exec(name);
    if (target) (targets[Number(target[1])] ??= {})[target[2]] = accessor;
    else {
      attributes[name] = accessor;
      vertices = column.values.length / column.width;
    }
  }
  return { attributes, targets, indices: writer.triangles(indices, vertices) };
}

const fractions = (values: readonly number[], name: string): void => {
  if (values.some((v, i) => !(v > 0 && v < 1) || (i > 0 && v >= values[i - 1])))
    throw new RangeError(`optimizeGLB ${name} must decrease from below 1 to above 0; pass for example [0.5, 0.25]`);
};

/**
 * Cleans a GLB before it ships, so no separate tool chain is needed. By default duplicate data merges and identical vertices
 * weld, which changes nothing a viewer shows. `simplify` and `lods` reduce triangles by quadric edge collapses: each level
 * keeps a subset of the vertices, so skins and morph targets carry over, and UV seams and hard edges stay closed.
 * Compress afterwards, with `compressDraco` or `compressMeshopt`.
 *
 * @example
 * ```ts
 * import { exportGLB } from '@margoengine/exporters';
 * import { optimizeGLB } from '@margoengine/exporters/optimize';
 *
 * declare const source: Parameters<typeof exportGLB>[0];
 * const { glb, stats } = await optimizeGLB(exportGLB(source), { simplify: 0.5, lods: [0.5, 0.25] });
 * ```
 *
 * @throws TypeError when `glb` is not a valid GLB, or its geometry is meshopt-compressed; RangeError for an option out of
 * range or data that runs past its buffer; the signal's reason on an abort.
 */
export async function optimizeGLB(glb: Uint8Array, options: OptimizeGLBOptions = {}): Promise<OptimizeGLBResult> {
  const { dedupe = true, weld = true, simplify, lods = [], screenCoverage, signal } = options;
  if (simplify !== undefined && !(simplify > 0 && simplify < 1))
    throw new RangeError(`optimizeGLB simplify is ${String(simplify)}; pass a fraction above 0 and below 1`);
  if (!Array.isArray(lods)) throw new TypeError('optimizeGLB lods must be an array; pass for example [0.5, 0.25]');
  fractions(lods, 'lods');
  if (
    screenCoverage !== undefined &&
    (!Array.isArray(screenCoverage) ||
      screenCoverage.length > lods.length + 1 ||
      screenCoverage.some((v, i) => !(v > 0 && v <= 1) || (i > 0 && v >= screenCoverage[i - 1])))
  )
    throw new RangeError(
      'optimizeGLB screenCoverage must decrease from 1 to above 0, at most one more than lods; pass for example [0.5, 0.2, 0.05]',
    );
  signal?.throwIfAborted();
  const parts = splitGLB(glb),
    json = parts.json as JSONObject;
  if (json.bufferViews?.some((view: JSONObject) => view.extensions?.EXT_meshopt_compression))
    throw new TypeError('optimizeGLB cannot read meshopt buffers; optimize first, then compress');
  if (lods.length && uses(json, LOD))
    throw new TypeError('optimizeGLB cannot add levels to a file that has MSFT_lod levels; leave lods out');
  const stats: OptimizeStats = {
      verticesBefore: 0,
      verticesAfter: 0,
      trianglesBefore: 0,
      trianglesAfter: 0,
      images: 0,
      textures: 0,
      materials: 0,
      accessors: 0,
      meshes: 0,
      levels: 0,
    },
    skipped: OptimizeSkippedPrimitive[] = [];
  if (dedupe) dedupeResources(parts, stats);

  // One piece for each distinct set of accessors, whichever primitives share it.
  const pieces = new Map<string, Piece>(),
    meshes: JSONObject[] = json.meshes ?? [],
    counted = new Set<number>();
  meshes.forEach((mesh, meshIndex) =>
    (mesh.primitives as JSONObject[]).forEach((primitive, index) => {
      const where = { mesh: meshIndex, primitive: index };
      if (primitive.extensions?.KHR_draco_mesh_compression) {
        skipped.push({ ...where, reason: 'draco' });
        return;
      }
      if (!Number.isSafeInteger(primitive.attributes?.POSITION)) {
        skipped.push({ ...where, reason: 'no-position' });
        return;
      }
      if ((primitive.mode ?? 4) !== 4) {
        skipped.push({ ...where, reason: 'not-triangles' });
        return;
      }
      const key = JSON.stringify([primitive.indices, primitive.attributes, primitive.targets]),
        known = pieces.get(key);
      if (known) {
        known.primitives.push({ primitive, mesh: meshIndex, index });
        return;
      }
      const columns = new Map<string, Column>();
      for (const [name, accessor] of Object.entries<number>(primitive.attributes))
        columns.set(name, columnOf(parts, json, accessor, name === 'POSITION'));
      (primitive.targets ?? []).forEach((target: JSONObject, at: number) => {
        for (const [name, accessor] of Object.entries<number>(target))
          columns.set(`${at} ${name}`, columnOf(parts, json, accessor, name === 'POSITION'));
      });
      const count = columns.get('POSITION')!.values.length / 3,
        indices =
          primitive.indices === undefined
            ? allOf(count)
            : Uint32Array.from(readAccessor(parts, primitive.indices).values);
      if (!counted.has(primitive.attributes.POSITION)) stats.verticesBefore += count;
      counted.add(primitive.attributes.POSITION);
      stats.trianglesBefore += Math.floor(indices.length / 3);
      pieces.set(key, { primitives: [{ primitive, mesh: meshIndex, index }], columns, indices, levels: [] });
    }),
  );

  const list = [...pieces.values()];
  await inProcess(
    list,
    (piece) => {
      if (!piece.indices.length) return;
      if (!weld) {
        piece.indices = compacted(piece.columns, piece.indices);
        return;
      }
      const count = piece.columns.get('POSITION')!.values.length / 3,
        { keep, indices } = weldVertices([...piece.columns.values()], piece.indices, count);
      // Only triangles with no area: an accessor may not be empty, so the piece stays as it was.
      if (!indices.length) return;
      for (const [name, column] of piece.columns) piece.columns.set(name, gathered(column, keep));
      piece.indices = indices;
    },
    signal,
  );

  const chain = [...(simplify === undefined ? [] : [simplify]), ...lods.map((ratio) => ratio * (simplify ?? 1))];
  if (chain.length)
    for (const piece of list) {
      signal?.throwIfAborted();
      const count = piece.columns.get('POSITION')!.values.length / 3;
      if (count > SIMPLIFY_LIMIT || piece.indices.length / 3 > SIMPLIFY_LIMIT) {
        for (const { mesh, index } of piece.primitives) skipped.push({ mesh, primitive: index, reason: 'too-large' });
        continue;
      }
      if (piece.indices.length) piece.levels = await simplified(piece, chain, signal);
    }

  // The new accessors.
  json.accessors ??= [];
  json.buffers ??= [];
  json.buffers[0] ??= { byteLength: 0 };
  const writer = new Writer(json, new Map(), dedupe),
    levelFields = new Map<JSONObject, ReturnType<typeof accessorFields>[]>();
  for (const piece of list) {
    const replaced = simplify !== undefined && piece.levels.length ? piece.levels[0] : piece,
      rest = simplify !== undefined ? piece.levels.slice(1) : piece.levels,
      fields = accessorFields(writer, replaced.columns, replaced.indices),
      further = rest.map((level) => accessorFields(writer, level.columns, level.indices));
    stats.verticesAfter += replaced.columns.get('POSITION')!.values.length / 3;
    stats.trianglesAfter += replaced.indices.length / 3;
    for (const { primitive } of piece.primitives) {
      primitive.attributes = { ...fields.attributes };
      if (fields.targets.length) primitive.targets = fields.targets.map((target) => ({ ...target }));
      primitive.indices = fields.indices;
      levelFields.set(primitive, further);
    }
  }

  // Merge the meshes the merged accessors and materials made equal.
  if (dedupe && !pinned(json)) {
    const toMesh = firstOf(meshes, (mesh) =>
      JSON.stringify([mesh.primitives, mesh.weights, mesh.extras, mesh.extensions]),
    );
    stats.meshes += squeezed(meshes, toMesh);
    for (const node of json.nodes ?? []) if (node.mesh !== undefined) node.mesh = toMesh[node.mesh];
  }
  if (lods.length) writeLevels(json, levelFields, lods.length, screenCoverage, stats);
  if (dedupe) stats.accessors += writer.reused + mergedAccessors(parts);
  dropUnreadAccessors(json);
  return { glb: joinGLB(packGLB(parts, writer.fresh)), stats, skipped };
}

/** Merges animation and skin accessors holding the same data. */
function mergedAccessors(parts: GLBParts): number {
  const json = parts.json as JSONObject,
    seen = new Map<string, number>(),
    to = new Map<number, number>();
  let merged = 0;
  const visit = (holder: JSONObject, key: string): void => {
    const index = holder[key];
    if (index === undefined) return;
    let first = to.get(index);
    if (first === undefined) {
      const { values, width } = readAccessor(parts, index),
        { min, max, type, normalized } = json.accessors[index],
        name = JSON.stringify([type, normalized, min, max, values.constructor.name, width]),
        bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
        known = seen.get(`${name}:${sha256(bytes)}`);
      if (known === undefined) seen.set(`${name}:${sha256(bytes)}`, index);
      else merged++;
      to.set(index, (first = known ?? index));
    }
    holder[key] = first;
  };
  for (const skin of json.skins ?? []) visit(skin, 'inverseBindMatrices');
  for (const animation of json.animations ?? [])
    for (const sampler of animation.samplers ?? []) {
      visit(sampler, 'input');
      visit(sampler, 'output');
    }
  return merged;
}

/** Adds, for each node that draws a mesh with levels, its level nodes, and the level meshes they draw. */
function writeLevels(
  json: JSONObject,
  levelFields: Map<JSONObject, ReturnType<typeof accessorFields>[]>,
  count: number,
  screenCoverage: readonly number[] | undefined,
  stats: OptimizeStats,
): void {
  const meshes: JSONObject[] = json.meshes ?? [],
    nodes: JSONObject[] = json.nodes ?? [],
    levelMeshes = new Map<number, number[]>(),
    meshLevels = (index: number): number[] => {
      let made = levelMeshes.get(index);
      if (made) return made;
      made = [];
      const source = meshes[index];
      if (source.primitives.some((primitive: JSONObject) => levelFields.get(primitive)?.length)) {
        for (let level = 0; level < count; level++) {
          const primitives = source.primitives.map((primitive: JSONObject) => {
            // Every primitive gets objects of its own: dropping accessors renumbers once per holder.
            const copy: JSONObject = structuredClone(primitive),
              fields = levelFields.get(primitive)?.[level];
            if (!fields) return copy;
            copy.attributes = { ...fields.attributes };
            copy.indices = fields.indices;
            if (fields.targets.length) copy.targets = fields.targets.map((target) => ({ ...target }));
            return copy;
          });
          meshes.push({
            ...source,
            ...(source.name === undefined ? {} : { name: `${source.name}_LOD${level + 1}` }),
            primitives,
          });
          made.push(meshes.length - 1);
        }
      }
      levelMeshes.set(index, made);
      return made;
    };
  // Channels by the node they drive, so a file of many nodes reads them once.
  const driven = new Map<number, { list: JSONObject[]; channel: JSONObject; pointer?: string }[]>();
  for (const { channels = [] } of json.animations ?? [])
    for (const channel of channels) {
      const pointer: string | undefined = channel.target?.extensions?.KHR_animation_pointer?.pointer,
        node = pointer ? Number(/^\/nodes\/(\d+)\//.exec(pointer)?.[1]) : channel.target?.node;
      if (!Number.isSafeInteger(node)) continue;
      if (!driven.has(node)) driven.set(node, []);
      driven.get(node)!.push({ list: channels, channel, pointer });
    }
  const drawing = nodes.length;
  for (let index = 0; index < drawing; index++) {
    const node = nodes[index];
    if (node.mesh === undefined || node.extensions) continue;
    const levels = meshLevels(node.mesh);
    if (!levels.length) continue;
    const { children: _, extensions: __, extras: ___, camera: ____, ...rest } = node,
      ids = levels.map((mesh, level) => {
        nodes.push({
          ...rest,
          ...(node.name === undefined ? {} : { name: `${node.name}_LOD${level + 1}` }),
          mesh,
        });
        return nodes.length - 1;
      });
    // A level sits under the same parent and starts with the same transform, so what moves the node moves it too.
    for (const { list, channel, pointer } of driven.get(index) ?? [])
      for (const id of ids)
        list.push({
          ...channel,
          target: pointer
            ? {
                ...channel.target,
                extensions: {
                  ...channel.target.extensions,
                  KHR_animation_pointer: { pointer: pointer.replace(`/nodes/${index}/`, `/nodes/${id}/`) },
                },
              }
            : { ...channel.target, node: id },
        });
    node.extensions = { [LOD]: { ids } };
    if (screenCoverage) node.extras = { ...node.extras, MSFT_screencoverage: [...screenCoverage] };
    stats.levels += ids.length;
  }
  if (stats.levels) useExtension(json, LOD, false);
}
