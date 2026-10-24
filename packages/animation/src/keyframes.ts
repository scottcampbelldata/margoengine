import type { PBRModel } from '@margoengine/gltf-pro';
import { normalizeQuaternion } from '@margoengine/math/quat';
import { finite, Skeleton } from './skin.js';

const rotation = [0, 0, 0, 0]; // normalizeQuaternion scratch

/** How a key moves to the next key: hold then jump, straight, or a cubic ease in, out, or in and out. */
export type KeyInterpolation = 'discrete' | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
/**
 * The arithmetic {@link sampleKeyframes} blends two keys with, at eased factor f between key values a and b.
 * - `'delta'` (the default): `a + (b - a) * f`. f = 0 still computes; when b - a overflows (keys near ±1.8e308 of
 *   opposite sign) the sample is NaN.
 * - `'weighted'`: a held sample (f = 0 or 1, including before the first key, after the last and through discrete
 *   segments) copies the key's value before any arithmetic; between keys translation and scale are
 *   `(1 - f) * a + f * b`, which stays finite for all finite keys. Rotations slerp as in `'delta'`.
 */
export type KeyframeBlend = 'delta' | 'weighted';
/** The property a keyframe track animates: a bone's or node's transform, or a mesh node's morph target weights. */
export type KeyframePath = 'translation' | 'rotation' | 'scale' | 'weights';
/** One key of a keyframe track. */
export interface Keyframe {
  /** Seconds, >= 0, strictly increasing within a track. */
  time: number;
  /**
   * [x, y, z] for translation and scale, a quaternion [x, y, z, w] for rotation (normalised on input), and one weight
   * per morph target for weights (the same count in every key, not normalised).
   */
  value: readonly number[];
  /** Shapes the time from this key to the next one (rotations slerp by the eased factor). Default 'linear'. */
  interpolation?: KeyInterpolation;
}
/** Keys for one property of one bone or node. */
export interface KeyframeTrackData {
  /** Stable id of the animated bone (its name) or of the caller's own node; for weights, the mesh node's name. */
  target: string;
  path: KeyframePath;
  keys: readonly Keyframe[];
  /** How samples between and at keys are computed; default `'delta'`. See {@link KeyframeBlend}. */
  blend?: KeyframeBlend;
}
/** Raw clip input for {@link createKeyframeClip}. */
export interface KeyframeClipData {
  name?: string;
  tracks: readonly KeyframeTrackData[];
}
/** A validated track: key times, 3 or 4 values per key (weights: one per morph target), and each key's interpolation. */
export interface KeyframeTrack {
  readonly target: string;
  readonly path: KeyframePath;
  readonly times: Float64Array;
  readonly values: Float64Array;
  readonly interpolations: readonly KeyInterpolation[];
  /** Set when the track data chose a blend; undefined means `'delta'`. */
  readonly blend?: KeyframeBlend;
}
/** A validated clip; `duration` is its last key time. */
export interface KeyframeClip {
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly KeyframeTrack[];
}
/** One glTF animation channel from {@link bakeKeyframeClip}: the shape of exporters' `AnimationChannelData`. */
export interface BakedChannel<N> {
  node: N;
  path: KeyframePath;
  interpolation: 'STEP' | 'LINEAR';
  times: Float32Array;
  values: Float32Array;
}

const kinds: readonly KeyInterpolation[] = ['discrete', 'linear', 'easeIn', 'easeOut', 'easeInOut'];
const ease = (kind: KeyInterpolation, u: number): number =>
  kind === 'discrete'
    ? 0
    : kind === 'easeIn'
      ? u * u * u
      : kind === 'easeOut'
        ? 1 - (1 - u) ** 3
        : kind === 'easeInOut'
          ? u < 0.5
            ? 4 * u * u * u
            : 1 - (2 - 2 * u) ** 3 / 2
          : u;

