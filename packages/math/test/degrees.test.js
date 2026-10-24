// Degree Euler helpers agree with the Euler and Quaternion classes in every order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Quaternion, degreesToQuaternion, quaternionToDegrees } from '../dist/index.js';

const ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
const close = (a, b, eps = 1e-12) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

test('degreesToQuaternion matches Quaternion.setFromEuler in every order', () => {
  const degrees = [30, -45, 120],
    radians = degrees.map((d) => (d * Math.PI) / 180);
  for (const order of ORDERS) {
    const expected = new Quaternion().setFromEuler(new Euler(...radians, order)).toArray();
    assert.ok(close(degreesToQuaternion(degrees, order), expected), order);
  }
  assert.deepEqual(degreesToQuaternion([0, 0, 0]), [0, 0, 0, 1]);
});

test('quaternionToDegrees round-trips and normalizes', () => {
  for (const order of ORDERS) {
    const q = degreesToQuaternion([10, 20, 30], order);
    assert.ok(close(quaternionToDegrees(q, order), [10, 20, 30], 1e-9), order);
    assert.ok(
      close(
        quaternionToDegrees(
          q.map((v) => v * 3),
          order,
        ),
        [10, 20, 30],
        1e-9,
      ),
      order,
    );
  }
  // A gimbal singularity still gives angles for the same orientation.
  const q = degreesToQuaternion([10, 90, 30], 'XYZ'),
    back = degreesToQuaternion(quaternionToDegrees(q, 'XYZ'), 'XYZ'),
    dot = Math.abs(q.reduce((sum, v, i) => sum + v * back[i], 0));
  assert.ok(Math.abs(dot - 1) < 1e-9);
});

test('degree helpers refuse non-finite input', () => {
  assert.throws(() => degreesToQuaternion([0, Number.NaN, 0]), RangeError);
  assert.throws(() => quaternionToDegrees([0, 0, 0, 0]), RangeError);
});
