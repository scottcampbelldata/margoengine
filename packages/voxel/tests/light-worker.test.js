// @margoengine/voxel/light-worker: light computed in a worker equals VoxelLighting's on the page, cell for cell, after
// loads, edits (torches, a roof removed and put back, slabs), unloads and a chunk loaded again, and light that arrives
// for a chunk unloaded or reloaded since is not written.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockTypes, VoxelChunk, VoxelWorld, slabState } from '../dist/index.js';
import { VoxelLighting } from '../dist/light.js';
import { VoxelLightWorker } from '../dist/light-worker.js';
import { NodeWebWorker } from './worker-support.js';

globalThis.Worker ??= NodeWebWorker;

const make = () => {
  const blocks = new BlockTypes();
  blocks.define('stone');
  blocks.define('glass', { layer: 'translucent' });
  blocks.define('leaves', { layer: 'cutout', opacity: 1 });
  blocks.define('torch', { shape: 'cross', layer: 'cutout', solid: false, light: 14 });
  blocks.define('slab', { shape: 'slab' });
  return blocks;
};
let seed = 9;
const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
// The same terrain in two worlds: 3 x 2 x 3 chunks of hills, caves and a few torches.
const fill = (world) => {
  const edits = [];
  for (let z = 0; z < 96; z++)
    for (let x = 0; x < 96; x++) {
      const h = Math.floor(20 + 8 * Math.sin(x * 0.11) * Math.cos(z * 0.07));
      for (let y = 0; y < 64; y++) {
        let s = y <= h ? 1 : 0;
        if (s && y > 4 && y < h - 2 && Math.sin(x * 0.3) * Math.cos(z * 0.25) * Math.sin(y * 0.4) > 0.5) s = 0;
        if (s) edits.push(x, y, z, s);
      }
    }
  world.setBlocks(edits);
};
const lightOf = (world) => {
  const out = [];
  for (let cz = 0; cz < 3; cz++)
    for (let cy = 0; cy < 2; cy++)
      for (let cx = 0; cx < 3; cx++) {
        const chunk = world.getChunk(cx, cy, cz);
        if (!chunk) continue;
        for (let i = 0; i < 32768; i++) out.push(chunk.getLight(i & 31, i >> 10, (i >> 5) & 31));
      }
  return out;
};
const same = (a, b, label) => {
  const la = lightOf(a),
    lb = lightOf(b);
  assert.equal(la.length, lb.length, label);
  const at = la.findIndex((v, i) => v !== lb[i]);
  assert.equal(at, -1, `${label}: first differing light at ${at}: ${la[at]} vs ${lb[at]}`);
};

test('worker light equals page light through loads, edits, unloads and reloads', async () => {
  const blocks = make(),
    page = new VoxelWorld({ blocks }),
    work = new VoxelWorld({ blocks: make() });
  fill(page);
  fill(work);
  const reference = VoxelLighting.attach(page, { budget: Infinity });
  reference.update();
  const lit = VoxelLightWorker.attach(work);
  await lit.settled();
  assert.ok(lit.update() > 0);
  same(work, page, 'first light');
  for (const key of work.dirty) work.dirty.delete(key);

  // Torches in caves and on hills, a slab, a 20 x 20 stone roof over open ground, glass and leaves.
  const edits = [];
  for (let i = 0; i < 30; i++)
    edits.push(Math.floor(random() * 96), 5 + Math.floor(random() * 50), Math.floor(random() * 96), 4);
  edits.push(40, 30, 40, slabState(5));
  for (let z = 10; z < 30; z++) for (let x = 60; x < 80; x++) edits.push(x, 50, z, 1);
  for (let x = 60; x < 80; x++) edits.push(x, 49, 30, 2, x, 48, 31, 3);
  for (const world of [page, work]) world.setBlocks(edits);
  reference.update();
  assert.equal(lit.busy, true);
  await lit.settled();
  lit.update();
  same(work, page, 'after edits');
  assert.ok(work.dirty.size > 0);

  // The roof taken off again, torches removed.
  const undo = [];
  for (let z = 10; z < 30; z++) for (let x = 60; x < 80; x++) undo.push(x, 50, z, 0);
  for (let i = 0; i < edits.length && i < 120; i += 4) undo.push(edits[i], edits[i + 1], edits[i + 2], 0);
  for (const world of [page, work]) world.setBlocks(undo);
  reference.update();
  await lit.settled();
  lit.update();
  same(work, page, 'after undo');

  // A chunk unloaded and another loaded again with edited blocks.
  for (const world of [page, work]) {
    world.removeChunk(1, 0, 1);
    const old = world.removeChunk(2, 0, 0),
      again = VoxelChunk.unpack(old.pack());
    again.set(3, 31, 3, 4);
    world.addChunk(2, 0, 0, again);
  }
  reference.update();
  await lit.settled();
  lit.update();
  same(work, page, 'after unload and reload');

  // A type defined after attach.
  for (const b of [page.blocks, work.blocks]) b.define('lamp', { light: 15 });
  for (const world of [page, work]) world.setBlock(50, 40, 50, 6);
  reference.update();
  await lit.settled();
  lit.update();
  same(work, page, 'after a new type');
  lit.dispose();
  assert.throws(() => lit.update(), { code: 'disposed' });
});

test('light for a chunk unloaded or loaded again before it arrives is not written', async () => {
  const world = new VoxelWorld({ blocks: make() });
  world.setBlock(5, 5, 5, 4); // a torch: chunk 0,0,0
  const lit = VoxelLightWorker.attach(world);
  await lit.settled();
  // Reload the chunk before the answer is written: the answer is for the old chunk.
  const old = world.removeChunk(0, 0, 0);
  world.addChunk(0, 0, 0, VoxelChunk.unpack(old.pack()));
  const fresh = world.getChunk(0, 0, 0);
  fresh.fillLight(0);
  lit.update(); // writes nothing for 0,0,0 (stale); sends the reload
  assert.equal(fresh.getLight(5, 6, 5), 0);
  await lit.settled();
  assert.equal(lit.update(), 1);
  assert.equal(fresh.getLight(5, 6, 5) & 15, 13);
  lit.dispose();
});

test('attach is checked', () => {
  const world = new VoxelWorld({ blocks: make() });
  assert.throws(() => VoxelLightWorker.attach({}), TypeError);
  assert.throws(() => VoxelLightWorker.attach(world, { worker: 1 }), TypeError);
  const lit = VoxelLightWorker.attach(world);
  assert.throws(() => VoxelLightWorker.attach(world), { code: 'attached' });
  lit.dispose();
  VoxelLightWorker.attach(world).dispose();
});
