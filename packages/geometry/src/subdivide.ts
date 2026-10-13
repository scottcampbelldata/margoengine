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

function subdivideOnce(data: GeometryData, tolerance: number): GeometryData {
  const P = data.positions, UV = data.uvs, count = P.length / 3;
  // Weld positions to find topology.
  const weld = new Uint32Array(count), keyOf = new Map<string, number>(), welded: number[] = [];
  const q = 1 / Math.max(tolerance, 1e-12);
  for (let v = 0; v < count; v++) {
    const key = `${Math.round(P[v * 3] * q)},${Math.round(P[v * 3 + 1] * q)},${Math.round(P[v * 3 + 2] * q)}`;
    let w = keyOf.get(key);
    if (w === undefined) {w = welded.length / 3; keyOf.set(key, w); welded.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);}
    weld[v] = w;
  }
  const wc = welded.length / 3;
  // Corners that share a welded position and UV become one vertex (normals are recomputed anyway), so
  // non-indexed input such as polyhedra comes out smooth and indexed.
  const canon = new Map<string, number>(), I = Uint32Array.from(data.indices, v => {
    const key = `${weld[v]},${Math.round(UV[v * 2] * q)},${Math.round(UV[v * 2 + 1] * q)}`, found = canon.get(key);
    if (found !== undefined) return found;
    canon.set(key, v); return v;
  });
  // Edge table on welded vertices: opposite vertices of adjacent faces.
  const edgeKey = (a: number, b: number) => a < b ? a * wc + b : b * wc + a;
  const opposite = new Map<number, number[]>();
  const neighbors: Set<number>[] = Array.from({length: wc}, () => new Set<number>());
  for (let t = 0; t < I.length; t += 3) {
    const w = [weld[I[t]], weld[I[t + 1]], weld[I[t + 2]]];
    if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2]) continue;
    for (let k = 0; k < 3; k++) {
      const a = w[k], b = w[(k + 1) % 3], c = w[(k + 2) % 3], key = edgeKey(a, b), list = opposite.get(key);
      if (list) list.push(c); else opposite.set(key, [c]);
      neighbors[a].add(b); neighbors[b].add(a);
    }
  }
  const boundary = (a: number, b: number) => (opposite.get(edgeKey(a, b))?.length ?? 0) !== 2;
  const wp = (w: number, k: number) => welded[w * 3 + k];
  // Smoothed original vertices.
  const smooth = new Float64Array(wc * 3);
  for (let v = 0; v < wc; v++) {
    const ring = [...neighbors[v]], edges = ring.filter(n => boundary(v, n));
    if (edges.length) {
      if (edges.length === 2) for (let k = 0; k < 3; k++) smooth[v * 3 + k] = 0.75 * wp(v, k) + 0.125 * (wp(edges[0], k) + wp(edges[1], k));
      else for (let k = 0; k < 3; k++) smooth[v * 3 + k] = wp(v, k);
      continue;
    }
    const n = ring.length;
    if (!n) {for (let k = 0; k < 3; k++) smooth[v * 3 + k] = wp(v, k); continue;}
    const beta = (5 / 8 - (3 / 8 + Math.cos(2 * Math.PI / n) / 4) ** 2) / n;
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (const r of ring) sum += wp(r, k);
      smooth[v * 3 + k] = (1 - n * beta) * wp(v, k) + beta * sum;
    }
  }
  const edgePoint = (a: number, b: number): number[] => {
    const opp = opposite.get(edgeKey(a, b)) ?? [];
    return [0, 1, 2].map(k => opp.length === 2 ? 0.375 * (wp(a, k) + wp(b, k)) + 0.125 * (wp(opp[0], k) + wp(opp[1], k)) : 0.5 * (wp(a, k) + wp(b, k)));
  };
  // Output: one vertex per original vertex, one per distinct attribute edge (by original index pair).
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
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
      positions.push(...edgePoint(weld[a], weld[b])); uvs.push((UV[a * 2] + UV[b * 2]) / 2, (UV[a * 2 + 1] + UV[b * 2 + 1]) / 2);
    }
    return m;
  };
  for (let t = 0; t < I.length; t += 3) {
    const ia = I[t], ib = I[t + 1], ic = I[t + 2], a = corner(ia), b = corner(ib), c = corner(ic), ab = mid(ia, ib), bc = mid(ib, ic), ca = mid(ic, ia);
    indices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return computeVertexNormals(geometryData(positions, new Float32Array(positions.length), uvs, indices));
}
