import { normalizeQuaternion } from '@margoengine/math/quat';
import { interpolateKeys, invalidTrack } from './key-cursor.js';
/** How a keyframe track blends between keys, as in glTF 2.0: `STEP` holds the previous key, `LINEAR` interpolates (slerp for rotations), `CUBICSPLINE` uses in/out tangents (three values per key). */
export type Interpolation = 'STEP' | 'LINEAR' | 'CUBICSPLINE';
/**
 * Samples one keyframe track at `time` and returns the result (allocating `width` numbers unless `target` is given). Checks its arguments and throws on bad ones; use {@link sampleTrackInto} in a hot loop.
 *
 * `times` is increasing seconds; `values` holds `width` numbers per key (three times that for `CUBICSPLINE`). Set `quaternion` for rotation tracks so the result is normalised. Time outside the track clamps to the first or last key.
 *
 * @example
 * ```ts
 * const times = new Float32Array([0, 1]);
 * const values = new Float32Array([0, 0, 0, 10, 0, 0]);
 * sampleTrack(times, values, 3, 0.5, 'LINEAR'); // Float32Array [5, 0, 0]
 * ```
 */
export function sampleTrack(
  times: Float32Array,
  values: Float32Array,
  width: number,
  time: number,
  interpolation: Interpolation,
  quaternion = false,
  target?: Float32Array,
): Float32Array {
  if (
    target !== undefined &&
    (!(target instanceof Float32Array) ||
      target.length !== width ||
      target.buffer === times.buffer ||
      target.buffer === values.buffer)
  )
    throw new TypeError(
      'Invalid animation sample target; pass a Float32Array of the track width that does not share the times or values buffer',
    );
  return sampleTrackInto(times, values, width, time, interpolation, quaternion, target);
}
/** Same as {@link sampleTrack} without the argument checks on `times`, `values` and `target`: pass a preallocated `out` of `width` numbers to avoid allocating. Defaults: `quaternion` false. */
export function sampleTrackInto(
  times: Float32Array,
  values: Float32Array,
  width: number,
  time: number,
  interpolation: Interpolation,
  quaternion = false,
  out?: Float32Array,
): Float32Array {
  if (
    !times.length ||
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isFinite(time) ||
    (interpolation !== 'STEP' && interpolation !== 'LINEAR' && interpolation !== 'CUBICSPLINE')
  )
    throw invalidTrack();
  const factor = interpolation === 'CUBICSPLINE' ? 3 : 1;
  if (values.length !== times.length * width * factor)
    throw new RangeError(
      'Animation output count mismatch; values needs times.length * width numbers (three times that for CUBICSPLINE)',
    );
  let lo = 0,
    hi = times.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  const a = lo,
    b = Math.min(a + 1, times.length - 1);
  out = out?.length === width && (!quaternion || width === 4) ? out : new Float32Array(width);
  return interpolateKeys(values, width, a, b, times[a], times[b], time, interpolation, quaternion, out);
}

/** A named moment in a clip, in seconds from its start. */
export interface ClipMarker {
  /** Seconds, finite and >= 0. */
  time: number;
  /** What happened, for example `'footstep'`; nonempty. */
  name: string;
  /** Anything the caller wants handed back with the marker. */
  data?: unknown;
}
/** Checks markers and returns a frozen copy sorted by time (stable for equal times). Throws TypeError or RangeError naming the fix. */
export function validateMarkers(markers: readonly ClipMarker[]): readonly ClipMarker[] {
  if (!Array.isArray(markers)) throw new TypeError('Clip markers must be an array of {time, name}');
  for (const m of markers) {
    if (typeof m?.name !== 'string' || !m.name) throw new TypeError('Clip marker needs a nonempty string name');
    if (!Number.isFinite(m.time) || m.time < 0) throw new RangeError('Clip marker time must be a finite number >= 0');
  }
  return Object.freeze(markers.map((m) => Object.freeze({ ...m })).sort((a, b) => a.time - b.time));
}
/**
 * Tracks a play position through a clip and reports the markers it passes. A marker at time m is passed once the
 * position is at or beyond m, so moving forward from a to b reports markers in (a, b], moving back reports (b, a], and
 * going forward then back over the same stretch reports each marker once each way. The first forward move also reports
 * markers at the start position. With `loop`, markers repeat every `duration` seconds, a step longer than the clip
 * reports every lap, and `time` wraps; without it, the position clamps to 0 and `duration`.
 *
 * @example
 * ```ts
 * const steps = new ClipMarkers([{time: 0.25, name: 'footstep'}, {time: 0.75, name: 'footstep'}], 1);
 * steps.advance(0.5).map((m) => m.time); // [0.25]
 * steps.advance(0.5).map((m) => m.time); // [0.75]
 * ```
 */
