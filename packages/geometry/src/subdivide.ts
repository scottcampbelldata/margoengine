import {geometryData, type GeometryData} from './data.js';
import {computeVertexNormals} from './utils.js';
import {finiteNumber} from './math.js';

/**
 * Loop subdivision. Each pass splits every triangle into four and smooths positions with Loop's weights (edge
 * points 3/8, 3/8, 1/8, 1/8; vertices with Loop's original beta). Boundary and non-manifold edges use the cubic
 * B-spline boundary rules, so open meshes keep their outline. Topology is found by welding positions within
 * `tolerance`, so UV seams and hard-normal splits do not tear the surface; UVs are interpolated linearly per corner
 * and seams are kept. Normals are recomputed (angle weighted); tangents and groups are dropped.
 */
export function loopSubdivide(data: GeometryData, iterations = 1, tolerance = 1e-6): GeometryData {
  finiteNumber(iterations);
  let current = data;
  for (let i = 0; i < Math.max(0, Math.floor(iterations)); i++) current = subdivideOnce(current, tolerance);
  return current;
}

// Rounded cells are bucketed by an integer hash and compared exactly: the same matches as joining the three rounded
// numbers into a string key (-0 equals 0, NaN equals NaN), without building a string per vertex.
const same = (a: number, b: number) => a === b || a !== a && b !== b;
function cellIndex(buckets: Map<number, number[]>, cells: number[], x: number, y: number, z: number): number {
  const hash = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791), bucket = buckets.get(hash);
  if (bucket) for (let i = 0; i < bucket.length; i++) {const c = bucket[i] * 3; if (same(cells[c], x) && same(cells[c + 1], y) && same(cells[c + 2], z)) return bucket[i];}
  const index = cells.length / 3; cells.push(x, y, z);
  if (bucket) bucket.push(index); else buckets.set(hash, [index]);
  return index;
}

