import assert from 'node:assert/strict';
import test from 'node:test';
import { GranularMpmSolver } from '@margoengine/physics/granular-mpm';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';
import { transferVoxelGranular } from '../dist/granular-mpm.js';
import { BlockTypes, VoxelWorld, blockState } from '../dist/index.js';

const source = [-32, 2, 0];
const adjacent = [-33, 2, 0];

function setup(shared = false) {
  const blocks = new BlockTypes();
  const sand = blocks.define('sand');
  const snow = blocks.define('snow');
  const stone = blocks.define('stone');
  const water = blockState(blocks.define('water', { layer: 'translucent', shape: 'liquid', solid: false }), 0xf043);
  const voxels = new VoxelWorld({ blocks });
  voxels.setBlock(...source, sand);
  voxels.setBlock(...adjacent, snow);
  voxels.setBlock(-32, 1, 0, water);
  voxels.setBlock(-31, 2, 0, stone);
  const physics = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) });
  const cells = [
    { position: source, block: sand },
    { position: adjacent, block: snow, material: 1 },
  ];
  // The snow impact adds affine motion and raises the wave speed through compressive hardening.
  // At h = 0.25 m, a 1920 Hz clock allows a combined speed of 192 m/s under the 0.4 CFL bound.
  const params = { floor: 0, rate: 5, materials: [{ density: 1600 }, { kind: 'snow', density: 400 }] };
  return { voxels, physics, water, stone, cells, params };
}

test('the voxel bridge transfers the original volume and material mass across chunk edges, with exact replay', async () => {
  async function run(shared) {
    const { voxels, physics, water, stone, cells, params } = setup(shared);
    const solver = await GranularMpmSolver.load();
    const changes = [];
    voxels.dirty.clear();
    voxels.onChange((x, y, z, next, previous) => {
      assert.equal(voxels.getBlock(...source), 0);
      assert.equal(voxels.getBlock(...adjacent), 0);
      assert.equal(solver.sample(0).mass, 25);
      changes.push([x, y, z, next, previous]);
    });
    transferVoxelGranular(voxels, physics, solver, { cells, params, metresPerVoxel: 0.5, voxelOrigin: [-32, 0, 0] });
    assert.deepEqual(
      changes,
      cells.map(({ position, block }) => [...position, 0, block]),
    );
    assert.deepEqual([...voxels.dirty].sort(), ['-1,0,0', '-2,0,0']);
    assert.equal(voxels.getBlock(-32, 1, 0), water);
    assert.equal(voxels.getBlock(-31, 2, 0), stone);
    assert.deepEqual(solver.sample(0).position, [0.125, 1.125, 0.125]);
    assert.deepEqual(solver.sample(8).position, [-0.375, 1.125, 0.125]);
    const sums = Array.from({ length: 16 }, (_, i) => solver.sample(i)).reduce(
      ([volume, mass], sample) => [volume + sample.referenceVolume, mass + sample.mass],
      [0, 0],
    );
    assert.deepEqual(sums, [0.25, 250]);
    const snapshot = physics.takeSnapshot();
    physics.advance(30);
    assert.ok(solver.sample(0).position[1] < 0.8);
    const hash = physics.hash();
    physics.restoreSnapshot(snapshot.bytes);
    physics.advance(30);
    assert.equal(physics.hash(), hash);
    return hash;
  }
  assert.equal(await run(true), await run(false));
});

test('invalid selection and failed MPM setup leave all original voxels intact', async () => {
  const { voxels, physics, cells, params, water } = setup();
  const solver = await GranularMpmSolver.load();
  assert.throws(() => transferVoxelGranular(voxels, physics, solver, { cells: [...cells, cells[0]], params }), /once/);
  assert.throws(
    () =>
      transferVoxelGranular(voxels, physics, solver, {
        cells: [cells[0], { position: [-32, 1, 0], block: water & 65535 }],
      }),
    /solid cube/,
  );
  assert.throws(() => transferVoxelGranular(voxels, physics, solver, { cells, params, samplesPerAxis: 1000 }), /arena/);
  const before = physics.hash();
  assert.throws(
    () => transferVoxelGranular(voxels, physics, solver, { cells, params: { ...params, spacing: 0.02, rate: 0 } }),
    /CFL bound/,
  );
  assert.equal(physics.hash(), before);
  for (const { position, block } of cells) assert.equal(voxels.getBlock(...position), block);
  assert.equal(voxels.getBlock(-32, 1, 0), water);
});

test('an observer failure leaves the transfer complete and surfaces the original error', async () => {
  const { voxels, physics, cells, params } = setup();
  const solver = await GranularMpmSolver.load();
  const fault = new Error('observer stopped');
  voxels.onChange(() => {
    throw fault;
  });
  assert.throws(
    () => transferVoxelGranular(voxels, physics, solver, { cells, params }),
    (error) => error === fault,
  );
  for (const { position } of cells) assert.equal(voxels.getBlock(...position), 0);
  assert.equal(solver.sample(15).mass, 50);
  physics.advance(1);
  assert.equal(solver.sample(15).mass, 50);
});

test('an edit during registration cancels the transfer and keeps the current source states', async () => {
  const { voxels, physics, cells, params, stone } = setup();
  const solver = await GranularMpmSolver.load();
  const editing = {
    ...params,
    get groundFriction() {
      voxels.setBlock(...source, stone);
      return 0.55;
    },
  };
  assert.throws(() => transferVoxelGranular(voxels, physics, solver, { cells, params: editing }), /sources changed/);
  assert.equal(voxels.getBlock(...source), stone);
  assert.equal(voxels.getBlock(...adjacent), cells[1].block);
  assert.equal(physics.remove(solver.id), false);
});
