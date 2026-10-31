// The Plaza's rare block rules and message: the pure parts (counts.mjs, src/counts.ts). plaza-counts.test.js runs them over
// real sockets in a real shard.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { VoxelChunk } from '@margoengine/voxel';
import { PlazaCounts } from '../server/counts.mjs';
import { defineBlocks } from '../src/blocks.ts';
import { decodeCounts, encodeCounts } from '../src/counts.ts';
import { COUNTED_BLOCKS, GEM_TOTAL } from '../src/plaza-area.ts';

const { blocks } = defineBlocks(),
  TIN = blocks.id('tin_ore'),
  OPAL = blocks.id('opal'),
  STONE = blocks.id('stone'),
  TIN_SLOT = COUNTED_BLOCKS.indexOf('tin_ore'),
  OPAL_SLOT = COUNTED_BLOCKS.indexOf('opal'),
  GEM = [10, 20, 30],
  isGem = (x, y, z) => x === GEM[0] && y === GEM[1] && z === GEM[2],
  make = (saved) => new PlazaCounts({ blocks, isGem, saved }),
  // An edit as the shard sees it: asked, and, when allowed, landed.
  edit = (counts, who, cell, state, previous) => {
    const ok = counts.allow(who, ...cell, state, previous);
    if (ok) counts.landed(...cell, state);
    return ok;
  };

test('every counted block is solid, so an edit can only remove one by breaking it', () => {
  for (const name of COUNTED_BLOCKS) assert.equal(blocks.table[blocks.id(name)].solid, true, name);
});

test('digging a natural ore pays once; the same cell brought back pays nothing', () => {
  const counts = make(),
    cell = [1, 2, 3];
  assert.equal(edit(counts, 'a', cell, 0, TIN), true);
  assert.equal(counts.countsOf('a')[TIN_SLOT], 1);
  assert.equal(edit(counts, 'b', cell, 0, TIN), true, 'a rollback or a crash brought it back: anyone may clear it');
  assert.equal(counts.countsOf('b')[TIN_SLOT], 0);
  assert.equal(counts.countsOf('a')[TIN_SLOT], 1);
});

test('a gem moves the world count once, and an opal that is no gem moves nothing', () => {
  const counts = make();
  assert.equal(edit(counts, 'a', GEM, 0, OPAL), true);
  assert.equal(counts.found, 1);
  assert.equal(counts.countsOf('a')[OPAL_SLOT], 1);
  assert.deepEqual(counts.takeChanges().found, true);
  edit(counts, 'b', GEM, 0, OPAL);
  assert.equal(counts.found, 1, 'the same gem again');
  assert.equal(counts.countsOf('b')[OPAL_SLOT], 0);
  edit(counts, 'b', [9, 9, 9], 0, OPAL);
  assert.equal(counts.countsOf('b')[OPAL_SLOT], 0);
  assert.equal(counts.found, 1);
});

test('place without a count is refused; placing and breaking your own earns nothing, however often', () => {
  const counts = make(),
    ore = [1, 2, 3],
    spot = [4, 5, 6];
  assert.equal(counts.allow('a', ...spot, TIN, 0), false, 'nothing to place');
  edit(counts, 'a', ore, 0, TIN);
  for (let i = 0; i < 5; i++) {
    assert.equal(edit(counts, 'a', spot, TIN, 0), true);
    assert.equal(counts.countsOf('a')[TIN_SLOT], 0);
    assert.equal(counts.ownerOf(...spot), 'a');
    assert.equal(counts.allow('a', ...spot, TIN, 0), false, 'the only one is in the world');
    assert.equal(edit(counts, 'a', spot, 0, TIN), true);
    assert.equal(counts.countsOf('a')[TIN_SLOT], 1, 'back to one, never two');
  }
});

test('a placed gem is its owner only and never moves the world count, even on a gem cell', () => {
  const counts = make();
  edit(counts, 'a', GEM, 0, OPAL);
  assert.equal(edit(counts, 'a', GEM, OPAL, 0), true);
  assert.equal(counts.allow('b', ...GEM, 0, OPAL), false, 'not the owner');
  assert.equal(counts.countsOf('b')[OPAL_SLOT], 0);
  assert.equal(edit(counts, 'a', GEM, 0, OPAL), true);
  assert.equal(counts.found, 1);
  assert.equal(counts.countsOf('a')[OPAL_SLOT], 1);
});

test('an edit the server refuses after allow() earns nothing', () => {
  // The limit on edited chunks refuses after allowEdit: no landed() comes, and the next edit must not inherit the pending.
  const counts = make(),
    ore = [1, 2, 3];
  assert.equal(counts.allow('a', ...ore, 0, TIN), true);
  assert.equal(counts.countsOf('a')[TIN_SLOT], 0);
  assert.equal(counts.landed(1, 2, 4, 0), false, 'another cell');
  assert.equal(counts.allow('a', 7, 7, 7, STONE, 0), true);
  assert.equal(counts.landed(...ore, 0), false, 'the old decision is gone');
  assert.equal(counts.countsOf('a')[TIN_SLOT], 0);
  assert.equal(edit(counts, 'a', ore, 0, TIN), true, 'and it can still be dug');
  assert.equal(counts.countsOf('a')[TIN_SLOT], 1);
});

