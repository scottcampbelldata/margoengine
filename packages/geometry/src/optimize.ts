// Mesh optimisation for the GPU: the same triangles and vertices in an order the hardware reads faster. Written from
// two public papers: T. Forsyth, "Linear-Speed Vertex Cache Optimisation" (2006) for the triangle order, and P. Sander,
// D. Nehab and J. Barczak, "Fast Triangle Reordering for Vertex Locality and Reduced Overdraw" (SIGGRAPH 2007) for the
// clusters sorted by how far they face out of the mesh.
import type { GeometryData } from './data.js';

/** Size of the cache the triangle order is tuned for: the score table of Forsyth's paper. */
const scoreCache = 32;
/** Cache a vertex is assumed to survive in when `cacheSize` is not given, in vertices. */
const defaultCache = 16;
/** A cluster shorter than this is never cut at a soft boundary, so the sort cannot shred the triangle order. */
const shortestCluster = 16;

/** Result of {@link analyzeVertexCache}. */
export interface VertexCacheStats {
  /** Vertex shader runs: cache misses over the whole index list. */
  misses: number;
  /** Average cache miss ratio: misses per triangle. 3 is the worst; about 0.5 to 0.7 is good on a closed mesh. */
  acmr: number;
  /** Average transform to vertex ratio: misses per vertex used. 1 is the best possible. */
  atvr: number;
}

/** Options of {@link optimizeOverdraw}. */
export interface OptimizeOverdrawOptions {
  /** How much worse than the input the cache miss ratio may get, as a factor of at least 1. Default 1.05. */
  threshold?: number;
  /** Simulated vertex cache size, in vertices. Default 16. */
  cacheSize?: number;
}

/** Options of {@link optimizeMesh}. */
export interface OptimizeMeshOptions extends OptimizeOverdrawOptions {
  /** Also sort for less overdraw. Keep it off for transparent meshes, whose triangle order may matter. Default true. */
  overdraw?: boolean;
}

/** Reads `indices` and checks them: whole triangles, and all below `vertexCount` when it is given. */
function readIndices(indices: ArrayLike<number>, vertexCount: number | undefined, label: string): number {
  if (indices.length % 3) throw new RangeError(`${label} needs whole triangles; pass 3 indices per face`);
  if (vertexCount !== undefined && !(Number.isInteger(vertexCount) && vertexCount >= 0))
    throw new RangeError(`${label} vertex count ${vertexCount} is invalid; pass an integer >= 0`);
  let top = -1;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`${label} index ${v} is invalid; pass integers >= 0`);
    if (v > top) top = v;
  }
  if (vertexCount !== undefined && top >= vertexCount)
    throw new RangeError(`${label} index ${top} is past ${vertexCount} vertices; fix the indices`);
  return vertexCount ?? top + 1;
}

function checkCache(cacheSize: number, label: string): void {
  if (!Number.isInteger(cacheSize) || cacheSize < 3)
    throw new RangeError(`${label} cache size ${cacheSize} is invalid; pass an integer >= 3`);
}

/**
 * Counts cache misses of an index list on a first-in first-out vertex cache, the model of the paper and close to how
 * GPUs reuse vertices.
 *
 * @param indices - Triangle indices.
 * @param vertexCount - Vertices the indices address. Default the highest index plus 1.
 * @param cacheSize - Cache size in vertices. Default 16.
 * @throws RangeError when an index or `cacheSize` is invalid.
 */
export function analyzeVertexCache(
  indices: ArrayLike<number>,
  vertexCount?: number,
  cacheSize = defaultCache,
): VertexCacheStats {
  const count = readIndices(indices, vertexCount, 'analyzeVertexCache');
  checkCache(cacheSize, 'analyzeVertexCache');
  const stamp = new Float64Array(count).fill(-Infinity),
    used = new Uint8Array(count);
  let time = 0,
    misses = 0,
    distinct = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!used[v]) {
      used[v] = 1;
      distinct++;
    }
    if (time - stamp[v] <= cacheSize) continue;
    stamp[v] = ++time;
    misses++;
  }
  return { misses, acmr: indices.length ? misses / (indices.length / 3) : 0, atvr: distinct ? misses / distinct : 0 };
}

