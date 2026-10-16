import test from 'node:test';
import assert from 'node:assert/strict';
import { TargetMotion } from '../examples/skinning-ik/target-motion.ts';
import { mapArmControl } from '../examples/skinning-ik/arm-controls.ts';

const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));

test('target command reuses its buffer and settles the full one-metre Side span within a second', () => {
  const start = mapArmControl('side', 0),
    end = mapArmControl('side', 1),
    motion = new TargetMotion(start),
    buffer = motion.position;
  let elapsed = 0;
  while (!motion.settled || elapsed === 0) {
    const before = [...motion.position];
    assert.strictEqual(motion.update(end, 1 / 60), buffer);
    assert.ok(distance(before, motion.position) <= motion.maxSpeed / 60 + 1e-12);
    for (let axis = 0; axis < 3; axis++)
      assert.ok(
        motion.position[axis] >= Math.min(start[axis], end[axis]) &&
          motion.position[axis] <= Math.max(start[axis], end[axis]),
      );
    elapsed += 1 / 60;
    assert.ok(elapsed <= 1.05, `Filter takes too long to settle (${elapsed}s)`);
  }
  assert.deepEqual(motion.position, end);
});

test('variable dt and rapid direction changes remain speed bounded without overshooting or coasting away', () => {
  const motion = new TargetMotion([0, 0, 0]),
    steps = [1 / 144, 1 / 60, 1 / 30, 0.05, 1e-12];
  for (let frame = 0; frame < 400; frame++) {
    const goal = frame % 20 < 10 ? [0.6, 0.3, -0.4] : [-0.5, -0.2, 0.35],
      dt = steps[frame % steps.length],
      before = [...motion.position];
    motion.update(goal, dt);
    assert.ok(distance(before, motion.position) <= motion.maxSpeed * dt + 2e-12);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(motion.position[axis] >= Math.min(before[axis], goal[axis]) - 1e-14);
      assert.ok(motion.position[axis] <= Math.max(before[axis], goal[axis]) + 1e-14);
    }
  }
});

test('unlimited critical response is invariant to subdividing a constant-target timestep', () => {
  const a = new TargetMotion([0, 0, 0], { maxSpeed: 100 }),
    b = new TargetMotion([0, 0, 0], { maxSpeed: 100 }),
    target = [0.2, 0.1, -0.15];
  a.update(target, 0.1);
  for (let i = 0; i < 10; i++) b.update(target, 0.01);
  assert.ok(distance(a.position, b.position) < 1e-14);
});

test('zero-delta reflection calls hold both position and velocity history; reset discards motion', () => {
  const a = new TargetMotion([0, 0, 0]),
    b = new TargetMotion([0, 0, 0]),
    target = [0.7, 0.1, -0.3];
  a.update(target, 1 / 60);
  b.update(target, 1 / 60);
  const before = [...a.position];
  for (let i = 0; i < 120; i++) assert.strictEqual(a.update([-1, 2, 1], 0), a.position);
  assert.deepEqual(a.position, before);
  a.update(target, 1 / 60);
  b.update(target, 1 / 60);
  assert.deepEqual(a.position, b.position);
  a.reset([0.2, -0.1, 0.3]);
  assert.equal(a.settled, true);
  assert.deepEqual(a.position, [0.2, -0.1, 0.3]);
  a.update(a.position, 1 / 60);
  assert.equal(a.settled, true);
});

test('finite input guards reject before state changes and tiny-step snap cannot bypass the speed cap', () => {
  const motion = new TargetMotion([0, 0, 0]);
  for (const point of [
    [NaN, 0, 0],
    [0, Infinity, 0],
    ['1', 0, 0],
    [0, 0],
    [1e40, 0, 0],
  ]) {
    assert.throws(() => motion.update(point, 1 / 60));
    assert.throws(() => motion.reset(point));
    assert.deepEqual(motion.position, [0, 0, 0]);
  }
  for (const dt of [-1, Infinity, NaN]) assert.throws(() => motion.update([1, 0, 0], dt));
  for (const options of [{ maxSpeed: 0 }, { maxSpeed: Infinity }, { response: 0 }, { response: Infinity }]) {
    assert.throws(() => new TargetMotion([0, 0, 0], options));
  }
  motion.update([1e-6, 0, 0], 1e-12);
  assert.ok(distance(motion.position, [0, 0, 0]) <= 1.8e-12);
  motion.update([1, 2, 3], 1e300);
  assert.deepEqual(motion.position, [1, 2, 3]);
});
