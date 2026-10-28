import { Geometry } from '@margoengine/core';
import { Noise } from './noise.js';
export * from './noise.js';
export {
  generateTreeMesh,
  generateShrubMesh,
  generateRockMesh,
  generateFernMesh,
  generateGrassMesh,
  contactAO,
  radialAO,
} from './foliage.js';
export {
  generateAcaciaMesh,
  generateBirchMesh,
  generateCactusMesh,
  generatePalmMesh,
  generateReedMesh,
  generateSnagMesh,
  generateTundraShrubMesh,
  type TreeMesh,
} from './plants.js';
export { generateCabinMesh, ROOF_PITCH, type HeightField } from './cabin.js';
export { createHumanoid, poseHumanoid } from './humanoid.js';
/** Scalar field sampled by `marchingCubes` at world position (x, y, z); must return finite values. */
export type DensityField = (x: number, y: number, z: number) => number;
/** Options for `marchingCubes`; invalid values throw a RangeError. */
export interface MarchingCubesOptions {
  /** Grid samples per axis, integers 3..128. Default [32, 32, 32]. */
  resolution?: readonly [number, number, number];
  /** Min and max corners of the sampled box in world units; min must be below max on every axis. Default [[-1, -1, -1], [1, 1, 1]]. */
  bounds?: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** Field value of the extracted surface (iso level). Default 0. */
  level?: number;
}
/** Seeded coastal island preset; returns an allocation-free world-height sampler. */
export function createIslandHeight(seed = 731): (x: number, z: number) => number {
  const noise = new Noise(seed);
  return (x, z) => {
    const radius = Math.hypot(x, z);
    const shelf = 5.5 * Math.exp(-((radius / 57) ** 4)) - 3.4;
    const east = 21 * Math.exp(-(((x - 30) / 18) ** 2) - ((z + 25) / 24) ** 2);
    const west = 13 * Math.exp(-(((x + 34) / 19) ** 2) - ((z + 35) / 20) ** 2);
    const ridge = noise.perlin(x * 0.045, 0.3, z * 0.045) * 2.8 + noise.perlin(x * 0.14, 2, z * 0.14) * 0.55;
    return shelf + east + west + ridge * Math.exp(-((radius / 67) ** 4));
  };
}

/**
 * Marching Cubes output with gradient normals and outward triangle winding. `field` is either a density function, sampled
 * once per grid point, or the grid samples themselves: resolution[0] * [1] * [2] values, x fastest then y then z, sample
 * (x, y, z) at `bounds[0] + (bounds[1] - bounds[0]) * (x, y, z) / (resolution - 1)`. A function's normals are its
 * sampled gradient at each vertex; a grid's are its central-difference gradient, interpolated along the edge.
 */
export function marchingCubes(
  field: DensityField | ArrayLike<number>,
  {
    resolution = [32, 32, 32],
    bounds = [
      [-1, -1, -1],
      [1, 1, 1],
    ],
    level = 0,
  }: MarchingCubesOptions = {},
): Geometry | null {
  const grid = typeof field !== 'function';
  if (
    (grid && (typeof field !== 'object' || field === null || typeof field.length !== 'number')) ||
    !Number.isFinite(level) ||
    resolution.length !== 3 ||
    resolution.some((n) => !Number.isInteger(n) || n < 3 || n > 128) ||
    bounds.length !== 2 ||
    bounds.some((p) => p.length !== 3 || p.some((v) => !Number.isFinite(Math.fround(v)))) ||
    bounds[0].some((v, i) => v >= bounds[1][i])
  )
    throw new RangeError(
      'Invalid voxel surface; pass a density function or grid, a finite level, resolution 3-128 per axis and bounds with min below max.',
    );
  const [nx, ny, nz] = resolution,
    size = nx * ny * nz;
  if (grid && field.length !== size)
    throw new RangeError(`Density grid holds ${field.length} values; pass resolution[0] * [1] * [2] = ${size}.`);
  const lo = bounds[0],
    hi = bounds[1];
  // Grid point coordinates per axis, computed as before: lo + (hi - lo) * i / (n - 1).
  const axes = [nx, ny, nz].map((n, a) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = lo[a] + ((hi[a] - lo[a]) * i) / (n - 1);
    return out;
  });
  // A density function may itself call marchingCubes; only the outermost call borrows the shared scratch.
  const own = !scratch.busy;
  const values = own && scratch.values.length >= size ? scratch.values : new Float64Array(size);
  if (own) scratch.values = values;
  scratch.busy = true;
  try {
    return surface(field, grid, values, resolution, axes, level, lo, hi, own);
  } finally {
    if (own) scratch.busy = false;
  }
}

