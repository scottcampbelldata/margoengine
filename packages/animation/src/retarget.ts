import { PBRModel } from '@margoengine/gltf-pro';
import { createKeyframeClip, sampleKeyframes, type KeyframeClip, type KeyframeTrackData } from './keyframes.js';
import { Skeleton, type BonePose } from './skin.js';
import { normalizeQuaternion } from '@margoengine/math/quat';

const rotation = [0, 0, 0, 0]; // normalizeQuaternion scratch

/**
 * A bone hierarchy and its rest pose, as {@link Retarget} reads it. Make one with {@link retargetRig} from a
 * `Skeleton` (bones) or a glTF-pro model (every node, so armature and mesh nodes count toward bone orientations).
 */
export interface RetargetRig {
  /** Bone names; a bone's index is its position here (a model's node index). */
  readonly names: readonly string[];
  /** Parent bone per bone, -1 at the top. */
  readonly parents: readonly number[];
  /** Rest local pose, 10 numbers per bone: translation xyz, rotation quaternion xyzw, scale xyz. */
  readonly rest: Float64Array;
}
/** Options for {@link Retarget}. */
export interface RetargetOptions {
  /**
   * Target bone name to source bone name. A target bone that is not listed follows the source bone of the same name,
   * when there is one. Map a target bone to `''` to leave it at rest.
   */
  names?: Readonly<Record<string, string>>;
  /** The target bone whose position follows the source's (the hips). Default: none, every bone keeps its rest position. */
  hip?: string;
  /**
   * Scale on the hip's movement from rest. Default: the target hip's rest height (y in model or skeleton space) over
   * the source hip's, or 1 when either is not above 0.
   */
  hipScale?: number;
}
/** A glTF-pro model's player, such as an `Animation`, whose clip {@link Retarget.clip} can sample. */
export interface RetargetPlayer {
  readonly model: PBRModel;
  readonly clips: readonly { readonly name: string; readonly duration: number }[];
  clip: number;
  time: number;
  playing: boolean;
  play(clip: number): unknown;
  seek(time: number): unknown;
}

/** World rotations (4 numbers per bone), positions and scales (3 per bone) of one rig. */
interface Space {
  readonly rotation: Float64Array;
  readonly position: Float64Array;
  readonly scale: Float64Array;
}
const space = (rig: RetargetRig): Space => ({
  rotation: new Float64Array(rig.names.length * 4),
  position: new Float64Array(rig.names.length * 3),
  scale: new Float64Array(rig.names.length * 3),
});

/** One rig's bones in parent-before-child order, checked. */
function order(rig: RetargetRig, label: string): number[] {
  const { names, parents, rest } = rig ?? {},
    n = names?.length;
  if (!Array.isArray(names) || !Array.isArray(parents) || parents.length !== n || !(rest instanceof Float64Array))
    throw new TypeError(`Retarget ${label} needs a rig with names, parents and rest; make it with retargetRig`);
  if (rest.length !== n * 10 || !rest.every(Number.isFinite))
    throw new RangeError(`Retarget ${label} rest pose needs 10 finite numbers per bone`);
  const children = parents.map(() => [] as number[]),
    out: number[] = [];
  parents.forEach((parent, i) => {
    if (!Number.isInteger(parent) || parent < -1 || parent >= n || parent === i)
      throw new RangeError(`Retarget ${label} bone ${i} parent ${parent} is invalid; use -1 or another bone's index`);
    if (parent >= 0) children[parent].push(i);
  });
  for (const stack = parents.flatMap((p, i) => (p < 0 ? [i] : [])); stack.length; ) {
    const bone = stack.pop()!;
    out.push(bone);
    stack.push(...children[bone]);
  }
  if (out.length !== n)
    throw new RangeError(`Retarget ${label} parents form a cycle; every chain must reach a top bone`);
  return out;
}

