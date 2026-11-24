// Cells for a closed triangle mesh: the cubes of a lattice that hold or touch the mesh, and a skin, the mesh's own vertices riding
// in the cells that hold them (each vertex has the barycentric coordinates of the tetrahedron it lies in).
//
// A triangle meets a box when no separating axis exists between them: the three box axes, the triangle's normal and the nine cross
// products of box axes with triangle edges (Akenine-Moller, "Fast 3D Triangle-Box Overlap Testing", J. Graphics Tools 6(1), 2001,
// is the reference for the axis list; the test below is the plain separating axis test of Gottschalk, Lin and Manocha, "OBBTree",
// SIGGRAPH 1996). A point is inside a closed mesh when a ray from it crosses an odd number of triangles.
import type { Vec3 } from './math.js';

type V = readonly [number, number, number];

const sub = (a: V, b: V): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The three corners of triangle `t` of an indexed mesh. */
export function corners(vertices: ArrayLike<number>, indices: ArrayLike<number>, t: number): [V, V, V] {
  const at = (k: number): V => [
    vertices[indices[t * 3 + k]! * 3]!,
    vertices[indices[t * 3 + k]! * 3 + 1]!,
    vertices[indices[t * 3 + k]! * 3 + 2]!,
  ];
  return [at(0), at(1), at(2)];
}

