import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleTrack, sampleTrackInto } from '../packages/animation/dist/index.js';

test('reused animation sample buffers match fresh samples for every interpolation', () => {
  const times = new Float32Array([0, 1, 2]);
  for (const [interpolation, width, quaternion] of [
    ['STEP', 3, false],
    ['LINEAR', 3, false],
    ['LINEAR', 4, true],
    ['CUBICSPLINE', 3, false],
    ['CUBICSPLINE', 4, true],
  ]) {
    const values = Float32Array.from(
      { length: 3 * width * (interpolation === 'CUBICSPLINE' ? 3 : 1) },
      (_, i) => Math.sin(i * 1.7) + 0.2,
    );
    const out = new Float32Array(width);
    for (const time of [-1, 0, 0.3, 1, 1.75, 2, 9]) {
      const fresh = sampleTrack(times, values, width, time, interpolation, quaternion);
      assert.equal(sampleTrackInto(times, values, width, time, interpolation, quaternion, out), out);
      assert.deepEqual(out, fresh, `${interpolation} width ${width} at ${time}`);
      assert.notEqual(fresh, out);
    }
  }
  assert.throws(
    () => sampleTrackInto(times, new Float32Array(9), 3, Infinity, 'LINEAR', false, new Float32Array(3)),
    TypeError,
  );
});
