// @margoengine/voxel/debris: groups of blocks cut loose by an edit break off as dynamic bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '@margoengine/physics';
import { BlockTypes, VoxelWorld } from '../dist/index.js';
import { VoxelPhysics } from '../dist/physics.js';
import { mergeBoxes, VoxelDebris } from '../dist/debris.js';

await Physics.load();

const blocks = new BlockTypes(),
  stone = blocks.define('stone'),
  wood = blocks.define('wood'),
  bedrock = blocks.define('bedrock'),
  flower = blocks.define('flower', { shape: 'cross', layer: 'cutout', solid: false }),
  water = blocks.define('water', { shape: 'liquid', liquid: true, solid: false, layer: 'translucent' });
const fill = (world, x0, x1, y0, y1, z0, z1, state) => {
  const edits = [];
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) edits.push(x, y, z, state);
  world.setBlocks(edits);
};
// One loaded chunk with a stone floor y 0 (held by the unloaded chunk below), a wooden pillar x 10, z 10, y 1 to 4
// and a beam y 5, x 10 to 15.
const scene = () => {
  const world = new VoxelWorld({ blocks });
  world.addChunk(0, 0, 0);
  fill(world, 0, 32, 0, 1, 0, 32, stone);
  fill(world, 10, 11, 1, 5, 10, 11, wood);
  fill(world, 10, 16, 5, 6, 10, 11, wood);
  return world;
};
const count = (world, state) => {
  let n = 0;
  for (let x = 0; x < 32; x++)
    for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) n += world.getBlock(x, y, z) === state;
  return n;
};

test('cutting a pillar breaks off everything above the cut as one piece and clears it from the world', () => {
  const world = scene(),
    debris = new VoxelDebris(world),
    seen = [];
  debris.onBreak((p) => seen.push(p.id));
  world.setBlock(10, 2, 10, 0);
  assert.equal(debris.pending, 6);
  const [piece, ...rest] = debris.update();
  assert.equal(rest.length, 0);
  // Pillar y 3 and 4 and the beam's 6 cells.
  assert.equal(piece.states.length, 8);
  assert.ok(piece.states.every((s) => s === wood));
  const cells = [];
  for (let i = 0; i < piece.cells.length; i += 3) cells.push(piece.cells.slice(i, i + 3).join(','));
  assert.deepEqual(cells.sort(), [
    '10,3,10',
    '10,4,10',
    '10,5,10',
    '11,5,10',
    '12,5,10',
    '13,5,10',
    '14,5,10',
    '15,5,10',
  ]);
  assert.equal(world.getBlock(10, 4, 10), 0);
  assert.equal(world.getBlock(15, 5, 10), 0);
  assert.equal(world.getBlock(10, 1, 10), wood, 'the stump below the cut stays');
  assert.equal(count(world, stone), 1024, 'the floor stays');
  // Mean of the cell centres.
  assert.deepEqual(piece.center, [(10 * 3 + 11 + 12 + 13 + 14 + 15 + 4) / 8, (3 + 4 + 6 * 5 + 4) / 8, 10.5]);
  assert.equal(piece.body, null);
  assert.deepEqual(piece.meshes, []);
  assert.deepEqual(seen, [piece.id]);
  assert.deepEqual(debris.pieces, [piece]);
  assert.equal(debris.pending, 0);
  assert.deepEqual(debris.update(), [], 'nothing more is loose');
});