// Quaternions and vectors in Float64Arrays at offsets; results go through locals so outputs may alias inputs.
function multiply(o: Float64Array, oi: number, a: Float64Array, ai: number, b: Float64Array, bi: number): void {
  const ax = a[ai],
    ay = a[ai + 1],
    az = a[ai + 2],
    aw = a[ai + 3],
    bx = b[bi],
    by = b[bi + 1],
    bz = b[bi + 2],
    bw = b[bi + 3];
  o[oi] = aw * bx + ax * bw + ay * bz - az * by;
  o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
/** o = conjugate(a) * b: a unit quaternion's inverse times b. */
function divide(o: Float64Array, oi: number, a: Float64Array, ai: number, b: Float64Array, bi: number): void {
  const ax = -a[ai],
    ay = -a[ai + 1],
    az = -a[ai + 2],
    aw = a[ai + 3],
    bx = b[bi],
    by = b[bi + 1],
    bz = b[bi + 2],
    bw = b[bi + 3];
  o[oi] = aw * bx + ax * bw + ay * bz - az * by;
  o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
/** o = q rotating (x, y, z), or its inverse when `inverse`. */
function rotate(
  o: Float64Array,
  oi: number,
  q: Float64Array,
  qi: number,
  x: number,
  y: number,
  z: number,
  inverse = false,
): void {
  const s = inverse ? -1 : 1,
    qx = q[qi] * s,
    qy = q[qi + 1] * s,
    qz = q[qi + 2] * s,
    qw = q[qi + 3],
    tx = 2 * (qy * z - qz * y),
    ty = 2 * (qz * x - qx * z),
    tz = 2 * (qx * y - qy * x);
  o[oi] = x + qw * tx + qy * tz - qz * ty;
  o[oi + 1] = y + qw * ty + qz * tx - qx * tz;
  o[oi + 2] = z + qw * tz + qx * ty - qy * tx;
}
/** World rotation (4 per bone), position and scale (3 per bone) of a local pose (10 per bone), parents first. */
function world(
  bones: readonly number[],
  parents: readonly number[],
  local: Float64Array,
  rotation: Float64Array,
  position: Float64Array,
  scale: Float64Array,
): void {
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i],
      p = parents[b],
      l = b * 10;
    if (p < 0) {
      for (let c = 0; c < 3; c++) (position[b * 3 + c] = local[l + c]), (scale[b * 3 + c] = local[l + 7 + c]);
      for (let c = 0; c < 4; c++) rotation[b * 4 + c] = local[l + 3 + c];
      continue;
    }
    multiply(rotation, b * 4, rotation, p * 4, local, l + 3);
    rotate(
      position,
      b * 3,
      rotation,
      p * 4,
      scale[p * 3] * local[l],
      scale[p * 3 + 1] * local[l + 1],
      scale[p * 3 + 2] * local[l + 2],
    );
    for (let c = 0; c < 3; c++) {
      position[b * 3 + c] += position[p * 3 + c];
      scale[b * 3 + c] = scale[p * 3 + c] * local[l + 7 + c];
    }
  }
}
/** Writes the current local pose of a Skeleton's bones or a model's nodes into `out`, 10 numbers each. */
function read(from: Skeleton | PBRModel, count: number, label: string, out: Float64Array): void {
  if (from instanceof Skeleton) {
    if (from.count !== count)
      throw new RangeError(
        `Retarget ${label} has ${from.count} bones but its rig has ${count}; use a source with the rig's bone count`,
      );
    for (let b = 0; b < count; b++) {
      const { translation, rotation, scale } = from.getPose(b);
      out.set(translation, b * 10);
      out.set(rotation, b * 10 + 3);
      out.set(scale, b * 10 + 7);
    }
    return;
  }
  if (!(from instanceof PBRModel)) throw new TypeError(`Retarget ${label} must be a Skeleton or a glTF-pro model`);
  if (from.nodes.length !== count)
    throw new RangeError(`Retarget ${label} has ${from.nodes.length} nodes but its rig ${count}; use its own rig`);
  const t = from.root.engine.store.transforms;
  for (let b = 0; b < count; b++) {
    const id = from.nodes[b].id,
      o = b * 10;
    out[o] = t.x[id];
    out[o + 1] = t.y[id];
    out[o + 2] = t.z[id];
    out[o + 3] = t.qx[id];
    out[o + 4] = t.qy[id];
    out[o + 5] = t.qz[id];
    out[o + 6] = t.qw[id];
    out[o + 7] = t.sx[id];
    out[o + 8] = t.sy[id];
    out[o + 9] = t.sz[id];
  }
}

