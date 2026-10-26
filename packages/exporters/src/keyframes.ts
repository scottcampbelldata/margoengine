// Held-key animation for plain data scenes: document frames to Float32 key times, transform tracks with quaternion
// continuity, topology-changing geometry cels shown one at a time by STEP scale channels, and retained instance
// placements sampled per key. Each helper sets the nodes' rest pose to the first key (what a viewer that does not play
// the animation shows) and returns the channels to put in an ExportScene animation.
import { decompose, isObject, savedRotation, type AnimationChannelData, type ExportNode } from './scene.js';

/** Document frames of a held-key clip: `frames` are the keys, played at `fps`, the last held until `end`. */
export interface FrameClip {
  /** Frames per second, finite and > 0. */
  fps: number;
  /** Key frames: whole numbers, strictly increasing, at most 65,536. The first plays at time 0. */
  frames: readonly number[];
  /** The frame after the last held one (end exclusive), > the last key. Default the last key + 1. */
  end?: number;
}

/** A local pose: translation [x, y, z], rotation quaternion [x, y, z, w] and scale [x, y, z]. */
export interface FramePose {
  translation?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
}

type Path = 'translation' | 'rotation' | 'scale';
const MAX_KEYS = 65536,
  MAX_SAMPLES = 1 << 20;

/**
 * Key times in seconds: one per key, `(frame - frames[0]) / fps`, then one for `end`, all as Float32. The extra last
 * time holds the final key until the clip ends, so the clip lasts `(end - frames[0]) / fps`.
 * @throws RangeError for a bad fps or frame, or when two times round to the same Float32 (trim or split the clip).
 */
export function frameTimes(clip: FrameClip): Float32Array {
  if (!isObject(clip)) throw new TypeError('Frame clip must be an object with fps and frames');
  const { fps, frames } = clip;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0)
    throw new RangeError(`Clip fps ${fps} must be finite and > 0`);
  if (!Array.isArray(frames) || !frames.length || frames.length > MAX_KEYS)
    throw new RangeError(`Clip frames must hold 1 to ${MAX_KEYS} keys`);
  const end = clip.end ?? frames[frames.length - 1] + 1,
    times = new Float32Array(frames.length + 1);
  for (let i = 0; i <= frames.length; i++) {
    const frame = i < frames.length ? frames[i] : end;
    if (!Number.isSafeInteger(frame) || (i > 0 && frame <= frames[i - 1]))
      throw new RangeError('Clip frames and end must be whole numbers, strictly increasing; sort the keys');
    times[i] = (frame - frames[0]) / fps;
    if (!Number.isFinite(times[i]) || (i > 0 && times[i] <= times[i - 1]))
      throw new RangeError('Clip times collapse in Float32 (glTF key times); trim or split the frame range');
  }
  return times;
}

/**
 * Every whole frame from `first` to `last`, as a clip that ends after `last`: for motion that changes between keys
 * (local object clocks, procedural motion), sampled once per document frame and held with STEP.
 * @throws RangeError when the range is empty or longer than `maxFrames` (default 4096).
 */
export function sampleFrames(first: number, last: number, fps: number, maxFrames = 4096): FrameClip {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first)
    throw new RangeError('Sample range needs whole frames with first <= last');
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > MAX_KEYS)
    throw new RangeError(`maxFrames must be a whole number from 1 to ${MAX_KEYS}`);
  if (last - first + 1 > maxFrames)
    throw new RangeError(`Sampling ${last - first + 1} frames exceeds ${maxFrames}; trim or split the clip`);
  return { fps, frames: Array.from({ length: last - first + 1 }, (_, i) => first + i), end: last + 1 };
}

function samples(clip: FrameClip, count: number, label: string): Float32Array {
  const times = frameTimes(clip);
  if (count !== clip.frames.length)
    throw new RangeError(`${label} needs one value per clip key (${clip.frames.length})`);
  return times;
}

function vector(value: unknown, size: number, label: string): number[] {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new TypeError(`${label} must be an array of ${size}`);
  const out = Array.from(value as ArrayLike<number>);
  if (out.length !== size || out.some((v) => typeof v !== 'number' || !Number.isFinite(Math.fround(v))))
    throw new RangeError(`${label} must be ${size} finite Float32 numbers`);
  return out;
}

function animatable(node: ExportNode, label: string): void {
  if (!isObject(node)) throw new TypeError(`${label} must be a scene node`);
  if (node.matrix !== undefined)
    throw new TypeError(`${label} has a matrix; animated nodes need translation, rotation and scale`);
}

/** Channel for one path: a value per key, the last repeated at the end time; rotations stay on one hemisphere. */
function channel(
  node: ExportNode,
  path: Path,
  times: Float32Array,
  values: number[][],
  interpolation: 'STEP' | 'LINEAR',
): AnimationChannelData {
  const keys = [...values, values[values.length - 1]];
  if (path === 'rotation')
    for (let i = 1; i < keys.length; i++)
      if (keys[i].reduce((sum, v, axis) => sum + v * keys[i - 1][axis], 0) < 0) keys[i] = keys[i].map((v) => -v);
  return { node, path, interpolation, times, values: keys.flat() };
}

/**
 * Transform channels from one pose per clip key: translation, rotation and scale, or the `paths` given (a
 * translation-only parent and a rotation-and-scale child, for example). Rotations are normalized and kept on one
 * hemisphere, so LINEAR keys (the default `interpolation`) turn the short way. Sets `node`'s animated paths to the
 * first key's values.
 * @throws TypeError for a node with a matrix or a pose missing an animated path; RangeError for bad values.
 */
