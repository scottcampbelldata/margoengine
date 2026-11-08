// @margoengine/voxel/fluids: a source spreads to a diamond of falling levels and dries up when taken away, falls off an
// edge as a column, heads for the nearest drop, two sources make a third (infinite), lava reaches less and slower, lava
// and water make obsidian and cobblestone, and unloaded chunks stop it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockTypes, VoxelWorld, blockData, blockId, blockState } from '../dist/index.js';
import { FLUID_FALLING, VoxelFluids } from '../dist/fluids.js';

const setup = (size = 2) => {
  const blocks = new BlockTypes(),
    stone = blocks.define('stone'),
    water = blocks.define('water', { shape: 'liquid', liquid: true, solid: false, layer: 'translucent' }),
    lava = blocks.define('lava', { shape: 'liquid', liquid: true, solid: false, light: 15 }),
    obsidian = blocks.define('obsidian'),
    cobble = blocks.define('cobblestone'),
    flower = blocks.define('flower', { shape: 'cross', solid: false, layer: 'cutout' }),
    world = new VoxelWorld({ blocks });
  for (let cz = 0; cz < size; cz++) for (let cx = 0; cx < size; cx++) world.addChunk(cx, 0, cz);
  const floor = [];
  for (let z = 0; z < 32 * size; z++) for (let x = 0; x < 32 * size; x++) floor.push(x, 10, z, stone);
  world.setBlocks(floor);
  const fluids = VoxelFluids.attach(world, {
    fluids: [
      { block: 'water', infinite: true },
      { block: lava, reach: 3, delay: 30 },
    ],
    mixes: [{ fluid: 'lava', touches: 'water', source: 'obsidian', flowing: 'cobblestone' }],
  });
  return { world, fluids, stone, water, lava, obsidian, cobble, flower };
};

test('a source spreads to a diamond of levels 1 to 7 and dries up when removed', () => {
  const { world, fluids, water } = setup();
  world.setBlock(30, 11, 30, water);
  assert.equal(fluids.pending, 1);
  fluids.settle();
  for (let dz = -9; dz <= 9; dz++)
    for (let dx = -9; dx <= 9; dx++) {
      const d = Math.abs(dx) + Math.abs(dz),
        s = world.getBlock(30 + dx, 11, 30 + dz);
      if (d > 7) assert.equal(s, 0, `${dx},${dz} should be dry`);
      else assert.equal(s, blockState(water, d), `${dx},${dz}`);
    }
  world.setBlock(30, 11, 30, 0);
  fluids.settle();
  for (let dz = -9; dz <= 9; dz++)
    for (let dx = -9; dx <= 9; dx++) assert.equal(world.getBlock(30 + dx, 11, 30 + dz), 0, `${dx},${dz} left`);
});

test('water falls off an edge as a full column and spreads again below; it heads for the nearest drop', () => {
  const { world, fluids, water, stone } = setup();
  // A ledge at y 20 from x 20 to 25; water on it at x 22 runs to the edge at x 25 and falls to the floor.
  const ledge = [];
  for (let z = 20; z < 30; z++) for (let x = 20; x <= 25; x++) ledge.push(x, 20, z, stone);
  world.setBlocks(ledge);
  world.setBlock(23, 21, 24, water);
  fluids.settle();
  for (let y = 11; y <= 20; y++)
    assert.equal(world.getBlock(26, y, 24), blockState(water, FLUID_FALLING), `fall y ${y}`);
  assert.equal(world.getBlock(26, 21, 24), blockState(water, 3)); // over the edge, then down
  assert.equal(world.getBlock(27, 11, 24), blockState(water, 1)); // spreading again on the floor
  assert.equal(world.getBlock(27, 12, 24), 0); // not from the falling column above the floor
  // Toward the nearest drop: from (23, 24) the edge at x 26 is 3 away; west (x 19) is 4 away, so nothing flows west.
  assert.equal(world.getBlock(22, 21, 24), 0);
  assert.equal(world.getBlock(24, 21, 24), blockState(water, 1));
});

test('two sources beside each other on solid ground make a third', () => {
  const { world, fluids, water } = setup();
  world.setBlocks([10, 11, 10, water, 12, 11, 10, water]);
  fluids.settle();
  assert.equal(world.getBlock(11, 11, 10), blockState(water, 0));
});

test('lava reaches 3 cells, slower; lava and water make obsidian and cobblestone', () => {
  const { world, fluids, water, lava, obsidian, cobble } = setup();
  world.setBlock(10, 11, 10, lava);
  for (let i = 0; i < 29; i++) fluids.tick();
  assert.equal(world.getBlock(11, 11, 10), 0); // its first step comes after 30 ticks
  fluids.tick();
  assert.equal(world.getBlock(11, 11, 10), blockState(lava, 2));
  fluids.settle();
  assert.equal(world.getBlock(13, 11, 10), blockState(lava, 6));
  assert.equal(world.getBlock(14, 11, 10), 0);
  // Water poured next to the lava's edge and onto its source.
  world.setBlock(14, 11, 10, water);
  world.setBlock(10, 12, 10, water);
  fluids.settle();
  assert.equal(world.getBlock(10, 11, 10), obsidian);
  assert.ok([cobble, 0].includes(world.getBlock(13, 11, 10)) || blockId(world.getBlock(13, 11, 10)) === water);
  let cobbles = 0;
  for (let z = 0; z < 20; z++) for (let x = 0; x < 20; x++) cobbles += +(world.getBlock(x, 11, z) === cobble);
  assert.ok(cobbles > 0, 'flowing lava touched by water turns to cobblestone');
});

test('water washes plants away and stops at unloaded chunks', () => {
  const { world, fluids, water, flower } = setup(1);
  world.setBlocks([29, 11, 5, flower, 31, 11, 5, water]);
  fluids.settle();
  assert.equal(blockId(world.getBlock(29, 11, 5)), water);
  assert.equal(world.getChunk(1, 0, 0), undefined); // x 32 is not loaded: nothing flowed there
  assert.equal(blockData(world.getBlock(31, 11, 5)), 0);
});

test('options and calls are checked', () => {
  const { world, fluids } = setup(1);
  assert.throws(() => VoxelFluids.attach({}, { fluids: [] }), TypeError);
  assert.throws(() => VoxelFluids.attach(world, { fluids: [{ block: 'stone' }] }), RangeError);
  assert.throws(() => VoxelFluids.attach(world, { fluids: [{ block: 'nope' }] }), RangeError);
  assert.throws(() => VoxelFluids.attach(world, { fluids: [{ block: 'water', reach: 8 }] }), RangeError);
  assert.throws(() => fluids.update(-1), RangeError);
  fluids.dispose();
  assert.throws(() => fluids.tick(), { code: 'disposed' });
});
