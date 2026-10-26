import type { PBRModel } from '@margoengine/gltf-pro';
import { normalizeQuaternion } from '@margoengine/math/quat';
import { finite, Skeleton } from './skin.js';

const rotation = [0, 0, 0, 0]; // normalizeQuaternion scratch

/**
 * How a key moves to the next key: hold then jump, straight, a cubic ease in, out, or in and out, or `'cubicSpline'`: a
 * Hermite spline through both keys with this key's `outTangent` and the next key's `inTangent` (glTF CUBICSPLINE).
 */
export type KeyInterpolation = 'discrete' | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'cubicSpline';
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
  /**
   * For `'cubicSpline'` segments: the slope arriving at this key, in value units per second, one number per value
   * component (default zeros). Read when the previous key is `'cubicSpline'`.
   */
  inTangent?: readonly number[];
  /** For a `'cubicSpline'` key: the slope leaving this key, in value units per second (default zeros). */
  outTangent?: readonly number[];
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
/**
 * What a {@link PropertyTrackData} value means: `'number'` (one number), `'vector'` (2 to 4 numbers blended per
 * component), `'color'` (linear RGB or RGBA, blended per component in linear space; convert sRGB keys first) or
 * `'quaternion'` ([x, y, z, w], normalised on input and slerped like rotations).
 */
export type PropertyValueType = 'number' | 'vector' | 'color' | 'quaternion';
/**
 * Keys for any numeric, vector, colour or quaternion property of any object. Name the property with `property`, a dot
 * path from `target` (`'material.roughness'`, `'position'`, `'lights.0.color'`), or pass `set` (and optionally
 * `get`) accessors. A path is resolved once, when the clip is created, to a setter: a number property is assigned; a
 * boolean property gets `value >= 0.5`; an array or typed array (a material's live colour) is written in place, or
 * assigned when its getter returns a new array on every read; an `{x, y, z, w}` or `{r, g, b, a}` object (a mesh's
 * `position`) is written field by field, through its `set(x, y, z)` when it has one. Replacing an object along the path
 * later leaves the track driving the old one: create the clip again.
 */
export interface PropertyTrackData {
  /** The object the property path starts from; with `set`, any value the accessors close over (used in labels). */
  target: object;
  /** Dot path from `target` to the property. Leave it out when passing `set`. */
  property?: string;
  /** Reads the current value (a number or 1-4 numbers), for {@link PropertyKeyframeTrack.read}. */
  get?: () => number | ArrayLike<number>;
  /** Writes a sampled value; the array is reused between calls, so copy it to keep it. */
  set?: (value: Float64Array) => void;
  /** Value type; default `'number'` for one-number keys and `'vector'` for longer ones. */
  type?: PropertyValueType;
  /** Label for errors and duplicate checks; default the property path, or `'set'`. */
  name?: string;
  /** 1 to 4 numbers per key (4 for quaternions, 3 or 4 for colours), the same count in every key. */
  keys: readonly Keyframe[];
  /** How samples between and at keys are computed; default `'delta'`. See {@link KeyframeBlend}. */
  blend?: KeyframeBlend;
}
/** Raw clip input for {@link createKeyframeClip}: transform and weights tracks, and property tracks. */
export interface KeyframeClipData {
  name?: string;
  tracks: readonly (KeyframeTrackData | PropertyTrackData)[];
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
  /** Set when a key is `'cubicSpline'`: per key, its in tangent then its out tangent (2 x width numbers). */
  readonly tangents?: Float64Array;
}
/** A validated property track: keys as on {@link KeyframeTrack} plus the binding its path or accessors resolved to. */
export interface PropertyKeyframeTrack {
  readonly target: object;
  /** The dot path, or undefined for an accessor track. */
  readonly property?: string;
  /** The label used in errors: the data's `name`, else the path, else `'set'`. */
  readonly name: string;
  readonly type: PropertyValueType;
  /** Numbers per key, 1 to 4. */
  readonly size: number;
  readonly times: Float64Array;
  readonly values: Float64Array;
  readonly interpolations: readonly KeyInterpolation[];
  readonly blend?: KeyframeBlend;
  readonly tangents?: Float64Array;
  /** Writes `size` numbers through the resolved binding (what {@link applyKeyframeClip} calls per frame). */
  write(value: ArrayLike<number>): void;
  /** The property's current value; throws TypeError for an accessor track without `get`. */
  read(out?: Float64Array): Float64Array;
}
/** A validated clip; `duration` is its last key time. */
export interface KeyframeClip {
  readonly name: string;
  readonly duration: number;
  readonly tracks: readonly KeyframeTrack[];
  /** Property tracks, in data order (absent on clips built by hand before property tracks existed). */
  readonly properties?: readonly PropertyKeyframeTrack[];
}
/** One glTF animation channel from {@link bakeKeyframeClip}: the shape of exporters' `AnimationChannelData`. */
export interface BakedChannel<N> {
  node: N;
  path: KeyframePath;
  interpolation: 'STEP' | 'LINEAR';
  times: Float32Array;
  values: Float32Array;
}

