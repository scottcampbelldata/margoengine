// Marching Cubes on a density function or a grid of samples (entry `@margoengine/procedural/marching-cubes`, also
// exported from the package root): its own entry so a caller that only polygonizes (terrain/rocks) loads none of the
// generators of the root.
import { Geometry } from '@margoengine/core';

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

/**
 * Marching Cubes output with gradient normals and outward triangle winding. `field` is either a density function, sampled
 * once per grid point, or the grid samples themselves: resolution[0] * [1] * [2] values, x fastest then y then z, sample
 * (x, y, z) at `bounds[0] + (bounds[1] - bounds[0]) * (x, y, z) / (resolution - 1)`. A function's vertices are its own
 * roots on the grid edges (exactly on the surface) and its normals its sampled gradient there; a grid's vertices are
 * linear between the two samples and its normals its central-difference gradient, interpolated along the edge.
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
  const evaluate: DensityField | null = grid
    ? null
    : (x, y, z) => {
        const value = (field as DensityField)(x, y, z) - level;
        if (!Number.isFinite(value)) throw new RangeError('Density must be finite');
        return value;
      };
  const mesh = extract(values, resolution, axes, rows, own, evaluate);
  if (!mesh.indices.length) return null;
  const count = mesh.positions.length / 3,
    normals = new Float32Array(count * 3);
  if (!evaluate) gridNormals(values, resolution, axes, mesh, normals);
  else {
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

// Cube corners are bits x | y << 1 | z << 2. The six cube faces, each as its four corners counter-clockwise seen from
// outside the cube.
const FACES = [
  [0, 4, 6, 2],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 6, 7, 3],
  [0, 2, 3, 1],
  [4, 5, 7, 6],
];
/** A cube edge as lower corner * 3 + axis (0 x, 1 y, 2 z); the upper corner is lower | 1 << axis. */
const edgeKey = (a: number, b: number): number => (a & b) * 3 + ((a ^ b) >> 1);
/** Per inside-corner mask, the faces (bits) whose corners alternate inside and outside: the ambiguous faces. */
const AMBIGUOUS = Array.from({ length: 256 }, (_, mask) =>
  FACES.reduce((bits, [a, b, c, d], f) => {
    const s = (k: number) => (mask >> k) & 1;
    return s(a) === s(c) && s(b) === s(d) && s(a) !== s(b) ? bits | (1 << f) : bits;
  }, 0),
);
/** Cube polygons per inside mask * 64 + connected ambiguous faces (bits), built on first use: [n, n edge keys]... */
const LOOPS: (Int8Array | undefined)[] = [];

/**
 * The surface polygons of one cube, traced on its faces (Bloomenthal 1994 builds the Marching Cubes table this way).
 * On each face the isoline joins each crossing where a counter-clockwise walk enters the inside to the crossing where
 * it leaves, so the inside lies to the right of every segment seen from outside the cube and the polygons wind
 * counter-clockwise seen from the outside (positive) side. A face whose corners alternate is split as its bilinear
 * interpolant is (`connected`: the inside corners meet across the face), and both cubes sharing the face decide alike.
 */
function cubeLoops(mask: number, connected: number): Int8Array {
  const next = new Int8Array(24).fill(-1),
    cross = [0, 0, 0, 0],
    enter = [false, false, false, false];
  for (let f = 0; f < 6; f++) {
    const c = FACES[f];
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const a = c[i],
        b = c[(i + 1) & 3],
        ia = (mask >> a) & 1,
        ib = (mask >> b) & 1;
      if (ia !== ib) (cross[n] = edgeKey(a, b)), (enter[n++] = ib === 1);
    }
    if (n === 2) {
      const e = enter[0] ? 0 : 1;
      next[cross[e]] = cross[1 - e];
    } else if (n === 4) {
      // In walk order the crossings are enter, exit, enter, exit from the first enter.
      const e = enter[0] ? 0 : 1,
        [e1, x1, e2, x2] = [0, 1, 2, 3].map((i) => cross[(e + i) & 3]);
      if ((connected >> f) & 1) (next[e1] = x2), (next[e2] = x1);
      else (next[e1] = x1), (next[e2] = x2);
    }
  }
  const out: number[] = [];
  for (let k = 0; k < 24; k++) {
    if (next[k] < 0) continue;
    const at = out.push(0) - 1;
    for (let e = k; next[e] >= 0; ) {
      out.push(e);
      const to = next[e];
      next[e] = -1;
      e = to;
    }
    out[at] = out.length - at - 1;
  }
  return Int8Array.from(out);
}

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
 * The root of `at` between coordinates sa and sb, where its values fa and fb (neither zero) lie on opposite sides:
 * the Illinois method (Dowell and Jarratt 1971), a regula falsi that halves the kept end's value when the same end is
 * kept twice, with a bisection whenever a step fails to halve the bracket, so the bracket always shrinks. Stops once
 * the bracket is below the float32 output's precision and returns the end with the smaller field value.
 */
