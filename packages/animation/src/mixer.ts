/// <reference lib="esnext.disposable" preserve="true" />
import {
  Animation,
  Skeleton,
  sampleKeyframes,
  type BonePose,
  type KeyframeClip,
  type PropertyKeyframeTrack,
} from '@margoengine/animation';
import { sampleTrackInto } from '@margoengine/animation/sampling';
import type { PBRModel } from '@margoengine/gltf-pro';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { rangeError } from '../../shared/errors.js';
import type { DiscreteClip, BoundDiscreteTrack, DiscreteValue } from './discrete-tracks.js';
const invalid = (message: string) => Object.assign(rangeError(message, 'arguments'), { code: 'arguments' });

/** Play once, clamping at the directional endpoint. */
export const LoopOnce = 2200;
/** Repeat from the opposite endpoint. Default loop mode. */
export const LoopRepeat = 2201;
/** Alternate forward and backward traversals. */
export const LoopPingPong = 2202;
/** Weighted replacement, with the original property filling weight below one. */
export const NormalAnimationBlendMode = 2500;
/** Add translation/property deltas, multiply scale deltas and compose quaternion deltas. */
export const AdditiveAnimationBlendMode = 2501;
/** Supported action loop modes. */
export type ActionLoop = typeof LoopOnce | typeof LoopRepeat | typeof LoopPingPong;
/** A parsed glTF clip or a code-authored keyframe clip. */
export type ActionClip = Animation['clips'][number] | KeyframeClip | DiscreteClip;
/** A model, existing Animation, Skeleton, or object hosting bound property tracks. */
export type MixerRoot = object;
type Path = 'translation' | 'rotation' | 'scale' | 'weights';
type Envelope = { start: number; duration: number; from: number; to: number };
type Binding = {
  base: Float64Array;
  value: Float64Array;
  total: number;
  quaternion: boolean;
  scale: boolean;
  applied: boolean;
  read(): ArrayLike<number>;
  write(value: Float64Array): void;
};
type Channel = { binding: Binding; sample(time: number): ArrayLike<number> };
type DiscreteBinding = {
  base: DiscreteValue;
  value: DiscreteValue;
  total: number;
  winner: number;
  applied: boolean;
  channel: BoundDiscreteTrack;
};
type DiscreteChannel = { binding: DiscreteBinding; sample(time: number): DiscreteValue };
const isDiscrete = (clip: ActionClip): clip is DiscreteClip => 'kind' in clip && clip.kind === 'discrete';
const finite = (n: number, label: string, min = -Infinity): number => {
  if (!Number.isFinite(n) || n < min) throw invalid(`Invalid ${label}; pass a finite number >= ${min}`);
  return n;
};
const factor = (e: Envelope, time: number) =>
  e.from + (e.to - e.from) * Math.max(0, Math.min(1, (time - e.start) / e.duration));
// Shortest-arc spherical interpolation. Inputs and outputs may alias.
function slerp(a: ArrayLike<number>, b: ArrayLike<number>, t: number, out: Float64Array): void {
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += a[i] * b[i];
  const sign = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.abs(dot));
  let x = 1 - t,
    y = t;
  if (dot < 0.9995) {
    const angle = Math.acos(dot),
      sin = Math.sin(angle);
    x = Math.sin((1 - t) * angle) / sin;
    y = Math.sin(t * angle) / sin;
  }
  for (let i = 0; i < 4; i++) out[i] = a[i] * x + b[i] * y * sign;
  const length = Math.hypot(...out);
  for (let i = 0; i < 4; i++) out[i] /= length;
}

