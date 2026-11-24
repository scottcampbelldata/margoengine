// Building blocks around triangle meshes that Rapier offers beside its shapes: voxels from points or from a filled mesh
// (`Voxels::from_points`, `voxelized_mesh` with a `FillMode`), the connected components and the half-edge topology of a mesh
// (`TriMeshFlags::CONNECTED_COMPONENTS`, `HALF_EDGE_TOPOLOGY`), and a mesh converter that picks a collider for a mesh
// (`MeshConverter`). Exact arithmetic on the numbers given, no clock and no trigonometry, so the same mesh gives the same
// answer on every machine.
//
// Clean room, from the papers: T. Akenine-Moeller, "Fast 3D Triangle-Box Overlap Testing", Journal of Graphics Tools 6(1), 2001
// (the thirteen separating axes) for the voxels a triangle touches; flood fill from outside the grid for the inside of a closed
// surface; J. Jacobi's eigenvalue method (Golub and Van Loan, "Matrix Computations", section 8.5) for the principal axes of a
// mesh's vertices.
import { MargoError } from '@margoengine/math/errors';
import type { Vec3 } from './math.js';
import type { ColliderOptions } from './shapes.js';

/** The cell a coordinate falls in: the floor of x over the cell size, without a library function. */
function cellOf(x: number, size: number): number {
  const q = x / size;
  const i = q >= 0 ? Math.trunc(q) : -Math.trunc(-q);
  return q < i ? i - 1 : i;
}

function cellSize(size: number | Vec3 | undefined): Vec3 {
  const s: Vec3 = size === undefined ? [1, 1, 1] : typeof size === 'number' ? [size, size, size] : [size[0], size[1], size[2]];
  if (!(s[0] > 0 && s[1] > 0 && s[2] > 0) || !s.every((v) => Number.isFinite(v)))
    throw new RangeError(`A voxel size is positive and finite on every axis (got ${s.join(', ')}); pass a number or [x, y, z] in metres.`);
  return s;
}

/**
 * The voxels of a point cloud: every cell of the given size that holds a point (Rapier's `voxels_from_points`), as the `cells`
 * of a `voxels` collider, three numbers each, sorted by x, then y, then z, each cell once.
 * @param points Packed x, y, z.
 * @param size A cell's edge, or its three edges (default 1).
 * @throws RangeError for a size that is not positive, points that are not whole triples or not finite.
 */
export function voxelsFromPoints(points: ArrayLike<number>, size?: number | Vec3): { cells: Int32Array; size: Vec3 } {
  const s = cellSize(size);
  if (points.length % 3 !== 0) throw new RangeError(`voxelsFromPoints takes packed x, y, z; ${points.length} numbers are not whole points.`);
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < points.length; i += 3) {
    if (!Number.isFinite(points[i]! + points[i + 1]! + points[i + 2]!)) throw new RangeError(`Point ${i / 3} is not finite; pass finite coordinates.`);
    const c: [number, number, number] = [cellOf(points[i]!, s[0]), cellOf(points[i + 1]!, s[1]), cellOf(points[i + 2]!, s[2])];
    seen.set(`${c[0]},${c[1]},${c[2]}`, c);
  }
  const cells = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const out = new Int32Array(3 * cells.length);
  cells.forEach((c, i) => out.set(c, 3 * i));
  return { cells: out, size: s };
}

