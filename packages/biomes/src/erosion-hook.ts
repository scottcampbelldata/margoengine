// How createRelief erodes a landscape: the erosion entry (`@margoengine/biomes/erosion`) sets `erode` when it loads, so
// the relief entry holds none of its code and a world without erosion never loads it.
import type { ReliefErosionOptions } from './erosion.js';
import type { Relief } from './relief.js';

/** Set by the erosion entry: wraps a relief in its eroded heights. */
export const erosionHook: { erode?: (relief: Relief, options: ReliefErosionOptions) => Relief } = {};