/** One cached clip playback, with an independent clock, weight and scheduled fades/warps. */
export class AnimationAction {
  /** Local cycle time in seconds. Default 0. */
  time = 0;
  /** Signed clip seconds per mixer second. Default 1. */
  timeScale = 1;
  /** Contribution before a fade multiplier. Default 1. */
  weight = 1;
  /** False mutes the action and stops its clock. Default true. */
  enabled = true;
  /** Freeze the clip clock while retaining its pose. Default false. */
  paused = false;
  /** Hold the last pose after finite playback. Default false (disable at completion). */
  clampWhenFinished = false;
  /** LoopRepeat by default. */
  loop: ActionLoop = LoopRepeat;
  /** Total traversals, Infinity by default; ignored by LoopOnce. */
  repetitions = Infinity;
  private scheduled = false;
  private loops = 0;
  private fade?: Envelope;
  private speed?: Envelope;
  private start?: number;
  /** @internal Actions are cached by AnimationMixer.clipAction. */
  constructor(
    private readonly mixer: AnimationMixer,
    private readonly clip: ActionClip,
    private readonly root: MixerRoot,
    readonly blendMode = NormalAnimationBlendMode,
    private readonly channels: Channel[] = [],
    private readonly discrete: DiscreteChannel[] = [],
  ) {}
  /** Start/resume without resetting the clock. */
  play(): this {
    this.mixer.assertLive();
    this.mixer.assertRootLive(this.root);
    if (!this.scheduled) this.mixer.activate(this.channels.map((c) => c.binding));
    if (!this.scheduled) this.mixer.activateDiscrete(this.discrete.map((c) => c.binding));
    this.scheduled = true;
    return this;
  }
  /** Stop, restore original properties on the next mixer update, and reset. */
  stop(): this {
    this.scheduled = false;
    this.mixer.deactivate(this.channels.map((c) => c.binding));
    this.mixer.deactivateDiscrete(this.discrete.map((c) => c.binding));
    return this.reset();
  }
  /** Rewind, enable, unpause and clear envelopes. */
  reset(): this {
    this.time = this.loops = 0;
    this.enabled = true;
    this.paused = false;
    this.fade = this.speed = undefined;
    this.start = undefined;
    return this;
  }
  /** Schedule a mixer-time start without changing the local clock. */
  startAt(time: number): this {
    this.start = finite(time, 'start time');
    return this;
  }
  /** Whether play() scheduled this action. */
  isScheduled(): boolean {
    return this.scheduled;
  }
  /** Whether the action clock can currently advance. */
  isRunning(): boolean {
    return (
      this.scheduled &&
      this.enabled &&
      !this.paused &&
      this.timeScale !== 0 &&
      (this.start === undefined || this.mixer.time >= this.start)
    );
  }
  /** Clip this action samples. */
  getClip(): ActionClip {
    return this.clip;
  }
  /** Owning mixer. */
  getMixer(): AnimationMixer {
    return this.mixer;
  }
  /** Root this action affects. */
  getRoot(): MixerRoot {
    return this.root;
  }
  /** Current weight including enabled and fading. */
  getEffectiveWeight(): number {
    return this.enabled ? this.weight * this.fadeFactor() : 0;
  }
  /** Current rate including pause and warping. */
  getEffectiveTimeScale(): number {
    return this.paused ? 0 : this.rate();
  }
  // Both read the public weight/timeScale and the envelopes at the mixer's time, so assignments show at once.
  private fadeFactor(): number {
    const e = this.fade;
    return e ? (e.duration ? factor(e, this.mixer.time) : e.to) : 1;
  }
  private rate(): number {
    const e = this.speed;
    return e ? (e.duration ? factor(e, this.mixer.time) : e.to) : this.timeScale;
  }
  /** Set contribution and cancel fading. */
  setEffectiveWeight(weight: number): this {
    this.weight = finite(weight, 'weight', 0);
    this.fade = undefined;
    return this;
  }
  /** Set rate and cancel warping. Negative rates run backwards. */
  setEffectiveTimeScale(scale: number): this {
    this.timeScale = finite(scale, 'timeScale');
    this.speed = undefined;
    return this;
  }
  /** Set a positive wall-time duration for one traversal. */
  setDuration(seconds: number): this {
    if (!(finite(seconds, 'duration', 0) > 0)) throw invalid('Duration must be positive; pass seconds > 0');
    return this.setEffectiveTimeScale(this.clip.duration / seconds);
  }
  /** Copy another action's clock/rate and cancel warping. */
  syncWith(action: AnimationAction): this {
    this.time = action.time;
    return this.setEffectiveTimeScale(action.timeScale);
  }
  /** Select a mode and total traversal count. Default repetitions Infinity. */
  setLoop(mode: ActionLoop, repetitions = Infinity): this {
    if (
      ![LoopOnce, LoopRepeat, LoopPingPong].includes(mode) ||
      (repetitions !== Infinity && (!Number.isSafeInteger(repetitions) || repetitions < 1))
    )
      throw invalid('Invalid action loop; pass a loop mode and a positive integer count or Infinity');
    this.loop = mode;
    this.repetitions = repetitions;
    return this;
  }
  private envelope(from: number, to: number, duration: number): Envelope {
    finite(duration, 'fade/warp duration', 0);
    return { from, to, duration, start: this.mixer.time };
  }
  /** Multiply weight by a ramp from zero to one. */
  fadeIn(duration: number): this {
    this.fade = this.envelope(0, 1, duration);
    return this;
  }
  /** Multiply weight by a ramp from one to zero. */
  fadeOut(duration: number): this {
    this.fade = this.envelope(1, 0, duration);
    return this;
  }
  /** Cancel the scheduled fade, retaining base weight. */
  stopFading(): this {
    this.fade = undefined;
    return this;
  }
  /** Schedule absolute signed rates over mixer seconds. */
  warp(from: number, to: number, duration: number): this {
    this.speed = this.envelope(finite(from, 'warp start'), finite(to, 'warp end'), duration);
    return this;
  }
  /** Slow to a stop. */
  halt(duration: number): this {
    return this.warp(this.getEffectiveTimeScale(), 0, duration);
  }
  /** Cancel scheduled warping. */
  stopWarping(): this {
    this.speed = undefined;
    return this;
  }
  /** Fade this action out and the destination in, optionally matching cycle rates during the transition. */
  crossFadeTo(action: AnimationAction, duration: number, warp = false): this {
    if (action.mixer !== this.mixer || action === this)
      throw invalid('Crossfade needs a different action from this mixer; use mixer.clipAction');
    finite(duration, 'crossfade duration', 0);
    if (warp && (!(this.clip.duration > 0) || !(action.clip.duration > 0)))
      throw invalid('Warp needs positive clip durations; omit warp for static clips');
    this.fadeOut(duration);
    action.fadeIn(duration);
    if (warp) {
      const ratio = this.clip.duration / action.clip.duration;
      this.warp(1, ratio, duration);
      action.warp(1 / ratio, 1, duration);
    }
    return this;
  }
  /** Fade from another action into this one. */
  crossFadeFrom(action: AnimationAction, duration: number, warp = false): this {
    action.crossFadeTo(this, duration, warp);
    return this;
  }
  /** @internal Advance once, then contribute channels to the mixer. */
  advance(delta: number): void {
    if (!this.scheduled || !this.enabled) return;
    finite(this.time, 'action time');
    finite(this.timeScale, 'timeScale');
    finite(this.weight, 'weight', 0);
    if (this.start !== undefined) {
      if (this.mixer.time < this.start) return;
      delta = Math.min(delta, this.mixer.time - this.start);
      this.start = undefined;
    }
    const rate = this.rate();
    if (this.speed) {
      const e = this.speed;
      if (this.mixer.time >= e.start + e.duration) {
        this.timeScale = rate;
        this.speed = undefined;
        if (rate === 0) this.paused = true;
      }
    }
    const fade = this.fadeFactor();
    if (this.fade) {
      const e = this.fade;
      if (this.mixer.time >= e.start + e.duration) {
        this.fade = undefined;
        if (e.to === 0) this.enabled = false;
      }
    }
    let weight = this.enabled ? this.weight * fade : 0;
    const duration = this.clip.duration;
    let sample = this.time;
    if (!this.paused && delta * rate !== 0) {
      const next = finite(this.time + delta * rate, 'advanced action time');
      if (this.loop === LoopOnce || duration === 0) {
        this.time = Math.max(0, Math.min(duration, next));
        if ((next >= duration || next < 0) && (duration > 0 || this.loop === LoopOnce || this.repetitions !== Infinity))
          this.finish();
      } else {
        const crossings = Math.floor(next / duration);
        const terminal = this.loops + Math.abs(crossings) >= this.repetitions;
        if (terminal) {
          this.time = next < 0 ? 0 : duration;
          this.loops = this.repetitions - 1;
          this.finish();
        } else {
          this.time = ((next % duration) + duration) % duration;
          this.loops += Math.abs(crossings);
        }
      }
      sample = this.time;
    }
    if (this.loop === LoopPingPong && this.loops % 2) sample = duration - sample;
    if (!this.enabled) weight = 0;
    if (weight > 0)
      for (const channel of this.channels)
        this.mixer.accumulate(channel.binding, channel.sample(sample), weight, this.blendMode);
    if (weight > 0)
      for (const channel of this.discrete)
        this.mixer.accumulateDiscrete(channel.binding, channel.sample(sample), weight);
  }
  /** @internal Binding ownership for cache eviction. */
  uses(binding: Binding): boolean {
    return this.channels.some((c) => c.binding === binding);
  }
  /** @internal Categorical binding ownership for activation and cache eviction. */
  usesDiscrete(binding: DiscreteBinding): boolean {
    return this.discrete.some((c) => c.binding === binding);
  }
  /** @internal Reset cycle bookkeeping for absolute seeks. */
  rewind(): void {
    this.time = this.loops = 0;
  }
  private finish(): void {
    if (this.clampWhenFinished) this.paused = true;
    else this.enabled = false;
  }
}

