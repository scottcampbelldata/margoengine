import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockTypes, VoxelChunk, VoxelWorld, blockState, chunkKey } from '../dist/index.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const world = (options) => {
  const blocks = new BlockTypes();
  for (let i = 1; i < 8; i++) blocks.define(`b${i}`);
  return new VoxelWorld({ blocks, ...options });
};
const keys = (set) => [...set].sort();

test('random edits across chunk borders and negative cells match a dense array', () => {
  const next = random(3),
    w = world(),
    // Cells -40..39 on each axis: 4 chunks per axis, two of them negative.
    size = 80,
    origin = 40,
    oracle = new Uint32Array(size ** 3),
    events = [];
  w.onChange((x, y, z, state, previous) => events.push([x, y, z, state, previous]));
  let expected = 0;
  for (let n = 0; n < 30000; n++) {
    const x = Math.floor(next() * size) - origin,
      y = Math.floor(next() * size) - origin,
      z = Math.floor(next() * size) - origin,
      state = blockState(Math.floor(next() * 8), Math.floor(next() * 3)),
      i = x + origin + size * (y + origin + size * (z + origin)),
      before = oracle[i];
    if (n % 2) assert.equal(w.setBlock(x, y, z, state), before);
    else assert.equal(w.setBlocks([x, y, z, state]), before === state ? 0 : 1);
    if (before !== state) expected++;
    oracle[i] = state;
  }
  assert.equal(events.length, expected);
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        assert.equal(w.getBlock(x - origin, y - origin, z - origin), oracle[x + size * (y + size * z)]);
  assert.equal(w.getChunk(-1, -2, 0) instanceof VoxelChunk, true);
  assert.equal(w.getBlock(1000, 0, 0), 0);
});

test('border edits mark the neighbours whose border shell holds the cell', () => {
  const w = world();
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) w.addChunk(x, y, z);
  const edit = (x, y, z) => {
    w.dirty.clear();
    w.setBlock(x, y, z, 1);
    return keys(w.dirty);
  };
  assert.deepEqual(edit(5, 6, 7), ['0,0,0']);
  assert.deepEqual(edit(31, 6, 7), ['0,0,0', '1,0,0']);
  assert.deepEqual(edit(0, 6, 7), ['-1,0,0', '0,0,0']);
  assert.deepEqual(edit(5, 31, 0), ['0,0,-1', '0,0,0', '0,1,-1', '0,1,0']);
  assert.equal(edit(31, 31, 31).length, 8);
  assert.equal(edit(-1, 0, 0).length, 8); // corner of chunk (-1, 0, 0): its +x, -y and -z sides
  // An unchanged cell marks nothing; an unloaded neighbour is not marked.
  assert.deepEqual(edit(31, 31, 31), []);
  assert.deepEqual(edit(63, 5, 5), ['1,0,0']);
});

test('adding and removing chunks marks them and their loaded neighbours, and manages column heightmaps', () => {
  const w = world();
  const a = w.addChunk(0, 0, 0);
  assert.deepEqual(keys(w.dirty), ['0,0,0']);
  assert.equal(w.getChunk(0, 0, 0), a);
  assert.deepEqual([...w.heightmap(0, 0)].slice(0, 3), [-32768, -32768, -32768]);
  assert.equal(w.heightmap(0, 0).length, 1024);
  w.dirty.clear();
  const b = new VoxelChunk(2);
  assert.equal(w.addChunk(1, 1, 1, b), b);
  assert.deepEqual(keys(w.dirty), ['0,0,0', '1,1,1']);
  assert.equal(w.getBlock(32, 32, 32), 2);
  const heights = w.heightmap(0, 0);
  w.addChunk(0, 5, 0);
  assert.equal(w.heightmap(0, 0), heights); // one per column of chunks
  w.dirty.clear();
  assert.equal(w.removeChunk(1, 1, 1), b);
  assert.deepEqual(keys(w.dirty), ['0,0,0', '1,1,1']);
  assert.equal(w.getChunk(1, 1, 1), undefined);
  assert.equal(w.getBlock(32, 32, 32), 0);
  assert.equal(w.heightmap(1, 1), undefined);
  assert.equal(w.removeChunk(1, 1, 1), undefined);
  w.removeChunk(0, 0, 0);
  assert.ok(w.heightmap(0, 0));
  w.removeChunk(0, 5, 0);
  assert.equal(w.heightmap(0, 0), undefined);
  assert.equal(chunkKey(-1, 2, -3), '-1,2,-3');
});

