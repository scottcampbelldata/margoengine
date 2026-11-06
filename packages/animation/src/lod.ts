// Animation level of detail: far or off-screen characters update less often and with fewer bones, so big crowds stay
// cheap. Time keeps running for every copy, so a character that comes back into view is where it should be.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Animation } from './index.js';
import { sampleTrackInto } from './sampling.js';

/** One detail level. A copy takes the last tier whose `distance` it has reached. */
export interface AnimationLODTier {
  /** World units from the camera at which this tier starts, >= 0. Tiers are given nearest first; the first is 0. */
  distance: number;
  /** Frames between updates: 1 is every frame, 4 every fourth. An integer >= 1. */
  interval: number;
  /** Deepest node level still animated, counted from the scene roots (0). Deeper nodes hold. Default: all. */
  depth?: number;
}
/** Options for {@link AnimationLOD}. */
export interface AnimationLODOptions {
  /** Detail levels, nearest first. Default {@link defaultLODTiers}. */
  tiers?: readonly AnimationLODTier[];
  /** Used while a copy is off screen, at any distance. Default `{distance: 0, interval: 16, depth: 1}`. */
  hidden?: AnimationLODTier;
}
/** One copy's options for {@link AnimationLOD.add}. */
export interface AnimationLODMember {
  /** Radius of the sphere around the model root tested against the view, in world units. Default 2. */
  radius?: number;
}
/** What one {@link AnimationLOD.update} did. */
export interface AnimationLODStats {
  /** Copies posed this frame. */
  updated: number;
  /** Copies left as they were this frame. */
  skipped: number;
  /** Copies off screen. */
  hidden: number;
}

/** Every frame up close, every second frame from 15 units, every fourth and only four levels deep from 40. */
export const defaultLODTiers: readonly AnimationLODTier[] = Object.freeze([
  Object.freeze({ distance: 0, interval: 1 }),
  Object.freeze({ distance: 15, interval: 2 }),
  Object.freeze({ distance: 40, interval: 4, depth: 4 }),
]);

interface Member {
  animation: Animation;
  radius: number;
  /** Spreads copies of one interval across frames, so they do not all update at once. */
  phase: number;
  /** Seconds not yet applied to the pose. */
  owed: number;
  time: number;
  playing: boolean;
  tier: AnimationLODTier;
  /** Each node's level, from the document's hierarchy. */
  levels: Int32Array;
}

function check(tier: AnimationLODTier, label: string): void {
  if (
    !Number.isFinite(tier?.distance) ||
    tier.distance < 0 ||
    !Number.isInteger(tier.interval) ||
    tier.interval < 1 ||
    (tier.depth !== undefined && !(Number.isInteger(tier.depth) && tier.depth >= 0))
  )
    throw new RangeError(`${label} is invalid; use a distance >= 0, an integer interval >= 1 and an integer depth >= 0`);
}
function levelsOf(animation: Animation): Int32Array {
  const nodes = animation.model.asset.doc.nodes ?? [],
    levels = new Int32Array(nodes.length),
    children = (i: number) => (nodes[i]?.children ?? []) as readonly number[],
    child = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) for (const c of children(i)) child[c] = 1;
  const walk: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (!child[i]) walk.push(i);
  while (walk.length) {
    const i = walk.pop()!;
    for (const c of children(i)) {
      levels[c] = levels[i] + 1;
      walk.push(c);
    }
  }
  return levels;
}
let serial = 0;

/**
 * Takes over the playback of many `Animation`s and updates each as often as its distance and visibility call for:
 * near copies every frame, far ones less often and with only their upper bones, off-screen ones rarely. Skipped time is
 * kept, so a copy that is updated again lands exactly where it would have been. A copy's clip, speed and loop still
 * come from its `Animation`.
 *
 * @example
 * ```ts
 * const lod = AnimationLOD.attach(stage.engine);
 * for (const animation of crowd) lod.add(animation, {radius: 1.5});
 * ```
 */
export class AnimationLOD implements EnginePlugin {
  readonly name = 'animation-lod:' + serial++;
  /** What the last update did. */
  readonly stats: AnimationLODStats = { updated: 0, skipped: 0, hidden: 0 };
  private readonly tiers: readonly AnimationLODTier[];
  private readonly hidden: AnimationLODTier;
  private readonly members = new Map<Animation, Member>();
  private readonly quaternion: number[] = [0, 0, 0, 1];
  private engine?: Engine;
  private frame = 0;
  private next = 0;
  private disposed = false;

