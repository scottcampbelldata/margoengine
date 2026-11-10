import type { Animator } from './index.js';
import { StateLayer, type StateLayerOptions } from './layers.js';
import type { AnimatorGraphDocument } from './graph.js';

/** Dense per-node weights in glTF node order. Values may be edited between frames. */
export type BoneMask = Float32Array;
/** A graph or a single clip with soft per-bone influence. */
export type WeightedLayerOptions = Pick<StateLayerOptions, 'weight' | 'blend'> & {
  /** One finite 0..1 weight for every model node. Retained and read every frame. */
  mask: ArrayLike<number>;
} & ({ clip: string; graph?: never } | { graph: AnimatorGraphDocument; clip?: never });

/** Builds a dense mask. Unlisted bones use defaultWeight (default 0); entries are node/weight pairs. */
export function createBoneMask(
  nodeCount: number,
  entries: Iterable<readonly [number, number]> = [],
  defaultWeight = 0,
): BoneMask {
  if (
    !Number.isSafeInteger(nodeCount) ||
    nodeCount < 0 ||
    !Number.isFinite(defaultWeight) ||
    defaultWeight < 0 ||
    defaultWeight > 1
  )
    throw new RangeError(
      'Bone mask needs a nonnegative node count and default weight 0..1; correct the mask dimensions',
    );
  const mask = new Float32Array(nodeCount).fill(defaultWeight),
    seen = new Set<number>();
  for (const [id, weight] of entries) {
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      id >= nodeCount ||
      seen.has(id) ||
      !Number.isFinite(weight) ||
      weight < 0 ||
      weight > 1
    )
      throw new RangeError(
        'Bone mask entries need unique model node indices and weights 0..1; correct the node/weight pairs',
      );
    seen.add(id);
    mask[id] = weight;
  }
  return mask;
}

/** Adds a soft masked clip or independent state graph. Effective influence is layer weight times bone weight. */
export function addWeightedLayer(animator: Animator, options: WeightedLayerOptions): StateLayer {
  const graph = options.graph ?? { initial: 'clip', states: { clip: options.clip! } };
  return new StateLayer(animator, {
    graph,
    weight: options.weight,
    blend: options.blend,
    mask: animator.animation.model.nodes.map((_, id) => id),
    nodeWeights: options.mask,
  });
}
