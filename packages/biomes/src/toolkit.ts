// The integer toolkit of the biomes package (entry `@margoengine/biomes/toolkit`): fixed-point arithmetic with WGSL's
// division rules, CORDIC, integer log2 and exp2, PCG hashes and value noise, and the one-time quantiser of float
// heights. Everything that decides a biome map's output is built from these, so the same inputs give the same bytes on
// every platform, in a worker, and in the GPU kernels that mirror them.
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
  qacos,
  qpow,
  qsqrt,
  sincos,
  udiv,
  umod,
  wendland,
} from './fixed.js';
export { fbm, hash2, hash3, hash4, hash5, pcg, ridged, valueNoise } from './hash.js';
export { quantizeHeights } from './height.js';
