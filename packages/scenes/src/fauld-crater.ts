/// <reference lib="esnext.disposable" preserve="true" />
// The Fauld crater: the raw 1944 bowl (about 230 m across and 30 m deep where Upper Castle Hayes Farm stood) or the
// wooded hollow today, from the crater models (own, Blender) blended into the real OS Terrain 50 ground, with the farm
// quilt round it, winter sky and weather. The memorials and the guard hut stand in `FAULD_SLOTS` and later passes.
// Ground, layout and sources: ./fauld-world.ts.
import type { EngineKernel } from '@margoengine/core';
import { attachFauldWorld, type FauldWorld, type FauldWorldSettings } from './fauld-world.js';

export {
  FAULD_CENTRE,
  FAULD_CLOUD_DECK,
  FAULD_PLACES,
  FAULD_SIZE,
  FAULD_SLOTS,
  type FauldEra,
  type FauldSky,
} from './fauld-world.js';

/** Settings of {@link attach}: the shared Fauld settings; the era defaults to `1944` (the fresh crater). */
export type FauldCraterSettings = FauldWorldSettings;

/**
 * Builds the crater into `engine`.
 * @example
 * const scene = await attach(engine, { era: 'today', sky: 'mist' });
 * scene.look([300, 140, 300], [0, 90, 0], 40);
 */
export function attach(engine: EngineKernel, settings: FauldCraterSettings = {}): Promise<FauldWorld> {
  return attachFauldWorld(engine, { era: '1944', ...settings });
}
