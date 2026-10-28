// @margoengine/biomes: biome maps from a heightmap and a few climate settings. Everything that decides the output is
// integer arithmetic (spec decision D9), so the same seed gives the same bytes on every platform.
export {
  ONE,
  TURN,
  atan2,
  clampInt,
  degreesToAngle,
  divFloor,
  divWide,
  fade,
  idiv,
  imod,
  isqrt,
  mul64,
  mulHigh,
  mulShift,
  qdiv,
  qexp2,
  qlog2,
  qmul,
  qpow,
  qsqrt,
  sincos,
  udiv,
  umod,
  wendland,
} from './fixed.js';
export { fbm, hash2, hash3, hash4, hash5, pcg, ridged, valueNoise } from './hash.js';
export { createRelief, quantizeHeights, type Relief, type ReliefOptions, type RiverLine } from './relief.js';
export { R16 } from './r16.js';
