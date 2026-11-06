import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '@margoengine/splines';
import { SplineFrames } from '@margoengine/splines/frames';
import { Tween, easeInQuad } from '../dist/index.js';
import { MotionPath, motionPath } from '../dist/motion-path.js';

// Knots close together then far apart: a curve parameter crosses them at very different speeds.
const POINTS = [[0, 0, 0], [0.1, 0.1, 0], [0.3, 0, 0.2], [6, 1, 0], [14, -2, 3], [15, 0, 9], [8, 4, 12]];
const curve = (options) => new Spline(POINTS, { divisions: 2048, ...options });
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Quaternion `[x, y, z, w]` applied to a vector, by the textbook formula, sharing no code with the entry. */
function rotate([x, y, z, w], v) {
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + y * t[2] - z * t[1],
    v[1] + w * t[1] + z * t[0] - x * t[2],
    v[2] + w * t[2] + x * t[1] - y * t[0],
  ];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** A mesh that records what it is told. */
const follower = () => ({
  position: null,
  quaternion: null,
  setPosition(p) {
    this.position = [...p];
  },
  setQuaternion(q) {
    this.quaternion = [...q];
  },
});

test('equal times cover equal lengths of curve, where the raw parameter does not', () => {
  const spline = curve(),
    tween = new Tween(),
    seen = [],
    steps = 200;
  motionPath(tween, (pose) => seen.push([...pose.position]), spline, { duration: 1 });
  for (let i = 0; i <= steps; i++) tween.update(i ? 1 / steps : 0);
  // An independent walk of the curve in steps 100 times finer than its arc-length table: arc length against parameter.
  const fine = 200000,
    arcs = new Float64Array(fine + 1);
  let previous = spline.at(0, new Float64Array(3));
  for (let i = 1; i <= fine; i++) {
    const p = spline.at(i / fine, new Float64Array(3));
    arcs[i] = arcs[i - 1] + distance(p, previous);
    previous = p;
  }
  const length = arcs[fine],
    step = length / steps;
  assert.ok(Math.abs(new MotionPath(spline).length - length) <= 1e-3 * length);
  // At time i the object must be where the walk says i steps of arc end. Its table has 2,048 chords, inverted linearly,
  // so it can be out by a part of a chord's error; 2% of a step, a quarter of one of its chords, holds that with room.
  let low = 0;
  seen.forEach((position, i) => {
    while (low < fine && arcs[low] < i * step) low++;
    const expected = spline.at(low / fine, new Float64Array(3));
    assert.ok(distance(position, expected) <= 0.02 * step, `at step ${i}: ${distance(position, expected)}`);
  });
  // The raw parameter is out by far more: the test means nothing on an even curve.
  const raw = Array.from({ length: steps + 1 }, (_, i) => Array.from(spline.at(i / steps, new Float64Array(3)))),
    rawChords = raw.slice(1).map((p, i) => distance(p, raw[i]));
  assert.ok(Math.max(...rawChords) / Math.min(...rawChords) > 10);
});

test('speed sets the duration from the length, and the object ends on the end of the path', () => {
  const spline = curve(),
    tween = new Tween(),
    mesh = follower();
  let done = false;
  motionPath(tween, mesh, spline, { speed: 2, onComplete: () => (done = true) });
  tween.update(spline.length / 2 - 0.01);
  assert.equal(done, false);
  tween.update(0.02);
  assert.equal(done, true);
  assert.ok(distance(mesh.position, POINTS.at(-1)) <= 1e-9);
});

test('the forward axis lies along the tangent and the rotation is a rotation', () => {
  const spline = curve(),
    frames = new SplineFrames(spline),
    tangent = new Float64Array(3);
  for (const [forward, axis] of [
    ['z', [0, 0, 1]],
    ['x', [1, 0, 0]],
    ['y', [0, 1, 0]],
    ['-z', [0, 0, -1]],
    ['-x', [-1, 0, 0]],
    ['-y', [0, -1, 0]],
  ]) {
    const path = new MotionPath(spline, { forward, frames });
    for (let i = 0; i <= 50; i++) {
      const at = (i / 50) * path.length,
        pose = path.poseAt(at);
      frames.frameAt(at).tangent.forEach((v, k) => (tangent[k] = v));
      assert.ok(Math.abs(Math.hypot(...pose.quaternion) - 1) <= 1e-12, 'unit length');
      // Doubles through a matrix to quaternion conversion: about 1e-15 per step, so 1e-12 holds with room.
      assert.ok(distance(rotate(pose.quaternion, axis), tangent) <= 1e-12, `${forward} at ${at}`);
    }
  }
});

