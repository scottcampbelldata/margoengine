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

/** Marching Cubes output with gradient normals and outward triangle winding. */
export function marchingCubes(
  field: DensityField,
  {
    resolution = [32, 32, 32],
    bounds = [
      [-1, -1, -1],
      [1, 1, 1],
    ],
    level = 0,
  }: MarchingCubesOptions = {},
): Geometry | null {
  if (
    typeof field !== 'function' ||
    !Number.isFinite(level) ||
    resolution.length !== 3 ||
    resolution.some((n) => !Number.isInteger(n) || n < 3 || n > 128) ||
    bounds.length !== 2 ||
    bounds.some((p) => p.length !== 3 || p.some((v) => !Number.isFinite(Math.fround(v)))) ||
    bounds[0].some((v, i) => v >= bounds[1][i])
  )
    throw new RangeError('Invalid voxel surface');
  const evaluate: DensityField = (x, y, z) => {
    const value = field(x, y, z) - level;
    if (!Number.isFinite(value)) throw new RangeError('Density must be finite');
    return value;
  };
  const mesh = extract(evaluate, resolution, bounds[0], bounds[1]);
  if (!mesh.indices.length) return null;
  const count = mesh.positions.length / 3,
    normals = new Float32Array(count * 3);
  const epsilon = Math.min(...bounds[0].map((v, i) => (bounds[1][i] - v) / resolution[i])) * 0.01;
  for (let i = 0; i < count; i++) {
    const x = mesh.positions[i * 3],
      y = mesh.positions[i * 3 + 1],
      z = mesh.positions[i * 3 + 2];
    const nx = evaluate(x + epsilon, y, z) - evaluate(x - epsilon, y, z),
      ny = evaluate(x, y + epsilon, z) - evaluate(x, y - epsilon, z),
      nz = evaluate(x, y, z + epsilon) - evaluate(x, y, z - epsilon),
      length = Math.hypot(nx, ny, nz);
    normals.set(length ? [nx / length, ny / length, nz / length] : [0, 1, 0], i * 3);
  }
  return new Geometry(mesh.positions, normals, mesh.indices);
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
/**
 * Marching tetrahedra (no lookup tables): samples `field` on a resolution[0] x [1] x [2] grid spanning `lo`..`hi`, and per
 * tetrahedron emits one triangle (one corner inside) or two (two inside) between the inside (negative) and outside corners.
 * Vertices on grid edges are shared, so the indexed mesh is closed wherever the surface stays inside the grid; triangles
 * wind counter-clockwise seen from outside.
 */
function extract(
  field: DensityField,
  [nx, ny, nz]: readonly number[],
  lo: readonly number[],
  hi: readonly number[],
): { positions: Float32Array; indices: Uint32Array } {
  const size = nx * ny * nz,
    values = new Float64Array(size),
    grid = new Float64Array(size * 3);
  for (let z = 0, i = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, i++) {
        const px = lo[0] + ((hi[0] - lo[0]) * x) / (nx - 1),
          py = lo[1] + ((hi[1] - lo[1]) * y) / (ny - 1),
          pz = lo[2] + ((hi[2] - lo[2]) * z) / (nz - 1);
        grid[i * 3] = px;
        grid[i * 3 + 1] = py;
        grid[i * 3 + 2] = pz;
        values[i] = field(px, py, pz);
      }
  const positions: number[] = [],
    indices: number[] = [];
  // Every tetrahedron edge runs from a grid point to one of 7 forward neighbours, so a vertex id is stored per (point, direction).
  const steps = [1, nx, nx * ny, 1 + nx, 1 + nx * ny, nx + nx * ny, 1 + nx + nx * ny],
    shared = new Int32Array(size * 7).fill(-1);
  const vertex = (a: number, b: number): number => {
    const p = a < b ? a : b,
      q = a < b ? b : a,
      slot = p * 7 + steps.indexOf(q - p);
    let id = shared[slot];
    if (id < 0) {
      const t = values[p] / (values[p] - values[q]);
      id = shared[slot] = positions.length / 3;
      if (id >= 1_000_000) throw new RangeError('Voxel output exceeds geometry budget');
      for (let c = 0; c < 3; c++) positions.push(grid[p * 3 + c] + (grid[q * 3 + c] - grid[p * 3 + c]) * t);
    }
    return id;
  };
  // Emits a, b, c turned so the face normal points toward grid point `out` (an outside corner).
  const face = (a: number, b: number, c: number, out: number): void => {
    const A = a * 3,
      B = b * 3,
      C = c * 3,
      ux = positions[B] - positions[A],
      uy = positions[B + 1] - positions[A + 1],
      uz = positions[B + 2] - positions[A + 2];
    const vx = positions[C] - positions[A],
      vy = positions[C + 1] - positions[A + 1],
      vz = positions[C + 2] - positions[A + 2];
    const toward =
      (uy * vz - uz * vy) * (grid[out * 3] - positions[A]) +
      (uz * vx - ux * vz) * (grid[out * 3 + 1] - positions[A + 1]) +
      (ux * vy - uy * vx) * (grid[out * 3 + 2] - positions[A + 2]);
    if (toward >= 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  };
  const corner = new Int32Array(8),
    inside: number[] = [],
    outside: number[] = [];
  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        let below = 0;
        for (let k = 0; k < 8; k++) {
          corner[k] = x + CORNERS[k][0] + nx * (y + CORNERS[k][1] + ny * (z + CORNERS[k][2]));
          if (values[corner[k]] < 0) below++;
        }
        if (below === 0 || below === 8) continue; // the surface does not cross this cube
        for (const tet of TETRAHEDRA) {
          inside.length = outside.length = 0;
          for (const k of tet) (values[corner[k]] < 0 ? inside : outside).push(corner[k]);
          if (inside.length === 1)
            face(
              vertex(inside[0], outside[0]),
              vertex(inside[0], outside[1]),
              vertex(inside[0], outside[2]),
              outside[0],
            );
          else if (inside.length === 3)
            face(
              vertex(outside[0], inside[0]),
              vertex(outside[0], inside[1]),
              vertex(outside[0], inside[2]),
              outside[0],
            );
          else if (inside.length === 2) {
            const [a, b] = inside,
              [c, d] = outside,
              ac = vertex(a, c),
              ad = vertex(a, d),
              bd = vertex(b, d),
              bc = vertex(b, c);
            face(ac, ad, bd, c);
            face(ac, bd, bc, c);
          }
        }
      }
  return { positions: new Float32Array(positions), indices: Uint32Array.from(indices) };
}