/** Score of a vertex by its place in the cache, with the three newest sharing one fixed score. */
const placeScore = /* @__PURE__ */ Float64Array.from({ length: scoreCache }, (_, i) =>
  i < 3 ? 0.75 : Math.pow(1 - (i - 3) / (scoreCache - 3), 1.5),
);

/** A vertex with few triangles left scores higher, so stragglers get finished instead of costing a miss later. */
function vertexScore(place: number, remaining: number): number {
  if (remaining === 0) return -1;
  return (place < 0 ? 0 : placeScore[place]) + 2 / Math.sqrt(remaining);
}

/**
 * Reorders triangles so vertices are reused while they are still in the GPU's post-transform cache. Every triangle
 * keeps its corners and winding; only the order of triangles changes. Linear time in the triangles.
 *
 * @param indices - Triangle indices.
 * @param vertexCount - Vertices the indices address. Default the highest index plus 1.
 * @returns A new index list.
 * @throws RangeError when an index is invalid.
 */
export function optimizeVertexCache(indices: ArrayLike<number>, vertexCount?: number): Uint32Array {
  const count = readIndices(indices, vertexCount, 'optimizeVertexCache'),
    triangles = indices.length / 3,
    out = new Uint32Array(indices.length),
    // Triangles of each vertex, compacted as they are emitted.
    start = new Uint32Array(count + 1),
    remaining = new Uint32Array(count);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < count; v++) start[v + 1] += start[v];
  const list = new Uint32Array(indices.length),
    fill = start.slice(0, count);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    list[fill[v]++] = (i / 3) | 0;
    remaining[v]++;
  }
  const score = new Float64Array(count),
    triangleScore = new Float64Array(triangles),
    emitted = new Uint8Array(triangles);
  for (let v = 0; v < count; v++) score[v] = vertexScore(-1, remaining[v]);
  for (let t = 0; t < triangles; t++)
    triangleScore[t] = score[indices[t * 3]] + score[indices[t * 3 + 1]] + score[indices[t * 3 + 2]];

  let cache = new Int32Array(scoreCache + 3),
    next = new Int32Array(scoreCache + 3),
    size = 0,
    scan = 0,
    best = -1;
  for (let done = 0; done < triangles; done++) {
    if (best < 0) {
      // Nothing in the cache has work left: restart at the next triangle not yet written.
      while (emitted[scan]) scan++;
      best = scan;
    }
    const a = indices[best * 3],
      b = indices[best * 3 + 1],
      c = indices[best * 3 + 2];
    out[done * 3] = a;
    out[done * 3 + 1] = b;
    out[done * 3 + 2] = c;
    emitted[best] = 1;
    // Take the triangle off its vertices' lists, once per corner.
    for (let k = 0; k < 3; k++) {
      const v = indices[best * 3 + k],
        first = start[v],
        last = first + remaining[v] - 1;
      for (let i = first; i <= last; i++)
        if (list[i] === best) {
          list[i] = list[last];
          break;
        }
      remaining[v]--;
    }
    // Move the three corners to the front of the cache, without repeats, and let the rest slide back.
    let length = 0;
    next[length++] = a;
    if (b !== a) next[length++] = b;
    if (c !== a && c !== b) next[length++] = c;
    for (let i = 0; i < size; i++) {
      const v = cache[i];
      if (v !== a && v !== b && v !== c) next[length++] = v;
      if (length === next.length) break;
    }
    const swap = cache;
    cache = next;
    next = swap;
    size = length;
    for (let i = 0; i < size; i++) {
      const v = cache[i],
        slot = i < scoreCache ? i : -1,
        updated = vertexScore(slot, remaining[v]),
        change = updated - score[v];
      score[v] = updated;
      for (let n = start[v], end = n + remaining[v]; n < end; n++) triangleScore[list[n]] += change;
    }
    if (size > scoreCache) size = scoreCache;
    // Only once every score is final: a triangle with two cached corners changes twice above.
    let topScore = -Infinity;
    best = -1;
    for (let i = 0; i < size; i++) {
      const v = cache[i];
      for (let n = start[v], end = n + remaining[v]; n < end; n++)
        if (triangleScore[list[n]] > topScore) {
          topScore = triangleScore[list[n]];
          best = list[n];
        }
    }
  }
  return out;
}

