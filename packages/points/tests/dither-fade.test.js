import assert from 'node:assert/strict';
import test from 'node:test';
import { PointsMaterial } from '../dist/index.js';
test('point materials validate optional live screen-door intervals without changing opacity or depth', () => {
  const m = new PointsMaterial({ ditherFade: [0.25, 0.75] });
  assert.deepEqual(m.ditherFade, [0.25, 0.75]);
  assert.equal(m.opacity, 1);
  assert.equal(m.writesDepth, true);
  m.ditherFade = [0, 0];
  m.validate();
  for (const range of [[-0.1, 1], [0, 1.1], [1, 0.5], [NaN, 1], [0]]) {
    m.ditherFade = range;
    assert.throws(() => m.validate(), /coverage interval/);
  }
});
