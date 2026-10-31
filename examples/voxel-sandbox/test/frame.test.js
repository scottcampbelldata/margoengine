import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkLine, frameSeconds } from '../src/frame.ts';

test('a slow frame steps its whole time, so walking speed does not fall with the frame rate', () => {
  assert.equal(frameSeconds(1000, 0), 0, 'the first frame steps nothing');
  assert.equal(frameSeconds(1016, 1000), 0.016);
  // 8 FPS: a step of 0.1 s here lost 18 percent of the speed (measured: fly 11 blocks/s fell to 9).
  assert.equal(frameSeconds(1125, 1000), 0.125);
  assert.equal(frameSeconds(1240, 1000), 0.24);
  assert.equal(frameSeconds(9000, 1000), 0.25, 'the most the body simulates in one update');
});

test('the HUD does not call the chunks held on the GPU drawn', () => {
  const line = chunkLine({ chunks: 805, visible: 9 }, 1379, 'all received');
  assert.equal(line, 'chunks 805 meshed, 9 visible, 1379 loaded, all received');
  assert.doesNotMatch(line, /drawn/);
});
