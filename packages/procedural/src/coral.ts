import type { GeometryData } from '@margoengine/geometry';
import { marchingCubes, type DensityField } from './marching-cubes.js';

type Point = [number, number, number];
type Bounds = [Point, Point];

/** Colony silhouettes loosely based on branching, tabular and massive reef builders. */
export type CoralForm = 'branching' | 'table' | 'brain';

/** Form, repeatable variation, scale and sampling detail of a single colony. */
export interface CoralOptions {
  /** Default branching. */
  readonly form?: CoralForm;
  /** Signed 32-bit repeatable colony seed. Default 1. */
  readonly seed?: number;
  /** Approximate colony diameter in metres. Default 1. */
  readonly diameter?: number;
  /** Grid samples on the longest axis, 48–128. Default 100. */
  readonly resolution?: number;
}

interface Stem {
  readonly from: Point;
  readonly direction: Point;
  readonly invLengthSquared: number;
  readonly radius: number;
  readonly taper: number;
}

function smoothMin(a: number, b: number, width: number): number {
  const overlap = Math.max(width - Math.abs(a - b), 0) / width;
  return Math.min(a, b) - overlap * overlap * width * 0.25;
}

function branchingField(seed: number, table: boolean): { field: DensityField; bounds: Bounds } {
  const stems: Stem[] = [];
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
  const bounds: Bounds = [
    [Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity],
  ];
  const azimuth = next() * Math.PI * 2;
  const add = (from: Point, to: Point, radius: number, tip: number) => {
    const direction = to.map((value, axis) => value - from[axis]) as Point;
    stems.push({
      from,
      direction,
      invLengthSquared: 1 / (direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2),
      radius,
      taper: tip - radius,
    });
    for (let axis = 0; axis < 3; axis++) {
      const margin = radius + 0.046;
      bounds[0][axis] = Math.min(bounds[0][axis], from[axis] - margin, to[axis] - margin);
      bounds[1][axis] = Math.max(bounds[1][axis], from[axis] + margin, to[axis] + margin);
    }
  };
  const grow = (start: Point, angle: number, rise: number, spread: number, radius: number, depth: number): void => {
    const mid: Point = [
      start[0] + Math.cos(angle) * spread * 0.52,
      start[1] + rise * 0.4,
      start[2] + Math.sin(angle) * spread * 0.52,
    ];
    const curve = (next() - 0.5) * 0.85;
    const end: Point = [
      mid[0] + Math.cos(angle + curve) * spread * 0.48,
      start[1] + rise,
      mid[2] + Math.sin(angle + curve) * spread * 0.48,
    ];
    add(start, mid, radius, radius * 0.84);
    add(mid, end, radius * 0.84, radius * (depth > 0 ? 0.65 : 0.51));
    if (depth === 0) return;
    const fork = 0.63 + next() * 0.53;
    const length = 0.54 + next() * 0.22;
    const secondarySpread = (table ? 0.088 : 0.067) * (depth === 1 ? 0.7 : 1);
    const secondaryRise = (table ? 0.063 : 0.125) * (depth === 1 ? 0.65 : 1);
    grow(mid, angle - fork, secondaryRise, secondarySpread, radius * 0.63, depth - 1);
    grow(end, angle + fork * 0.64, secondaryRise * length, secondarySpread * 0.74, radius * 0.63, depth - 1);
  };
  const base: Point = [0, -0.017, 0];
  const crown: Point = [(next() - 0.5) * 0.06, table ? 0.138 : 0.089, (next() - 0.5) * 0.06];
  add(base, crown, table ? 0.094 : 0.12, table ? 0.066 : 0.092);
  const count = table ? 8 : 7;
  for (let i = 0; i < count; i++) {
    const angle = azimuth + (i * Math.PI * 2) / count + (next() - 0.5) * 0.51;
    const rise = table ? 0.065 + next() * 0.05 : 0.16 + next() * 0.116;
    const spread = table ? 0.267 + next() * 0.068 : 0.145 + next() * 0.12;
    grow(crown, angle, rise, spread, (table ? 0.042 : 0.05) + next() * 0.01, 2);
  }
  if (!table) grow(crown, azimuth + 0.8, 0.273, 0.115, 0.047, 2);
  bounds[0][1] = -0.055;
  return {
    bounds,
    field(x, y, z) {
      let surface = 1;
      for (const { from, direction, invLengthSquared, radius, taper } of stems) {
        const a = x - from[0],
          b = y - from[1],
          c = z - from[2];
        const t = Math.min(1, Math.max(0, (a * direction[0] + b * direction[1] + c * direction[2]) * invLengthSquared));
        const r = radius + taper * t;
        const sq = (a - direction[0] * t) ** 2 + (b - direction[1] * t) ** 2 + (c - direction[2] * t) ** 2;
        if (sq < (r + Math.max(0.012, surface)) ** 2) surface = smoothMin(surface, Math.sqrt(sq) - r, 0.011);
      }
      // Fine calice relief lives on the colony surface and survives geometry export.
      const texture = Math.sin(x * 281 + Math.sin(z * 143)) * Math.cos(y * 233) * Math.sin(z * 251 - x * 23);
      return Math.max(-y, surface + 0.0027 * texture);
    },
  };
}