function subdivideOnce(data: GeometryData, tolerance: number): GeometryData {
  const P = data.positions, UV = data.uvs, count = P.length / 3;
  // Weld positions to find topology.
  const weld = new Uint32Array(count), welded: number[] = [], cells: number[] = [], buckets = new Map<number, number[]>();
  const q = 1 / Math.max(tolerance, 1e-12);
  for (let v = 0; v < count; v++) {
    const w = cellIndex(buckets, cells, Math.round(P[v * 3] * q), Math.round(P[v * 3 + 1] * q), Math.round(P[v * 3 + 2] * q));
    if (w === welded.length / 3) welded.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    weld[v] = w;
  }
  const wc = welded.length / 3;
  // Corners that share a welded position and UV become one vertex (normals are recomputed anyway), so
  // non-indexed input such as polyhedra comes out smooth and indexed.
  const canonCells: number[] = [], canonBuckets = new Map<number, number[]>(), first: number[] = [], I = Uint32Array.from(data.indices, v => {
    const c = cellIndex(canonBuckets, canonCells, weld[v], Math.round(UV[v * 2] * q), Math.round(UV[v * 2 + 1] * q));
    if (c === first.length) first.push(v);
    return first[c];
  });
  // Edge table on welded vertices: opposite vertices of adjacent faces (count, first two), and each vertex's
  // neighbours in first-seen order, which the smoothing sums depend on.
  const edgeKey = (a: number, b: number) => a < b ? a * wc + b : b * wc + a;
  const edgeIds = new Map<number, number>(), oppCount: number[] = [], opp0: number[] = [], opp1: number[] = [];
  const neighbors: number[][] = Array.from({length: wc}, () => []);
  const link = (a: number, b: number) => {const ring = neighbors[a]; for (let i = 0; i < ring.length; i++) if (ring[i] === b) return; ring.push(b);};
  for (let t = 0; t < I.length; t += 3) {
    const w0 = weld[I[t]], w1 = weld[I[t + 1]], w2 = weld[I[t + 2]];
    if (w0 === w1 || w1 === w2 || w0 === w2) continue;
    for (let k = 0; k < 3; k++) {
      const a = k === 0 ? w0 : k === 1 ? w1 : w2, b = k === 0 ? w1 : k === 1 ? w2 : w0, c = k === 0 ? w2 : k === 1 ? w0 : w1, key = edgeKey(a, b);
      let id = edgeIds.get(key);
      if (id === undefined) {id = oppCount.length; edgeIds.set(key, id); oppCount.push(1); opp0.push(c); opp1.push(0);}
      else if (++oppCount[id] === 2) opp1[id] = c;
      link(a, b); link(b, a);
    }
  }
  const boundary = (a: number, b: number) => {const id = edgeIds.get(edgeKey(a, b)); return (id === undefined ? 0 : oppCount[id]) !== 2;};
  const wp = (w: number, k: number) => welded[w * 3 + k];
  // Smoothed original vertices.
  const smooth = new Float64Array(wc * 3);
  for (let v = 0; v < wc; v++) {
    const ring = neighbors[v];
    let edges = 0, e0 = 0, e1 = 0;
    for (let i = 0; i < ring.length; i++) if (boundary(v, ring[i])) {if (edges === 0) e0 = ring[i]; else if (edges === 1) e1 = ring[i]; edges++;}
    if (edges) {
      if (edges === 2) for (let k = 0; k < 3; k++) smooth[v * 3 + k] = 0.75 * wp(v, k) + 0.125 * (wp(e0, k) + wp(e1, k));
      else for (let k = 0; k < 3; k++) smooth[v * 3 + k] = wp(v, k);
      continue;
    }
    const n = ring.length;
    if (!n) {for (let k = 0; k < 3; k++) smooth[v * 3 + k] = wp(v, k); continue;}
    const beta = (5 / 8 - (3 / 8 + Math.cos(2 * Math.PI / n) / 4) ** 2) / n;
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += wp(ring[i], k);
      smooth[v * 3 + k] = (1 - n * beta) * wp(v, k) + beta * sum;
    }
  }
  // Output: one vertex per original vertex, one per distinct attribute edge (by original index pair).
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const edgePoint = (a: number, b: number): void => {
    const id = edgeIds.get(edgeKey(a, b)), inner = id !== undefined && oppCount[id] === 2, o0 = inner ? opp0[id!] : 0, o1 = inner ? opp1[id!] : 0;
    for (let k = 0; k < 3; k++) positions.push(inner ? 0.375 * (wp(a, k) + wp(b, k)) + 0.125 * (wp(o0, k) + wp(o1, k)) : 0.5 * (wp(a, k) + wp(b, k)));
  };
  const used = new Int32Array(count).fill(-1);
  const corner = (v: number) => {
    if (used[v] < 0) {
      const w = weld[v]; used[v] = positions.length / 3;
      positions.push(smooth[w * 3], smooth[w * 3 + 1], smooth[w * 3 + 2]); uvs.push(UV[v * 2], UV[v * 2 + 1]);
    }
    return used[v];
  };
  const mids = new Map<number, number>();
  const mid = (a: number, b: number) => {
    const key = a < b ? a * count + b : b * count + a;
    let m = mids.get(key);
    if (m === undefined) {
      m = positions.length / 3; mids.set(key, m);
      edgePoint(weld[a], weld[b]); uvs.push((UV[a * 2] + UV[b * 2]) / 2, (UV[a * 2 + 1] + UV[b * 2 + 1]) / 2);
    }
    return m;
  };
  for (let t = 0; t < I.length; t += 3) {
    const ia = I[t], ib = I[t + 1], ic = I[t + 2], a = corner(ia), b = corner(ib), c = corner(ic), ab = mid(ia, ib), bc = mid(ib, ic), ca = mid(ic, ia);
    indices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return computeVertexNormals(geometryData(positions, new Float32Array(positions.length), uvs, indices));
}