export class ClipMarkers {
  readonly markers: readonly ClipMarker[];
  /** Clip length in seconds. */
  readonly duration: number;
  private readonly loop: boolean;
  private at = 0;
  private fresh = true;
  /** `markers` are checked and sorted (see {@link validateMarkers}); `duration` is seconds > 0; `loop` defaults to true. */
  constructor(markers: readonly ClipMarker[], duration: number, loop = true) {
    if (!(duration > 0) || !Number.isFinite(duration))
      throw new RangeError('Clip duration must be a finite number > 0 seconds');
    this.markers = validateMarkers(markers);
    this.duration = duration;
    this.loop = loop;
    if (this.markers.some((m) => m.time > duration))
      throw new RangeError('Clip marker time is past the clip duration; move it inside the clip');
  }
  /** Position in seconds inside the clip (wrapped when looping). */
  get time(): number {
    return this.loop ? this.at % this.duration : this.at;
  }
  /** Moves by `delta` seconds (negative plays backward) and returns the markers passed, in order of travel. `out` is cleared and reused when given. */
  advance(delta: number, out: ClipMarker[] = []): ClipMarker[] {
    if (!Number.isFinite(delta)) throw new RangeError('Clip advance needs a finite delta in seconds');
    return this.move(this.at + delta, out);
  }
  /** Jumps to `time` seconds (finite, >= 0). Returns the markers between the old and new position when `fire` is true, none by default. */
  seek(time: number, fire = false, out: ClipMarker[] = []): ClipMarker[] {
    if (!Number.isFinite(time) || time < 0) throw new RangeError('Clip seek needs a finite time >= 0 seconds');
    const hits = this.move(time, out);
    if (!fire) hits.length = 0;
    return hits;
  }
  private move(to: number, out: ClipMarker[]): ClipMarker[] {
    const { duration: d, loop } = this;
    out.length = 0;
    to = loop ? Math.max(to, 0) : Math.min(Math.max(to, 0), d);
    const from = this.at,
      forward = to >= from,
      lo = forward ? from : to,
      hi = forward ? to : from,
      first = loop ? Math.floor(lo / d) : 0,
      last = loop ? Math.floor(hi / d) : 0,
      found: [number, ClipMarker][] = [];
    if ((last - first + 1) * this.markers.length > 65536)
      throw new RangeError('Clip step spans too many laps; use smaller deltas');
    for (let k = first; k <= last; k++)
      for (const m of this.markers) {
        const u = m.time + k * d;
        if (u <= hi && (u > lo || (this.fresh && forward && u === lo))) found.push([u, m]);
      }
    found.sort((x, y) => (forward ? x[0] - y[0] : y[0] - x[0]));
    for (const f of found) out.push(f[1]);
    this.at = to;
    this.fresh = false;
    return out;
  }
}

/** One keyframe track as plain arrays, the shape {@link sampleTrack} takes. */
export interface TrackData {
  times: Float32Array;
  /** `width` numbers per key. */
  values: Float32Array;
  width: number;
  /** `'LINEAR'` or `'STEP'`; CUBICSPLINE tracks are not compressed. */
  interpolation: 'STEP' | 'LINEAR';
  /** Set for rotation tracks (width 4): both sides are normalised and compared along the shortest path. */
  quaternion?: boolean;
}
/** What {@link compressTrack} returns. */
export interface CompressedTrack extends TrackData {
  /** The largest component difference, over every original key time, between the original and the reduced track's sample. Never above `tolerance`. */
  error: number;
}
const gap = (x: Float32Array, y: Float32Array, quaternion: boolean | undefined) => {
  let dot = 0,
    e = 0;
  if (quaternion) for (let c = 0; c < 4; c++) dot += x[c] * y[c];
  const s = dot < 0 ? -1 : 1;
  for (let c = 0; c < x.length; c++) e = Math.max(e, Math.abs(x[c] - s * y[c]));
  return e;
};
const keyOf = (t: TrackData, i: number, out: Float32Array) => {
  for (let c = 0; c < t.width; c++) out[c] = t.values[i * t.width + c];
  return t.quaternion ? normalizeQuaternion(out, out) : out;
};
/**
 * Removes keys a track does not need. Every original key time still samples to within `tolerance` (value units, per
 * component; rotations compare normalised quaternion components) of the original, and `error` reports the real maximum.
 * The first and last keys stay. Linear tracks keep the keys that bend the curve (Douglas-Peucker on the sampled values);
 * step tracks drop keys within `tolerance` of the key held before them. Sampling the result is the same call as before.
 * Use 0 to remove only exact repeats.
 *
 * @example
 * ```ts
 * const times = new Float32Array([0, 1, 2]), values = new Float32Array([0, 5, 10]);
 * compressTrack({times, values, width: 1, interpolation: 'LINEAR'}, 0.001).times; // Float32Array [0, 2]
 * ```
 */
