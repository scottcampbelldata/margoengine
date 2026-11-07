// @margoengine/cutscene/shots: virtual cameras on a shot track. A shot names a camera, and the track cuts or blends
// from one to the next while both keep moving, so an edit is written as shots instead of keys on raw transforms. Like
// every track it is a pure function of the time: scrubbing into the middle of a blend shows what playing to it shows.
import { rotateByQuaternion } from '@margoengine/math/quat';
import {
  type CameraState,
  type CutsceneState,
  type CutsceneTrackType,
  type TrackInstant,
  cameraAt,
  easing,
  rolledUp,
} from './cutscene.js';
import type { CameraKey, ClipBase, EaseSpec, TrackCheck, Vec3 } from './index.js';

/**
 * A camera a shot can use. Where it stands comes from `keys` (a move, timed from the start of the shot), `live` (a
 * camera of the running game), or `position` and `target`. `follow` then makes the position relative to an object and
 * `lookAt` aims at an object instead of the target.
 */
export interface VirtualCamera {
  /** A camera move: the keys of a camera track, with time 0 at the start of the shot. */
  keys?: CameraKey[];
  /** Path through `keys`: `'catmull-rom'` (default) or `'linear'`. */
  path?: 'catmull-rom' | 'linear';
  /** Names a function in the `live` option of {@link shotTrack}, read at every evaluate. */
  live?: string;
  /** Default [0, 0, 0], or the offset from `follow`. */
  position?: Vec3;
  /** The point looked at. Needed unless `keys`, `live` or `lookAt` gives one. */
  target?: Vec3;
  /** Vertical field of view, degrees (default 60). */
  fov?: number;
  /** Roll about the view direction, radians (default 0). */
  roll?: number;
  /** Object whose position `position` is measured from. */
  follow?: string;
  /** With `follow`: measure in the object's own axes, so the camera turns with it (default false). */
  followRotation?: boolean;
  /** Object to aim at. */
  lookAt?: string;
  /** Added to the `lookAt` object's position (default [0, 0, 0]). */
  lookOffset?: Vec3;
}

/** A shot: a camera for a span of the timeline. Shots may not overlap; between shots the last one holds. */
export interface ShotClip extends ClipBase {
  /** Key of the camera in the track's `cameras`. */
  camera: string;
  /** Seconds to blend from the shot before; 0 is a cut (default 0). At most the shot's `duration`. */
  blendIn?: number;
  /** Shape of the blend (default `'smoothstep'`). */
  ease?: EaseSpec;
  /**
   * `'direct'` (default) moves the camera straight across and turns its view. `'orbit'` swings it around the point
   * looked at, for two cameras on one subject, so the blend does not cut through the subject.
   */
  blend?: 'direct' | 'orbit';
  /** Rate of the camera's move (default 1). */
  speed?: number;
  /** Seconds into the camera's move at the start of the shot (default 0). */
  offset?: number;
}

/** Cameras and the shots that use them. */
export interface ShotTrack {
  type: 'shot';
  id: string;
  cameras: Record<string, VirtualCamera>;
  clips: ShotClip[];
  muted?: boolean;
}

/** Which shots are on screen: what {@link shotOf} gives. */
export interface ShotState {
  /** The shot's camera. */
  camera: string;
  /** During a blend, the camera it blends from. */
  from?: string;
  /** How far the blend is, 0 to 1 after easing; 1 when no blend runs. */
  weight: number;
  /** Path of the track. */
  track: string;
}

/** Where an object is, from {@link ShotTrackOptions.locate}. */
export interface ShotObject {
  position: readonly number[];
  /** Unit quaternion, for `followRotation`. */
  rotation?: readonly number[];
}

/** What a `live` camera gives. */
export interface LiveCamera {
  position: readonly number[];
  target: readonly number[];
  /** Degrees (default 60). */
  fov?: number;
  /** Radians (default 0). */
  roll?: number;
}