export function animateTransforms(
  node: ExportNode,
  clip: FrameClip,
  poses: readonly FramePose[],
  {
    interpolation = 'LINEAR',
    paths = ['translation', 'rotation', 'scale'],
  }: {
    interpolation?: 'STEP' | 'LINEAR';
    paths?: readonly Path[];
  } = {},
): AnimationChannelData[] {
  animatable(node, 'Animated node');
  if (interpolation !== 'STEP' && interpolation !== 'LINEAR')
    throw new TypeError('Transform interpolation must be STEP or LINEAR');
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => !['translation', 'rotation', 'scale'].includes(p)))
    throw new TypeError('paths must list translation, rotation or scale');
  if (!Array.isArray(poses)) throw new TypeError('poses must be an array, one per clip key');
  const times = samples(clip, poses.length, 'poses'),
    tracks = [...new Set<Path>(paths)].map((path) => {
      const values = poses.map((pose, i) => {
        if (!isObject(pose) || pose[path] === undefined)
          throw new TypeError(`poses[${i}] has no ${path}; give every pose a value for each animated path`);
        const value = vector(pose[path], path === 'rotation' ? 4 : 3, `poses[${i}].${path}`);
        // The rest pose keeps the saved numbers; only the channel keys are Float32 accessor data.
        return path === 'rotation' ? savedRotation(value) : value;
      });
      return { path, values };
    });
  // Validated in full before the node changes.
  for (const { path, values } of tracks) node[path] = values[0];
  return tracks.map(({ path, values }) => channel(node, path, times, values, interpolation));
}

/**
 * Held geometry cels: `cels` are the nodes of the distinct models (banks, as `@margoengine/voxel-edit`'s packFrames
 * gives them), and `shown[k]` the one visible from clip key `k` (-1 for none). Each cel is shown at scale [1, 1, 1]
 * and hidden at [0, 0, 0] through STEP scale channels, so a topology change is a swap between sibling nodes and a bank
 * used at several keys is written once. Sets each cel's scale to its visibility at the first key; put content that
 * needs its own scale in a child of the cel.
 * @throws RangeError for a cel index out of range or more than 1,048,576 cel keys in one call.
 */
export function animateCels(
  cels: readonly ExportNode[],
  clip: FrameClip,
  shown: ArrayLike<number>,
): AnimationChannelData[] {
  if (!Array.isArray(cels) || !cels.length) throw new TypeError('cels must be a nonempty array of scene nodes');
  if (!isObject(shown) || typeof shown.length !== 'number') throw new TypeError('shown must list a cel per key');
  const times = samples(clip, shown.length, 'shown');
  if (cels.length * shown.length > MAX_SAMPLES)
    throw new RangeError(`Cels times keys exceed ${MAX_SAMPLES}; trim the clip or split the model`);
  for (let k = 0; k < shown.length; k++)
    if (!Number.isInteger(shown[k]) || shown[k] < -1 || shown[k] >= cels.length)
      throw new RangeError(`shown[${k}] must be a cel index or -1`);
  cels.forEach((cel, index) => animatable(cel, `cels[${index}]`));
  return cels.map((cel, index) => {
    const values = Array.from(shown, (key) => (key === index ? [1, 1, 1] : [0, 0, 0]));
    cel.scale = values[0];
    return channel(cel, 'scale', times, values, 'STEP');
  });
}

/**
 * A retained instance's placement per clip key: its local column-major matrix, or null where the instance is hidden
 * (written as scale [0, 0, 0] at the last visible placement). STEP translation, rotation and scale channels; sets
 * `node`'s translation, rotation and scale to the first key.
 * @throws RangeError when a matrix has shear or is not affine (keep sheared parents as separate nodes), or when the
 * instance is never visible.
 */
export function animatePlacements(
  node: ExportNode,
  clip: FrameClip,
  matrices: readonly (ArrayLike<number> | null)[],
): AnimationChannelData[] {
  animatable(node, 'Placed node');
  if (!Array.isArray(matrices)) throw new TypeError('matrices must be an array, one per clip key');
  const times = samples(clip, matrices.length, 'matrices'),
    parts = matrices.map((matrix, i) => {
      if (matrix === null) return null;
      const m = Float64Array.from(vector(matrix, 16, `matrices[${i}]`));
      if (m[3] || m[7] || m[11] || m[15] !== 1) throw new RangeError(`matrices[${i}] must be affine`);
      const trs = decompose(m);
      if (!trs) throw new RangeError(`matrices[${i}] has shear or zero scale; keep sheared parents as separate nodes`);
      return trs;
    });
  let held = parts.find((part) => part !== null);
  if (!held) throw new RangeError('The instance is never visible; leave it out');
  const poses = parts.map((part) => {
    if (part) held = part;
    return part ? { t: part.t, r: part.r, s: part.s } : { t: held!.t, r: held!.r, s: [0, 0, 0] };
  });
  // A key hidden before the first visible one takes the first visible placement.
  [node.translation, node.rotation, node.scale] = [poses[0].t, poses[0].r, poses[0].s];
  return (['translation', 'rotation', 'scale'] as const).map((path) =>
    channel(
      node,
      path,
      times,
      poses.map((pose) => (path === 'translation' ? pose.t : path === 'rotation' ? pose.r : pose.s)),
      'STEP',
    ),
  );
}
