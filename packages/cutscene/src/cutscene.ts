// Evaluation: `Cutscene.evaluate(t)` is a pure function of the document and t (a fresh state object each call, no
// hidden playback state), so scrubbing, seeking and playing reach identical results at the same time. Instants (custom
// events, markers, clip starts and ends, also inside nested timelines) are precomputed and sorted once, so
// `eventsBetween` returns them in one deterministic order however the time range is split.
import { interpolateQuaternions } from '@margoengine/math/quat';
import * as tween from '@margoengine/tween';
import {
  type AnimationClip,
  type AudioClip,
  BASIC_EASINGS,
  type CameraKey,
  type CutsceneDocument,
  type EaseSpec,
  type SubtitleClip,
  type TimelineClip,
  type TimelineSpec,
  type Track,
  parseCutscene,
} from './document.js';

type Ease = (u: number) => number;

/** Every easing name a document may use: `linear`, `step`, `smoothstep` and the `ease*` easings of `@margoengine/tween`. */
export const EASING_NAMES: ReadonlySet<string> = new Set([
  ...BASIC_EASINGS,
  ...Object.keys(tween).filter(
    (name) => /^ease[A-Z]/.test(name) && typeof (tween as Record<string, unknown>)[name] === 'function',
  ),
]);
const STEP: Ease = (u) => (u < 1 ? 0 : 1);
const easing = (spec: EaseSpec | undefined): Ease => {
  if (spec === undefined || spec === 'linear') return tween.linear;
  if (spec === 'step') return STEP;
  if (spec === 'smoothstep') return tween.easeSmoothstep;
  if (typeof spec === 'string') return (tween as unknown as Record<string, Ease>)[spec];
  return tween.cubicBezier(spec[0], spec[1], spec[2], spec[3]);
};

/** Where the camera is at a time. */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  /** Vertical field of view, degrees. */
  fov: number;
  /** Roll about the view direction, radians. */
  roll: number;
  /** Screen-up direction with the roll applied (+Y rolled about the view direction), ready for `camera.up`. */
  up: [number, number, number];
  /** Path of the camera track (`intro/cam` inside a nested timeline). */
  track: string;
}
/** An object's animated transform channels at a time (only the channels its tracks key). */
export interface TransformState {
  position?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}
/** An animation clip playing at a time, for your animation mixer. */
export interface AnimationState {
  target: string;
  clip: string;
  /** Clip time, seconds. */
  time: number;
  /** Blend weight in [0, 1] from blendIn and blendOut. */
  weight: number;
  track: string;
}
/** A sound playing at a time: start it at `time` seconds in when you seek. */
export interface AudioState {
  sound: string;
  /** Seconds into the sound. */
  time: number;
  /** Gain with fades applied. */
  volume: number;
  track: string;
}
/** A subtitle on screen at a time. */
export interface SubtitleState {
  text: string;
  speaker?: string;
  track: string;
}
/** Everything a cutscene sets at one time. A new object each call; it shares nothing with the document. */
export interface CutsceneState {
  /** The time evaluated, clamped to [0, duration]. */
  time: number;
  /** The first unmuted camera track's camera (nested timelines included, in track order), or null. */
  camera: CameraState | null;
  /** Transform channels by target name; a later track wins a channel both key. */
  transforms: Record<string, TransformState>;
  /** Property values by target name, then property name. */
  properties: Record<string, Record<string, number | number[]>>;
  animations: AnimationState[];
  audio: AudioState[];
  subtitles: SubtitleState[];
  /** Name of the last marker at or before `time` (top-level timeline), or null. */
  marker: string | null;
}

