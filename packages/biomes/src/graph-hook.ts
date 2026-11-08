// How placement reads a rule graph: the graph entry (`@margoengine/biomes/graph`) sets `factors` when it loads, so the
// placement entry holds none of its code and a placement without a graph never loads it.
import type { PlacementGraph } from './graph.js';

/** A species' density factor at cell `k` of the fields, at world position x, z in ticks (1/256 m): Q16.16, 0..1. */
export type GraphFactor = (
  layers: Readonly<Record<string, ArrayLike<number>>>,
  k: number,
  x: number,
  z: number,
) => number;

/** Set by the graph entry: each species' factor (palette order), undefined where no output selects it. */
export const graphHook: {
  factors?: (
    graph: PlacementGraph,
    species: readonly { readonly key: string; readonly id: string; readonly tags: readonly string[] }[],
  ) => (GraphFactor | undefined)[];
} = {};
