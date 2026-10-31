// Clip markers (crossing both ways, looping, seeking), key-removal compression and 16-bit quantisation, with exact numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyframeClip } from '../dist/index.js';
import {
  ClipMarkers,
  compressTrack,
  dequantizeTrack,
  quantizeTrack,
  sampleTrack,
  validateMarkers,
} from '../dist/sampling.js';

const names = (hits) => hits.map((m) => `${m.name}@${m.time}`);
const steps = [
  { time: 0.75, name: 'b' },
  { time: 0.25, name: 'a' },
  { time: 0, name: 'z' },
];

test('markers fire once on crossing, forward and backward; a marker landed on counts as passed', () => {
  const m = new ClipMarkers(steps, 1, false);
  assert.deepEqual(names(m.advance(0.25)), ['z@0', 'a@0.25']); // the start marker, and a marker landed on
  assert.deepEqual(names(m.advance(0.125)), []);
  assert.deepEqual(names(m.advance(0.375)), ['b@0.75']);
  assert.deepEqual(names(m.advance(-0.5)), ['b@0.75']); // 0.75 -> 0.25 leaves b; a is landed on and stays passed
  assert.deepEqual(names(m.advance(-0.25)), ['a@0.25']); // 0.25 -> 0 leaves a
  assert.deepEqual(names(m.advance(0.5)), ['a@0.25']); // z at 0 was not passed again
  assert.deepEqual(names(m.advance(5)), ['b@0.75']); // clamps at 1
  assert.equal(m.time, 1);
  assert.deepEqual(names(m.advance(1)), []);
});

test('looping repeats markers every lap, wraps time and reports every lap of a long step', () => {
  const m = new ClipMarkers(steps, 1);
  assert.deepEqual(names(m.advance(0.875)), ['z@0', 'a@0.25', 'b@0.75']);
  assert.deepEqual(names(m.advance(0.25)), ['z@0']); // 0.875 -> 1.125 crosses z at 1.0
  assert.equal(m.time, 0.125);
  assert.deepEqual(names(m.advance(2.5)), ['a@0.25', 'b@0.75', 'z@0', 'a@0.25', 'b@0.75', 'z@0', 'a@0.25']);
  assert.deepEqual(names(m.advance(-0.5)), ['a@0.25']); // 3.625 -> 3.125 leaves a at 3.25
  const back = new ClipMarkers(steps, 1);
  back.seek(2.5);
  assert.deepEqual(names(back.advance(-1.25)), ['a@0.25', 'z@0', 'b@0.75']); // 2.25, 2.0, 1.75
});

test('seek is silent unless asked, and fires the markers between the old and new position when asked', () => {
  const m = new ClipMarkers(steps, 1, false);
  assert.deepEqual(m.seek(0.9), []);
  assert.equal(m.time, 0.9);
  assert.deepEqual(names(m.seek(0.1, true)), ['b@0.75', 'a@0.25']);
  assert.deepEqual(names(m.seek(0.8, true)), ['a@0.25', 'b@0.75']);
  const out = [{ time: 9, name: 'old' }];
  assert.equal(m.seek(0, true, out), out);
  assert.deepEqual(names(out), ['b@0.75', 'a@0.25']);
});

test('markers are validated and kept sorted on the clip', () => {
  assert.deepEqual(names(validateMarkers(steps)), ['z@0', 'a@0.25', 'b@0.75']);
  assert.throws(() => validateMarkers([{ time: -1, name: 'x' }]), RangeError);
  assert.throws(() => validateMarkers([{ time: 1, name: '' }]), TypeError);
  assert.throws(() => new ClipMarkers([{ time: 2, name: 'x' }], 1), RangeError);
  assert.throws(() => new ClipMarkers([], 0), RangeError);
  assert.throws(() => new ClipMarkers([], 1).advance(Number.NaN), RangeError);
  const track = {
    target: 'a',
    path: 'translation',
    keys: [
      { time: 0, value: [0, 0, 0] },
      { time: 2, value: [1, 0, 0] },
    ],
  };
  const clip = createKeyframeClip({
    tracks: [track],
    markers: [
      { time: 1.5, name: 'hit', data: 7 },
      { time: 0.5, name: 'foot' },
    ],
  });
  assert.deepEqual(names(clip.markers), ['foot@0.5', 'hit@1.5']);
  assert.equal(clip.markers[1].data, 7);
  assert.deepEqual(createKeyframeClip({ tracks: [track] }).markers, []);
  assert.throws(() => createKeyframeClip({ tracks: [track], markers: [{ time: 2.5, name: 'late' }] }), RangeError);
  const player = new ClipMarkers(clip.markers, clip.duration);
  assert.deepEqual(names(player.advance(1)), ['foot@0.5']);
  assert.deepEqual(names(player.advance(1)), ['hit@1.5']);
});

// A 2 second walk cycle baked at 60 fps: a smooth bob (translation) and a swinging leg (rotation about x).
const frames = 121;
const times = Float32Array.from({ length: frames }, (_, i) => i / 60);
const bob = new Float32Array(frames * 3),
  swing = new Float32Array(frames * 4);
