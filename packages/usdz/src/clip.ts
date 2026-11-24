// One animation clip per stage, shared by the entries that animate a scene. Stage time becomes seconds through the stage's
// `timeCodesPerSecond` (AOUSD USD Core Specification v1.1.0, Time Codes Per Second).
import type { GLTFAnimation } from '../../shared/gltf.js';
import type { TimeSamples } from './crate.js';
import type { SceneRead } from './extension.js';

export interface Clip {
  /** Stage time codes as clip seconds, as a list a sampler can share. */
  seconds(times: readonly number[]): number[];
  /** Adds one channel; channels given the same `times` array share one input. */
  channel(node: number, path: string, times: number[], values: Float32Array, interpolation?: string): void;
  /** Adds one KHR_animation_pointer channel of booleans, which hold from key to key. */
  pointer(pointer: string, times: number[], values: Uint8Array): void;
}
type Target = NonNullable<GLTFAnimation['channels']>[number]['target'];
const clips = new WeakMap<object, Clip>();
const widths: Record<string, string> = { translation: 'VEC3', scale: 'VEC3', rotation: 'VEC4', weights: 'SCALAR' };

/** The stage's clip. It joins the document when its first channel does, named after the default prim. */
export function clipOf(read: SceneRead): Clip {
  const known = clips.get(read.document);
  if (known) return known;
  const fields = read.specs['/']?.fields ?? {},
    rate = fields.timeCodesPerSecond ?? fields.framesPerSecond ?? 24,
    perSecond = typeof rate === 'number' && rate > 0 ? rate : 24;
  // A sample before the stage's start would be a negative time, which a clip cannot hold: the clip starts there instead.
  let start = typeof fields.startTimeCode === 'number' ? fields.startTimeCode : Infinity,
    earliest = Infinity;
  for (const path in read.specs) {
    const first = (read.specs[path].fields.timeSamples as TimeSamples | undefined)?.times[0];
    if (first !== undefined && first < earliest) earliest = first;
  }
  // A clip's times are float32. A lead-in of over 2^20 codes would blur them, and it only holds the first pose anyway.
  if (earliest < start || earliest - start > 2 ** 20) start = earliest;
  const inputs = new Map<number[], number>();
  let animation: GLTFAnimation | undefined;
  const add = (target: Target, times: number[], output: number, interpolation: string) => {
    if (!animation) {
      animation = { name: String(fields.defaultPrim ?? 'USD'), samplers: [], channels: [] };
      (read.document.animations ??= []).push(animation);
    }
    let input = inputs.get(times);
    if (input === undefined) {
      input = read.accessor(Float32Array.from(times), 'SCALAR');
      read.document.accessors![input].min = [times[0]];
      read.document.accessors![input].max = [times[times.length - 1]];
      inputs.set(times, input);
    }
    animation.channels.push({ sampler: animation.samplers.length, target });
    animation.samplers.push({ input, output, interpolation });
  };
  const clip: Clip = {
    seconds: (times) => times.map((t) => (t - start) / perSecond),
    channel(node, path, times, values, interpolation = 'LINEAR') {
      add({ node, path }, times, read.accessor(values, widths[path]), interpolation);
    },
    pointer(pointer, times, values) {
      add({ path: 'pointer', extensions: { KHR_animation_pointer: { pointer } } }, times, read.accessor(values, 'SCALAR'), 'STEP');
    },
  };
  clips.set(read.document, clip);
  return clip;
}

/** A list value as plain numbers: nested tuples and matrices come flat, in reading order. */
export const flat = (value: unknown): number[] =>
  Array.isArray(value) ? (value.flat(9) as number[]) : Array.from((value ?? []) as ArrayLike<number>);

/** An attribute over time: its samples, or its default as one sample with no time. */
export interface Stream {
  times: number[];
  values: number[][];
}
export function streamOf(read: SceneRead, path: string, name: string): Stream | undefined {
  const fields = read.specs[path + '.' + name]?.fields;
  if (!fields) return undefined;
  const samples = fields.timeSamples as TimeSamples | undefined;
  if (samples?.times.length) {
    const times: number[] = [],
      values: number[][] = [];
    // A blocked sample holds nothing to play.
    samples.times.forEach((t, i) => {
      if (samples.values[i] === null || samples.values[i] === undefined) return;
      times.push(t);
      values.push(flat(samples.values[i]));
    });
    if (times.length) return { times, values };
  }
  return fields.default === undefined || fields.default === null ? undefined : { times: [], values: [flat(fields.default)] };
}
/** The sample pair around `t` and how far between them `t` lies; held at both ends. */
export function bracket(times: readonly number[], t: number): [number, number, number] {
  if (times.length < 2 || t <= times[0]) return [0, 0, 0];
  const last = times.length - 1;
  if (t >= times[last]) return [last, last, 0];
  let low = 0,
    high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= t) low = middle;
    else high = middle;
  }
  return [low, high, (t - times[low]) / (times[high] - times[low])];
}
/** Spherical interpolation of `a` and `b` at `at` into `out` at `offset`, `[x, y, z, w]`, the short way. */
export function slerp(a: ArrayLike<number>, b: ArrayLike<number>, f: number, out: Float32Array | number[], offset: number) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let p = 1 - f,
    q = f;
  if (dot < 0.9999) {
    const angle = Math.acos(dot),
      s = Math.sin(angle);
    p = Math.sin((1 - f) * angle) / s;
    q = Math.sin(f * angle) / s;
  }
  q *= sign;
  let length = 0;
  for (let i = 0; i < 4; i++) {
    const v = p * a[i] + q * b[i];
    out[offset + i] = v;
    length += v * v;
  }
  length = Math.sqrt(length) || 1;
  for (let i = 0; i < 4; i++) out[offset + i] /= length;
}