test('the high bits of a state do not hide a counted block', () => {
  const counts = make();
  assert.equal(counts.allow('a', 4, 5, 6, TIN | (3 << 16), 0), false);
  edit(counts, 'a', [1, 2, 3], 0, TIN | (1 << 16));
  assert.equal(counts.countsOf('a')[TIN_SLOT], 1);
  assert.equal(counts.allow('a', 4, 5, 6, 0xffff, 0), true, 'an id off the table is the server s to refuse');
});

test('a non-zero state over a counted block is refused', () => {
  assert.equal(make().allow('a', 1, 2, 3, STONE, TIN), false);
});

test('a count stops at what it can hold and a find still lands', () => {
  const inventory = { a: COUNTED_BLOCKS.map(() => 0xffff) },
    counts = make({ found: 0, inventory, dug: [], placed: [] });
  assert.equal(edit(counts, 'a', [1, 2, 3], 0, TIN), true);
  assert.equal(counts.countsOf('a')[TIN_SLOT], 0xffff);
});

test('reconcile: a placed block gone from the world goes back to its owner; one still there stays', () => {
  const counts = make(),
    kept = [1, 2, 3],
    lost = [40, 2, 3],
    noChunk = [100, 2, 3];
  for (let i = 0; i < 3; i++) edit(counts, 'a', [200 + i, 0, 0], 0, TIN);
  edit(counts, 'a', kept, TIN, 0);
  edit(counts, 'a', lost, TIN, 0);
  edit(counts, 'a', noChunk, TIN, 0);
  assert.equal(counts.countsOf('a')[TIN_SLOT], 0);
  const chunk = new VoxelChunk();
  chunk.set(1, 2, 3, TIN);
  const edits = new Map([
    ['0,0,0', chunk.pack()],
    ['1,0,0', new VoxelChunk().pack()],
  ]);
  counts.takeChanges();
  assert.equal(counts.reconcile(edits), 2);
  assert.equal(counts.countsOf('a')[TIN_SLOT], 2);
  assert.equal(counts.ownerOf(...kept), 'a');
  assert.equal(counts.ownerOf(...lost), undefined);
  assert.deepEqual([...counts.takeChanges().identities], ['a'], 'the owner is told');
  // Should the taken-back block ever return, it pays nobody again.
  edit(counts, 'b', lost, 0, TIN);
  assert.equal(counts.countsOf('b')[TIN_SLOT], 0);
});

test('what state.json keeps brings everything back, and holds no address', () => {
  const counts = make();
  edit(counts, 'a', GEM, 0, OPAL);
  edit(counts, 'a', [1, 2, 3], 0, TIN);
  edit(counts, 'a', [4, 5, 6], TIN, 0);
  assert.equal(counts.dirty, true);
  const back = make(JSON.parse(JSON.stringify(counts)));
  assert.equal(back.found, 1);
  assert.deepEqual(back.countsOf('a'), counts.countsOf('a'));
  assert.equal(back.ownerOf(4, 5, 6), 'a');
  edit(back, 'a', [1, 2, 3], 0, TIN);
  assert.equal(back.countsOf('a')[TIN_SLOT], 0, 'a cell dug before the restart stays dug');
  edit(back, 'b', GEM, 0, OPAL);
  assert.equal(back.found, 1);
  assert.equal(back.dirty, false);
});

test('200 identities and 50,000 cells go through state.json', () => {
  const counts = make();
  for (let i = 0; i < 50_000; i++) edit(counts, `id${i % 200}`, [i, 5, 5], 0, TIN);
  const text = JSON.stringify(counts),
    back = make(JSON.parse(text));
  assert.equal(back.countsOf('id7')[TIN_SLOT], 250);
});

test('the message round trips, and is about a dozen bytes', () => {
  const full = { found: 412, total: GEM_TOTAL, counts: [3, 0, 70000, 1, 65535], ended: false },
    bytes = encodeCounts(full);
  assert.deepEqual(decodeCounts(bytes), full);
  assert.ok(encodeCounts({ found: 1000, total: 1000, counts: [1, 2, 3, 4, 5] }).length <= 12);
  assert.deepEqual(decodeCounts(encodeCounts({ found: 9, total: 1000 })), { found: 9, total: 1000, ended: false });
  assert.equal(decodeCounts(encodeCounts({ found: 0, total: 1000, counts: [0, 0, 0, 0, 0], ended: true })).ended, true);
});

test('the page can import the message without terrain: counts.ts imports only plaza-area.ts', async () => {
  const text = await readFile(new URL('../src/counts.ts', import.meta.url), 'utf8');
  assert.deepEqual(
    [...text.matchAll(/^import .* from '(.*)';/gm)].map((m) => m[1]),
    ['./plaza-area.ts'],
  );
});

test('bad messages are refused with a reason', () => {
  assert.throws(() => encodeCounts({ found: -1, total: 1 }), RangeError);
  assert.throws(() => encodeCounts({ found: 1.5, total: 1 }), RangeError);
  assert.throws(() => encodeCounts({ found: 1, total: 1, counts: [1] }), RangeError);
  for (const bad of [[], [9, 0, 0], [0, 128], [0, 1], [0, 1, 1, 1], [2, 1, 1, 1], [0, 255, 255, 255, 255, 255, 1]])
    assert.throws(() => decodeCounts(Uint8Array.from(bad)), RangeError, String(bad));
});
