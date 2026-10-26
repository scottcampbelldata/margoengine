// Vector fields, CPU only: arrow glyphs (a shaft and two head strokes per sample, in the plane of the arrow and the
// view-independent "up" it is least aligned with) and streamlines traced through a gridded field with the classical
// fourth-order Runge-Kutta method (W. Kutta, 1901; as in E. Hairer, S. P. Norsett and G. Wanner, "Solving Ordinary
// Differential Equations I", section II.1) on trilinearly interpolated velocities.

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
    n > 1 ? ((p - lo) / (hi - lo)) * (n - 1) : p === lo || hi === lo ? 0 : Number.NaN;
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
  /** Step length in data units. Default a fifth of the smallest grid spacing. */
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
 * A streamline through `seed`: points (xyz) and the speed at each, traced with RK4 steps of fixed arc length (the
 * velocity normalised, so steps are even), stopping at the grid's edge, where the flow stops or after `maxSteps`.
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
  // Unit direction of the flow, scaled by the trace sign.
  const dir = (p: readonly number[], sign: number): [number, number, number] | null => {
    const v = sampleField(grid, p[0], p[1], p[2]);
    if (!v) return null;
    const speed = Math.hypot(v[0], v[1], v[2]);
    return speed < minSpeed ? null : [(sign * v[0]) / speed, (sign * v[1]) / speed, (sign * v[2]) / speed];
  };
  const trace = (sign: number): number[][] => {
    const points: number[][] = [];
    let p = [seed[0], seed[1], seed[2]];
    for (let n = 0; n < maxSteps; n++) {
      const k1 = dir(p, sign);
      if (!k1) break;
      const k2 = dir([p[0] + (h / 2) * k1[0], p[1] + (h / 2) * k1[1], p[2] + (h / 2) * k1[2]], sign);
      if (!k2) break;
      const k3 = dir([p[0] + (h / 2) * k2[0], p[1] + (h / 2) * k2[1], p[2] + (h / 2) * k2[2]], sign);
      if (!k3) break;
      const k4 = dir([p[0] + h * k3[0], p[1] + h * k3[1], p[2] + h * k3[2]], sign);
      if (!k4) break;
      p = [0, 1, 2].map((c) => p[c] + (h / 6) * (k1[c] + 2 * k2[c] + 2 * k3[c] + k4[c]));
      if (!sampleField(grid, p[0], p[1], p[2])) break;
      points.push(p);
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
