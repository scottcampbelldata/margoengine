import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { StrictMode, createRef } from 'react';

// CameraControls drives the real @margoengine/controls/transitions OrbitControls; only the engine is a stand-in.
const dom = new JSDOM('<!doctype html><html><body><canvas></canvas></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'navigator'])
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { Context } = await import('../dist/internal.js');
const { CameraControls } = await import('../dist/controls.js');
const { render, act, cleanup } = await import('@testing-library/react');
const flush = () => act(async () => {});
const h = React.createElement;
const scenes = [];

function scene() {
  const errors = [],
    meshes = new Map();
  const engine = {
    backend: 'webgpu',
    disposed: false,
    canvas: dom.window.document.querySelector('canvas'),
    camera: {
      position: [0, 0, 10],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: 60,
      near: 0.1,
      far: 1000,
      matrix: new Float32Array(16),
    },
    meshes,
    plugins: new Map(),
    store: { tick() {}, parents: [] },
    onError: (error) => errors.push(error),
  };
  const value = {
    engine,
    resources: { models: new Set(), lighting: new Map() },
    frames: { callbacks: new Set() },
    errors,
  };
  scenes.push(value);
  return value;
}
const tree = (value, props) => h(StrictMode, null, h(Context.Provider, { value }, h(CameraControls, props)));
async function frames(value, seconds, step = 0.05) {
  for (let t = 0; t < seconds - 1e-9; t += step)
    await act(async () => {
      for (const callback of [...value.frames.callbacks]) callback(value.engine, step);
    });
}
const near = (actual, expected, label) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) < 1e-6),
    `${label}: ${actual.map((v) => v.toFixed(6))} is not ${expected}`,
  );

afterEach(async () => {
  cleanup();
  await flush();
  for (const value of scenes) assert.equal(value.frames.callbacks.size, 0, 'unmount releases the frame callback');
  scenes.length = 0;
});

test('CameraControls has damping on and a ref that moves the camera smoothly or at once', async () => {
  const value = scene(),
    ref = createRef(),
    camera = value.engine.camera;
  render(tree(value, { ref, maxDistance: 20 }));
  await flush();
  const handle = ref.current;
  assert.ok(handle, 'the ref is the handle once the controls load');
  assert.equal(handle.controls.enableDamping, true, 'damping is on by default');
  assert.ok(handle.controls.transitions, 'the native controls carry transitions');

  // A smooth move arrives after its duration and resolves true; it is between the two views on the way.
  const moved = handle.setLookAt([0, 5, 5], [1, 0, 0]);
  await frames(value, 0.3);
  assert.ok(camera.position[1] > 0 && camera.position[1] < 5, 'part way after half the duration');
  await frames(value, 0.4);
  assert.equal(await moved, true);
  near(camera.position, [0, 5, 5], 'eye');
  near(camera.target, [1, 0, 0], 'target');

  // At once: rotateTo puts the eye at azimuth atan2(x, z) and polar from +Y around the target.
  await handle.setLookAt([0, 0, 10], [0, 0, 0], false);
  await frames(value, 0.05);
  const turned = handle.rotateTo(Math.PI / 2, Math.PI / 2, false);
  await frames(value, 0.05);
  assert.equal(await turned, true);
  near(camera.position, [10, 0, 0], 'rotateTo');
  const relative = handle.rotate(Math.PI / 2, 0, false);
  await frames(value, 0.05);
  await relative;
  near(camera.position, [0, 0, -10], 'rotate adds to the current angles');

  // Dolly along the view, held inside maxDistance.
  const closer = handle.dolly(4, false);
  await frames(value, 0.05);
  await closer;
  near(camera.position, [0, 0, -6], 'dolly 4 closer');
  const far = handle.dollyTo(100, false);
  await frames(value, 0.05);
  await far;
  near(camera.position, [0, 0, -20], 'dollyTo stops at maxDistance');

  // Truck slides eye and target along the screen's right and up.
  await handle.setLookAt([0, 0, 10], [0, 0, 0], false);
  await frames(value, 0.05);
  const slid = handle.truck(1, 2, false);
  await frames(value, 0.05);
  await slid;
  near(camera.position, [1, 2, 10], 'truck eye');
  near(camera.target, [1, 2, 0], 'truck target');

  // reset goes back to the view at mount.
  const back = handle.reset(false);
  await frames(value, 0.05);
  await back;
  near(camera.position, [0, 0, 10], 'reset eye');
  near(camera.target, [0, 0, 0], 'reset target');
});

