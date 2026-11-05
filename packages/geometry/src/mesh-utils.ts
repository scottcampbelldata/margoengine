// Mesh housekeeping served by `@margoengine/geometry/utils`: baking deformation into plain positions, merging groups,
// interleaving attributes, memory estimates and draw-mode conversion.
import type { GeometryData, GeometryGroup } from './data.js';

/** One morph target: differences from the base mesh, glTF style. Any attribute may be left out. */
export interface MorphTargetData {
  /** xyz difference per vertex. */
  positions?: ArrayLike<number>;
  /** xyz difference per vertex. */
  normals?: ArrayLike<number>;
  /** xyz difference per vertex (the tangent's w sign is not morphed). */
  tangents?: ArrayLike<number>;
}

/** Input of {@link bakeSkin}. */
export interface SkinData {
  /** Four joint indices per vertex. */
  joints: ArrayLike<number>;
  /** Four weights per vertex, matching `joints`. Normalized here; all zero leaves the vertex in place. */
  weights: ArrayLike<number>;
  /** One column-major 4x4 matrix per joint: joint world matrix times inverse bind matrix, 16 values each. */
  matrices: ArrayLike<number>;
}

/** One attribute of {@link interleaveAttributes}. */
export interface InterleaveInput {
  /** The values, `size` per vertex. */
  array: ArrayLike<number>;
  /** Components per vertex. */
  size: number;
}

/** Result of {@link interleaveAttributes}. */
export interface InterleavedBuffer {
  /** One buffer, `stride` values per vertex. */
  buffer: Float32Array;
  /** Floats per vertex; multiply by 4 for the bytes a vertex layout wants. */
  stride: number;
  /** Where each attribute starts inside a vertex, in floats, in input order. */
  offsets: number[];
}

/** Result of {@link estimateMemory}, in bytes. */
export interface MemoryEstimate {
  positions: number;
  normals: number;
  uvs: number;
  tangents: number;
  indices: number;
  /** All of the above: what the mesh holds on the CPU, and about what its GPU buffers take when uploaded unchanged. */
  total: number;
}

function vectorLength(label: string, array: ArrayLike<number> | undefined, expected: number): void {
  if (array && array.length !== expected)
    throw new RangeError(`${label} holds ${array.length} values; pass ${expected} to match the vertices`);
}

function unit(array: Float32Array, at: number): void {
  const size = Math.hypot(array[at], array[at + 1], array[at + 2]);
  if (!size) return;
  array[at] /= size;
  array[at + 1] /= size;
  array[at + 2] /= size;
}

/**
 * Bakes morph targets into a plain mesh: each attribute becomes the base plus the sum of `weights[i]` times target i's
 * differences, and normals and tangents are made unit length again. The input is left alone.
 *
 * @param data - The base mesh.
 * @param targets - Morph targets.
 * @param weights - One weight per target.
 * @throws RangeError when counts or lengths do not match or a weight is not finite.
 */
export function bakeMorphTargets(
  data: GeometryData,
  targets: readonly MorphTargetData[],
  weights: ArrayLike<number>,
): GeometryData {
  if (weights.length !== targets.length)
    throw new RangeError(`bakeMorphTargets got ${weights.length} weights; pass one per target (${targets.length})`);
  const positions = data.positions.slice(),
    normals = data.normals.slice(),
    tangents = data.tangents?.slice(),
    count = positions.length / 3;
  targets.forEach((target, i) => {
    const weight = weights[i];
    if (!Number.isFinite(weight))
      throw new RangeError(`bakeMorphTargets weight ${weight} is invalid; pass a finite number`);
    vectorLength('bakeMorphTargets positions', target.positions, count * 3);
    vectorLength('bakeMorphTargets normals', target.normals, count * 3);
    vectorLength('bakeMorphTargets tangents', target.tangents, count * 3);
    if (!weight) return;
    const P = target.positions,
      N = normals.length ? target.normals : undefined,
      T = tangents ? target.tangents : undefined;
    for (let v = 0; v < count; v++)
      for (let k = 0; k < 3; k++) {
        if (P) positions[v * 3 + k] += weight * P[v * 3 + k];
        if (N) normals[v * 3 + k] += weight * N[v * 3 + k];
        if (T) tangents![v * 4 + k] += weight * T[v * 3 + k];
      }
  });
  for (let v = 0; v * 3 < normals.length; v++) unit(normals, v * 3);
  if (tangents) for (let v = 0; v < count; v++) unit(tangents, v * 4);
  return withAttributes(data, positions, normals, tangents);
}