test('a group still joined to something that holds it stays: a second pillar, an anchor, the floor, an unloaded chunk', () => {
  // Second pillar under the far end of the beam.
  let world = scene();
  fill(world, 15, 16, 1, 5, 10, 11, wood);
  let debris = new VoxelDebris(world);
  world.setBlock(10, 2, 10, 0);
  assert.deepEqual(debris.update(), []);
  assert.equal(world.getBlock(10, 5, 10), wood);
  // A bedrock block in the beam.
  world = scene();
  world.setBlock(15, 5, 10, bedrock);
  debris = new VoxelDebris(world, { anchors: ['bedrock'] });
  world.setBlock(10, 2, 10, 0);
  assert.deepEqual(debris.update(), []);
  // An island floating in the air falls whole when touched; with `floor` at its bottom it is held.
  for (const floor of [-Infinity, 20]) {
    world = scene();
    fill(world, 4, 7, 20, 22, 4, 7, stone);
    debris = new VoxelDebris(world, { floor });
    world.setBlock(5, 21, 5, 0);
    const pieces = debris.update();
    assert.equal(pieces.length, floor === 20 ? 0 : 1);
    if (pieces.length) assert.equal(pieces[0].cells.length / 3, 17);
  }
  // A beam running into the unloaded chunk x 1 may be held there.
  world = scene();
  fill(world, 15, 32, 5, 6, 10, 11, wood);
  debris = new VoxelDebris(world);
  world.setBlock(10, 2, 10, 0);
  assert.deepEqual(debris.update(), []);
  // Load chunk x 1 and the same cut breaks the beam off.
  world = scene();
  world.addChunk(1, 0, 0);
  fill(world, 15, 40, 5, 6, 10, 11, wood);
  debris = new VoxelDebris(world);
  world.setBlock(10, 2, 10, 0);
  const [piece] = debris.update();
  assert.equal(piece.cells.length / 3, 2 + 30);
});

test('one cut can free several pieces; non-solid blocks neither join nor hold groups', () => {
  const world = scene();
  // A cross of arms on the pillar top (y 4): arms x 8-9, x 11-12, z 8-9, z 11-12; the beam is removed.
  fill(world, 10, 16, 5, 6, 10, 11, 0);
  fill(world, 8, 13, 4, 5, 10, 11, wood);
  fill(world, 10, 11, 4, 5, 8, 13, wood);
  // A flower and water touching the x 11-12 arm and the floor do not hold it.
  world.setBlock(12, 3, 10, water);
  fill(world, 12, 13, 1, 3, 10, 11, water);
  world.setBlock(9, 3, 10, flower);
  const debris = new VoxelDebris(world, { maxCells: 64 });
  world.setBlock(10, 4, 10, 0);
  const pieces = debris.update();
  assert.equal(pieces.length, 4);
  assert.deepEqual(
    pieces.map((p) => p.cells.length / 3),
    [2, 2, 2, 2],
  );
  assert.equal(world.getBlock(10, 3, 10), wood, 'the pillar stays');
  assert.equal(world.getBlock(12, 3, 10), water);
  assert.equal(world.getBlock(9, 3, 10), flower);
});

test('a group of maxCells cells or more stays, which bounds the search', () => {
  const world = scene();
  fill(world, 4, 8, 20, 24, 4, 8, stone); // 64 cells floating
  const small = new VoxelDebris(world, { maxCells: 63 });
  world.setBlock(4, 20, 4, 0); // 63 left
  assert.deepEqual(small.update(), []);
  world.setBlock(5, 20, 4, 0); // 62 left
  assert.equal(small.update()[0].cells.length / 3, 62);
});

test('mergeBoxes covers exactly the cells with disjoint boxes and merges a solid block into one box', () => {
  assert.deepEqual(
    [...mergeBoxes([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1])],
    [0, 0, 0, 2, 2, 2],
  );
  let seed = 7;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  for (let round = 0; round < 20; round++) {
    const set = new Set(),
      cells = [];
    for (let i = 0; i < 300; i++) {
      const c = [Math.floor(next() * 8) - 3, Math.floor(next() * 6), Math.floor(next() * 7)],
        k = c.join(',');
      if (!set.has(k)) set.add(k), cells.push(...c);
    }
    const boxes = mergeBoxes(cells),
      covered = new Map();
    for (let b = 0; b < boxes.length; b += 6)
      for (let x = boxes[b]; x < boxes[b + 3]; x++)
        for (let y = boxes[b + 1]; y < boxes[b + 4]; y++)
          for (let z = boxes[b + 2]; z < boxes[b + 5]; z++) {
            const k = `${x},${y},${z}`;
            assert.ok(set.has(k), `box covers ${k}, which is not a cell`);
            assert.ok(!covered.has(k), `${k} in two boxes`);
            covered.set(k, b);
          }
    assert.equal(covered.size, set.size);
    assert.ok(boxes.length / 6 < set.size, 'neighbouring cells merge');
  }
});

