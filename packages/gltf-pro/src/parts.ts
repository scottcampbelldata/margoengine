/**
 * Splits a primitive with more vertices than one GPU part may hold into parts of at most `max` vertices each, so a glTF
 * primitive of any size (a 10M-triangle scan) loads, uploads and culls part by part. Clean room from:
 * - Hoppe, Optimization of Mesh Locality for Transparent Vertex Caching, SIGGRAPH 1999, https://hhoppe.com/proj/tvc/
 * - Sander, Nehab, Barczak, Fast Triangle Reordering for Vertex Locality and Reduced Overdraw, SIGGRAPH 2007
 * - Yoon, Lindstrom, Pascucci, Manocha, Cache-Oblivious Mesh Layouts, SIGGRAPH 2005
 * - Isenburg, Lindstrom, Streaming Meshes, IEEE Visualization 2005
 * - Cignoni et al., Batched Multi Triangulation, IEEE Visualization 2005
 * - Kerbl et al., Revisiting the Vertex Cache, HPG 2018, https://doi.org/10.1145/3233302
 * - Karis, Stubbe, Wihlidal, A Deep Dive into Nanite Virtualized Geometry, SIGGRAPH 2021
 * - glTF 2.0 sections 3.6.2 and 3.7.2, https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
 * - WebGPU limits (maxStorageBufferBindingSize, maxBufferSize), https://www.w3.org/TR/webgpu/#limits
 *
 * Elements (points, line pairs or triangles) are put in Morton order of their centroids (a 30-bit key, three 10-bit
 * radix passes, O(n)) so each part is a compact piece of the surface with tight bounds, then walked greedily: a part
 * closes when the element's new vertices would pass `max`. Vertices shared inside a part stay shared; only vertices on
 * a cut are copied into both parts. Blended primitives skip the sort: their order decides how they layer.
 */
/** Default vertices per part: 2^18, 20 MiB of 80-byte vertices, under every default WebGPU storage binding (128 MiB) and the WebGL2 layer's 2048-context one (64 MiB). */
export const PART_VERTICES = 262_144;
/** Fewest and most vertices per part `maxPartVertices` accepts. */
export const MIN_PART_VERTICES = 1024,
  MAX_PART_VERTICES = 1_048_576;
/** Most vertices one primitive may have: index accessors decode through Float32, exact to 2^24. */
export const PRIMITIVE_VERTICES = 16_777_216;
/** One part of a split primitive: local indices and, for each local vertex, its vertex in the source primitive. */
export interface PartPlan {
  indices: Uint32Array;
  vertexMap: Uint32Array;
}
/** Validates a `maxPartVertices` option (default PART_VERTICES). */
export function partLimit(value: number = PART_VERTICES): number {
  if (!Number.isInteger(value) || value < MIN_PART_VERTICES || value > MAX_PART_VERTICES)
    throw new RangeError(
      `maxPartVertices must be an integer from ${MIN_PART_VERTICES} to ${MAX_PART_VERTICES} (default ${PART_VERTICES})`,
    );
  return value;
}
/** Order of the elements of `indices` (`per` indices each) by the Morton key of their centroids. */
function mortonOrder(
  indices: Uint32Array,
  per: number,
  positions: ArrayLike<number>,
  count: number,
  stride: number,
): Uint32Array {
  const n = indices.length / per;
  let x0 = Infinity,
    y0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < count * stride; i += stride) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  // One scale for all three axes (the largest extent), so the key's cells are cubes: per-axis scales would give a
  // nearly flat axis (a terrain's height) all 10 bits, and its top bit would split the surface into height bands
  // spread across the whole field instead of compact pieces.
  const sx = 1023.999 / (Math.max(x1 - x0, y1 - y0, z1 - z0) || 1),
    sy = sx,
    sz = sx,
    keys = new Uint32Array(n);
  // Spreads the 10 low bits of v to every third bit.
  const spread = (v: number) => {
    v = (v | (v << 16)) & 0x030000ff;
    v = (v | (v << 8)) & 0x0300f00f;
    v = (v | (v << 4)) & 0x030c30c3;
    return (v | (v << 2)) & 0x09249249;
  };
  for (let e = 0, o = 0; e < n; e++, o += per) {
    let x = 0,
      y = 0,
      z = 0;
    for (let k = 0; k < per; k++) {
      const v = indices[o + k] * stride;
      x += positions[v];
      y += positions[v + 1];
      z += positions[v + 2];
    }
    keys[e] =
      ((spread(((x / per - x0) * sx) | 0) << 2) |
        (spread(((y / per - y0) * sy) | 0) << 1) |
        spread(((z / per - z0) * sz) | 0)) >>>
      0;
  }
  let order = new Uint32Array(n),
    next = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const counts = new Uint32Array(1024);
  for (let shift = 0; shift < 30; shift += 10) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(keys[i] >>> shift) & 1023]++;
    for (let b = 0, sum = 0; b < 1024; b++) {
      const c = counts[b];
      counts[b] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const e = order[i];
      next[counts[(keys[e] >>> shift) & 1023]++] = e;
    }
    [order, next] = [next, order];
  }
  return order;
}
/**
 * Splits `indices` (`per` = 1 points, 2 lines, 3 triangles) over `count` vertices into parts of at most `max` vertices.
 * `positions` (x, y, z every `stride` floats) turns on the Morton order; null keeps the source order (blended primitives).
 */
