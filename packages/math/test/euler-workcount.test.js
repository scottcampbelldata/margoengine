// Batch 162 row 1.9: Quaternion.setFromEuler reads each angle once and shares pair products. Outputs are compared
// bit for bit with the parent formula, written out here as the reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from '../dist/index.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const bits = (values) => [...new Uint8Array(Float64Array.from(values).buffer)];
const orders = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];

// The parent setFromEuler, unchanged.
function parentEuler(x, y, z, order) {
  const sx = Math.sin(x / 2), cx = Math.cos(x / 2), sy = Math.sin(y / 2), cy = Math.cos(y / 2), sz = Math.sin(z / 2), cz = Math.cos(z / 2);
  const a = sx * cy * cz, b = cx * sy * sz, c = cx * sy * cz, d = sx * cy * sz, e = cx * cy * sz, f = sx * sy * cz, g = cx * cy * cz, h = sx * sy * sz;
  return {
    XYZ: [a + b, c - d, e + f, g - h], YXZ: [a + b, c - d, e - f, g + h], ZXY: [a - b, c + d, e + f, g - h],
    ZYX: [a - b, c + d, e - f, g + h], YZX: [a + b, c + d, e - f, g - h], XZY: [a - b, c - d, e + f, g + h],
  }[order];
}

test('setFromEuler matches the parent bit for bit in all six orders', () => {
  const pick = random(162), angles = [0, -0, 1e-300, -1e-300, Math.PI, -Math.PI, 1e300, -1e300, Infinity, NaN, 2 ** -1074];
  for (let i = 0; i < 2000; i++) angles.push((pick() - 0.5) * 20);
  const q = new Quaternion();
  for (let i = 0; i < angles.length; i++)
    for (const order of orders) {
      const x = angles[i], y = angles[(i * 7 + 3) % angles.length], z = angles[(i * 13 + 5) % angles.length];
      q.setFromEuler({ x, y, z, order });
      assert.deepEqual(bits([q.x, q.y, q.z, q.w]), bits(parentEuler(x, y, z, order)), `${order} ${x} ${y} ${z}`);
    }
});

test('setFromEuler reads each angle once', () => {
  const reads = { x: 0, y: 0, z: 0, order: 0 };
  const euler = {};
  for (const [key, value] of Object.entries({ x: 0.3, y: -1.2, z: 2.5, order: 'ZXY' }))
    Object.defineProperty(euler, key, { get: () => (reads[key]++, value) });
  new Quaternion().setFromEuler(euler);
  // The parent read x, y and z twice each (once for sin, once for cos).
  assert.deepEqual(reads, { x: 1, y: 1, z: 1, order: 1 });
});
