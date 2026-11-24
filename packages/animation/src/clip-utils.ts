// Clip editing: cut a time range into a new clip, and turn a clip into an additive one against a reference pose.
import { interpolateQuaternions, multiplyQuaternions } from '@margoengine/math/quat';
import {
  createKeyframeClip,
  sampleKeyframes,
  type Keyframe,
  type KeyframeClip,
  type KeyframeTrack,
  type KeyframeTrackData,
  type KeyInterpolation,
  type PropertyKeyframeTrack,
  type PropertyTrackData,
} from './keyframes.js';
import type { Skeleton } from './skin.js';

/** Options for {@link subclip}. */
export interface SubclipOptions {
  /** Name of the new clip. Default the source's name. */
  name?: string;
  /** Keys per second where a cut lands inside an eased or cubic segment, whose curve cannot be cut at one key. Default 60. */
  fps?: number;
}
/** The reference pose for {@link makeAdditive}. */
export interface AdditiveReference {
  /** The clip holding the reference pose, with a track for every track being converted. Default the clip itself. */
  clip?: KeyframeClip;
  /** Seconds into the reference clip. Default 0. */
  time?: number;
  /** Name of the new clip. Default the source's name plus ` (additive)`. */
  name?: string;
}

type AnyTrack = KeyframeTrack | PropertyKeyframeTrack;
const widthOf = (track: AnyTrack) => track.values.length / track.times.length;
const curved = (kind: KeyInterpolation) => kind !== 'linear' && kind !== 'discrete';

/** The keys of `track` from `start` to `end`, re-timed to start at 0. */
function cut(track: AnyTrack, start: number, end: number, fps: number): Keyframe[] {
  const { times, values, interpolations, tangents } = track,
    width = widthOf(track),
    last = times.length - 1,
    keys: Keyframe[] = [];
  const sample = (time: number, interpolation: KeyInterpolation) =>
    keys.push({ time: time - start, value: Array.from(sampleKeyframes(track, time).subarray(0, width)), interpolation });
  const copy = (k: number, interpolation = interpolations[k]) => {
    const key: Keyframe = {
      time: times[k] - start,
      value: Array.from(values.subarray(k * width, (k + 1) * width)),
      interpolation,
    };
    if (tangents) {
      const at = k * width * 2;
      key.inTangent = Array.from(tangents.subarray(at, at + width));
      key.outTangent = Array.from(tangents.subarray(at + width, at + width * 2));
    }
    keys.push(key);
  };
  let k = -1;
  while (k < last && times[k + 1] <= start) k++;
  let cursor = start;
  while (cursor < end) {
    const next = k < last ? times[k + 1] : Infinity,
      stop = Math.min(next, end),
      onKey = k >= 0 && times[k] === cursor,
      kind = k >= 0 ? interpolations[k] : 'linear',
      partial = k >= 0 && k < last && curved(kind) && !(onKey && next <= end);
    if (partial) {
      // Part of a curved segment: its shape belongs to the whole segment, so carry it as short straight keys. A key that
      // starts one keeps its in tangent, which the segment before it may end on.
      if (onKey) copy(k, 'linear');
      else sample(cursor, 'linear');
      const steps = Math.max(1, Math.ceil((stop - cursor) * fps));
      for (let i = 1; i < steps; i++) sample(cursor + ((stop - cursor) * i) / steps, 'linear');
    } else if (onKey) copy(k);
    else sample(cursor, curved(kind) ? 'linear' : kind);
    cursor = stop;
    if (cursor === next) k++;
  }
  if (k >= 0 && times[k] === end) copy(k);
  else sample(end, 'linear');
  return keys;
}

/**
 * A new clip holding `start` to `end` seconds of `clip`, re-timed to start at 0: both ends are sampled, so the cut plays
 * exactly as the source did there. Keys and their interpolation are kept; only a curved segment the cut passes through
 * becomes short straight keys at `fps`. Markers in the range come along, and property tracks stay bound to their targets.
 *
 * @example
 * ```ts
 * const stride = subclip(walk, 0.5, 1.5, {name: 'Stride'});
 * ```
 */
export function subclip(
  clip: KeyframeClip,
  start: number,
  end: number,
  { name = clip.name, fps = 60 }: SubclipOptions = {},
): KeyframeClip {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > clip.duration)
    throw new RangeError(`Subclip range ${start} to ${end} is invalid; use 0 <= start < end <= ${clip.duration}`);
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError('Subclip fps must be a finite number > 0');
  const tracks: (KeyframeTrackData | PropertyTrackData)[] = clip.tracks.map((track) => ({
    target: track.target,
    path: track.path,
    keys: cut(track, start, end, fps),
    ...(track.blend ? { blend: track.blend } : {}),
  }));
  for (const track of clip.properties ?? [])
    tracks.push({
      target: track.target,
      type: track.type,
      name: track.name,
      keys: cut(track, start, end, fps),
      ...(track.blend ? { blend: track.blend } : {}),
      ...(track.property !== undefined
        ? { property: track.property }
        : { get: () => track.read(), set: (value) => track.write(value) }),
    });
  return createKeyframeClip({
    name,
    tracks,
    markers: (clip.markers ?? [])
      .filter((marker) => marker.time >= start && marker.time <= end)
      .map((marker) => ({ ...marker, time: marker.time - start })),
  });
}

