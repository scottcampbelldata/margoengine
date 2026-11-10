import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewCube } from '../dist/index.js';
import { UpViewCube } from '../dist/up.js';
import { FitViewCube } from '../dist/fit.js';
import { ViewCompass } from '../dist/compass.js';
import { CameraProjection } from '../../cameras/dist/index.js';
import { setup } from './support.mjs';

const near = (a, b) =>
  assert.ok(
    a.every((v, i) => Math.abs(v - b[i]) < 1e-8),
    `${a} != ${b}`,
  );
const direction = (camera) => {
  const d = camera.position.map((v, i) => v - camera.target[i]);
  return d.map((v) => v / Math.hypot(...d));
};
test('cardinal clicks, north offset and heading follow the cube frame including Z up', () => {
  for (const up of ['y', 'z', [1, 2, 3]]) {
    const { engine } = setup();
    using cube = new UpViewCube(engine, { up, duration: 0 });
    using compass = new ViewCompass(cube);
    const buttons = [...compass.element.querySelectorAll('button')];
    for (const [i, d] of [
      [0, [0, 0, -1]],
      [1, [1, 0, 0]],
      [2, [0, 0, 1]],
      [3, [-1, 0, 0]],
    ]) {
      buttons[i].click();
      engine.frame();
      near(direction(engine.camera), cube.world(d));
    }
    compass.north = Math.PI / 2;
    buttons[0].click();
    engine.frame();
    near(direction(engine.camera), cube.world([1, 0, 0]));
    cube.view('top', 0);
    engine.frame();
    assert.ok(buttons.every((b) => !b.style.left.includes('NaN') && !b.style.top.includes('NaN')));
    assert.throws(() => {
      compass.north = Infinity;
    }, RangeError);
  }
});
test('context menu actions, projection radio state, fit and keyboard focus', () => {
  const { engine, dom } = setup();
  const projection = CameraProjection.attach(engine, { mode: 'perspective' });
  using cube = new ViewCube(engine, { duration: 0, projection });
  let fits = 0;
  using compass = new ViewCompass(cube, { fit: () => fits++ });
  const items = [...compass.menu.querySelectorAll('button')];
  const face = cube.element.querySelector('[aria-label="Front view"]');
  face.focus();
  cube.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
  assert.equal(compass.menu.hidden, false);
  assert.equal(dom.window.document.activeElement, items[0]);
  assert.equal(items[3].getAttribute('aria-checked'), 'true');
  const key = (value) =>
    compass.menu.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    );
  key('ArrowUp');
  assert.equal(dom.window.document.activeElement, items[5]);
  key('Home');
  key('ArrowDown');
  assert.equal(dom.window.document.activeElement, items[1]);
  key('Escape');
  assert.equal(dom.window.document.activeElement, face);
  cube.view('right', 0);
  compass.openMenu(10, 10);
  items[1].click();
  cube.view('front', 0);
  compass.openMenu(10, 10);
  items[0].click();
  near(direction(engine.camera), [1, 0, 0]);
  compass.openMenu(10, 10);
  items[2].click();
  assert.equal(fits, 1);
  compass.openMenu(10, 10);
  items[4].click();
  assert.equal(projection.mode, 'orthographic');
  compass.openMenu(10, 10);
  assert.equal(items[4].getAttribute('aria-checked'), 'true');
  items[5].click();
  assert.equal(compass.visible, false);
  compass.openMenu(10, 10);
  assert.equal(items[5].getAttribute('aria-checked'), 'false');
  dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(compass.menu.hidden, true);
});
test('missing fit/projection disable actions and keyboard navigation skips them', () => {
  const { engine, dom } = setup();
  using cube = new ViewCube(engine, { duration: 0 });
  using compass = new ViewCompass(cube);
  const items = [...compass.menu.querySelectorAll('button')];
  compass.openMenu(99999, 99999);
  assert.ok(items.slice(2, 5).every((b) => b.disabled));
  items[1].focus();
  compass.menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(dom.window.document.activeElement, items[5]);
  assert.throws(() => compass.openMenu(NaN, 0), RangeError);
});
test('fit entry integration, cube-owned disposal, margins and duplicate attachment', () => {
  const { engine } = setup();
  using cube = new FitViewCube(engine, { bounds: [-2, -1, -1, 2, 1, 1], duration: 0 });
  const margin = cube.element.style.marginBottom,
    original = cube.dispose;
  const compass = new ViewCompass(cube);
  assert.throws(() => new ViewCompass(cube), /already has a compass/);
  compass.openMenu(0, 0);
  const fit = compass.menu.querySelectorAll('button')[2];
  assert.equal(fit.disabled, false);
  fit.click();
  assert.ok(engine.camera.position[2] > 4);
  compass.dispose();
  assert.equal(cube.dispose, original);
  assert.equal(cube.element.style.marginBottom, margin);
  assert.equal(engine.plugins.size, 1);
  assert.equal(compass.menu.isConnected, false);
  const next = new ViewCompass(cube, { menu: false });
  assert.equal(next.menu, undefined);
  cube.dispose();
  assert.equal(engine.plugins.size, 0);
  assert.equal(next.element.isConnected, false);
  next.dispose();
  assert.throws(() => new ViewCompass(cube), /disposed/);
});
test('compass drag is a turntable, retains user distance on a fit cube and suppresses its ending click', () => {
  const { engine, dom } = setup();
  using cube = new FitViewCube(engine, { bounds: [-2, -1, -1, 2, 1, 1], duration: 0 });
  cube.view('iso');
  engine.camera.position = engine.camera.position.map((v) => v * 2);
  const radius = Math.hypot(...engine.camera.position),
    before = direction(engine.camera);
  using compass = new ViewCompass(cube);
  const button = compass.element.querySelector('button');
  const pointer = (type, x) =>
    button.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 0, button: 0 }));
  pointer('pointerdown', 0);
  pointer('pointermove', 40);
  pointer('pointerup', 40);
  button.click();
  engine.frame();
  assert.ok(Math.abs(Math.hypot(...engine.camera.position) - radius) < 1e-8);
  assert.ok(Math.abs(direction(engine.camera)[1] - before[1]) < 1e-8);
  assert.ok(Math.abs(direction(engine.camera)[0] - before[0]) > 0.1);
  near(engine.camera.target, [0, 0, 0]);
  assert.equal(cube.animating, false);
});
