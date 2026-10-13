import test from 'node:test';
import assert from 'node:assert/strict';
import {SnapshotBuffer, createSnapshot} from '../dist/index.js';

test('finite extreme quaternion components normalize without overflow or subnormal loss', () => {
  for (const magnitude of [1e308, Number.MIN_VALUE]) {
    const buffer = new SnapshotBuffer();
    assert.equal(buffer.push(0, [0, 0, 0], [magnitude, -magnitude, magnitude, -magnitude]), true);
    assert.deepEqual([...buffer.sample(0).rotation], [0.5, -0.5, 0.5, -0.5]);
    buffer.push(1, [0, 0, 0], [-magnitude, magnitude, -magnitude, magnitude]);
    assert.ok(Math.abs(Math.hypot(...buffer.sample(0.5).rotation) - 1) < 1e-15);
    assert.equal(buffer.push(0.5, [0, 0, 0], [magnitude, magnitude, magnitude, magnitude]), false);
    assert.throws(() => buffer.push(2, [0, 0, 0], [0, 0, 0, 0]), /Zero/);
  }
});

test('ordinary quaternion normalization retains its existing component values', () => {
  const quaternion = [0.1234, -2.4567, 3.1234, 0.91], length = Math.hypot(...quaternion);
  const buffer = new SnapshotBuffer(); buffer.push(0, [0, 0, 0], quaternion);
  assert.deepEqual([...buffer.sample(0).rotation], quaternion.map(value => value / length));
});
test('Hermite positions, shortest-path slerp, packet ordering and bounded dead reckoning', () => {
  const buffer = new SnapshotBuffer(3, 0.25), output = createSnapshot(); assert.equal(buffer.sample(0), null);
  buffer.push(0, [0, 0, 0], [0, 0, 0, 1], [2, 0, 0]); buffer.push(1, [2, 0, 0], [0, 1, 0, 0], [2, 0, 0]);
  assert.equal(buffer.push(0.5, [99, 0, 0]), false); assert.equal(buffer.sample(0.5, output), output); assert.equal(output.position[0], 1);
  assert.ok(Math.abs(output.rotation[1] - Math.SQRT1_2) < 1e-8); assert.equal(buffer.sample(100, output).position[0], 2.5);
  assert.equal(buffer.sample(-10, output).position[0], 0); buffer.push(2, [4, 0, 0]); buffer.push(3, [6, 0, 0]); assert.equal(buffer.sample(-1, output).position[0], 2);
  assert.throws(() => buffer.push(4, [NaN, 0, 0]), /finite/); buffer.clear(); assert.equal(buffer.sample(1), null);
});
test('antipodal quaternions do not rotate or lose unit length', () => {
  const buffer = new SnapshotBuffer(); buffer.push(0, [0, 0, 0], [0, 0, 0, 1]); buffer.push(1, [0, 0, 0], [0, 0, 0, -1]);
  assert.deepEqual([...buffer.sample(0.5).rotation], [0, 0, 0, 1]);
});