/** An instant the player fires: a custom event, a marker, or a clip starting (`enter`) or ending (`exit`). */
export interface CutsceneEvent {
  /** Time on the top-level timeline, seconds. */
  time: number;
  kind: 'event' | 'marker' | 'enter' | 'exit';
  /** The event or marker name, or the clip's animation, sound, text or timeline name. */
  name: string;
  /** Path of the track (`intro/sfx` inside a nested timeline); empty for a top-level marker. */
  track: string;
  /** Type of that track (`'marker'` for markers). */
  type: Track['type'] | 'marker';
  /** A custom event's data. */
  data?: unknown;
  /** The clip of an `enter` or `exit`. */
  clip?: AnimationClip | AudioClip | SubtitleClip | TimelineClip;
  /** Position in the document's event order, ties broken by it. */
  order: number;
}

const RANK = { exit: 0, marker: 1, event: 2, enter: 3 } as const;

/** Index of the last key whose time is <= t (-1 before the first). Keys are sorted by time. */
function before(keys: readonly { time: number }[], t: number): number {
  let lo = 0,
    hi = keys.length - 1,
    found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].time <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The segment around `t`: from key `i` to key `i + 1` at eased fraction `u`; `u` is 0 on the first/last key. */
function segment<K extends { time: number; ease?: EaseSpec; cut?: boolean }>(
  keys: readonly K[],
  eases: readonly Ease[],
  t: number,
): { i: number; j: number; u: number } {
  const i = before(keys, t);
  if (i < 0) return { i: 0, j: 0, u: 0 };
  if (i >= keys.length - 1) return { i, j: i, u: 0 };
  const a = keys[i],
    b = keys[i + 1];
  if (b.cut) return { i, j: i, u: 0 };
  const span = b.time - a.time;
  return { i, j: i + 1, u: span > 0 ? eases[i + 1](Math.min(1, Math.max(0, (t - a.time) / span))) : 1 };
}

const lerp = (a: readonly number[], b: readonly number[], u: number): number[] => a.map((x, k) => x + (b[k] - x) * u);

/** Uniform Catmull-Rom between p1 and p2 (E. Catmull and R. Rom, 1974). */
const catmull = (
  p0: readonly number[],
  p1: readonly number[],
  p2: readonly number[],
  p3: readonly number[],
  u: number,
): number[] => {
  const u2 = u * u,
    u3 = u2 * u;
  return p1.map(
    (_, k) =>
      0.5 *
      (2 * p1[k] +
        (-p0[k] + p2[k]) * u +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3),
  );
};

/** World +Y made perpendicular to the view and rotated by `roll` about it (Rodrigues' rotation formula). */
function rolledUp(position: readonly number[], target: readonly number[], roll: number): [number, number, number] {
  let fx = target[0] - position[0],
    fy = target[1] - position[1],
    fz = target[2] - position[2];
  const fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-12) return [0, 1, 0];
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // Straight up or down: +Y is parallel to the view, so use -Z (the convention core's Camera documents).
  let ux = 0,
    uy = 1,
    uz = 0;
  if (Math.abs(fy) > 1 - 1e-9) {
    uy = 0;
    uz = -1;
  }
  const d = ux * fx + uy * fy + uz * fz;
  ux -= d * fx;
  uy -= d * fy;
  uz -= d * fz;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  if (!roll) return [ux, uy, uz];
  // Rotate about f: u cos r + (f x u) sin r (u is perpendicular to f).
  const c = Math.cos(roll),
    s = Math.sin(roll),
    cx = fy * uz - fz * uy,
    cy = fz * ux - fx * uz,
    cz = fx * uy - fy * ux;
  return [ux * c + cx * s, uy * c + cy * s, uz * c + cz * s];
}

interface Compiled {
  spec: TimelineSpec;
  eases: Map<object, Ease[]>;
  channels: Map<object, { position: number[]; rotation: number[]; scale: number[] }>;
  instants: CutsceneEvent[];
}

