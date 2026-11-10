/** Sparse morph/accessor writing and aligned vertex interleaving, without modifying logical accessor values. */
import { exportGLB, type GLBOptions } from './gltf.js';
import type { ExportSource } from './scene.js';
import { joinGLB, readAccessor, splitGLB, type GLBParts } from './glb.js';
import { addView, packGLB, type JSONObject, type NewViews } from './glb-pack.js';
import { SIZES } from './glb-columns.js';

/** Independent binary-layout controls. */
export interface AccessorLayoutOptions {
  /** Sparse storage for all accessors, only morph targets, or none. Default 'all'. */
  sparse?: 'all' | 'morphs' | false;
  /** Interleave dense attributes used by the same primitive into streams of at most 252 bytes. Default true. */
  interleave?: boolean;
  /** Maximum final GLB bytes. Default the GLB format limit, 4,294,967,295. */
  maxBytes?: number;
  /** Stops between accessors and vertex streams. */
  signal?: AbortSignal;
}

/** GLB writer options plus accessor-layout controls. */
export interface SparseExportOptions extends GLBOptions, AccessorLayoutOptions {}

/** Deterministic counts for a layout conversion. */
export interface AccessorLayoutStats {
  /** Accessors converted to sparse replacement tables. */
  sparse: number;
  /** Accessors represented entirely by implicit zero values. */
  zero: number;
  /** Dense vertex accessors placed in interleaved streams. */
  interleaved: number;
  /** New interleaved buffer views. */
  streams: number;
  /** Complete GLB size before conversion. */
  bytesBefore: number;
  /** Complete GLB size after conversion. */
  bytesAfter: number;
}

const align = (n: number): number => Math.ceil(n / 4) * 4;
const SET: Record<number, (v: DataView, at: number, n: number) => void> = {
  5120: (v, a, n) => v.setInt8(a, n),
  5121: (v, a, n) => v.setUint8(a, n),
  5122: (v, a, n) => v.setInt16(a, n, true),
  5123: (v, a, n) => v.setUint16(a, n, true),
  5125: (v, a, n) => v.setUint32(a, n, true),
  5126: (v, a, n) => v.setFloat32(a, n, true),
};

function shape(accessor: JSONObject): { columns: number; rows: number; column: number; bytes: number } {
  const dimension = /^MAT([234])$/.exec(accessor.type),
    columns = dimension ? Number(dimension[1]) : 1,
    rows = dimension ? columns : accessor.type === 'SCALAR' ? 1 : Number(accessor.type.slice(3)),
    column = columns > 1 ? align(rows * SIZES[accessor.componentType]) : rows * SIZES[accessor.componentType];
  return { columns, rows, column, bytes: columns * column };
}

function element(view: DataView, at: number, accessor: JSONObject, values: ArrayLike<number>, row: number): void {
  const { columns, rows, column } = shape(accessor),
    size = SIZES[accessor.componentType],
    put = SET[accessor.componentType];
  for (let c = 0; c < columns; c++)
    for (let r = 0; r < rows; r++) put(view, at + c * column + r * size, values[row * columns * rows + c * rows + r]);
}

function sparsify(
  parts: GLBParts,
  fresh: NewViews,
  eligible: Set<number>,
  stats: AccessorLayoutStats,
  options: AccessorLayoutOptions,
): void {
  const json = parts.json as JSONObject;
  for (const index of eligible) {
    options.signal?.throwIfAborted();
    const accessor = json.accessors[index];
    if (
      !SET[accessor.componentType] ||
      accessor.sparse ||
      accessor.bufferView === undefined ||
      json.bufferViews[accessor.bufferView].extensions?.EXT_meshopt_compression
    )
      continue;
    const { values, width } = readAccessor(parts, index),
      rows: number[] = [],
      { bytes } = shape(accessor);
    for (let i = 0; i < accessor.count; i++) {
      let nonzero = false;
      for (let k = 0; k < width; k++) nonzero ||= values[i * width + k] !== 0 || Object.is(values[i * width + k], -0);
      if (nonzero) rows.push(i);
    }
    if (rows.length === accessor.count) continue;
    const last = rows[rows.length - 1] ?? 0,
      type = last <= 255 ? 5121 : last <= 65535 ? 5123 : 5125,
      size = SIZES[type],
      cost = align(rows.length * size) + align(rows.length * bytes) + 200;
    if (rows.length && cost >= accessor.count * bytes) continue;
    delete accessor.bufferView;
    delete accessor.byteOffset;
    if (!rows.length) {
      stats.zero++;
      continue;
    }
    const indices = new Uint8Array(rows.length * size),
      replacements = new Uint8Array(rows.length * bytes),
      iv = new DataView(indices.buffer),
      vv = new DataView(replacements.buffer);
    for (const [i, row] of rows.entries()) {
      SET[type](iv, i * size, row);
      element(vv, i * bytes, accessor, values, row);
    }
    accessor.sparse = {
      count: rows.length,
      indices: { bufferView: addView(json, fresh, indices), componentType: type },
      values: { bufferView: addView(json, fresh, replacements) },
    };
    stats.sparse++;
  }
}

