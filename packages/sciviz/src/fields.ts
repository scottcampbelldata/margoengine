// Vector fields, CPU only: arrow glyphs (a shaft and two head strokes per sample, in the plane of the arrow and the
// view-independent "up" it is least aligned with) and streamlines traced through a gridded field with the classical
// fourth-order Runge-Kutta method (W. Kutta, 1901; as in E. Hairer, S. P. Norsett and G. Wanner, "Solving Ordinary
// Differential Equations I", section II.1) on trilinearly interpolated velocities.

import { rangeError } from '../../shared/errors.js';

/** A vector field on a regular grid: components u, v (and w) at nx x ny (x nz) samples, x fastest. */
export interface VectorGrid {
  readonly u: ArrayLike<number>;
  readonly v: ArrayLike<number>;
  /** Third component; omit for a 2D field. */
  readonly w?: ArrayLike<number>;
  /** Samples along x, y and z (1 for a 2D field). */
  readonly dims: readonly [number, number, number];
  /** Data bounds of the grid's first and last samples: [xmin, xmax, ymin, ymax, zmin, zmax]. */
  readonly bounds: readonly [number, number, number, number, number, number];
}

/** The field's velocity at data point p (trilinear), or null outside the grid or next to a NaN sample. */
export function sampleField(grid: VectorGrid, x: number, y: number, z: number): [number, number, number] | null {
  const [nx, ny, nz] = grid.dims,
    b = grid.bounds;
  const coord = (p: number, lo: number, hi: number, n: number): number =>
    n > 1 ? (p < Math.min(lo, hi) || p > Math.max(lo, hi) ? Number.NaN : ((p - lo) / (hi - lo)) * (n - 1))
      : p === lo || hi === lo ? 0 : Number.NaN;
  const fx = coord(x, b[0], b[1], nx),
    fy = coord(y, b[2], b[3], ny),
    fz = nz > 1 ? coord(z, b[4], b[5], nz) : 0;
  if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= nx - 1 && fy <= ny - 1 && fz <= nz - 1)) return null;
  const i = Math.min(Math.floor(fx), Math.max(nx - 2, 0)),
    j = Math.min(Math.floor(fy), Math.max(ny - 2, 0)),
    k = Math.min(Math.floor(fz), Math.max(nz - 2, 0)),
    tx = fx - i,
    ty = fy - j,
    tz = fz - k;
  const out: [number, number, number] = [0, 0, 0],
    comps = [grid.u, grid.v, grid.w];
  for (let c = 0; c < 3; c++) {
    const a = comps[c];
    if (!a) continue;
    let sum = 0;
    for (let dz = 0; dz <= (nz > 1 ? 1 : 0); dz++)
      for (let dy = 0; dy <= (ny > 1 ? 1 : 0); dy++)
        for (let dx = 0; dx <= (nx > 1 ? 1 : 0); dx++) {
          const weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (nz > 1 ? (dz ? tz : 1 - tz) : 1);
          if (weight === 0) continue;
          const s = a[((k + dz) * ny + (j + dy)) * nx + (i + dx)];
          if (s !== s) return null;
          sum += weight * s;
        }
    out[c] = sum;
  }
  return out;
}

/** Options for {@link streamline}. */
export interface StreamlineOptions {
  /** Maximum arc step in data units; shortened for local error and critical points. Default a fifth of the smallest grid spacing. */
  readonly step?: number;
  /** Most steps each way. Default 2000. */
  readonly maxSteps?: number;
  /** Stop where the speed falls below this. Default 1e-9. */
  readonly minSpeed?: number;
  /** `'forward'`, `'backward'` or `'both'` (default) from the seed. */
  readonly direction?: 'forward' | 'backward' | 'both';
}

/** The grid's smallest sample spacing in data units. */
export function gridSpacing(grid: VectorGrid): number {
  const [nx, ny, nz] = grid.dims,
    b = grid.bounds;
  const s = [nx > 1 ? (b[1] - b[0]) / (nx - 1) : Infinity, ny > 1 ? (b[3] - b[2]) / (ny - 1) : Infinity];
  if (nz > 1) s.push((b[5] - b[4]) / (nz - 1));
  return Math.min(...s.map(Math.abs));
}

/**
 * A streamline through `seed`: points (xyz) and the speed at each, traced with error-controlled, normalized RK4.
 * Step doubling estimates local position error; unresolved turns/critical points shorten the step. Stops at
 * minSpeed, the grid edge/mask, spatial resolution (1e-6 of min(step, grid spacing), or roundoff), or maxSteps.
 */