/** Options of {@link shotTrack}. */
export interface ShotTrackOptions {
  /** Finds an object the cutscene does not move. Objects with a transform track are read from it first. Default none. */
  locate?: (name: string) => ShotObject | undefined;
  /** Cameras of the running game by name, so a cutscene can blend out of and back into play. Default none. */
  live?: Readonly<Record<string, () => LiveCamera>>;
}

const finite3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every((x) => Number.isFinite(x));

function checkCamera(camera: Record<string, unknown>, path: string, check: TrackCheck): void {
  const { add } = check,
    keys = camera.keys !== undefined;
  if (keys) {
    check.cameraKeys(camera.keys, `${path}.keys`);
    if ('path' in camera && camera.path !== 'catmull-rom' && camera.path !== 'linear')
      add(`${path}.path`, "must be 'catmull-rom' or 'linear'");
  }
  for (const name of ['live', 'follow', 'lookAt'])
    if (name in camera && (typeof camera[name] !== 'string' || !camera[name]))
      add(`${path}.${name}`, 'must be a non-empty string');
  for (const name of ['position', 'target', 'lookOffset'])
    if (name in camera && !finite3(camera[name])) add(`${path}.${name}`, 'must be [x, y, z] with finite numbers');
  if (keys && 'live' in camera) add(`${path}.live`, 'cannot go with keys; use one source for the camera');
  if (keys || 'live' in camera) {
    for (const name of ['position', 'target', 'follow', 'lookAt'])
      if (name in camera) add(`${path}.${name}`, 'cannot go with keys or live, which set where the camera is');
  } else if (!('target' in camera) && !('lookAt' in camera))
    add(path, 'must say what it looks at: keys, live, target or lookAt');
  if ('fov' in camera && !(typeof camera.fov === 'number' && camera.fov > 0 && camera.fov < 180))
    add(`${path}.fov`, 'must be degrees between 0 and 180');
  if ('roll' in camera && !Number.isFinite(camera.roll)) add(`${path}.roll`, 'must be a finite number of radians');
  if ('followRotation' in camera && typeof camera.followRotation !== 'boolean')
    add(`${path}.followRotation`, 'must be true or false');
}

function validate(track: Record<string, unknown>, check: TrackCheck): void {
  const { path, add } = check,
    cameras = track.cameras,
    named = typeof cameras === 'object' && cameras !== null && !Array.isArray(cameras);
  if (!named) add(`${path}.cameras`, 'must be an object of name: camera');
  else
    for (const [name, camera] of Object.entries(cameras))
      if (typeof camera !== 'object' || camera === null || Array.isArray(camera))
        add(`${path}.cameras.${name}`, 'must be an object');
      else checkCamera(camera as Record<string, unknown>, `${path}.cameras.${name}`, check);
  const clips = check.clips((clip, p) => {
    if (typeof clip.camera !== 'string' || !named || !Object.hasOwn(cameras, clip.camera))
      add(`${p}.camera`, `must name one of the track's cameras (${named ? Object.keys(cameras).join(', ') : 'none'})`);
    check.positive(clip, 'blendIn', p);
    check.positive(clip, 'speed', p, false);
    check.positive(clip, 'offset', p);
    check.ease(clip.ease, `${p}.ease`);
    if ('blend' in clip && clip.blend !== 'direct' && clip.blend !== 'orbit')
      add(`${p}.blend`, "must be 'direct' or 'orbit'");
    if (typeof clip.blendIn === 'number' && typeof clip.duration === 'number' && clip.blendIn > clip.duration)
      add(`${p}.blendIn`, 'is longer than the shot; shorten the blend or lengthen the shot');
  });
  clips?.forEach((clip, i) => {
    const before = clips[i - 1];
    if (!before) {
      if (typeof clip.blendIn === 'number' && clip.blendIn > 0)
        add(`${path}.clips[0].blendIn`, 'has no shot before it to blend from; start with a shot of a live camera');
    } else if ((before.start as number) + (before.duration as number) > (clip.start as number) + 1e-9)
      add(`${path}.clips[${i}].start`, 'overlaps the shot before; shots follow each other, use blendIn to blend');
  });
}

