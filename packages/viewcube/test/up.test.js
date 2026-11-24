import test from 'node:test';
import assert from 'node:assert/strict';
import { UpViewCube } from '../dist/up.js';
import { setup } from './support.mjs';
import { CameraProjection } from '../../cameras/dist/index.js';

const near = (a, b) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) < 1e-8), `${a} != ${b}`);
test('Z up faces, tuple corners, clicks, flip and screen orientation use the same frame', () => {
  const { engine, dom } = setup({ position: [0, -10, 0], up: [0, 0, 1] });
  using cube = new UpViewCube(engine, { duration: 0, flip: true });
  cube.view('top'); engine.frame(); near(engine.camera.position, [0, 0, 10]); near(engine.camera.up, [0, 1, 0]);
  cube.view('front'); engine.frame(); near(engine.camera.position, [0, -10, 0]); near(engine.camera.up, [0, 0, 1]);
  cube.element.querySelector('[data-view="0,0,1"]').click(); engine.frame(); near(engine.camera.position, [0, 10, 0]);
  cube.view([1, 1, 1]); engine.frame(); near(engine.camera.position, [10 / Math.sqrt(3), -10 / Math.sqrt(3), 10 / Math.sqrt(3)]);
  cube.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); engine.frame();
  assert.ok(engine.camera.position[2] > 9);
});
test('arbitrary and negative up preserve distance, home, roll and animated poles', () => {
  for (const up of [[1, 2, 3], [0, -1, 0], [0, 0, -1], [1, 0, 0], [1e-12, 0, -1]]) {
    const { engine } = setup();
    using cube = new UpViewCube(engine, { up, duration: 0.2, home: true });
    const direction = up.map((x) => x / Math.hypot(...up));
    cube.view('top'); for (let i = 0; i < 15; i++) engine.frame();
    near(engine.camera.position, direction.map((x) => 10 * x));
    cube.roll(1, 0); engine.frame();
    assert.ok(engine.camera.up.every(Number.isFinite));
    cube.home(0); engine.frame(); near(engine.camera.position, [0, 0, 10]);
    near(cube.world(cube.local([2, -4, 3])), [2, -4, 3]);
  }
});
test('invalid frames fail before creating a widget or plugin', () => {
  const { engine } = setup();
  for (const up of [[0, 0, 0], [Infinity, 1, 0], [NaN, 0, 0]]) assert.throws(() => new UpViewCube(engine, { up }));
  assert.throws(() => new UpViewCube(engine, { up: 'z', front: [0, 0, 1] }));
  assert.equal(engine.plugins.size, 0);
});
test('custom front and drag use widget up while home remains a world pose', () => {
  const { engine, dom } = setup({ position: [10, 0, 0] });
  using cube = new UpViewCube(engine, { up: 'z', front: [1, 0, 2], duration: 0 });
  cube.view('front'); near(engine.camera.position, [10, 0, 0]);
  const cell = cube.element.querySelector('[data-view="0,0,1"]');
  const pointer = (type, x) => cell.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 0, button: 0 }));
  pointer('pointerdown', 0); pointer('pointermove', 40); pointer('pointerup', 40); engine.frame();
  near(engine.camera.position, [10 * Math.cos(1), -10 * Math.sin(1), 0]);
  cube.setHome({ position: [1, 2, 13], target: [1, 2, 3] }); cube.home(0); engine.frame();
  near(engine.camera.position, [1, 2, 13]); near(engine.camera.target, [1, 2, 3]);
});
test('projection preserves Z-up front and uses the widget front at its exact pole', () => {
  const { engine } = setup({ position: [0, -10, 0] });
  const projection = CameraProjection.attach(engine, { mode: 'orthographic' });
  using cube = new UpViewCube(engine, { projection, duration: 0 });
  cube.view('front'); engine.frame(); near(engine.camera.up, [0, 0, 1]);
  cube.view('top'); engine.frame(); near(engine.camera.up, [0, 1, 0]);
});

test('owned pole up retains azimuth across repeated quarter rolls in every world frame', () => {
  for (const up of ['y', 'z', [1, 2, 3]]) {
    for (const [view, sign] of [['top', 1], ['bottom', -1]]) {
      const { engine, dom } = setup();
      const cube = new UpViewCube(engine, { up, duration: 0 });
      try {
        cube.view(view);
        engine.frame();
        const position = [...engine.camera.position];
        for (const direction of [1, -1]) {
          for (let step = 1; step <= 4; step++) {
            cube.roll(direction, 0);
            engine.frame();
            const angle = direction * step * Math.PI / 2;
            near(engine.camera.up, cube.world([Math.sin(angle), 0, -sign * Math.cos(angle)]));
            near(engine.camera.position, position);
            assert.equal(cube.turns, ((direction * step) % 4 + 4) % 4);
          }
        }
      } finally {
        cube.dispose();
        dom.window.close();
      }
    }
  }
});
