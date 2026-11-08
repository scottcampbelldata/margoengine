// Default easing is linear: halfway through the duration the value is halfway to the target.
// The batch 167 tween bench checks the same rule on 10,000 tweens (0.016 of a 1 second tween).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tween } from '../dist/index.js';

test('a linear tween is halfway after half its duration', () => {
  const tween = new Tween();
  const object = { x: 0 };
  tween.to(object, 'x', 100, { duration: 1 });
  tween.update(0.5);
  assert.ok(Math.abs(object.x - 50) < 1e-9);
});
