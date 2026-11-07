import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer, createSnapshot } from '../dist/index.js';
import { FieldBuffer } from '../dist/fields.js';

const near = (actual, expected, tolerance = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} against ${expected}`);

test('scale and any other number blend in a line and hold past the newest snapshot', () => {
  const buffer = new FieldBuffer({ scale: { type: 'linear', size: 3 }, opacity: { type: 'linear' } });
  buffer.push(1, { scale: [1, 2, 3], opacity: 0 });
  buffer.push(2, { scale: [3, 2, 1], opacity: 1 });
  const middle = buffer.sample(1.25);
  assert.deepEqual([...middle.scale], [1.5, 2, 2.5]);
  assert.equal(middle.opacity, 0.25);
  assert.deepEqual([...buffer.sample(5).scale], [3, 2, 1]);
  assert.deepEqual([...buffer.sample(0).scale], [1, 2, 3]);
});

test('colour blends in linear light, and alpha straight', () => {
  const srgb = new FieldBuffer({ tint: { type: 'color', size: 4 } }),
    linear = new FieldBuffer({ tint: { type: 'color', space: 'linear' } });
  srgb.push(0, { tint: [1, 0, 0, 0] });
  srgb.push(1, { tint: [0, 0, 1, 1] });
  linear.push(0, { tint: [1, 0, 0] });
  linear.push(1, { tint: [0, 0, 1] });
  // Half of full red in light is 0.5 linear, which sRGB encodes as 0.7354 (IEC 61966-2-1).
  const middle = srgb.sample(0.5).tint;
  near(middle[0], 0.7353569830524495);
  near(middle[2], 0.7353569830524495);
  near(middle[3], 0.5);
  near(linear.sample(0.5).tint[0], 0.5);
  srgb.clear();
  srgb.push(0, { tint: [0.25, 0.5, 0.75, 1] });
  const held = srgb.sample(0).tint;
  [0.25, 0.5, 0.75, 1].forEach((value, i) => near(held[i], value));
});

test('animation time goes forward through a loop seam', () => {
  const buffer = new FieldBuffer({ clipTime: { type: 'time', period: 1 } });
  buffer.push(0, { clipTime: 0.9 });
  buffer.push(1, { clipTime: 0.1 });
  near(buffer.sample(0.25).clipTime, 0.95);
  near(buffer.sample(0.5).clipTime, 0);
  near(buffer.sample(0.75).clipTime, 0.05);
  buffer.clear();
  buffer.push(0, { clipTime: 0.1 });
  buffer.push(1, { clipTime: 0.9 });
  near(buffer.sample(0.5).clipTime, 0, 1e-12);
  near(buffer.sample(0.25).clipTime, 0.05);
});

test('animation time without a period is a plain line', () => {
  const buffer = new FieldBuffer({ clipTime: { type: 'time' } });
  buffer.push(0, { clipTime: 4 });
  buffer.push(1, { clipTime: 6 });
  near(buffer.sample(0.5).clipTime, 5);
});

test('animation time never blends across a change of clip', () => {
  const buffer = new FieldBuffer({ clip: { type: 'step' }, clipTime: { type: 'time', clip: 'clip' } });
  buffer.push(0, { clip: 1, clipTime: 2.5 });
  buffer.push(1, { clip: 2, clipTime: 0.1 });
  const before = buffer.sample(0.5);
  assert.equal(before.clip, 1);
  assert.equal(before.clipTime, 2.5);
  const after = buffer.sample(1);
  assert.equal(after.clip, 2);
  assert.equal(after.clipTime, 0.1);
});

test('past the newest snapshot, animation time runs on at its last rate, capped', () => {
  const buffer = new FieldBuffer({ clip: { type: 'step' }, clipTime: { type: 'time', period: 3, clip: 'clip' } });
  buffer.push(0, { clip: 1, clipTime: 1.5 });
  near(buffer.sample(0.1).clipTime, 1.5);
  buffer.push(1, { clip: 1, clipTime: 1.9 });
  near(buffer.sample(1.1).clipTime, 1.94);
  near(buffer.sample(1.25).clipTime, 2);
  near(buffer.sample(9).clipTime, 2);
  buffer.push(2, { clip: 2, clipTime: 0 });
  assert.equal(buffer.sample(2.1).clipTime, 0, 'one snapshot of a clip gives no rate');
});

test('steps change on the next snapshot\'s time and not before', () => {
  const buffer = new FieldBuffer({ flags: { type: 'step', size: 2 } });
  buffer.push(0, { flags: [1, 2] });
  buffer.push(1, { flags: [3, 4] });
  assert.deepEqual([...buffer.sample(0.999).flags], [1, 2]);
  assert.deepEqual([...buffer.sample(1).flags], [3, 4]);
});

test('the pose fields give exactly what SnapshotBuffer gives', () => {
  const fields = new FieldBuffer(
      {
        position: { type: 'hermite', velocity: 'velocity' },
        velocity: { type: 'linear', size: 3 },
        rotation: { type: 'quaternion' },
      },
      { capacity: 8, maxPrediction: 0.1 },
    ),
    pose = new SnapshotBuffer(8, 0.1),
    output = createSnapshot();
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32.5;
  for (let i = 0; i < 40; i++) {
    const position = [random(), random(), random()],
      velocity = [random(), random(), random()],
      rotation = [random(), random(), random(), random()];
    fields.push(i * 0.1, { position, velocity, rotation });
    pose.push(i * 0.1, position, rotation, velocity);
    for (let k = 0; k < 8; k++) {
      const time = i * 0.1 + random() * 0.9,
        got = fields.sample(time),
        want = pose.sample(time, output);
      assert.deepEqual([...got.position], [...want.position]);
      assert.deepEqual([...got.rotation], [...want.rotation]);
    }
  }
});

test('angles take the short way round', () => {
  const buffer = new FieldBuffer({ heading: { type: 'angle' } });
  buffer.push(0, { heading: 3 });
  buffer.push(1, { heading: -3 });
  near(buffer.sample(0.5).heading, 3 + (2 * Math.PI - 6) / 2);
});

test('a snapshot need only hold what changed', () => {
  const buffer = new FieldBuffer({ scale: { type: 'linear' }, rotation: { type: 'quaternion' } });
  assert.throws(() => buffer.push(0, { scale: 1 }), { name: 'TypeError', message: /first snapshot has no 'rotation'/ });
  assert.equal(buffer.push(0, { scale: 1, rotation: [0, 0, 0, 2] }), true);
  assert.equal(buffer.push(1, { scale: 3 }), true);
  const sample = buffer.sample(1);
  assert.equal(sample.scale, 3);
  assert.deepEqual([...sample.rotation], [0, 0, 0, 1]);
});

test('order, the ring and clear behave as SnapshotBuffer does', () => {
  const buffer = new FieldBuffer({ value: { type: 'linear' } }, { capacity: 3 });
  assert.equal(buffer.sample(0), null);
  for (let i = 0; i < 5; i++) assert.equal(buffer.push(i, { value: i * 10 }), true);
  assert.equal(buffer.push(4, { value: 99 }), false);
  assert.equal(buffer.push(1, { value: 99 }), false);
  assert.equal(buffer.sample(9).value, 40);
  assert.equal(buffer.sample(0).value, 20, 'the first two left the ring');
  assert.equal(buffer.sample(3.5).value, 35);
  buffer.clear();
  assert.equal(buffer.sample(1), null);
});

test('an output of your own survives the next sample', () => {
  const buffer = new FieldBuffer({ size: { type: 'linear', size: 2 } }),
    mine = buffer.create();
  buffer.push(0, { size: [1, 1] });
  buffer.push(1, { size: [3, 3] });
  assert.equal(buffer.sample(0.5, mine), mine);
  buffer.sample(1);
  assert.deepEqual([...mine.size], [2, 2]);
  assert.throws(() => buffer.sample(0, {}), { name: 'TypeError', message: /create\(\)/ });
});

test('fields, options and values are checked', () => {
  for (const fields of [
    { a: { type: 'wobble' } },
    { a: { type: 'linear', size: 0 } },
    { a: { type: 'linear', size: 65 } },
    { a: { type: 'color', size: 2 } },
    { a: { type: 'time', period: -1 } },
    { a: { type: 'hermite', velocity: 'none' } },
    { a: { type: 'hermite', velocity: 'v' }, v: { type: 'linear', size: 2 } },
    { a: { type: 'time', clip: 'none' } },
    { a: { type: 'time', clip: 'c' }, c: { type: 'linear' } },
    { a: null },
  ])
    assert.throws(() => new FieldBuffer(fields), TypeError, JSON.stringify(fields));
  assert.throws(() => new FieldBuffer({}, { capacity: 1 }), RangeError);
  assert.throws(() => new FieldBuffer({}, { maxPrediction: 11 }), RangeError);
  const buffer = new FieldBuffer({ s: { type: 'linear' }, v: { type: 'linear', size: 2 }, q: { type: 'quaternion' } });
  const good = { s: 1, v: [1, 2], q: [0, 0, 0, 1] };
  assert.throws(() => buffer.push(Number.NaN, good), RangeError);
  assert.throws(() => buffer.push(0, { ...good, s: [1] }), TypeError);
  assert.throws(() => buffer.push(0, { ...good, v: 1 }), TypeError);
  assert.throws(() => buffer.push(0, { ...good, v: [1] }), TypeError);
  assert.throws(() => buffer.push(0, { ...good, s: Number.NaN }), RangeError);
  assert.throws(() => buffer.push(0, { ...good, q: [0, 0, 0, 0] }), { message: /zero length/ });
  assert.throws(() => buffer.sample(Number.POSITIVE_INFINITY), RangeError);
});
