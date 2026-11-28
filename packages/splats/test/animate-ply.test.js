// A per-frame PLY capture read into SplatSequence, without a GPU: every frame keeps the splats and their order, each
// splat's covariance is the one its scales and turn give, and the sequence takes the frames as they are read. The GPU
// check (test/gpu/check.mjs) plays these same files and compares the cloud and the picture; a real third-party sequence
// is played by scripts/test-real-sequence.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SplatSequence } from '../dist/animate.js';
import { Splats, parsePly } from '../dist/index.js';
import { FRAMES, LONG, SHORT, SPLATS, centre, plyFrame, turn } from './fixtures/ply-frames.js';

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} against ${b}`);

test('each frame of a PLY capture reads the same splats in order, turned as the file says', () => {
  for (let f = 0; f < FRAMES; f++) {
    const data = parsePly(plyFrame(f)),
      c = Math.cos(turn(f)),
      s = Math.sin(turn(f)),
      a = LONG * LONG,
      b = SHORT * SHORT;
    assert.equal(data.positions.length, SPLATS * 3);
    for (let i = 0; i < SPLATS; i++) {
      centre(i, f).forEach((x, k) => near(data.positions[i * 3 + k], x, `frame ${f} splat ${i} centre ${k}`));
      // R diag(a, b, b) R^T for a turn about z, stored xx, xy, xz, yy, yz, zz.
      [c * c * a + s * s * b, c * s * (a - b), 0, s * s * a + c * c * b, 0, b].forEach((x, k) =>
        near(data.covariances[i * 6 + k], x, `frame ${f} splat ${i} covariance ${k}`),
      );
      near(data.colors[i * 4 + 3], 1 / (1 + Math.exp(-2)), `frame ${f} splat ${i} opacity`);
    }
  }
});

test('SplatSequence plays the frames read from the files', () => {
  const frames = Array.from({ length: FRAMES }, (_, f) => parsePly(plyFrame(f))),
    sequence = new SplatSequence(Splats.reserve(SPLATS), frames, { fps: 10 });
  assert.equal(sequence.length, FRAMES);
  near(sequence.duration, 0.3, 'duration');
  const mid = sequence.sample(0.15);
  assert.deepEqual([mid.from, mid.to], [1, 2]);
  near(mid.mix, 0.5, 'mix');
  assert.throws(
    () => new SplatSequence(Splats.reserve(SPLATS + 1), frames),
    RangeError,
    'a cloud of another count is refused',
  );
  sequence.dispose();
});