function surface(
  field: DensityField | ArrayLike<number>,
  grid: boolean,
  values: Float64Array,
  resolution: readonly [number, number, number],
  axes: readonly Float64Array[],
  level: number,
  lo: readonly number[],
  hi: readonly number[],
  own: boolean,
): Geometry | null {
  const [nx, ny, nz] = resolution,
    [ax, ay, az] = axes,
    // Per grid row along x: 0 all outside, 1 all inside, 2 both.
    rows = new Uint8Array(ny * nz);
  for (let z = 0, r = 0; z < nz; z++)
    for (let y = 0; y < ny; y++, r++) {
      const inside = grid
        ? copyRow(field as ArrayLike<number>, values, r * nx, nx, level)
        : sampleRow(field as DensityField, values, r * nx, ax, ay[y], az[z], level);
      rows[r] = inside === 0 ? 0 : inside === nx ? 1 : 2;
    }
  const mesh = extract(values, resolution, axes, rows, own);
  if (!mesh.indices.length) return null;
  const count = mesh.positions.length / 3,
    normals = new Float32Array(count * 3);
  if (grid) gridNormals(values, resolution, axes, mesh, normals);
  else {
    const evaluate: DensityField = (x, y, z) => {
      const value = (field as DensityField)(x, y, z) - level;
      if (!Number.isFinite(value)) throw new RangeError('Density must be finite');
      return value;
    };
    const epsilon = Math.min(...lo.map((v, i) => (hi[i] - v) / resolution[i])) * 0.01;
    for (let i = 0; i < count; i++) {
      const x = mesh.positions[i * 3],
        y = mesh.positions[i * 3 + 1],
        z = mesh.positions[i * 3 + 2];
      const gx = evaluate(x + epsilon, y, z) - evaluate(x - epsilon, y, z),
        gy = evaluate(x, y + epsilon, z) - evaluate(x, y - epsilon, z),
        gz = evaluate(x, y, z + epsilon) - evaluate(x, y, z - epsilon),
        length = Math.hypot(gx, gy, gz);
      unit(normals, i * 3, gx, gy, gz, length);
    }
  }
  return new Geometry(mesh.positions, normals, mesh.indices);
}

// One grid row of samples, less the level, into `values` from `start`; returns how many are inside (negative).
function copyRow(field: ArrayLike<number>, values: Float64Array, start: number, n: number, level: number): number {
  let inside = 0;
  for (let i = start, end = start + n; i < end; i++) {
    const value = field[i] - level;
    if (!Number.isFinite(value)) throw new RangeError('Density must be finite');
    values[i] = value;
    if (value < 0) inside++;
  }
  return inside;
}
function sampleRow(
  field: DensityField,
  values: Float64Array,
  start: number,
  ax: Float64Array,
  y: number,
  z: number,
  level: number,
): number {
  let inside = 0;
  for (let x = 0; x < ax.length; x++) {
    const value = field(ax[x], y, z) - level;
    if (!Number.isFinite(value)) throw new RangeError('Density must be finite');
    values[start + x] = value;
    if (value < 0) inside++;
  }
  return inside;
}

const unit = (out: Float32Array, at: number, x: number, y: number, z: number, length: number): void => {
  if (length) {
    out[at] = x / length;
    out[at + 1] = y / length;
    out[at + 2] = z / length;
  } else {
    out[at] = 0;
    out[at + 1] = 1;
    out[at + 2] = 0;
  }
};

// Grid normals: central differences at the two grid points of each vertex's edge (one-sided on the border), mixed by
// the vertex's position along that edge.
function gridNormals(
  values: Float64Array,
  [nx, ny, nz]: readonly number[],
  axes: readonly Float64Array[],
  mesh: Extracted,
  normals: Float32Array,
): void {
  const strides = [1, nx, nx * ny],
    dims = [nx, ny, nz],
    g = [0, 0, 0, 0, 0, 0];
  const gradient = (p: number, at: number): void => {
    const coords = [p % nx, Math.floor(p / nx) % ny, Math.floor(p / (nx * ny))];
    for (let a = 0; a < 3; a++) {
      const c = coords[a],
        s = strides[a],
        lo = c > 0 ? c - 1 : c,
        hi = c < dims[a] - 1 ? c + 1 : c;
      g[at + a] = (values[p + (hi - c) * s] - values[p - (c - lo) * s]) / (axes[a][hi] - axes[a][lo]);
    }
  };
  for (let i = 0, count = mesh.edges.length / 2; i < count; i++) {
    const t = mesh.weights[i];
    gradient(mesh.edges[i * 2], 0);
    gradient(mesh.edges[i * 2 + 1], 3);
    const x = g[0] + (g[3] - g[0]) * t,
      y = g[1] + (g[4] - g[1]) * t,
      z = g[2] + (g[5] - g[2]) * t;
    unit(normals, i * 3, x, y, z, Math.hypot(x, y, z));
  }
}

