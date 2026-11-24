/// <reference lib="esnext.disposable" preserve="true" />
// Fauld countryside, November 1944 and today: the hedged clay hills round Hanbury, Fauld and the Dove valley on the real
// OS Terrain 50 ground, with the farm quilt, hedges and hedge trees, lanes, woods, a winter sky and weather. The
// buildings (St Werburgh's, the Cock Inn, cottages, the farm, Ford's works) and cattle are Tripo models that come later:
// their slots are `FAULD_SLOTS`, drawn as nothing until a model is given, so shots frame the land and keep buildings at
// 150 m or more. Ground, layout and sources: ./fauld-world.ts.
import type { EngineKernel } from '@margoengine/core';
import { attachFauldWorld, type FauldWorld, type FauldWorldSettings } from './fauld-world.js';

export { FAULD_CENTRE, FAULD_PLACES, FAULD_SIZE, FAULD_SLOTS, type FauldEra, type FauldSky } from './fauld-world.js';

/** Settings of {@link attach}: the shared Fauld settings; the era defaults to `before` (the morning of 27 November 1944). */
export type FauldCountrysideSettings = FauldWorldSettings;

/**
 * Builds the countryside into `engine`.
 * @example
 * const scene = await attach(engine, { sky: 'dawn', focus: [-600, -300] });
 * scene.look([-600, 420, 900], [0, 80, 0], 35);
 */
export function attach(engine: EngineKernel, settings: FauldCountrysideSettings = {}): Promise<FauldWorld> {
  return attachFauldWorld(engine, { era: 'before', ...settings });
}