const kinds: readonly KeyInterpolation[] = ['discrete', 'linear', 'easeIn', 'easeOut', 'easeInOut', 'cubicSpline'];
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

interface ParsedKeys {
  times: Float64Array;
  values: Float64Array;
  interpolations: KeyInterpolation[];
  tangents?: Float64Array;
}
function parseKeys(label: string, keys: readonly Keyframe[], width: number, quaternion: boolean): ParsedKeys {
  const times = new Float64Array(keys.length),
    values = new Float64Array(keys.length * width),
    cubic = keys.some((key) => key?.interpolation === 'cubicSpline'),
    tangents = cubic ? new Float64Array(keys.length * width * 2) : undefined;
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
    if (!quaternion) values.set(value, k * width);
    else if (!(value[0] || value[1] || value[2] || value[3]))
      throw new RangeError(`${label} key ${k} is a zero quaternion; pass a unit quaternion`);
    else values.set(normalizeQuaternion(value, rotation), k * width);
    if (tangents) {
      if (key.inTangent !== undefined)
        tangents.set(finite(key.inTangent, width, `${label} key ${k} inTangent`), k * width * 2);
      if (key.outTangent !== undefined)
        tangents.set(finite(key.outTangent, width, `${label} key ${k} outTangent`), k * width * 2 + width);
    }
    times[k] = time;
    return interpolation;
  });
  return tangents ? { times, values, interpolations, tangents } : { times, values, interpolations };
}
const vectorFields = ['x', 'y', 'z', 'w'],
  colorFields = ['r', 'g', 'b', 'a'];
const numeric = (value: unknown): value is ArrayLike<number> =>
  Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