function edgeRoot(at: (s: number) => number, sa: number, fa: number, sb: number, fb: number): number {
  const tolerance = (Math.abs(sa) + Math.abs(sb)) * 2 ** -26 + Math.abs(sb - sa) * 2 ** -40;
  let ga = fa,
    gb = fb,
    kept = 0,
    bisect = false;
  for (let step = 0; step < 160 && Math.abs(sb - sa) > tolerance; step++) {
    const width = Math.abs(sb - sa);
    let s: number = bisect ? (sa + sb) / 2 : sa - (fa * (sb - sa)) / (fb - fa);
    if (!(s > Math.min(sa, sb) && s < Math.max(sa, sb))) s = (sa + sb) / 2;
    if (s === sa || s === sb) break;
    const g = at(s);
    if (g === 0) return s;
    if (g < 0 === ga < 0) {
      if (kept === 1) fb /= 2;
      (sa = s), (fa = ga = g), (kept = 1);
    } else {
      if (kept === -1) fa /= 2;
      (sb = s), (fb = gb = g), (kept = -1);
    }
    bisect = Math.abs(sb - sa) > width / 2;
  }
  return Math.abs(ga) <= Math.abs(gb) ? sa : sb;
}

/**
 * Marching Cubes (Lorensen and Cline 1987) on axis edges: per cube of the resolution[0] x [1] x [2] grid of `values`
 * (sampled at the `axes` coordinates), the polygons of `cubeLoops`, ambiguous faces split by the asymptotic decider
 * (Nielson and Hamann 1991), fanned into triangles. Vertices on grid edges are shared, so the indexed mesh is closed
 * wherever the surface stays inside the grid; triangles wind counter-clockwise seen from outside. With `evaluate` (the
 * field less the level) each vertex is the field's own root on its edge, not the linear guess between the two samples
 * (Bloomenthal 1988 converges vertices on the known function).
 */
