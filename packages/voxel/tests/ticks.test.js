// @margoengine/voxel/ticks: scheduled ticks run in order at their tick, random ticks pick cells evenly and repeat for a
// seed, neighbour and placed hooks run once per change, and the built-in rules: sand falls a cell per delay and lands,
// grass spreads onto lit dirt only, crops grow through their stages, fire spreads through wood and burns out.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockTypes, VoxelWorld, blockData, blockId, blockState } from '../dist/index.js';
import { fallingRule, fireRule, growRule, spreadRule, VoxelTicks } from '../dist/ticks.js';

const setup = () => {
  const blocks = new BlockTypes(),
    ids = {};
  for (const name of ['stone', 'sand', 'dirt', 'grass', 'wheat', 'planks', 'fire', 'marker'])
    ids[name] = blocks.define(name, name === 'fire' || name === 'wheat' ? { solid: false, shape: 'cross' } : {});
  const world = new VoxelWorld({ blocks });
  world.addChunk(0, 0, 0);
  return { world, ids };
};

test('scheduled ticks run at their tick, in order; placed and neighbour hooks once per change', () => {
  const { world, ids } = setup(),
    seen = [],
    ticks = VoxelTicks.attach(world, {
      randomTicks: 0,
      rules: {
        marker: {
          scheduled: (c) => seen.push(['s', c.tick, c.x]),
          placed: (c) => seen.push(['p', c.tick, c.x]),
          neighbor: (c) => seen.push(['n', c.tick, c.x]),
        },
      },
    });
  world.setBlocks([1, 1, 1, ids.marker, 3, 1, 1, ids.marker]);
  ticks.schedule(3, 1, 1, 2);
  ticks.schedule(1, 1, 1, 2);
  ticks.schedule(1, 1, 1, 1);
  ticks.tick(); // tick 1: s(1) at x 1; placed for both
  world.setBlock(2, 1, 1, ids.stone); // between them: one neighbour update each, next tick
  ticks.tick();
  ticks.tick();
  assert.deepEqual(seen, [
    ['s', 1, 1],
    ['p', 1, 1],
    ['p', 1, 3],
    ['s', 2, 3],
    ['s', 2, 1],
    ['n', 2, 3],
    ['n', 2, 1],
  ]);
  assert.equal(ticks.pending, 0);
});

test('random ticks: about randomTicks per chunk per tick, spread over the chunk, the same for a seed', () => {
  const run = (seed) => {
    const { world, ids } = setup(),
      hits = [];
    world.setBlocks(
      Array.from({ length: 32 * 32 }, (_, i) => [i & 31, 0, i >> 5, ids.marker]).flat(), // one marker layer
    );
    const ticks = VoxelTicks.attach(world, {
      seed,
      randomTicks: 64,
      rules: { marker: { random: (c) => hits.push(c.x + 32 * c.z) } },
    });
    for (let i = 0; i < 2000; i++) ticks.tick();
    return hits;
  };
  const a = run(5),
    b = run(5),
    c = run(6);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  // 64 picks of 32,768 cells per tick hit the 1,024 marker cells 2 times a tick on average: 4,000 in 2,000 ticks.
  assert.ok(Math.abs(a.length - 4000) < 4 * Math.sqrt(4000), `${a.length} hits`);
  const counts = new Array(1024).fill(0);
  for (const h of a) counts[h]++;
  assert.ok(counts.filter((n) => n === 0).length < 60, 'every cell gets picked'); // e^-3.9 * 1024 = 21 expected
});

test('falling sand drops one cell per delay and lands on the floor, also when its support is taken away', () => {
  const { world, ids } = setup(),
    ticks = VoxelTicks.attach(world, { rules: { sand: fallingRule(2) }, randomTicks: 0 });
  world.setBlock(5, 2, 5, ids.stone);
  world.setBlock(5, 10, 5, ids.sand); // placed in the air: falls
  for (let i = 0; i < 2; i++) ticks.tick(); // placed runs at tick 1, falls at tick 3
  assert.equal(world.getBlock(5, 10, 5), ids.sand);
  ticks.tick();
  assert.equal(world.getBlock(5, 9, 5), ids.sand);
  for (let i = 0; i < 40; i++) ticks.tick();
  assert.equal(world.getBlock(5, 3, 5), ids.sand);
  world.setBlock(5, 2, 5, 0); // the stone under it goes
  for (let i = 0; i < 40; i++) ticks.tick();
  assert.equal(world.getBlock(5, 0, 5), ids.sand); // y 0 is the bottom of the only loaded chunk... below is unloaded
  assert.equal(world.getBlock(5, 3, 5), 0);
});

test('grass spreads onto dirt with enough sky light, not in the dark; crops grow; fire burns through wood and out', () => {
  const { world, ids } = setup(),
    ticks = VoxelTicks.attach(world, {
      seed: 3,
      randomTicks: 4096,
      rules: {
        grass: spreadRule({ onto: ids.dirt, light: 9, smothered: ids.dirt }),
        wheat: growRule(8),
        fire: fireRule({ burns: { [ids.planks]: 0.5 }, delay: 3, life: 6 }),
      },
    });
  const dirt = [];
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) dirt.push(x, 4, z, ids.dirt);
  world.setBlocks(dirt);
  world.getChunk(0, 0, 0).fillLight(0xf0); // open sky everywhere
  for (let z = 0; z < 32; z++) for (let x = 16; x < 32; x++) world.getChunk(0, 0, 0).setLight(x, 5, z, 0x30); // dark half
  world.setBlock(2, 4, 2, ids.grass);
  world.setBlock(3, 5, 3, blockState(ids.wheat, 0));
  for (let i = 0; i < 1500; i++) ticks.tick();
  let lit = 0,
    dark = 0;
  for (let z = 0; z < 32; z++)
    for (let x = 0; x < 32; x++) if (world.getBlock(x, 4, z) === ids.grass) x < 16 ? lit++ : dark++;
  assert.ok(lit > 400, `grass on lit dirt: ${lit}`);
  assert.equal(dark, 0);
  assert.equal(blockData(world.getBlock(3, 5, 3)), 7);
  // Fire on a plank floor spreads and burns out.
  const floor = [];
  for (let x = 0; x < 10; x++) floor.push(x, 20, 10, ids.planks);
  world.setBlocks(floor);
  world.setBlock(0, 21, 10, ids.fire);
  for (let i = 0; i < 2000; i++) ticks.tick();
  let planks = 0,
    fires = 0;
  for (let x = 0; x < 10; x++) planks += +(world.getBlock(x, 20, 10) === ids.planks);
  for (let y = 19; y < 23; y++) for (let x = 0; x < 11; x++) fires += +(blockId(world.getBlock(x, y, 10)) === ids.fire);
  assert.ok(planks < 10, 'some planks burned');
  assert.equal(fires, 0, 'every fire went out');
});

test('options are checked', () => {
  const { world } = setup();
  assert.throws(() => VoxelTicks.attach({}), TypeError);
  assert.throws(() => VoxelTicks.attach(world, { randomTicks: -1 }), RangeError);
  assert.throws(() => VoxelTicks.attach(world, { rules: { nope: {} } }), RangeError);
  assert.throws(() => VoxelTicks.attach(world, { rules: { sand: { random: 1 } } }), TypeError);
  const ticks = VoxelTicks.attach(world);
  assert.throws(() => ticks.schedule(0, 0, 0, 0), RangeError);
  assert.throws(() => growRule(0), RangeError);
  ticks.dispose();
  assert.throws(() => ticks.tick(), { code: 'disposed' });
});
