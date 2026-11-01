// Shared, browser-free bundle builder reached by the focused test and hardware runner.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export async function inputsModuleCode() {
  const entry = fileURLToPath(new URL('./gpu-classify-inputs-browser.mjs', import.meta.url)).replaceAll('\\', '/');
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'internal-classify-inputs-fixture',
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) =>
          id === entry
            ? `
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
`
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: 'strict',
        output: { format: 'iife', name: '__margoInputsProof' },
      },
    },
  });
  assert.ok(
    !Array.isArray(result) && result.output.length === 1 && result.output[0].type === 'chunk',
    'Internal inputs fixture must bundle to one self-contained module',
  );
  return result.output[0].code;
}
