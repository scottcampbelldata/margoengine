import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { keptOffLayer } from '../scripts/support/kept-off-layer.js';

test('keptOffLayer reads the opt-out as written and as minified', () => {
  assert.equal(keptOffLayer("needsWebGPU('#viewport', { layer: false })"), true);
  assert.equal(keptOffLayer('e("#viewport",{layer:!1})'), true);
  assert.equal(keptOffLayer("needsWebGPU('#viewport')"), false);
  assert.equal(keptOffLayer('e("#viewport",{layer:!0})'), false);
});

// compute-lab and sciviz-surface moved onto the layer while this list still named them, so the check demanded the
// needs-WebGPU message from pages that rightly ran on the layer.
test('the no-WebGPU check names no page by hand as kept off the layer', async () => {
  const source = await readFile(new URL('../scripts/test-no-webgpu-browser.mjs', import.meta.url), 'utf8');
  assert.match(source, /const NOT_ON_LAYER = new Set\(\);/);
  assert.match(source, /keptOffLayer\(code\)/);
});
