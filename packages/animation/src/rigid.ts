// Rigid binding: whole meshes posed by keys of their own, attached one mesh per bone at a time, compiled into
// stepped bone tracks so playback and export share one clip.
import { conjugateQuaternion, multiplyQuaternions, normalizeQuaternion } from '@margoengine/math/quat';
import { createKeyframeClip, type Keyframe, type KeyframeClip, type KeyframeTrackData } from './keyframes.js';

/** A bone of a rigid rig: its id (the track target) and its rest translation. */
export interface RigidBone {
  id: string;
  translation: readonly [number, number, number];
}

/** A mesh rigidly bound to a bone, with the rest pose its keys are measured from. */
export interface RigidBinding {
  /** The mesh's id, as named by its keys. */
  object: string;
  /** The bone that carries it. One bone may carry several meshes. */
  bone: string;
  /** Rest position. */
  position: readonly [number, number, number];
  /** Rest rotation as a quaternion `[x, y, z, w]`. */
  rotation: readonly [number, number, number, number];
}

/** A keyed pose of a bound mesh. */
export interface RigidKey {
  object: string;
  /** Seconds, >= 0. Keys need not be sorted; among equal times the later key wins. */
  time: number;
  position: readonly [number, number, number];
  rotation: readonly [number, number, number, number];
}

/** Options for {@link compileRigidClip}. */
export interface RigidClipOptions {
  /** Clip name. */
  name?: string;
  /** Seconds; when past the last key, the last pose is held until then. */
  duration?: number;
}

/**
 * Compiles keys of rigidly bound meshes into stepped bone translation and rotation tracks. Each bone follows one of
 * its meshes: the first in binding order that has been keyed so far. A key moves the bone by the mesh's offset from
 * its rest position (`bone.translation + key.position - rest.position`) and rotates it by
 * `key.rotation * inverse(rest.rotation)`. A bone whose first key is after 0 starts at rest; bones without keyed
 * meshes get no tracks. Keys of unbound meshes are ignored.
 * @throws TypeError for malformed bones, bindings or keys, or a binding to an unknown bone or a mesh bound twice;
 * RangeError for a non-finite or negative time or value.
 */
export function compileRigidClip(
  bones: readonly RigidBone[],
  bindings: readonly RigidBinding[],
  keys: readonly RigidKey[],
  options: RigidClipOptions = {},
): KeyframeClip {
  if (!Array.isArray(bones) || !Array.isArray(bindings) || !Array.isArray(keys))
    throw new TypeError('compileRigidClip needs arrays of bones, bindings and keys');
  const vector = (value: unknown, width: number, label: string): number[] => {
    const list = value as ArrayLike<unknown> | undefined;
    if (typeof list !== 'object' || list === null || list.length !== width)
      throw new TypeError(`${label} needs ${width} numbers`);
    if (!Array.from(list).every((v) => typeof v === 'number' && Number.isFinite(v)))
      throw new RangeError(`${label} must be finite numbers`);
    return Array.from(list as ArrayLike<number>);
  };
  const boneIds = new Set<string>();
  for (const bone of bones) {
    if (typeof bone?.id !== 'string' || !bone.id) throw new TypeError('Every rigid bone needs a nonempty string id');
    vector(bone.translation, 3, `Bone ${bone.id} translation`);
    boneIds.add(bone.id);
  }
  const bound = new Map<string, RigidBinding>(),
    peers = new Map<string, string[]>();
  for (const binding of bindings) {
    if (typeof binding?.object !== 'string' || bound.has(binding.object))
      throw new TypeError(`Binding for ${String(binding?.object)} is missing or repeated; bind each mesh once`);
    if (!boneIds.has(binding.bone))
      throw new TypeError(`Binding for ${binding.object} names unknown bone ${binding.bone}; bind it to a listed bone`);
    vector(binding.position, 3, `Binding ${binding.object} position`);
    vector(binding.rotation, 4, `Binding ${binding.object} rotation`);
    bound.set(binding.object, binding);
    peers.set(binding.bone, [...(peers.get(binding.bone) ?? []), binding.object]);
  }
  const keysByBone = new Map<string, RigidKey[]>();
  for (const key of keys) {
    if (typeof key?.object !== 'string') throw new TypeError('Every rigid key needs a string object');
    if (typeof key.time !== 'number' || !Number.isFinite(key.time) || key.time < 0)
      throw new RangeError(`Key of ${key.object} needs a finite time of 0 or more`);
    vector(key.position, 3, `Key of ${key.object} position`);
    vector(key.rotation, 4, `Key of ${key.object} rotation`);
    const binding = bound.get(key.object);
    if (binding) keysByBone.set(binding.bone, [...(keysByBone.get(binding.bone) ?? []), key]);
  }
  const { name, duration } = options;
  if (duration !== undefined && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0))
    throw new RangeError('duration must be a finite number of seconds, 0 or more');
  const tracks: KeyframeTrackData[] = [];
  for (const bone of bones) {
    // Stable sort keeps authored order among equal times, so the later key wins below.
    const ordered = [...(keysByBone.get(bone.id) ?? [])].sort((a, b) => a.time - b.time);
    if (!ordered.length) continue;
    const order = new Map((peers.get(bone.id) ?? []).map((object, index) => [object, index])),
      objects = peers.get(bone.id)!,
      held = new Map<string, RigidKey>(),
      positions: Keyframe[] = [],
      rotations: Keyframe[] = [];
    if (ordered[0].time > 0) {
      positions.push({ time: 0, value: bone.translation, interpolation: 'discrete' });
      rotations.push({ time: 0, value: [0, 0, 0, 1], interpolation: 'discrete' });
    }
    let owner = Infinity;
    for (let index = 0; index < ordered.length; ) {
      const time = ordered[index].time;
      while (index < ordered.length && ordered[index].time === time) {
        const key = ordered[index++];
        held.set(key.object, key);
        owner = Math.min(owner, order.get(key.object)!);
      }
      // A later key of an earlier-bound mesh takes the bone over from the one that was following.
      const rest = bound.get(objects[owner])!,
        key = held.get(rest.object)!;
      positions.push({
        time,
        value: [0, 1, 2].map((i) => bone.translation[i] + (key.position[i] - rest.position[i])),
        interpolation: 'discrete',
      });
      rotations.push({
        time,
        value: multiplyQuaternions(
          normalizeQuaternion(key.rotation),
          conjugateQuaternion(normalizeQuaternion(rest.rotation)),
        ),
        interpolation: 'discrete',
      });
    }
    if (duration !== undefined && duration > ordered[ordered.length - 1].time) {
      positions.push({ ...positions[positions.length - 1], time: duration });
      rotations.push({ ...rotations[rotations.length - 1], time: duration });
    }
    tracks.push(
      { target: bone.id, path: 'translation', keys: positions },
      { target: bone.id, path: 'rotation', keys: rotations },
    );
  }
  return createKeyframeClip(name === undefined ? { tracks } : { name, tracks });
}