/**
 * Reorders triangles so that surfaces likely to hide others draw first and the GPU's depth test can skip more pixels.
 * Run it after {@link optimizeVertexCache}: it cuts the order into clusters where the cache restarts anyway, then sorts
 * clusters by how far they face out from the mesh centre, keeping the order inside each. The cache miss ratio stays
 * within about `threshold` of the input's.
 *
 * @param indices - Triangle indices, already optimised for the vertex cache.
 * @param positions - xyz per vertex.
 * @param options - See {@link OptimizeOverdrawOptions}.
 * @returns A new index list.
 * @throws RangeError when an index, `threshold` or `cacheSize` is invalid.
 */
export function optimizeOverdraw(
  indices: ArrayLike<number>,
  positions: ArrayLike<number>,
  options: OptimizeOverdrawOptions = {},
): Uint32Array {
  const { threshold = 1.05, cacheSize = defaultCache } = options;
  if (positions.length % 3) throw new RangeError('optimizeOverdraw positions must be xyz per vertex; fix the array');
  const count = readIndices(indices, positions.length / 3, 'optimizeOverdraw');
  checkCache(cacheSize, 'optimizeOverdraw');
  if (!(threshold >= 1 && threshold < Infinity))
    throw new RangeError(`optimizeOverdraw threshold ${threshold} is invalid; pass a finite number >= 1`);
  const triangles = indices.length / 3,
    limit = analyzeVertexCache(indices, count, cacheSize).acmr * threshold,
    stamp = new Float64Array(count).fill(-Infinity),
    clusterStart: number[] = [];
  // Cut where all three corners miss (the cache restarted anyway), or where the cluster so far is under the allowed
  // ratio. Each cluster is counted from a cold cache, because after the sort it can follow any other cluster: the
  // restart is already paid for in its own ratio, so the sorted list stays near the limit.
  let time = 0,
    misses = 0,
    begin = 0;
  for (let t = 0; t < triangles; t++) {
    if (t - begin >= shortestCluster && misses / (t - begin) <= limit) {
      clusterStart.push(t);
      begin = t;
      misses = 0;
      time += cacheSize + 1;
    }
    let missed = 0;
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      if (time - stamp[v] <= cacheSize) continue;
      stamp[v] = ++time;
      missed++;
    }
    if (t === 0 || (t > begin && missed === 3)) {
      clusterStart.push(t);
      begin = t;
      misses = 0;
    }
    misses += missed;
  }
  // Area-weighted centre and normal of each cluster, and of the mesh.
  const clusters = clusterStart.length,
    centre = new Float64Array(clusters * 3),
    normal = new Float64Array(clusters * 3),
    area = new Float64Array(clusters),
    mesh = [0, 0, 0];
  let total = 0;
  for (let c = 0; c < clusters; c++) {
    const end = c + 1 < clusters ? clusterStart[c + 1] : triangles;
    for (let t = clusterStart[c]; t < end; t++) {
      const a = indices[t * 3] * 3,
        b = indices[t * 3 + 1] * 3,
        d = indices[t * 3 + 2] * 3,
        ux = positions[b] - positions[a],
        uy = positions[b + 1] - positions[a + 1],
        uz = positions[b + 2] - positions[a + 2],
        vx = positions[d] - positions[a],
        vy = positions[d + 1] - positions[a + 1],
        vz = positions[d + 2] - positions[a + 2],
        nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx,
        size = Math.hypot(nx, ny, nz);
      normal[c * 3] += nx;
      normal[c * 3 + 1] += ny;
      normal[c * 3 + 2] += nz;
      area[c] += size;
      for (let k = 0; k < 3; k++) {
        const middle = (positions[a + k] + positions[b + k] + positions[d + k]) / 3;
        centre[c * 3 + k] += middle * size;
        mesh[k] += middle * size;
      }
      total += size;
    }
  }
  const key = new Float64Array(clusters),
    order = Array.from({ length: clusters }, (_, c) => c);
  for (let c = 0; c < clusters; c++) {
    const length = Math.hypot(normal[c * 3], normal[c * 3 + 1], normal[c * 3 + 2]);
    if (!(length > 0 && area[c] > 0 && total > 0)) continue;
    let along = 0;
    for (let k = 0; k < 3; k++) along += (centre[c * 3 + k] / area[c] - mesh[k] / total) * normal[c * 3 + k];
    key[c] = along / length;
  }
  order.sort((a, b) => key[b] - key[a] || a - b);
  const out = new Uint32Array(indices.length);
  let at = 0;
  for (const c of order) {
    const end = (c + 1 < clusters ? clusterStart[c + 1] : triangles) * 3;
    for (let i = clusterStart[c] * 3; i < end; i++) out[at++] = indices[i];
  }
  return out;
}