test('with physics a piece is a dynamic body of its cells mass that falls onto the voxel floor and comes to rest', () => {
  const physics = new Physics(null, { gravity: [0, -9.81, 0] }),
    world = scene(),
    voxels = new VoxelPhysics(physics, world, { budget: Infinity }),
    debris = new VoxelDebris(world, { physics, density: 2 });
  // A body near the pillar so VoxelPhysics builds the chunk's colliders first.
  physics.addBody(null, { type: 'kinematicPosition', position: [16, 10, 16], colliders: [] });
  for (let i = 0; i < 3; i++) physics.step();
  world.setBlock(10, 2, 10, 0);
  const [piece] = debris.update(1 / 60);
  assert.ok(piece.body);
  assert.equal(piece.body.userData, piece);
  assert.equal(piece.body.type, 'dynamic');
  assert.ok(Math.abs(piece.body.mass - 16) < 1e-3, `mass ${piece.body.mass}: 8 cells of 2 kg`);
  assert.deepEqual(
    piece.body.position.map((v) => Math.round(v * 1e4) / 1e4),
    piece.center.map((v) => Math.round(v * 1e4) / 1e4),
  );
  // Boxes: pillar cells (one box) and the beam (one box).
  assert.equal(piece.boxes.length / 6, 2);
  const startY = piece.body.position[1];
  for (let i = 0; i < 360; i++) {
    debris.update(1 / 60);
    physics.step();
  }
  const [x, y, z] = piece.body.position,
    speed = Math.hypot(...piece.body.linearVelocity);
  assert.ok([x, y, z].every(Number.isFinite));
  assert.ok(startY - y > 1.5, `fell from ${startY} to ${y}`);
  // The piece lies on the floor (top y 1): its centre is above it, and it is still.
  assert.ok(y > 1.2 && y < 4, `rests at ${y}`);
  assert.ok(speed < 0.05, `speed ${speed}`);
  assert.equal(voxels.pending, 0);
  debris.dispose();
  assert.equal(piece.body.valid, false, 'dispose removes the bodies');
  physics.dispose();
});

test('lifetime and maxPieces remove old pieces; remove and dispose clean up and dispose stops watching', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    world = scene(),
    debris = new VoxelDebris(world, { physics, lifetime: 1, maxPieces: 2 });
  // Three floating two-cell towers; taking each one's top off leaves a loose cell.
  for (const x of [2, 6, 20]) fill(world, x, x + 1, 10, 12, 3, 4, stone);
  for (const x of [2, 6, 20]) world.setBlock(x, 11, 3, 0);
  const pieces = debris.update(0);
  assert.equal(pieces.length, 3);
  assert.deepEqual(debris.pieces, pieces.slice(1), 'the oldest went past maxPieces');
  assert.equal(pieces[0].body.valid, false);
  debris.update(0.6);
  debris.remove(pieces[1]);
  assert.equal(pieces[1].body.valid, false);
  assert.deepEqual(debris.pieces, [pieces[2]]);
  debris.update(0.5);
  assert.deepEqual(debris.pieces, [], 'past its lifetime');
  debris.dispose();
  debris.dispose();
  world.setBlock(10, 2, 10, 0);
  assert.equal(debris.pending, 0, 'disposed: edits are no longer watched');
  assert.throws(() => debris.update(), { code: 'disposed' });
  physics.dispose();
});

test('options are checked and every message says how to fix it', () => {
  const world = scene();
  const cases = [
    () => new VoxelDebris({}),
    () => new VoxelDebris(world, { physics: {} }),
    () => new VoxelDebris(world, { engine: {} }),
    () => new VoxelDebris(world, { floor: 'low' }),
    () => new VoxelDebris(world, { anchors: 'bedrock' }),
    () => new VoxelDebris(world, { maxCells: 0 }),
    () => new VoxelDebris(world, { maxCells: 70000 }),
    () => new VoxelDebris(world, { maxPieces: 1.5 }),
    () => new VoxelDebris(world, { lifetime: 0 }),
    () => new VoxelDebris(world, { density: -1 }),
    () => new VoxelDebris(world, { friction: Number.NaN }),
    () => new VoxelDebris(world, { material: 'red' }),
    () => new VoxelDebris(world).update(-1),
    () => new VoxelDebris(world).onBreak(null),
  ];
  for (const make of cases)
    assert.throws(make, (e) => (e instanceof TypeError || e instanceof RangeError) && /; \S/.test(e.message));
  assert.throws(() => new VoxelDebris(world, { anchors: ['nothing'] }));
  using debris = new VoxelDebris(world);
  assert.equal(debris.maxCells, 4096);
  assert.equal(debris.maxPieces, 64);
});
