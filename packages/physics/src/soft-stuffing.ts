// Tetrahedra fitted to a closed triangle mesh, by isosurface stuffing (Labelle and Shewchuk, "Isosurface Stuffing: Fast
// Tetrahedral Meshes with Good Dihedral Angles", ACM Transactions on Graphics 26(3), SIGGRAPH 2007): a body-centred cubic
// lattice covers the mesh; each lattice edge whose ends lie on either side of the surface is cut where it crosses it; a lattice
// vertex closer to a cut point than alpha of its edge (0.24999 on the lattice's long edges, 0.41189 on its short ones, the
// paper's values) is warped onto the nearest such cut point; then each lattice tetrahedron is kept, dropped, or cut along the
// surface by the stencil of its signs. Where a cut leaves a quadrilateral face, its diagonal runs through the face's lowest
// numbered vertex, which two neighbouring cells agree on, and prisms split by the same rule (Dompierre, Labbe, Vallet and
// Camarero, "How to Subdivide Pyramids, Prisms and Hexahedra into Tetrahedra", 8th International Meshing Roundtable, 1999), so the
// cells conform. The boundary passes through the cut points, which lie on the mesh, so the cells follow the surface to within
// the chordal error of a lattice cell.
import { insideMesh, rowCrossings, tetDeterminant } from './soft-volume.js';

/** Tetrahedra for a closed mesh: flat positions (three a particle) and four particle indices a cell. */
export interface StuffedCells {
  readonly positions: number[];
  readonly cells: number[];
}

/** The paper's warp thresholds, as fractions of an edge's length (Labelle and Shewchuk 2007, Section 3). */
const ALPHA_LONG = 0.24999;
const ALPHA_SHORT = 0.41189;

/**
 * Fills a closed, outward-wound triangle mesh (flat x, y, z vertices, three indices a triangle) with tetrahedra fitted to its
 * surface, on a body-centred cubic lattice of cube side `size` metres.
 */