function compile(document: CutsceneDocument): Map<TimelineSpec, Compiled> {
  const all = new Map<TimelineSpec, Compiled>();
  const make = (spec: TimelineSpec): Compiled => {
    let compiled = all.get(spec);
    if (compiled) return compiled;
    compiled = { spec, eases: new Map(), channels: new Map(), instants: [] };
    all.set(spec, compiled);
    for (const track of spec.tracks) {
      if (track.type === 'camera' || track.type === 'transform' || track.type === 'property')
        compiled.eases.set(
          track,
          (track.keys as { ease?: EaseSpec }[]).map((key) => easing(key.ease)),
        );
      if (track.type === 'transform') {
        const channel = (name: 'position' | 'rotation' | 'scale'): number[] =>
          track.keys.flatMap((key, index) => (key[name] ? [index] : []));
        compiled.channels.set(track, {
          position: channel('position'),
          rotation: channel('rotation'),
          scale: channel('scale'),
        });
      }
    }
    return compiled;
  };
  // Instants of a timeline, with times local to it; nested timelines map theirs through the clip.
  // `span` is a clip's [start, end] in the same local time, so a nested window can clip both ends of it.
  type Raw = Omit<CutsceneEvent, 'order'> & { span?: [number, number] };
  const instants = (spec: TimelineSpec, prefix: string): Raw[] => {
    const out: Raw[] = [];
    if (!prefix)
      for (const marker of spec.markers ?? [])
        out.push({ time: marker.time, kind: 'marker', name: marker.name, track: '', type: 'marker' });
    for (const track of spec.tracks) {
      if (track.muted) continue;
      const path = prefix + track.id;
      if (track.type === 'event')
        for (const event of track.events)
          out.push({
            time: event.time,
            kind: 'event',
            name: event.name,
            track: path,
            type: 'event',
            ...(event.data === undefined ? {} : { data: event.data }),
          });
      else if (
        track.type === 'animation' ||
        track.type === 'audio' ||
        track.type === 'subtitle' ||
        track.type === 'timeline'
      )
        for (const clip of track.clips as (AnimationClip | AudioClip | SubtitleClip | TimelineClip)[]) {
          const name =
            'clip' in clip ? clip.clip : 'sound' in clip ? clip.sound : 'text' in clip ? clip.text : clip.timeline;
          const span: [number, number] = [clip.start, clip.start + clip.duration];
          out.push({ time: clip.start, kind: 'enter', name, track: path, type: track.type, clip, span });
          if (track.type === 'timeline') {
            const nested = clip as TimelineClip,
              child = document.timelines![nested.timeline],
              speed = nested.speed ?? 1,
              offset = nested.offset ?? 0,
              last = Math.min(child.duration, offset + clip.duration * speed);
            const map = (time: number): number => clip.start + (time - offset) / speed;
            for (const inner of instants(child, `${path}/`)) {
              if (inner.span) {
                // A nested clip cut by the window still enters and exits, at the window's edges.
                const from = Math.max(inner.span[0], offset),
                  to = Math.min(inner.span[1], last);
                if (!(to > from)) continue;
                const span: [number, number] = [map(from), map(to)];
                out.push({ ...inner, time: inner.kind === 'enter' ? span[0] : span[1], span });
              } else if (inner.time >= offset && inner.time <= last) out.push({ ...inner, time: map(inner.time) });
            }
          }
          out.push({ time: clip.start + clip.duration, kind: 'exit', name, track: path, type: track.type, clip, span });
        }
    }
    return out;
  };
  const top = make(document);
  for (const spec of Object.values(document.timelines ?? {})) make(spec);
  top.instants = instants(document, '')
    .map(({ span: _, ...event }, order) => ({ ...event, order }))
    .sort((a, b) => a.time - b.time || RANK[a.kind] - RANK[b.kind] || a.order - b.order)
    .map((event, order) => Object.freeze({ ...event, order }));
  return all;
}

/**
 * A validated, compiled cutscene. `evaluate(t)` gives the full state at any time as a pure function of the document
 * and `t`; `eventsBetween(from, to)` gives the instants passed between two times, in order. Build one from a
 * {@link CutsceneDocument}, an object or JSON text; play it with {@link CutscenePlayer}.
 */
