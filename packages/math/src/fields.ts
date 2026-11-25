// `@margoengine/math/fields`: the contracts of the physics framework's shared fields (docs/physics-framework.md, section 4),
// as types only: the wind and any flow (fields/wind.ts) and follow targets (fields/follow.ts). Importing it adds no code.
export type { FlowCell, FlowField, FlowSample, Wind } from './fields/wind.js';
export type { FollowSource, FollowTarget } from './fields/follow.js';
