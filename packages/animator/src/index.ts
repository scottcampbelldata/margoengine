/// <reference lib="esnext.disposable" preserve="true" />
import type { Animation } from '@margoengine/animation';
import { sampleTrackInto } from '@margoengine/animation/sampling';
import type { Engine, EnginePlugin, Mesh, Vec3 } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { multiplyQuaternions as quaternionMultiply } from '@margoengine/math/quat';
import { MargoError } from '@margoengine/math/errors';
import { blend1D, blend2D, quaternionBlend, treeWeights } from './blend.js';
import { solveTwoBoneIK, rotationBetween } from './ik.js';
export { blend1D, blend2D } from './blend.js';
export { solveTwoBoneIK } from './ik.js';
export { CCDSolver } from './ccd.js';
export type { CCDConeLimit, CCDEulerLimit, CCDHingeLimit, CCDJointLimit, CCDResult } from './ccd.js';
export { addCCDChain } from './ccd-chain.js';
export type { CCDChain } from './ccd-chain.js';
export { addRootMotion } from './root-motion.js';
export type { RootMotion, RootMotionOptions } from './root-motion.js';
export { addLookAt, addAimConstraint } from './look-at.js';
export type { LookAt, AimConstraint } from './look-at.js';
export { addFootPlacement } from './foot-placement.js';
export type { FootPlacement, FootPlacementHandle, PlacedLeg } from './foot-placement.js';
/**
 * What an animator state plays: a clip name, a 1D tree (`parameter` plus samples sorted by increasing `value`) or a
 * 2D tree (two `parameters` plus samples with unique `[x, y]` values). Parameters default to 0.
 */
export type BlendTree =
  | string
  | { parameter: string; samples: readonly { value: number; clip: string }[] }
  | { parameters: readonly [string, string]; samples: readonly { value: readonly [number, number]; clip: string }[] };
/**
 * An automatic state change: in state `from`, once every condition it lists holds (`when`, `trigger`, `exitTime`; at
 * least one), the animator crossfades to `to`. Transitions are checked once per frame in declaration order and the
 * first that holds wins.
 */
export interface AnimatorTransition {
  /** The state this transition leaves, or `'*'` for any state (except `to` itself). */
  from: string;
  /** The state it enters. */
  to: string;
  /** Holds when it returns true; evaluated while in `from`. Default: no parameter condition. */
  when?: (parameters: Readonly<Record<string, number>>) => boolean;
  /** Holds while this trigger is set ({@link Animator.setTrigger}); taking the transition clears it. Default: none. */
  trigger?: string;
  /**
   * Holds once the state's normalized time ({@link Animator.normalizedTime}) reaches this value: 1 is the end of the
   * state's longest clip, 0.8 lets the crossfade overlap its last fifth. Default: none.
   */
  exitTime?: number;
  /** Crossfade length in seconds, 0 or more. Default 0.15. */
  duration?: number;
}
/** A named moment in a state's cycle (a footstep, a hit frame), delivered through `animator.on('event')`. */
export interface AnimatorEvent {
  /** The state it belongs to. */
  state: string;
  /** Normalized time in the state's cycle, 0 to 1 (0.5 is halfway through its longest clip). */
  time: number;
  /** Event name, for example `'footstep'`. */
  name: string;
  /** Anything the listener needs (which foot, a sound name). Default undefined. */
  data?: unknown;
}
/** Events an Animator emits, keyed by type. */
export interface AnimatorEventMap {
  /** A timed event from `options.events`, once per cycle it is passed (loops included). */
  event: { name: string; state: string; time: number; data: unknown };
  /** The state changed, by a transition rule or {@link Animator.transition}. */
  statechange: { from: string; to: string; duration: number };
}
/** Options for {@link Animator}. */
export interface AnimatorOptions {
  /** Named states; each is a clip name or a blend tree. At least one is required. */
  states: Record<string, BlendTree>;
  /** The state to start in; must be a key of `states`. */
  initial: string;
  /** Starting blend parameters. Default: none (every parameter reads 0). */
  parameters?: Record<string, number>;
  /** Automatic state changes. Default: none. */
  transitions?: readonly AnimatorTransition[];
  /** Timed events per state (footsteps, hit frames), delivered through `animator.on('event')`. Default: none. */
  events?: readonly AnimatorEvent[];
  /**
   * Optional explicit rotation commit, captured once during construction.
   * Receives a borrowed normal array for sampled/blended poses and FootIK.
   * The synchronous writer must validate finite Float32/nonzero input,
   * normalize and synchronize quaternion/Euler state without mutating or
   * retaining the array. Cached unchanged rotations do not call the writer.
   * Recursive onPreUpdate calls from the writer are rejected before mutation.
   * Omit to preserve dynamic Mesh.setQuaternion dispatch.
   */
  writeRotation?: (node: Mesh, rotation: readonly number[]) => void;
}
/**
 * A masked layer over the base pose. `additive` (default) adds the difference between the clip and its reference
 * pose; `override` blends the masked bones toward the clip's pose by `weight` (an upper-body wave over a walk).
 */