/** Validates raw keys into a clip. Throws TypeError for bad shapes or a repeated target+path, RangeError for bad numbers. */
export function createKeyframeClip(data: KeyframeClipData): KeyframeClip {
  if (!data || !Array.isArray(data.tracks)) throw new TypeError('Keyframe clip needs a tracks array');
  if (data.name !== undefined && typeof data.name !== 'string')
    throw new TypeError('Keyframe clip name must be a string');
  const seen = new Set<string>();
  const tracks = data.tracks.map((track, t): KeyframeTrack => {
    const label = `Keyframe track ${t}`;
    if (!track || typeof track.target !== 'string' || !track.target)
      throw new TypeError(`${label} needs a nonempty string target`);
    const { target, path, keys, blend } = track;
    if (path !== 'translation' && path !== 'rotation' && path !== 'scale' && path !== 'weights')
      throw new TypeError(`${label} path ${path} is invalid; use translation, rotation, scale or weights`);
    if (blend !== undefined && blend !== 'delta' && blend !== 'weighted')
      throw new TypeError(`${label} blend ${blend} is invalid; use delta or weighted`);
    if (seen.has(target + ':' + path)) throw new TypeError(`${label} repeats ${target} ${path}; merge the keys`);
    seen.add(target + ':' + path);
    if (!Array.isArray(keys) || !keys.length) throw new TypeError(`${label} needs a nonempty keys array`);
    // A weights track is as wide as its first key; every key must match it.
    const width = path === 'rotation' ? 4 : path === 'weights' ? Number(keys[0]?.value?.length) : 3;
    if (!(Number.isInteger(width) && width > 0))
      throw new TypeError(`${label} weights keys need one number per morph target; pass a nonempty array`);
    const times = new Float64Array(keys.length),
      values = new Float64Array(keys.length * width);
    const interpolations = keys.map((key, k) => {
      const time = key?.time,
        interpolation = key?.interpolation ?? 'linear';
      if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || (k > 0 && time <= times[k - 1]))
        throw new RangeError(`${label} key ${k} time ${time} is invalid; use increasing seconds >= 0`);
      if (!kinds.includes(interpolation))
        throw new TypeError(
          `${label} key ${k} interpolation ${interpolation} is invalid; use one of ${kinds.join(', ')}`,
        );
      const value = finite(key.value, width, `${label} key ${k} value`);
      if (path !== 'rotation') values.set(value, k * width);
      else if (!(value[0] || value[1] || value[2] || value[3]))
        throw new RangeError(`${label} key ${k} is a zero quaternion; pass a unit quaternion`);
      else values.set(normalizeQuaternion(value, rotation), k * width);
      times[k] = time;
      return interpolation;
    });
    return blend === undefined
      ? { target, path, times, values, interpolations }
      : { target, path, times, values, interpolations, blend };
  });
  return {
    name: data.name ?? '',
    duration: Math.max(0, ...tracks.map((track) => track.times[track.times.length - 1])),
    tracks,
  };
}

/**
 * A track's value at `time` seconds: the first key's before it, the last key's after it, else the two surrounding keys
 * blended by the earlier key's interpolation (rotations by shortest-path slerp) with the track's
 * {@link KeyframeBlend} arithmetic. Deterministic for any frame rate.
 */
