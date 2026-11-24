// @margoengine/cutscene/record: a take recorder. Sample live objects, the camera, properties and input tick by tick, and
// get cutscene tracks back. Keys are thinned by Ramer-Douglas-Peucker on the channel's own interpolation, so every
// sample of the take stays within the tolerance of what the tracks play.
import { InputRecorder, type InputClip, type RecordSource } from '@margoengine/input/replay';
import { MargoError } from '@margoengine/math/errors';
import { eulerToQuaternion, interpolateQuaternions } from '@margoengine/math/quat';
import type {
  CameraKey,
  CameraTrack,
  CutsceneDocument,
  CueEvent,
  EventTrack,
  Marker,
  PropertyKey,
  PropertyTrack,
  TransformKey,
  TransformTrack,
  Track,
  Vec3,
} from './document.js';

/** A vector as a `Mesh` holds it (`x`, `y`, `z`) or as an array. */
type VectorLike = ArrayLike<number> | { readonly x: number; readonly y: number; readonly z: number };

/** What a transform source gives. A 3-value `rotation` is Euler radians, as a `Mesh`'s; 4 values are a quaternion. */
export interface TransformSample {
  position?: VectorLike;
  rotation?: VectorLike;
  scale?: VectorLike;
}

/** What a camera source gives; `core`'s `Camera` fits. */
export interface CameraSample {
  position: VectorLike;
  target: VectorLike;
  /** Degrees (default 60). */
  fov?: number;
  /** Radians (default 0). */
  roll?: number;
}

/** How far the tracks may stray from the samples. A value of 0 keeps every change. */
export interface TakeTolerance {
  /** World units, for positions and camera positions and targets. Default 0.001. */
  position?: number;
  /** Radians. Default 0.001. */
  rotation?: number;
  /** Default 0.001. */
  scale?: number;
  /** For properties and fields of view, on each component. Default 0.001. */
  value?: number;
}

/** Options of {@link TakeRecorder}. */
export interface TakeRecorderOptions {
  /** How far the tracks may stray from the samples. */
  tolerance?: TakeTolerance;
  /** Clock in milliseconds, for `capture()` with no time. Default `performance.now`. */
  now?: () => number;
}

/** A finished take: tracks, and what else was marked while recording. */
export interface Take {
  /** Seconds from the first capture to the last. */
  duration: number;
  tracks: Track[];
  markers: Marker[];
  /** Samples each track was thinned from, and the keys left, by track id. */
  kept: Record<string, { samples: number; keys: number }>;
}

/** Options of {@link inputTracks}. */
export interface InputTrackOptions {
  /** Seconds to add to every time. Default 0. */
  at?: number;
  /** The `target` of the property tracks, and the start of the track ids. Default `'input'`. */
  target?: string;
}

/** Options of {@link appendTake}. */
export interface AppendTakeOptions {
  /** Where the take starts in the document, seconds. Default the document's end. */
  at?: number;
  /** Put in front of the track ids, so a second take of one object can sit beside the first. Default none. */
  prefix?: string;
}

const list = (value: VectorLike, what: string): number[] => {
  const v = value as { x?: number; y?: number; z?: number; length?: number };
  const out = typeof v.x === 'number' ? [v.x, v.y as number, v.z as number] : Array.from(value as ArrayLike<number>);
  if (!out.length || !out.every(Number.isFinite)) throw new RangeError(`Take sample ${what} must hold finite numbers`);
  return out;
};

const distance = (a: readonly number[], b: readonly number[]): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
};
const lerp = (a: readonly number[], b: readonly number[], u: number): number[] => a.map((x, i) => x + (b[i] - x) * u);

/** Angle between two rotations, radians. */
const turn = (a: readonly number[], b: readonly number[]): number => {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
};
const slerp = (a: readonly number[], b: readonly number[], u: number): number[] => {
  const q = interpolateQuaternions(a, b, u, 0.9995),
    n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};
/** The largest of each component's gap, for values whose parts need not share a unit. */
const widest = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((most, x, i) => Math.max(most, Math.abs(x - b[i])), 0);