const length = (v: readonly number[]): number => Math.hypot(v[0], v[1], v[2]);
const subtract = (a: readonly number[], b: readonly number[]): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mix = (a: readonly number[], b: readonly number[], u: number): number[] => [
  a[0] + (b[0] - a[0]) * u,
  a[1] + (b[1] - a[1]) * u,
  a[2] + (b[2] - a[2]) * u,
];

/**
 * Turns from `a` to `b`, at even angular speed, keeping a length that moves evenly between theirs. Length-0 input
 * gives the other vector's direction. Vectors that point opposite ways turn around the world's up.
 */
function swing(a: readonly number[], b: readonly number[], u: number): number[] {
  const la = length(a),
    lb = length(b),
    size = la + (lb - la) * u;
  if (la < 1e-12 || lb < 1e-12) return mix(a, b, u);
  const ax = a[0] / la,
    ay = a[1] / la,
    az = a[2] / la;
  const cosine = Math.min(1, Math.max(-1, (ax * b[0] + ay * b[1] + az * b[2]) / lb));
  // The unit vector in the plane of the turn, square to a.
  let cx = b[0] / lb - ax * cosine,
    cy = b[1] / lb - ay * cosine,
    cz = b[2] / lb - az * cosine,
    cl = Math.hypot(cx, cy, cz);
  if (cl < 1e-9) {
    if (cosine > 0) return [ax * size, ay * size, az * size];
    // Opposite: any square vector will do, and a turn about the world's up reads as a pan.
    const flat = Math.hypot(ax, az) > 1e-6;
    cx = flat ? az : 1;
    cy = 0;
    cz = flat ? -ax : 0;
    cl = Math.hypot(cx, cy, cz);
  }
  const angle = Math.atan2(cl, cosine) * u,
    c = Math.cos(angle),
    s = Math.sin(angle) / cl;
  return [(ax * c + cx * s) * size, (ay * c + cy * s) * size, (az * c + cz * s) * size];
}

/** Blends two cameras. At `u` 0 and 1 it gives them exactly, so a blend starts and ends without a step. */
function blendCameras(a: CameraState, b: CameraState, u: number, style: 'direct' | 'orbit', track: string): CameraState {
  if (u <= 0) return { ...a, track };
  if (u >= 1) return { ...b, track };
  const roll = a.roll + (b.roll - a.roll) * u;
  let position: number[], target: number[];
  if (style === 'orbit') {
    target = mix(a.target, b.target, u);
    const arm = swing(subtract(a.position, a.target), subtract(b.position, b.target), u);
    position = [target[0] + arm[0], target[1] + arm[1], target[2] + arm[2]];
  } else {
    // The view turns rather than the target sliding, so the target never passes through the camera.
    position = mix(a.position, b.position, u);
    const view = swing(subtract(a.target, a.position), subtract(b.target, b.position), u);
    target = [position[0] + view[0], position[1] + view[1], position[2] + view[2]];
  }
  return {
    position: position as [number, number, number],
    target: target as [number, number, number],
    fov: a.fov + (b.fov - a.fov) * u,
    roll,
    up: rolledUp(position, target, roll),
    track,
  };
}

/**
 * The shot track type: pass it in the `tracks` option of `Cutscene` or `CutscenePlayer`. A shot track sets
 * `state.camera`, in place of any camera track; the first unmuted shot track wins. Shots fire `enter` and `exit`.
 * @throws RangeError from `evaluate` when a shot needs an object or a live camera nothing provides.
 */
