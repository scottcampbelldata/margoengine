import test from 'node:test';
import assert from 'node:assert/strict';
import { lensField, lensSettings } from '../dist/lens.js';
import { lensFieldF32 } from './lens-f32.js';

const rows = () => {
  const out = [];
  for (let k = 0; k < 2400; k++)
    out.push([Math.fround((k * 0.0173) % 1.7), Math.fround((k * 0.0319) % 1), [1000000, 123456.75, 86400.5][k % 3]]);
  return out;
};
const worst = (settings) => {
  let w = 0;
  for (const [x, y, t] of rows()) {
    const s = settings(t),
      got = lensFieldF32(x, y, s.subarray(0, 4), s.subarray(4, 8)),
      want = lensField(x, y, t, { wetness: 1 });
    for (let j = 0; j < 3; j++) w = Math.max(w, Math.abs(got[j] - want[j]));
  }
  return w;
};

// Regression (KB0362): the f32 reference the GPU parity case now compares with. It follows lensField at short times,
// and at long times the packed settings keep it near the f64 field where the raw time * speed product does not, so a
// broken packing still fails the parity case through this model.
test('the f32 lens reference follows the f64 field and needs the long-time packing', () => {
  for (const [x, y] of [
    [0.3, 0.4],
    [1.1293, 0.9679],
  ]) {
    const s = lensSettings({ wetness: 1 }, 2.5),
      got = lensFieldF32(x, y, s.subarray(0, 4), s.subarray(4, 8)),
      want = lensField(x, y, 2.5, { wetness: 1 });
    for (let j = 0; j < 3; j++) assert.ok(Math.abs(got[j] - want[j]) < 1e-4, `${x}, ${y}: ${got} vs ${want}`);
  }
  const packed = worst((t) => lensSettings({ wetness: 1 }, t));
  const raw = worst((t) => {
    const s = lensSettings({ wetness: 1 }, 0);
    s[1] = Math.fround(t * 0.08);
    return s;
  });
  assert.ok(packed < 1e-4 && raw > 100 * packed, `packed ${packed}, raw ${raw}`);
});
