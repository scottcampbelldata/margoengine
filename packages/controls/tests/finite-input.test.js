// Script input to the camera controls must be finite: one NaN turn, pan or dolly used to leave the camera at NaN for
// good. Every bad value throws a RangeError before any state changes, so the next update moves the camera as if the
// call never came.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ArcballControls, FirstPersonControls, OrbitControls } from '../dist/index.js';
import { FakeElement, camera } from './control-fakes.js';

const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
const finite = (cam) => [...cam.position, ...cam.target].every(Number.isFinite);
const pose = (cam) => [...cam.position, ...cam.target];
const rejects = (call, what) =>
  assert.throws(call, (error) => error instanceof RangeError && /; pass /.test(error.message), what);

function unchanged(make, calls) {
  for (const [name, call] of calls) {
    // The same controls with no bad call, updated once, are what the camera must match.
    const reference = camera();
    make(reference).update(1 / 60);
    const cam = camera(),
      control = make(cam);
    rejects(() => call(control), name);
    control.update(1 / 60);
    assert.ok(finite(cam), `${name}: camera stays finite`);
    assert.deepEqual(pose(cam), pose(reference), `${name}: camera as if the call never came`);
  }
}

test('OrbitControls reject non-finite turns and pans and dolly factors that are not finite and above 0', () => {
  const calls = [];
  for (const v of BAD)
    calls.push(
      [`rotateLeft(${v})`, (c) => c.rotateLeft(v)],
      [`rotateUp(${v})`, (c) => c.rotateUp(v)],
      [`pan(${v}, 0)`, (c) => c.pan(v, 0)],
      [`pan(0, ${v})`, (c) => c.pan(0, v)],
      [`dollyIn(${v})`, (c) => c.dollyIn(v)],
      [`dollyOut(${v})`, (c) => c.dollyOut(v)],
    );
  for (const v of [0, -2]) calls.push([`dollyIn(${v})`, (c) => c.dollyIn(v)], [`dollyOut(${v})`, (c) => c.dollyOut(v)]);
  unchanged((cam) => new OrbitControls(cam, new FakeElement()), calls);
});

test('ArcballControls reject the same bad turns, pans and dolly factors', () => {
  const calls = [];
  for (const v of BAD)
    calls.push(
      [`rotate(axis, ${v})`, (c) => c.rotate([0, 1, 0], v)],
      [`rotate([${v}, 1, 0], 1)`, (c) => c.rotate([v, 1, 0], 1)],
      [`pan(${v}, 0)`, (c) => c.pan(v, 0)],
      [`dollyIn(${v})`, (c) => c.dollyIn(v)],
      [`dollyOut(${v})`, (c) => c.dollyOut(v)],
    );
  for (const v of [0, -2]) calls.push([`dollyIn(${v})`, (c) => c.dollyIn(v)], [`dollyOut(${v})`, (c) => c.dollyOut(v)]);
  unchanged((cam) => new ArcballControls(cam, new FakeElement()), calls);
});

test('FirstPersonControls reject a non-finite update step and look target', () => {
  unchanged(
    (cam) => new FirstPersonControls(cam, new FakeElement()),
    BAD.flatMap((v) => [
      [`update(${v})`, (c) => c.update(v)],
      [`lookAt(${v}, 0, 0)`, (c) => c.lookAt(v, 0, 0)],
      [`lookAt([0, ${v}, 0])`, (c) => c.lookAt([0, v, 0])],
    ]),
  );
});