export function stuffMesh(vertices: ArrayLike<number>, triangles: ArrayLike<number>, size: number): StuffedCells {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, vertices[i]!);
    max[i % 3] = Math.max(max[i % 3]!, vertices[i]!);
  }
  // One cube of margin all round, so every cube that meets the mesh has its six neighbouring centres.
  const n = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a]! - min[a]!) / size)) + 2) as [number, number, number],
    o = [0, 1, 2].map((a) => (min[a]! + max[a]!) / 2 - (n[a]! * size) / 2) as [number, number, number],
    [nx, ny, nz] = n,
    corners = (nx + 1) * (ny + 1) * (nz + 1),
    total = corners + nx * ny * nz,
    corner = (i: number, j: number, k: number): number => (i * (ny + 1) + j) * (nz + 1) + k,
    centre = (i: number, j: number, k: number): number => corners + (i * ny + j) * nz + k,
    position = new Float64Array(total * 3),
    sign = new Int8Array(total);
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++)
      for (let k = 0; k <= nz; k++)
        position.set([o[0] + i * size, o[1] + j * size, o[2] + k * size], corner(i, j, k) * 3);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++)
        position.set([o[0] + (i + 0.5) * size, o[1] + (j + 0.5) * size, o[2] + (k + 0.5) * size], centre(i, j, k) * 3);
  // Inside (-1) or outside (+1): the ray test of insideMesh, run once a lattice row (its crossings depend on y and z only).
  const classify = (count: number, ids: (s: number) => number): void => {
    const hits = rowCrossings(position[ids(0) * 3 + 1]!, position[ids(0) * 3 + 2]!, vertices, triangles);
    for (let s = 0; s < count; s++) {
      const id = ids(s),
        x = position[id * 3]!;
      let crossings = 0;
      for (const h of hits) if (h > x) crossings++;
      sign[id] = crossings % 2 === 1 ? -1 : 1;
    }
  };
  for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) classify(nx + 1, (i) => corner(i, j, k));
  for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) classify(nx, (i) => centre(i, j, k));

  // The lattice tetrahedra: two neighbouring centres and two consecutive corners of the square face they share.
  const tets: number[] = [];
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3,
      c = (a + 2) % 3;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++)
        for (let k = 0; k < nz; k++) {
          const at = [i, j, k];
          if (at[a]! + 1 >= n[a]!) continue;
          const next = [i, j, k];
          next[a]!++;
          const ring = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ].map(([u, v]) => {
            const q = [0, 0, 0];
            q[a] = at[a]! + 1;
            q[b] = at[b]! + u!;
            q[c] = at[c]! + v!;
            return corner(q[0]!, q[1]!, q[2]!);
          });
          const p = centre(i, j, k),
            q = centre(next[0]!, next[1]!, next[2]!);
          for (let m = 0; m < 4; m++) tets.push(p, q, ring[m]!, ring[(m + 1) % 4]!);
        }
  }

  // Cut points on the lattice edges that cross the surface, where the segment meets the mesh nearest its inside end.
  const longEdge = (u: number, w: number): boolean => u < corners === w < corners,
    key = (u: number, w: number): number => (u < w ? u * total + w : w * total + u),
    cuts = new Map<number, [number, number, number]>(),
    cutAt = (u: number, w: number): [number, number, number] => {
      const inner = sign[u]! < 0 ? u : w,
        outer = inner === u ? w : u,
        p = [position[inner * 3]!, position[inner * 3 + 1]!, position[inner * 3 + 2]!] as const,
        d = [position[outer * 3]! - p[0], position[outer * 3 + 1]! - p[1], position[outer * 3 + 2]! - p[2]] as const,
        t = segmentHit(p, d, vertices, triangles) ?? bisect(p, d, vertices, triangles);
      return [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
    };
  for (let t = 0; t < tets.length; t += 4)
    for (let x = 0; x < 4; x++)
      for (let y = x + 1; y < 4; y++) {
        const u = tets[t + x]!,
          w = tets[t + y]!;
        if (sign[u]! * sign[w]! < 0 && !cuts.has(key(u, w))) cuts.set(key(u, w), cutAt(u, w));
      }

  // Warp: a vertex too near a cut point on one of its edges moves onto the nearest such point and lies on the surface.
  const warp = new Map<number, [number, number, number]>();
  for (const [k, point] of cuts) {
    const u = Math.floor(k / total),
      w = k % total,
      alpha = longEdge(u, w) ? ALPHA_LONG : ALPHA_SHORT,
      length = Math.hypot(
        position[u * 3]! - position[w * 3]!,
        position[u * 3 + 1]! - position[w * 3 + 1]!,
        position[u * 3 + 2]! - position[w * 3 + 2]!,
      );
    for (const v of [u, w]) {
      const distance = Math.hypot(
        point[0] - position[v * 3]!,
        point[1] - position[v * 3 + 1]!,
        point[2] - position[v * 3 + 2]!,
      );
      if (distance >= alpha * length) continue;
      const held = warp.get(v);
      if (
        !held ||
        distance <
          Math.hypot(held[0] - position[v * 3]!, held[1] - position[v * 3 + 1]!, held[2] - position[v * 3 + 2]!)
      )
        warp.set(v, point);
    }
  }
  for (const [v, point] of warp) {
    position.set(point, v * 3);
    sign[v] = 0;
  }

  // Number the output: lattice vertices in lattice order, then the surviving cut points in key order.
  const id = new Map<number, number>(),
    out: number[] = [],
    used = new Set<number>(),
    raw: number[] = [];
  const order = [...cuts.keys()].sort((p, q) => p - q),
    cutIndex = new Map(order.map((k, i) => [k, total + i]));
  const cut = (u: number, w: number): number => cutIndex.get(key(u, w))!;
  const push = (...four: number[]): void => {
    raw.push(...four);
    for (const v of four) used.add(v);
  };
  // A quadrilateral u0 u1 u2 u3 (in cyclic order) with an apex: two tetrahedra, split through the quad's lowest vertex.
  const pyramid = (apex: number, q: readonly [number, number, number, number]): void => {
    const m = q.indexOf(Math.min(...q)),
      a = q[m]!,
      b = q[(m + 1) % 4]!,
      c = q[(m + 2) % 4]!,
      d = q[(m + 3) % 4]!;
    push(apex, a, b, c);
    push(apex, a, c, d);
  };
  // A prism of triangles (v0 v1 v2) and (v3 v4 v5), vi + 3 across from vi: three tetrahedra (Dompierre et al. 1999).
  const prism = (v: readonly number[]): void => {
    const m = v.indexOf(Math.min(...v)),
      // Turn the prism so its lowest vertex is v0: rotate within its triangle, and swap the triangles if it is in the top one.
      rot = (s: number): number => {
        const bottom = m < 3 ? 0 : 3,
          top = 3 - bottom,
          r = m % 3,
          tri = s < 3 ? bottom : top;
        return v[tri + (((s % 3) + r) % 3)]!;
      },
      [p0, p1, p2, p3, p4, p5] = [0, 1, 2, 3, 4, 5].map(rot) as [number, number, number, number, number, number];
    if (Math.min(p1, p5) < Math.min(p2, p4)) {
      push(p0, p1, p2, p5);
      push(p0, p1, p5, p4);
    } else {
      push(p0, p1, p2, p4);
      push(p0, p4, p2, p5);
    }
    push(p0, p4, p5, p3);
  };
  for (let t = 0; t < tets.length; t += 4) {
    const four = [tets[t]!, tets[t + 1]!, tets[t + 2]!, tets[t + 3]!],
      neg = four.filter((v) => sign[v]! < 0),
      zero = four.filter((v) => sign[v] === 0),
      pos = four.filter((v) => sign[v]! > 0);
    if (neg.length === 0) {
      // On or outside the surface; a cell of four warped vertices is kept when its centre is inside.
      if (zero.length === 4) {
        const c = [0, 1, 2].map((a) => four.reduce((s, v) => s + position[v * 3 + a]!, 0) / 4) as [
          number,
          number,
          number,
        ];
        if (insideMesh(c, vertices, triangles)) push(...four);
      }
      continue;
    }
    if (pos.length === 0) {
      push(...four);
      continue;
    }
    if (neg.length === 1 && pos.length === 3)
      push(neg[0]!, cut(neg[0]!, pos[0]!), cut(neg[0]!, pos[1]!), cut(neg[0]!, pos[2]!));
    else if (neg.length === 1 && pos.length === 2)
      push(neg[0]!, zero[0]!, cut(neg[0]!, pos[0]!), cut(neg[0]!, pos[1]!));
    else if (neg.length === 1) push(neg[0]!, zero[0]!, zero[1]!, cut(neg[0]!, pos[0]!));
    else if (neg.length === 2 && pos.length === 2) {
      const [a, b] = neg as [number, number],
        [p, q] = pos as [number, number];
      prism([a, cut(a, p), cut(a, q), b, cut(b, p), cut(b, q)]);
    } else if (neg.length === 2) {
      const [a, b] = neg as [number, number],
        p = pos[0]!;
      pyramid(zero[0]!, [a, b, cut(b, p), cut(a, p)]);
    } else {
      const [a, b, c] = neg as [number, number, number],
        p = pos[0]!;
      prism([a, b, c, cut(a, p), cut(b, p), cut(c, p)]);
    }
  }
  const point = (v: number): ArrayLike<number> =>
    v < total ? position.subarray(v * 3, v * 3 + 3) : cuts.get(order[v - total]!)!;
  for (const v of [...used].sort((p, q) => p - q)) {
    id.set(v, out.length / 3);
    const at = point(v);
    out.push(at[0]!, at[1]!, at[2]!);
  }
  const cells = raw.map((v) => id.get(v)!);
  // Every cell right-handed: a left-handed one has its last two corners swapped.
  for (let t = 0; t < cells.length; t += 4)
    if (tetDeterminant(out, cells[t]!, cells[t + 1]!, cells[t + 2]!, cells[t + 3]!) < 0)
      [cells[t + 2], cells[t + 3]] = [cells[t + 3]!, cells[t + 2]!];
  return { positions: out, cells };
}

