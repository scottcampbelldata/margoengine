// @margoengine/voxel-edit/gpu off the GPU: argument checks before any device work. The GPU runs are in
// gpu-browser-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuGrid } from '../dist/gpu.js';

test('the entry loads without WebGPU and refuses a missing device or a bad grid with a fix', async () => {
  const grid = { size: [2, 2, 2], voxels: new Uint8Array(8) };
  await assert.rejects(GpuGrid.create(null, grid), (e) => e instanceof TypeError && /; pass /.test(e.message));
  await assert.rejects(GpuGrid.create({}, grid), TypeError);
  assert.equal(typeof GpuGrid.prototype[Symbol.dispose], 'function');
});
