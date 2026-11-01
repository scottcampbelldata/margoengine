// Literal source graph for Factory auditing and the single browser IIFE.
export { classify, classifier, classifyInputs, classifyPlanes } from '../src/classify.ts';
export { classifyInputsGPU, classifyGPU } from '../src/gpu-classify-inputs.ts';
export { warpLattice } from '../src/classify-warp.ts';
export { presets } from '../src/presets.ts';
export { whittaker, holdridge } from '../src/zones.ts';
export { inputsCases, inputsOracle, INPUTS_CASE_COUNT } from './gpu-classify-inputs-cases.mjs';
export { rectFields } from '../src/fields.ts';
export { rectFieldsGPU } from '../src/gpu-fields.ts';
export { buildRegion } from '../src/region.ts';
export { heightsOf } from '../src/height.ts';
export { createRelief } from '../src/relief.ts';
export { quantizeClimate } from '../src/climate.ts';
export { divFloor } from '../src/fixed.ts';
export { fieldIntegrationCases, fieldNames, frameFor } from './gpu-field-integration-cases.mjs';