export class Cutscene {
  /** The validated, deep-frozen document. */
  readonly document: CutsceneDocument;
  /** Every instant of the cutscene, sorted (time, then exit, marker, event, enter, then document order). */
  readonly instants: readonly CutsceneEvent[];
  private readonly compiled: Map<TimelineSpec, Compiled>;
  /** @throws TypeError naming the first problem in the document and its fix. */
  constructor(document: CutsceneDocument | string | unknown) {
    this.document = parseCutscene(document, EASING_NAMES);
    this.compiled = compile(this.document);
    this.instants = Object.freeze(this.compiled.get(this.document)!.instants);
  }
  /** Length of the top-level timeline, seconds. */
  get duration(): number {
    return this.document.duration;
  }
  /**
   * The state at time `t` (clamped to [0, duration]). Two calls with the same `t` return equal states, whatever
   * happened in between.
   * @throws RangeError for a non-finite time.
   */
  evaluate(t: number): CutsceneState {
    if (typeof t !== 'number' || Number.isNaN(t))
      throw new RangeError('Cutscene time must be a number of seconds; pass a finite time');
    const time = Math.min(this.duration, Math.max(0, t));
    const state: CutsceneState = {
      time,
      camera: null,
      transforms: {},
      properties: {},
      animations: [],
      audio: [],
      subtitles: [],
      marker: null,
    };
    const markers = this.document.markers ?? [];
    const m = before(markers, time);
    if (m >= 0) state.marker = markers[m].name;
    this.timeline(this.document, time, '', state);
    return state;
  }
  /**
   * The instants passed going from `from` to `to`, in the order they are passed: forward (from < to) every instant
   * with from <= time < to, and those at the end when `to` reaches it; backward (to < from) every instant with
   * to < time <= from, latest first, and those at 0 when `to` reaches it. Splitting a range anywhere returns the same
   * instants, so a frame rate never changes what fires. Times are clamped to [0, duration].
   * @throws RangeError for a NaN time.
   */
  eventsBetween(from: number, to: number): CutsceneEvent[] {
    if (Number.isNaN(from) || Number.isNaN(to) || typeof from !== 'number' || typeof to !== 'number')
      throw new RangeError('Cutscene times must be numbers of seconds; pass finite times');
    const end = this.duration,
      a = Math.min(end, Math.max(0, from)),
      b = Math.min(end, Math.max(0, to)),
      all = this.instants;
    if (a === b) return [];
    if (a < b) return all.filter((e) => e.time >= a && (e.time < b || (b === end && e.time === end)));
    return all.filter((e) => e.time <= a && (e.time > b || (b === 0 && e.time === 0))).reverse();
  }
  private timeline(spec: TimelineSpec, t: number, prefix: string, state: CutsceneState): void {
    const compiled = this.compiled.get(spec)!;
    for (const track of spec.tracks) {
      if (track.muted) continue;
      const path = prefix + track.id;
      switch (track.type) {
        case 'camera':
          if (!state.camera)
            state.camera = this.camera(track.keys, compiled.eases.get(track)!, track.path ?? 'catmull-rom', t, path);
          break;
        case 'transform': {
          const channels = compiled.channels.get(track)!,
            eases = compiled.eases.get(track)!,
            out = (state.transforms[track.target] ??= {});
          for (const name of ['position', 'rotation', 'scale'] as const) {
            const indices = channels[name];
            if (!indices.length) continue;
            const keys = indices.map((index) => track.keys[index]);
            const { i, j, u } = segment(
              keys,
              indices.map((index) => eases[index]),
              t,
            );
            const a = keys[i][name]!,
              b = keys[j][name]!;
            if (name === 'rotation') {
              const q = i === j ? [...a] : interpolateQuaternions(a, b, u, 0.9995);
              const n = Math.hypot(q[0], q[1], q[2], q[3]);
              out.rotation = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
            } else out[name] = lerp(a, b, u) as [number, number, number];
          }
          break;
        }
        case 'property': {
          const { i, j, u } = segment(track.keys, compiled.eases.get(track)!, t);
          const a = track.keys[i].value,
            b = track.keys[j].value;
          (state.properties[track.target] ??= {})[track.property] =
            typeof a === 'number' ? a + ((b as number) - a) * u : lerp(a, b as number[], u);
          break;
        }
        case 'animation':
          for (const clip of track.clips) {
            if (!(t >= clip.start && t < clip.start + clip.duration)) continue;
            const local = t - clip.start,
              speed = clip.speed ?? 1;
            let time = (clip.offset ?? 0) + local * speed;
            if (clip.loop && clip.length) time %= clip.length;
            else if (clip.length !== undefined) time = Math.min(time, clip.length);
            const fadeIn = clip.blendIn ? local / clip.blendIn : 1,
              fadeOut = clip.blendOut ? (clip.duration - local) / clip.blendOut : 1;
            state.animations.push({
              target: track.target,
              clip: clip.clip,
              time,
              weight: Math.max(0, Math.min(1, fadeIn, fadeOut)),
              track: path,
            });
          }
          break;
        case 'audio':
          for (const clip of track.clips) {
            if (!(t >= clip.start && t < clip.start + clip.duration)) continue;
            const local = t - clip.start,
              fadeIn = clip.fadeIn ? local / clip.fadeIn : 1,
              fadeOut = clip.fadeOut ? (clip.duration - local) / clip.fadeOut : 1;
            state.audio.push({
              sound: clip.sound,
              time: (clip.offset ?? 0) + local,
              volume: (clip.volume ?? 1) * Math.max(0, Math.min(1, fadeIn, fadeOut)),
              track: path,
            });
          }
          break;
        case 'subtitle':
          for (const clip of track.clips)
            if (t >= clip.start && t < clip.start + clip.duration)
              state.subtitles.push(
                clip.speaker === undefined
                  ? { text: clip.text, track: path }
                  : { text: clip.text, speaker: clip.speaker, track: path },
              );
          break;
        case 'timeline':
          for (const clip of track.clips) {
            if (!(t >= clip.start && t < clip.start + clip.duration)) continue;
            const child = this.document.timelines![clip.timeline];
            const local = Math.min(child.duration, (clip.offset ?? 0) + (t - clip.start) * (clip.speed ?? 1));
            this.timeline(child, local, `${path}/`, state);
          }
          break;
        case 'event':
          break;
      }
    }
  }
  private camera(
    keys: readonly CameraKey[],
    eases: readonly Ease[],
    path: 'catmull-rom' | 'linear',
    t: number,
    track: string,
  ): CameraState {
    const { i, j, u } = segment(keys, eases, t);
    const a = keys[i],
      b = keys[j];
    let position: number[], target: number[];
    if (i === j) {
      position = [...a.position];
      target = [...a.target];
    } else if (path === 'linear') {
      position = lerp(a.position, b.position, u);
      target = lerp(a.target, b.target, u);
    } else {
      // Neighbours stop at cuts and at the ends, so a shot's spline never bends toward another shot.
      const p0 = i > 0 && !a.cut ? keys[i - 1] : a,
        p3 = j + 1 < keys.length && !keys[j + 1].cut ? keys[j + 1] : b;
      position = catmull(p0.position, a.position, b.position, p3.position, u);
      target = catmull(p0.target, a.target, b.target, p3.target, u);
    }
    const fa = a.fov ?? 60,
      fb = b.fov ?? 60,
      ra = a.roll ?? 0,
      rb = b.roll ?? 0,
      roll = ra + (rb - ra) * u;
    return {
      position: position as [number, number, number],
      target: target as [number, number, number],
      fov: fa + (fb - fa) * u,
      roll,
      up: rolledUp(position, target, roll),
      track,
    };
  }
}

/** The state of `document` at time `t`; builds a {@link Cutscene} each call, so keep one for repeated use. */
export function evaluate(document: CutsceneDocument | string | unknown, t: number): CutsceneState {
  return new Cutscene(document).evaluate(t);
}
