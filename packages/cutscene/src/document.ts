// The serialisable cutscene document: plain JSON tracks of keys and clips, nested timelines by id, markers, and the
// validator that checks a document (or anything at all) without throwing.
import type { Quat, Vec3 } from '@margoengine/math';

export type { Quat, Vec3 };

/**
 * Easing into a key from the previous one: a name (`'linear'`, `'step'`, `'smoothstep'` or any `ease*` easing of
 * `@margoengine/tween`, e.g. `'easeInOutCubic'`), or CSS cubic-bezier control points `[x1, y1, x2, y2]`.
 */
export type EaseSpec = string | readonly [number, number, number, number];

/** A camera key: where the camera is and looks at a time. */
export interface CameraKey {
  /** Seconds from the start of the timeline. */
  time: number;
  position: Vec3;
  /** The point looked at. */
  target: Vec3;
  /** Vertical field of view, degrees (default 60, as core's Camera). */
  fov?: number;
  /** Roll about the view direction, radians (default 0). */
  roll?: number;
  /** Easing from the previous key into this one (default `'linear'`). */
  ease?: EaseSpec;
  /** A camera cut: jump to this key instead of moving from the previous one (default false). */
  cut?: boolean;
}
/** Camera moves: keys interpolated along a path, with cuts. */
export interface CameraTrack {
  type: 'camera';
  id: string;
  keys: CameraKey[];
  /** Path through the key positions and targets: a Catmull-Rom spline through every key (default) or straight lines. */
  path?: 'catmull-rom' | 'linear';
  /** Ignored while true (default false). */
  muted?: boolean;
}
/** A transform key; each channel present is interpolated among the keys that have it. */
export interface TransformKey {
  time: number;
  position?: Vec3;
  /** Unit quaternion `[x, y, z, w]`, interpolated by spherical linear interpolation. */
  rotation?: Quat;
  scale?: Vec3;
  ease?: EaseSpec;
}
/** Moves one object, named by `target`. */
export interface TransformTrack {
  type: 'transform';
  id: string;
  /** The object's name in your scene. */
  target: string;
  keys: TransformKey[];
  muted?: boolean;
}
/** A property key: a number or a numeric array (a colour, a vector). */
export interface PropertyKey {
  time: number;
  value: number | number[];
  ease?: EaseSpec;
}
/** Animates one property of one object (`'material.opacity'`, `'light.intensity'`). */
export interface PropertyTrack {
  type: 'property';
  id: string;
  target: string;
  property: string;
  keys: PropertyKey[];
  muted?: boolean;
}
/** A span of time on a clip track. */
export interface ClipBase {
  /** Seconds from the start of the timeline. */
  start: number;
  /** Seconds; above 0. */
  duration: number;
}
/** Plays an animation clip on an object (for your animation mixer). */
export interface AnimationClip extends ClipBase {
  /** The clip's name (as in the glTF file). */
  clip: string;
  /** Playback rate (default 1). */
  speed?: number;
  /** Clip time at the start of the span, seconds (default 0). */
  offset?: number;
  /** Wrap the clip time at `length` instead of holding the last frame (default false). */
  loop?: boolean;
  /** Clip length for `loop`, seconds. */
  length?: number;
  /** Seconds to fade the weight in from 0 and out to 0 (default 0). */
  blendIn?: number;
  blendOut?: number;
}
/** Animation clip triggers for one object. */
export interface AnimationTrack {
  type: 'animation';
  id: string;
  target: string;
  clips: AnimationClip[];
  muted?: boolean;
}
/** An audio cue. */
export interface AudioClip extends ClipBase {
  /** The sound's name in your audio bank. */
  sound: string;
  /** Gain (default 1). */
  volume?: number;
  /** Seconds into the sound at the start of the span (default 0). */
  offset?: number;
  /** Seconds of linear fade in and out (default 0). */
  fadeIn?: number;
  fadeOut?: number;
}
/** Audio cues. */
export interface AudioTrack {
  type: 'audio';
  id: string;
  clips: AudioClip[];
  muted?: boolean;
}
/** A subtitle or caption line. */
export interface SubtitleClip extends ClipBase {
  text: string;
  speaker?: string;
}
/** Subtitles and on-screen text. */
export interface SubtitleTrack {
  type: 'subtitle';
  id: string;
  clips: SubtitleClip[];
  muted?: boolean;
}
/** A named instant with optional JSON data. */
export interface CueEvent {
  time: number;
  name: string;
  data?: unknown;
}
/** Custom events: the player fires them in order, also when skipping. */
export interface EventTrack {
  type: 'event';
  id: string;
  events: CueEvent[];
  muted?: boolean;
}
/** Plays a nested timeline from `timelines`. */
export interface TimelineClip extends ClipBase {
  /** Key of the nested timeline in the document's `timelines`. */
  timeline: string;
  /** Playback rate (default 1). */
  speed?: number;
  /** Nested time at the start of the span, seconds (default 0). */
  offset?: number;
}
/** Nested timelines, placed on the parent's time. */
export interface TimelineTrack {
  type: 'timeline';
  id: string;
  clips: TimelineClip[];
  muted?: boolean;
}
/** Any track. */
export type Track =
  | CameraTrack
  | TransformTrack
  | PropertyTrack
  | AnimationTrack
  | AudioTrack
  | SubtitleTrack
  | EventTrack
  | TimelineTrack;