/**
 * The bones and current local pose of a `Skeleton`, or of every node of a glTF-pro model (names, parents and the
 * nodes' local transforms), as a {@link RetargetRig}. The current pose becomes the rig's rest pose, the reference both
 * rigs are compared in, so pose both characters the same way (both in T-pose, say) before making their rigs.
 */
export function retargetRig(from: Skeleton | PBRModel): RetargetRig {
  if (from instanceof Skeleton) {
    const rest = new Float64Array(from.count * 10);
    read(from, from.count, 'skeleton', rest);
    return { names: from.names, parents: from.parents, rest };
  }
  if (!(from instanceof PBRModel)) throw new TypeError('retargetRig needs a Skeleton or a glTF-pro model');
  const ids = new Map(from.nodes.map((node, i) => [node.id, i])),
    parents = from.root.engine.store.parents,
    rest = new Float64Array(from.nodes.length * 10);
  read(from, from.nodes.length, 'model', rest);
  return {
    names: from.nodes.map((node) => node.name),
    parents: from.nodes.map((node) => ids.get(parents[node.id]) ?? -1),
    rest,
  };
}

/**
 * Retargeting: moves one skeleton the way another moves, bone by bone. Each
 * mapped target bone turns in model space by the same rotation its source bone has turned from rest, which absorbs
 * different bone axes and rest orientations: target world rotation = source world rotation x inverse(source rest
 * world rotation) x target rest world rotation. Unmapped target bones keep their rest local rotation, every bone keeps
 * its rest length and scale, and the `hip` bone's position follows the source hip's movement from rest times
 * `hipScale`. Both rigs' model spaces are assumed to face the same way.
 */
export class Retarget {
  /** Source bone per target bone, -1 where the target bone is not mapped. */
  readonly map: Int32Array;
  /** Target hip bone index, or -1. */
  readonly hip: number;
  /** Source bone the hip follows, or -1. */
  readonly sourceHip: number;
  /** Scale applied to the hip's movement. */
  readonly hipScale: number;
  private readonly sourceOrder: number[];
  private readonly targetOrder: number[];
  // Rest world transforms, and scratch for the current pose; all reused, so `pose` allocates nothing.
  private readonly sourceRest: Space;
  private readonly targetRest: Space;
  private readonly sourceNow: Space;
  private readonly targetNow: Space;
  private readonly delta = new Float64Array(4);
  private readonly input: Float64Array;
  private readonly output: Float64Array;
  private readonly poses: BonePose[];
  private readonly quaternion = [0, 0, 0, 1];
  private readonly vector: [number, number, number] = [0, 0, 0];

