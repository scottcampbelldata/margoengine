// How createRelief makes a mountain valley: the valley entry (`@margoengine/biomes/valley`) fills this
// when it loads, so the relief entry holds none of its code and a world without one never loads it.
import type { MountainValley, MountainValleyOptions, MountainValleySettings } from './valley.js';

/** Set by the valley entry: checks the options and builds the valley with its height function. */
export const mountainValleyHook: {
  settings?: (
    options: MountainValleyOptions,
    size: readonly [number, number],
    alone?: boolean,
  ) => MountainValleySettings;
  build?: (
    settings: MountainValleySettings,
    seed: number,
    origin: readonly [number, number],
    size: readonly [number, number],
    base: number,
    relief: number,
  ) => { valley: MountainValley; height: (x: number, z: number) => number };
} = {};