/** Resolves a dot path on `target` once into a writer for `size` numbers. */
function bindPath(target: object, path: string, size: number, label: string): (value: ArrayLike<number>) => void {
  const parts = path.split('.');
  if (parts.some((part) => !part))
    throw new TypeError(`${label} property path '${path}' has an empty segment; use names joined by dots`);
  let parent = target as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = parent[parts[i]];
    if (!next || typeof next !== 'object')
      throw new RangeError(
        `${label} property path '${path}' stops at '${parts.slice(0, i + 1).join('.')}', which is ${next === null ? 'null' : typeof next}; check the path names an object`,
      );
    parent = next as Record<string, unknown>;
  }
  const key = parts[parts.length - 1];
  if (!(key in parent))
    throw new RangeError(`${label} property path '${path}' has no '${key}' on its object; check the spelling`);
  const current = parent[key],
    wrong = (what: string) =>
      new TypeError(
        `${label} property '${path}' ${what}, which ${size} number${size > 1 ? 's' : ''} per key cannot drive; key a matching size or pass set`,
      );
  if (typeof current === 'number' || typeof current === 'boolean') {
    if (size !== 1) throw wrong(`is a ${typeof current}`);
    return typeof current === 'number'
      ? (value) => (parent[key] = value[0])
      : (value) => (parent[key] = value[0] >= 0.5);
  }
  if (numeric(current)) {
    if (current.length < size) throw wrong(`holds ${current.length} numbers`);
    if (parent[key] !== current) {
      // A getter that copies on every read: assign a reused array instead (such setters copy their input).
      const scratch = new Array<number>(size).fill(0);
      return (value) => {
        for (let c = 0; c < size; c++) scratch[c] = value[c];
        parent[key] = scratch;
      };
    }
    const array = current as unknown as Record<number, number>;
    return (value) => {
      for (let c = 0; c < size; c++) array[c] = value[c];
    };
  }
  if (current && typeof current === 'object') {
    const object = current as Record<string, unknown>,
      fields = typeof object.r === 'number' ? colorFields : vectorFields;
    for (let c = 0; c < size; c++)
      if (typeof object[fields[c]] !== 'number') throw wrong(`has no number field '${fields[c]}'`);
    if (size === 3 && fields === vectorFields && typeof object.set === 'function') {
      const set = object.set as (x: number, y: number, z: number) => unknown;
      return (value) => set.call(object, value[0], value[1], value[2]);
    }
    return (value) => {
      for (let c = 0; c < size; c++) object[fields[c]] = value[c];
    };
  }
  throw wrong(`is ${current === null ? 'null' : typeof current}, not a number, array or vector object`);
}
function readValue(value: unknown, size: number, out: Float64Array): Float64Array {
  if (typeof value === 'number' || typeof value === 'boolean') out[0] = +value;
  else if (numeric(value)) for (let c = 0; c < size; c++) out[c] = value[c];
  else {
    const object = value as Record<string, number>,
      fields = typeof object?.r === 'number' ? colorFields : vectorFields;
    for (let c = 0; c < size; c++) out[c] = object?.[fields[c]];
  }
  return out;
}
const scratches = [1, 2, 3, 4].map((n) => new Float64Array(n));
const valueSizes: Record<PropertyValueType, number[]> = {
  number: [1],
  vector: [2, 3, 4],
  color: [3, 4],
  quaternion: [4],
};
function propertyTrack(track: PropertyTrackData, label: string): PropertyKeyframeTrack {
  const { target, property, get, set, keys, blend } = track;
  if ((property === undefined) === (set === undefined))
    throw new TypeError(`${label} needs either a property path or a set accessor; pass exactly one`);
  if (property !== undefined && (typeof property !== 'string' || !property))
    throw new TypeError(`${label} property must be a nonempty dot path such as 'material.roughness'`);
  if (set !== undefined && typeof set !== 'function') throw new TypeError(`${label} set must be a function`);
  if (get !== undefined && typeof get !== 'function') throw new TypeError(`${label} get must be a function`);
  if (track.name !== undefined && typeof track.name !== 'string') throw new TypeError(`${label} name must be a string`);
  if (blend !== undefined && blend !== 'delta' && blend !== 'weighted')
    throw new TypeError(`${label} blend ${blend} is invalid; use delta or weighted`);
  if (!Array.isArray(keys) || !keys.length) throw new TypeError(`${label} needs a nonempty keys array`);
  const size = Number(keys[0]?.value?.length),
    type = track.type ?? (size === 1 ? 'number' : 'vector'),
    sizes = valueSizes[type];
  if (!sizes) throw new TypeError(`${label} type ${type} is invalid; use number, vector, color or quaternion`);
  if (!sizes.includes(size))
    throw new RangeError(`${label} ${type} keys need ${sizes.join(' or ')} numbers each; pass that many in every key`);
  const name = track.name ?? property ?? 'set',
    parsed = parseKeys(label, keys, size, type === 'quaternion'),
    out = scratches[size - 1];
  const write: (value: ArrayLike<number>) => void = set
    ? (value) => {
        for (let c = 0; c < size; c++) out[c] = value[c];
        set(out);
      }
    : bindPath(target, property!, size, label);
  const read = (into = new Float64Array(size)): Float64Array => {
    if (get) return readValue(get(), size, into);
    if (property === undefined) throw new TypeError(`Property track ${name} has no get accessor; pass get to read it`);
    let value: unknown = target;
    for (const part of property.split('.')) value = (value as Record<string, unknown>)[part];
    return readValue(value, size, into);
  };
  return {
    target,
    ...(property === undefined ? {} : { property }),
    name,
    type,
    size,
    ...parsed,
    ...(blend === undefined ? {} : { blend }),
    write,
    read,
  };
}

/**
 * Validates raw keys into a clip. Transform and weights tracks (a string `target` and a `path`) go to `tracks`;
 * property tracks ({@link PropertyTrackData}: an object `target` with a `property` path or a `set` accessor) are bound
 * once and go to `properties`. Throws TypeError for bad shapes, a repeated target+path or object+property, or a
 * property path that ends on a value it cannot write, and RangeError for bad numbers or a path that does not resolve.
 */
