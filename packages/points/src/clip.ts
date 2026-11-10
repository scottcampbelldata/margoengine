import type { PointCloud } from './cloud.js';
import { checkPoints, subsetCloud, transformPoint, type SurveyPoints } from './survey.js';

/** A closed volume in world space. Point centres on its boundary belong to the volume. */
export interface PointClipVolume {
  contains(x: number, y: number, z: number): boolean;
}

/** Settings for combining volumes. Defaults: union, keep inside. An empty list keeps all finite points. */
export interface PointClipOptions {
  volumes: readonly PointClipVolume[];
  operation?: 'union' | 'intersection';
  keep?: 'inside' | 'outside';
  signal?: AbortSignal;
}

function bounds(min: ArrayLike<number>, max: ArrayLike<number>, n: number): void {
  if (
    min.length !== n ||
    max.length !== n ||
    Array.from(min).some((v, i) => !Number.isFinite(v) || !Number.isFinite(max[i]) || v > max[i])
  )
    throw new RangeError('Pass finite min/max bounds in ascending order');
}

function matrix(value?: ArrayLike<number>): number[] | undefined {
  if (!value) return undefined;
  if (value.length !== 16 || !Array.from(value).every(Number.isFinite))
    throw new TypeError('Pass a finite column-major world-to-volume matrix of 16 numbers');
  return Array.from(value);
}

/** Axis-aligned or oriented box; worldToLocal defaults to identity. Bounds are copied. */
export function boxClipVolume(
  min: readonly number[],
  max: readonly number[],
  worldToLocal?: ArrayLike<number>,
): PointClipVolume {
  bounds(min, max, 3);
  const lo = [...min],
    hi = [...max],
    m = matrix(worldToLocal);
  return {
    contains(x, y, z) {
      const p = transformPoint([x, y, z], 0, m);
      return p.every((v, a) => v >= lo[a] && v <= hi[a]);
    },
  };
}

/** Polygon extruded along local z; arbitrary concave rings use even-odd fill. */
export interface PolygonClipOptions {
  /** Local z interval, inclusive. Default unbounded. */
  depth?: readonly [number, number];
  /** World-to-volume matrix; may be a view-projection matrix for screen-space polygons. Default identity. */
  worldToLocal?: ArrayLike<number>;
  /** Reject points with homogeneous w <= 0 (behind a perspective camera). Default false. */
  positiveW?: boolean;
}

/** Create an extruded polygon volume. Vertices are local xy pairs and are copied. */
export function polygonClipVolume(
  vertices: readonly (readonly [number, number])[],
  options: PolygonClipOptions = {},
): PointClipVolume {
  if (vertices.length < 3 || vertices.some((v) => v.length !== 2 || !v.every(Number.isFinite)))
    throw new TypeError('Pass at least three finite xy polygon vertices');
  const ring = vertices.map((v) => [...v]),
    m = matrix(options.worldToLocal),
    depth = options.depth ?? [-Infinity, Infinity];
  if (depth.length !== 2 || Number.isNaN(depth[0]) || Number.isNaN(depth[1]) || depth[0] > depth[1])
    throw new RangeError('Pass an ascending polygon depth interval');
  const lo = depth[0],
    hi = depth[1];
  return {
    contains(x, y, z) {
      if (options.positiveW && m && m[3] * x + m[7] * y + m[11] * z + m[15] <= 0) return false;
      const [u, v, d] = transformPoint([x, y, z], 0, m);
      if (!Number.isFinite(u) || !Number.isFinite(v) || d < lo || d > hi || !Number.isFinite(d)) return false;
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j],
          [bx, by] = ring[i];
        const cross = (u - ax) * (by - ay) - (v - ay) * (bx - ax);
        if (
          cross === 0 &&
          u >= Math.min(ax, bx) &&
          u <= Math.max(ax, bx) &&
          v >= Math.min(ay, by) &&
          v <= Math.max(ay, by)
        )
          return true;
        if (ay > v !== by > v && u < ax + ((v - ay) * (bx - ax)) / (by - ay)) inside = !inside;
      }
      return inside;
    },
  };
}

