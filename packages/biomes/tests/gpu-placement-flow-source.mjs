// All test/runner imports are literal and reachable without evaluating a computed loader.
export { BiomeWorld } from '../src/world.ts';
export { defineBiome } from '../src/define.ts';
export { BiomePlacement } from '../src/placement.ts';
export { hydrology } from '../src/hydrology.ts';
export { placeTileGPU, PLACEMENT_WGSL, LUBY_WGSL } from '../src/gpu-placement.ts';
export { hydrologyGPU, FLOW_WGSL } from '../src/gpu-flow.ts';
export { presets } from '../src/presets.ts';
export {
  placementCases,
  flowCases,
  tileBytes,
  flowBytes,
  PLACEMENT_FLOW_CASE_COUNT,
} from './gpu-placement-flow-cases.mjs';
// Include the J5 field/classification half of the same pipeline proof.
export { rectFields } from '../src/fields.ts';
export { rectFieldsGPU } from '../src/gpu-fields.ts';
export { classifier, classify } from '../src/classify.ts';
export { classifyGPU } from '../src/gpu-classify-inputs.ts';
export { buildRegion } from '../src/region.ts';
export { heightsOf } from '../src/height.ts';
export { createRelief } from '../src/relief.ts';
export { quantizeClimate } from '../src/climate.ts';
export { divFloor } from '../src/fixed.ts';
export { frameFor, fieldNames, fieldIntegrationCases } from './gpu-field-integration-cases.mjs';