/** Whether the triangle `t` (three points) meets the box of centre `c` and half size `h` (Akenine-Moeller 2001). */
function triangleMeetsBox(t: readonly [Vec3, Vec3, Vec3], c: Vec3, h: Vec3): boolean {
  const v = t.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]] as Vec3) as [Vec3, Vec3, Vec3];
  const e = [
    [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]],
    [v[2][0] - v[1][0], v[2][1] - v[1][1], v[2][2] - v[1][2]],
    [v[0][0] - v[2][0], v[0][1] - v[2][1], v[0][2] - v[2][2]],
  ] as Vec3[];
  // The three axes of the box.
  for (let k = 0; k < 3; k++) {
    const lo = Math.min(v[0][k]!, v[1][k]!, v[2][k]!),
      hi = Math.max(v[0][k]!, v[1][k]!, v[2][k]!);
    if (lo > h[k]! || hi < -h[k]!) return false;
  }
  // The triangle's plane.
  const n: Vec3 = [e[0]![1]! * e[1]![2]! - e[0]![2]! * e[1]![1]!, e[0]![2]! * e[1]![0]! - e[0]![0]! * e[1]![2]!, e[0]![0]! * e[1]![1]! - e[0]![1]! * e[1]![0]!];
  const reach = h[0] * Math.abs(n[0]) + h[1] * Math.abs(n[1]) + h[2] * Math.abs(n[2]);
  const d = n[0] * v[0][0] + n[1] * v[0][1] + n[2] * v[0][2];
  if (Math.abs(d) > reach) return false;
  // The nine cross products of an edge and a box axis.
  for (const edge of e)
    for (let k = 0; k < 3; k++) {
      const axis: Vec3 = k === 0 ? [0, -edge[2]!, edge[1]!] : k === 1 ? [edge[2]!, 0, -edge[0]!] : [-edge[1]!, edge[0]!, 0];
      if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) continue;
      const p = v.map((q) => axis[0] * q[0] + axis[1] * q[1] + axis[2] * q[2]);
      const r = h[0] * Math.abs(axis[0]) + h[1] * Math.abs(axis[1]) + h[2] * Math.abs(axis[2]);
      if (Math.min(p[0]!, p[1]!, p[2]!) > r || Math.max(p[0]!, p[1]!, p[2]!) < -r) return false;
    }
  return true;
}

/** How a mesh is filled when it is voxelized (Rapier's `FillMode`): the surface only, or the surface and what it encloses. */
export type VoxelFill = 'surface' | 'filled';

/**
 * The voxels of a triangle mesh (Rapier's `voxelized_mesh`): every cell a triangle touches, and with `fill: 'filled'` every cell
 * the surface encloses (found by flood fill from outside the mesh's grid, so a closed surface is filled and an open one is not).
 * @param vertices Packed x, y, z.
 * @param indices Three vertex indices a triangle.
 * @returns The `cells` and `size` of a `voxels` collider.
 * @throws RangeError for indices out of range, a size that is not positive, or a mesh that would need more than 16,000,000 cells.
 */
export function voxelizedMesh(
  vertices: ArrayLike<number>,
  indices: ArrayLike<number>,
  size?: number | Vec3,
  fill: VoxelFill = 'surface',
): { cells: Int32Array; size: Vec3 } {
  const s = cellSize(size);
  const count = vertices.length / 3;
  if (!Number.isInteger(count) || indices.length % 3 !== 0) throw new RangeError('voxelizedMesh takes packed x, y, z vertices and three indices a triangle.');
  const surface = new Map<number, [number, number, number]>();
  let low: [number, number, number] = [Infinity, Infinity, Infinity],
    high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const tris: [Vec3, Vec3, Vec3][] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => {
      const i = indices[t + k]!;
      if (!(i >= 0 && i < count)) throw new RangeError(`Index ${i} is outside the ${count} vertices; keep every index below it.`);
      return [vertices[3 * i]!, vertices[3 * i + 1]!, vertices[3 * i + 2]!] as Vec3;
    }) as [Vec3, Vec3, Vec3];
    tris.push(p);
    for (const q of p) {
      low = [Math.min(low[0], cellOf(q[0], s[0])), Math.min(low[1], cellOf(q[1], s[1])), Math.min(low[2], cellOf(q[2], s[2]))];
      high = [Math.max(high[0], cellOf(q[0], s[0])), Math.max(high[1], cellOf(q[1], s[1])), Math.max(high[2], cellOf(q[2], s[2]))];
    }
  }
  if (!tris.length) return { cells: new Int32Array(0), size: s };
  const dims: [number, number, number] = [high[0] - low[0] + 3, high[1] - low[1] + 3, high[2] - low[2] + 3];
  if (dims[0] * dims[1] * dims[2] > 16_000_000)
    throw new RangeError(`This mesh needs ${dims[0] * dims[1] * dims[2]} cells at this size; use a larger voxel size.`);
  const key = (x: number, y: number, z: number): number => (x * dims[1] + y) * dims[2] + z;
  const half: Vec3 = [s[0] / 2, s[1] / 2, s[2] / 2];
  for (const tri of tris) {
    const a = [0, 1, 2].map((k) => Math.min(tri[0][k]!, tri[1][k]!, tri[2][k]!)),
      b = [0, 1, 2].map((k) => Math.max(tri[0][k]!, tri[1][k]!, tri[2][k]!));
    for (let x = cellOf(a[0]!, s[0]); x <= cellOf(b[0]!, s[0]); x++)
      for (let y = cellOf(a[1]!, s[1]); y <= cellOf(b[1]!, s[1]); y++)
        for (let z = cellOf(a[2]!, s[2]); z <= cellOf(b[2]!, s[2]); z++)
          if (triangleMeetsBox(tri, [(x + 0.5) * s[0], (y + 0.5) * s[1], (z + 0.5) * s[2]], half))
            surface.set(key(x - low[0] + 1, y - low[1] + 1, z - low[2] + 1), [x, y, z]);
  }
  const cells = new Map(surface);
  if (fill === 'filled') {
    // Flood from a corner of the padded grid over every cell the surface does not hold: those it reaches are outside.
    const outside = new Uint8Array(dims[0] * dims[1] * dims[2]);
    const stack: number[] = [0];
    outside[0] = 1;
    while (stack.length) {
      const at = stack.pop()!,
        z = at % dims[2],
        y = Math.trunc(at / dims[2]) % dims[1],
        x = Math.trunc(at / (dims[2] * dims[1]));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const nx = x + dx,
          ny = y + dy,
          nz = z + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= dims[0] || ny >= dims[1] || nz >= dims[2]) continue;
        const k = key(nx, ny, nz);
        if (outside[k] || surface.has(k)) continue;
        outside[k] = 1;
        stack.push(k);
      }
    }
    for (let x = 0; x < dims[0]; x++)
      for (let y = 0; y < dims[1]; y++)
        for (let z = 0; z < dims[2]; z++) {
          const k = key(x, y, z);
          if (!outside[k] && !cells.has(k)) cells.set(k, [x + low[0] - 1, y + low[1] - 1, z + low[2] - 1]);
        }
  }
  const list = [...cells.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const out = new Int32Array(3 * list.length);
  list.forEach((c, i) => out.set(c, 3 * i));
  return { cells: out, size: s };
}