export function sampleKeyframes(track: KeyframeTrack, time: number, out?: Float64Array): Float64Array {
  if (typeof time !== 'number' || !Number.isFinite(time))
    throw new RangeError(`Keyframe sample time ${time} is invalid; pass finite seconds`);
  const { times, values } = track,
    linear = track.path !== 'rotation',
    width = linear ? values.length / times.length : 4,
    last = times.length - 1;
  if (out !== undefined && !(out instanceof Float64Array && out.length >= width))
    throw new TypeError(`Keyframe sample target must be a Float64Array of at least ${width} numbers`);
  out ??= new Float64Array(width);
  let a = 0;
  if (time >= times[last]) a = last;
  else if (time > times[0])
    for (let hi = last; a + 1 < hi; ) {
      const mid = (a + hi) >> 1;
      if (times[mid] <= time) a = mid;
      else hi = mid;
    }
  const f =
    a === last || time <= times[a] ? 0 : ease(track.interpolations[a], (time - times[a]) / (times[a + 1] - times[a]));
  const i = a * width,
    j = Math.min(a + 1, last) * width;
  if (track.blend === 'weighted') {
    if (f === 0 || f === 1) {
      out.set(values.subarray(f ? j : i, (f ? j : i) + width));
      return out;
    }
    if (linear) {
      for (let c = 0; c < width; c++) {
        const p = values[i + c],
          q = values[j + c],
          v = (1 - f) * p + f * q;
        // Only a rounding step past ±Number.MAX_VALUE overflows; the exact value lies between p and q.
        out[c] = Number.isFinite(v) ? v : v > 0 ? Math.max(p, q) : Math.min(p, q);
      }
      return out;
    }
  } else if (linear || f === 0 || f === 1) {
    for (let c = 0; c < width; c++)
      out[c] = f === 1 ? values[j + c] : values[i + c] + (values[j + c] - values[i + c]) * f;
    return out;
  }
  let dot = 0;
  for (let c = 0; c < 4; c++) dot += values[i + c] * values[j + c];
  const sign = dot < 0 ? -1 : 1,
    angle = Math.acos(Math.min(1, Math.abs(dot))),
    s = Math.sin(angle),
    x = s > 1e-6 ? Math.sin((1 - f) * angle) / s : 1 - f,
    y = (s > 1e-6 ? Math.sin(f * angle) / s : f) * sign;
  for (let c = 0; c < 4; c++) out[c] = values[i + c] * x + values[j + c] * y;
  return normalizeQuaternion(out, out);
}

/**
 * What {@link applyKeyframeClip} drives on a glTF-pro model: an `Animation` (`Animation.attach(model)`) fits, so morph
 * weights go through its `setMorph`.
 */
export interface KeyframeModelTarget {
  readonly model: PBRModel;
  setMorph(node: number, target: number, weight: number): void;
}

/**
 * Poses `target` at `time`. On a `Skeleton`, every translation, rotation or scale track whose target names one of its
 * bones sets that bone's property (weights tracks are skipped: bones have no morphs). On a glTF-pro model's
 * `Animation`, tracks name model nodes (the first node with that name): transform tracks set the node's local
 * transform and weights tracks set every morph weight through `setMorph`. Pause the Animation's own clip
 * (`animation.playing = false`) while a code clip drives the model, or the two overwrite each other.
 */
export function applyKeyframeClip(clip: KeyframeClip, target: Skeleton | KeyframeModelTarget, time: number): void {
  if (target instanceof Skeleton) {
    for (const track of clip.tracks) {
      const bone = track.path === 'weights' ? -1 : target.index(track.target);
      if (bone >= 0) target.setPose(bone, { [track.path]: sampleKeyframes(track, time) });
    }
    return;
  }
  if (!target || typeof target.setMorph !== 'function' || !Array.isArray(target.model?.nodes))
    throw new TypeError(
      'applyKeyframeClip needs a Skeleton or an Animation; pass a skeleton or Animation.attach(model)',
    );
  const { nodes, primitives } = target.model;
  for (const track of clip.tracks) {
    const index = nodes.findIndex((node) => node.name === track.target);
    if (index < 0) continue;
    const value = sampleKeyframes(track, time),
      node = nodes[index];
    if (track.path === 'weights') {
      const count = primitives.find((p) => p.nodeIndex === index)?.weights.length ?? 0;
      if (count !== value.length)
        throw new RangeError(
          `Keyframe track ${track.target} weights has ${value.length} values but the node has ${count} morph targets; key one weight per target`,
        );
      for (let k = 0; k < count; k++) target.setMorph(index, k, value[k]);
    } else if (track.path === 'translation') node.setPosition(value as unknown as [number, number, number]);
    else if (track.path === 'scale') node.setScale(value as unknown as [number, number, number]);
    else node.setQuaternion(value as unknown as number[]);
  }
}