test('CameraControls fits a box or a mesh, and a cancelled or interrupted move resolves false', async () => {
  const value = scene(),
    ref = createRef(),
    camera = value.engine.camera;
  // A mesh: a unit cube's corners as interleaved vertices (position and normal), moved to x = 4.
  const vertices = new Float32Array(48);
  for (let i = 0; i < 8; i++) vertices.set([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1], i * 6);
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1]);
  const mesh = { id: 7, geometry: { vertices }, matrix };
  value.engine.meshes.set(7, mesh);
  value.engine.store.parents[7] = -1;
  render(tree(value, { ref, duration: 0.2 }));
  await flush();
  const handle = ref.current;
  const box = handle.fitToBox({ min: [-1, -1, -1], max: [1, 1, 1] }, false, { aspect: 1 });
  await frames(value, 0.05);
  assert.equal(await box, true);
  near(camera.target, [0, 0, 0], 'the box centre');
  assert.ok(camera.position[2] > 1 && camera.position[0] === 0, 'from the same direction, outside the box');
  const fitted = handle.fitToSphere(mesh, true, { aspect: 1 });
  await frames(value, 0.25);
  assert.equal(await fitted, true, 'duration 0.2 s');
  near(camera.target, [4, 0, 0], 'the mesh centre');
  assert.throws(() => handle.fitToBox({ id: 99 }), RangeError);
  assert.throws(() => handle.dolly(Number.NaN), RangeError);

  const cancelled = handle.setLookAt([0, 0, 30], [0, 0, 0]);
  await frames(value, 0.05);
  handle.cancel();
  assert.equal(await cancelled, false);
  const replaced = handle.setLookAt([0, 0, 30], [0, 0, 0]);
  await frames(value, 0.05);
  const newer = handle.dollyTo(12);
  assert.equal(await replaced, false, 'a newer move replaces one in flight');
  await frames(value, 0.3);
  assert.equal(await newer, true);
});

test('FlyControls, FirstPersonControls and TrackballControls load their own entry, apply props and fly from keys', async () => {
  const { FlyControls, FirstPersonControls, TrackballControls } = await import('../dist/controls.js');
  const { FlyControls: FlyClass } = await import('@margoengine/controls/fly');
  const { FirstPersonControls: WalkClass } = await import('@margoengine/controls/first-person');
  const { TrackballControls: BallClass } = await import('@margoengine/controls/trackball');
  const mount = (Component, props) => {
    const value = scene(),
      ref = createRef();
    const view = render(h(StrictMode, null, h(Context.Provider, { value }, h(Component, { ref, ...props }))));
    return { value, ref, view };
  };
  const keys = dom.window.document.createElement('div');
  const fly = mount(FlyControls, { movementSpeed: 4, keyTarget: keys });
  await flush();
  assert.ok(fly.ref.current instanceof FlyClass, 'the ref is the FlyControls of /fly');
  assert.equal(fly.ref.current.movementSpeed, 4);
  keys.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
  await frames(fly.value, 0.5);
  keys.dispatchEvent(new dom.window.KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
  near(fly.value.engine.camera.position, [0, 0, 8], 'W flies 4 units per second along the view for 0.5 s');
  // A removed prop restores the controls' default.
  fly.view.rerender(
    h(StrictMode, null, h(Context.Provider, { value: fly.value }, h(FlyControls, { ref: fly.ref, keyTarget: keys }))),
  );
  await flush();
  assert.equal(fly.ref.current.movementSpeed, 1);

  const walk = mount(FirstPersonControls, {
    lookSpeed: 0.01,
    constrainVertical: true,
    verticalMin: 0.5,
    verticalMax: 2,
  });
  await flush();
  assert.ok(walk.ref.current instanceof WalkClass, 'the ref is the FirstPersonControls of /first-person');
  assert.equal(walk.ref.current.lookSpeed, 0.01);
  assert.equal(walk.ref.current.verticalMin, 0.5);

  const ball = mount(TrackballControls, { staticMoving: true, maxDistance: 50 });
  await flush();
  assert.ok(ball.ref.current instanceof BallClass, 'the ref is the TrackballControls of /trackball');
  assert.equal(ball.ref.current.staticMoving, true);
  assert.equal(ball.ref.current.maxDistance, 50);
});