test('up follows the frame normal, so the object does not flip or spin on the way', () => {
  // A climb that turns through a quarter circle and on, past the vertical where a fixed up vector would flip.
  const spline = new Spline([[0, 0, 0], [10, 0, 0], [20, 10, 0], [20, 20, 0], [10, 30, 0], [0, 30, 5]]),
    path = new MotionPath(spline),
    frames = path.frames;
  let previous;
  for (let i = 0; i <= 400; i++) {
    const at = (i / 400) * path.length,
      pose = path.poseAt(at),
      up = rotate(pose.quaternion, [0, 1, 0]);
    assert.ok(distance(up, frames.frameAt(at).normal) <= 1e-12);
    // About 3 radians of turning over 400 steps: a step turns a hundredth of a radian or so, so neighbours are near
    // parallel, 0.99 is 8 degrees, and a flip is -1.
    if (previous) assert.ok(dot(up, previous) > 0.99, `a jump at ${at}`);
    previous = up;
  }
});

test('a camera faces the way it moves with -z', () => {
  const spline = new Spline([[0, 0, 0], [0, 0, -10]]),
    pose = new MotionPath(spline, { forward: '-z' }).poseAt(5);
  assert.ok(distance(rotate(pose.quaternion, [0, 0, -1]), [0, 0, -1]) <= 1e-12);
  assert.ok(distance(pose.position, [0, 0, -5]) <= 1e-9);
});

test('start and end pick a stretch, and end before start runs it backwards', () => {
  const spline = curve(),
    length = spline.length,
    tween = new Tween(),
    seen = [];
  motionPath(tween, (pose) => seen.push(pose.distance), spline, { duration: 1, start: length / 2, end: length / 4 });
  tween.update(0);
  tween.update(0.5);
  tween.update(0.5);
  assert.deepEqual(seen, [length / 2, (3 * length) / 8, length / 4]);
});

test('an easing shapes the speed, one that overshoots waits at the end, and orient false leaves rotation', () => {
  const spline = curve(),
    tween = new Tween(),
    seen = [];
  motionPath(tween, (pose) => seen.push(pose.distance), spline, { duration: 1, easing: easeInQuad });
  tween.update(0.5);
  assert.ok(Math.abs(seen[0] - spline.length / 4) <= 1e-9);
  const over = [];
  motionPath(tween, (pose) => over.push(pose.distance), spline, { duration: 1, easing: (t) => t * 1.5 });
  tween.update(0.9);
  assert.equal(over[0], spline.length);
  const mesh = follower();
  motionPath(tween, mesh, spline, { duration: 1, orient: false });
  tween.update(0.5);
  assert.ok(mesh.position);
  assert.equal(mesh.quaternion, null);
});

test('cancel stops it, and a ready MotionPath can be shared', () => {
  const path = new MotionPath(curve()),
    tween = new Tween(),
    mesh = follower();
  const cancel = motionPath(tween, mesh, path, { duration: 1 });
  tween.update(0.5);
  const stopped = [...mesh.position];
  cancel();
  tween.update(0.5);
  assert.deepEqual(mesh.position, stopped);
});

test('a closed path comes back to where it began', () => {
  const spline = new Spline([[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]], { closed: true }),
    path = new MotionPath(spline);
  assert.ok(distance(path.poseAt(0).position, path.poseAt(path.length).position) <= 1e-9);
});

test('bad input throws', () => {
  const spline = curve(),
    tween = new Tween(),
    mesh = follower();
  assert.throws(() => new MotionPath(new Spline([[1, 1, 1], [1, 1, 1]])), RangeError);
  assert.throws(() => new MotionPath(spline, { forward: 'w' }), RangeError);
  assert.throws(() => new MotionPath(spline).poseAt(-1), RangeError);
  assert.throws(() => motionPath(tween, mesh, spline, {}), RangeError);
  assert.throws(() => motionPath(tween, mesh, spline, { duration: 1, speed: 1 }), RangeError);
  assert.throws(() => motionPath(tween, mesh, spline, { speed: 0 }), RangeError);
  assert.throws(() => motionPath(tween, mesh, spline, { speed: Infinity }), RangeError);
  assert.throws(() => motionPath(tween, mesh, spline, { duration: 1, end: spline.length + 1 }), RangeError);
  assert.throws(() => motionPath(tween, mesh, spline, { duration: 1, start: -1 }), RangeError);
  assert.throws(() => motionPath(tween, {}, spline, { duration: 1 }), RangeError);
});
