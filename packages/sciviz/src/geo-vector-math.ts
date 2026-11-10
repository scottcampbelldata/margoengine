import { rangeError } from '../../shared/errors.js';
import { project, type Projection } from './geo.js';
/** Degrees longitude, latitude and optional metre height. */
export type GeoCoordinate = readonly [number, number, number?];
/** Sample a great-circle arc, with optional height arch. Antipodes use a deterministic perpendicular plane. */
export function greatCircleArc(
  from: GeoCoordinate,
  to: GeoCoordinate,
  options: {
    /** Segment count, default 64. */
    readonly segments?: number;
    /** Added parabolic arch height in metres, default 0. */
    readonly arch?: number;
  } = {},
): Float64Array {
  const segments = options.segments ?? 64,
    arch = options.arch ?? 0,
    r = Math.PI / 180;
  if (!Number.isInteger(segments) || segments < 1 || segments > 100000 || !Number.isFinite(arch))
    throw rangeError('Arc needs segments 1..100000 and finite arch metres', 'sciviz');
  for (const p of [from, to])
    if (p.length < 2 || !p.every(Number.isFinite) || Math.abs(p[1]) > 90)
      throw rangeError('Arc endpoints need finite lon/lat and optional height, latitude -90..90', 'sciviz');
  const unit = (p: GeoCoordinate) => [
    Math.cos(p[1] * r) * Math.cos(p[0] * r),
    Math.cos(p[1] * r) * Math.sin(p[0] * r),
    Math.sin(p[1] * r),
  ];
  const a = unit(from),
    b = unit(to),
    dot = Math.max(
      -1,
      Math.min(
        1,
        a.reduce((sum, v, i) => sum + v * b[i], 0),
      ),
    );
  const perpendicular = b.map((v, i) => v - dot * a[i]);
  const length = Math.hypot(...perpendicular),
    theta = Math.atan2(length, dot);
  if (length < 1e-14) {
    const axis =
      Math.abs(a[0]) < Math.abs(a[1])
        ? Math.abs(a[0]) < Math.abs(a[2])
          ? 0
          : 2
        : Math.abs(a[1]) < Math.abs(a[2])
          ? 1
          : 2;
    for (let i = 0; i < 3; i++) perpendicular[i] = (i === axis ? 1 : 0) - a[axis] * a[i];
  }
  const norm = Math.hypot(...perpendicular),
    tangent = perpendicular.map((v) => v / norm),
    out = new Float64Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments,
      p = a.map((v, k) => v * Math.cos(theta * t) + tangent[k] * Math.sin(theta * t));
    out.set(
      [
        Math.atan2(p[1], p[0]) / r,
        Math.atan2(p[2], Math.hypot(p[0], p[1])) / r,
        (from[2] ?? 0) * (1 - t) + (to[2] ?? 0) * t + 4 * t * (1 - t) * arch,
      ],
      i * 3,
    );
  }
  // Preserve exact source endpoints, including their longitude representation.
  out.set([from[0], from[1], from[2] ?? 0], 0);
  out.set([to[0], to[1], to[2] ?? 0], segments * 3);
  if (!out.every(Number.isFinite)) throw rangeError('Arc height overflows; reduce endpoint heights or arch', 'sciviz');
  return out;
}

/** One projected-space bin. Polygon corners and centre use map data units, not metres. */
export interface GeoBin {
  readonly column: number;
  readonly row: number;
  readonly center: readonly [number, number];
  readonly polygon: readonly (readonly [number, number])[];
  readonly count: number;
  readonly sum: number;
  readonly mean: number;
  readonly indices: Uint32Array;
}
/** Square or pointy hexagonal binning after map projection; exact deterministic input membership. */
export function geoBins(
  positions: ArrayLike<number>,
  options: {
    /** Projected side length for squares or circumradius for hexagons, required and positive. */
    readonly size: number;
    /** Default hexagon. */
    readonly shape?: 'hexagon' | 'square';
    /** Default mercator. Binning uses the plane, and its polygons can subsequently be draped on a globe. */
    readonly projection?: Exclude<Projection, 'globe'>;
    /** Lon/lat stride, default 2; stride 3 accepts height. */
    readonly stride?: 2 | 3;
    /** Optional value per point; defaults to 1. */
    readonly values?: ArrayLike<number>;
    readonly signal?: AbortSignal;
  },
): GeoBin[] {
  const size = options.size,
    stride = options.stride ?? 2,
    shape = options.shape ?? 'hexagon';
  if (
    !(size > 0 && Number.isFinite(size)) ||
    ![2, 3].includes(stride) ||
    positions.length % stride ||
    !['hexagon', 'square'].includes(shape) ||
    !['plate', 'mercator'].includes(options.projection ?? 'mercator') ||
    (options.values && options.values.length !== positions.length / stride)
  )
    throw rangeError('Binning needs positive projected size, stride 2 or 3, and one value per position', 'sciviz');
  const bins = new Map<
    string,
    { column: number; row: number; center: [number, number]; indices: number[]; sum: number }
  >();
  for (let i = 0; i < positions.length / stride; i++) {
    if ((i & 1023) === 0) options.signal?.throwIfAborted();
    const [x, y] = project(positions[i * stride], positions[i * stride + 1], 0, options.projection ?? 'mercator');
    const value = options.values?.[i] ?? 1;
    if (!Number.isFinite(value))
      throw rangeError('Binning values must be finite; filter missing observations first', 'sciviz');
    let column: number, row: number, cx: number, cy: number;
    if (shape === 'square') {
      column = Math.floor(x / size);
      row = Math.floor(y / size);
      cx = (column + 0.5) * size;
      cy = (row + 0.5) * size;
    } else {
      const q = (x / Math.sqrt(3) - y / 3) / size,
        r = (2 * y) / (3 * size),
        s = -q - r;
      let rq = Math.round(q),
        rr = Math.round(r);
      const rs = Math.round(s);
      if (Math.abs(rq - q) > Math.abs(rr - r) && Math.abs(rq - q) > Math.abs(rs - s)) rq = -rr - rs;
      else if (Math.abs(rr - r) > Math.abs(rs - s)) rr = -rq - rs;
      column = rq;
      row = rr;
      cx = Math.sqrt(3) * size * (rq + rr / 2);
      cy = 1.5 * size * rr;
    }
    const key = `${column}/${row}`;
    let bin = bins.get(key);
    if (!bin) {
      bin = { column, row, center: [cx, cy], sum: 0, indices: [] };
      bins.set(key, bin);
    }
    bin.indices.push(i);
    bin.sum += value;
    if (!Number.isFinite(bin.sum)) throw rangeError('Bin sum overflows; rescale observations before binning', 'sciviz');
  }
  return [...bins.values()].map((bin) => ({
    ...bin,
    count: bin.indices.length,
    mean: bin.sum / bin.indices.length,
    indices: new Uint32Array(bin.indices),
    polygon:
      shape === 'square'
        ? [
            [bin.center[0] - size / 2, bin.center[1] - size / 2],
            [bin.center[0] + size / 2, bin.center[1] - size / 2],
            [bin.center[0] + size / 2, bin.center[1] + size / 2],
            [bin.center[0] - size / 2, bin.center[1] + size / 2],
          ]
        : Array.from({ length: 6 }, (_, i): [number, number] => {
            const a = ((30 + 60 * i) * Math.PI) / 180;
            return [bin.center[0] + size * Math.cos(a), bin.center[1] + size * Math.sin(a)];
          }),
  }));
}
