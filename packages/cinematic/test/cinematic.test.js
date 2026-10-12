import test from 'node:test';
import assert from 'node:assert/strict';
import {Cinematic} from '../dist/index.js';
test('critical springs are frame-rate independent and shake leaves the settled follow position intact', () => {
  const a = new Cinematic({offset: [0, 2, 4]}), b = new Cinematic({offset: [0, 2, 4]}); a.update(0); b.update(0); a.follow([10, 0, 0]); b.follow([10, 0, 0]);
  a.update(1); for (let i = 0; i < 60; i++) b.update(1 / 60);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a.position[i] - b.position[i]) < 1e-10);
  assert.ok(a.position[0] > 9 && a.position[0] < 10); a.shake(1, 0.1); a.update(1); assert.ok(a.position.every(Number.isFinite));
  assert.throws(() => a.follow([NaN, 0, 0]), /finite/); assert.throws(() => a.shake(-1, 1), /Invalid/);
});
