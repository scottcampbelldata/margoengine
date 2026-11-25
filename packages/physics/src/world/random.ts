// The physics world's random numbers are the engine's one counter-based generator, `@margoengine/math/random` (the
// TypeScript twin of kernel-common's K02), re-exported here so the world's entry keeps its names.
export { RandomStream, philox, solverNumber } from '@margoengine/math/random';
