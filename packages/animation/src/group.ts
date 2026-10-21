/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { sampleKeyframes, type KeyframeClip } from './keyframes.js';
import { Skeleton, type BonePose } from './skin.js';

/**
 * A glTF-pro model's player that an {@link AnimationGroup} drives: an `Animation` from this package fits. Its own
 * playback is paused while it is a member; the group seeks it instead.
 */
export interface AnimationGroupPlayer {
  readonly model: PBRModel;
  readonly clips: readonly { readonly name: string; readonly duration: number }[];
  readonly options: { readonly loop?: boolean };
  clip: number;
  playing: boolean;
  seek(time: number): unknown;
  setMorph(node: number, target: number, weight: number): void;
}
/** A member of an {@link AnimationGroup}: a model's `Animation`, or (for a code-authored clip) a `Skeleton`. */
export type AnimationGroupMember = AnimationGroupPlayer | Skeleton;
/** Options for {@link AnimationGroup}. */
export interface AnimationGroupOptions {
  /**
   * For a code-authored clip: wrap at its end (default true), else hold its first and last frames. A glTF clip loops
   * as each member Animation's own `loop` option says.
   */
  loop?: boolean;
  /** Clip seconds per second, finite and >= 0. Default 1. */
  speed?: number;
}

interface Member {
  readonly target: AnimationGroupMember;
  offset: number;
  /** The glTF clip index on an Animation member; -1 for a code-authored clip. */
  readonly clip: number;
  /** Code-authored clip only: one sampler and writer per track that reaches this member, given the clip time. */
  readonly bindings: readonly ((time: number) => void)[];
}

const finiteNumber = (value: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RangeError(`AnimationGroup ${label} ${value} is invalid; pass finite seconds`);
  return value;
};
let serial = 0;

/**
 * One clip and one clock driving many models, for crowds of clones. Members are
 * glTF-pro models' `Animation`s playing a clip they all have (by name or index), or, for a code-authored
 * `KeyframeClip`, `Skeleton`s and `Animation`s whose bones or nodes the tracks name. Each member may run `offset`
 * seconds ahead (negative: behind) of the group. A glTF clip plays through each member's own sampling path
 * (`animation.seek`), and a code clip through bindings resolved once in `add`, so a frame allocates nothing in the group
 * itself. Use it as an engine plugin (`engine.use(group)`; it advances in `onPreUpdate`) or call `update(delta)`.
 * A member whose model is disposed leaves the group at the next `update` or `seek`; remove a member before disposing
 * only its Animation.
 */
