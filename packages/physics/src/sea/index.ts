// `@margoengine/physics/sea`: the sea's surface and the water below it (SEA-02 of docs/physics-solvers.md), synthesised from
// the wave solver's spectrum (`@margoengine/physics/waves`) and read by hulls, swimmers, kelp and spray through the
// sea-surface contract of `@margoengine/math/fields`.
export { SpectralSea, type SpectralSeaOptions } from './surface.js';
export {
  WAKE_HEIGHT_FIELD,
  WAKE_LAYOUT,
  WAKE_SOURCE_LAYOUT,
  WAKE_SOURCE_WORDS,
  WakeSolver,
  type WakeParams,
  type WakeSample,
} from './wake.js';
export { SUBMERGED_WAKE_LAYOUT, SUBMERGED_WAKE_WORDS, type SubmergedWakeSource } from './submerged-wake.js';