  /** Same as `engine.use(new AnimationLOD(...))`; returns it. */
  static attach(engine: EngineKernel, options?: AnimationLODOptions): AnimationLOD {
    const lod = new AnimationLOD(options);
    engine.use(lod);
    return lod;
  }
  constructor({
    tiers = defaultLODTiers,
    hidden = { distance: 0, interval: 16, depth: 1 },
  }: AnimationLODOptions = {}) {
    if (!Array.isArray(tiers) || !tiers.length) throw new TypeError('AnimationLOD tiers must be a non-empty array');
    tiers.forEach((tier, i) => {
      check(tier, `AnimationLOD tier ${i}`);
      if (i ? tier.distance <= tiers[i - 1].distance : tier.distance !== 0)
        throw new RangeError('AnimationLOD tiers must start at distance 0 and increase');
    });
    check(hidden, 'AnimationLOD hidden tier');
    this.tiers = tiers;
    this.hidden = hidden;
  }
  /** Copies under this LOD. */
  get count(): number {
    return this.members.size;
  }
  /** Takes over a copy's playback from its current time; `remove` hands it back. */
  add(animation: Animation, { radius = 2 }: AnimationLODMember = {}): this {
    if (this.disposed) throw new MargoError('disposed', 'AnimationLOD is disposed; create a new one');
    if (!Number.isFinite(radius) || radius < 0) throw new RangeError('AnimationLOD radius must be a finite number >= 0');
    const member = this.members.get(animation);
    if (member) {
      member.radius = radius;
      return this;
    }
    this.members.set(animation, {
      animation,
      radius,
      phase: this.next++,
      owed: 0,
      time: animation.time,
      playing: animation.playing,
      tier: this.tiers[0],
      levels: levelsOf(animation),
    });
    animation.playing = false;
    return this;
  }
  /** Hands a copy back to its `Animation`, fully posed at the time it has reached. */
  remove(animation: Animation): boolean {
    const member = this.members.get(animation);
    if (!member) return false;
    this.members.delete(animation);
    if (!animation['disposed'] && !animation.model.disposed) {
      animation.seek(member.time + member.owed * (animation.options.speed ?? 1));
      animation.playing = member.playing;
    }
    return true;
  }
  /** The tier a copy is on after the last update, or undefined if it is not under this LOD. */
  tierOf(animation: Animation): AnimationLODTier | undefined {
    return this.members.get(animation)?.tier;
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    this.update(delta);
  }
  /** Advances every copy by `delta` seconds, posing those whose turn it is. */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid animation delta; pass a finite delta >= 0 seconds');
    const camera = this.engine?.camera,
      stats = this.stats,
      frame = this.frame++;
    stats.updated = stats.skipped = stats.hidden = 0;
    for (const member of this.members.values()) {
      const { animation } = member;
      if (animation['disposed'] || animation.model.disposed) {
        this.members.delete(animation);
        continue;
      }
      const root = animation.model.root.matrix,
        x = root[12],
        y = root[13],
        z = root[14];
      let tier = this.tiers[0],
        visible = true;
      if (camera) {
        const eye = camera.position,
          distance = Math.hypot(x - eye[0], y - eye[1], z - eye[2]),
          planes = camera.planes;
        for (const candidate of this.tiers) if (distance >= candidate.distance) tier = candidate;
        for (let p = 0; visible && p < 24; p += 4)
          visible = planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3] >= -member.radius;
      }
      if (!visible) {
        tier = this.hidden;
        stats.hidden++;
      }
      member.tier = tier;
      member.owed += delta;
      if ((frame + member.phase) % tier.interval) {
        stats.skipped++;
        continue;
      }
      member.time += member.owed * (animation.options.speed ?? 1);
      member.owed = 0;
      this.pose(member, tier);
      stats.updated++;
    }
  }
  private pose({ animation, time, levels }: Member, tier: AnimationLODTier): void {
    if (tier.depth === undefined) {
      animation.seek(time);
      return;
    }
    const clip = animation.clips[animation.clip];
    if (!clip) return;
    const loop = (animation.options.loop ?? true) && clip.duration > 0,
      t = loop ? time % clip.duration : Math.min(time, clip.duration),
      nodes = animation.model.nodes;
    animation.time = time;
    for (const track of clip.tracks) {
      if (track.path !== 'weights' && levels[track.node] > tier.depth) continue;
      const value = sampleTrackInto(
          track.times,
          track.values,
          track.width,
          t,
          track.interpolation,
          track.path === 'rotation',
          track.sample,
        ),
        node = nodes[track.node];
      if (track.path === 'translation') node.setPosition(value as unknown as [number, number, number]);
      else if (track.path === 'scale') node.setScale(value as unknown as [number, number, number]);
      else if (track.path === 'rotation') {
        for (let c = 0; c < 4; c++) this.quaternion[c] = value[c];
        node.setQuaternion(this.quaternion);
      } else for (const p of animation.model.primitives) if (p.nodeIndex === track.node) p.weights.set(value);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const animation of [...this.members.keys()]) this.remove(animation);
    this.engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
