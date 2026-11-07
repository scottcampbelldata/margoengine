import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer } from '../dist/index.js';
import { TimeRing, Timeline, blendAngle, normalizeQuaternion, slerpInto } from '../dist/timeline.js';

test('a ring keeps order, wraps and finds the entries around a moment', () => {
  const ring = new TimeRing(3);
  assert.equal(ring.locate(1), false);
  assert.equal(ring.find(1), -1);
  assert.equal(Number.isNaN(ring.newest), true);
  assert.deepEqual([ring.first, ring.last, ring.previous], [-1, -1, -1]);
  for (const time of [1, 2, 4, 8]) assert.notEqual(ring.push(time), -1);
  assert.equal(ring.push(8), -1);
  assert.equal(ring.push(3), -1);
  assert.deepEqual([ring.oldest, ring.newest, ring.count], [2, 8, 3]);
  assert.equal(ring.find(1), -1);
  assert.equal(ring.times[ring.find(4)], 4);
  ring.locate(3);
  assert.deepEqual([ring.times[ring.a], ring.times[ring.b], ring.u, ring.past], [2, 4, 0.5, 0]);
  ring.locate(4);
  assert.equal(ring.a, ring.b);
  assert.deepEqual([ring.times[ring.a], ring.u, ring.past], [4, 0, 0]);
  ring.locate(0);
  assert.deepEqual([ring.times[ring.a], ring.times[ring.b], ring.past], [2, 2, 0]);
  ring.locate(11);
  assert.deepEqual([ring.times[ring.a], ring.times[ring.b], ring.past], [8, 8, 3]);
  assert.equal(ring.times[ring.previous], 4);
  ring.dropThrough(4);
  assert.deepEqual([ring.count, ring.oldest], [1, 8]);
  ring.clear();
  assert.equal(ring.count, 0);
});

test('a ring can keep its times inside your rows', () => {
  const rows = new Float64Array(9),
    ring = new TimeRing(3, rows, 3);
  assert.equal(ring.push(5), 0);
  assert.equal(ring.push(6), 1);
  assert.equal(rows[3], 6);
  ring.locate(5.5);
  assert.deepEqual([ring.a, ring.b, ring.u], [0, 1, 0.5]);
});

test('a timeline holds values, replaces them and lets go of what it drops', () => {
  const line = new Timeline(3),
    one = { id: 1 };
  assert.equal(line.latest, undefined);
  assert.equal(line.add(10, one), true);
  assert.equal(line.add(10, { id: 9 }), false);
  assert.equal(line.get(10), one);
  assert.equal(line.get(11), undefined);
  assert.equal(line.replace(11, {}), false);
  const two = { id: 2 };
  assert.equal(line.replace(10, two), true);
  line.add(20, { id: 3 });
  assert.equal(line.latest.id, 3);
  assert.equal(line.locate(15), true);
  assert.deepEqual([line.from.id, line.to.id, line.u], [2, 3, 0.5]);
  line.dropThrough(10);
  assert.equal(line.get(10), undefined);
  line.clear();
  assert.equal(line.latest, undefined);
});

test('the ring refuses a bad size', () => {
  for (const args of [[1], [65537], [2.5], [4, new Float64Array(2)], [4, new Float64Array(8), 0], [4, new Float64Array(8), 3]])
    assert.throws(() => new TimeRing(...args), RangeError, String(args));
  assert.throws(() => new Timeline(1), RangeError);
});

test('the blends are the ones SnapshotBuffer draws with', () => {
  assert.ok(Math.abs(blendAngle(3, -3, 0.5) - (3 + (2 * Math.PI - 6) / 2)) < 1e-12);
  assert.equal(blendAngle(1, 2, 0.5), 1.5);
  const data = new Float64Array(8),
    out = new Float64Array(4);
  normalizeQuaternion([0, 0, 0, 2], data, 0);
  normalizeQuaternion([0, 0, 1e308, -1e308], data, 4);
  slerpInto(out, 0, data, 0, 4, 0.25);
  const buffer = new SnapshotBuffer();
  buffer.push(0, [0, 0, 0], [0, 0, 0, 2]);
  buffer.push(1, [0, 0, 0], [0, 0, 1e308, -1e308]);
  assert.deepEqual([...buffer.sample(0.25).rotation], [...out]);
  assert.throws(() => normalizeQuaternion([0, 0, 0, 0], data, 0), { message: /zero length/ });
});

test('SnapshotBuffer stores its time in the row, on the shared ring', () => {
  const buffer = new SnapshotBuffer(2);
  buffer.push(1, [1, 0, 0]);
  buffer.push(2, [2, 0, 0]);
  buffer.push(3, [3, 0, 0]);
  assert.deepEqual([buffer.samples[0], buffer.samples[11]], [3, 2]);
  assert.equal(buffer.sample(0).position[0], 2);
});