/**
 * Clip time for a segment that has run `elapsed` seconds: scaled by `timeScale` (negative plays from the end in
 * reverse), wrapped by `loop`, else held at the ends of `[0, duration]`.
 */
export function segmentTime(
  elapsed: number,
  duration: number,
  { loop = false, timeScale = 1 }: { loop?: boolean; timeScale?: number } = {},
): number {
  if (![elapsed, duration, timeScale].every(Number.isFinite) || elapsed < 0 || duration < 0)
    throw new RangeError('Segment time needs finite elapsed and duration >= 0 and a finite timeScale');
  const t = elapsed * Math.abs(timeScale),
    local = loop && duration > 0 ? t % duration : Math.min(t, duration);
  return timeScale < 0 ? duration - local : local;
}

/** The largest Float32 below a positive Float32 time. */
function before(time: number): number {
  const below = new Float32Array([time]);
  new Uint32Array(below.buffer)[0]--;
  return below[0];
}
/**
 * glTF samplers for a clip, ready for exporters' `AnimationData` (`{name, channels}`) once `resolve` maps each track
 * target to its `ExportNode`; tracks it maps to undefined are left out. A track of only discrete keys becomes STEP at
 * its keys and one of only linear keys becomes LINEAR at its keys, both exact everywhere; any other track is LINEAR at
 * its keys plus every `1 / fps` second inside eased segments, exact at those times, and a discrete segment inside it
 * holds until one Float32 step before the next key.
 */
export function bakeKeyframeClip<N>(
  clip: KeyframeClip,
  fps: number,
  resolve: (target: string) => N | undefined,
): { name: string; channels: BakedChannel<N>[] } {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0)
    throw new RangeError(`Keyframe bake fps ${fps} is invalid; pass frames per second > 0`);
  if (typeof resolve !== 'function') throw new TypeError('Keyframe bake needs a resolve(target) function');
  const channels: BakedChannel<N>[] = [];
  for (const track of clip.tracks) {
    const node = resolve(track.target);
    if (node === undefined) continue;
    const { times: keys, interpolations } = track,
      used = new Set(interpolations.slice(0, -1)),
      plain = used.size === 0 || (used.size === 1 && (used.has('discrete') || used.has('linear'))),
      times: number[] = [],
      values: number[] = [],
      add = (time: number, from = time) => {
        const stored = Math.fround(time);
        if (times.length && stored <= times[times.length - 1]) return false;
        times.push(stored);
        values.push(...sampleKeyframes(track, from));
        return true;
      };
    for (let k = 0; k < keys.length; k++) {
      if (!add(keys[k]))
        throw new RangeError(
          `Keyframe track ${track.target} ${track.path} keys are closer than Float32 time precision`,
        );
      if (plain || k === keys.length - 1 || interpolations[k] === 'linear') continue;
      const end = Math.fround(keys[k + 1]);
      if (interpolations[k] === 'discrete') add(before(end), keys[k]);
      else
        for (let n = Math.floor(keys[k] * fps) + 1; n / fps < keys[k + 1]; n++)
          if (Math.fround(n / fps) < end) add(n / fps, Math.fround(n / fps));
    }
    if (track.path === 'rotation')
      for (let i = 4; i < values.length; i += 4)
        if (
          values[i] * values[i - 4] +
            values[i + 1] * values[i - 3] +
            values[i + 2] * values[i - 2] +
            values[i + 3] * values[i - 1] <
          0
        )
          for (let c = 0; c < 4; c++) values[i + c] = -values[i + c];
    channels.push({
      node,
      path: track.path,
      interpolation: plain && used.has('discrete') ? 'STEP' : 'LINEAR',
      times: Float32Array.from(times),
      values: Float32Array.from(values),
    });
  }
  return { name: clip.name, channels };
}
