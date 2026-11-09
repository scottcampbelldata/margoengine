import { speedTest } from '../../../scripts/support/speed-test.mjs';
// Page-thread cost of a big light change: VoxelLighting floods on the page; VoxelLightWorker only posts the edits and
// writes the answer back. Prints both; checks only that the worker leaves the page less to do than the flood itself.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BlockTypes, VoxelWorld } from '../dist/index.js';
import { VoxelLighting } from '../dist/light.js';
import { VoxelLightWorker } from '../dist/light-worker.js';
import { NodeWebWorker } from './worker-support.js';

globalThis.Worker ??= NodeWebWorker;

// A 32 x 32 room 39 cells deep under a stone roof, inside 3 x 2 x 3 chunks with a stone floor.
const make = () => {
  const blocks = new BlockTypes();
  blocks.define('stone');
  const world = new VoxelWorld({ blocks }),
    edits = [];
  for (let cy = 0; cy < 2; cy++)
    for (let cz = -1; cz < 2; cz++) for (let cx = -1; cx < 2; cx++) world.addChunk(cx, cy, cz);
  for (let z = -32; z < 64; z++) for (let x = -32; x < 64; x++) edits.push(x, 0, z, 1);
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) edits.push(x, 40, z, 1);
  for (let y = 1; y < 40; y++)
    for (let i = 0; i < 32; i++) edits.push(i, y, -1, 1, i, y, 32, 1, -1, y, i, 1, 32, y, i, 1);
  world.setBlocks(edits);
  return world;
};
const roof = (world, state) => {
  const edits = [];
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) edits.push(x, 40, z, state);
  world.setBlocks(edits);
};

speedTest('a roof removed and put back: page milliseconds with VoxelLighting and with VoxelLightWorker', async () => {
  const a = make(),
    page = VoxelLighting.attach(a, { budget: Infinity }),
    b = make(),
    worker = VoxelLightWorker.attach(b);
  page.update();
  await worker.settled();
  worker.update();
  for (const [label, state] of [
    ['roof removed', 0],
    ['roof put back', 1],
  ]) {
    let t = performance.now();
    roof(a, state);
    const cells = page.update(),
      flood = performance.now() - t;
    t = performance.now();
    roof(b, state);
    worker.update();
    const posted = performance.now() - t;
    await worker.settled();
    t = performance.now();
    const chunks = worker.update(),
      written = performance.now() - t;
    console.log(
      `${label}: VoxelLighting ${flood.toFixed(2)} ms on the page for ${cells} cells; VoxelLightWorker ${posted.toFixed(2)} ms posting + ${written.toFixed(2)} ms writing ${chunks} chunks`,
    );
    assert.ok(posted + written < flood, 'the worker leaves the page less than the flood fill');
  }
  worker.dispose();
});