export function partition(
  indices: Uint32Array,
  per: number,
  count: number,
  max: number,
  positions: ArrayLike<number> | null,
  stride = 3,
): PartPlan[] {
  const n = indices.length / per,
    order = positions ? mortonOrder(indices, per, positions, count, stride) : null,
    local = new Int32Array(count).fill(-1),
    map = new Uint32Array(max),
    out = new Uint32Array(indices.length),
    parts: PartPlan[] = [];
  let used = 0,
    start = 0,
    o = 0;
  const close = () => {
    parts.push({ indices: out.slice(start, o), vertexMap: map.slice(0, used) });
    for (let k = 0; k < used; k++) local[map[k]] = -1;
    used = 0;
    start = o;
  };
  for (let i = 0; i < n; i++) {
    const at = (order ? order[i] : i) * per;
    let fresh = 0;
    for (let k = 0; k < per; k++) {
      const v = indices[at + k];
      if (local[v] >= 0) continue;
      let repeat = false;
      for (let j = 0; j < k; j++) if (indices[at + j] === v) repeat = true;
      if (!repeat) fresh++;
    }
    if (used + fresh > max) close();
    for (let k = 0; k < per; k++) {
      const v = indices[at + k];
      if (local[v] < 0) {
        local[v] = used;
        map[used++] = v;
      }
      out[o++] = local[v];
    }
  }
  if (o > start) close();
  return parts;
}
/** Packed geometry (20 floats a vertex) as parts split it; `part` as on PBRPrimitive. */
export interface SplitGeometry {
  interpolatedDirections?: boolean;
  vertices: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
  topology?: 'point-list' | 'line-list';
  part?: { index: number; count: number; vertexMap: Uint32Array };
}
/**
 * Packed triangles (prepared geometry, autoLOD levels) with more than `max` vertices as parts of at most `max`, Morton
 * ordered unless `keepOrder` (blended materials); geometry within `max` comes back alone, unchanged.
 */
export function splitPrepared<T extends SplitGeometry>(data: T, max: number, keepOrder = false): (T | SplitGeometry)[] {
  const { vertices, indices, uvs } = data,
    count = vertices.length / 20;
  if (!(count > max) || !(vertices instanceof Float32Array) || !(indices instanceof Uint32Array) || indices.length % 3)
    return [data];
  if (count > PRIMITIVE_VERTICES)
    throw new RangeError(
      `Prepared PBR geometry has more than ${PRIMITIVE_VERTICES} vertices; split it into several primitives`,
    );
  for (let i = 0; i < indices.length; i++)
    if (indices[i] >= count) throw new RangeError('Invalid prepared PBR geometry; run prepareAsset again');
  const plans = partition(indices, 3, count, max, keepOrder ? null : vertices, 20);
  return plans.map(({ indices, vertexMap }, index) => {
    const n = vertexMap.length,
      out = new Float32Array(n * 20),
      later = uvs ? new Float32Array(n * 4) : undefined;
    for (let k = 0; k < n; k++) {
      out.set(vertices.subarray(vertexMap[k] * 20, vertexMap[k] * 20 + 20), k * 20);
      if (later) later.set(uvs!.subarray(vertexMap[k] * 4, vertexMap[k] * 4 + 4), k * 4);
    }
    return {
      ...(data.interpolatedDirections ? { interpolatedDirections: true } : {}),
      vertices: out,
      indices,
      ...(data.topology ? { topology: data.topology } : {}),
      ...(later ? { uvs: later } : {}),
      part: { index, count: plans.length, vertexMap },
    };
  });
}