export function compressTrack(track: TrackData, tolerance: number): CompressedTrack {
  const { times, values, width, interpolation, quaternion } = track,
    n = times.length;
  if (!(tolerance >= 0) || !Number.isFinite(tolerance))
    throw new RangeError('Compression tolerance must be a finite number >= 0');
  if (interpolation !== 'LINEAR' && interpolation !== 'STEP')
    throw new TypeError('Only LINEAR and STEP tracks compress; pass interpolation LINEAR or STEP');
  if (n < 1 || values.length !== n * width)
    throw new RangeError('Track needs times and width numbers per key; values.length must be times.length * width');
  const keep = new Uint8Array(n),
    a = new Float32Array(width),
    b = new Float32Array(width),
    pair = { times: new Float32Array(2), values: new Float32Array(2 * width), width, interpolation, quaternion };
  keep[0] = keep[n - 1] = 1;
  if (interpolation === 'STEP') {
    for (let i = 1, held = 0; i < n - 1; i++)
      if (gap(keyOf(track, i, a), keyOf(track, held, b), quaternion) > tolerance) keep[(held = i)] = 1;
  } else {
    const stack = [0, n - 1];
    while (stack.length) {
      const hi = stack.pop()!,
        lo = stack.pop()!;
      let split = -1,
        worst = tolerance;
      pair.times[0] = times[lo];
      pair.times[1] = times[hi];
      pair.values.set(values.subarray(lo * width, lo * width + width), 0);
      pair.values.set(values.subarray(hi * width, hi * width + width), width);
      for (let i = lo + 1; i < hi; i++) {
        const e = gap(
          sampleTrackInto(pair.times, pair.values, width, times[i], 'LINEAR', quaternion, a),
          keyOf(track, i, b),
          quaternion,
        );
        if (e > worst) (worst = e), (split = i);
      }
      if (split >= 0) (keep[split] = 1), stack.push(lo, split, split, hi);
    }
  }
  const kept = keep.reduce((s, k) => s + k, 0),
    out: CompressedTrack = {
      times: new Float32Array(kept),
      values: new Float32Array(kept * width),
      width,
      interpolation,
      ...(quaternion ? { quaternion } : {}),
      error: 0,
    };
  for (let i = 0, j = 0; i < n; i++)
    if (keep[i]) {
      out.times[j] = times[i];
      out.values.set(values.subarray(i * width, i * width + width), j++ * width);
    }
  for (let i = 0; i < n; i++)
    out.error = Math.max(
      out.error,
      gap(
        sampleTrackInto(out.times, out.values, width, times[i], interpolation, quaternion, a),
        keyOf(track, i, b),
        quaternion,
      ),
    );
  return out;
}

/** A track with its values as 16-bit integers: component c of a key is `min[c] + data[i] * step[c]`. */
export interface QuantizedTrack extends Omit<TrackData, 'values'> {
  data: Uint16Array;
  /** Per component: the smallest value in the track. */
  min: Float32Array;
  /** Per component: (largest - smallest) / 65535, 0 for a constant component. */
  step: Float32Array;
}
/**
 * Stores a track's values as 16-bit integers between each component's smallest and largest value: half the bytes of
 * Float32 values, and no component is off by more than half a `step` (range / 131070) plus Float32 rounding. Times stay
 * Float32. Undo with {@link dequantizeTrack}.
 *
 * @example
 * ```ts
 * const times = new Float32Array([0, 1]), values = new Float32Array([-1, 3]);
 * const q = quantizeTrack({times, values, width: 1, interpolation: 'LINEAR'}); // q.data Uint16Array [0, 65535]
 * dequantizeTrack(q).values; // Float32Array [-1, 3]
 * ```
 */
export function quantizeTrack(track: TrackData): QuantizedTrack {
  const { values, width } = track,
    min = new Float32Array(width).fill(Infinity),
    max = new Float32Array(width).fill(-Infinity),
    step = new Float32Array(width),
    data = new Uint16Array(values.length);
  if (!values.length || values.length !== track.times.length * width)
    throw new RangeError('Track needs times and width numbers per key; values.length must be times.length * width');
  for (let i = 0; i < values.length; i++) {
    const v = values[i],
      c = i % width;
    if (!Number.isFinite(v)) throw new RangeError('Track values must be finite to quantise');
    if (v < min[c]) min[c] = v;
    if (v > max[c]) max[c] = v;
  }
  for (let c = 0; c < width; c++) step[c] = (max[c] - min[c]) / 65535;
  for (let i = 0; i < values.length; i++) {
    const c = i % width;
    data[i] = step[c] ? Math.round((values[i] - min[c]) / step[c]) : 0;
  }
  const { values: _, ...rest } = track;
  return { ...rest, data, min, step };
}
/** Rebuilds the Float32 track from a {@link QuantizedTrack}. */
export function dequantizeTrack(q: QuantizedTrack): TrackData {
  const { data, min, step, ...rest } = q,
    values = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) values[i] = min[i % q.width] + data[i] * step[i % q.width];
  return { ...rest, values };
}
