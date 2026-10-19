import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_SIZE, VoxelChunk } from '../dist/index.js';

const CELLS = 32768;
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const cell = (i) => [i & 31, i >> 10, (i >> 5) & 31]; // x, y, z of index x | z << 5 | y << 10
const widthFor = (n) => (n <= 1 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : n <= 256 ? 8 : 16);
const same = (chunk, oracle) => {
  for (let i = 0; i < CELLS; i++) if (chunk.get(...cell(i)) !== oracle[i]) return `cell ${i}`;
  return '';
};
// Index widths stay within one doubling of the narrowest that holds the distinct states.
const widthOk = (chunk, oracle) => {
  const n = new Set(oracle).size,
    { bits } = chunk.pack();
  return n === 1 ? bits === 0 : bits >= widthFor(n) && bits <= widthFor(2 * n);
};

test('random edits match a dense array through every palette size, and pack/unpack round-trips', () => {
  const next = random(7),
    chunk = new VoxelChunk(),
    oracle = new Uint32Array(CELLS);
  // Pools of distinct states (spread over the u32 range) grow past every index width; pool 1 rewrites every cell.
  for (const pool of [2, 3, 5, 17, 257, 6000, 300, 40, 9, 3, 1, 70000, 2]) {
    for (let n = 0; n < (pool === 1 ? CELLS : 20000); n++) {
      const i = pool === 1 ? n : Math.floor(next() * CELLS),
        state = (Math.floor(next() * pool) * 2654435761) >>> 0;
      assert.equal(chunk.set(...cell(i), state), oracle[i]);
      oracle[i] = state;
    }
    assert.equal(same(chunk, oracle), '', `pool ${pool}`);
    assert.ok(widthOk(chunk, oracle), `pool ${pool}: width ${chunk.pack().bits} for ${new Set(oracle).size} states`);
    assert.equal(same(VoxelChunk.unpack(chunk.pack()), oracle), '', `pool ${pool} round trip`);
  }
  assert.equal(CHUNK_SIZE, 32);
});

test('the palette widens through 1, 2, 4, 8 and 16 bits and shrinks back to a uniform chunk', () => {
  const chunk = new VoxelChunk(),
    grown = [],
    shrunk = [];
  // Cell i holds state i + 1 (cells past `count` stay air): count + 1 distinct states.
  for (let i = 0; i < 600; i++) {
    chunk.set(...cell(i), i + 1);
    grown.push(chunk.pack().bits);
  }
  assert.deepEqual([...new Set(grown)], [1, 2, 4, 8, 16]);
  assert.equal(grown.indexOf(2), 1); // 3 states
  assert.equal(grown.indexOf(4), 3); // 5 states
  assert.equal(grown.indexOf(8), 15); // 17 states
  assert.equal(grown.indexOf(16), 255); // 257 states
  for (let i = 599; i >= 0; i--) {
    chunk.set(...cell(i), 0);
    shrunk.push(chunk.pack().bits);
  }
  assert.deepEqual([...new Set(shrunk)], [16, 8, 4, 2, 0]);
  const packed = chunk.pack();
  assert.equal(packed.bits, 0);
  assert.deepEqual([...packed.palette], [0]);
  assert.equal(packed.words.length, 0);
  // Every cell distinct: the palette holds 32,768 states and rewriting a cell reuses its slot.
  const full = new VoxelChunk();
  for (let i = 0; i < CELLS; i++) full.set(...cell(i), i + 1);
  for (let i = 0; i < CELLS; i += 97) full.set(...cell(i), 100000 + i);
  assert.equal(full.pack().palette.length, CELLS);
  for (let i = 0; i < CELLS; i++) assert.equal(full.get(...cell(i)), i % 97 ? i + 1 : 100000 + i);
});

test('fill makes a uniform chunk stored as its palette alone', () => {
  const chunk = new VoxelChunk(3);
  assert.equal(chunk.get(31, 31, 31), 3);
  chunk.set(1, 2, 3, 9);
  chunk.fill(0xffffffff);
  const packed = chunk.pack();
  assert.deepEqual([packed.bits, [...packed.palette], packed.words.length], [0, [0xffffffff], 0]);
  assert.equal(chunk.get(1, 2, 3), 0xffffffff);
  chunk.set(0, 0, 0, 1);
  assert.equal(chunk.pack().bits, 1);
  chunk.set(0, 0, 0, 0xffffffff);
  assert.equal(chunk.pack().bits, 0);
});

test('light stays one byte until a cell differs, and round-trips both ways', () => {
  const chunk = new VoxelChunk();
  assert.equal(chunk.pack().light, 0);
  chunk.setLight(4, 5, 6, 0);
  assert.equal(chunk.pack().light, 0);
  chunk.setLight(4, 5, 6, 0xf3);
  const packed = chunk.pack();
  assert.ok(packed.light instanceof Uint8Array && packed.light.length === CELLS);
  assert.equal(packed.light[4 | (6 << 5) | (5 << 10)], 0xf3);
  assert.equal(chunk.getLight(4, 5, 6), 0xf3);
  assert.equal(chunk.getLight(0, 0, 0), 0);
  assert.equal(VoxelChunk.unpack(packed).getLight(4, 5, 6), 0xf3);
  assert.equal(VoxelChunk.unpack({ ...new VoxelChunk().pack(), light: 0xf0 }).getLight(9, 9, 9), 0xf0);
});