function brainField(seed: number, resolution: number): DensityField {
  const phase = (seed % 16381) * 0.047;
  // Keep several samples across the tightest folds and fade microscopic relief at distant detail.
  const detail = Math.min(1, resolution / 116);
  return (x, y, z) => {
    const radial = Math.hypot(x / 0.495, (y - 0.113) / 0.295, z / 0.47);
    const folds =
      detail *
      (x * 86 +
        y * 41 +
        5.3 * Math.sin(z * 9 + 2.55 * Math.sin(y * 6.1 + phase)) +
        1.9 * Math.sin(y * 18 - z * 11 + phase));
    const ridge = (0.5 + 0.5 * Math.cos(folds)) ** 1.33;
    const bead = Math.sin(z * 160 + 8 * Math.cos(y * 49)) * Math.sin(x * 168 + y * 135);
    return Math.max(-y, (radial - 0.982) * 0.36 - 0.0095 * ridge - 0.0011 * detail ** 3 * bead);
  };
}

// An undersampled pore or groove can leave an isolated cell at the isosurface. Keep the
// coral colony as one connected mesh. Its basal body always contains the largest component.
function colonyVertices(vertexCount: number, indices: Uint32Array): Uint32Array {
  const parents = Uint32Array.from({ length: vertexCount }, (_, i) => i);
  const sizes = new Uint32Array(vertexCount).fill(1);
  const root = (i: number) => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  let colony = 0;
  for (let i = 0; i < indices.length; i += 3) {
    for (let j = 1; j <= 2; j++) {
      let a = root(indices[i]),
        b = root(indices[i + j]);
      if (a === b) continue;
      if (sizes[a] < sizes[b]) [a, b] = [b, a];
      parents[b] = a;
      sizes[a] += sizes[b];
      if (sizes[a] > sizes[colony]) colony = a;
    }
  }
  const map = new Uint32Array(vertexCount).fill(0xffffffff);
  for (let i = 0, next = 0; i < vertexCount; i++) {
    if (root(i) === colony) map[i] = next++;
  }
  return map;
}

/** Generate one seeded, closed, Y-up coral colony with a seabed contact at y=0. UVs project from above. */
export function coralGeometry({
  form = 'branching',
  seed = 1,
  diameter = 1,
  resolution = 100,
}: CoralOptions = {}): GeometryData {
  if (
    (form !== 'branching' && form !== 'table' && form !== 'brain') ||
    seed !== (seed | 0) ||
    !Number.isFinite(diameter) ||
    diameter < 0.01 ||
    diameter > 30 ||
    !Number.isInteger(resolution) ||
    resolution < 48 ||
    resolution > 128
  )
    throw new RangeError('Coral needs a supported form, signed 32-bit seed, diameter 0.01–30 m and resolution 48–128');
  const { field, bounds } =
    form === 'brain'
      ? {
          field: brainField(seed, resolution),
          bounds: [
            [-0.562, -0.055, -0.56],
            [0.563, 0.475, 0.56],
          ] as Bounds,
        }
      : branchingField(seed, form === 'table');
  const dimensions = bounds[0].map((n, i) => bounds[1][i] - n) as Point;
  const longest = Math.max(...dimensions);
  const grid = dimensions.map((n) => Math.max(3, Math.round((n / longest) * (resolution - 1)) + 1)) as Point;
  const result = marchingCubes(field, { resolution: grid, bounds });
  if (!result) throw new RangeError('Coral surface could not be sampled; use a higher resolution');

  const source = result.vertices;
  const map = colonyVertices(source.length / 6, result.indices);
  const count = map.reduce((sum, i) => sum + Number(i !== 0xffffffff), 0);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < source.length / 6; i++) {
    const to = map[i];
    if (to === 0xffffffff) continue;
    for (let axis = 0; axis < 3; axis++) {
      positions[to * 3 + axis] = source[i * 6 + axis] * diameter;
      normals[to * 3 + axis] = source[i * 6 + 3 + axis];
    }
    uvs[to * 2] = 0.5 + source[i * 6];
    uvs[to * 2 + 1] = 0.5 + source[i * 6 + 2];
  }
  const indices = result.indices.filter((i) => map[i] !== 0xffffffff).map((i) => map[i]);
  return { positions, normals, uvs, indices };
}
