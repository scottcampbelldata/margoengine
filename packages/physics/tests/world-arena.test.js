// The world's one region allocator (`Arena`, packages/physics/src/world/memory.ts): regions are freed and resized, freed
// blocks merge and are taken again lowest first, and the same calls give the same offsets.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Arena, DYNAMIC_BASE, regionWords, worldMemory } from '../dist/world.js';

const plain = () => new Arena(worldMemory(false));

test('a freed region is taken again by the next region that fits it, the lowest block first', () => {
  const arena = plain(),
    a = arena.allocate('a', 64, 'u8', 1),
    b = arena.allocate('b', 64, 'u8', 1),
    c = arena.allocate('c', 64, 'u8', 1);
  assert.deepEqual([a.byteOffset, b.byteOffset, c.byteOffset], [DYNAMIC_BASE, DYNAMIC_BASE + 64, DYNAMIC_BASE + 128]);
  arena.free(b);
  assert.equal(arena.freeBytes, 64);
  const d = arena.allocate('d', 24, 'f32', 1);
  assert.equal(d.byteOffset, b.byteOffset, 'the hole b left');
  const e = arena.allocate('e', 64, 'u8', 1);
  assert.equal(e.byteOffset, DYNAMIC_BASE + 192, 'too large for the 40 bytes left of the hole: the top');
  const f = arena.allocate('f', 40, 'u8', 1);
  assert.equal(f.byteOffset, b.byteOffset + 24, 'the rest of the hole');
  assert.equal(arena.freeBytes, 0);
});

test('neighbouring free blocks merge, and a block that reaches the top lowers it', () => {
  const arena = plain(),
    regions = ['a', 'b', 'c', 'd'].map((name) => arena.allocate(name, 32, 'u8', 1));
  arena.free(regions[1]);
  arena.free(regions[0]);
  assert.equal(arena.allocate('ab', 64, 'u8', 1).byteOffset, DYNAMIC_BASE, 'a and b are one block of 64 bytes');
  arena.free(regions[3]);
  assert.equal(arena.used, 96, 'd was the top');
  arena.free(regions[2]);
  assert.equal(arena.used, 64, 'c, now the top, gives its bytes back too');
  assert.equal(arena.freeBytes, 0);
});

test('a region comes back zeroed, also where an earlier one wrote', () => {
  const arena = plain(),
    a = arena.allocate('a', 16, 'u32', 1);
  regionWords(arena.memory, a).fill(7);
  arena.free(a);
  const b = arena.allocate('b', 16, 'u32', 1);
  assert.equal(b.byteOffset, a.byteOffset);
  assert.deepEqual([...regionWords(arena.memory, b)], [0, 0, 0, 0]);
});

test('resize keeps the words: in place at the top, in place into a free block after it, or moved with one copy', () => {
  const arena = plain(),
    a = arena.allocate('a', 16, 'u32', 3),
    b = arena.allocate('b', 8, 'u32', 3);
  regionWords(arena.memory, a).set([1, 2, 3, 4]);
  regionWords(arena.memory, b).set([5, 6]);
  // b is the top: it grows where it is.
  const b2 = arena.resize(b, 16);
  assert.equal(b2.byteOffset, b.byteOffset);
  assert.deepEqual([...regionWords(arena.memory, b2)], [5, 6, 0, 0]);
  assert.deepEqual([b2.name, b2.type, b2.layout], ['b', 'u32', 3]);
  // a has b right after it: it moves to the top, its words with it, and frees its block.
  const a2 = arena.resize(a, 32);
  assert.equal(a2.byteOffset, b2.byteOffset + 16);
  assert.deepEqual([...regionWords(arena.memory, a2)], [1, 2, 3, 4, 0, 0, 0, 0]);
  assert.equal(arena.freeBytes, 16);
  // A region before the hole grows into it.
  const c = arena.allocate('c', 8, 'u8', 1);
  assert.equal(c.byteOffset, DYNAMIC_BASE, 'the block a left');
  const c2 = arena.resize(c, 16);
  assert.equal(c2.byteOffset, c.byteOffset, 'into the free block after it');
  assert.equal(arena.freeBytes, 0);
  // Shrinking frees the tail, and the dropped words read zero when the region grows back.
  const a3 = arena.resize(a2, 8);
  assert.equal(a3.byteOffset, a2.byteOffset);
  assert.deepEqual([...regionWords(arena.memory, a3)], [1, 2]);
  assert.deepEqual([...regionWords(arena.memory, arena.resize(a3, 16))], [1, 2, 0, 0]);
});