/** Where the segment p + t d (t from 0 to 1) first meets a triangle of the mesh (Moller and Trumbore 1997), or null. */
function segmentHit(
  p: readonly number[],
  d: readonly number[],
  vertices: ArrayLike<number>,
  triangles: ArrayLike<number>,
): number | null {
  let best: number | null = null;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t]! * 3,
      b = triangles[t + 1]! * 3,
      c = triangles[t + 2]! * 3;
    const e1x = vertices[b]! - vertices[a]!,
      e1y = vertices[b + 1]! - vertices[a + 1]!,
      e1z = vertices[b + 2]! - vertices[a + 2]!,
      e2x = vertices[c]! - vertices[a]!,
      e2y = vertices[c + 1]! - vertices[a + 1]!,
      e2z = vertices[c + 2]! - vertices[a + 2]!,
      hx = d[1]! * e2z - d[2]! * e2y,
      hy = d[2]! * e2x - d[0]! * e2z,
      hz = d[0]! * e2y - d[1]! * e2x,
      det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-30) continue;
    const sx = p[0]! - vertices[a]!,
      sy = p[1]! - vertices[a + 1]!,
      sz = p[2]! - vertices[a + 2]!,
      u = (sx * hx + sy * hy + sz * hz) / det;
    if (u < -1e-12 || u > 1 + 1e-12) continue;
    const qx = sy * e1z - sz * e1y,
      qy = sz * e1x - sx * e1z,
      qz = sx * e1y - sy * e1x,
      v = (d[0]! * qx + d[1]! * qy + d[2]! * qz) / det;
    if (v < -1e-12 || u + v > 1 + 1e-12) continue;
    const s = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (s >= 0 && s <= 1 && (best === null || s < best)) best = s;
  }
  return best;
}

/** The crossing found by halving the segment on the inside test, for a segment that passes through the mesh at an edge. */
function bisect(
  p: readonly number[],
  d: readonly number[],
  vertices: ArrayLike<number>,
  triangles: ArrayLike<number>,
): number {
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (insideMesh([p[0]! + d[0]! * mid, p[1]! + d[1]! * mid, p[2]! + d[2]! * mid], vertices, triangles)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