// Cube corners (x, y, z bits) and the six tetrahedra around the 0-6 diagonal. Every cube face is split along the diagonal
// from its lowest to its highest corner, the same in both cubes that share it, so the surface has no cracks.
const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const TETRAHEDRA = [
  [0, 6, 1, 2],
  [0, 6, 2, 3],
  [0, 6, 3, 7],
  [0, 6, 7, 4],
  [0, 6, 4, 5],
  [0, 6, 5, 1],
];
/** Corner bits (x | y << 1 | z << 2) of the CORNERS above. */
const BITS = CORNERS.map(([x, y, z]) => x | (y << 1) | (z << 2));

interface Extracted {
  positions: Float32Array;
  indices: Uint32Array;
  /** Per vertex, the grid points (lower, upper) of the edge it lies on. */
  edges: Int32Array;
  /** Per vertex, its position along that edge, 0 at the lower point. */
  weights: Float64Array;
}

// Reused between calls (one marchingCubes at a time; a nested call allocates its own): the samples, and the shared-vertex
// table, all -1 between calls.
const scratch: {
  busy: boolean;
  values: Float64Array<ArrayBuffer>;
  shared: Int32Array<ArrayBuffer>;
  positions?: Float64Array<ArrayBuffer>;
  indices?: Uint32Array<ArrayBuffer>;
  edges?: Int32Array<ArrayBuffer>;
  weights?: Float64Array<ArrayBuffer>;
  used?: Int32Array<ArrayBuffer>;
} = { busy: false, values: new Float64Array(0), shared: new Int32Array(0) };

const grow = <T extends Float64Array | Uint32Array | Int32Array>(array: T, need: number): T => {
  if (need <= array.length) return array;
  const next = new (array.constructor as new (n: number) => T)(Math.max(need, array.length * 2));
  next.set(array);
  return next;
};

/**
 * Marching tetrahedra (no lookup tables): per cube of the resolution[0] x [1] x [2] grid of `values` (sampled at the
 * `axes` coordinates), and per tetrahedron, emits one triangle (one corner inside) or two (two inside) between the inside
 * (negative) and outside corners. Vertices on grid edges are shared, so the indexed mesh is closed wherever the surface
 * stays inside the grid; triangles wind counter-clockwise seen from outside.
 */
