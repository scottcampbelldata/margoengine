import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockTypes, VoxelWorld, blockState } from '@margoengine/voxel';
import { Crowd } from '../dist/index.js';
import { TiledNavMesh } from '../dist/tiles.js';
import { VoxelNavMesh } from '../dist/voxel.js';

/** A generated stand-in world: a stone floor at y 0, `size` blocks a side. */
function world(size = 64) {
  const blocks = new BlockTypes(),
    stone = blocks.define('stone', {}),
    slab = blocks.define('slab', { shape: 'slab' }),
    water = blocks.define('water', { layer: 'translucent', solid: false, liquid: true }),
    voxels = new VoxelWorld({ blocks, minY: -32, maxY: 95 });
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) voxels.setBlock(x, 0, z, stone);
  return { voxels, stone, slab, water };
}
const options = { walkableRadius: 1, walkableHeight: 4, walkableClimb: 2, tileSize: 16 };
const wall = (voxels, state, x, z0, z1, height = 3) => {
  for (let z = z0; z < z1; z++) for (let y = 1; y <= height; y++) voxels.setBlock(x, y, z, state);
};

test('walks on blocks, on top of them, and round walls', () => {
  const { voxels, stone } = world(),
    mesh = new VoxelNavMesh(voxels, options);
  assert.ok(mesh.polygonCount > 0);
  const a = [5, 1, 30],
    b = [60, 1, 30];
  assert.equal(mesh.path(a, b).length, 2, 'open floor is straight');
  assert.ok(Math.abs(mesh.heightAt(mesh.locate(a), 5, 30) - 1) < 1e-6, 'the top of the block');
  wall(voxels, stone, 32, 0, 60);
  assert.ok(mesh.pendingTiles > 0);
  mesh.update();
  const route = mesh.path(a, b);
  assert.ok(route.length > 2);
  assert.ok(
    route.some((p) => p[2] >= 60),
    'round the end',
  );
  mesh.dispose();
});

test('a change rebuilds only the tiles that see it', () => {
  const { voxels, stone } = world(128),
    mesh = new VoxelNavMesh(voxels, options),
    tiles = [...mesh.tileList()].length;
  assert.equal(mesh.pendingTiles, 0);
  voxels.setBlock(40, 1, 40, stone);
  assert.ok(mesh.pendingTiles >= 1 && mesh.pendingTiles <= 4, `${mesh.pendingTiles} of ${tiles}`);
  assert.equal(mesh.update(1), 1);
  mesh.update();
  assert.equal(mesh.locate([40.5, 1, 40.5]) >= 0, false, 'covered by the block');
  voxels.setBlock(40, 1, 40, 0);
  mesh.update();
  assert.ok(mesh.path([35, 1, 40], [45, 1, 40]));
  mesh.dispose();
});

test('a slab is half a block: a step a walker takes, where a whole block is a wall', () => {
  const { voxels, stone, slab } = world(),
    mesh = new VoxelNavMesh(voxels, options);
  wall(voxels, stone, 32, 0, 64, 1);
  mesh.update();
  assert.equal(mesh.path([20, 1, 30], [50, 1, 30]), null, 'a whole block is over the 0.5 climb');
  for (let z = 0; z < 64; z++) voxels.setBlock(32, 1, z, slab);
  mesh.update();
  assert.ok(mesh.path([20, 1, 30], [50, 1, 30]));
  assert.ok(Math.abs(mesh.heightAt(mesh.locate([32.5, 1.5, 30]), 32.5, 30) - 1.5) < 0.3);
  // An upper slab: its top is the whole block's, over a half block gap too low to walk under.
  const upper = blockState(slab, 4);
  for (let x = 30; x < 36; x++) for (let z = 0; z < 64; z++) voxels.setBlock(x, 1, z, upper);
  mesh.update();
  assert.ok(Math.abs(mesh.heightAt(mesh.locate([33, 2, 30]), 33, 30) - 2) < 1e-6);
  assert.equal(mesh.path([20, 1, 30], [50, 1, 30]), null);
  mesh.dispose();
});

