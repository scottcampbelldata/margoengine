// Indexed-grid rasterizers with exact voxel boundary rules: ellipsoids, cylinders, rings and thick or tapered lines,
// returned as cell indexes of a grid (part of ./edit). Stamp them with stampCells.
import type { Vec3 } from '@margoengine/math';
import { axisIndex, cellLimit, checkCell, checkOptions, checkPoint, type GridLimits } from './grid.js';

/** Options every rasterizer takes. */
export interface RasterOptions extends GridLimits {
  /** Cells outside the grid: `'refuse'` (default) throws a RangeError and returns nothing, `'clip'` drops them. */
  outside?: 'refuse' | 'clip';
}

/** Options of {@link ellipsoidCells}. */
export interface EllipsoidOptions extends RasterOptions {
  /** Centre, in cells (any finite point). */
  center: Vec3;
  /** Radii along x, y and z, each positive and finite. */
  radii: Vec3;
}

/** Options of {@link cylinderCells}. */
export interface CylinderOptions extends RasterOptions {
  /** The axis the cylinder runs along. */
  axis: 'x' | 'y' | 'z';
  /** Centre, in cells; each cell is rounded (`Math.round`) after its whole-cell offset is added. */
  center: Vec3;
  /** Radius across the axis, 0 or more. */
  radius: number;
  /** Length along the axis, 0 or more: offsets `ceil(-length / 2)` to `floor(length / 2)`. */
  length: number;
  /** Radius of a hole along the axis, 0 or more: cells with `b * b + d * d <= inner * inner` stay out. Default none. */
  inner?: number;
}

/** Options of {@link ringCells}. */
export interface RingOptions extends RasterOptions {
  /** Centre, in cells. */
  center: Vec3;
  /** Outer radius, 0 or more. */
  outer: number;
  /** Inner radius, 0 or more: the hole. */
  inner: number;
  /** Thickness along z, 0 or more, as a cylinder's length. */
  thickness: number;
}

/** Options of {@link thickLineCells}. */
export interface ThickLineOptions extends RasterOptions {
  from: Vec3;
  to: Vec3;
  /** Half width of the cube stamped at each step, 0 or more: cells from `ceil(p - halfWidth)` to `floor(p + halfWidth)`. Default 0. */
  halfWidth?: number;
  /**
   * Step count `n` from the longest axis span `s`. `'ceil'` (default): `n = ceil(s)`, steps 0 to n, so the line ends
   * on `to`. `'span'`: `n = s` itself, steps 0 to `floor(s)`, so a fractional span stops short of `to`. Both put step
   * `k` at `round(from + (to - from) * k / max(1, n))` per axis.
   */
  steps?: 'ceil' | 'span';
}

/** Options of {@link taperedLineCells}. */
export interface TaperedLineOptions extends RasterOptions {
  from: Vec3;
  to: Vec3;
  /** Radius at `from`, finite. Default 1. */
  radius?: number;
  /** Radius at `to`, finite. Default `radius`. */
  endRadius?: number;
  /** Smallest radius a sphere is stamped with, positive. Default 0.6. */
  minRadius?: number;
  /** Spheres per cell of length: `ceil(length * samplesPerCell)` steps. Positive. Default 1.4. */
  samplesPerCell?: number;
}

const MAX_BOX = 67_108_864,
  MAX_STEPS = 1_048_576;

/** Collects cells of a grid of `size`, each once in first-reached order, under an outside rule and a cell budget. */
function collector(size: Vec3, options: RasterOptions, name: string) {
  checkOptions(options, name);
  checkCell(size, `${name} size`);
  if (size.some((v) => v < 1)) throw new RangeError(`${name} size has an empty axis; pass sizes of at least 1`);
  const outside = options.outside ?? 'refuse',
    limit = cellLimit(options),
    cells = new Set<number>(),
    [sx, sy, sz] = size;
  if (outside !== 'refuse' && outside !== 'clip')
    throw new TypeError(`${name} outside is unknown; pass 'refuse' or 'clip'`);
  return {
    put(x: number, y: number, z: number): void {
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) {
        if (outside === 'clip') return;
        throw new RangeError(`${name} reaches cell ${x}, ${y}, ${z} outside the grid; move it or pass outside 'clip'`);
      }
      const index = x + sx * (z + sz * y);
      if (!cells.has(index) && cells.size >= limit)
        throw new RangeError(`${name} covers over ${limit} cells; draw less or raise maxCells`);
      cells.add(index);
    },
    result: () => Float64Array.from(cells),
  };
}