/**
 * The connected components of a triangle mesh (Rapier's `TriMeshFlags::CONNECTED_COMPONENTS`): triangles that share a vertex
 * index are in one component. One number a triangle (the component's number, from 0 in the order of its first triangle), and
 * how many components there are.
 */
export function meshConnectedComponents(indices: ArrayLike<number>): { component: Uint32Array; count: number } {
  const triangles = indices.length / 3;
  if (!Number.isInteger(triangles)) throw new RangeError('meshConnectedComponents takes three indices a triangle.');
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let root = v;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    for (let c = v; c !== root; ) {
      const next = parent.get(c)!;
      parent.set(c, root);
      c = next;
    }
    return root;
  };
  for (let i = 0; i < indices.length; i++) if (!parent.has(indices[i]!)) parent.set(indices[i]!, indices[i]!);
  for (let t = 0; t < triangles; t++)
    for (let k = 1; k < 3; k++) {
      const a = find(indices[3 * t]!),
        b = find(indices[3 * t + k]!);
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
    }
  const names = new Map<number, number>(),
    component = new Uint32Array(triangles);
  for (let t = 0; t < triangles; t++) {
    const root = find(indices[3 * t]!);
    if (!names.has(root)) names.set(root, names.size);
    component[t] = names.get(root)!;
  }
  return { component, count: names.size };
}

/**
 * The half-edge topology of a triangle mesh (Rapier's `TriMeshFlags::HALF_EDGE_TOPOLOGY`): half-edge `3 t + k` runs from
 * vertex `k` of triangle `t` to vertex `k + 1`. `vertex` is where it starts, `next` the following half-edge round its triangle,
 * `face` its triangle, and `twin` the half-edge running the other way along the same edge in the triangle across it, or
 * 0xffffffff on a boundary. An edge that more than two triangles share has no twins.
 */
