import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelWorld } from '@margoengine/voxel';
import { defineBlocks } from '../src/blocks.ts';
import { buildShapes, buildShowcase, groundY, showcaseReady } from '../src/showcase.ts';

// The deterministic views build at (-27, 16): one chunk column (-1, 0). Stone up to y 7, as seed 1 has there.
function world(cys) {
  const { blocks } = defineBlocks(),
    w = new VoxelWorld({ blocks }),
    stone = blocks.id('stone'),
    edits = [];
  for (const cy of cys) w.addChunk(-1, cy, 0);
  for (let x = -32; x < 0; x++)
    for (let z = 0; z < 32; z++) for (let y = Math.max(-32, cys[0] * 32); y <= 7; y++) edits.push(x, y, z, stone);
  w.setBlocks(edits);
  return { w, blocks };
}

// Regression: showcaseReady checked only chunk rows -1..1, but groundY reads from y 96 (row 3) down to -64 (row -2).
// When rows 2 or 3 arrived late (worker order, CPU load), every groundY under the yard was undefined, the yard's base
// became -Infinity and buildShapes' brick-column loop (y = -Infinity; y <= base + 2; y++) pushed edits until
// "RangeError: Invalid array length" (the intermittent voxel-shapes-high visual check failure).
test('the showcase waits for every chunk groundY reads under its yard', () => {
  const partial = world([-1, 0, 1]);
  assert.equal(groundY(partial.w, -27, 16), undefined, 'row 2 and 3 are missing');
  assert.equal(showcaseReady(partial.w, -27, 16), false);
  const full = world([-2, -1, 0, 1, 2, 3]);
  assert.equal(groundY(full.w, -27, 16), 7);
  assert.equal(showcaseReady(full.w, -27, 16), true);
  buildShapes(full.w, full.blocks, -27, 16);
  // The brick column stands on the yard's base, one above the ground.
  for (let y = 8; y <= 10; y++) assert.equal(full.w.getBlock(-27, y, 23), full.blocks.id('bricks'));
});

test('a yard with no ground under it is a RangeError, not an endless build', () => {
  for (const build of [buildShapes, buildShowcase]) {
    const { w, blocks } = world([-1, 0, 1]);
    assert.throws(() => build(w, blocks, -27, 16), {
      name: 'RangeError',
      message: /No ground under the showcase yard/,
    });
  }
});