export interface AdditiveLayer {
  /** The clip to add or blend in. */
  clip: string;
  /** Strength from 0 to 1; read every frame, so it may be animated. */
  weight: number;
  /** glTF node indices the layer affects. */
  mask: readonly number[];
  /** `'additive'` (default) or `'override'`. */
  blend?: 'additive' | 'override';
  /** Clip time in seconds, read every frame (default the state's time), to play a layer on its own clock. */
  time?: number;
  /** Additive reference clip time. A zero reference scale axis contributes an identity scale delta. */
  referenceTime?: number;
}
/** A masked additive or override layer ({@link Animator.addLayer}). */
export type AnimatorLayer = AdditiveLayer;
/** What a {@link FootIK} `raycast` returns for a hit. */
export interface GroundHit {
  /** World-space hit point. */
  position: Vec3;
  /** Unit surface normal; when given the ankle's local +Y aligns with it. Default: no alignment. */
  normal?: Vec3;
}
/** One leg for {@link Animator.addFootIK}: a direct hip, knee, ankle chain that plants the foot on the ground. */
export interface FootIK {
  /** glTF node index of the hip. */
  hip: number;
  /** glTF node index of the knee; a child of `hip`. */
  knee: number;
  /** glTF node index of the ankle; a child of `knee`. */
  ankle: number;
  /** World-space point the knee bends toward. */
  pole: Vec3;
  /** Casts a ray from a world-space `origin` along `direction` (down); returns the hit or `null`. */
  raycast: (origin: Vec3, direction: Vec3) => GroundHit | null;
  /** Height of the ankle above the ground, in metres. Default 0. */
  offset?: number;
  /** How far above the ankle the ray starts, in metres; above 0. Default 1. */
  probeHeight?: number;
}
/** @internal A state's own clock, for time that does not run at one second a second. */
export interface StateClock {
  /** The state's time after `step` seconds from `time`. */
  advance(time: number, step: number): number;
  /** Seconds along `clip`, counted over its loops, at the state's `time`. */
  clipTime(clip: string, time: number): number;
  /** The time state `from` would be at now, to keep it playing through a crossfade; undefined freezes it. */
  follow?(from: string, time: number): number | undefined;
}
/** @internal One frame's finished pose: local transforms per glTF node, morph weights per node. */
export interface Pose {
  position: number[][];
  rotation: number[][];
  scale: number[][];
  weights: Map<number, Float32Array>;
}
const clone = (p: Pose): Pose => {
  const weights = new Map<number, Float32Array>();
  for (const [k, v] of p.weights) weights.set(k, v.slice());
  return {
    position: p.position.map((v) => v.slice()),
    rotation: p.rotation.map((v) => v.slice()),
    scale: p.scale.map((v) => v.slice()),
    weights,
  };
};
const copyVectors = (source: number[][], out: number[][]): void => {
  out.length = source.length;
  for (let i = 0; i < source.length; i++) {
    const values = source[i];
    if (!out[i] || out[i].length !== values.length) out[i] = values.slice();
    else for (let j = 0; j < values.length; j++) out[i][j] = values[j];
  }
};
const copyPose = (source: Pose, out: Pose, weightNodes: readonly number[]): Pose => {
  copyVectors(source.position, out.position);
  copyVectors(source.rotation, out.rotation);
  copyVectors(source.scale, out.scale);
  if (out.weights.size !== source.weights.size)
    for (const id of out.weights.keys()) if (!source.weights.has(id)) out.weights.delete(id);
  for (let i = 0; i < weightNodes.length; i++) {
    const id = weightNodes[i],
      values = source.weights.get(id)!;
    const own = out.weights.get(id);
    if (own?.length === values.length) own.set(values);
    else out.weights.set(id, values.slice());
  }
  return out;
};
/**
 * Gameplay animation on top of an {@link Animation}: named states, blend trees, crossfades, additive layers and foot
 * IK. Attach the Animation first; the Animator takes over its playback until disposed (`using` works).
 * @example
 * const animator = Animator.attach(Animation.attach(model), {
 *   initial: 'idle',
 *   states: {idle: 'Idle', run: 'Run'},
 *   transitions: [{from: 'idle', to: 'run', when: (p) => p.speed > 0.5}],
 * });
 * animator.parameters.speed = 1;
 */