  constructor(
    readonly source: RetargetRig,
    readonly target: RetargetRig,
    options: RetargetOptions = {},
  ) {
    this.sourceOrder = order(source, 'source');
    this.targetOrder = order(target, 'target');
    const names = options.names ?? {};
    if (typeof names !== 'object')
      throw new TypeError('Retarget names must map target bone names to source bone names');
    for (const [to, from] of Object.entries(names))
      if (typeof from !== 'string' || (from && !source.names.includes(from)))
        throw new RangeError(`Retarget maps ${to} to ${from}, which the source does not have; fix the names map`);
    // A listed bone maps to its entry ('' for none); an unlisted one by equal name. Unnamed glTF nodes need an entry.
    const mapped = (name: string) => (Object.hasOwn(names, name) ? names[name] : name);
    this.map = Int32Array.from(target.names, (name) => (mapped(name) ? source.names.indexOf(mapped(name)) : -1));
    if (!this.map.some((s) => s >= 0))
      throw new RangeError('Retarget maps no bones; pass a names map or use rigs with matching bone names');
    this.sourceNow = space(source);
    this.targetNow = space(target);
    const sourceRest = (this.sourceRest = space(source)),
      targetRest = (this.targetRest = space(target));
    world(this.sourceOrder, source.parents, source.rest, sourceRest.rotation, sourceRest.position, sourceRest.scale);
    world(this.targetOrder, target.parents, target.rest, targetRest.rotation, targetRest.position, targetRest.scale);
    this.hip = options.hip === undefined ? -1 : target.names.indexOf(options.hip);
    if (options.hip !== undefined && this.hip < 0)
      throw new RangeError(`Retarget hip ${options.hip} is not a target bone; pass the target's hip bone name`);
    this.sourceHip = this.hip < 0 ? -1 : this.map[this.hip];
    if (this.hip >= 0 && this.sourceHip < 0)
      throw new RangeError(`Retarget hip ${options.hip} has no source bone; map it in names`);
    const sourceHeight = this.sourceHip < 0 ? 0 : sourceRest.position[this.sourceHip * 3 + 1],
      targetHeight = this.hip < 0 ? 0 : targetRest.position[this.hip * 3 + 1],
      scale = options.hipScale ?? (sourceHeight > 0 && targetHeight > 0 ? targetHeight / sourceHeight : 1);
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)
      throw new RangeError(`Retarget hipScale ${scale} is invalid; pass a finite number > 0`);
    this.hipScale = scale;
    this.input = new Float64Array(source.names.length * 10);
    this.output = new Float64Array(target.names.length * 10);
    this.poses = target.names.map((_, b) => ({
      rotation: this.output.subarray(b * 10 + 3, b * 10 + 7) as unknown as BonePose['rotation'],
      ...(b === this.hip
        ? { translation: this.output.subarray(b * 10, b * 10 + 3) as unknown as BonePose['translation'] }
        : {}),
    }));
  }

  /**
   * The target's local pose (10 numbers per target bone, as in {@link RetargetRig.rest}) for a source local pose
   * (10 per source bone). Unmapped target bones get their rest pose.
   */
  pose(source: Float64Array, out: Float64Array = new Float64Array(this.target.names.length * 10)): Float64Array {
    if (!(source instanceof Float64Array) || source.length !== this.source.names.length * 10)
      throw new TypeError(`Retarget pose needs a Float64Array of ${this.source.names.length * 10} numbers`);
    if (!(out instanceof Float64Array) || out.length !== this.target.names.length * 10)
      throw new TypeError(`Retarget output needs a Float64Array of ${this.target.names.length * 10} numbers`);
    const s = this.sourceNow,
      t = this.targetNow,
      { parents, rest } = this.target,
      d = this.delta;
    world(this.sourceOrder, this.source.parents, source, s.rotation, s.position, s.scale);
    out.set(rest);
    for (let i = 0; i < this.targetOrder.length; i++) {
      const b = this.targetOrder[i],
        p = parents[b],
        from = this.map[b],
        l = b * 10;
      if (from >= 0) {
        // World delta of the source bone from rest, applied to the target bone's rest world rotation.
        divide(d, 0, this.sourceRest.rotation, from * 4, this.targetRest.rotation, b * 4);
        multiply(t.rotation, b * 4, s.rotation, from * 4, d, 0);
        if (p < 0) for (let c = 0; c < 4; c++) out[l + 3 + c] = t.rotation[b * 4 + c];
        else divide(out, l + 3, t.rotation, p * 4, t.rotation, b * 4);
        for (let c = 0; c < 4; c++) rotation[c] = out[l + 3 + c];
        out.set(normalizeQuaternion(rotation, rotation), l + 3);
      }
      if (b === this.hip) {
        // The hip's new model-space position, then back into its parent's space.
        const k = this.hipScale,
          h = this.sourceHip * 3,
          x = this.targetRest.position[b * 3] + k * (s.position[h] - this.sourceRest.position[h]),
          y = this.targetRest.position[b * 3 + 1] + k * (s.position[h + 1] - this.sourceRest.position[h + 1]),
          z = this.targetRest.position[b * 3 + 2] + k * (s.position[h + 2] - this.sourceRest.position[h + 2]);
        if (p < 0) (out[l] = x), (out[l + 1] = y), (out[l + 2] = z);
        else {
          rotate(
            out,
            l,
            t.rotation,
            p * 4,
            x - t.position[p * 3],
            y - t.position[p * 3 + 1],
            z - t.position[p * 3 + 2],
            true,
          );
          for (let c = 0; c < 3; c++) out[l + c] /= t.scale[p * 3 + c];
        }
      }
      // This bone's world transform for its children, from the pose just written.
      if (p < 0) {
        for (let c = 0; c < 3; c++) (t.position[b * 3 + c] = out[l + c]), (t.scale[b * 3 + c] = out[l + 7 + c]);
        for (let c = 0; c < 4; c++) t.rotation[b * 4 + c] = out[l + 3 + c];
      } else {
        multiply(t.rotation, b * 4, t.rotation, p * 4, out, l + 3);
        rotate(
          t.position,
          b * 3,
          t.rotation,
          p * 4,
          t.scale[p * 3] * out[l],
          t.scale[p * 3 + 1] * out[l + 1],
          t.scale[p * 3 + 2] * out[l + 2],
        );
        for (let c = 0; c < 3; c++) {
          t.position[b * 3 + c] += t.position[p * 3 + c];
          t.scale[b * 3 + c] = t.scale[p * 3 + c] * out[l + 7 + c];
        }
      }
    }
    return out;
  }

  /**
   * Poses `target` the way `source` is posed now: each must be the Skeleton or model its rig was made from. Writes
   * only the mapped bones' rotations and the hip's position; other target bones keep what they have (the retarget
   * assumes them at rest).
   */
  apply(source: Skeleton | PBRModel, target: Skeleton | PBRModel): void {
    read(source, this.source.names.length, 'source', this.input);
    const out = this.pose(this.input, this.output);
    if (target instanceof Skeleton) {
      if (target.count !== this.target.names.length)
        throw new RangeError(
          `Retarget target has ${target.count} bones but its rig has ${this.target.names.length}; pass a target with the rig's bone count`,
        );
      for (let b = 0; b < this.map.length; b++)
        if (this.map[b] >= 0 || b === this.hip) target.setPose(b, this.poses[b]);
      return;
    }
    if (!(target instanceof PBRModel)) throw new TypeError('Retarget target must be a Skeleton or a glTF-pro model');
    if (target.nodes.length !== this.target.names.length)
      throw new RangeError(
        `Retarget target has ${target.nodes.length} nodes but its rig has ${this.target.names.length}; pass a model with the rig's node count`,
      );
    const q = this.quaternion,
      v = this.vector;
    for (let b = 0; b < this.map.length; b++) {
      if (this.map[b] >= 0) {
        for (let c = 0; c < 4; c++) q[c] = out[b * 10 + 3 + c];
        target.nodes[b].setQuaternion(q);
      }
      if (b === this.hip) {
        for (let c = 0; c < 3; c++) v[c] = out[b * 10 + c];
        target.nodes[b].setPosition(v);
      }
    }
  }

  /**
   * A code-authored clip for the target rig from a source clip, sampled at `fps` (default 30) from 0 to the clip's
   * duration: a rotation track per mapped target bone and a translation track for the hip, linear keys. The source
   * is a `KeyframeClip` whose tracks name source bones (sampled over the source rig's rest pose; weights tracks are
   * not carried over), or a glTF clip played by the source model's `Animation` (`{animation, clip}`; its clip, time and
   * playing state are restored afterwards). Play the result with `applyKeyframeClip` or an `AnimationGroup`.
   */
  clip(
    source: KeyframeClip | { readonly animation: RetargetPlayer; readonly clip: string | number },
    { fps = 30, name }: { fps?: number; name?: string } = {},
  ): KeyframeClip {
    if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0 || fps > 1000)
      throw new RangeError(`Retarget clip fps ${fps} is invalid; pass frames per second from 0 to 1000`);
    const input = this.input,
      bones = this.source.names.length;
    let duration: number,
      label: string,
      sample: (time: number) => void,
      finish = () => {};
    if ('tracks' in source && Array.isArray(source.tracks)) {
      const clip = source,
        tracks = clip.tracks.filter((track) => track.path !== 'weights' && this.source.names.includes(track.target)),
        at = tracks.map((track) => this.source.names.indexOf(track.target) * 10),
        value = new Float64Array(4);
      duration = clip.duration;
      label = clip.name;
      sample = (time) => {
        input.set(this.source.rest);
        tracks.forEach((track, i) => {
          const v = sampleKeyframes(track, time, value),
            o = at[i] + (track.path === 'translation' ? 0 : track.path === 'rotation' ? 3 : 7);
          for (let c = 0; c < (track.path === 'rotation' ? 4 : 3); c++) input[o + c] = v[c];
        });
      };
    } else {
      const { animation, clip } = source as { animation: RetargetPlayer; clip: string | number },
        model = animation?.model;
      if (!(model instanceof PBRModel) || !Array.isArray(animation.clips) || typeof animation.seek !== 'function')
        throw new TypeError('Retarget clip needs a KeyframeClip or {animation, clip} with an Animation');
      const index = typeof clip === 'string' ? animation.clips.findIndex((c) => c.name === clip) : clip;
      if (!Number.isInteger(index) || index < 0 || index >= animation.clips.length)
        throw new RangeError(
          `Retarget clip ${clip} is not one of the source model's clips; pass a name or index it has`,
        );
      const saved = { clip: animation.clip, time: animation.time, playing: animation.playing };
      duration = animation.clips[index].duration;
      label = animation.clips[index].name;
      animation.play(index);
      sample = (time) => {
        animation.seek(time);
        read(model, bones, 'source', input);
      };
      finish = () => {
        animation.play(saved.clip);
        animation.seek(saved.time);
        animation.playing = saved.playing;
      };
    }
    const frames = Math.max(1, Math.ceil(duration * fps)),
      mapped = Array.from(this.map.keys()).filter((b) => this.map[b] >= 0),
      rotations = mapped.map(() => [] as { time: number; value: number[] }[]),
      hip: { time: number; value: number[] }[] = [],
      out = this.output;
    try {
      for (let f = 0; f <= frames; f++) {
        const time = (duration * f) / frames;
        sample(time);
        this.pose(input, out);
        mapped.forEach((b, i) => rotations[i].push({ time, value: Array.from(out.subarray(b * 10 + 3, b * 10 + 7)) }));
        if (this.hip >= 0) hip.push({ time, value: Array.from(out.subarray(this.hip * 10, this.hip * 10 + 3)) });
        if (duration === 0) break;
      }
    } finally {
      finish();
    }
    const tracks: KeyframeTrackData[] = mapped.map((b, i) => ({
      target: this.target.names[b],
      path: 'rotation',
      keys: rotations[i],
    }));
    if (this.hip >= 0) tracks.push({ target: this.target.names[this.hip], path: 'translation', keys: hip });
    const names = new Set<string>();
    for (const track of tracks)
      if (names.has(track.target + track.path))
        throw new RangeError(`Retarget target rig repeats bone name ${track.target}; give target bones unique names`);
      else names.add(track.target + track.path);
    return createKeyframeClip({ name: name ?? label, tracks });
  }
}