function extract(
  values: Float64Array,
  [nx, ny, nz]: readonly number[],
  axes: readonly Float64Array[],
  rows: Uint8Array,
  own: boolean,
  evaluate: DensityField | null,
): Extracted {
  const [ax, ay, az] = axes,
    size = nx * ny * nz,
    slots = size * 8;
  let shared: Int32Array<ArrayBuffer>;
  if (own && scratch.shared.length >= slots) shared = scratch.shared;
  else {
    shared = new Int32Array(slots).fill(-1);
    if (own) scratch.shared = shared;
  }
  // Grid offset of each cube corner.
  const offset = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => (b & 1) + nx * (((b >> 1) & 1) + ny * (b >> 2)));
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
  const cell = [0, 0, 0];
  const vertex = (key: number): number => {
    const lower = (key / 3) | 0,
      axis = key - lower * 3,
      p = base + offset[lower],
      q = base + offset[lower | (1 << axis)];
    cell[0] = bx + (lower & 1);
    cell[1] = by + ((lower >> 1) & 1);
    cell[2] = bz + (lower >> 2);
    const line = axes[axis],
      c0 = line[cell[axis]],
      c1 = line[cell[axis] + 1];
    let t = values[p] / (values[p] - values[q]),
      s = c0 + (c1 - c0) * t,
      slot = p * 8 + (1 << axis);
    // A crossing on a grid point, exactly or within the float32 output's precision (a sample at or a rounding error
    // from the level), is one point for every edge from it, so it takes the point's own slot (direction bits 0, which
    // no edge uses) and sits on the point: one vertex, and the triangles that collapse onto it are dropped. This is the
    // corner snapping of Treece, Prager and Gee (1998), at the output precision.
    const f = Math.fround;
    if (t === 0 || f(s) === f(c0)) (t = 0), (s = c0), (slot = p * 8);
    else if (t === 1 || f(s) === f(c1)) (t = 1), (s = c1), (slot = q * 8);
    let id = shared[slot];
    if (id >= 0) return id;
    const x = ax[cell[0]],
      y = ay[cell[1]],
      z = az[cell[2]];
    if (evaluate && t > 0 && t < 1) {
      const at =
        axis === 0
          ? (v: number) => evaluate(v, y, z)
          : axis === 1
            ? (v: number) => evaluate(x, v, z)
            : (v: number) => evaluate(x, y, v);
      s = edgeRoot(at, c0, values[p], c1, values[q]);
      t = (s - c0) / (c1 - c0);
    }
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
    positions[id * 3] = axis === 0 ? s : x;
    positions[id * 3 + 1] = axis === 1 ? s : y;
    positions[id * 3 + 2] = axis === 2 ? s : z;
    edges[id * 2] = p;
    edges[id * 2 + 1] = q;
    weights[id] = t;
    return id;
  };
  const loop = new Int32Array(12);
  try {
    for (bz = 0; bz < nz - 1; bz++)
      for (by = 0; by < ny - 1; by++) {
        // The cubes of this row touch four grid rows; when all four lie on one side, no cube is crossed.
        const r = by + ny * bz,
          side = rows[r];
        if (side < 2 && rows[r + 1] === side && rows[r + ny] === side && rows[r + ny + 1] === side) continue;
        base = nx * r;
        // Inside bit per corner. Moving one cube along x, the x = 1 corners (1, 3, 5, 7) become the x = 0 ones (0, 2, 4,
        // 6), so each cube reads only its four new corners.
        let low = 0;
        for (const k of [0, 2, 4, 6]) if (values[base + offset[k]] < 0) low |= 1 << k;
        for (bx = 0; bx < nx - 1; bx++, base++) {
          let high = 0;
          for (const k of [1, 3, 5, 7]) if (values[base + offset[k]] < 0) high |= 1 << k;
          const mask = low | high;
          low = high >> 1;
          if (mask === 0 || mask === 255) continue; // the surface does not cross this cube
          // Asymptotic decider: the inside corners of an alternating face meet across it when the bilinear
          // interpolant's saddle value (v0 v2 - v1 v3) / (v0 + v2 - v1 - v3) is inside. The ratio does not change
          // with the corner a face walk starts from or its direction, so both cubes on the face agree.
          let connected = 0;
          for (let f = 0, ambiguous = AMBIGUOUS[mask]; ambiguous >> f; f++) {
            if (!((ambiguous >> f) & 1)) continue;
            const [a, b, c, d] = FACES[f],
              v0 = values[base + offset[a]],
              v1 = values[base + offset[b]],
              v2 = values[base + offset[c]],
              v3 = values[base + offset[d]];
            if ((v0 * v2 - v1 * v3) / (v0 + v2 - v1 - v3) < 0) connected |= 1 << f;
          }
          const key = mask * 64 + connected,
            polygons = (LOOPS[key] ??= cubeLoops(mask, connected));
          for (let at = 0; at < polygons.length; at += polygons[at] + 1) {
            // Vertices snapped to one grid point merge; drop the repeats, then fan what is left.
            let n = 0;
            for (let i = 1; i <= polygons[at]; i++) {
              const id = vertex(polygons[at + i]);
              if (n === 0 || loop[n - 1] !== id) loop[n++] = id;
            }
            while (n > 1 && loop[n - 1] === loop[0]) n--;
            if (length + 3 * n > indices.length) indices = grow(indices, length + 3 * n);
            for (let i = 1; i + 1 < n; i++) {
              const a = loop[0],
                b = loop[i],
                c = loop[i + 1];
              if (a === b || b === c || c === a) continue;
              indices[length++] = a;
              indices[length++] = b;
              indices[length++] = c;
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