/** {@link subclip} by frame numbers at `frameRate` frames per second, `first` and `last` included. */
export function subclipFrames(
  clip: KeyframeClip,
  first: number,
  last: number,
  frameRate = 30,
  options?: SubclipOptions,
): KeyframeClip {
  if (!Number.isInteger(first) || !Number.isInteger(last) || !Number.isFinite(frameRate) || frameRate <= 0)
    throw new RangeError('Subclip frames must be integers and the frame rate a finite number > 0');
  return subclip(clip, first / frameRate, last / frameRate, options);
}

/**
 * A clip of differences from a reference pose: translation and weights subtract it, scale divides by it (a zero
 * reference axis gives 1) and rotation is `inverse(reference) * rotation`, the sums `@margoengine/animator` additive
 * layers use. Every key keeps its time and interpolation, so the result is exact between keys too. Property tracks are
 * left out: a difference means nothing to them. Play the result over a base pose with {@link applyAdditiveClip}.
 *
 * @example
 * ```ts
 * const nod = makeAdditive(headNod); // against the clip's first frame
 * const lean = makeAdditive(leanClip, {clip: idle, time: 0.5}); // against a frame of another clip
 * ```
 */
export function makeAdditive(clip: KeyframeClip, reference: AdditiveReference = {}): KeyframeClip {
  const { clip: from = clip, time = 0, name = clip.name + ' (additive)' } = reference;
  if (!Number.isFinite(time) || time < 0) throw new RangeError('Additive reference time must be finite and >= 0');
  const tracks = clip.tracks.map((track) => {
    const source = from.tracks.find((t) => t.target === track.target && t.path === track.path);
    if (!source)
      throw new RangeError(
        `Additive reference has no ${track.path} track for ${track.target}; use a reference clip that animates it`,
      );
    const base = sampleKeyframes(source, time),
      width = widthOf(track),
      inverse = track.path === 'rotation' ? [-base[0], -base[1], -base[2], base[3]] : undefined;
    if (track.path === 'weights' && base.length !== width)
      throw new RangeError(
        `Additive reference for ${track.target} has a different morph target count; use a reference clip of the same model`,
      );
    // Each is linear in the key, so tangents follow the same sum (without the offset, for translation and weights).
    const delta = (value: ArrayLike<number>, tangent: boolean): number[] => {
      if (inverse) return Array.from(multiplyQuaternions(inverse, value));
      return Array.from(value, (v, c) =>
        track.path === 'scale' ? (base[c] === 0 ? (tangent ? 0 : 1) : v / base[c]) : tangent ? v : v - base[c],
      );
    };
    const keys: Keyframe[] = Array.from(track.times, (keyTime, k) => {
      const key: Keyframe = {
        time: keyTime,
        value: delta(track.values.subarray(k * width, (k + 1) * width), false),
        interpolation: track.interpolations[k],
      };
      if (track.tangents) {
        const at = k * width * 2;
        key.inTangent = delta(track.tangents.subarray(at, at + width), true);
        key.outTangent = delta(track.tangents.subarray(at + width, at + width * 2), true);
      }
      return key;
    });
    return { target: track.target, path: track.path, keys, ...(track.blend ? { blend: track.blend } : {}) };
  });
  return createKeyframeClip({ name, tracks, markers: clip.markers ?? [] });
}

/**
 * Adds an additive clip from {@link makeAdditive} onto a skeleton's current pose at `time`, by `weight` (default 1). Pose
 * the base first each frame: the additive adds to whatever is there, so applying it twice adds twice. Tracks naming no
 * bone, and weights tracks, are skipped.
 */
export function applyAdditiveClip(clip: KeyframeClip, skeleton: Skeleton, time: number, weight = 1): void {
  if (!Number.isFinite(weight) || weight < 0) throw new RangeError('Additive weight must be finite and >= 0');
  for (const track of clip.tracks) {
    if (track.path === 'weights' || !skeleton.names.includes(track.target)) continue;
    const bone = skeleton.index(track.target),
      pose = skeleton.getPose(bone),
      value = sampleKeyframes(track, time);
    if (track.path === 'translation')
      skeleton.setPose(bone, { translation: pose.translation.map((v, c) => v + value[c] * weight) as typeof pose.translation });
    else if (track.path === 'scale')
      skeleton.setPose(bone, { scale: pose.scale.map((v, c) => v * (1 + (value[c] - 1) * weight)) as typeof pose.scale });
    else {
      const turn = interpolateQuaternions([0, 0, 0, 1], value, weight, 0.9995);
      skeleton.setPose(bone, { rotation: Array.from(multiplyQuaternions(pose.rotation, turn)) as typeof pose.rotation });
    }
  }
}
