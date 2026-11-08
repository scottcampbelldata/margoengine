// VoxelGI without a GPU: its option checks and the unsupported backend. The ray tracing and the shading are proved in
// gi-browser-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelGI } from '../dist/gi.js';
import { BlockTypes, VoxelWorld } from '../dist/index.js';

test('options are checked; WebGPU is required', () => {
  const world = new VoxelWorld({ blocks: new BlockTypes() }),
    engine = { createMesh() {}, gpu: null, camera: { position: [0, 0, 0] } };
  assert.throws(() => VoxelGI.attach({}, { world }), TypeError);
  assert.throws(() => VoxelGI.attach(engine, { world: {} }), TypeError);
  for (const bad of [
    { strength: -1 },
    { strength: 9 },
    { softness: 0.6 },
    { cells: 100 },
    { cells: 5000.5 },
    { rays: 0 },
    { rays: 17 },
    { range: 65 },
    { albedo: { stone: [1, 2, 0] } },
    { albedo: { stone: 'grey' } },
  ])
    assert.throws(() => VoxelGI.attach(engine, { world, ...bad }), RangeError, JSON.stringify(bad));
  assert.throws(() => VoxelGI.attach(engine, { world }), { code: 'unsupported' });
});
