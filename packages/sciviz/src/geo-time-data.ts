import { rangeError } from '../../shared/errors.js';
import { greatCircleArc, type GeoCoordinate } from './geo-vector-math.js';

/** Geographic keyframes. Time units are caller-defined and shared by every track and the timeline. */
export interface GeoTrack {
  readonly id: string | number;
  readonly times: ArrayLike<number>;
  /** Packed longitude degrees, latitude degrees, height metres. */
  readonly positions: ArrayLike<number>;
  readonly properties?: Readonly<Record<string, unknown>>;
}
/** Interpolation follows the shortest longitude path or a spherical great circle. */
export type GeoInterpolation = 'linear' | 'great-circle' | 'step';
/** An owned, validated track; input mutation cannot change playback. */
export interface GeoTrackData extends GeoTrack {
  readonly times: Float64Array;
  readonly positions: Float64Array;
}
/** Copies finite, strictly increasing keyframes. Duplicate times reject rather than divide by zero. */
export function prepareGeoTrack(track: GeoTrack): GeoTrackData {
  if (!['string', 'number'].includes(typeof track.id) || (typeof track.id === 'number' && !Number.isFinite(track.id)))
    throw rangeError('Track id must be a string or finite number', 'sciviz');
  const times = Float64Array.from(track.times),
    positions = Float64Array.from(track.positions);
  if (
    !times.length ||
    positions.length !== times.length * 3 ||
    !times.every(Number.isFinite) ||
    !positions.every(Number.isFinite) ||
    !times.every((v, i) => Number.isFinite(v - times[0]) && (i === 0 || v > times[i - 1])) ||
    !times.every((_, i) => Math.abs(positions[i * 3 + 1]) <= 90)
  )
    throw rangeError('Track needs increasing finite times and packed lon/lat/height with latitude -90..90', 'sciviz');
  return { id: track.id, times, positions, properties: track.properties ? { ...track.properties } : undefined };
}
function bracket(times: ArrayLike<number>, time: number): number {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
/** Position at time, undefined outside availability unless clamp is true. Exact keys stay exact. */
export function geoPositionAt(
  track: GeoTrackData,
  time: number,
  options: { readonly interpolation?: GeoInterpolation; readonly clamp?: boolean } = {},
): [number, number, number] | undefined {
  if (!Number.isFinite(time)) throw rangeError('Track time must be finite', 'sciviz');
  const mode = options.interpolation ?? 'linear';
  if (!['linear', 'great-circle', 'step'].includes(mode))
    throw rangeError('Unknown geographic interpolation', 'sciviz');
  const { times, positions: p } = track;
  if ((time < times[0] || time > times[times.length - 1]) && !options.clamp) return undefined;
  const i = Math.max(0, bracket(times, time)),
    a = Array.from(p.slice(i * 3, i * 3 + 3)) as [number, number, number];
  if (i === times.length - 1 || time <= times[i] || mode === 'step') return a;
  const b = Array.from(p.slice((i + 1) * 3, (i + 2) * 3)) as [number, number, number],
    t = (time - times[i]) / (times[i + 1] - times[i]);
  if (mode === 'great-circle') {
    // The arc evaluator owns antipodal and coincident handling; choose the exact fraction by rotating its endpoint.
    const r = Math.PI / 180,
      unit = (v: GeoCoordinate) => [
        Math.cos(v[1] * r) * Math.cos(v[0] * r),
        Math.cos(v[1] * r) * Math.sin(v[0] * r),
        Math.sin(v[1] * r),
      ],
      u = unit(a),
      v = unit(b),
      dot = Math.max(
        -1,
        Math.min(
          1,
          u.reduce((s, x, k) => s + x * v[k], 0),
        ),
      ),
      w = v.map((x, k) => x - dot * u[k]);
    let n = Math.hypot(...w);
    if (n < 1e-14 && dot < 0) {
      const arc = greatCircleArc(a, b, { segments: 2 });
      w.splice(0, 3, ...unit([arc[3], arc[4]]));
      n = 1;
    }
    const angle = Math.atan2(Math.hypot(...v.map((x, k) => x - dot * u[k])), dot),
      point = n < 1e-14 ? u : u.map((x, k) => x * Math.cos(angle * t) + (w[k] / n) * Math.sin(angle * t));
    return [
      Math.atan2(point[1], point[0]) / r,
      Math.atan2(point[2], Math.hypot(point[0], point[1])) / r,
      a[2] + (b[2] - a[2]) * t,
    ];
  }
  const delta = (((((b[0] % 360) - (a[0] % 360)) % 360) + 540) % 360) - 180;
  return [
    (((((a[0] % 360) + delta * t + 180) % 360) + 360) % 360) - 180,
    (1 - t) * a[1] + t * b[1],
    (1 - t) * a[2] + t * b[2],
  ];
}
/** Clips a trail to exact interpolated boundaries, including interior keys and the current position. */
export function geoTrail(
  track: GeoTrackData,
  time: number,
  duration: number,
  options: { readonly interpolation?: GeoInterpolation } = {},
): GeoTrackData | undefined {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration < 0)
    throw rangeError('Trail time and nonnegative duration must be finite', 'sciviz');
  const start = Math.max(time - duration, track.times[0]),
    end = Math.min(time, track.times[track.times.length - 1]);
  if (end < start) return undefined;
  const times = [start];
  for (let i = Math.max(0, bracket(track.times, start) + 1); i < track.times.length && track.times[i] < end; i++)
    times.push(track.times[i]);
  if (end > start) times.push(end);
  return {
    id: track.id,
    properties: track.properties,
    times: Float64Array.from(times),
    positions: Float64Array.from(times.flatMap((t) => geoPositionAt(track, t, options)!)),
  };
}