test('setBlock adds an air chunk for a non-air state; air in an unloaded chunk changes nothing', () => {
  const w = world(),
    changes = [];
  const off = w.onChange((...change) => changes.push(change));
  assert.equal(w.setBlock(-1, -1, -1, 0), 0);
  assert.equal(w.getChunk(-1, -1, -1), undefined);
  assert.equal(w.setBlock(-1, -1, -1, 3), 0);
  assert.equal(w.getChunk(-1, -1, -1).get(31, 31, 31), 3);
  assert.deepEqual(changes, [[-1, -1, -1, 3, 0]]);
  off();
  w.setBlock(-1, -1, -1, 4);
  assert.equal(changes.length, 1);
});

test('setBlocks checks every edit before applying any, and reads Int32Array states as u32', () => {
  const w = world();
  assert.throws(() => w.setBlocks([0, 0, 0, 1, 1, 1, 1, 99]), RangeError);
  assert.equal(w.getBlock(0, 0, 0), 0);
  const high = blockState(2, 0x8000);
  assert.equal(w.setBlocks(Int32Array.of(0, 0, 0, high | 0, 1, 0, 0, 1)), 2);
  assert.equal(w.getBlock(0, 0, 0), high);
  assert.equal(w.setBlocks(Int32Array.of(0, 0, 0, high | 0)), 0);
  assert.throws(() => w.setBlocks([0, 0, 0]), TypeError);
  assert.throws(() => w.setBlocks('0000'), TypeError);
});

test('minY and maxY bound the world', () => {
  const w = world({ minY: -10, maxY: 40 });
  assert.equal(w.getBlock(0, 41, 0), 0);
  assert.throws(() => w.setBlock(0, 41, 0, 1), RangeError);
  assert.throws(() => w.setBlock(0, -11, 0, 1), RangeError);
  w.setBlock(0, 40, 0, 1);
  w.setBlock(0, -10, 0, 1);
  assert.throws(() => w.addChunk(0, 2, 0), RangeError);
  assert.throws(() => w.addChunk(0, -2, 0), RangeError);
});

test('invalid worlds, cells, states and chunks throw per the conventions', () => {
  assert.throws(() => new VoxelWorld(), TypeError);
  assert.throws(() => new VoxelWorld({ blocks: {} }), TypeError);
  assert.throws(() => world({ minY: 5, maxY: 4 }), RangeError);
  assert.throws(() => world({ maxY: 40000 }), RangeError);
  assert.throws(() => world({ minY: 0.5 }), RangeError);
  assert.throws(() => world({ minY: '0' }), TypeError);
  const w = world();
  assert.throws(() => w.getBlock(0.5, 0, 0), RangeError);
  assert.throws(() => w.getBlock(2 ** 31, 0, 0), RangeError);
  assert.throws(() => w.getBlock('0', 0, 0), TypeError);
  assert.throws(() => w.setBlock(0, 0, 0, 8), /Block id 8 is not defined/);
  assert.throws(() => w.setBlock(0, 0, 0, -1), RangeError);
  assert.throws(() => w.setBlock(0, 0, 0, '1'), TypeError);
  assert.throws(() => w.getChunk(0.5, 0, 0), RangeError);
  assert.throws(() => w.getChunk(2 ** 26, 0, 0), RangeError);
  assert.throws(() => w.addChunk(0, 0, 0, {}), TypeError);
  w.addChunk(0, 0, 0);
  assert.throws(() => w.addChunk(0, 0, 0), { name: 'MargoError', code: 'state' });
  assert.throws(() => w.onChange(null), TypeError);
  assert.throws(() => w.heightmap(Number.NaN, 0), RangeError);
});
