// Voxel regions on the GPU (tracer.ts #syncScene): models that share one packed copy (the same contentKey) take one
// region. Repacking into a new buffer placed such a copy once per model, so the copies used up the room the snapshot was
// checked to fit, and a later model got no region at all: its record pointed at word 0 and it drew another model's
// bricks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, materials, model, settle, translate } from './support.js';

const MODEL_WORDS = 12;
// Every 8^3 brick mixed (checkerboard), cell (0, 0, 0) holding `palette`.
const checker = (id, palette, key) => ({
  ...model(id, [16, 96, 16], (x, y, z) => ((x + y + z) % 2 === 0 ? palette : 0)),
  ...(key ? { contentKey: key } : {}),
});

test('models sharing a packed copy take one voxel region, so every model still fits after a repack', async () => {
  // 16384 words per binding. Each model packs to 48 mixed bricks (48 + 48 x 128 = 6192 words): the scene needs
  // 4 + 2 x 6192 words, which fits; a second copy of the shared one would leave too little for the last model.
  const device = fakeDevice({ maxStorageBufferBindingSize: 65536 }),
    harness = fakeEngine(device),
    scene = {
      revision: 1,
      models: [checker('a', 1, 'k'), checker('b', 1, 'k'), checker('d', 2)],
      instances: [
        { id: 'a', modelId: 'a', matrix: translate(0, 0, 0) },
        { id: 'b', modelId: 'b', matrix: translate(20, 0, 0) },
        { id: 'd', modelId: 'd', matrix: translate(40, 0, 0) },
      ],
      materials: materials([1, 2]),
    },
    tracer = VoxelPathTracer.attach(harness.engine, { scene, denoise: false });
  await tracer.ready;
  harness.frame();
  await settle();
  harness.frame();
  const sizes = (words, i) => [...words.subarray(4 + i * MODEL_WORDS, 4 + i * MODEL_WORDS + 3)];
  const sceneBuffer = device.buffers.findLast((b) => {
      if (b.destroyed || b.size < 64) return false;
      const w = new Uint32Array(b.data);
      return [0, 1, 2].every((i) => sizes(w, i).join() === '16,96,16');
    }),
    voxelBuffer = device.buffers.findLast((b) => !b.destroyed && b.size >= 4 * 2 * 6192 && b.size <= 65536),
    words = new Uint32Array(sceneBuffer.data),
    voxels = new Uint32Array(voxelBuffer.data),
    grid = [0, 1, 2].map((i) => words[4 + i * MODEL_WORDS + 3]);
  // The shared copy has one region; the other model has its own, holding its own bricks.
  assert.equal(grid[0], grid[1]);
  assert.ok(grid[2] >= 4 && grid[2] !== grid[0], `model d's region ${grid[2]}`);
  assert.equal(voxels[voxels[grid[0]]] & 255, 1);
  assert.equal(voxels[voxels[grid[2]]] & 255, 2);
  tracer.dispose();
});