export function shotTrack(options: ShotTrackOptions = {}): CutsceneTrackType {
  const { locate, live = {} } = options;
  const eases = new WeakMap<object, ((u: number) => number)[]>();
  const keyEases = (camera: VirtualCamera): ((u: number) => number)[] => {
    let list = eases.get(camera);
    if (!list) eases.set(camera, (list = camera.keys!.map((key) => easing(key.ease))));
    return list;
  };
  const find = (name: string, state: CutsceneState): ShotObject => {
    const moved = state.transforms[name];
    if (moved?.position) return moved as ShotObject;
    const found = locate?.(name);
    if (!found)
      throw new RangeError(`No object '${name}' for a shot; key its position on a transform track or pass locate`);
    return found;
  };
  const shoot = (camera: VirtualCamera, local: number, state: CutsceneState, track: string): CameraState => {
    if (camera.keys) return cameraAt(camera.keys, keyEases(camera), camera.path ?? 'catmull-rom', local, track);
    let position: readonly number[], target: readonly number[];
    let fov = camera.fov,
      roll = camera.roll;
    if (camera.live !== undefined) {
      if (!Object.hasOwn(live, camera.live))
        throw new RangeError(`No live camera '${camera.live}' for a shot; pass it in the live option`);
      const seen = live[camera.live]();
      position = seen.position;
      target = seen.target;
      fov ??= seen.fov;
      roll ??= seen.roll;
    } else {
      position = camera.position ?? [0, 0, 0];
      target = camera.target ?? [0, 0, 0];
      if (camera.follow !== undefined) {
        const object = find(camera.follow, state),
          turned = camera.followRotation && object.rotation ? rotate(position, object.rotation) : position;
        position = [object.position[0] + turned[0], object.position[1] + turned[1], object.position[2] + turned[2]];
      }
      if (camera.lookAt !== undefined) {
        const aim = find(camera.lookAt, state).position,
          offset = camera.lookOffset ?? [0, 0, 0];
        target = [aim[0] + offset[0], aim[1] + offset[1], aim[2] + offset[2]];
      }
    }
    return {
      position: [position[0], position[1], position[2]],
      target: [target[0], target[1], target[2]],
      fov: fov ?? 60,
      roll: roll ?? 0,
      up: rolledUp(position, target, roll ?? 0),
      track,
    };
  };
  return {
    type: 'shot',
    validate,
    instants(raw): TrackInstant[] {
      return (raw as unknown as ShotTrack).clips.flatMap((clip) => [
        { time: clip.start, kind: 'enter' as const, name: clip.camera, clip },
        { time: clip.start + clip.duration, kind: 'exit' as const, name: clip.camera, clip },
      ]);
    },
    evaluate(raw, t, state, path): void {
      const { cameras, clips } = raw as unknown as ShotTrack;
      const extras = (state.extras ??= {});
      if (extras.shot || !clips.length) return;
      let index = 0;
      while (index + 1 < clips.length && clips[index + 1].start <= t) index++;
      const clip = clips[index],
        at = (shot: ShotClip): number => (shot.offset ?? 0) + Math.max(0, t - shot.start) * (shot.speed ?? 1),
        own = shoot(cameras[clip.camera], at(clip), state, path),
        into = t - clip.start,
        blending = index > 0 && clip.blendIn !== undefined && into < clip.blendIn;
      if (!blending) {
        state.camera = own;
        extras.shot = { camera: clip.camera, weight: 1, track: path } satisfies ShotState;
        return;
      }
      const before = clips[index - 1],
        weight = easing(clip.ease ?? 'smoothstep')(into / clip.blendIn!);
      state.camera = blendCameras(
        shoot(cameras[before.camera], at(before), state, path),
        own,
        weight,
        clip.blend ?? 'direct',
        path,
      );
      extras.shot = { camera: clip.camera, from: before.camera, weight, track: path } satisfies ShotState;
    },
  };
}

const rotate = (v: readonly number[], q: readonly number[]): number[] => {
  const out = [v[0], v[1], v[2]];
  return rotateByQuaternion(out, q, out) as number[];
};

/** Which shot a state shows, or null when it has no shot track. */
export function shotOf(state: CutsceneState): ShotState | null {
  return (state.extras?.shot as ShotState | undefined) ?? null;
}
