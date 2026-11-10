import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inverseCurvilinearCell,
  curvilinearVolume,
  CurvilinearVolume,
  CurvilinearSection,
} from '../dist/curvilinear.js';
test('curvilinear entry exposes direct mapped volumes and owned coordinate sections', () => {
  assert.equal(typeof curvilinearVolume, 'function');
  assert.equal(typeof CurvilinearVolume.prototype.slice, 'function');
  assert.equal(typeof CurvilinearSection.prototype.dispose, 'function');
});
function point(x, y, z) {
  return [x + 0.3 * y * z, y + 0.2 * x * z, z + 0.15 * x * y];
}
const corners = Array.from({ length: 8 }, (_, k) => point(k & 1, (k >> 1) & 1, k >> 2)).flat();
test('inverse trilinear mapping recovers warped cell coordinates including corners and faces', () => {
  for (let i = 0; i <= 10; i++)
    for (let j = 0; j <= 10; j++)
      for (let k = 0; k <= 10; k++) {
        const q = [i / 10, j / 10, k / 10],
          p = point(...q),
          actual = inverseCurvilinearCell(corners, p);
        assert.ok(actual);
        actual.forEach((v, a) => assert.ok(Math.abs(v - q[a]) < 1e-8));
      }
});
test('inverse mapping rejects extrapolation and singular cells, with coded validation', () => {
  assert.equal(inverseCurvilinearCell(corners, [2, 2, 2]), null);
  assert.equal(inverseCurvilinearCell(new Float32Array(24), [0, 0, 0]), null);
  assert.throws(
    () => inverseCurvilinearCell([1], [0, 0, 0]),
    (e) => e instanceof RangeError && e.message.includes('https://margoengine.com/errors#sciviz'),
  );
});
test('inverse mapping is invariant to physical translation, scale and reversed orientation', () => {
  for (const scale of [1e-6, 1, 1e6]) {
    const c = corners.map((v, i) => v * scale * (i % 3 === 0 ? -1 : 1) + 3 * scale);
    const p = point(0.23, 0.47, 0.81).map((v, i) => v * scale * (i === 0 ? -1 : 1) + 3 * scale);
    const q = inverseCurvilinearCell(c, p);
    assert.ok(q);
    q.forEach((v, a) => assert.ok(Math.abs(v - [0.23, 0.47, 0.81][a]) < 1e-8));
  }
});