/** Independent clip actions on one or more roots. Call update(delta) or register as an engine plugin. */
export class AnimationMixer implements EnginePlugin {
  /** Creates and registers a mixer for a root; disposing it removes its engine registration. */
  static attach(engine: EngineKernel, root: MixerRoot): AnimationMixer {
    const mixer = new AnimationMixer(root);
    try {
      engine.use(mixer);
      return mixer;
    } catch (error) {
      mixer.dispose();
      throw error;
    }
  }
  /** Unique plugin identity. */
  readonly name: string;
  /** Global seconds. Default 0. */
  time = 0;
  /** Global signed rate. Default 1. */
  timeScale = 1;
  private readonly actions: AnimationAction[] = [];
  private readonly players = new Map<MixerRoot, Animation | Skeleton | undefined>();
  private readonly owned = new Set<Animation>();
  private readonly bindings = new Map<object, Map<string, Binding>>();
  private readonly discreteBindings = new Map<object, Map<string, DiscreteBinding>>();
  private engine?: Engine;
  private disposed = false;
  private readonly additive = new Map<Binding, { value: ArrayLike<number>; weight: number }[]>();
  /** Construct over a model, existing Animation or Skeleton. Existing Animation playback is paused. */
  constructor(private readonly root: MixerRoot) {
    this.name = 'animation-mixer:' + serial++;
    this.player(root);
  }
  /** @internal Guard all new work after disposal. */
  assertLive(): void {
    if (this.disposed)
      throw new MargoError(
        'disposed',
        'AnimationMixer is disposed; create a new mixer; see https://margoengine.com/errors#disposed',
      );
  }
  /** @internal A disposed model/player cannot start another action. */
  assertRootLive(root: MixerRoot): void {
    const player = this.players.get(root);
    if (player instanceof Animation) {
      if (player.model.disposed)
        throw new MargoError(
          'disposed',
          'Mixer root is disposed; use a live model; see https://margoengine.com/errors#disposed',
        );
      player.captureState();
    }
  }
  private rootAlive(root: MixerRoot): boolean {
    const player = this.players.get(root);
    return !(player instanceof Animation) || !player.model.disposed;
  }
  /** @internal Capture original values when a property's first action starts. */
  activate(bindings: readonly Binding[]): void {
    for (const b of bindings)
      if (!this.actions.some((a) => a.isScheduled() && a.uses(b))) b.base.set(Array.from(b.read()));
  }
  /** @internal Restore original values when its last action stops. */
  deactivate(bindings: readonly Binding[]): void {
    for (const b of bindings)
      if (b.applied && !this.actions.some((a) => a.isScheduled() && a.uses(b))) {
        if (this.actions.some((a) => a.uses(b) && this.rootAlive(a.getRoot()))) b.write(b.base);
        b.applied = false;
      }
  }
  /** @internal Capture categorical originals on first activation. */
  activateDiscrete(bindings: readonly DiscreteBinding[]): void {
    for (const b of bindings)
      if (!this.actions.some((a) => a.isScheduled() && a.usesDiscrete(b))) b.base = b.channel.read();
  }
  /** @internal Restore categorical originals on last deactivation. */
  deactivateDiscrete(bindings: readonly DiscreteBinding[]): void {
    for (const b of bindings)
      if (b.applied && !this.actions.some((a) => a.isScheduled() && a.usesDiscrete(b))) {
        if (this.actions.some((a) => a.usesDiscrete(b) && this.rootAlive(a.getRoot()))) b.channel.write(b.base);
        b.applied = false;
      }
  }
  private player(root: MixerRoot): Animation | Skeleton | undefined {
    if (this.players.has(root)) return this.players.get(root);
    let player = this.players.get(root);
    if (!player) {
      if (!root || typeof root !== 'object')
        throw invalid('Invalid mixer root; pass an object, model, Skeleton or Animation');
      if (root instanceof Skeleton || root instanceof Animation) player = root;
      else if (Array.isArray((root as PBRModel).nodes) && (root as PBRModel).root?.scene) {
        const model = root as PBRModel;
        if (model.disposed)
          throw new MargoError(
            'disposed',
            'Mixer root is disposed; use a live model; see https://margoengine.com/errors#disposed',
          );
        player = new Animation(model);
        model.root.scene.use(player);
      }
      if (player instanceof Animation) {
        player.playing = false;
        if (player !== root) this.owned.add(player);
      }
      this.players.set(root, player);
    }
    return player;
  }
  private resolve(clip: ActionClip | string | number, root: MixerRoot): ActionClip {
    const player = this.player(root);
    const result =
      typeof clip === 'object'
        ? clip
        : player instanceof Animation
          ? typeof clip === 'number'
            ? player.clips[clip]
            : player.clips.find((c) => c.name === clip)
          : undefined;
    if (!result || !Number.isFinite(result.duration) || result.duration < 0 || !Array.isArray(result.tracks))
      throw invalid('Unknown mixer clip; use an Animation clip or createKeyframeClip');
    return result;
  }
  /** Return the cached action for this clip/root/blend mode, creating its bindings once. */
  clipAction(
    clip: ActionClip | string | number,
    root = this.root,
    blendMode = NormalAnimationBlendMode,
  ): AnimationAction {
    this.assertLive();
    if (![NormalAnimationBlendMode, AdditiveAnimationBlendMode].includes(blendMode))
      throw invalid('Invalid blend mode; choose NormalAnimationBlendMode or AdditiveAnimationBlendMode');
    const resolved = this.resolve(clip, root);
    this.assertRootLive(root);
    if (isDiscrete(resolved) && blendMode === AdditiveAnimationBlendMode)
      throw invalid('Categorical tracks have no additive arithmetic; use NormalAnimationBlendMode');
    let action = this.actions.find(
      (a) => a.getClip() === resolved && a.getRoot() === root && a.blendMode === blendMode,
    );
    if (!action) {
      action = new AnimationAction(
        this,
        resolved,
        root,
        blendMode,
        this.bind(resolved, root),
        this.bindDiscrete(resolved),
      );
      this.actions.push(action);
    }
    return action;
  }
  /** Existing cached action or null. */
  existingAction(clip: ActionClip | string | number, root = this.root): AnimationAction | null {
    // A lookup never creates anything: an unused root has no player yet, and an unknown clip is simply not cached.
    const player = this.players.get(root);
    const resolved =
      typeof clip === 'object'
        ? clip
        : player instanceof Animation
          ? typeof clip === 'number'
            ? player.clips[clip]
            : player.clips.find((c) => c.name === clip)
          : undefined;
    if (!resolved) return null;
    return this.actions.find((a) => a.getClip() === resolved && a.getRoot() === root) ?? null;
  }
  /** Default animation root. */
  getRoot(): MixerRoot {
    return this.root;
  }
  /** Advance independent action clocks, then blend once per affected property. */
  update(delta: number): this {
    this.assertLive();
    finite(delta, 'mixer delta');
    finite(this.timeScale, 'mixer timeScale');
    const step = delta * this.timeScale;
    finite(this.time + step, 'mixer time');
    this.time += step;
    const removed = this.actions.filter((a) => {
      const player = this.players.get(a.getRoot());
      return player instanceof Animation && player.model.disposed;
    });
    for (const action of removed) this.actions.splice(this.actions.indexOf(action), 1);
    for (const [target, map] of this.bindings) {
      for (const [key, b] of map)
        if (removed.some((a) => a.uses(b)) && !this.actions.some((a) => a.uses(b))) map.delete(key);
      if (!map.size) this.bindings.delete(target);
    }
    this.additive.clear();
    for (const [target, map] of this.discreteBindings) {
      for (const [key, b] of map)
        if (removed.some((a) => a.usesDiscrete(b)) && !this.actions.some((a) => a.usesDiscrete(b))) map.delete(key);
      if (!map.size) this.discreteBindings.delete(target);
    }
    for (const map of this.discreteBindings.values())
      for (const b of map.values()) {
        b.total = 0;
        b.winner = -Infinity;
        b.value = b.base;
      }
    for (const map of this.bindings.values())
      for (const binding of map.values()) {
        binding.total = 0;
        binding.value.fill(0);
      }
    for (const action of this.actions) action.advance(step);
    for (const map of this.bindings.values())
      for (const b of map.values()) {
        const active = b.total > 0 || this.additive.has(b);
        if (!active && !b.applied) continue;
        if (b.total === 0) b.value.set(b.base);
        else if (b.quaternion) {
          if (b.total < 1) slerp(b.base, b.value, b.total, b.value);
        } else
          for (let i = 0; i < b.value.length; i++)
            b.value[i] = b.value[i] / Math.max(1, b.total) + b.base[i] * Math.max(0, 1 - b.total);
        for (const add of this.additive.get(b) ?? []) {
          if (b.quaternion) {
            const q = new Float64Array(4);
            slerp([0, 0, 0, 1], add.value, add.weight, q);
            const [x, y, z, w] = b.value,
              [a, c, d, e] = q;
            b.value.set([
              w * a + x * e + y * d - z * c,
              w * c - x * d + y * e + z * a,
              w * d + x * c - y * a + z * e,
              w * e - x * a - y * c - z * d,
            ]);
          } else
            for (let i = 0; i < b.value.length; i++)
              b.value[i] = b.scale
                ? b.value[i] * (1 + (add.value[i] - 1) * add.weight)
                : b.value[i] + add.value[i] * add.weight;
        }
        b.write(b.value);
        b.applied = active;
      }
    for (const map of this.discreteBindings.values())
      for (const b of map.values()) {
        const active = b.total > 0;
        if (!active && !b.applied) continue;
        b.channel.write(!active || Math.max(0, 1 - b.total) > b.winner ? b.base : b.value);
        b.applied = active;
      }
    return this;
  }
  /** Seek global playback from the beginning, scaling by timeScale. */
  setTime(time: number): this {
    finite(time, 'mixer seek');
    this.time = 0;
    for (const a of this.actions) a.rewind();
    return this.update(time);
  }
  /** Stop and rewind all actions, restoring captured original properties. */
  stopAllAction(): this {
    for (const a of this.actions) a.stop();
    return this.update(0);
  }
  /** Remove cached actions for a clip/root. Stop them first. */
  uncacheAction(clip: ActionClip | string | number, root = this.root): void {
    const resolved = this.resolve(clip, root);
    for (let i = this.actions.length - 1; i >= 0; i--)
      if (this.actions[i].getClip() === resolved && this.actions[i].getRoot() === root) {
        this.actions[i].stop();
        this.actions.splice(i, 1);
      }
    this.update(0);
    for (const [target, map] of this.bindings) {
      for (const [key, binding] of map) if (!this.actions.some((a) => a.uses(binding))) map.delete(key);
      if (!map.size) this.bindings.delete(target);
    }
    for (const [target, map] of this.discreteBindings) {
      for (const [key, b] of map) if (!this.actions.some((a) => a.usesDiscrete(b))) map.delete(key);
      if (!map.size) this.discreteBindings.delete(target);
    }
  }
  /** Remove all actions using a clip. */
  uncacheClip(clip: ActionClip): void {
    for (const root of this.players.keys()) this.uncacheAction(clip, root);
  }
  /** Stop and remove actions using a root. */
  uncacheRoot(root: MixerRoot): void {
    for (const a of [...this.actions]) if (a.getRoot() === root) this.uncacheAction(a.getClip(), root);
    this.update(0);
    const player = this.players.get(root);
    if (player instanceof Animation && this.owned.delete(player)) player.dispose();
    this.players.delete(root);
  }
  /** Engine plugin setup; no GPU resources of its own. */
  setup(engine: Engine): void {
    this.assertLive();
    this.engine = engine;
  }
  /** Engine plugin clock hook. */
  onPreUpdate(delta: number): void {
    this.update(delta);
  }
  /** Restore originals, detach by identity and release only Animations this mixer created. */
  dispose(): void {
    if (this.disposed) return;
    this.stopAllAction();
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    for (const a of this.owned) a.dispose();
    this.owned.clear();
    this.actions.length = 0;
    this.players.clear();
    this.bindings.clear();
    this.discreteBindings.clear();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @internal Shared property accumulation, with deferred additive composition. */
  accumulate(b: Binding, value: ArrayLike<number>, weight: number, mode: number): void {
    if (mode === AdditiveAnimationBlendMode) {
      let list = this.additive.get(b);
      if (!list) this.additive.set(b, (list = []));
      list.push({ value: Float64Array.from(value), weight });
      return;
    }
    const total = b.total + weight;
    if (b.quaternion) {
      if (b.total === 0) b.value.set(Array.from(value));
      else slerp(b.value, value, weight / total, b.value);
    } else for (let i = 0; i < b.value.length; i++) b.value[i] += value[i] * weight;
    b.total = total;
  }
  private binding(
    target: object,
    path: string,
    base: ArrayLike<number>,
    write: Binding['write'],
    quaternion = false,
    scale = false,
    read: () => ArrayLike<number> = () => base,
  ): Binding {
    let map = this.bindings.get(target);
    if (!map) this.bindings.set(target, (map = new Map()));
    let binding = map.get(path);
    if (!binding) {
      binding = {
        base: Float64Array.from(base),
        value: new Float64Array(base.length),
        total: 0,
        write,
        quaternion,
        scale,
        applied: false,
        read,
      };
      map.set(path, binding);
    }
    return binding;
  }
  private bind(clip: ActionClip, root: MixerRoot): Channel[] {
    if (isDiscrete(clip)) return [];
    const player = this.player(root),
      channels: Channel[] = [];
    const code = (clip.tracks[0] && 'target' in clip.tracks[0]) || 'properties' in clip;
    for (const raw of clip.tracks) {
      const path = raw.path as Path;
      let binding: Binding | undefined;
      if (player instanceof Skeleton) {
        if (!('target' in raw) || path === 'weights') continue;
        const index = player.index(raw.target);
        if (index < 0) continue;
        const pose = player.getPose(index),
          key = path as 'translation' | 'rotation' | 'scale';
        binding = this.binding(
          player,
          index + ':' + path,
          pose[key],
          (value) => player.setPose(index, { [key]: value } as unknown as BonePose),
          path === 'rotation',
          path === 'scale',
          () => player.getPose(index)[key],
        );
      } else if (player instanceof Animation) {
        const index = 'node' in raw ? raw.node : player.model.nodes.findIndex((n) => n.name === raw.target);
        if (index < 0) continue;
        const node = player.model.nodes[index];
        if (path === 'weights') {
          const primitive = player.model.primitives.find((p) => p.nodeIndex === index);
          if (!primitive) continue;
          binding = this.binding(node, path, primitive.weights, (value) => {
            for (let i = 0; i < value.length; i++) player.setMorph(index, i, value[i]);
          });
        } else {
          const t = node.engine.store.transforms,
            id = node.id;
          const base =
            path === 'translation'
              ? [t.x[id], t.y[id], t.z[id]]
              : path === 'scale'
                ? [t.sx[id], t.sy[id], t.sz[id]]
                : [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
          binding = this.binding(
            node,
            path,
            base,
            (value) => {
              if (path === 'translation') node.setPosition(value as unknown as [number, number, number]);
              else if (path === 'scale') node.setScale(value as unknown as [number, number, number]);
              else node.setQuaternion(Array.from(value));
            },
            path === 'rotation',
            path === 'scale',
            () =>
              path === 'translation'
                ? [t.x[id], t.y[id], t.z[id]]
                : path === 'scale'
                  ? [t.sx[id], t.sy[id], t.sz[id]]
                  : [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
          );
        }
      } else
        throw invalid('Transform tracks need a Skeleton or Animation root; use bound property tracks on plain objects');
      if ('node' in raw) {
        const out = new Float32Array(raw.width);
        channels.push({
          binding,
          sample: (time) =>
            sampleTrackInto(raw.times, raw.values, raw.width, time, raw.interpolation, path === 'rotation', out),
        });
      } else {
        const out = new Float64Array(raw.values.length / raw.times.length);
        channels.push({ binding, sample: (time) => sampleKeyframes(raw, time, out) });
      }
    }
    const properties = code
      ? (clip as KeyframeClip).properties
      : 'bind' in clip && clip.bind
        ? (clip.bound ??= clip.bind()).properties
        : undefined;
    for (const track of properties ?? []) this.property(track, channels);
    return channels;
  }
  private property(track: PropertyKeyframeTrack, channels: Channel[]): void {
    const binding = this.binding(
      track.target,
      'property:' + (track.property ?? track.name),
      track.read(),
      (value) => track.write(value),
      track.type === 'quaternion',
      false,
      () => track.read(),
    );
    const out = new Float64Array(track.size);
    channels.push({ binding, sample: (time) => sampleKeyframes(track, time, out) });
  }
  private bindDiscrete(clip: ActionClip): DiscreteChannel[] {
    if (!isDiscrete(clip)) return [];
    return clip.tracks.map((channel) => {
      let map = this.discreteBindings.get(channel.target);
      if (!map) this.discreteBindings.set(channel.target, (map = new Map()));
      let binding = map.get(channel.property);
      if (!binding) {
        const base = channel.read();
        binding = { base, value: base, total: 0, winner: -Infinity, applied: false, channel };
        map.set(channel.property, binding);
      } else if (typeof binding.base !== typeof channel.read())
        throw invalid('Categorical binding types disagree; use the same value type for one property');
      return { binding, sample: (time) => channel.sample(time) };
    });
  }
  /** @internal Categorical winner selection never averages booleans or string indices. */
  accumulateDiscrete(binding: DiscreteBinding, value: DiscreteValue, weight: number): void {
    if ((typeof value !== 'boolean' && typeof value !== 'string') || typeof value !== typeof binding.base)
      throw invalid('Categorical channel changed value type; return the original boolean or string type');
    binding.total += weight;
    if (weight >= binding.winner) {
      binding.winner = weight;
      binding.value = value;
    }
  }
}
let serial = 0;
