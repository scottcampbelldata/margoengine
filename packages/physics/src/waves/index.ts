// `@margoengine/physics/waves`: the physics framework's sea waves (docs/physics-solvers.md, SEA-01): a spectral wave model
// driven by the wind, publishing the spectrum the sea surface synthesises.
export {
  FRESH_WATER_DENSITY,
  SEA_WATER_DENSITY,
  WAVE_LAYOUT,
  WAVE_SPECTRUM_FIELD,
  WaveSolver,
  bandWidth,
  groupVelocity,
  jonswap,
  peakFrequency,
  significantHeight,
  wavenumber,
  type SeaState,
  type WaveParams,
  type WaveSolverNativeOptions,
} from './spectral.js';
export type { WaveTransportWorkerWork, WaveTransportWorkCounts } from './transport-kernel.js';