/** A named point in time (a chapter, a beat); the player reports markers it passes. */
export interface Marker {
  time: number;
  name: string;
}

/** A timeline: tracks over `duration` seconds. */
export interface TimelineSpec {
  /** Seconds; above 0. */
  duration: number;
  tracks: Track[];
  markers?: Marker[];
}

/** A saved cutscene: `JSON.stringify` it to store it, {@link parseCutscene} to read it back. */
export interface CutsceneDocument extends TimelineSpec {
  format: 'margo-cutscene';
  version: 1;
  /** Nested timelines by key, for timeline tracks. They may nest further, without cycles. */
  timelines?: Record<string, TimelineSpec>;
}

/** What a custom track type's `validate` gets: the helpers the built-in tracks are checked with. */
export interface TrackCheck {
  /** The track's path in the document (`tracks[2]`). */
  path: string;
  /** Length of the timeline holding the track, seconds. */
  end: number;
  /** Report a problem at `path`, with its fix. */
  add(path: string, message: string): void;
  /** Check a time on this timeline; false when it was reported. */
  time(value: unknown, path: string): boolean;
  /** Check an {@link EaseSpec}; `undefined` passes. */
  ease(value: unknown, path: string): void;
  /** Check that a list holds objects, and count them against {@link MAX_CUTSCENE_ITEMS}; null when it was reported. */
  list(value: unknown, path: string): Record<string, unknown>[] | null;
  /** Check that a list is sorted by `field`. */
  ordered(list: Record<string, unknown>[], path: string, field: string): void;
  /** Check `track.target`. */
  target(): void;
  /** Check `track.clips` as spans of the timeline, calling `check` on each; returns them, or null when reported. */
  clips(check: (clip: Record<string, unknown>, path: string) => void): Record<string, unknown>[] | null;
  /** Check an optional number on a clip: above 0, or 0 and above when `zero` (default true). */
  positive(clip: Record<string, unknown>, key: string, path: string, zero?: boolean): void;
  /** Check a list of {@link CameraKey}s and that it is not empty. */
  cameraKeys(value: unknown, path: string): void;
}

/** One problem found by {@link validateCutscene}: where (`tracks[2].keys[0].time`) and what to change. */
export interface CutsceneIssue {
  path: string;
  message: string;
}

/** Deepest nesting of timelines accepted. */
export const MAX_TIMELINE_DEPTH = 16;
/** Most keys, clips, events and markers accepted in one document. */
export const MAX_CUTSCENE_ITEMS = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vec = (value: unknown, length: number): boolean =>
  Array.isArray(value) && value.length === length && value.every(finite);

/** Names accepted for {@link EaseSpec} besides the `ease*` names of `@margoengine/tween`. */
export const BASIC_EASINGS = ['linear', 'step', 'smoothstep'] as const;

/** The part of a custom track type the validator uses. */
export interface TrackValidator {
  validate(track: Record<string, unknown>, check: TrackCheck): void;
}

/**
 * Check a cutscene document without building it. Returns every problem found, each with its path and the fix; an
 * empty array means it is valid. `easings` lists the extra easing names allowed (the player passes tween's), and
 * `types` the custom track types allowed, by their `type`.
 * Never throws, whatever the input.
 */