export class Animator implements EnginePlugin {
  /** Plugin name, `animator:<model name>`. */
  readonly name: string;
  /** Blend parameters by name; write them to steer blend trees and transitions. Missing names read 0. */
  readonly parameters: Record<string, number>;
  /** The current state name; change it with {@link Animator.transition}. */
  state: string;
  /** Seconds spent in the current state. */
  time = 0;
  /**
   * Advances state time and crossfades while true; false holds the current pose in place. Time also scales by the
   * Animation's `options.speed`, as it does for Animation's own playback, so one pause and speed control serves both.
   */
  playing = true;
  private engine?: Engine;
  private readonly rest: Pose;
  private current: Pose;
  private readonly singlePose: Pose;
  private readonly weightNodes: number[];
  private readonly morphed: Set<number>;
  private readonly applied: Float64Array[];
  private fade?: { pose: Pose; elapsed: number; duration: number; from: string };
  private entry = 0;
  private readonly clocks = new Map<string, StateClock>();
  private layers = new Set<AdditiveLayer>();
  private readonly scratch = new Map<number, Float32Array>();
  private feet = new Set<FootIK>();
  private readonly solvers: Array<() => void> = [];
  private readonly poseSteps: Array<(position: number[][], rotation: number[][]) => void> = [];
  private readonly lateSteps: Array<(pose: Pose, step: number) => void> = [];
  private readonly fadeSteps: Array<(position: number[][], rotation: number[][], state: string, time: number) => void> =
    [];
  private disposed = false;
  private readonly triggers = new Set<string>();
  private readonly durations = new Map<string, number>();
  private readonly events = new Map<string, AnimatorEvent[]>();
  private readonly listeners = new Map<keyof AnimatorEventMap, Set<(event: never) => void>>();
  private entered = true;
  private unsubscribe?: () => void;
  private previousPlaying: boolean;
  private readonly writeRotation?: AnimatorOptions['writeRotation'];
  private rotationWriteActive = false;
  constructor(
    readonly animation: Animation,
    readonly options: AnimatorOptions,
  ) {
    this.name = 'animator:' + animation.model.name;
    this.parameters = { ...options.parameters };
    this.state = options.initial;
    if (!options.states || !Object.hasOwn(options.states, this.state) || !Object.keys(options.states).length)
      throw new TypeError('Invalid animator states; pass a non-empty states object that contains the initial state');
    for (const [name, tree] of Object.entries(options.states)) {
      if (!name) throw new TypeError('Empty animator state; give every state a non-empty name');
      if (name === '*') throw new TypeError("Animator state '*' is reserved for any-state transitions; rename it");
      if (typeof tree === 'string') this.clip(tree);
      else if ('parameter' in tree) {
        blend1D(
          tree.samples.map((s) => s.value),
          0,
        );
        for (const s of tree.samples) this.clip(s.clip);
      } else {
        if (tree.parameters.length !== 2)
          throw new TypeError('Invalid blend parameters; a 2D blend tree takes exactly two parameter names');
        blend2D(
          tree.samples.map((s) => s.value),
          0,
          0,
        );
        for (const s of tree.samples) this.clip(s.clip);
      }
    }
    // A state's cycle is its longest clip: what normalized time, exit times and events measure.
    for (const [name, tree] of Object.entries(options.states)) {
      const clips = typeof tree === 'string' ? [tree] : tree.samples.map((sample) => sample.clip);
      this.durations.set(name, Math.max(0, ...clips.map((clip) => this.clip(clip).duration)));
    }
    for (const t of options.transitions ?? [])
      if (
        (t.from !== '*' && !Object.hasOwn(options.states, t.from)) ||
        !Object.hasOwn(options.states, t.to) ||
        (t.when !== undefined && typeof t.when !== 'function') ||
        (t.trigger !== undefined && (typeof t.trigger !== 'string' || !t.trigger)) ||
        (t.exitTime !== undefined && !(t.exitTime >= 0 && t.exitTime < Infinity)) ||
        (t.when === undefined && t.trigger === undefined && t.exitTime === undefined) ||
        !Number.isFinite(t.duration ?? 0.15) ||
        (t.duration ?? 0.15) < 0
      )
        throw new TypeError(
          "Invalid animator transition; use known from (or '*') and to states, at least one of a when function, a trigger name or an exitTime of 0 or more, and a duration of 0 or more",
        );
    for (const event of options.events ?? []) {
      if (
        !event ||
        !Object.hasOwn(options.states, event.state) ||
        typeof event.name !== 'string' ||
        !event.name ||
        !(event.time >= 0 && event.time <= 1)
      )
        throw new TypeError(
          "Invalid animator event; pass {state, time, name} with a known state, a normalized time from 0 to 1 and a non-empty name, e.g. {state: 'walk', time: 0.5, name: 'footstep'}",
        );
      let list = this.events.get(event.state);
      if (!list) this.events.set(event.state, (list = []));
      list.push(event);
    }
    const writer = options.writeRotation;
    if (writer !== undefined && typeof writer !== 'function')
      throw new TypeError(
        'Invalid animator rotation writer; pass a function (node, rotation) => void or omit writeRotation',
      );
    this.writeRotation = writer;
    const nodes = animation.model.nodes,
      t = animation.model.root.engine.store.transforms;
    const morphWeights = new Map<number, Float32Array>();
    for (const primitive of animation.model.primitives) {
      const weights = morphWeights.get(primitive.nodeIndex);
      if (weights && weights.length !== primitive.weights.length)
        throw new RangeError("Morph target counts must match across a node's primitives");
      if (!weights) morphWeights.set(primitive.nodeIndex, primitive.weights.slice());
    }
    this.rest = {
      position: nodes.map((n) => [t.x[n.id], t.y[n.id], t.z[n.id]]),
      rotation: nodes.map((n) => [t.qx[n.id], t.qy[n.id], t.qz[n.id], t.qw[n.id]]),
      scale: nodes.map((n) => [t.sx[n.id], t.sy[n.id], t.sz[n.id]]),
      weights: morphWeights,
    };
    this.current = clone(this.rest);
    this.singlePose = clone(this.rest);
    this.weightNodes = [...this.rest.weights.keys()];
    // Only morph weights a clip animates are written; every other node's weights stay the application's (expression
    // sliders, lip sync) instead of being reset to their rest values every frame.
    this.morphed = new Set(
      animation.clips.flatMap((clip) =>
        clip.tracks.filter((track) => track.path === 'weights').map((track) => track.node),
      ),
    );
    this.applied = nodes.map(() => new Float64Array(26).fill(NaN));
    this.previousPlaying = animation.playing;
  }
  static attach(animation: Animation, options: AnimatorOptions): Animator {
    const animator = new Animator(animation, options);
    animation.model.root.engine.use(animator);
    return animator;
  }
  private clip(name: string) {
    const clips = this.animation.clips;
    for (let i = 0; i < clips.length; i++) if (clips[i].name === name) return clips[i];
    throw new RangeError(`Unknown animator clip "${name}"; use a clip name from animation.clips`);
  }
  transition(state: string, duration = 0.15): this {
    if (this.disposed || !Object.hasOwn(this.options.states, state) || !Number.isFinite(duration) || duration < 0)
      throw new RangeError(
        'Invalid animator transition; pass a state name from options.states and a duration of 0 or more, on an Animator that is not disposed',
      );
    if (state === this.state) return this;
    const from = this.state;
    this.fade = duration ? { pose: clone(this.current), elapsed: 0, duration, from } : undefined;
    this.state = state;
    this.time = 0;
    this.entry = 0;
    this.entered = true;
    this.emit('statechange', { from, to: state, duration });
    return this;
  }
  /**
   * Time in the current state as a fraction of its cycle (its longest clip): 0 on entry, 1 after one cycle, 2.5
   * halfway through the third. A state whose clips have no duration reads 1.
   */
  get normalizedTime(): number {
    const duration = this.durations.get(this.state) ?? 0;
    return duration > 0 ? this.time / duration : 1;
  }
  /** Sets a trigger: the next transition that lists it (and whose other conditions hold) is taken and clears it. */
  setTrigger(name: string): this {
    if (typeof name !== 'string' || !name)
      throw new TypeError('Animator trigger needs a non-empty name; pass the trigger a transition lists');
    this.triggers.add(name);
    return this;
  }
  /** Clears a trigger that no transition has taken yet. */
  resetTrigger(name: string): this {
    this.triggers.delete(name);
    return this;
  }
  /** True while `name` is set and not yet taken by a transition. */
  hasTrigger(name: string): boolean {
    return this.triggers.has(name);
  }
  /** Subscribes to timed events or state changes. Returns an unsubscribe function. */
  on<K extends keyof AnimatorEventMap>(type: K, listener: (event: AnimatorEventMap[K]) => void): () => void {
    if (typeof listener !== 'function')
      throw new TypeError("Animator listener must be a function: animator.on('event', (e) => {})");
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as (event: never) => void);
    return () => {
      set!.delete(listener as (event: never) => void);
    };
  }
  private emit<K extends keyof AnimatorEventMap>(type: K, event: AnimatorEventMap[K]): void {
    const set = this.listeners.get(type);
    if (set) for (const listener of [...set]) (listener as (event: AnimatorEventMap[K]) => void)(event);
  }
  /** Emits the current state's timed events passed between state times `from` and `to` (seconds), loops included. */
  private fireEvents(from: number, to: number): void {
    const entered = this.entered;
    this.entered = false;
    const list = this.events.get(this.state);
    if (!list || !this.listeners.get('event')?.size || (!(to > from) && !entered)) return;
    const duration = this.durations.get(this.state) ?? 0,
      loop = (this.animation.options.loop ?? true) && duration > 0,
      state = this.state;
    for (const e of list) {
      const at = e.time * duration;
      // Every cycle k whose moment k * duration + at lies in (from, to], or [from, to] on the frame the state began.
      for (let k = loop ? Math.max(0, Math.ceil((from - at) / duration)) : 0; ; k++) {
        const moment = k * duration + at;
        if (moment > to) break;
        if (moment > from || (entered && moment >= from))
          this.emit('event', { name: e.name, state, time: e.time, data: e.data });
        if (!loop) break;
      }
    }
  }
  addLayer(layer: AdditiveLayer): () => void {
    this.clip(layer.clip);
    this.validateLayer(layer);
    this.layers.add(layer);
    return () => this.layers.delete(layer);
  }
  private validateLayer(layer: AdditiveLayer): void {
    if (
      this.disposed ||
      (layer.blend !== undefined && layer.blend !== 'additive' && layer.blend !== 'override') ||
      !(layer.time === undefined || (layer.time >= 0 && layer.time < Infinity)) ||
      !Number.isFinite(layer.weight) ||
      layer.weight < 0 ||
      layer.weight > 1 ||
      !Array.isArray(layer.mask) ||
      layer.mask.some((i) => !Number.isInteger(i) || i < 0 || i >= this.animation.model.nodes.length) ||
      !Number.isFinite(layer.referenceTime ?? 0) ||
      (layer.referenceTime ?? 0) < 0
    )
      throw new RangeError(
        "Invalid animator layer; use a weight from 0 to 1, a mask of node indices inside the model, blend 'additive' or 'override', and a time and referenceTime of 0 or more, on an Animator that is not disposed",
      );
  }
  addFootIK(foot: FootIK): () => void {
    const nodes = this.animation.model.nodes;
    if (
      this.disposed ||
      [foot.hip, foot.knee, foot.ankle].some((i) => !Number.isInteger(i) || i < 0 || i >= nodes.length) ||
      typeof foot.raycast !== 'function' ||
      !Number.isFinite(foot.offset ?? 0) ||
      !Number.isFinite(foot.probeHeight ?? 1) ||
      (foot.probeHeight ?? 1) <= 0
    )
      throw new TypeError(
        'Invalid foot IK; pass hip, knee and ankle node indices inside the model, a raycast function, a finite offset and a probeHeight above 0, on an Animator that is not disposed',
      );
    finiteVector(foot.pole, 3, 'IK pole');
    const parents = nodes[0].engine.store.parents;
    if (parents[nodes[foot.knee].id] !== nodes[foot.hip].id || parents[nodes[foot.ankle].id] !== nodes[foot.knee].id)
      throw new TypeError(
        'IK requires a direct hip/knee/ankle chain; pass a knee that is a child of the hip and an ankle that is a child of the knee',
      );
    this.feet.add(foot);
    return () => this.feet.delete(foot);
  }
  /**
   * @internal A step run every frame after the pose, the additive layers and foot IK, with the skeleton's world matrices
   * current ({@link addCCDChain} adds one per chain). Returns its remover.
   */
  addSolver(step: () => void): () => void {
    if (this.disposed) throw new MargoError('disposed', 'Animator is disposed; attach a new Animator');
    this.solvers.push(step);
    return () => {
      const index = this.solvers.indexOf(step);
      if (index !== -1) this.solvers.splice(index, 1);
    };
  }
  /**
   * @internal A step that edits the current state's sampled pose (local translations and rotations per glTF node)
   * before crossfades, additive layers and foot IK ({@link addRootMotion} adds one). Returns its remover.
   */
  addPoseStep(step: (position: number[][], rotation: number[][]) => void): () => void {
    if (this.disposed) throw new MargoError('disposed', 'Animator is disposed; attach a new Animator');
    this.poseSteps.push(step);
    return () => {
      const index = this.poseSteps.indexOf(step);
      if (index !== -1) this.poseSteps.splice(index, 1);
    };
  }
  /**
   * @internal A step that edits a state's pose when a crossfade samples the state it is leaving, which a pose step does
   * not see ({@link addRootMotion} takes the travel out). Returns its remover.
   */
  addFadeStep(step: (position: number[][], rotation: number[][], state: string, time: number) => void): () => void {
    if (this.disposed) throw new MargoError('disposed', 'Animator is disposed; attach a new Animator');
    this.fadeSteps.push(step);
    return () => {
      const index = this.fadeSteps.indexOf(step);
      if (index !== -1) this.fadeSteps.splice(index, 1);
    };
  }
  /**
   * @internal A step that edits the finished pose (after crossfades and layers, before it reaches the nodes, foot IK and
   * the solvers), with the seconds of animation time this frame advanced. Returns its remover.
   */
  addLateStep(step: (pose: Pose, step: number) => void): () => void {
    if (this.disposed) throw new MargoError('disposed', 'Animator is disposed; attach a new Animator');
    this.lateSteps.push(step);
    return () => {
      const index = this.lateSteps.indexOf(step);
      if (index !== -1) this.lateSteps.splice(index, 1);
    };
  }
  /** @internal Gives `state` its own clock, or takes it away with null. */
  setStateClock(state: string, clock: StateClock | null): void {
    if (clock) this.clocks.set(state, clock);
    else this.clocks.delete(state);
  }
  /** @internal True when `state` has its own clock. */
  hasStateClock(state: string): boolean {
    return this.clocks.has(state);
  }
  /** @internal Starts the state just entered at `time` instead of 0. */
  enterAt(time: number): void {
    this.time = time;
    this.entry = time;
  }
  /** @internal The state time the current state started at. */
  get entryTime(): number {
    return this.entry;
  }
  /** @internal Seconds along `clip`, counted over its loops, at `state`'s `time`. */
  clipTime(clip: string, time: number, state = this.state): number {
    const clock = this.clocks.get(state);
    return clock ? clock.clipTime(clip, time) : time;
  }
  /** @internal Ends the crossfade in progress: the pose jumps to the current state on this frame. */
  cancelFade(): void {
    this.fade = undefined;
  }
  /** @internal Node `index`'s rest (loaded) rotation, x y z w; read-only. */
  restRotation(index: number): readonly number[] {
    return this.rest.rotation[index];
  }
  /** @internal Commits a node rotation through `writeRotation` (or `Mesh.setQuaternion`), as the pose and foot IK do. */
  writeNodeRotation(node: Mesh, rotation: readonly number[]): void {
    this.commitRotation(node, rotation);
  }
  setup(engine: Engine): void {
    if (
      this.disposed ||
      this.animation.model.disposed ||
      engine !== this.animation.model.root.engine ||
      !engine.hasPlugin(this.animation.name)
    )
      throw new MargoError(
        'state',
        'Attach Animation before its Animator; call Animation.attach(model) on the same engine first, and use an Animation and Animator that are not disposed',
      );
    this.engine = engine;
    this.animation.playing = false;
    this.unsubscribe = this.animation.model.onDispose(() => this.dispose());
  }
  onPreUpdate(delta: number): void {
    if (this.rotationWriteActive)
      throw new MargoError(
        'state',
        'Animator rotation writer cannot reenter updates; do not call onPreUpdate or change the Animator from inside writeRotation',
      );
    if (this.disposed) return;
    if (this.engine && !this.engine.hasPlugin(this.animation.name)) {
      this.dispose();
      return;
    }
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid animator delta; pass a finite delta of 0 or more seconds');
    this.animation.playing = false;
    for (const v of Object.values(this.parameters))
      if (!Number.isFinite(v))
        throw new RangeError('Invalid blend parameter; set every animator.parameters value to a finite number');
    const transitions = this.options.transitions;
    if (transitions) {
      const normalized = this.normalizedTime;
      for (const t of transitions) {
        if (t.from === '*' ? t.to === this.state : t.from !== this.state) continue;
        if (t.exitTime !== undefined && normalized < t.exitTime) continue;
        if (t.trigger !== undefined && !this.triggers.has(t.trigger)) continue;
        if (t.when && !t.when(this.parameters)) continue;
        if (t.trigger !== undefined) this.triggers.delete(t.trigger);
        this.transition(t.to, t.duration);
        break;
      }
    }
    const speed = this.animation.options.speed ?? 1;
    if (!Number.isFinite(speed) || speed < 0) throw new RangeError('Animation speed must be a finite number >= 0');
    const step = this.playing ? delta * speed : 0,
      before = this.time;
    const clock = this.clocks.get(this.state);
    this.time = clock ? clock.advance(this.time, step) : this.time + step;
    if (this.events.size) this.fireEvents(before, this.time);
    else this.entered = false;
    const tree = this.options.states[this.state];
    let pose: Pose | undefined;
    // One unlayered clip needs one owned pose, not a deep clone of every node
    // on every frame. Transition snapshots remain independent clones.
    if (typeof tree === 'string' && !this.fade && this.layers.size === 0) {
      pose = this.sample(tree, this.clipTime(tree, this.time), this.animation.options.loop ?? true, this.singlePose);
    } else pose = this.treePose(this.state, this.time);
    if (!pose) pose = clone(this.rest);
    for (let i = 0; i < this.poseSteps.length; i++) this.poseSteps[i](pose.position, pose.rotation);
    if (this.fade) {
      const f = this.fade,
        follow = clock?.follow?.(f.from, this.time),
        from = follow === undefined ? undefined : this.treePose(f.from, follow);
      if (from)
        for (let i = 0; i < this.fadeSteps.length; i++) this.fadeSteps[i](from.position, from.rotation, f.from, follow!);
      f.elapsed += step;
      pose = this.mix(from ?? clone(f.pose), pose, Math.min(1, f.elapsed / f.duration));
      if (f.elapsed >= f.duration) this.fade = undefined;
    }
    if (this.layers.size)
      for (const layer of this.layers) {
        this.validateLayer(layer);
        const sample = this.sample(layer.clip, layer.time ?? this.time);
        if (layer.blend === 'override') {
          // Blend the masked bones toward the clip's pose.
          const w = layer.weight;
          for (const i of layer.mask) {
            for (let c = 0; c < 3; c++) {
              pose.position[i][c] += (sample.position[i][c] - pose.position[i][c]) * w;
              pose.scale[i][c] += (sample.scale[i][c] - pose.scale[i][c]) * w;
            }
            pose.rotation[i] = quaternionBlend(pose.rotation[i], sample.rotation[i], w);
            const weights = pose.weights.get(i),
              sampleWeights = sample.weights.get(i);
            if (weights && sampleWeights)
              for (let j = 0; j < weights.length; j++) weights[j] += (sampleWeights[j] - weights[j]) * w;
          }
          continue;
        }
        const reference = this.sample(layer.clip, layer.referenceTime ?? 0, false);
        for (const i of layer.mask) {
          for (let c = 0; c < 3; c++) {
            pose.position[i][c] += (sample.position[i][c] - reference.position[i][c]) * layer.weight;
            const referenceScale = reference.scale[i][c];
            if (referenceScale !== 0 && layer.weight !== 0)
              pose.scale[i][c] *= 1 + (sample.scale[i][c] / referenceScale - 1) * layer.weight;
          }
          const weights = pose.weights.get(i),
            sampleWeights = sample.weights.get(i),
            referenceWeights = reference.weights.get(i);
          if (weights && sampleWeights && referenceWeights)
            for (let j = 0; j < weights.length; j++)
              weights[j] += (sampleWeights[j] - referenceWeights[j]) * layer.weight;
          const inverse = [
              -reference.rotation[i][0],
              -reference.rotation[i][1],
              -reference.rotation[i][2],
              reference.rotation[i][3],
            ],
            difference = quaternionMultiply(inverse, sample.rotation[i]);
          pose.rotation[i] = quaternionMultiply(
            pose.rotation[i],
            quaternionBlend([0, 0, 0, 1], difference, layer.weight),
          );
        }
      }
    for (let i = 0; i < this.lateSteps.length; i++) this.lateSteps[i](pose, step);
    this.current = pose;
    const nodes = this.animation.model.nodes;
    for (let i = 0; i < nodes.length; i++) this.applyNode(nodes[i], pose, i);
    const primitives = this.animation.model.primitives;
    for (let i = 0; i < primitives.length; i++) {
      const p = primitives[i];
      const weights = pose.weights.get(p.nodeIndex);
      if (weights && this.morphed.has(p.nodeIndex)) p.weights.set(weights);
    }
    if (this.feet.size) for (const foot of this.feet) this.foot(foot);
    if (this.solvers.length) {
      // World matrices of the posed skeleton: the solvers' parent frames.
      this.engine!.store.tick(false);
      for (let i = 0; i < this.solvers.length; i++) this.solvers[i]();
    }
  }
  // Compare both the requested values and the exact stored result. External
  // edits (including Euler rotations and store growth) still force restoration;
  // unchanged static nodes need no repeated normalization or setter temporaries.
  private applyNode(node: Mesh, pose: Pose, index: number): void {
    node.check();
    const t = node.engine.store.transforms,
      id = node.id,
      cache = this.applied[index],
      p = pose.position[index],
      s = pose.scale[index],
      q = pose.rotation[index],
      // The node's Euler lanes (what mesh.rotation reads), straight from the store like the transforms above.
      r = node.engine.store.rotations,
      e = id * 3;
    if (
      p.length !== 3 ||
      p[0] !== cache[0] ||
      p[1] !== cache[1] ||
      p[2] !== cache[2] ||
      t.x[id] !== cache[13] ||
      t.y[id] !== cache[14] ||
      t.z[id] !== cache[15]
    ) {
      node.setPosition(p as [number, number, number]);
      cache[0] = p[0];
      cache[1] = p[1];
      cache[2] = p[2];
      cache[13] = t.x[id];
      cache[14] = t.y[id];
      cache[15] = t.z[id];
    }
    if (
      s.length !== 3 ||
      s[0] !== cache[3] ||
      s[1] !== cache[4] ||
      s[2] !== cache[5] ||
      t.sx[id] !== cache[16] ||
      t.sy[id] !== cache[17] ||
      t.sz[id] !== cache[18]
    ) {
      node.setScale(s as [number, number, number]);
      cache[3] = s[0];
      cache[4] = s[1];
      cache[5] = s[2];
      cache[16] = t.sx[id];
      cache[17] = t.sy[id];
      cache[18] = t.sz[id];
    }
    if (
      q.length !== 4 ||
      q[0] !== cache[6] ||
      q[1] !== cache[7] ||
      q[2] !== cache[8] ||
      q[3] !== cache[9] ||
      t.qx[id] !== cache[19] ||
      t.qy[id] !== cache[20] ||
      t.qz[id] !== cache[21] ||
      t.qw[id] !== cache[22] ||
      r[e] !== cache[23] ||
      r[e + 1] !== cache[24] ||
      r[e + 2] !== cache[25]
    ) {
      this.commitRotation(node, q);
      cache[6] = q[0];
      cache[7] = q[1];
      cache[8] = q[2];
      cache[9] = q[3];
      cache[19] = t.qx[id];
      cache[20] = t.qy[id];
      cache[21] = t.qz[id];
      cache[22] = t.qw[id];
      cache[23] = r[e];
      cache[24] = r[e + 1];
      cache[25] = r[e + 2];
    }
  }
  private commitRotation(node: Mesh, rotation: readonly number[]): void {
    const writer = this.writeRotation;
    if (!writer) {
      node.setQuaternion(rotation);
      return;
    }
    if (this.rotationWriteActive)
      throw new MargoError(
        'state',
        'Animator rotation writer cannot reenter updates; do not call onPreUpdate or change the Animator from inside writeRotation',
      );
    this.rotationWriteActive = true;
    try {
      writer(node, rotation);
    } finally {
      this.rotationWriteActive = false;
    }
  }
  /** State `state`'s clips, blended at its `time`; undefined when no clip has weight. */
  private treePose(state: string, time: number): Pose | undefined {
    const { clips, weights } = treeWeights(this.options.states[state], this.parameters),
      clock = this.clocks.get(state),
      loop = this.animation.options.loop ?? true;
    let pose: Pose | undefined,
      total = 0;
    for (let i = 0; i < clips.length; i++)
      if (weights[i] > 0) {
        const sampled = this.sample(clips[i], clock ? clock.clipTime(clips[i], time) : time, loop);
        total += weights[i];
        pose = pose ? this.mix(pose, sampled, weights[i] / total) : sampled;
      }
    return pose;
  }
  private sample(name: string, time: number, loop = true, out?: Pose): Pose {
    const clip = this.clip(name),
      pose = out ? copyPose(this.rest, out, this.weightNodes) : clone(this.rest),
      t = loop && clip.duration > 0 ? time % clip.duration : Math.min(time, clip.duration);
    // Sample into one scratch buffer per track width, then copy into the vectors this pose already owns.
    for (let i = 0; i < clip.tracks.length; i++) {
      const track = clip.tracks[i];
      const width = track.width;
      let scratch = this.scratch.get(width);
      if (!scratch) this.scratch.set(width, (scratch = new Float32Array(width)));
      const values = sampleTrackInto(
        track.times,
        track.values,
        width,
        t,
        track.interpolation,
        track.path === 'rotation',
        scratch,
      );
      if (track.path === 'weights') {
        const own = pose.weights.get(track.node);
        if (own instanceof Float32Array && own.length === width) own.set(values);
        else pose.weights.set(track.node, values.slice());
        continue;
      }
      const list = pose[track.path === 'translation' ? 'position' : track.path],
        own = list[track.node];
      if (own?.length === width) for (let c = 0; c < width; c++) own[c] = values[c];
      else list[track.node] = Array.from(values);
    }
    return pose;
  }
  private mix(a: Pose, b: Pose, weight: number): Pose {
    const out = a;
    for (let i = 0; i < out.position.length; i++) {
      for (let c = 0; c < 3; c++) {
        out.position[i][c] = a.position[i][c] * (1 - weight) + b.position[i][c] * weight;
        out.scale[i][c] = a.scale[i][c] * (1 - weight) + b.scale[i][c] * weight;
      }
      const q = a.rotation[i];
      out.rotation[i] = quaternionBlend(q, b.rotation[i], weight, q.length === 4 ? q : undefined);
    }
    for (const [id, values] of out.weights) {
      const other = b.weights.get(id);
      if (other) for (let i = 0; i < values.length; i++) values[i] = values[i] * (1 - weight) + other[i] * weight;
    }
    return out;
  }
  private worldRotation(node: Mesh): number[] {
    const t = node.engine.store.transforms,
      parents = node.engine.store.parents;
    let q = [0, 0, 0, 1];
    const chain: number[] = [];
    for (let id = node.id; id !== -1; id = parents[id]) chain.push(id);
    for (const id of chain.reverse()) {
      if (t.sx[id] <= 0 || Math.abs(t.sx[id] - t.sy[id]) > 1e-5 || Math.abs(t.sx[id] - t.sz[id]) > 1e-5)
        throw new RangeError(
          'Foot IK requires positive uniform bone and ancestor scales; set the leg bones and their parents to one equal positive scale',
        );
      q = quaternionMultiply(q, [t.qx[id], t.qy[id], t.qz[id], t.qw[id]]);
    }
    return q;
  }
  private rotateWorld(node: Mesh, delta: number[]): void {
    const id = node.engine.store.parents[node.id],
      parent = id === -1 ? [0, 0, 0, 1] : this.worldRotation(node.engine.meshes.get(id)!),
      world = quaternionMultiply(delta, this.worldRotation(node));
    this.commitRotation(node, quaternionMultiply([-parent[0], -parent[1], -parent[2], parent[3]], world));
  }
  private foot(foot: FootIK): void {
    const nodes = this.animation.model.nodes,
      hip = nodes[foot.hip],
      knee = nodes[foot.knee],
      ankle = nodes[foot.ankle],
      position = (node: Mesh) => Array.from(node.matrix.subarray(12, 15)) as [number, number, number],
      subtract = (a: Vec3, b: Vec3) => a.map((v, i) => v - b[i]) as [number, number, number];
    this.engine!.store.tick(false);
    const start = position(ankle),
      hit = foot.raycast([start[0], start[1] + (foot.probeHeight ?? 1), start[2]], [0, -1, 0]);
    if (!hit) return;
    finiteVector(hit.position, 3, 'Ground hit');
    if (hit.normal) finiteVector(hit.normal, 3, 'Ground normal');
    const target: [number, number, number] = [hit.position[0], hit.position[1] + (foot.offset ?? 0), hit.position[2]],
      root = position(hip),
      solved = solveTwoBoneIK(root, position(knee), start, target, foot.pole);
    this.rotateWorld(hip, rotationBetween(subtract(position(knee), root), subtract(solved.knee, root)));
    this.engine!.store.tick(false);
    this.rotateWorld(
      knee,
      rotationBetween(subtract(position(ankle), position(knee)), subtract(solved.ankle, position(knee))),
    );
    this.engine!.store.tick(false);
    if (hit.normal) {
      const m = ankle.matrix;
      this.rotateWorld(ankle, rotationBetween([m[4], m[5], m[6]], hit.normal));
      this.engine!.store.tick(false);
    }
  }
  onDeviceRestored(): void {
    this.animation.playing = false;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.animation.playing = this.previousPlaying;
    this.layers.clear();
    this.feet.clear();
    this.listeners.clear();
    this.triggers.clear();
    this.solvers.length = 0;
    this.poseSteps.length = 0;
    this.lateSteps.length = 0;
    this.fadeSteps.length = 0;
    this.clocks.clear();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