function withAttributes(
  data: GeometryData,
  positions: Float32Array,
  normals: Float32Array,
  tangents: Float32Array | undefined,
): GeometryData {
  const out: GeometryData = { positions, normals, uvs: data.uvs, indices: data.indices };
  if (tangents) out.tangents = tangents;
  if (data.groups) out.groups = data.groups.map((g) => ({ ...g }));
  return out;
}

/**
 * Bakes linear blend skinning into plain positions, for picking, physics or export of one pose. Each vertex gets the
 * weighted sum of its joints' matrices; normals use that matrix's inverse transpose and tangents the matrix, both unit
 * length again. The input is left alone.
 *
 * @param data - The mesh in bind pose.
 * @param skin - See {@link SkinData}.
 * @throws RangeError when a length does not match, a joint is out of range or a weight is negative or not finite.
 */
export function bakeSkin(data: GeometryData, skin: SkinData): GeometryData {
  const { joints, weights, matrices } = skin,
    count = data.positions.length / 3,
    jointCount = matrices.length / 16;
  vectorLength('bakeSkin joints', joints, count * 4);
  vectorLength('bakeSkin weights', weights, count * 4);
  if (!Number.isInteger(jointCount))
    throw new RangeError('bakeSkin matrices must hold 16 values per joint; pass whole 4x4 matrices');
  const positions = data.positions.slice(),
    normals = data.normals.slice(),
    tangents = data.tangents?.slice(),
    hasNormals = normals.length === positions.length,
    m = new Float64Array(12);
  for (let v = 0; v < count; v++) {
    let total = 0;
    for (let i = 0; i < 4; i++) {
      const w = weights[v * 4 + i];
      if (!(w >= 0 && w < Infinity)) throw new RangeError(`bakeSkin weight ${w} is invalid; pass finite values >= 0`);
      total += w;
    }
    if (!total) continue;
    m.fill(0);
    for (let i = 0; i < 4; i++) {
      const w = weights[v * 4 + i] / total;
      if (!w) continue;
      const joint = joints[v * 4 + i];
      if (!(Number.isInteger(joint) && joint >= 0 && joint < jointCount))
        throw new RangeError(`bakeSkin joint ${joint} is outside ${jointCount} matrices; fix the joints`);
      // Rows of the 3x4 affine part: m[r * 4 + c] is row r, column c.
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) m[r * 4 + c] += w * matrices[joint * 16 + c * 4 + r];
    }
    const at = v * 3,
      x = data.positions[at],
      y = data.positions[at + 1],
      z = data.positions[at + 2];
    for (let r = 0; r < 3; r++) positions[at + r] = m[r * 4] * x + m[r * 4 + 1] * y + m[r * 4 + 2] * z + m[r * 4 + 3];
    if (hasNormals) {
      const nx = data.normals[at],
        ny = data.normals[at + 1],
        nz = data.normals[at + 2],
        // Cofactors of the 3x3: the inverse transpose up to a scale that unit length removes, and to the determinant's
        // sign, which is put back so a mirroring pose still faces out.
        c00 = m[5] * m[10] - m[6] * m[9],
        c01 = m[6] * m[8] - m[4] * m[10],
        c02 = m[4] * m[9] - m[5] * m[8],
        c10 = m[2] * m[9] - m[1] * m[10],
        c11 = m[0] * m[10] - m[2] * m[8],
        c12 = m[1] * m[8] - m[0] * m[9],
        c20 = m[1] * m[6] - m[2] * m[5],
        c21 = m[2] * m[4] - m[0] * m[6],
        c22 = m[0] * m[5] - m[1] * m[4],
        sign = m[0] * c00 + m[1] * c01 + m[2] * c02 < 0 ? -1 : 1;
      normals[at] = sign * (c00 * nx + c01 * ny + c02 * nz);
      normals[at + 1] = sign * (c10 * nx + c11 * ny + c12 * nz);
      normals[at + 2] = sign * (c20 * nx + c21 * ny + c22 * nz);
      unit(normals, at);
    }
    if (tangents) {
      const T = data.tangents!,
        q = v * 4;
      for (let r = 0; r < 3; r++) tangents[q + r] = m[r * 4] * T[q] + m[r * 4 + 1] * T[q + 1] + m[r * 4 + 2] * T[q + 2];
      unit(tangents, q);
    }
  }
  return withAttributes(data, positions, normals, tangents);
}