test('liquids are not ground, unless told so; chunks come and go', () => {
  const { voxels, water } = world(),
    mesh = new VoxelNavMesh(voxels, options);
  for (let x = 0; x < 64; x++) for (let z = 28; z < 36; z++) voxels.setBlock(x, 0, z, water);
  mesh.update();
  assert.equal(mesh.path([5, 1, 5], [5, 1, 60]), null, 'water cuts the world in two');
  mesh.dispose();
  const swimming = new VoxelNavMesh(voxels, { ...options, solid: (type) => type.solid || type.liquid });
  assert.ok(swimming.path([5, 1, 5], [5, 1, 60]));
  const near = swimming.locate([40, 1, 40]);
  assert.ok(near >= 0);
  voxels.removeChunk(1, 0, 1);
  swimming.update();
  assert.equal(swimming.locate([40, 1, 40]), -1, 'an unloaded chunk is air');
  voxels.addChunk(1, 0, 1).set(8, 0, 8, 1);
  swimming.update();
  swimming.dispose();
  voxels.setBlock(5, 1, 5, 1);
  assert.equal(swimming.pendingTiles, 0, 'dispose stops listening');
});

test('the mesh matches one built from the same blocks as triangles', () => {
  const { voxels, stone } = world(64),
    boxes = [
      [10, 14, 10, 14],
      [30, 34, 20, 50],
      [44, 46, 8, 30],
    ],
    positions = [0, 1, 0, 64, 1, 0, 64, 1, 64, 0, 1, 64],
    indices = [0, 2, 1, 0, 3, 2];
  for (const [x0, x1, z0, z1] of boxes) {
    for (let x = x0; x < x1; x++)
      for (let z = z0; z < z1; z++) for (let y = 1; y <= 3; y++) voxels.setBlock(x, y, z, stone);
    const base = positions.length / 3;
    for (const y of [1, 4]) positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
    for (const [a, b, c, d] of [
      [7, 6, 5, 4],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ])
      indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
  const shared = { cs: 0.5, ch: 0.25, ...options },
    blocks = new VoxelNavMesh(voxels, shared),
    triangles = new TiledNavMesh(positions, indices, { ...shared, detailSampleDist: 0 });
  const toBox = (x, z) =>
    Math.min(...boxes.map(([x0, x1, z0, z1]) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1))));
  let compared = 0;
  for (let x = 0.75; x < 64; x += 0.5)
    for (let z = 0.75; z < 64; z += 0.5) {
      const one = blocks.locate([x, 1, z]) >= 0,
        two = triangles.locate([x, 1, z]) >= 0;
      compared++;
      // Triangles voxelise to every cell they touch, so a wall can stand a cell wider than its blocks; nowhere else.
      if (one !== two) assert.ok(toBox(x, z) < 1.25, `${x}, ${z}`);
    }
  assert.ok(compared > 16000);
});

test('a crowd walks on it and replans when a wall goes up', () => {
  const { voxels, stone } = world(),
    mesh = new VoxelNavMesh(voxels, options),
    crowd = new Crowd(mesh),
    agent = crowd.addAgent({ position: [10, 1, 30], radius: 0.4 });
  agent.setTarget([50, 1, 30]);
  crowd.update(1 / 30);
  wall(voxels, stone, 30, 0, 50);
  mesh.update();
  for (let i = 0; i < 1800 && agent.state === 'moving'; i++) crowd.update(1 / 30);
  assert.equal(agent.state, 'arrived');
  mesh.dispose();
});

test('options are checked', () => {
  const { voxels } = world(16);
  assert.throws(() => new VoxelNavMesh(voxels, { cs: 0.3 }), RangeError);
  assert.throws(() => new VoxelNavMesh(voxels, { ch: 0 }), RangeError);
  const empty = new VoxelWorld({ blocks: new BlockTypes() });
  assert.throws(
    () => new VoxelNavMesh(empty),
    (error) => error.code === 'failed',
  );
  assert.equal(new VoxelNavMesh(empty, { deferred: true }).polygonCount, 0);
});
