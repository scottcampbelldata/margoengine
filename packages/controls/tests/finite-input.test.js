// Script input to the camera controls must be finite: one NaN turn, pan or dolly used to leave the camera at NaN for
// good. Every bad value throws a RangeError before any state changes, so the next update moves the camera as if the
// call never came.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ArcballControls, FirstPersonControls, OrbitControls, TrackballControls } from '../dist/index.js';
import { FakeElement, camera } from './control-fakes.js';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { ThirdPersonControls } from '../dist/third-person.js';

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

test('TrackballControls reject a non-finite or negative update step', () => {
  unchanged(
    (cam) => new TrackballControls(cam, new FakeElement()),
    [...BAD, -1 / 60].map((v) => [`update(${v})`, (c) => c.update(v)]),
  );
});

test('ThirdPersonControls reject non-finite turns and a non-finite or negative update step', async () => {
  const follow = async () => {
    const canvas = Object.assign(new FakeElement(), { width: 800, height: 600, getContext: () => null }),
      engine = new Runtime(
        canvas,
        await TransformStore.create(8),
        { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
        { position: [0, 3, 8], target: [0, 1, 0] },
        null,
      );
    return { engine, control: new ThirdPersonControls(engine, () => [0, 0, 0], { lag: 0, returnTime: 0 }) };
  };
  const reference = await follow();
  reference.control.update(1 / 60);
  const calls = [...BAD, -1 / 60].map((v) => [`update(${v})`, (c) => c.update(v)]);
  for (const v of BAD)
    calls.push([`rotate(${v}, 0)`, (c) => c.rotate(v, 0)], [`rotate(0, ${v})`, (c) => c.rotate(0, v)]);
  for (const [name, call] of calls) {
    const { engine, control } = await follow();
    rejects(() => call(control), name);
    control.update(1 / 60);
    assert.ok(finite(engine.camera), `${name}: camera stays finite`);
    assert.deepEqual(pose(engine.camera), pose(reference.engine.camera), `${name}: camera as if the call never came`);
    control.dispose();
    engine.dispose();
  }
  reference.control.dispose();
  reference.engine.dispose();
});