/** Indices of the samples to keep: every dropped sample sits within `tolerance` of the line between its neighbours. */
function thin(
  times: readonly number[],
  values: readonly (readonly number[])[],
  tolerance: number,
  between: (a: readonly number[], b: readonly number[], u: number) => number[],
  gap: (a: readonly number[], b: readonly number[]) => number,
): number[] {
  const last = times.length - 1;
  if (last < 1) return last < 0 ? [] : [0];
  const keep = new Uint8Array(times.length),
    stack: [number, number][] = [[0, last]];
  keep[0] = keep[last] = 1;
  while (stack.length) {
    const [from, to] = stack.pop()!,
      span = times[to] - times[from];
    let worst = -1,
      most = tolerance;
    for (let i = from + 1; i < to; i++) {
      const error = gap(values[i], between(values[from], values[to], span > 0 ? (times[i] - times[from]) / span : 0));
      if (error > most) {
        most = error;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([from, worst], [worst, to]);
  }
  const out: number[] = [];
  keep.forEach((flag, i) => flag && out.push(i));
  // A channel that never moved needs one key: it holds.
  return out.length === 2 && gap(values[0], values[last]) <= tolerance ? [0] : out;
}

interface Channel {
  times: number[];
  values: number[][];
}
const channel = (): Channel => ({ times: [], values: [] });
const push = (into: Channel, time: number, value: number[], what: string): void => {
  const first = into.values[0];
  if (first && first.length !== value.length) throw new RangeError(`Take sample ${what} changed its length; give the same number of values every tick`);
  into.times.push(time);
  into.values.push(value);
};

/**
 * Records live gameplay into cutscene tracks. Say what to record, call `capture()` once per tick, and `stop()` gives a
 * {@link Take}: put it in a document with {@link takeDocument} or {@link appendTake}.
 *
 * ```ts
 * const recorder = new TakeRecorder();
 * recorder.transform('hero', hero); // a Mesh, or a function giving { position, rotation, scale }
 * recorder.capture(); // once per tick
 * const take = recorder.stop();
 * ```
 */
export class TakeRecorder {
  private readonly tolerance: Required<TakeTolerance>;
  private readonly now: () => number;
  private readonly transforms = new Map<
    string,
    { read: () => TransformSample; position: Channel; rotation: Channel; scale: Channel }
  >();
  private readonly properties = new Map<
    string,
    { target: string; property: string; read: () => number | readonly number[]; data: Channel; scalar: boolean }
  >();
  private cameraRead: (() => CameraSample) | null = null;
  private readonly cameraData = channel();
  private readonly cameraFov = channel();
  private readonly cameraRoll = channel();
  private readonly events: CueEvent[] = [];
  private readonly marks: Marker[] = [];
  private inputs: { recorder: InputRecorder; start: number | null; target: string }[] = [];
  private start: number | null = null;
  private clock = 0;
  private ticks = 0;
  private stopped = false;
  constructor({ tolerance = {}, now = () => performance.now() }: TakeRecorderOptions = {}) {
    for (const [name, value] of Object.entries(tolerance))
      if (!(value >= 0) || !Number.isFinite(value)) throw new RangeError(`Take tolerance ${name} must be 0 or more`);
    this.tolerance = { position: 0.001, rotation: 0.001, scale: 0.001, value: 0.001, ...tolerance };
    this.now = now;
  }
  /** Seconds since the first capture. */
  get time(): number {
    return this.clock;
  }
  /** Ticks captured so far. */
  get frames(): number {
    return this.ticks;
  }
  /** Record an object as `name`: a `Mesh`, anything with `position`, `rotation` or `scale`, or a function giving them. */
  transform(name: string, source: TransformSample | (() => TransformSample)): this {
    this.open();
    if (typeof name !== 'string' || !name) throw new TypeError('Take transform needs the object name');
    if (this.transforms.has(name)) throw new RangeError(`Take already records '${name}'; use another name`);
    const read = typeof source === 'function' ? source : () => source;
    this.transforms.set(name, { read, position: channel(), rotation: channel(), scale: channel() });
    return this;
  }
  /** Record the camera: a `Camera`, or a function giving `position`, `target`, `fov` and `roll`. One per take. */
  camera(source: CameraSample | (() => CameraSample)): this {
    this.open();
    if (this.cameraRead) throw new RangeError('Take already records a camera; use one per take');
    this.cameraRead = typeof source === 'function' ? source : () => source;
    return this;
  }
  /** Record a number or a numeric array of `target`, as a property track. */
  property(target: string, property: string, read: () => number | readonly number[]): this {
    this.open();
    if (typeof read !== 'function') throw new TypeError('Take property needs a function that reads the value');
    const id = `property-${target}-${property}`;
    if (this.properties.has(id)) throw new RangeError(`Take already records ${target}.${property}; use another name`);
    this.properties.set(id, { target, property, read, data: channel(), scalar: false });
    return this;
  }
  /** Record every binding of an `Input` from the next capture on; call `capture()` after `input.update()`. */
  input(input: RecordSource, { target = 'input' }: { target?: string } = {}): this {
    this.open();
    if (this.inputs.some((entry) => entry.target === target))
      throw new RangeError(`Take already records input as '${target}'; give this one another target`);
    this.inputs.push({ recorder: new InputRecorder(input, { now: () => this.clock * 1000 }), start: null, target });
    return this;
  }
  /** Note an event at the current time, for an event track. */
  event(name: string, data?: unknown): this {
    this.open();
    this.events.push(data === undefined ? { time: this.clock, name } : { time: this.clock, name, data });
    return this;
  }
  /** Note a marker at the current time. */
  marker(name: string): this {
    this.open();
    this.marks.push({ time: this.clock, name });
    return this;
  }
  /**
   * Sample everything: once per tick. `time` is seconds on your own clock, for a fixed-step game; by default the
   * `now` clock runs. The first capture is time 0 of the take.
   * @throws RangeError for a time before the last capture.
   */
  capture(time?: number): this {
    this.open();
    const now = time ?? this.now() / 1000;
    if (!Number.isFinite(now)) throw new RangeError('Take capture time must be a finite number of seconds');
    this.start ??= now;
    const at = now - this.start;
    if (at < this.clock) throw new RangeError('Take capture time went backwards; pass times in order');
    this.clock = at;
    this.ticks++;
    for (const [name, entry] of this.transforms) {
      const sample = entry.read();
      if (sample.position) push(entry.position, at, list(sample.position, `${name}.position`).slice(0, 3), 'position');
      if (sample.scale) push(entry.scale, at, list(sample.scale, `${name}.scale`).slice(0, 3), 'scale');
      if (sample.rotation) {
        const raw = list(sample.rotation, `${name}.rotation`),
          quaternion = raw.length === 3 ? eulerToQuaternion(raw[0], raw[1], raw[2]) : raw,
          before = entry.rotation.values.at(-1);
        // q and -q are one rotation; keep neighbours on one side so a slerp takes the short way.
        const flip =
          before &&
          before[0] * quaternion[0] + before[1] * quaternion[1] + before[2] * quaternion[2] + before[3] * quaternion[3] < 0;
        push(entry.rotation, at, flip ? quaternion.map((x) => -x) : [...quaternion], 'rotation');
      }
    }
    for (const entry of this.properties.values()) {
      const value = entry.read();
      entry.scalar = typeof value === 'number';
      const parts = typeof value === 'number' ? [value] : [...value];
      if (!parts.every(Number.isFinite)) throw new RangeError(`Take property ${entry.target}.${entry.property} must be finite`);
      push(entry.data, at, parts, `${entry.target}.${entry.property}`);
    }
    if (this.cameraRead) {
      const seen = this.cameraRead();
      push(this.cameraData, at, [...list(seen.position, 'camera position'), ...list(seen.target, 'camera target')], 'camera');
      push(this.cameraFov, at, [seen.fov ?? 60], 'fov');
      push(this.cameraRoll, at, [seen.roll ?? 0], 'roll');
    }
    for (const entry of this.inputs) {
      entry.start ??= at;
      entry.recorder.capture();
    }
    return this;
  }
  /**
   * End the take and give its tracks. The recorder is spent.
   * @throws MargoError `'state'` when nothing was captured or when it has already stopped.
   */
  stop(): Take {
    this.open();
    if (!this.ticks) throw new MargoError('state', 'Take has no samples; call capture() once per tick before stop()');
    this.stopped = true;
    const tracks: Track[] = [],
      kept: Take['kept'] = {},
      note = (id: string, samples: number, keys: number): void => void (kept[id] = { samples, keys });
    if (this.cameraRead) tracks.push(this.cameraTrack(note));
    for (const [name, entry] of this.transforms) {
      const track = this.transformTrack(name, entry);
      if (track) {
        tracks.push(track);
        note(track.id, entry.position.times.length || entry.rotation.times.length || entry.scale.times.length, track.keys.length);
      }
    }
    for (const [id, entry] of this.properties) {
      const { times, values } = entry.data,
        indices = thin(times, values, this.tolerance.value, lerp, widest),
        keys = indices.map((i): PropertyKey => ({ time: times[i], value: entry.scalar ? values[i][0] : values[i] }));
      tracks.push({ type: 'property', id, target: entry.target, property: entry.property, keys } satisfies PropertyTrack);
      note(id, times.length, keys.length);
    }
    for (const { recorder, start, target } of this.inputs)
      if (start !== null) tracks.push(...inputTracks(recorder.clip(), { at: start, target }));
    if (this.events.length) tracks.push({ type: 'event', id: 'events', events: this.events } satisfies EventTrack);
    return { duration: this.clock, tracks, markers: this.marks, kept };
  }
  private open(): void {
    if (this.stopped) throw new MargoError('state', 'Take has stopped; create a new TakeRecorder for the next take');
  }
  private transformTrack(
    name: string,
    entry: { position: Channel; rotation: Channel; scale: Channel },
  ): TransformTrack | null {
    const keys = new Map<number, TransformKey>();
    const add = (data: Channel, field: 'position' | 'rotation' | 'scale', indices: number[]): void => {
      for (const i of indices) {
        const time = data.times[i];
        let key = keys.get(time);
        if (!key) keys.set(time, (key = { time }));
        (key as unknown as Record<string, number[]>)[field] = data.values[i];
      }
    };
    const { position, rotation, scale } = entry;
    add(position, 'position', thin(position.times, position.values, this.tolerance.position, lerp, distance));
    add(rotation, 'rotation', thin(rotation.times, rotation.values, this.tolerance.rotation, slerp, turn));
    add(scale, 'scale', thin(scale.times, scale.values, this.tolerance.scale, lerp, distance));
    if (!keys.size) return null;
    return {
      type: 'transform',
      id: `transform-${name}`,
      target: name,
      keys: [...keys.values()].sort((a, b) => a.time - b.time),
    };
  }
  private cameraTrack(note: (id: string, samples: number, keys: number) => void): CameraTrack {
    const { times, values } = this.cameraData,
      // Position and target thin together, as one key holds both; each stays within the tolerance as a distance.
      where = thin(times, values, this.tolerance.position, lerp, (a, b) =>
        Math.max(distance(a.slice(0, 3), b.slice(0, 3)), distance(a.slice(3), b.slice(3))),
      ),
      fov = thin(times, this.cameraFov.values, this.tolerance.value, lerp, widest),
      roll = thin(times, this.cameraRoll.values, this.tolerance.value, lerp, widest),
      indices = [...new Set([...where, ...fov, ...roll])].sort((a, b) => a - b);
    const keys = indices.map((i): CameraKey => {
      const v = values[i];
      return {
        time: times[i],
        position: v.slice(0, 3) as unknown as Vec3,
        target: v.slice(3, 6) as unknown as Vec3,
        fov: this.cameraFov.values[i][0],
        roll: this.cameraRoll.values[i][0],
      };
    });
    note('camera', times.length, keys.length);
    return { type: 'camera', id: 'camera', path: 'linear', keys };
  }
}

/**
 * An input recording as tracks: one stepped property track per binding (target `input`, property the action, and
 * `#1` and so on for its later bindings), so `state.properties.input.move` is what the binding gave at any time, and
 * one event track with `<action>` when a binding leaves 0 and `<action>:up` when it comes back.
 */
export function inputTracks(clip: InputClip, { at = 0, target = 'input' }: InputTrackOptions = {}): Track[] {
  const seconds = (tick: number): number => at + clip.times[tick] / 1000,
    keys = clip.channels.map((): PropertyKey[] => [{ time: at, value: 0 }]),
    events: CueEvent[] = [];
  for (let i = 0; i < clip.events.length; i += 3) {
    const time = seconds(clip.events[i]),
      id = clip.events[i + 1],
      value = clip.events[i + 2],
      list = keys[id],
      before = list.at(-1)!,
      was = before.value,
      [action, binding] = clip.channels[id],
      data = { binding, value };
    if (before.time === time) before.value = value;
    else list.push({ time, value, ease: 'step' });
    if (was === 0 && value !== 0) events.push({ time, name: action, data });
    else if (was !== 0 && value === 0) events.push({ time, name: `${action}:up`, data });
  }
  const name = (id: number): string => {
    const [action, binding] = clip.channels[id];
    return binding ? `${action}#${binding}` : action;
  };
  const tracks: Track[] = clip.channels.map(
    (_, id): PropertyTrack => ({
      type: 'property',
      id: `${target}-${name(id)}`,
      target,
      property: name(id),
      keys: keys[id],
    }),
  );
  if (events.length) tracks.push({ type: 'event', id: `${target}-events`, events });
  return tracks;
}

/** Shift every time on a track by `by` seconds. */
function shifted(track: Track, by: number, prefix: string): Track {
  const copy = JSON.parse(JSON.stringify(track)) as Track & { keys?: { time: number }[]; events?: { time: number }[] };
  copy.id = prefix + copy.id;
  for (const key of copy.keys ?? []) key.time += by;
  for (const event of copy.events ?? []) event.time += by;
  return copy;
}

/** The smallest length of a document holding a take that lasted no time at all, one frame. */
const ONE_TICK = 1 / 60;

/** A take as a whole cutscene document. */
export function takeDocument(take: Take): CutsceneDocument {
  return {
    format: 'margo-cutscene',
    version: 1,
    duration: Math.max(take.duration, ONE_TICK),
    tracks: take.tracks,
    ...(take.markers.length ? { markers: take.markers } : {}),
  };
}

/**
 * A new document with the take added at a time, longer if it needs to be. The document you pass is left alone.
 * @throws RangeError when a track id is taken: pass `prefix`.
 */
export function appendTake(
  document: CutsceneDocument,
  take: Take,
  { at = document.duration, prefix = '' }: AppendTakeOptions = {},
): CutsceneDocument {
  if (!(at >= 0) || !Number.isFinite(at)) throw new RangeError('appendTake needs a time of 0 or more');
  const copy = JSON.parse(JSON.stringify(document)) as CutsceneDocument,
    ids = new Set(copy.tracks.map((track) => track.id));
  for (const track of take.tracks) {
    const moved = shifted(track, at, prefix);
    if (ids.has(moved.id)) throw new RangeError(`Track id '${moved.id}' is taken; pass a prefix to appendTake`);
    ids.add(moved.id);
    copy.tracks.push(moved);
  }
  if (take.markers.length)
    copy.markers = [...(copy.markers ?? []), ...take.markers.map((marker) => ({ ...marker, time: marker.time + at }))].sort(
      (a, b) => a.time - b.time,
    );
  copy.duration = Math.max(copy.duration, at + Math.max(take.duration, ONE_TICK));
  return copy;
}