export function createKeyframeClip(data: KeyframeClipData): KeyframeClip {
  if (!data || !Array.isArray(data.tracks)) throw new TypeError('Keyframe clip needs a tracks array');
  if (data.name !== undefined && typeof data.name !== 'string')
    throw new TypeError('Keyframe clip name must be a string');
  const seen = new Set<string>(),
    bound = new Map<object, Set<unknown>>(),
    tracks: KeyframeTrack[] = [],
    properties: PropertyKeyframeTrack[] = [];
  data.tracks.forEach((raw, t) => {
    const label = `Keyframe track ${t}`,
      target = raw?.target;
    if (target !== null && (typeof target === 'object' || typeof target === 'function')) {
      const data = raw as PropertyTrackData,
        track = propertyTrack(data, label),
        key = data.set ?? data.property,
        used = bound.get(target) ?? new Set();
      if (used.has(key)) throw new TypeError(`${label} repeats property ${track.name}; merge the keys`);
      bound.set(target, used.add(key));
      properties.push(track);
      return;
    }
    if (typeof target !== 'string' || !target)
      throw new TypeError(`${label} needs a nonempty string target, or an object target with a property`);
    const { path, keys, blend } = raw as KeyframeTrackData;
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
    const parsed = parseKeys(label, keys, width, path === 'rotation');
    tracks.push({ target, path, ...parsed, ...(blend === undefined ? {} : { blend }) });
  });
  return {
    name: data.name ?? '',
    duration: Math.max(0, ...[...tracks, ...properties].map((track) => track.times[track.times.length - 1])),
    tracks,
    properties,
  };
}

/**
 * A track's value at `time` seconds: the first key's before it, the last key's after it, else the two surrounding keys
 * blended by the earlier key's interpolation (rotations and quaternion properties by shortest-path slerp) with the
 * track's {@link KeyframeBlend} arithmetic. A `'cubicSpline'` segment is the glTF CUBICSPLINE Hermite curve (tangents scaled
 * by the segment's duration; quaternions normalised after). Deterministic for any frame rate. Property tracks sample
 * the same way.
 */