function nonNegative(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new RangeError(`${subject} must be finite and 0 or more; pass one`);
  return value;
}

function checkBox(extents: number[], name: string): void {
  if (extents.reduce((product, n) => product * Math.max(0, n), 1) > MAX_BOX)
    throw new RangeError(`${name} spans over ${MAX_BOX} cells of bounding box; draw it in parts`);
}

/** The ellipsoid test of one centre and radii, cells visited y, then z, then x. */
function ellipsoid(put: (x: number, y: number, z: number) => void, c: Vec3, r: Vec3): void {
  const [cx, cy, cz] = c,
    [rx, ry, rz] = r;
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++)
    for (let z = Math.ceil(cz - rz); z <= Math.floor(cz + rz); z++)
      for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++)
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1) put(x, y, z);
}

/**
 * The cells of a solid ellipsoid in a grid of `size`, as cell indexes: whole cells from `ceil(c - r)` to
 * `floor(c + r)` per axis with `((x - cx) / rx)^2 + ((y - cy) / ry)^2 + ((z - cz) / rz)^2 <= 1` (cell coordinates,
 * not centres), visited y, then z, then x.
 */
export function ellipsoidCells(size: Vec3, options: EllipsoidOptions): Float64Array {
  const out = collector(size, options, 'ellipsoidCells');
  checkPoint(options.center, 'ellipsoidCells center');
  checkPoint(options.radii, 'ellipsoidCells radii');
  if (options.radii.some((r) => r <= 0)) throw new RangeError('ellipsoidCells radii must be positive; pass three');
  checkBox(
    options.radii.map((r) => 2 * r + 1),
    'ellipsoidCells',
  );
  ellipsoid(out.put, options.center, options.radii);
  return out.result();
}

function cylinder(
  put: (x: number, y: number, z: number) => void,
  axis: 0 | 1 | 2,
  center: Vec3,
  radius: number,
  length: number,
  inner?: number,
): void {
  const u = (axis + 1) % 3,
    v = (axis + 2) % 3,
    p = [0, 0, 0];
  for (let a = Math.ceil(-length / 2); a <= Math.floor(length / 2); a++)
    for (let b = Math.ceil(-radius); b <= radius; b++)
      for (let d = Math.ceil(-radius); d <= radius; d++) {
        const r2 = b * b + d * d;
        if (r2 > radius * radius || (inner !== undefined && r2 <= inner * inner)) continue;
        p[0] = center[0];
        p[1] = center[1];
        p[2] = center[2];
        p[axis] += a;
        p[u] += b;
        p[v] += d;
        put(Math.round(p[0]), Math.round(p[1]), Math.round(p[2]));
      }
}

/**
 * The cells of a cylinder along `axis`: offset `a` along it from `ceil(-length / 2)` to `floor(length / 2)` and
 * offsets `b`, `d` across it (the next two axes, x after z) from `ceil(-radius)` while within `radius`, kept when
 * `b^2 + d^2 <= radius^2` and, with `inner`, `b^2 + d^2 > inner^2`; each cell is `round(center + offsets)`.
 */
export function cylinderCells(size: Vec3, options: CylinderOptions): Float64Array {
  const out = collector(size, options, 'cylinderCells'),
    axis = axisIndex(options.axis, 'cylinderCells axis');
  checkPoint(options.center, 'cylinderCells center');
  const radius = nonNegative(options.radius, 'cylinderCells radius'),
    length = nonNegative(options.length, 'cylinderCells length'),
    inner = options.inner === undefined ? undefined : nonNegative(options.inner, 'cylinderCells inner');
  checkBox([2 * radius + 1, 2 * radius + 1, length + 1], 'cylinderCells');
  cylinder(out.put, axis, options.center, radius, length, inner);
  return out.result();
}