export function validateCutscene(
  input: unknown,
  easings: ReadonlySet<string> = new Set(),
  types: ReadonlyMap<string, TrackValidator> = new Map(),
): CutsceneIssue[] {
  const issues: CutsceneIssue[] = [];
  const add = (path: string, message: string): void => {
    if (issues.length < 1000) issues.push({ path, message });
  };
  if (!isRecord(input)) {
    add('', 'must be a cutscene document {format: "margo-cutscene", version: 1, duration, tracks}');
    return issues;
  }
  if (input.format !== 'margo-cutscene') add('format', "must be 'margo-cutscene'; this is not a cutscene document");
  if (input.version !== 1) add('version', 'must be 1; this file is from a newer version, update @margoengine/cutscene');
  let items = 0;
  const timelines = isRecord(input.timelines) ? input.timelines : {};
  if ('timelines' in input && !isRecord(input.timelines)) add('timelines', 'must be an object of name: timeline');
  const ease = (value: unknown, path: string): void => {
    if (value === undefined) return;
    if (typeof value === 'string') {
      if (!(BASIC_EASINGS as readonly string[]).includes(value) && !easings.has(value))
        add(
          path,
          `unknown easing '${value}'; use linear, step, smoothstep, an ease* name of @margoengine/tween or [x1, y1, x2, y2]`,
        );
    } else if (
      !vec(value, 4) ||
      (value as number[])[0] < 0 ||
      (value as number[])[0] > 1 ||
      (value as number[])[2] < 0 ||
      (value as number[])[2] > 1
    )
      add(path, 'must be an easing name or cubic-bezier [x1, y1, x2, y2] with x1 and x2 in [0, 1]');
  };
  const timeline = (spec: unknown, base: string): void => {
    const at = (path: string): string => (base ? `${base}.${path}` : path);
    if (!isRecord(spec)) {
      add(base, 'must be a timeline {duration, tracks}');
      return;
    }
    const duration = spec.duration;
    const okDuration = finite(duration) && duration > 0;
    if (!okDuration) add(at('duration'), 'must be a finite number of seconds above 0');
    const end = okDuration ? (duration as number) : Number.POSITIVE_INFINITY;
    const time = (value: unknown, path: string): boolean => {
      if (!finite(value) || value < 0 || value > end) {
        add(path, `must be a time in seconds from 0 to the duration (${okDuration ? duration : 'duration'})`);
        return false;
      }
      return true;
    };
    const ordered = (list: Record<string, unknown>[], path: string, field: string): void => {
      for (let i = 1; i < list.length; i++)
        if (
          finite(list[i][field]) &&
          finite(list[i - 1][field]) &&
          (list[i][field] as number) < (list[i - 1][field] as number)
        )
          add(`${path}[${i}].${field}`, `is earlier than the one before; sort the list by ${field}`);
    };
    const list = (value: unknown, path: string): Record<string, unknown>[] | null => {
      if (!Array.isArray(value)) {
        add(path, 'must be an array');
        return null;
      }
      items += value.length;
      if (items > MAX_CUTSCENE_ITEMS) {
        add(path, `the document has more than ${MAX_CUTSCENE_ITEMS} keys, clips and events; split it`);
        return null;
      }
      const records: Record<string, unknown>[] = [];
      value.forEach((item, index) => {
        if (isRecord(item)) records.push(item);
        else add(`${path}[${index}]`, 'must be an object');
      });
      return records.length === value.length ? records : null;
    };
    if ('markers' in spec) {
      const markers = list(spec.markers, at('markers'));
      markers?.forEach((marker, i) => {
        time(marker.time, at(`markers[${i}].time`));
        if (typeof marker.name !== 'string' || !marker.name)
          add(at(`markers[${i}].name`), 'must be a non-empty string');
      });
      if (markers) ordered(markers, at('markers'), 'time');
    }
    const cameraKeys = (value: unknown, path: string): void => {
      const keys = list(value, path);
      if (keys && !keys.length) add(path, 'must hold at least one key');
      keys?.forEach((key, i) => {
        const p = `${path}[${i}]`;
        time(key.time, `${p}.time`);
        if (!vec(key.position, 3)) add(`${p}.position`, 'must be [x, y, z] with finite numbers');
        if (!vec(key.target, 3)) add(`${p}.target`, 'must be [x, y, z] with finite numbers');
        if ('fov' in key && !(finite(key.fov) && key.fov > 0 && key.fov < 180))
          add(`${p}.fov`, 'must be degrees between 0 and 180');
        if ('roll' in key && !finite(key.roll)) add(`${p}.roll`, 'must be a finite number of radians');
        if ('cut' in key && typeof key.cut !== 'boolean') add(`${p}.cut`, 'must be true or false');
        ease(key.ease, `${p}.ease`);
      });
      if (keys) ordered(keys, path, 'time');
    };
    const tracks = list(spec.tracks, at('tracks'));
    if (!tracks) return;
    const ids = new Set<string>();
    tracks.forEach((track, t) => {
      const path = at(`tracks[${t}]`);
      if (typeof track.id !== 'string' || !track.id) add(`${path}.id`, 'must be a non-empty string');
      else if (ids.has(track.id))
        add(`${path}.id`, `'${track.id}' is used by another track; give each track its own id`);
      else ids.add(track.id);
      if ('muted' in track && typeof track.muted !== 'boolean') add(`${path}.muted`, 'must be true or false');
      const target = (): void => {
        if (typeof track.target !== 'string' || !track.target)
          add(`${path}.target`, 'must name the object, a non-empty string');
      };
      const clips = (check: (clip: Record<string, unknown>, p: string) => void): Record<string, unknown>[] | null => {
        const all = list(track.clips, `${path}.clips`);
        all?.forEach((clip, i) => {
          const p = `${path}.clips[${i}]`;
          const okStart = time(clip.start, `${p}.start`);
          if (!finite(clip.duration) || clip.duration <= 0)
            add(`${p}.duration`, 'must be a finite number of seconds above 0');
          else if (okStart && (clip.start as number) + clip.duration > end + 1e-9)
            add(`${p}.duration`, 'runs past the end of its timeline; shorten it or raise the duration');
          check(clip, p);
        });
        if (all) ordered(all, `${path}.clips`, 'start');
        return all;
      };
      const positive = (clip: Record<string, unknown>, key: string, p: string, zero = true): void => {
        if (key in clip && !(finite(clip[key]) && (zero ? (clip[key] as number) >= 0 : (clip[key] as number) > 0)))
          add(`${p}.${key}`, `must be a finite number ${zero ? 'of 0 or more' : 'above 0'}`);
      };
      switch (track.type) {
        case 'camera':
          if ('path' in track && track.path !== 'catmull-rom' && track.path !== 'linear')
            add(`${path}.path`, "must be 'catmull-rom' or 'linear'");
          cameraKeys(track.keys, `${path}.keys`);
          break;
        case 'transform': {
          target();
          const keys = list(track.keys, `${path}.keys`);
          if (keys && !keys.length) add(`${path}.keys`, 'must hold at least one key');
          keys?.forEach((key, i) => {
            const p = `${path}.keys[${i}]`;
            time(key.time, `${p}.time`);
            if (!('position' in key) && !('rotation' in key) && !('scale' in key))
              add(p, 'must set position, rotation or scale');
            if ('position' in key && !vec(key.position, 3))
              add(`${p}.position`, 'must be [x, y, z] with finite numbers');
            if ('scale' in key && !vec(key.scale, 3)) add(`${p}.scale`, 'must be [x, y, z] with finite numbers');
            if ('rotation' in key && (!vec(key.rotation, 4) || Math.hypot(...(key.rotation as number[])) < 1e-6))
              add(`${p}.rotation`, 'must be a unit quaternion [x, y, z, w]');
            ease(key.ease, `${p}.ease`);
          });
          if (keys) ordered(keys, `${path}.keys`, 'time');
          break;
        }
        case 'property': {
          target();
          if (typeof track.property !== 'string' || !track.property)
            add(`${path}.property`, 'must name the property, a non-empty string');
          const keys = list(track.keys, `${path}.keys`);
          if (keys && !keys.length) add(`${path}.keys`, 'must hold at least one key');
          let width = -2;
          keys?.forEach((key, i) => {
            const p = `${path}.keys[${i}]`;
            time(key.time, `${p}.time`);
            const value = key.value;
            const w = finite(value)
              ? -1
              : Array.isArray(value) && value.length && value.every(finite)
                ? value.length
                : -3;
            if (w === -3) add(`${p}.value`, 'must be a finite number or a non-empty array of finite numbers');
            else if (width !== -2 && w !== width)
              add(`${p}.value`, 'must have the same shape as the first key (a number, or an array of the same length)');
            else width = w;
            ease(key.ease, `${p}.ease`);
          });
          if (keys) ordered(keys, `${path}.keys`, 'time');
          break;
        }
        case 'animation':
          target();
          clips((clip, p) => {
            if (typeof clip.clip !== 'string' || !clip.clip) add(`${p}.clip`, 'must name the animation clip');
            positive(clip, 'speed', p, false);
            positive(clip, 'offset', p);
            positive(clip, 'blendIn', p);
            positive(clip, 'blendOut', p);
            if ('loop' in clip && typeof clip.loop !== 'boolean') add(`${p}.loop`, 'must be true or false');
            if (clip.loop === true && !(finite(clip.length) && clip.length > 0))
              add(`${p}.length`, 'must be the clip length in seconds (above 0) when loop is true');
            else positive(clip, 'length', p, false);
          });
          break;
        case 'audio':
          clips((clip, p) => {
            if (typeof clip.sound !== 'string' || !clip.sound) add(`${p}.sound`, 'must name the sound');
            positive(clip, 'volume', p);
            positive(clip, 'offset', p);
            positive(clip, 'fadeIn', p);
            positive(clip, 'fadeOut', p);
          });
          break;
        case 'subtitle':
          clips((clip, p) => {
            if (typeof clip.text !== 'string') add(`${p}.text`, 'must be a string');
            if ('speaker' in clip && typeof clip.speaker !== 'string') add(`${p}.speaker`, 'must be a string');
          });
          break;
        case 'event': {
          const events = list(track.events, `${path}.events`);
          events?.forEach((event, i) => {
            time(event.time, `${path}.events[${i}].time`);
            if (typeof event.name !== 'string' || !event.name)
              add(`${path}.events[${i}].name`, 'must be a non-empty string');
          });
          if (events) ordered(events, `${path}.events`, 'time');
          break;
        }
        case 'timeline':
          clips((clip, p) => {
            if (typeof clip.timeline !== 'string' || !Object.hasOwn(timelines, clip.timeline))
              add(
                `${p}.timeline`,
                `must name a timeline in the document's timelines (${Object.keys(timelines).join(', ') || 'none defined'})`,
              );
            positive(clip, 'speed', p, false);
            positive(clip, 'offset', p);
          });
          break;
        default: {
          const custom = typeof track.type === 'string' ? types.get(track.type) : undefined;
          if (custom)
            custom.validate(track, { path, end, add, time, ease, list, ordered, target, clips, positive, cameraKeys });
          else
            add(
              `${path}.type`,
              `unknown track type ${JSON.stringify(track.type)}; use camera, transform, property, animation, audio, subtitle, event or timeline, or pass its custom track type in the tracks option`,
            );
        }
      }
    });
  };
  timeline(input, '');
  // Nested timelines: each checked once; references must not form a cycle or nest too deep.
  for (const [name, spec] of Object.entries(timelines)) timeline(spec, `timelines.${name}`);
  const children = (name: string): string[] => {
    const spec = timelines[name];
    if (!isRecord(spec) || !Array.isArray(spec.tracks)) return [];
    return spec.tracks.flatMap((track) =>
      isRecord(track) && track.type === 'timeline' && Array.isArray(track.clips)
        ? track.clips.flatMap((clip) =>
            isRecord(clip) && typeof clip.timeline === 'string' && Object.hasOwn(timelines, clip.timeline)
              ? [clip.timeline]
              : [],
          )
        : [],
    );
  };
  const state = new Map<string, number>(); // 1 visiting, 2 done (with its depth below)
  const depthOf = new Map<string, number>();
  const visit = (name: string, trail: string[]): number => {
    if (state.get(name) === 2) return depthOf.get(name)!;
    if (state.get(name) === 1) {
      add(`timelines.${name}`, `nests itself (${[...trail, name].join(' > ')}); remove the cycle`);
      return 0;
    }
    state.set(name, 1);
    let depth = 0;
    for (const child of children(name)) depth = Math.max(depth, 1 + visit(child, [...trail, name]));
    state.set(name, 2);
    depthOf.set(name, depth);
    return depth;
  };
  for (const name of Object.keys(timelines))
    if (visit(name, []) + 1 > MAX_TIMELINE_DEPTH)
      add(`timelines.${name}`, `nests deeper than ${MAX_TIMELINE_DEPTH} levels; flatten it`);
  return issues;
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/**
 * Read a cutscene: JSON text or an object, checked with {@link validateCutscene}. Returns a deep-frozen copy, so the
 * document cannot change under a player and `evaluate` stays a pure function of it and the time.
 * @throws TypeError naming the first problem's path and fix, or for text that is not JSON.
 */
export function parseCutscene(
  input: string | unknown,
  easings?: ReadonlySet<string>,
  types?: ReadonlyMap<string, TrackValidator>,
): CutsceneDocument {
  let value: unknown;
  try {
    value = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
  } catch (error) {
    throw new TypeError(
      `Cutscene is not valid JSON (${(error as Error).message}); save it with JSON.stringify(document)`,
    );
  }
  const issues = validateCutscene(value, easings, types);
  if (issues.length)
    throw new TypeError(
      `Invalid cutscene; fix ${issues[0].path || 'the document'}: ${issues[0].message}${issues.length > 1 ? ` (and ${issues.length - 1} more; see validateCutscene)` : ''}`,
    );
  return deepFreeze(value as CutsceneDocument);
}