export function sampleKeyframes(
  track: KeyframeTrack | PropertyKeyframeTrack,
  time: number,
  out?: Float64Array,
): Float64Array {
  if (typeof time !== 'number' || !Number.isFinite(time))
    throw new RangeError(`Keyframe sample time ${time} is invalid; pass finite seconds`);
  const { times, values } = track,
    linear = 'path' in track ? track.path !== 'rotation' : track.type !== 'quaternion',
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
  if (f > 0 && f < 1 && track.interpolations[a] === 'cubicSpline') {
    const span = times[a + 1] - times[a],
      t = f,
      t2 = t * t,
      t3 = t2 * t,
      tangents = track.tangents!,
      outgoing = a * width * 2 + width,
      incoming = (a + 1) * width * 2;
    for (let c = 0; c < width; c++)
      out[c] =
        (2 * t3 - 3 * t2 + 1) * values[i + c] +
        (t3 - 2 * t2 + t) * span * tangents[outgoing + c] +
        (-2 * t3 + 3 * t2) * values[j + c] +
        (t3 - t2) * span * tangents[incoming + c];
    if (linear) return out;
    // A curve through a zero quaternion holds the earlier key there.
    if (!(out[0] || out[1] || out[2] || out[3])) out.set(values.subarray(i, i + 4));
    return normalizeQuaternion(out, out);
  }
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

const sample = new Float64Array(4);
/**
 * Poses `target` at `time`. On a `Skeleton`, every translation, rotation or scale track whose target names one of its
 * bones sets that bone's property (weights tracks are skipped: bones have no morphs). On a glTF-pro model's
 * `Animation`, tracks name model nodes (the first node with that name): transform tracks set the node's local
 * transform and weights tracks set every morph weight through `setMorph`. Pause the Animation's own clip
 * (`animation.playing = false`) while a code clip drives the model, or the two overwrite each other. Every property
 * track is written through its binding first, with or without a target; `applyKeyframeClip(clip, time)` writes only
 * those. Allocates nothing per call for property tracks.
 */
export function applyKeyframeClip(clip: KeyframeClip, time: number): void;
export function applyKeyframeClip(clip: KeyframeClip, target: Skeleton | KeyframeModelTarget, time: number): void;
export function applyKeyframeClip(
  clip: KeyframeClip,
  targetOrTime: Skeleton | KeyframeModelTarget | number,
  at?: number,
): void {
  const target = typeof targetOrTime === 'number' ? undefined : targetOrTime,
    time = typeof targetOrTime === 'number' ? targetOrTime : (at as number);
  if (
    target !== undefined &&
    !(target instanceof Skeleton) &&
    (!target || typeof target.setMorph !== 'function' || !Array.isArray(target.model?.nodes))
  )
    throw new TypeError(
      'applyKeyframeClip needs a Skeleton or an Animation; pass a skeleton or Animation.attach(model)',
    );
  const properties = clip?.properties ?? [];
  for (let i = 0; i < properties.length; i++) properties[i].write(sampleKeyframes(properties[i], time, sample));
  if (target === undefined) {
    if (typeof time !== 'number' || !Number.isFinite(time))
      throw new RangeError(`Keyframe clip time ${time} is invalid; pass finite seconds`);
    return;
  }
  if (target instanceof Skeleton) {
    for (const track of clip.tracks) {
      const bone = track.path === 'weights' ? -1 : target.index(track.target);
      if (bone >= 0) target.setPose(bone, { [track.path]: sampleKeyframes(track, time) });
    }
    return;
  }
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
/** One baked glTF sampler from {@link bakeKeyframeTrack}: Float32 key times and values. */
export interface BakedSampler {
  interpolation: 'STEP' | 'LINEAR';
  times: Float32Array;
  values: Float32Array;
}
const checkFps = (fps: number): void => {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0)
    throw new RangeError(`Keyframe bake fps ${fps} is invalid; pass frames per second > 0`);
};
/**
 * One track, transform or property, as a glTF sampler, by the rules of {@link bakeKeyframeClip}: only discrete keys
 * become STEP and only linear keys LINEAR, exact everywhere; other tracks are LINEAR at the keys plus every `1 / fps`
 * second inside eased and cubic segments, each value exactly what {@link sampleKeyframes} returns there. Rotations and
 * quaternion properties flip sign where needed so neighbouring keys lie in one hemisphere.
 */
export function bakeKeyframeTrack(track: KeyframeTrack | PropertyKeyframeTrack, fps: number): BakedSampler {
  checkFps(fps);
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
        `Keyframe track ${'path' in track ? track.target + ' ' + track.path : track.name} keys are closer than Float32 time precision; space keys further apart`,
      );
    if (plain || k === keys.length - 1 || interpolations[k] === 'linear') continue;
    const end = Math.fround(keys[k + 1]);
    if (interpolations[k] === 'discrete') add(before(end), keys[k]);
    else
      for (let n = Math.floor(keys[k] * fps) + 1; n / fps < keys[k + 1]; n++)
        if (Math.fround(n / fps) < end) add(n / fps, Math.fround(n / fps));
  }
  if ('path' in track ? track.path === 'rotation' : track.type === 'quaternion')
    for (let i = 4; i < values.length; i += 4)
      if (
        values[i] * values[i - 4] +
          values[i + 1] * values[i - 3] +
          values[i + 2] * values[i - 2] +
          values[i + 3] * values[i - 1] <
        0
      )
        for (let c = 0; c < 4; c++) values[i + c] = -values[i + c];
  return {
    interpolation: plain && used.has('discrete') ? 'STEP' : 'LINEAR',
    times: Float32Array.from(times),
    values: Float32Array.from(values),
  };
}
/**
 * glTF samplers for a clip, ready for exporters' `AnimationData` (`{name, channels}`) once `resolve` maps each track
 * target to its `ExportNode`; tracks it maps to undefined are left out. A track of only discrete keys becomes STEP at
 * its keys and one of only linear keys becomes LINEAR at its keys, both exact everywhere; any other track is LINEAR at
 * its keys plus every `1 / fps` second inside eased and cubic segments, exact at those times, and a discrete segment
 * inside it holds until one Float32 step before the next key. Property tracks have no glTF node path and are left out;
 * bake them one at a time with {@link bakeKeyframeTrack}.
 */
export function bakeKeyframeClip<N>(
  clip: KeyframeClip,
  fps: number,
  resolve: (target: string) => N | undefined,
): { name: string; channels: BakedChannel<N>[] } {
  checkFps(fps);
  if (typeof resolve !== 'function') throw new TypeError('Keyframe bake needs a resolve(target) function');
  const channels: BakedChannel<N>[] = [];
  for (const track of clip.tracks) {
    const node = resolve(track.target);
    if (node !== undefined) channels.push({ node, path: track.path, ...bakeKeyframeTrack(track, fps) });
  }
  return { name: clip.name, channels };
}