/** Whether the triangle meets the box of half sizes `half` centred on `centre`. */
export function triangleMeetsBox(tri: readonly [V, V, V], centre: V, half: number): boolean {
  const a = sub(tri[0], centre),
    b = sub(tri[1], centre),
    c = sub(tri[2], centre),
    edges: V[] = [sub(b, a), sub(c, b), sub(a, c)],
    separated = (axis: V): boolean => {
      const length = dot(axis, axis);
      if (length < 1e-24) return false;
      const pa = dot(a, axis),
        pb = dot(b, axis),
        pc = dot(c, axis),
        r = half * (Math.abs(axis[0]) + Math.abs(axis[1]) + Math.abs(axis[2]));
      return Math.min(pa, pb, pc) > r || Math.max(pa, pb, pc) < -r;
    };
  for (let k = 0; k < 3; k++) {
    const lo = Math.min(a[k]!, b[k]!, c[k]!),
      hi = Math.max(a[k]!, b[k]!, c[k]!);
    if (lo > half || hi < -half) return false;
  }
  const unit: V[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  if (separated(cross(edges[0]!, edges[1]!))) return false;
  for (const edge of edges) for (const axis of unit) if (separated(cross(axis, edge))) return false;
  return true;
}

/** Whether `point` is inside a closed, outward mesh: a ray along +x crosses an odd number of triangles. */
export function insideMesh(point: V, vertices: ArrayLike<number>, indices: ArrayLike<number>): boolean {
  let crossings = 0;
  for (let t = 0; t < indices.length / 3; t++) {
    const [p, q, r] = corners(vertices, indices, t),
      e1 = sub(q, p),
      e2 = sub(r, p),
      dir: V = [1, 0, 0],
      h = cross(dir, e2),
      det = dot(e1, h);
    if (Math.abs(det) < 1e-18) continue;
    const s = sub(point, p),
      u = dot(s, h) / det;
    if (u < 0 || u > 1) continue;
    const qv = cross(s, e1),
      v = dot(dir, qv) / det;
    if (v < 0 || u + v > 1) continue;
    if (dot(e2, qv) / det > 0) crossings++;
  }
  return crossings % 2 === 1;
}

/** A skin: mesh vertices (flat) each bound to the cell that holds it, with the barycentric coordinates there. */
export interface Skin {
  vertices: Float32Array;
  indices: Uint32Array;
  /** The cell of each vertex (an index into the body's cells), and its four weights (they add to 1; they may be negative past the cell). */
  cell: Uint32Array;
  weight: Float32Array;
}

/** Binds each vertex of a mesh to the tetrahedron of `cells` (four particle indices each, of `positions`) that holds it, or lies nearest. */
export function bindSkin(
  vertices: ArrayLike<number>,
  indices: ArrayLike<number>,
  positions: ArrayLike<number>,
  cells: ArrayLike<number>,
): Skin {
  const n = vertices.length / 3,
    cell = new Uint32Array(n),
    weight = new Float32Array(n * 4),
    count = cells.length / 4;
  // A bounding box of every cell, to skip those a vertex is not near.
  const boxes = new Float64Array(count * 6);
  for (let t = 0; t < count; t++)
    for (let a = 0; a < 3; a++) {
      let lo = Infinity,
        hi = -Infinity;
      for (let k = 0; k < 4; k++) {
        const x = positions[cells[t * 4 + k]! * 3 + a]!;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      boxes[t * 6 + a] = lo;
      boxes[t * 6 + 3 + a] = hi;
    }
  const coords = (t: number, p: V): number[] | null => {
    const at = (k: number): V => [
      positions[cells[t * 4 + k]! * 3]!,
      positions[cells[t * 4 + k]! * 3 + 1]!,
      positions[cells[t * 4 + k]! * 3 + 2]!,
    ];
    const o = at(0),
      a = sub(at(1), o),
      b = sub(at(2), o),
      c = sub(at(3), o),
      d = sub(p, o),
      det = dot(a, cross(b, c));
    if (Math.abs(det) < 1e-24) return null;
    const l1 = dot(d, cross(b, c)) / det,
      l2 = dot(a, cross(d, c)) / det,
      l3 = dot(a, cross(b, d)) / det;
    return [1 - l1 - l2 - l3, l1, l2, l3];
  };
  for (let i = 0; i < n; i++) {
    const p: V = [vertices[i * 3]!, vertices[i * 3 + 1]!, vertices[i * 3 + 2]!];
    let best = -1,
      bestScore = -Infinity,
      bestCoords: number[] = [1, 0, 0, 0];
    for (let t = 0; t < count; t++) {
      let outside = false;
      for (let a = 0; a < 3 && !outside; a++)
        outside = p[a]! < boxes[t * 6 + a]! - 1e-9 || p[a]! > boxes[t * 6 + 3 + a]! + 1e-9;
      if (outside && best >= 0 && bestScore >= 0) continue;
      const w = coords(t, p);
      if (!w) continue;
      // How far inside: the smallest weight (0 or more is inside), so the nearest cell wins when none holds the vertex.
      const score = Math.min(...w);
      if (score > bestScore) {
        best = t;
        bestScore = score;
        bestCoords = w;
        if (score >= 0) break;
      }
    }
    cell[i] = Math.max(best, 0);
    weight.set(bestCoords, i * 4);
  }
  return {
    vertices: Float32Array.from(vertices as ArrayLike<number>),
    indices: Uint32Array.from(indices as ArrayLike<number>),
    cell,
    weight,
  };
}

/** The cubes of side `size` over the mesh's box that hold or touch it, as the centres the lattice builder asks about. */
export function reaches(
  vertices: ArrayLike<number>,
  indices: ArrayLike<number>,
  size: number,
): (x: number, y: number, z: number) => boolean {
  // Triangles by the lattice columns their boxes overlap, so each cube tests the few near it.
  const triangles = indices.length / 3,
    boxes: [V, V][] = [];
  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = corners(vertices, indices, t);
    boxes.push([
      [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])],
      [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])],
    ]);
  }
  return (x, y, z) => {
    const centre: V = [x, y, z],
      half = size / 2;
    if (insideMesh(centre, vertices, indices)) return true;
    for (let t = 0; t < triangles; t++) {
      const [lo, hi] = boxes[t]!;
      if (
        hi[0] < x - half ||
        lo[0] > x + half ||
        hi[1] < y - half ||
        lo[1] > y + half ||
        hi[2] < z - half ||
        lo[2] > z + half
      )
        continue;
      if (triangleMeetsBox(corners(vertices, indices, t), centre, half)) return true;
    }
    return false;
  };
}

/** The tight box of a flat list of points. */
export function boundsOf(vertices: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, vertices[i + a]!);
      max[a] = Math.max(max[a]!, vertices[i + a]!);
    }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}