test('packed chunks own their buffers: transferring them leaves the chunk intact', () => {
  const next = random(11),
    chunk = new VoxelChunk();
  for (let n = 0; n < 5000; n++) chunk.set(...cell(Math.floor(next() * CELLS)), Math.floor(next() * 40));
  chunk.setLight(1, 1, 1, 0x7f);
  const before = Array.from({ length: CELLS }, (_, i) => chunk.get(...cell(i)));
  const packed = chunk.pack(),
    arrays = [packed.palette, packed.words, packed.light];
  for (const array of arrays) assert.equal(array.byteLength, array.buffer.byteLength);
  assert.equal(new Set(arrays.map((array) => array.buffer)).size, 3);
  const moved = structuredClone(packed, { transfer: arrays.map((array) => array.buffer) });
  assert.equal(packed.words.length, 0); // detached
  const copy = VoxelChunk.unpack(moved);
  for (let i = 0; i < CELLS; i++) {
    assert.equal(chunk.get(...cell(i)), before[i]);
    assert.equal(copy.get(...cell(i)), before[i]);
  }
  assert.equal(copy.getLight(1, 1, 1), 0x7f);
  // unpack copies: editing the result leaves the packed arrays alone.
  const again = chunk.pack();
  VoxelChunk.unpack(again).set(0, 0, 0, 39);
  assert.equal(VoxelChunk.unpack(again).get(0, 0, 0), before[0]);
});

test('unpack merges duplicate and unused palette entries and narrows wide indices', () => {
  const words = new Uint32Array(1024 * 16);
  for (let i = 0; i < CELLS; i++) words[i >> 1] |= (i % 3) << ((i & 1) * 16); // entries 0, 1, 2
  const chunk = VoxelChunk.unpack({ palette: Uint32Array.of(7, 8, 7, 99), bits: 16, words, light: 0 });
  const packed = chunk.pack();
  assert.deepEqual([packed.bits, [...packed.palette]], [2, [7, 8]]);
  for (let i = 0; i < CELLS; i += 101) assert.equal(chunk.get(...cell(i)), i % 3 === 1 ? 8 : 7);
  const uniform = VoxelChunk.unpack({
    palette: Uint32Array.of(4, 4),
    bits: 1,
    words: new Uint32Array(1024).fill(~0),
    light: 0,
  });
  assert.deepEqual([uniform.pack().bits, [...uniform.pack().palette]], [0, [4]]);
});

test('invalid cells, states and packed chunks throw TypeError or RangeError', () => {
  const chunk = new VoxelChunk();
  for (const [x, y, z] of [
    [32, 0, 0],
    [-1, 0, 0],
    [0, 1.5, 0],
    [0, 0, Number.NaN],
  ])
    assert.throws(() => chunk.get(x, y, z), RangeError);
  assert.throws(() => chunk.get('1', 0, 0), TypeError);
  assert.throws(() => chunk.set(0, 0, 0, -1), RangeError);
  assert.throws(() => chunk.set(0, 0, 0, 2 ** 32), RangeError);
  assert.throws(() => chunk.set(0, 0, 0, '1'), TypeError);
  assert.throws(() => new VoxelChunk(0.5), RangeError);
  assert.throws(() => chunk.setLight(0, 0, 0, 256), RangeError);
  assert.throws(() => chunk.setLight(0, 32, 0, 1), RangeError);
  const good = { palette: Uint32Array.of(1, 2), bits: 1, words: new Uint32Array(1024), light: 0 };
  assert.throws(() => VoxelChunk.unpack(null), TypeError);
  assert.throws(() => VoxelChunk.unpack({ ...good, palette: [1, 2] }), TypeError);
  assert.throws(() => VoxelChunk.unpack({ ...good, bits: 3 }), RangeError);
  assert.throws(() => VoxelChunk.unpack({ ...good, palette: Uint32Array.of(1, 2, 3) }), RangeError);
  assert.throws(() => VoxelChunk.unpack({ ...good, words: new Uint32Array(1023) }), RangeError);
  assert.throws(() => VoxelChunk.unpack({ ...good, light: 300 }), RangeError);
  assert.throws(() => VoxelChunk.unpack({ ...good, light: new Uint8Array(10) }), RangeError);
  assert.throws(() => VoxelChunk.unpack({ ...good, light: 'x' }), TypeError);
  assert.throws(
    () =>
      VoxelChunk.unpack({ ...good, palette: Uint32Array.of(1), words: Uint32Array.of(2, ...new Uint32Array(1023)) }),
    /palette entry 1 of 1/,
  );
  assert.equal(VoxelChunk.unpack(good).get(0, 0, 0), 1);
});
