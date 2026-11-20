// GpuVoxelMesher without a GPU: its argument checks, the jobs answered without one (all air, an unloaded chunk),
// cancel, supersede and dispose. The compute shaders are proved in gpu-mesher-browser-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuVoxelMesher } from '../dist/gpu-mesher.js';
import { BlockTypes, VoxelWorld, slabState } from '../dist/index.js';

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

test('a chunk whose meshing throws on this thread rejects its promise instead of leaving it pending', async () => {
  const blocks = new BlockTypes(),
    slab = blocks.define('slab', { shape: 'slab', textures: 1 }),
    world = new VoxelWorld({ blocks }),
    mesher = new GpuVoxelMesher(device());
  world.setBlock(1, 1, 1, slabState(slab));
  // A block type the mesher cannot read (its layer edited after define) makes the CPU path throw.
  blocks.table[slab].layer = 'unknown';
  const settled = await Promise.race([
    mesher.mesh(world, '0,0,0').then(
      () => 'resolved',
      (error) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 1000)),
  ]);
  assert.ok(settled instanceof TypeError, `settled: ${settled}`);
  // The mesher keeps working for the chunks after it.
  blocks.table[slab].layer = 'opaque';
  assert.equal((await mesher.mesh(world, '0,0,0')).opaque.length > 0, true);
  mesher.dispose();
});

test('a lost device: jobs wait until setDevice moves the mesher to the restored device (KB-RESTORE-VOXMESH1)', async () => {
  const blocks = new BlockTypes();
  blocks.define('stone');
  const world = new VoxelWorld({ blocks });
  world.addChunk(0, 0, 0);
  let lose;
  const first = Object.assign(device(), { lost: new Promise((resolve) => (lose = resolve)) }),
    mesher = new GpuVoxelMesher(first);
  assert.throws(() => mesher.setDevice(undefined), TypeError);
  assert.throws(() => mesher.setDevice(device(1 << 20)), /smaller batch/);
  mesher.setDevice(first); // the device in use: nothing changes
  lose({ reason: 'destroyed' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let settled = false;
  const waiting = mesher.mesh(world, '0,0,0').then((mesh) => ((settled = true), mesh));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, 'nothing runs on the lost device');
  mesher.setDevice(device());
  const mesh = await waiting;
  assert.equal(mesh.opaque.length, 0, 'the job ran once the mesher had a device again');
  assert.equal(mesher.stats.empty, 1);
  mesher.dispose();
  assert.throws(() => mesher.setDevice(device()), { code: 'disposed' });
});
