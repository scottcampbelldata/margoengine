// Light throughput, printed and not asserted (timings vary by machine). Single thread, well under a second.
import test from 'node:test';
import { BlockTypes, VoxelChunk, VoxelWorld } from '../dist/index.js';
import { VoxelLighting } from '../dist/light.js';

const settle = (lighting) => {
  let cells = 0;
  for (let n; (n = lighting.update()); ) cells += n;
  return cells;
};
const rate = (cells, ms) => `${Math.round(cells / ms)} cells/ms (${cells} cells, ${ms.toFixed(2)} ms)`;

test('benchmark: torch in open air and a 32-wide roof removal (printed)', (t) => {
  const blocks = new BlockTypes(),
    stone = blocks.define('stone'),
    torch = blocks.define('torch', { shape: 'cross', layer: 'cutout', solid: false, light: 14 }),
    world = new VoxelWorld({ blocks }),
    lighting = VoxelLighting.attach(world, { budget: Infinity });
  for (let cx = -1; cx <= 1; cx++)
    for (let cz = -1; cz <= 1; cz++) {
      world.addChunk(cx, 0, cz, new VoxelChunk(stone));
      world.addChunk(cx, 1, cz);
      world.addChunk(cx, 2, cz);
    }
  let start = performance.now();
  const load = settle(lighting),
    loadMs = performance.now() - start;
  // A torch placed and removed in open air, 40 times.
  let cells = 0;
  start = performance.now();
  for (let n = 0; n < 40; n++) {
    world.setBlock(16, 48, 16, torch);
    cells += settle(lighting);
    world.setBlock(16, 48, 16, 0);
    cells += settle(lighting);
  }
  const torchMs = performance.now() - start;
  // A 32 x 30 x 32 room inside chunk (0, 0, 0), its stone roof at y 31; then the roof goes and comes back.
  const room = [],
    roof = [];
  for (let x = 0; x < 32; x++)
    for (let z = 0; z < 32; z++) {
      for (let y = 1; y < 31; y++) room.push(x, y, z, 0);
      roof.push(x, 31, z, 0);
    }
  world.setBlocks(room);
  settle(lighting);
  start = performance.now();
  world.setBlocks(roof);
  const open = settle(lighting),
    openMs = performance.now() - start;
  for (let i = 3; i < roof.length; i += 4) roof[i] = stone;
  start = performance.now();
  world.setBlocks(roof);
  const close = settle(lighting),
    closeMs = performance.now() - start;
  t.diagnostic(`load 27 chunks (9 stone, 18 open sky): ${loadMs.toFixed(2)} ms, ${load} budget cells`);
  t.diagnostic(`torch in open air, place + remove x40: ${rate(cells, torchMs)}`);
  t.diagnostic(`32-wide roof removed: ${rate(open, openMs)}; put back: ${rate(close, closeMs)}`);
});