/**
 * Merges groups that share a material into one draw each, moving their triangles next to each other: materials keep the
 * order they first appear in and triangles keep their order inside a material. Indices outside every group stay at the
 * end, in no group. Without groups the mesh comes back as it is. The input is left alone.
 *
 * @throws RangeError when groups overlap, run past the indices or do not hold whole triangles.
 */
export function mergeGroups(data: GeometryData): GeometryData {
  const groups = data.groups;
  if (!groups?.length) return { ...data };
  const length = data.indices.length,
    sorted = [...groups].sort((a, b) => a.start - b.start);
  let end = 0;
  for (const g of sorted) {
    if (g.start % 3 || g.count % 3 || g.start < 0 || g.count < 0 || g.start + g.count > length)
      throw new RangeError(
        `mergeGroups group ${g.start}+${g.count} is invalid; cover whole triangles inside the indices`,
      );
    if (g.start < end) throw new RangeError('mergeGroups groups overlap; pass groups that do not share triangles');
    end = g.start + g.count;
  }
  const materials = new Map<number, GeometryGroup[]>();
  for (const g of sorted) {
    const list = materials.get(g.materialIndex);
    if (list) list.push(g);
    else materials.set(g.materialIndex, [g]);
  }
  const indices = new Uint32Array(length),
    merged: GeometryGroup[] = [];
  let at = 0;
  for (const [materialIndex, list] of materials) {
    const start = at;
    for (const g of list) {
      indices.set(data.indices.subarray(g.start, g.start + g.count), at);
      at += g.count;
    }
    merged.push({ start, count: at - start, materialIndex });
  }
  // What no group covers goes after them, in order.
  let from = 0;
  for (const g of sorted) {
    indices.set(data.indices.subarray(from, g.start), at);
    at += g.start - from;
    from = g.start + g.count;
  }
  indices.set(data.indices.subarray(from), at);
  return { ...data, indices, groups: merged };
}

/**
 * Packs attributes into one buffer, vertex after vertex, which is what a single vertex buffer binding wants.
 *
 * @param attributes - The attributes, in the order they sit inside a vertex.
 * @throws RangeError when there are none, a size is invalid or the vertex counts differ.
 */
export function interleaveAttributes(attributes: readonly InterleaveInput[]): InterleavedBuffer {
  if (!attributes.length) throw new RangeError('interleaveAttributes needs an attribute; pass at least one');
  let stride = 0;
  const offsets: number[] = [];
  for (const { size } of attributes) {
    if (!Number.isInteger(size) || size < 1)
      throw new RangeError(`interleaveAttributes size ${size} is invalid; pass an integer >= 1`);
    offsets.push(stride);
    stride += size;
  }
  const count = attributes[0].array.length / attributes[0].size;
  for (const { array, size } of attributes)
    if (array.length !== count * size || !Number.isInteger(count))
      throw new RangeError('interleaveAttributes vertex counts differ; pass whole vertices of the same count');
  const buffer = new Float32Array(count * stride);
  attributes.forEach(({ array, size }, n) => {
    for (let v = 0; v < count; v++)
      for (let k = 0; k < size; k++) buffer[v * stride + offsets[n] + k] = array[v * size + k];
  });
  return { buffer, stride, offsets };
}