export class AnimationGroup implements EnginePlugin {
  readonly name = 'animation-group:' + serial++;
  /** Group time in seconds; a member plays `time + offset`. */
  time = 0;
  /** False stops `update` (and the plugin) from advancing `time`. */
  playing = true;
  private readonly members: Member[] = [];
  private engine?: Engine;
  private disposed = false;
  /**
   * @param clip A glTF clip name or index that every member Animation has, or a code-authored `KeyframeClip`.
   * @param options `loop` (code clips) and `speed`.
   */
  constructor(
    readonly clip: string | number | KeyframeClip,
    readonly options: AnimationGroupOptions = {},
  ) {
    if (typeof clip !== 'string' && typeof clip !== 'number' && !Array.isArray((clip as KeyframeClip)?.tracks))
      throw new TypeError('AnimationGroup clip must be a glTF clip name or index, or a KeyframeClip');
    if (options.loop !== undefined && typeof options.loop !== 'boolean')
      throw new TypeError('AnimationGroup loop must be a boolean');
    const speed = options.speed ?? 1;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0)
      throw new RangeError(`AnimationGroup speed ${speed} is invalid; pass a finite number >= 0`);
  }
  /** Number of members. */
  get size(): number {
    return this.members.length;
  }
  /** True when `target` is a member. */
  has(target: AnimationGroupMember): boolean {
    return this.members.some((member) => member.target === target);
  }
  /**
   * Adds a member that plays `offset` seconds ahead of the group (adding it again only changes its offset) and poses it
   * at the current time. An Animation member's own playback is paused (`playing = false`).
   */
  add(target: AnimationGroupMember, offset = 0): this {
    if (this.disposed) throw new MargoError('disposed', 'AnimationGroup is disposed; create a new group');
    finiteNumber(offset, 'offset');
    const existing = this.members.find((member) => member.target === target);
    if (existing) {
      existing.offset = offset;
      this.pose(existing);
      return this;
    }
    const clip = this.clip,
      code = typeof clip === 'object';
    let index = -1;
    if (!code) {
      const player = target as AnimationGroupPlayer;
      if (target instanceof Skeleton || !Array.isArray(player?.clips) || typeof player.seek !== 'function')
        throw new TypeError('AnimationGroup with a glTF clip needs Animation members; pass Animation.attach(model)');
      index = typeof clip === 'string' ? player.clips.findIndex((c) => c.name === clip) : clip;
      if (!Number.isInteger(index) || index < 0 || index >= player.clips.length)
        throw new RangeError(
          `AnimationGroup clip ${clip} is not one of this model's clips; pass a name or index it has`,
        );
      player.playing = false;
    }
    const member: Member = { target, offset, clip: index, bindings: code ? this.bind(clip, target) : [] };
    this.members.push(member);
    this.pose(member);
    return this;
  }
  /** Removes a member; it keeps its last pose (an Animation stays paused). */
  remove(target: AnimationGroupMember): this {
    const at = this.members.findIndex((member) => member.target === target);
    if (at >= 0) this.members.splice(at, 1);
    return this;
  }
  /** Changes a member's time offset in seconds and poses it. */
  setOffset(target: AnimationGroupMember, offset: number): this {
    const member = this.members.find((m) => m.target === target);
    if (!member) throw new RangeError('AnimationGroup member not found; add it first');
    member.offset = finiteNumber(offset, 'offset');
    this.pose(member);
    return this;
  }
  /** Sets the group time and poses every member. */
  seek(time: number): this {
    if (finiteNumber(time, 'time') < 0)
      throw new RangeError(`AnimationGroup time ${time} is invalid; pass seconds >= 0`);
    this.time = time;
    this.poseAll();
    return this;
  }
  /** Advances the group by `delta` seconds times `speed` (when playing) and poses every member. */
  update(delta: number): this {
    if (finiteNumber(delta, 'delta') < 0) throw new RangeError(`AnimationGroup delta ${delta} is invalid; pass >= 0`);
    if (this.playing) this.time += delta * (this.options.speed ?? 1);
    this.poseAll();
    return this;
  }
  /** Engine plugin hook; the group needs no GPU resources. */
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'AnimationGroup is disposed; create a new group');
    this.engine = engine;
  }
  /** Engine plugin hook: `update(delta)` before the engine updates world matrices. */
  onPreUpdate(delta: number): void {
    this.update(delta);
  }
  /** Drops every member (they keep their last pose) and detaches from the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.members.length = 0;
    this.engine?.removePlugin(this.name);
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** Poses every member; a member whose model was disposed leaves the group. */
  private poseAll(): void {
    for (let i = this.members.length - 1; i >= 0; i--) {
      const target = this.members[i].target;
      if (!(target instanceof Skeleton) && target.model.disposed) this.members.splice(i, 1);
      else this.pose(this.members[i]);
    }
  }
  private pose(member: Member): void {
    const local = this.time + member.offset;
    if (member.clip >= 0) {
      const player = member.target as AnimationGroupPlayer,
        duration = player.clips[member.clip].duration;
      // The member wraps or clamps a positive time itself; a negative one is brought into range first.
      player.clip = member.clip;
      player.seek(
        local >= 0 ? local : (player.options.loop ?? true) && duration > 0 ? (local % duration) + duration : 0,
      );
      return;
    }
    const duration = (this.clip as KeyframeClip).duration,
      time =
        (this.options.loop ?? true) && duration > 0
          ? ((local % duration) + duration) % duration
          : Math.min(Math.max(local, 0), duration);
    for (let i = 0; i < member.bindings.length; i++) member.bindings[i](time);
  }
  private bind(clip: KeyframeClip, target: AnimationGroupMember): ((time: number) => void)[] {
    const bindings: ((time: number) => void)[] = [];
    if (target instanceof Skeleton) {
      for (const track of clip.tracks) {
        const bone = track.path === 'weights' ? -1 : target.index(track.target);
        if (bone < 0) continue;
        const value = new Float64Array(track.path === 'rotation' ? 4 : 3),
          pose = { [track.path]: value } as BonePose;
        bindings.push((time) => {
          sampleKeyframes(track, time, value);
          target.setPose(bone, pose);
        });
      }
      return bindings;
    }
    const player = target as AnimationGroupPlayer,
      nodes = player?.model?.nodes;
    if (!Array.isArray(nodes) || typeof player.setMorph !== 'function')
      throw new TypeError('AnimationGroup members must be Skeletons or Animations; pass Animation.attach(model)');
    for (const track of clip.tracks) {
      const index = nodes.findIndex((node) => node.name === track.target);
      if (index < 0) continue;
      const node = nodes[index],
        width = track.values.length / track.times.length,
        value = new Float64Array(width),
        quaternion = [0, 0, 0, 1];
      if (track.path === 'weights') {
        const count = player.model.primitives.find((p) => p.nodeIndex === index)?.weights.length ?? 0;
        if (count !== width)
          throw new RangeError(
            `Keyframe track ${track.target} weights has ${width} values but the node has ${count} morph targets; key one weight per target`,
          );
      }
      bindings.push((time) => {
        sampleKeyframes(track, time, value);
        if (track.path === 'weights') for (let k = 0; k < width; k++) player.setMorph(index, k, value[k]);
        else if (track.path === 'translation') node.setPosition(value as unknown as [number, number, number]);
        else if (track.path === 'scale') node.setScale(value as unknown as [number, number, number]);
        else {
          for (let c = 0; c < 4; c++) quaternion[c] = value[c];
          node.setQuaternion(quaternion);
        }
      });
    }
    return bindings;
  }
}
