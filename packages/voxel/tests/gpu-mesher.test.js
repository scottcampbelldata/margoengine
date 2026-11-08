// GpuVoxelMesher without a GPU: its argument checks, the jobs answered without one (all air, an unloaded chunk),
// cancel, supersede and dispose. The compute shaders are proved in gpu-mesher-browser-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuVoxelMesher } from '../dist/gpu-mesher.js';
import { BlockTypes, VoxelWorld } from '../dist/index.js';

// Enough of a GPUDevice to construct the mesher; any GPU work would throw.
const device = (limit = 1 << 30) => ({
  createComputePipeline() {
    throw new Error('no GPU work expected');
  },
  limits: { maxStorageBufferBindingSize: limit },
});

test('options and arguments are checked', () => {
  assert.throws(() => new GpuVoxelMesher(undefined), TypeError);
  assert.throws(() => new GpuVoxelMesher({}), TypeError);
  for (const batch of [0, 33, 1.5, Number.NaN])
    assert.throws(() => new GpuVoxelMesher(device(), { batch }), RangeError);
  assert.throws(() => new GpuVoxelMesher(device(1 << 20)), /smaller batch/);
  assert.equal(new GpuVoxelMesher(device()).batch, 8);
  const mesher = new GpuVoxelMesher(device(), { batch: 2 }),
    world = new VoxelWorld({ blocks: new BlockTypes() });
  assert.throws(() => mesher.mesh({}, '0,0,0'), TypeError);
  assert.throws(() => mesher.mesh(world, 5), TypeError);
  assert.throws(() => mesher.mesh(world, '0,0'), RangeError);
  assert.throws(() => mesher.mesh(world, '0,0,99999999999'), RangeError);
  assert.throws(() => mesher.mesh(world, '0,0,0', Number.NaN), RangeError);
  assert.throws(() => mesher.mesh(world, '0,0,0', 0, 'eye'), TypeError);
  assert.throws(() => mesher.mesh(world, '0,0,0', 0, [0, 1]), RangeError);
});

test('all-air and unloaded chunks are answered without the GPU; cancel, supersede and dispose resolve null', async () => {
  const blocks = new BlockTypes();
  blocks.define('stone');
  const world = new VoxelWorld({ blocks });
  world.addChunk(0, 0, 0);
  const mesher = new GpuVoxelMesher(device());
  const air = await mesher.mesh(world, '0,0,0');
  assert.deepEqual([air.opaque.length, air.cutout.length, air.translucent.length], [0, 0, 0]);
  let all = 0; // every pair of chunk faces joined: bit a * 6 + b for a < b
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) all |= 1 << (a * 6 + b);
  assert.equal(air.visibility, all);
  assert.equal(await mesher.mesh(world, '4,0,0'), null);
  const older = mesher.mesh(world, '0,0,0'),
    newer = mesher.mesh(world, '0,0,0');
  assert.equal(await older, null);
  assert.notEqual(await newer, null);
  const cancelled = mesher.mesh(world, '0,0,0');
  mesher.cancel('0,0,0');
  assert.equal(await cancelled, null);
  const pending = mesher.mesh(world, '0,0,0');
  mesher.dispose();
  assert.equal(await pending, null);
  assert.throws(() => mesher.mesh(world, '0,0,0'), { code: 'disposed' });
  assert.throws(() => mesher.warm(), { code: 'disposed' });
  assert.deepEqual(mesher.stats, { gpu: 0, cpu: 0, empty: 2, batches: 0 });
  mesher[Symbol.dispose]();
});
