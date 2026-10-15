import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer, createSnapshot } from '../dist/index.js';

test('snapshot rotations copy the identity without sharing mutable storage', () => {
  const a = createSnapshot(),
    b = createSnapshot();
  a.rotation[3] = 0;
  assert.deepEqual([...b.rotation], [0, 0, 0, 1]);
  assert.deepEqual([...createSnapshot().rotation], [0, 0, 0, 1]);
  const buffer = new SnapshotBuffer();
  buffer.push(0, [0, 0, 0]);
  assert.deepEqual([...buffer.sample(0).rotation], [0, 0, 0, 1]);
});

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
  const quaternion = [0.1234, -2.4567, 3.1234, 0.91],
    length = Math.hypot(...quaternion);
  const buffer = new SnapshotBuffer();
  buffer.push(0, [0, 0, 0], quaternion);
  assert.deepEqual(
    [...buffer.sample(0).rotation],
    quaternion.map((value) => value / length),
  );
});
test('Hermite positions, shortest-path slerp, packet ordering and bounded dead reckoning', () => {
  const buffer = new SnapshotBuffer(3, 0.25),
    output = createSnapshot();
  assert.equal(buffer.sample(0), null);
  buffer.push(0, [0, 0, 0], [0, 0, 0, 1], [2, 0, 0]);
  buffer.push(1, [2, 0, 0], [0, 1, 0, 0], [2, 0, 0]);
  assert.equal(buffer.push(0.5, [99, 0, 0]), false);
  assert.equal(buffer.sample(0.5, output), output);
  assert.equal(output.position[0], 1);
  assert.ok(Math.abs(output.rotation[1] - Math.SQRT1_2) < 1e-8);
  assert.equal(buffer.sample(100, output).position[0], 2.5);
  assert.equal(buffer.sample(-10, output).position[0], 0);
  buffer.push(2, [4, 0, 0]);
  buffer.push(3, [6, 0, 0]);
  assert.equal(buffer.sample(-1, output).position[0], 2);
  assert.throws(() => buffer.push(4, [NaN, 0, 0]), /finite/);
  buffer.clear();
  assert.equal(buffer.sample(1), null);
});
test('antipodal quaternions do not rotate or lose unit length', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(0, [0, 0, 0], [0, 0, 0, 1]);
  buffer.push(1, [0, 0, 0], [0, 0, 0, -1]);
  assert.deepEqual([...buffer.sample(0.5).rotation], [0, 0, 0, 1]);
});

test('wrapped timestamp search preserves linear-search Hermite and quaternion results exactly', () => {
  function reference(samples, time, output, prediction) {
    let a = samples[0],
      b = a;
    for (let i = 1; i < samples.length; i++) {
      b = samples[i];
      if (b[0] >= time) break;
      a = b;
    }
    if (time <= samples[0][0]) a = b = samples[0];
    if (a === b || time >= b[0]) {
      const delta = Math.min(prediction, Math.max(0, time - b[0]));
      for (let i = 0; i < 3; i++) {
        output.position[i] = b[1 + i] + b[8 + i] * delta;
        output.velocity[i] = b[8 + i];
      }
      for (let i = 0; i < 4; i++) output.rotation[i] = b[4 + i];
      return output;
    }
    const span = b[0] - a[0],
      u = Math.max(0, Math.min(1, (time - a[0]) / span)),
      u2 = u * u,
      u3 = u2 * u;
    for (let i = 0; i < 3; i++) {
      output.position[i] =
        (2 * u3 - 3 * u2 + 1) * a[1 + i] +
        (u3 - 2 * u2 + u) * span * a[8 + i] +
        (-2 * u3 + 3 * u2) * b[1 + i] +
        (u3 - u2) * span * b[8 + i];
      output.velocity[i] = (1 - u) * a[8 + i] + u * b[8 + i];
    }
    let dot = 0;
    for (let i = 0; i < 4; i++) dot += a[4 + i] * b[4 + i];
    const sign = dot < 0 ? -1 : 1;
    dot = Math.min(1, Math.abs(dot));
    const angle = Math.acos(dot),
      sine = Math.sin(angle),
      p = dot > 0.9995 ? 1 - u : Math.sin((1 - u) * angle) / sine,
      q = dot > 0.9995 ? u : Math.sin(u * angle) / sine;
    let length = 0;
    for (let i = 0; i < 4; i++) {
      output.rotation[i] = p * a[4 + i] + q * sign * b[4 + i];
      length += output.rotation[i] ** 2;
    }
    length = Math.sqrt(length);
    for (let i = 0; i < 4; i++) output.rotation[i] /= length;
    return output;
  }
  for (const capacity of [2, 3, 7, 32, 257])
    for (const angleStep of [0.01, 1.3]) {
      const buffer = new SnapshotBuffer(capacity),
        samples = [],
        actual = createSnapshot(),
        expected = createSnapshot();
      assert.equal(buffer.sample(0, actual), null);
      for (let i = 0; i < capacity * 2 + 3; i++) {
        const time = i * 0.05 + i * i * 0.00001,
          angle = i * angleStep;
        const rotation = [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
          position = [Math.sin(i), i * 0.1, -i],
          velocity = [Math.cos(i), 0.1, -1];
        buffer.push(time, position, rotation, velocity);
        const length = Math.hypot(...rotation),
          sample = [time, ...position, ...rotation.map((value) => value / length), ...velocity];
        samples.push(sample);
        if (samples.length > capacity) samples.shift();
        for (const stamp of [-10, time, time + 0.013, time + 10, samples[0][0], samples[0][0] + 0.025, time - 0.071]) {
          assert.equal(buffer.sample(stamp, actual), actual);
          reference(samples, stamp, expected, buffer.maxPrediction);
          assert.deepEqual(actual, expected);
        }
      }
      buffer.clear();
      assert.equal(buffer.sample(0, actual), null);
    }
});