/** Select point indices without modifying data. Non-finite positions are always excluded. */
export function clipPoints(data: SurveyPoints, options: PointClipOptions): Uint32Array {
  checkPoints(data);
  if (
    !['union', 'intersection'].includes(options.operation ?? 'union') ||
    !['inside', 'outside'].includes(options.keep ?? 'inside')
  )
    throw new RangeError('Use operation union/intersection and keep inside/outside');
  const indices: number[] = [];
  for (let i = 0; i < data.positions.length / 3; i++) {
    if (!(i % 4096)) options.signal?.throwIfAborted();
    const p = transformPoint(data.positions, i, data.matrix);
    if (!p.every(Number.isFinite)) continue;
    const inside =
      options.operation === 'intersection'
        ? options.volumes.every((v) => v.contains(...p))
        : options.volumes.some((v) => v.contains(...p));
    if (!options.volumes.length || inside === (options.keep !== 'outside')) indices.push(i);
  }
  return Uint32Array.from(indices);
}

/** Create a renderable clipped cloud plus indices into the source. Re-run after changing data or volumes. */
export function createClippedCloud(
  source: PointCloud,
  options: PointClipOptions,
  worldMatrix?: ArrayLike<number>,
): { cloud: PointCloud; indices: Uint32Array } {
  const indices = clipPoints(worldMatrix ? { positions: source.positions, matrix: worldMatrix } : source, options);
  return { cloud: subsetCloud(source, indices), indices };
}

/** A polyline corridor, horizontal in the plane perpendicular to upAxis (default y). */
export interface ElevationProfileOptions {
  path: readonly (readonly [number, number, number])[];
  /** Full corridor width in world units, including its boundary. */
  width: number;
  upAxis?: 0 | 1 | 2;
  signal?: AbortSignal;
}

/** Profile records sorted by horizontal distance along the path, then source index. */
export interface ElevationProfile {
  indices: Uint32Array;
  positions: Float64Array;
  distance: Float64Array;
  elevation: Float64Array;
  /** Signed lateral distance from the chosen path segment. */
  offset: Float64Array;
  segment: Uint32Array;
  length: number;
}

/** Extract every point in a finite-width polyline corridor, once at the closest segment; square end caps. */
export function elevationProfile(data: SurveyPoints, options: ElevationProfileOptions): ElevationProfile {
  checkPoints(data);
  const { path, width } = options,
    up = options.upAxis ?? 1;
  if (
    !Number.isFinite(width) ||
    width < 0 ||
    ![0, 1, 2].includes(up) ||
    path.length < 2 ||
    path.some((p) => p.length !== 3 || !p.every(Number.isFinite))
  )
    throw new RangeError('Pass at least two finite xyz path vertices, nonnegative width and upAxis 0, 1 or 2');
  const axes = [0, 1, 2].filter((a) => a !== up),
    a = axes[0],
    b = axes[1];
  const segments: { x: number; y: number; dx: number; dy: number; length: number; start: number; index: number }[] = [];
  let length = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const dx = path[i + 1][a] - path[i][a],
      dy = path[i + 1][b] - path[i][b],
      l = Math.hypot(dx, dy);
    if (!l) continue;
    segments.push({ x: path[i][a], y: path[i][b], dx: dx / l, dy: dy / l, length: l, start: length, index: i });
    length += l;
  }
  if (!segments.length) throw new RangeError('Pass a path with nonzero horizontal length');
  const records: { i: number; p: number[]; distance: number; offset: number; segment: number }[] = [];
  for (let i = 0; i < data.positions.length / 3; i++) {
    if (!(i % 4096)) options.signal?.throwIfAborted();
    const p = transformPoint(data.positions, i, data.matrix);
    if (!p.every(Number.isFinite)) continue;
    let best = Infinity,
      record: (typeof records)[number] | undefined;
    for (const s of segments) {
      const x = p[a] - s.x,
        y = p[b] - s.y,
        t = x * s.dx + y * s.dy,
        offset = s.dx * y - s.dy * x;
      if (t < 0 || t > s.length || Math.abs(offset) > width / 2 || Math.abs(offset) >= best) continue;
      best = Math.abs(offset);
      record = { i, p, distance: s.start + t, offset, segment: s.index };
    }
    if (record) records.push(record);
  }
  records.sort((x, y) => x.distance - y.distance || x.i - y.i);
  return {
    indices: Uint32Array.from(records, (r) => r.i),
    positions: Float64Array.from(records.flatMap((r) => r.p)),
    distance: Float64Array.from(records, (r) => r.distance),
    elevation: Float64Array.from(records, (r) => r.p[up]),
    offset: Float64Array.from(records, (r) => r.offset),
    segment: Uint32Array.from(records, (r) => r.segment),
    length,
  };
}

export type { SurveyPoints } from './survey.js';