export function streamline(
  grid: VectorGrid,
  seed: readonly [number, number, number],
  options: StreamlineOptions = {},
): { positions: Float64Array; speeds: Float64Array } {
  const h = options.step ?? gridSpacing(grid) / 5,
    maxSteps = options.maxSteps ?? 2000,
    minSpeed = options.minSpeed ?? 1e-9,
    direction = options.direction ?? 'both';
  if (!(h > 0) || !Number.isFinite(h) || !Number.isSafeInteger(maxSteps) || maxSteps < 0 ||
    !Number.isFinite(minSpeed) || minSpeed < 0 || !['forward', 'backward', 'both'].includes(direction))
    throw rangeError('Streamline needs a positive finite step, nonnegative integer maxSteps/minSpeed and a valid direction', 'sciviz');
  // Normalization is singular at a zero. Do not let RK stages straddle that singularity or let their
  // cancellation masquerade as an accurate step. Half-space tests also resolve sharp, nonzero curvature.
  const resolution = Math.min(h, gridSpacing(grid)) * 1e-6;
  const dir = (p: readonly number[], sign: number): number[] | null => {
    const v = sampleField(grid, p[0], p[1], p[2]);
    if (!v) return null;
    const speed = Math.hypot(v[0], v[1], v[2]);
    return speed > 0 && speed >= minSpeed && Number.isFinite(speed)
      ? v.map((c) => sign * c / speed) : null;
  };
  const dot = (a: number[], b: number[]) => a.reduce((sum, c, i) => sum + c * b[i], 0);
  const advance = (p: number[], length: number, sign: number, reference: number[]): number[] | null => {
    const stage = (q: number[]) => {
      const k = dir(q, sign);
      return k && dot(k, reference) > 0 ? k : null;
    };
    const offset = (k: number[], fraction: number) => p.map((c, i) => c + fraction * length * k[i]);
    const k1 = stage(p);
    if (!k1) return null;
    const k2 = stage(offset(k1, 0.5));
    if (!k2) return null;
    const k3 = stage(offset(k2, 0.5));
    if (!k3) return null;
    const k4 = stage(offset(k3, 1));
    if (!k4) return null;
    const q = p.map((c, i) => c + length / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    return stage(q) ? q : null;
  };
  const trace = (sign: number): number[][] => {
    const points: number[][] = [];
    let p = [seed[0], seed[1], seed[2]], length = h;
    for (let n = 0; n < maxSteps; n++) {
      const k1 = dir(p, sign);
      if (!k1) break;
      const floor = Math.max(resolution, 32 * Number.EPSILON * Math.max(...p.map(Math.abs), h));
      let next: number[] | null = null;
      // Bounded refinement, never publication followed by path trimming. Each rejection halves length.
      while (length >= floor) {
        const full = advance(p, length, sign, k1),
          half = advance(p, length / 2, sign, k1),
          fine = half && advance(half, length / 2, sign, k1);
        if (full && fine) {
          const delta = fine.map((c, i) => c - p[i]),
            error = Math.hypot(...fine.map((c, i) => c - full[i])) / 15;
          if (dot(delta, k1) > floor && error <= length * 1e-6) {
            next = fine;
            // RK4's local error scales with length^5. Keep the requested step as the upper bound.
            length = Math.min(h, length * Math.min(2, Math.max(0.5, 0.9 * (length * 1e-6 / (error || Number.MIN_VALUE)) ** 0.2)));
            break;
          }
        }
        length /= 2;
      }
      if (!next) break;
      points.push(next);
      p = next;
    }
    return points;
  };
  const back = direction === 'forward' ? [] : trace(-1).reverse(),
    ahead = direction === 'backward' ? [] : trace(1),
    seedValue = sampleField(grid, seed[0], seed[1], seed[2]),
    all = seedValue ? [...back, [seed[0], seed[1], seed[2]], ...ahead] : [];
  const positions = new Float64Array(all.length * 3),
    speeds = new Float64Array(all.length);
  all.forEach((p, i) => {
    positions.set(p, i * 3);
    const v = sampleField(grid, p[0], p[1], p[2]);
    speeds[i] = v ? Math.hypot(v[0], v[1], v[2]) : 0;
  });
  return { positions, speeds };
}

/**
 * Arrow glyphs as line segments (pairs of xyz points): for each sample, a shaft from its point along its vector times
 * `scale`, and two head strokes `head` of the shaft's length long, 25 degrees off it, in the plane of the shaft and
 * the axis it is least aligned with. Zero and NaN vectors draw nothing.
 */
export function arrowSegments(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  z: ArrayLike<number> | undefined,
  u: ArrayLike<number>,
  v: ArrayLike<number>,
  w: ArrayLike<number> | undefined,
  scale: number,
  head = 0.3,
): { segments: Float64Array; sample: Uint32Array } {
  const out: number[] = [],
    sample: number[] = [],
    cos = Math.cos((25 * Math.PI) / 180),
    sin = Math.sin((25 * Math.PI) / 180);
  for (let i = 0; i < x.length; i++) {
    const p = [x[i], y[i], z ? z[i] : 0],
      d = [u[i] * scale, v[i] * scale, w ? w[i] * scale : 0],
      length = Math.hypot(d[0], d[1], d[2]);
    if (!(length > 0) || !p.every(Number.isFinite)) continue;
    const t = [p[0] + d[0], p[1] + d[1], p[2] + d[2]],
      a = d.map((c) => c / length);
    // A perpendicular in the plane of the shaft and the axis least aligned with it (z for a 2D field: the head stays flat).
    const axis = w ? [0, 1, 2].reduce((m, c) => (Math.abs(a[c]) < Math.abs(a[m]) ? c : m), 0) : 2;
    const e = [0, 0, 0];
    e[axis] = 1;
    const dot = a[0] * e[0] + a[1] * e[1] + a[2] * e[2];
    let n = [e[0] - dot * a[0], e[1] - dot * a[1], e[2] - dot * a[2]];
    if (!w) n = [-a[1], a[0], 0];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((c) => c / nl);
    const hl = head * length;
    out.push(...p, ...t);
    for (const s of [1, -1]) out.push(...t, ...[0, 1, 2].map((c) => t[c] - hl * (cos * a[c] - s * sin * n[c])));
    sample.push(i, i, i);
  }
  return { segments: Float64Array.from(out), sample: Uint32Array.from(sample) };
}