/** The cells of a flat ring around z: a z cylinder of `thickness` with radius `outer` and a hole of radius `inner`. */
export function ringCells(size: Vec3, options: RingOptions): Float64Array {
  const out = collector(size, options, 'ringCells');
  checkPoint(options.center, 'ringCells center');
  const outer = nonNegative(options.outer, 'ringCells outer'),
    inner = nonNegative(options.inner, 'ringCells inner'),
    thickness = nonNegative(options.thickness, 'ringCells thickness');
  checkBox([2 * outer + 1, 2 * outer + 1, thickness + 1], 'ringCells');
  cylinder(out.put, 2, options.center, outer, thickness, inner);
  return out.result();
}

/**
 * The cells of a straight line drawn as a cube of `halfWidth` at each step (see {@link ThickLineOptions.steps}), each
 * cube's cells visited y, then z, then x.
 */
export function thickLineCells(size: Vec3, options: ThickLineOptions): Float64Array {
  const out = collector(size, options, 'thickLineCells'),
    { from: a, to: b } = options,
    half = nonNegative(options.halfWidth ?? 0, 'thickLineCells halfWidth'),
    mode = options.steps ?? 'ceil';
  checkPoint(a, 'thickLineCells from');
  checkPoint(b, 'thickLineCells to');
  if (mode !== 'ceil' && mode !== 'span') throw new TypeError("thickLineCells steps is unknown; pass 'ceil' or 'span'");
  const span = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])),
    n = mode === 'ceil' ? Math.ceil(span) : span;
  if (n > MAX_STEPS) throw new RangeError(`thickLineCells takes over ${MAX_STEPS} steps; draw it in parts`);
  checkBox([2 * half + 1, 2 * half + 1, 2 * half + 1], 'thickLineCells');
  for (let k = 0; k <= n; k++) {
    const p = [0, 1, 2].map((i) => Math.round(a[i] + ((b[i] - a[i]) * k) / Math.max(1, n)));
    for (let y = Math.ceil(p[1] - half); y <= Math.floor(p[1] + half); y++)
      for (let z = Math.ceil(p[2] - half); z <= Math.floor(p[2] + half); z++)
        for (let x = Math.ceil(p[0] - half); x <= Math.floor(p[0] + half); x++) out.put(x, y, z);
  }
  return out.result();
}

/**
 * The cells of a tapered line: `ceil(length * samplesPerCell)` + 1 spheres (ellipsoids with three equal radii, the
 * {@link ellipsoidCells} rule) at `from + (to - from) * t`, `t = i / max(1, steps)`, of radius
 * `max(minRadius, radius + (endRadius - radius) * t)`.
 */
export function taperedLineCells(size: Vec3, options: TaperedLineOptions): Float64Array {
  const out = collector(size, options, 'taperedLineCells'),
    { from: a, to: b } = options,
    r = options.radius ?? 1,
    end = options.endRadius ?? r,
    min = options.minRadius ?? 0.6,
    density = options.samplesPerCell ?? 1.4;
  checkPoint(a, 'taperedLineCells from');
  checkPoint(b, 'taperedLineCells to');
  if (!Number.isFinite(r) || !Number.isFinite(end))
    throw new RangeError('taperedLineCells radius and endRadius must be finite; pass numbers');
  if (!(min > 0 && Number.isFinite(min)) || !(density > 0 && Number.isFinite(density)))
    throw new RangeError('taperedLineCells minRadius and samplesPerCell must be positive and finite; pass numbers');
  const distance = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
    steps = Math.ceil(distance * density),
    widest = Math.max(min, Math.abs(r), Math.abs(end));
  if (steps > MAX_STEPS) throw new RangeError(`taperedLineCells takes over ${MAX_STEPS} steps; draw it in parts`);
  checkBox([2 * widest + 1, 2 * widest + 1, 2 * widest + 1], 'taperedLineCells');
  for (let i = 0; i <= steps; i++) {
    const t = i / Math.max(1, steps),
      radius = Math.max(min, r + (end - r) * t);
    ellipsoid(
      out.put,
      [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
      [radius, radius, radius],
    );
  }
  return out.result();
}