function extract(
  values: Float64Array,
  [nx, ny, nz]: readonly number[],
  [ax, ay, az]: readonly Float64Array[],
  rows: Uint8Array,
  own: boolean,
): Extracted {
  const size = nx * ny * nz,
    slots = size * 8;
  let shared: Int32Array<ArrayBuffer>;
  if (own && scratch.shared.length >= slots) shared = scratch.shared;
  else {
    shared = new Int32Array(slots).fill(-1);
    if (own) scratch.shared = shared;
  }
  // Grid offset of each cube corner.
  const offset = CORNERS.map(([x, y, z]) => x + nx * (y + ny * z));
  const reuse = own ? scratch : null;
  let positions = reuse?.positions ?? new Float64Array(3 * 4096),
    indices = reuse?.indices ?? new Uint32Array(3 * 8192),
    edges = reuse?.edges ?? new Int32Array(2 * 4096),
    weights = reuse?.weights ?? new Float64Array(4096),
    used = reuse?.used ?? new Int32Array(4096),
    count = 0,
    length = 0;
  let bx = 0,
    by = 0,
    bz = 0,
    base = 0;
  // Every tetrahedron edge joins two comparable corners (the lower one's bits are a subset of the upper one's), so a
  // vertex id is stored per (lower grid point, direction bits).
  const vertex = (ka: number, kb: number): number => {
    const lower = (BITS[ka] & BITS[kb]) === BITS[ka] ? ka : kb,
      upper = lower === ka ? kb : ka,
      p = base + offset[lower],
      q = base + offset[upper],
      slot = p * 8 + (BITS[ka] ^ BITS[kb]);
    let id = shared[slot];
    if (id < 0) {
      id = count++;
      if (id >= 1_000_000) throw new RangeError('Voxel output exceeds the geometry budget; reduce the resolution.');
      shared[slot] = id;
      if (count > weights.length) {
        positions = grow(positions, count * 3);
        edges = grow(edges, count * 2);
        weights = grow(weights, count);
        used = grow(used, count);
      }
      used[id] = slot;
      const t = values[p] / (values[p] - values[q]),
        lb = BITS[lower],
        ub = BITS[upper],
        x0 = ax[bx + (lb & 1)],
        y0 = ay[by + ((lb >> 1) & 1)],
        z0 = az[bz + (lb >> 2)];
      positions[id * 3] = x0 + (ax[bx + (ub & 1)] - x0) * t;
      positions[id * 3 + 1] = y0 + (ay[by + ((ub >> 1) & 1)] - y0) * t;
      positions[id * 3 + 2] = z0 + (az[bz + (ub >> 2)] - z0) * t;
      edges[id * 2] = p;
      edges[id * 2 + 1] = q;
      weights[id] = t;
    }
    return id;
  };
  // Emits a, b, c turned so the face normal points toward cube corner `out` (an outside corner).
  const face = (a: number, b: number, c: number, out: number): void => {
    const A = a * 3,
      B = b * 3,
      C = c * 3,
      ux = positions[B] - positions[A],
      uy = positions[B + 1] - positions[A + 1],
      uz = positions[B + 2] - positions[A + 2];
    const vx = positions[C] - positions[A],
      vy = positions[C + 1] - positions[A + 1],
      vz = positions[C + 2] - positions[A + 2],
      o = BITS[out];
    const toward =
      (uy * vz - uz * vy) * (ax[bx + (o & 1)] - positions[A]) +
      (uz * vx - ux * vz) * (ay[by + ((o >> 1) & 1)] - positions[A + 1]) +
      (ux * vy - uy * vx) * (az[bz + (o >> 2)] - positions[A + 2]);
    if (length + 3 > indices.length) indices = grow(indices, length + 3);
    indices[length] = a;
    indices[length + 1] = toward >= 0 ? b : c;
    indices[length + 2] = toward >= 0 ? c : b;
    length += 3;
  };
  const inside = new Int32Array(4),
    outside = new Int32Array(4),
    [, , o2, o3, o4, o5, o6, o7] = offset;
  try {
    for (bz = 0; bz < nz - 1; bz++)
      for (by = 0; by < ny - 1; by++) {
        // The cubes of this row touch four grid rows; when all four lie on one side, no cube is crossed.
        const r = by + ny * bz,
          side = rows[r];
        if (side < 2 && rows[r + 1] === side && rows[r + ny] === side && rows[r + ny + 1] === side) continue;
        base = nx * r;
        // Inside bit per corner. Moving one cube along x, the x = 1 corners (1, 2, 5, 6) become the x = 0 ones (0, 3, 4,
        // 7), so each cube reads only its four new corners.
        let low =
          (values[base] < 0 ? 1 : 0) |
          (values[base + o3] < 0 ? 8 : 0) |
          (values[base + o4] < 0 ? 16 : 0) |
          (values[base + o7] < 0 ? 128 : 0);
        for (bx = 0; bx < nx - 1; bx++, base++) {
          const high =
              (values[base + 1] < 0 ? 2 : 0) |
              (values[base + o2] < 0 ? 4 : 0) |
              (values[base + o5] < 0 ? 32 : 0) |
              (values[base + o6] < 0 ? 64 : 0),
            below = low | high;
          low = ((high >> 1) & 17) | ((high << 1) & 136);
          if (below === 0 || below === 255) continue; // the surface does not cross this cube
          for (const tet of TETRAHEDRA) {
            let ins = 0,
              outs = 0;
            for (const k of tet) {
              if (below & (1 << k)) inside[ins++] = k;
              else outside[outs++] = k;
            }
            if (ins === 1)
              face(
                vertex(inside[0], outside[0]),
                vertex(inside[0], outside[1]),
                vertex(inside[0], outside[2]),
                outside[0],
              );
            else if (ins === 3)
              face(
                vertex(outside[0], inside[0]),
                vertex(outside[0], inside[1]),
                vertex(outside[0], inside[2]),
                outside[0],
              );
            else if (ins === 2) {
              const a = inside[0],
                b = inside[1],
                c = outside[0],
                d = outside[1],
                ac = vertex(a, c),
                ad = vertex(a, d),
                bd = vertex(b, d),
                bc = vertex(b, c);
              face(ac, ad, bd, c);
              face(ac, bd, bc, c);
            }
          }
        }
      }
  } finally {
    // Leave the shared table all -1 for the next call, and keep the grown buffers.
    for (let i = 0; i < count; i++) shared[used[i]] = -1;
    if (reuse) Object.assign(reuse, { positions, indices, edges, weights, used });
  }
  // edges and weights are views of reused buffers: read before the next call.
  return {
    positions: Float32Array.from(positions.subarray(0, count * 3)),
    indices: indices.slice(0, length),
    edges: edges.subarray(0, count * 2),
    weights: weights.subarray(0, count),
  };
}