test('a region freed twice, resized after a free or handed out by another arena is refused, and nothing changes', () => {
  const arena = plain(),
    a = arena.allocate('a', 16, 'u8', 1),
    b = arena.allocate('b', 16, 'u8', 1);
  arena.free(a);
  const fix =
    /not a live region of this arena; free or resize each region once, with the region allocate or resize returned/;
  assert.throws(() => arena.free(a), fix);
  assert.throws(() => arena.resize(a, 32), fix);
  const moved = arena.resize(b, 64);
  assert.throws(() => arena.free(b), fix, 'b is gone once resize returned its new place');
  assert.throws(() => arena.free({ ...moved, byteLength: 8 }), fix, 'a region with another length');
  assert.throws(() => plain().free(moved), fix);
  assert.equal(arena.freeBytes, 16);
  arena.free(moved);
  assert.equal(arena.used, 0);
  assert.throws(() => arena.resize(moved, 12), /pass a whole number|not a live region/);
});

// A random sequence of allocations, frees and resizes, with a byte map of what each live region should hold.
function churn(seed, steps) {
  let state = seed;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const arena = plain(),
    live = [],
    offsets = [];
  for (let i = 0; i < steps; i++) {
    const pick = next() % 10;
    if (live.length === 0 || pick < 5) {
      const bytes = 8 * (next() % 96);
      const region = arena.allocate(`r${i}`, bytes, 'u8', 1),
        fill = (i % 251) + 1;
      regionWords(arena.memory, region).fill(fill);
      live.push({ region, fill });
      offsets.push(region.byteOffset);
    } else if (pick < 8) {
      const [gone] = live.splice(next() % live.length, 1);
      arena.free(gone.region);
    } else {
      const entry = live[next() % live.length],
        bytes = 8 * (next() % 160),
        old = entry.region.byteLength;
      entry.region = arena.resize(entry.region, bytes);
      offsets.push(entry.region.byteOffset);
      const words = regionWords(arena.memory, entry.region);
      for (let k = 0; k < bytes; k++)
        assert.equal(words[k], k < old ? entry.fill : 0, `resize kept byte ${k} of ${old}`);
      words.fill(entry.fill);
    }
    // Every live region lies above the module windows, 8-byte aligned, apart from every other, and holds its own bytes.
    const spans = live
      .filter(({ region }) => region.byteLength > 0)
      .map(({ region }) => [region.byteOffset, region.byteOffset + region.byteLength])
      .sort((x, y) => x[0] - y[0]);
    for (let k = 0; k < spans.length; k++) {
      assert.ok(spans[k][0] >= DYNAMIC_BASE && spans[k][0] % 8 === 0);
      if (k > 0) assert.ok(spans[k - 1][1] <= spans[k][0], `step ${i}: regions overlap`);
    }
  }
  for (const { region, fill } of live) assert.ok(regionWords(arena.memory, region).every((b) => b === fill));
  return { offsets, used: arena.used, free: arena.freeBytes };
}

test('3,000 random allocations, frees and resizes keep every region apart and whole, and replay to the same offsets', () => {
  const first = churn(0x4d415247, 3000),
    again = churn(0x4d415247, 3000);
  assert.deepEqual(again, first);
  // Freed blocks are reused: the arena reaches far less than the sum of everything ever handed out.
  assert.ok(first.used < 0.5 * first.offsets.length * 8 * 96, `reached ${first.used} bytes`);
});