export interface HalfEdgeTopology {
  vertex: Uint32Array;
  twin: Uint32Array;
  next: Uint32Array;
  face: Uint32Array;
}
export function meshHalfEdges(indices: ArrayLike<number>): HalfEdgeTopology {
  const triangles = indices.length / 3;
  if (!Number.isInteger(triangles)) throw new RangeError('meshHalfEdges takes three indices a triangle.');
  const n = indices.length,
    out: HalfEdgeTopology = { vertex: new Uint32Array(n), twin: new Uint32Array(n).fill(0xffffffff), next: new Uint32Array(n), face: new Uint32Array(n) };
  const edges = new Map<string, number[]>();
  for (let t = 0; t < triangles; t++)
    for (let k = 0; k < 3; k++) {
      const h = 3 * t + k,
        from = indices[h]!,
        to = indices[3 * t + ((k + 1) % 3)]!;
      out.vertex[h] = from;
      out.next[h] = 3 * t + ((k + 1) % 3);
      out.face[h] = t;
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      let list = edges.get(key);
      if (!list) edges.set(key, (list = []));
      list.push(h);
    }
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [a, b] = list as [number, number];
    // Opposite directions along the edge: a consistent mesh. Two that run the same way have no twin.
    if (out.vertex[a] === out.vertex[b]) continue;
    out.twin[a] = b;
    out.twin[b] = a;
  }
  return out;
}

/** What a mesh converter turns a mesh into (Rapier's `MeshConverter`). */
export type MeshConversion = 'trimesh' | 'convexHull' | 'aabb' | 'obb';

/**
 * Collider options for a triangle mesh, chosen by hand as Rapier's `MeshConverter` chooses: the mesh itself, the convex hull of
 * its vertices, the axis-aligned box around them, or the oriented box along their principal axes. A box comes with the `offset` and
 * `rotation` that place it. `options.borderRadius` rounds the hull (`RoundConvexHull`) and `options.trimesh` carries trimesh flags
 * (`TriMeshWithFlags`). A convex decomposition, rounded or not (`ConvexDecomposition`, `RoundConvexDecomposition`), is its own entry,
 * `convexDecomposition` from `@margoengine/physics/decomposition` with its `borderRadius`.
 * @throws RangeError for a mesh with no triangles or an index out of range.
 */
export function convertMesh(
  vertices: ArrayLike<number>,
  indices: ArrayLike<number>,
  to: MeshConversion,
  options: MeshConversionOptions = {},
): ColliderOptions {
  const out = convertSharp(vertices, indices, to);
  if (out.shape === 'trimesh' && options.trimesh) return { ...out, ...options.trimesh };
  if (out.shape === 'convexHull' && options.borderRadius !== undefined) {
    if (!(options.borderRadius >= 0) || !Number.isFinite(options.borderRadius))
      throw new RangeError(`borderRadius is 0 or more metres and finite (got ${options.borderRadius}); pass 0 for a sharp hull.`);
    return { ...out, borderRadius: options.borderRadius };
  }
  return out;
}

/** Options of {@link convertMesh}. */
export interface MeshConversionOptions {
  /** `convexHull` only: the hull grown by this much in metres, as Rapier's `RoundConvexHull` (default 0). */
  borderRadius?: number;
  /** `trimesh` only: the trimesh options to carry (clean-up flags, `oriented`, `fixInternalEdges`, ...), as `TriMeshWithFlags`. */
  trimesh?: Omit<Extract<ColliderOptions, { shape: 'trimesh' }>, 'shape' | 'vertices' | 'indices'>;
}

