import test from 'node:test';
import assert from 'node:assert/strict';
import { Tween, easeInOutCubic } from '../dist/index.js';

test('opposite finite extreme endpoints interpolate and complete exactly', () => {
  for (const duration of [0, 1]) {
    const tween = new Tween(),
      target = { x: 1e308 };
    let completed = 0;
    tween.to(target, 'x', -1e308, {
      duration,
      onComplete() {
        completed++;
        assert.equal(target.x, -1e308);
      },
    });
    if (duration) {
      tween.update(0);
      assert.equal(target.x, 1e308);
      tween.update(0.25);
      assert.equal(target.x, 5e307);
      tween.update(0.25);
      assert.equal(target.x, 0);
    }
    tween.update(duration ? 0.5 : 0);
    assert.equal(target.x, -1e308);
    assert.equal(completed, 1);
    tween.update(1);
    assert.equal(completed, 1);
  }
});
test('delay, easing, overwrite, cancellation and completion produce bounded numeric properties', () => {
  const timeline = new Tween(),
    target = { x: 0 };
  let completed = 0;
  timeline.to(target, 'x', 10, { duration: 1, delay: 0.5, easing: easeInOutCubic, onComplete: () => completed++ });
  timeline.update(0.25);
  assert.equal(target.x, 0);
  timeline.update(0.75);
  assert.equal(target.x, 5);
  timeline.update(10);
  assert.equal(target.x, 10);
  timeline.update(10);
  assert.equal(completed, 1);
  timeline.to(target, 'x', 20, { duration: 1 });
  const cancel = timeline.to(target, 'x', 30, { duration: 1 });
  timeline.update(0.5);
  assert.equal(target.x, 20);
  cancel();
  timeline.update(1);
  assert.equal(target.x, 20);
  assert.throws(() => timeline.to(target, 'missing', 1, { duration: 1 }), /Invalid/);
  assert.throws(() => timeline.update(-1), /Invalid/);
});
test('callbacks may add and clear tracks without skipping or recursively evaluating them', () => {
  const timeline = new Tween(),
    target = { x: 0, y: 0 };
  timeline.to(target, 'x', 1, {
    duration: 0,
    onComplete() {
      timeline.to(target, 'y', 2, { duration: 1 });
    },
  });
  timeline.update(1);
  assert.equal(target.y, 0);
  timeline.update(0.5);
  assert.equal(target.y, 1);
  timeline.to(target, 'x', 3, {
    duration: 0,
    onComplete() {
      timeline.clear();
    },
  });
  timeline.update(0);
  timeline.update(1);
  assert.equal(target.y, 1);
});
