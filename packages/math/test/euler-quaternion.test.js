import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Quaternion } from '../dist/index.js';

// The definition: intrinsic order abc is qa * qb * qc of half-angle axis quaternions (core's convention).
function reference(x, y, z, order) {
  let q = [0, 0, 0, 1];
  for (const axis of order) {
    const angle = axis === 'X' ? x : axis === 'Y' ? y : z,
      s = Math.sin(angle / 2),
      r = [axis === 'X' ? s : 0, axis === 'Y' ? s : 0, axis === 'Z' ? s : 0, Math.cos(angle / 2)];
    q = [
      q[3] * r[0] + q[0] * r[3] + q[1] * r[2] - q[2] * r[1],
      q[3] * r[1] - q[0] * r[2] + q[1] * r[3] + q[2] * r[0],
      q[3] * r[2] + q[0] * r[1] - q[1] * r[0] + q[2] * r[3],
      q[3] * r[3] - q[0] * r[0] - q[1] * r[1] - q[2] * r[2],
    ];
  }
  return q;
}

test('setFromEuler is the per-axis quaternion product in every order', () => {
  let seed = 7;
  const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 4 * Math.PI;
  const q = new Quaternion();
  for (const order of ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'])
    for (let i = 0; i < 500; i++) {
      const [x, y, z] = [next(), next(), next()],
        want = reference(x, y, z, order);
      q.setFromEuler(new Euler(x, y, z, order));
      for (let k = 0; k < 4; k++) assert.ok(Math.abs([q.x, q.y, q.z, q.w][k] - want[k]) < 1e-12, `${order} ${k}`);
    }
  assert.throws(() => q.setFromEuler({ x: 0, y: 0, z: 0, order: 'xyz' }), /Euler order/);
});