function convertSharp(vertices: ArrayLike<number>, indices: ArrayLike<number>, to: MeshConversion): ColliderOptions {
  const count = vertices.length / 3;
  if (!Number.isInteger(count) || indices.length % 3 !== 0 || indices.length === 0)
    throw new RangeError('convertMesh takes packed x, y, z vertices and at least one triangle of three indices.');
  const used = new Set<number>();
  for (let i = 0; i < indices.length; i++) {
    if (!(indices[i]! >= 0 && indices[i]! < count)) throw new RangeError(`Index ${indices[i]} is outside the ${count} vertices.`);
    used.add(indices[i]!);
  }
  if (to === 'trimesh') return { shape: 'trimesh', vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
  const points: number[] = [];
  for (const i of [...used].sort((a, b) => a - b)) points.push(vertices[3 * i]!, vertices[3 * i + 1]!, vertices[3 * i + 2]!);
  if (to === 'convexHull') return { shape: 'convexHull', points };
  const n = points.length / 3;
  if (to === 'aabb') {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, points[3 * i + k]!);
        hi[k] = Math.max(hi[k]!, points[3 * i + k]!);
      }
    return { shape: 'box', halfExtents: [(hi[0]! - lo[0]!) / 2, (hi[1]! - lo[1]!) / 2, (hi[2]! - lo[2]!) / 2], offset: [(hi[0]! + lo[0]!) / 2, (hi[1]! + lo[1]!) / 2, (hi[2]! + lo[2]!) / 2] };
  }
  if (to !== 'obb') throw new MargoError('unsupported', `convertMesh turns a mesh into trimesh, convexHull, aabb or obb, not ${String(to)}.`);
  // The principal axes: the eigenvectors of the covariance of the vertices, by Jacobi's method.
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) mean[k]! += points[3 * i + k]! / n;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a]![b]! += ((points[3 * i + a]! - mean[a]!) * (points[3 * i + b]! - mean[b]!)) / n;
  const axes = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += Math.abs(cov[p]![q]!);
    if (off < 1e-14) break;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(cov[p]![q]!) < 1e-300) continue;
        const theta = (cov[q]![q]! - cov[p]![p]!) / (2 * cov[p]![q]!),
          t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < 3; k++) {
          const a = cov[k]![p]!,
            b = cov[k]![q]!;
          cov[k]![p] = c * a - s * b;
          cov[k]![q] = s * a + c * b;
        }
        for (let k = 0; k < 3; k++) {
          const a = cov[p]![k]!,
            b = cov[q]![k]!;
          cov[p]![k] = c * a - s * b;
          cov[q]![k] = s * a + c * b;
        }
        for (let k = 0; k < 3; k++) {
          const a = axes[k]![p]!,
            b = axes[k]![q]!;
          axes[k]![p] = c * a - s * b;
          axes[k]![q] = s * a + c * b;
        }
      }
  }
  // Columns of `axes` are the principal directions; make the frame right handed.
  const col = (j: number): Vec3 => [axes[0]![j]!, axes[1]![j]!, axes[2]![j]!];
  const [ex, ey] = [col(0), col(1)];
  const ez: Vec3 = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
  const frame = [ex, ey, ez];
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      const d = frame[a]![0]! * points[3 * i]! + frame[a]![1]! * points[3 * i + 1]! + frame[a]![2]! * points[3 * i + 2]!;
      lo[a] = Math.min(lo[a]!, d);
      hi[a] = Math.max(hi[a]!, d);
    }
  const centre: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) for (let k = 0; k < 3; k++) centre[k]! += frame[a]![k]! * ((lo[a]! + hi[a]!) / 2);
  // Rotation matrix with the frame as columns, to a quaternion.
  const m = [
    [ex[0], ey[0], ez[0]],
    [ex[1], ey[1], ez[1]],
    [ex[2], ey[2], ez[2]],
  ];
  const trace = m[0]![0]! + m[1]![1]! + m[2]![2]!;
  let q: [number, number, number, number];
  if (trace > 0) {
    const w = Math.sqrt(1 + trace) / 2;
    q = [(m[2]![1]! - m[1]![2]!) / (4 * w), (m[0]![2]! - m[2]![0]!) / (4 * w), (m[1]![0]! - m[0]![1]!) / (4 * w), w];
  } else if (m[0]![0]! >= m[1]![1]! && m[0]![0]! >= m[2]![2]!) {
    const x = Math.sqrt(1 + m[0]![0]! - m[1]![1]! - m[2]![2]!) / 2;
    q = [x, (m[0]![1]! + m[1]![0]!) / (4 * x), (m[0]![2]! + m[2]![0]!) / (4 * x), (m[2]![1]! - m[1]![2]!) / (4 * x)];
  } else if (m[1]![1]! >= m[2]![2]!) {
    const y = Math.sqrt(1 + m[1]![1]! - m[0]![0]! - m[2]![2]!) / 2;
    q = [(m[0]![1]! + m[1]![0]!) / (4 * y), y, (m[1]![2]! + m[2]![1]!) / (4 * y), (m[0]![2]! - m[2]![0]!) / (4 * y)];
  } else {
    const z = Math.sqrt(1 + m[2]![2]! - m[0]![0]! - m[1]![1]!) / 2;
    q = [(m[0]![2]! + m[2]![0]!) / (4 * z), (m[1]![2]! + m[2]![1]!) / (4 * z), z, (m[1]![0]! - m[0]![1]!) / (4 * z)];
  }
  return { shape: 'box', halfExtents: [(hi[0]! - lo[0]!) / 2, (hi[1]! - lo[1]!) / 2, (hi[2]! - lo[2]!) / 2], offset: centre, rotation: q };
}