/**
 * The vertex order that reads the vertex buffer front to back: entry `v` is the new index of old vertex `v`, in order
 * of first use, and `0xffffffff` for a vertex no triangle uses. For attributes outside `GeometryData`, such as skin
 * weights, apply this table yourself.
 *
 * @param indices - Triangle indices.
 * @param vertexCount - Vertices in the buffers. Default the highest index plus 1.
 * @throws RangeError when an index is invalid.
 */
export function vertexFetchRemap(indices: ArrayLike<number>, vertexCount?: number): Uint32Array {
  const count = readIndices(indices, vertexCount, 'vertexFetchRemap'),
    remap = new Uint32Array(count).fill(0xffffffff);
  let next = 0;
  for (let i = 0; i < indices.length; i++) if (remap[indices[i]] === 0xffffffff) remap[indices[i]] = next++;
  return remap;
}

/**
 * Rewrites the vertex buffers in order of first use, so the GPU reads them nearly in sequence, and drops vertices no
 * triangle uses. Positions, normals, UVs and tangents move together; triangles and groups stay as they are. Run it last.
 *
 * @param data - The mesh.
 * @returns A new mesh; the input is left alone.
 * @throws RangeError when an index is invalid.
 */
export function optimizeVertexFetch(data: GeometryData): GeometryData {
  const count = data.positions.length / 3,
    remap = vertexFetchRemap(data.indices, count);
  let used = 0;
  for (let v = 0; v < count; v++) if (remap[v] !== 0xffffffff) used++;
  const move = (source: Float32Array, size: number): Float32Array => {
      if (source.length !== count * size) return source.slice();
      const target = new Float32Array(used * size);
      for (let v = 0; v < count; v++) {
        if (remap[v] === 0xffffffff) continue;
        for (let k = 0; k < size; k++) target[remap[v] * size + k] = source[v * size + k];
      }
      return target;
    },
    indices = new Uint32Array(data.indices.length);
  for (let i = 0; i < indices.length; i++) indices[i] = remap[data.indices[i]];
  const out: GeometryData = {
    positions: move(data.positions, 3),
    normals: move(data.normals, 3),
    uvs: move(data.uvs, 2),
    indices,
  };
  if (data.tangents) out.tangents = move(data.tangents, 4);
  if (data.groups) out.groups = data.groups.map((g) => ({ ...g }));
  return out;
}

/**
 * The whole import step: {@link optimizeVertexCache}, {@link optimizeOverdraw} and {@link optimizeVertexFetch}, with
 * each stretch between group boundaries handled alone so groups keep exactly their triangles and materials. An opaque
 * mesh draws the same picture. A mesh with one vertex per corner has nothing to reuse: run `mergeVertices` first.
 *
 * @param data - The mesh.
 * @param options - See {@link OptimizeMeshOptions}.
 * @returns A new mesh; the input is left alone.
 * @throws RangeError when an index or option is invalid, or a group does not start and end on a whole triangle.
 */
export function optimizeMesh(data: GeometryData, options: OptimizeMeshOptions = {}): GeometryData {
  const { overdraw = true, ...sorting } = options,
    length = data.indices.length,
    count = data.positions.length / 3,
    stops = new Set([0, length]);
  for (const { start, count: size } of data.groups ?? []) {
    const end = start + size;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= length) || start % 3 || end % 3)
      throw new RangeError(`optimizeMesh group ${start}+${size} is invalid; groups must cover whole triangles`);
    stops.add(start).add(end);
  }
  const edges = [...stops].sort((a, b) => a - b),
    indices = new Uint32Array(length);
  for (let i = 0; i + 1 < edges.length; i++) {
    let part: Uint32Array = optimizeVertexCache(data.indices.subarray(edges[i], edges[i + 1]), count);
    if (overdraw) part = optimizeOverdraw(part, data.positions, sorting);
    indices.set(part, edges[i]);
  }
  return optimizeVertexFetch({ ...data, indices });
}