function interleave(
  parts: GLBParts,
  fresh: NewViews,
  protectedAccessors: Set<number>,
  stats: AccessorLayoutStats,
  options: AccessorLayoutOptions,
): void {
  const json = parts.json as JSONObject,
    placed = new Set<number>();
  for (const mesh of json.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.extensions?.KHR_draco_mesh_compression) continue;
      const groups = new Map<number, number[]>();
      for (const index of new Set<number>(Object.values(primitive.attributes ?? {}))) {
        const a = json.accessors[index];
        if (
          placed.has(index) ||
          protectedAccessors.has(index) ||
          a.sparse ||
          a.bufferView === undefined ||
          !SET[a.componentType] ||
          a.type.startsWith('MAT') ||
          json.bufferViews[a.bufferView].extensions?.EXT_meshopt_compression
        )
          continue;
        if (!groups.has(a.count)) groups.set(a.count, []);
        groups.get(a.count)!.push(index);
      }
      const write = (indices: number[], stride: number): void => {
        options.signal?.throwIfAborted();
        if (indices.length < 2) return;
        const count = json.accessors[indices[0]].count,
          bytes = new Uint8Array(count * stride),
          view = new DataView(bytes.buffer),
          offsets = new Map<number, number>();
        let offset = 0;
        for (const index of indices) {
          const a = json.accessors[index],
            { values } = readAccessor(parts, index);
          offsets.set(index, offset);
          for (let row = 0; row < count; row++) element(view, row * stride + offset, a, values, row);
          offset += align(shape(a).bytes);
        }
        const bufferView = addView(json, fresh, bytes, { target: 34962, byteStride: stride });
        for (const index of indices) {
          const a = json.accessors[index];
          a.bufferView = bufferView;
          a.byteOffset = offsets.get(index);
          placed.add(index);
        }
        stats.interleaved += indices.length;
        stats.streams++;
      };
      for (const group of groups.values()) {
        let batch: number[] = [],
          stride = 0;
        for (const index of group) {
          const size = align(shape(json.accessors[index]).bytes);
          if (stride + size > 252) {
            write(batch, stride);
            batch = [];
            stride = 0;
          }
          batch.push(index);
          stride += size;
        }
        write(batch, stride);
      }
    }
}

/**
 * Repack an existing GLB into sparse accessors and/or interleaved vertex streams, retaining every accessor index,
 * component type, normalized flag, bound and logical value. Compression-owned streams are retained unchanged.
 * @throws {RangeError} For invalid size limits or an exceeded final limit; use a supported maxBytes or fewer data.
 * @throws {TypeError} For invalid options or GLB accessor data; repair the input or use the documented options.
 */
export function layoutGLB(
  bytes: Uint8Array,
  options: AccessorLayoutOptions = {},
): { glb: Uint8Array; stats: AccessorLayoutStats } {
  options.signal?.throwIfAborted();
  const sparse = options.sparse ?? 'all',
    max = options.maxBytes ?? 0xffffffff;
  if (
    ![false, 'all', 'morphs'].includes(sparse) ||
    (options.interleave !== undefined && typeof options.interleave !== 'boolean')
  )
    throw new TypeError(
      'MARGO_EXPORT_LAYOUT_OPTIONS: use sparse all/morphs/false and a boolean interleave flag. See docs/limits.md',
    );
  if (!Number.isSafeInteger(max) || max < 0 || max > 0xffffffff)
    throw new RangeError(
      'MARGO_EXPORT_LAYOUT_LIMIT: set maxBytes to an integer from 0 to 4294967295. See docs/limits.md',
    );
  const parts = splitGLB(bytes),
    json = parts.json as JSONObject,
    fresh: NewViews = new Map(),
    protectedAccessors = new Set<number>(),
    targets = new Set<number>(),
    stats: AccessorLayoutStats = {
      sparse: 0,
      zero: 0,
      interleaved: 0,
      streams: 0,
      bytesBefore: bytes.length,
      bytesAfter: 0,
    };
  for (const mesh of json.meshes ?? [])
    for (const p of mesh.primitives ?? []) {
      if (p.extensions?.KHR_draco_mesh_compression) {
        for (const a of Object.values<number>(p.attributes ?? {})) protectedAccessors.add(a);
        if (p.indices !== undefined) protectedAccessors.add(p.indices);
      }
      for (const target of p.targets ?? []) for (const a of Object.values<number>(target)) targets.add(a);
    }
  const sparseEligible = new Set<number>(
    (json.accessors ?? [])
      .map((_: unknown, i: number) => i)
      .filter((i: number) => !protectedAccessors.has(i) && (sparse === 'all' || targets.has(i))),
  );
  if (sparse !== false) sparsify(parts, fresh, sparseEligible, stats, options);
  // Re-read from packed data so new sparse replacements have their real buffer offsets.
  const packed = packGLB(parts, fresh),
    interleaved: NewViews = new Map();
  if (options.interleave !== false) interleave(packed, interleaved, protectedAccessors, stats, options);
  const output = packGLB(packed, interleaved);
  if (!output.bin && json.buffers?.length === 1 && json.buffers[0].uri === undefined) delete json.buffers;
  const glb = joinGLB(output);
  if (glb.length > max)
    throw new RangeError(
      'MARGO_EXPORT_LAYOUT_SIZE: final GLB exceeds maxBytes; raise maxBytes or export fewer data. See docs/limits.md',
    );
  stats.bytesAfter = glb.length;
  return { glb, stats };
}

/** Write an engine or data scene directly to a GLB with the requested sparse/interleaved accessor layout. */
export function exportSparseGLB(source: ExportSource, options: SparseExportOptions = {}): Uint8Array {
  options.signal?.throwIfAborted();
  return layoutGLB(exportGLB(source, { ...options, maxBytes: undefined }), options).glb;
}
