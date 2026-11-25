// `@margoengine/math/fields`: the contracts of the physics framework's shared fields (docs/physics-framework.md, section 4),
// as types only: the wind and any flow (fields/wind.ts), the terrain bed (fields/bed.ts), follow targets (fields/follow.ts)
// precipitation (fields/precipitation.ts) and the waves' spectrum (fields/waves.ts).
// Importing it adds no code.
export type { Bed, BedGrid, BedSample } from './fields/bed.js';
export type { FlowCell, FlowField, FlowSample, Wind } from './fields/wind.js';
export type { FollowSource, FollowTarget } from './fields/follow.js';
export type { HydrometeorSample, Precipitation, PrecipitationSample } from './fields/precipitation.js';
export type { WaveSpectrumField, WaveSpectrumSample } from './fields/waves.js';
