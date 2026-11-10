/// <reference lib="esnext.disposable" preserve="true" />
import { multiplyQuaternions } from '@margoengine/math/quat';

import type { Animator, Pose } from './index.js';
import { AnimatorGraph, type AnimatorGraphDocument } from './graph.js';
import { quaternionBlend } from './blend.js';

/** A state graph composited over the Animator, in installation order. */
export interface StateLayerOptions {
  /** Independent states, transitions, parameters, triggers and timed events. */
  graph: AnimatorGraphDocument;
  /** Live strength, from 0 to 1. Default 1. */
  weight?: number;
  /** glTF node indices; omitted means every node animated by the graph's clips. */
  mask?: readonly number[];
  /** @internal Optional dense per-node influence, supplied by the masks entry. */
  nodeWeights?: ArrayLike<number>;
  /** Override blends toward the graph; additive adds its difference from the loaded pose. Default override. */
  blend?: 'override' | 'additive';
}

/** An independently playing graph layer. Dispose removes it without detaching the base Animator. */
export class StateLayer {
  /** The layer's graph; set parameters, triggers or explicit transitions here. */
  readonly graph: AnimatorGraph;
  /** Live layer weight, 0 to 1. Zero still advances its state machine. */
  weight: number;
  /** Live node selection. An empty mask affects no nodes. */
  mask: readonly number[];
  /** @internal Dense influence, retained and read every frame when present. */
  nodeWeights?: ArrayLike<number>;
  /** Live compositing mode. */
  blend: 'override' | 'additive';
  private readonly off: () => void;
  private readonly offModel: () => void;
  private disposed = false;

  /** Installs one layer; prefer addStateLayer for the same operation as a function. */
  constructor(
    private readonly animator: Animator,
    options: StateLayerOptions,
  ) {
    this.weight = options.weight ?? 1;
    this.blend = options.blend ?? 'override';
    this.nodeWeights = options.nodeWeights;
    const names = new Set(
      Object.values(options.graph.states).flatMap((tree) =>
        typeof tree === 'string' ? [tree] : tree.samples.map((sample) => sample.clip),
      ),
    );
    this.mask = options.mask ?? [
      ...new Set(
        animator.animation.clips
          .filter((clip) => names.has(clip.name))
          .flatMap((clip) => clip.tracks.map((track) => track.node)),
      ),
    ];
    this.validate();
    this.graph = new AnimatorGraph(animator.animation, options.graph);
    this.graph.animator.copyRestFrom(animator);
    for (const [id, values] of animator.captureState().rest.weights) this.references.set(id, new Float32Array(values));
    this.off = animator.addLateStep((pose, step) => {
      this.validate();
      // step already includes the owner's pause and Animation speed. The evaluator applies speed once itself.
      const speed = animator.animation.options.speed ?? 1;
      const layer = this.graph.animator.onPreUpdate(speed > 0 ? step / speed : 0, true);
      if (layer && this.weight > 0) this.compose(pose, layer);
    });
    this.offModel = animator.onDispose(() => this.dispose());
  }

  private validate(): void {
    if (
      this.nodeWeights !== undefined &&
      (this.nodeWeights.length !== this.animator.animation.model.nodes.length ||
        Array.from(this.nodeWeights).some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 1))
    )
      throw new RangeError('Weighted layer needs one finite 0..1 weight per model node; correct the bone mask');
    if (
      !Number.isFinite(this.weight) ||
      this.weight < 0 ||
      this.weight > 1 ||
      !['override', 'additive'].includes(this.blend) ||
      !Array.isArray(this.mask) ||
      new Set(this.mask).size !== this.mask.length ||
      this.mask.some((id) => !Number.isInteger(id) || id < 0 || id >= this.animator.animation.model.nodes.length)
    )
      throw new RangeError(
        'State layer needs weight 0..1, a unique mask of model node indices and override or additive blend; correct the layer options',
      );
  }

  private compose(pose: Pose, layer: Pose): void {
    for (const id of this.mask) {
      const w = this.weight * (this.nodeWeights?.[id] ?? 1);
      if (w === 0) continue;
      const additive = this.blend === 'additive';
      for (let c = 0; c < 3; c++) {
        pose.position[id][c] +=
          (layer.position[id][c] - (additive ? this.animator.restPosition(id)[c] : pose.position[id][c])) * w;
        const rest = this.animator.restScale(id)[c];
        if (additive) {
          if (rest !== 0) pose.scale[id][c] *= 1 + (layer.scale[id][c] / rest - 1) * w;
        } else pose.scale[id][c] += (layer.scale[id][c] - pose.scale[id][c]) * w;
      }
      if (additive) {
        const q = this.animator.restRotation(id);
        const delta = multiplyQuaternions([-q[0], -q[1], -q[2], q[3]], layer.rotation[id]);
        pose.rotation[id] = multiplyQuaternions(pose.rotation[id], quaternionBlend([0, 0, 0, 1], delta, w));
      } else pose.rotation[id] = quaternionBlend(pose.rotation[id], layer.rotation[id], w);
      const own = pose.weights.get(id),
        other = layer.weights.get(id);
      if (own && other) {
        // Morph references are captured before graph playback, just like transform references.
        const rest = this.references.get(id)!;
        for (let c = 0; c < own.length; c++) own[c] += (other[c] - (additive ? rest[c] : own[c])) * w;
      }
    }
  }
  private readonly references = new Map<number, Float32Array>();

  /** Removes this layer. Repeated disposal is harmless. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.offModel();
    const playing = this.animator.animation.playing;
    this.graph.dispose();
    this.animator.animation.playing = playing;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** Adds an independent state machine with live weight and mask, after existing layers and before IK. */
export function addStateLayer(animator: Animator, options: StateLayerOptions): StateLayer {
  return new StateLayer(animator, options);
}
