// `@margoengine/physics/sea`: the sea's surface and the water below it (SEA-02 of docs/physics-solvers.md), synthesised from
// the wave solver's spectrum (`@margoengine/physics/waves`) and read by hulls, swimmers, kelp and spray through the
// sea-surface contract of `@margoengine/math/fields`.
export { SpectralSea, type SpectralSeaOptions } from './surface.js';
export { bakeWakeHullMask, type WakeHullMaskGrid } from './wake-hull-mask.js';
export {
  WAKE_HEIGHT_FIELD,
  WAKE_LAYOUT,
  WAKE_SOURCE_LAYOUT,
  WAKE_SOURCE_WORDS,
  WakeSolver,
  type WakeBreakingOptions,
  type WakeNativeWorkCounts,
  type WakeNativeWorkerWork,
  type WakeParams,
  type WakeSample,
} from './wake.js';
export {
  WAKE_BREAKING_FIELD,
  WAKE_BREAKING_HEADER_WORDS,
  WAKE_BREAKING_LAYOUT,
  WAKE_BREAKING_THRESHOLD,
  WAKE_BREAKING_WORDS,
} from './wake-breaking.js';
export {
  wakeRainEquivalentDrop,
  wakeRainSource,
  wakeRainSources,
  type WakeRainDrop,
  type WakeRainGrid,
  type WakeRainImpact,
  type WakeRainSourcesOptions,
} from './wake-rain.js';
export { SUBMERGED_WAKE_LAYOUT, SUBMERGED_WAKE_WORDS, type SubmergedWakeSource } from './submerged-wake.js';
