import test from 'node:test';
import assert from 'node:assert/strict';
import { FitViewCube } from '../dist/fit.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { setup } from './support.mjs';

const near = (a, b) =>
  assert.ok(
    a.every((x, i) => Math.abs(x - b[i]) < 1e-8),
    `${a} != ${b}`,
  );
function framed(camera, b, aspect = 4 / 3) {
  camera.update(aspect, true);
  const m = camera.matrix;
  for (let i = 0; i < 8; i++) {
    const p = [b[i & 1 ? 3 : 0], b[i & 2 ? 4 : 1], b[i & 4 ? 5 : 2]],
      q = [0, 1, 2, 3].map((r) => p[0] * m[r] + p[1] * m[4 + r] + p[2] * m[8 + r] + m[12 + r]);
    assert.ok(
      q[3] > 0 &&
        Math.abs(q[0] / q[3]) <= 1 + 1e-8 &&
        Math.abs(q[1] / q[3]) <= 1 + 1e-8 &&
        q[2] / q[3] >= -1e-8 &&
        q[2] / q[3] <= 1 + 1e-8,
      `clipped ${p}: ${q}`,
    );
  }
}
test('all bounds corners stay in the perspective frustum throughout rotating and recentering', () => {
  for (const aspect of [0.25, 4 / 3, 3]) {
    const { engine } = setup();
    const bounds = [16, -3, -2, 24, 5, 4];
    using cube = new FitViewCube(engine, { bounds, aspect, duration: 0.5 });
    for (const view of ['top', 'bottom', 'left', 'back', 'iso', [1, -1, 0]]) {
      cube.view(view);
      for (let i = 0; i < 32; i++) {
        engine.frame();
        framed(engine.camera, bounds, aspect);
      }
      near(engine.camera.target, [20, 1, 1]);
      assert.equal(cube.animating, false);
    }
  }
});
test('orthographic automatic, fixed height and asymmetric frusta frame while turning with Z up', () => {
  for (const options of [
    {},
    { height: 2 },
    { left: 2, right: 6, top: 3, bottom: -1 },
    { height: 5, near: 2, far: 12 },
  ]) {
    const { engine } = setup({ position: [0, -10, 0] });
    const projection = CameraProjection.attach(engine, { mode: 'orthographic', ...options });
    const bounds = [-3, -2, -1, 3, 2, 1];
    using cube = new FitViewCube(engine, { bounds, projection, up: 'z', duration: 0.2 });
    for (const view of ['front', 'top', 'iso', 'right']) {
      cube.view(view);
      for (let i = 0; i < 14; i++) {
        engine.frame();
        framed(engine.camera, bounds);
      }
      assert.ok(projection.zoom > 0);
    }
    cube.setProjection('perspective');
    engine.frame();
    framed(engine.camera, bounds);
  }
});
test('live bounds, Home, roll, keyboard, refit and external interruption', () => {
  const { engine, dom } = setup();
  let bounds = [-1, -1, -1, 1, 1, 1],
    reads = 0;
  using cube = new FitViewCube(engine, {
    bounds: () => {
      reads++;
      return bounds;
    },
    duration: 0,
    home: true,
  });
  cube.view('right');
  near(engine.camera.target, [0, 0, 0]);
  bounds = [2, 3, 4, 6, 7, 8];
  cube.home();
  near(engine.camera.target, [4, 5, 6]);
  framed(engine.camera, bounds);
  cube.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  framed(engine.camera, bounds);
  cube.roll(1, 0);
  cube.fit(0);
  assert.equal(cube.turns, 1);
  framed(engine.camera, bounds);
  assert.equal(reads, 5);
  cube.view('top', 1);
  engine.frame();
  engine.camera.position = engine.camera.position.map((v) => v + 1);
  const external = [...engine.camera.position];
  engine.frame();
  assert.equal(cube.animating, false);
  near(engine.camera.position, external);
});
test('malformed, reversed and out-of-range bounds reject without moving the camera', () => {
  const { engine } = setup();
  using cube = new FitViewCube(engine, { duration: 0 });
  for (const b of [
    [0, 0],
    [1, 0, 0, -1, 0, 0],
    [0, 0, 0, Infinity, 1, 1],
    [-1e6, -1e6, -1e6, 1e6, 1e6, 1e6],
  ]) {
    cube.bounds = b;
    const before = [...engine.camera.position];
    assert.throws(() => cube.view('top'));
    near(engine.camera.position, before);
  }
  cube.bounds = [0, 0, 0, 0, 0, 0];
  cube.fit(0);
  framed(engine.camera, cube.bounds);
});