/**
 * Splits an interleaved buffer back into one array per attribute.
 *
 * @param buffer - The interleaved values.
 * @param sizes - Components of each attribute, in the order they sit inside a vertex.
 * @throws RangeError when a size is invalid or the buffer does not hold whole vertices.
 */
export function deinterleaveAttributes(buffer: ArrayLike<number>, sizes: readonly number[]): Float32Array[] {
  let stride = 0;
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 1)
      throw new RangeError(`deinterleaveAttributes size ${size} is invalid; pass an integer >= 1`);
    stride += size;
  }
  if (!stride || buffer.length % stride)
    throw new RangeError(
      `deinterleaveAttributes buffer of ${buffer.length} is not whole vertices of ${stride}; fix sizes`,
    );
  const count = buffer.length / stride;
  let offset = 0;
  return sizes.map((size) => {
    const out = new Float32Array(count * size);
    for (let v = 0; v < count; v++) for (let k = 0; k < size; k++) out[v * size + k] = buffer[v * stride + offset + k];
    offset += size;
    return out;
  });
}

/**
 * Bytes a mesh's arrays hold, per attribute and in total. A plain sum of `byteLength`: arrays shared between meshes
 * count once per mesh.
 */
export function estimateMemory(data: GeometryData): MemoryEstimate {
  const positions = data.positions.byteLength,
    normals = data.normals.byteLength,
    uvs = data.uvs.byteLength,
    tangents = data.tangents?.byteLength ?? 0,
    indices = data.indices.byteLength;
  return { positions, normals, uvs, tangents, indices, total: positions + normals + uvs + tangents + indices };
}

/** The list a draw mode reads: the given indices, or `0..count - 1` for a non-indexed draw. */
function modeIndices(source: ArrayLike<number> | number, label: string): ArrayLike<number> {
  if (typeof source !== 'number') return source;
  if (!Number.isInteger(source) || source < 0)
    throw new RangeError(`${label} count ${source} is invalid; pass an integer >= 0 or an index list`);
  return Uint32Array.from({ length: source }, (_, i) => i);
}

/** Primitive restart: this index ends one strip or fan and starts the next. */
const isRestart = (index: number): boolean => index === 0xffffffff;

/**
 * Converts a triangle strip to a triangle list. Winding alternates in a strip, so every other triangle swaps two
 * corners to keep facing the same way. Degenerate triangles, the usual way of stitching strips, are dropped without
 * losing the winding count, and `0xffffffff` restarts the strip.
 *
 * @param source - Strip indices, or a vertex count for a non-indexed strip.
 * @throws RangeError when a count is invalid.
 */
export function triangleStripToTriangles(source: ArrayLike<number> | number): Uint32Array {
  const indices = modeIndices(source, 'triangleStripToTriangles'),
    out: number[] = [];
  let begin = 0;
  for (let i = 0; i <= indices.length; i++) {
    if (i < indices.length && !isRestart(indices[i])) continue;
    for (let t = begin; t + 2 < i; t++) {
      const odd = (t - begin) & 1,
        a = indices[t],
        b = indices[t + 1 + odd],
        c = indices[t + 2 - odd];
      if (a !== b && b !== c && a !== c) out.push(a, b, c);
    }
    begin = i + 1;
  }
  return Uint32Array.from(out);
}

/**
 * Converts a triangle fan to a triangle list: every triangle shares the fan's first vertex. Degenerate triangles are
 * dropped, and `0xffffffff` starts a new fan.
 *
 * @param source - Fan indices, or a vertex count for a non-indexed fan.
 * @throws RangeError when a count is invalid.
 */
export function triangleFanToTriangles(source: ArrayLike<number> | number): Uint32Array {
  const indices = modeIndices(source, 'triangleFanToTriangles'),
    out: number[] = [];
  let begin = 0;
  for (let i = 0; i <= indices.length; i++) {
    if (i < indices.length && !isRestart(indices[i])) continue;
    for (let t = begin + 1; t + 1 < i; t++) {
      const a = indices[begin],
        b = indices[t],
        c = indices[t + 1];
      if (a !== b && b !== c && a !== c) out.push(a, b, c);
    }
    begin = i + 1;
  }
  return Uint32Array.from(out);
}