for (let i = 0; i < frames; i++) {
  const t = i / 60,
    angle = 0.6 * Math.sin(2 * Math.PI * t);
  bob.set([0.1 * Math.sin(4 * Math.PI * t), 1 + 0.05 * Math.cos(4 * Math.PI * t), t * 1.2], i * 3);
  swing.set([Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)], i * 4);
}
// Largest component difference between two tracks, sampled at every key time of the first.
const measure = (track, reduced, quaternion) => {
  let worst = 0;
  for (const t of track.times) {
    const a = sampleTrack(track.times, track.values, track.width, t, track.interpolation, quaternion);
    const b = sampleTrack(reduced.times, reduced.values, track.width, t, track.interpolation, quaternion);
    const sign = quaternion && a.reduce((s, v, c) => s + v * b[c], 0) < 0 ? -1 : 1;
    for (let c = 0; c < a.length; c++) worst = Math.max(worst, Math.abs(a[c] - sign * b[c]));
  }
  return worst;
};

test('compression keeps every original key time within the tolerance and shrinks a baked walk cycle', () => {
  const kept = {};
  for (const [name, values, width, quaternion] of [
    ['bob', bob, 3, false],
    ['swing', swing, 4, true],
  ]) {
    const track = { times, values, width, interpolation: 'LINEAR', quaternion };
    for (const tolerance of [0.0005, 0.002, 0.01]) {
      const small = compressTrack(track, tolerance);
      const measured = measure(track, small, quaternion);
      assert.ok(small.error <= tolerance, `${name} reported ${small.error} > ${tolerance}`);
      assert.ok(Math.abs(small.error - measured) < 1e-6, `${name} reported ${small.error}, measured ${measured}`);
      assert.ok(measured <= tolerance + 1e-6, `${name} measured ${measured} > ${tolerance}`);
      assert.equal(small.times[0], 0);
      assert.equal(small.times.at(-1), 2);
      assert.equal(small.values.length, small.times.length * width);
      kept[`${name}@${tolerance}`] = small.times.length;
    }
  }
  // Exact counts of 121 keys: a 2 Hz bob at 0.5 mm needs every frame; at 1 cm it needs 33.
  assert.deepEqual(kept, {
    'bob@0.0005': 121,
    'bob@0.002': 73,
    'bob@0.01': 33,
    'swing@0.0005': 110,
    'swing@0.002': 54,
    'swing@0.01': 27,
  });
});

test('compression edge cases: exact repeats, tolerance 0, step tracks, bad input', () => {
  const flat = {
    times: new Float32Array([0, 1, 2, 3]),
    values: new Float32Array([4, 4, 4, 4]),
    width: 1,
    interpolation: 'LINEAR',
  };
  assert.deepEqual([...compressTrack(flat, 0).times], [0, 3]);
  const ramp = { ...flat, values: new Float32Array([0, 1, 2, 3.5]) };
  assert.deepEqual([...compressTrack(ramp, 0).times], [0, 2, 3]); // the bend at 2 is the largest miss, then 1 is on the line
  const held = {
    times: new Float32Array([0, 1, 2, 3, 4]),
    values: new Float32Array([0, 0.001, 0, 1, 1.0004]),
    width: 1,
    interpolation: 'STEP',
  };
  const dropped = compressTrack(held, 0.002);
  assert.deepEqual([...dropped.times], [0, 3, 4]);
  assert.ok(Math.abs(dropped.error - 0.001) < 1e-7);
  const one = { ...flat, times: new Float32Array([5]), values: new Float32Array([1]) };
  assert.equal(compressTrack(one, 0.1).times.length, 1);
  assert.throws(() => compressTrack(flat, -1), RangeError);
  assert.throws(() => compressTrack({ ...flat, interpolation: 'CUBICSPLINE' }, 0.1), TypeError);
  assert.throws(() => compressTrack({ ...flat, values: new Float32Array(3) }, 0.1), RangeError);
});

test('16-bit quantisation stays within half a step and halves the value bytes', () => {
  for (const [values, width, quaternion] of [
    [bob, 3, false],
    [swing, 4, true],
  ]) {
    const track = { times, values, width, interpolation: 'LINEAR', quaternion },
      q = quantizeTrack(track),
      back = dequantizeTrack(q);
    assert.ok(q.data instanceof Uint16Array);
    assert.equal(q.data.byteLength * 2, values.byteLength);
    for (let i = 0; i < values.length; i++)
      assert.ok(
        Math.abs(back.values[i] - values[i]) <= q.step[i % width] / 2 + 1e-6 * Math.max(1, Math.abs(values[i])),
        `value ${i}`,
      );
    assert.equal(back.quaternion, quaternion);
    assert.equal(back.times, times);
  }
  const one = (values) => ({
    times: new Float32Array(values.length),
    values: new Float32Array(values),
    width: 1,
    interpolation: 'LINEAR',
  });
  assert.deepEqual([...dequantizeTrack(quantizeTrack(one([7, 7]))).values], [7, 7]);
  const ends = quantizeTrack(one([-1, 3]));
  assert.deepEqual([...ends.data], [0, 65535]);
  assert.deepEqual([...dequantizeTrack(ends).values], [-1, 3]);
  assert.throws(() => quantizeTrack(one([Number.NaN])), RangeError);
});

test('compression then quantisation: total error stays under tolerance plus half a step, with the bytes saved', () => {
  const track = { times, values: bob, width: 3, interpolation: 'LINEAR' },
    small = compressTrack(track, 0.01),
    q = quantizeTrack(small),
    back = dequantizeTrack(q),
    before = times.byteLength + bob.byteLength,
    after = q.times.byteLength + q.data.byteLength + q.min.byteLength + q.step.byteLength;
  assert.equal(before, 1936);
  assert.equal(after, 354); // 33 times (132) + 99 values as 16 bit (198) + min and step (24)
  assert.ok(measure(track, back, false) <= 0.01 + Math.max(...q.step) / 2 + 1e-6);
});
