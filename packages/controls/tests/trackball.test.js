import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackballControls } from '../dist/index.js';
import { FakeElement, FakeTarget, camera, close, closeVec, key, pointer, run } from './control-fakes.js';

const T = 1e-9;
const POLE = 1e-3;
function ball(options = {}) {
  const el = new FakeElement(),
    keys = new FakeTarget(),
    cam = camera(),
    control = new TrackballControls(cam, el, { keyTarget: keys }),
    events = [];
  Object.assign(control, options);
  for (const type of ['start', 'change', 'end']) control.addEventListener(type, () => events.push(type));
  return { el, keys, cam, control, events };
}
const len = (a) => Math.hypot(...a);
const eye = (cam) => cam.position.map((v, i) => v - cam.target[i]);
// Press, move through `points` with one update after each move, release.
function gesture(el, control, points, extra = {}, delta = 1 / 60) {
  pointer(el, 'pointerdown', points[0][0], points[0][1], extra);
  for (const [x, y] of points.slice(1)) {
    pointer(el, 'pointermove', x, y, extra);
    control.update(delta);
  }
  pointer(el, 'pointerup', ...points[points.length - 1], extra);
}

test('trackball: defaults', () => {
  const { control, el } = ball();
  assert.equal(control.rotateSpeed, 1);
  assert.equal(control.zoomSpeed, 1.2);
  assert.equal(control.panSpeed, 0.3);
  assert.equal(control.staticMoving, false);
  assert.equal(control.dynamicDampingFactor, 0.2);
  assert.equal(control.minDistance, 0);
  assert.equal(control.maxDistance, Infinity);
  assert.deepEqual(control.keys, ['KeyA', 'KeyS', 'KeyD']);
  assert.deepEqual(control.mouseButtons, { LEFT: 0, MIDDLE: 1, RIGHT: 2 });
  assert.equal(control.state, 'none');
  assert.equal(el.style.touchAction, 'none');
  control.dispose();
  assert.equal(el.style.touchAction, 'auto');
  assert.equal(el.listenerCount, 0);
});

test('trackball: the scene follows the pointer like a grabbed ball, distance kept, no roll', () => {
  let { el, cam, control, events } = ball({ staticMoving: true });
  gesture(el, control, [
    [400, 300],
    [480, 300],
  ]);
  assert.ok(cam.position[0] < -1, 'drag right moves the camera toward -X');
  close(cam.position[1], 0, T);
  close(len(eye(cam)), 10, T);
  closeVec(cam.target, [0, 0, 0], 0);
  assert.deepEqual(events, ['start', 'change', 'end']);
  control.dispose();

  ({ el, cam, control } = ball({ staticMoving: true }));
  gesture(el, control, [
    [400, 300],
    [400, 240],
  ]);
  assert.ok(cam.position[1] < -1, 'drag up moves the camera down');
  close(cam.position[0], 0, T);
  close(len(eye(cam)), 10, T);
  control.dispose();

  // Bell's ball: near the centre a small drag of s circle units turns the view by about s radians.
  ({ el, cam, control } = ball({ staticMoving: true }));
  gesture(el, control, [
    [400, 300],
    [404, 300],
  ]);
  close(Math.atan2(-cam.position[0], cam.position[2]), 0.01, 1e-6, 'about 1 rad per half width near the centre');
  control.dispose();

  // A diagonal drag far from the centre: the screen axes stay level (camera up keeps zero roll by construction).
  ({ el, cam, control } = ball({ staticMoving: true }));
  gesture(el, control, [
    [700, 100],
    [760, 160],
    [790, 250],
  ]);
  close(len(eye(cam)), 10, T);
  assert.ok(cam.position.every(Number.isFinite));
  control.dispose();
});

test('trackball: never crosses or reaches a pole', () => {
  const { el, cam, control } = ball({ staticMoving: true });
  pointer(el, 'pointerdown', 400, 100);
  for (let i = 0; i < 40; i++) {
    pointer(el, 'pointermove', 400, 100 + ((i % 8) + 1) * 30);
    control.update(1 / 60);
    if (i % 8 === 7) {
      pointer(el, 'pointerup', 400, 340);
      pointer(el, 'pointerdown', 400, 100);
    }
    assert.ok(cam.position[2] > 0, `never over the top (step ${i})`);
    assert.ok(Math.atan2(Math.hypot(cam.position[0], cam.position[2]), cam.position[1]) >= POLE - 1e-12);
  }
  pointer(el, 'pointerup', 400, 340);
  closeVec(cam.position, [0, 10 * Math.cos(POLE), 10 * Math.sin(POLE)], T, 'stops exactly at the limit');
  closeVec(cam.position, [0, 9.999995, 0.00999999833333], 1e-9);
  // One huge step cannot jump across the pole either.
  cam.position = [0, 0, 10];
  pointer(el, 'pointerdown', 400, 0);
  pointer(el, 'pointermove', 400, 100000);
  control.update(1 / 60);
  assert.ok(cam.position[2] > 0 && cam.position[1] > 0);
  assert.doesNotThrow(() => cam.update(4 / 3, true));
  control.dispose();
});

test('trackball: coasting after a fling is frame-rate independent and stops', () => {
  // The same 1/30 s drag at a steady angular speed (two equal arcs either side of the centre): two moves at
  // 60 fps, or one update at 30 fps.
  const fling = (fps) => {
    const { el, cam, control } = ball();
    pointer(el, 'pointerdown', 380, 300);
    pointer(el, 'pointermove', 400, 300);
    if (fps === 60) control.update(1 / 60);
    pointer(el, 'pointermove', 420, 300);
    control.update(1 / fps);
    pointer(el, 'pointerup', 420, 300);
    return { cam, control };
  };
  const a = fling(60),
    b = fling(30);
  closeVec(a.cam.position, b.cam.position, T, 'after the drag');
  assert.equal(run(a.control, 1, 60), true, 'still coasting after 1 s');
  run(b.control, 1, 30);
  closeVec(a.cam.position, b.cam.position, 1e-9, 'coast after 1 s at 60 vs 30 fps');
  close(len(eye(a.cam)), 10, T);
  let stopped = false;
  for (let i = 0; i < 60 * 30 && !stopped; i++) stopped = !a.control.update(1 / 60);
  assert.ok(stopped, 'the coast ends');
  assert.equal(a.control.update(1 / 60), false);
  const held = [...a.cam.position];
  run(a.control, 5);
  closeVec(a.cam.position, held, 0, 'and stays stopped');
  a.control.dispose();
  b.control.dispose();

  // Pressing again takes hold of the ball and stops the coast; staticMoving never coasts.
  const c = fling(60);
  pointer(c.control.element, 'pointerdown', 400, 300);
  assert.equal(c.control.update(1 / 60), false);
  pointer(c.control.element, 'pointerup', 400, 300);
  c.control.dispose();
  const { el, control } = ball({ staticMoving: true });
  gesture(el, control, [
    [400, 300],
    [440, 300],
  ]);
  assert.equal(control.update(1 / 60), false);
  control.dispose();
});

test('trackball: pan moves the target with the scene following the pointer', () => {
  let { el, cam, control } = ball({ staticMoving: true });
  gesture(
    el,
    control,
    [
      [400, 300],
      [440, 300],
    ],
    { button: 2 },
  );
  closeVec(cam.position, [-0.15, 0, 10], T, '(40 / 800) * 10 * panSpeed');
  closeVec(cam.target, [-0.15, 0, 0], T);
  control.dispose();

  // Damped pan: frame-rate independent, and ends where the static pan does.
  const damped = () => {
    const b = ball();
    pointer(b.el, 'pointerdown', 400, 300, { button: 2 });
    pointer(b.el, 'pointermove', 440, 320, { button: 2 });
    pointer(b.el, 'pointerup', 440, 320, { button: 2 });
    return b;
  };
  const a = damped(),
    b = damped();
  run(a.control, 10 / 60, 60);
  run(b.control, 10 / 60, 30);
  closeVec(a.cam.target, b.cam.target, T, 'same easing at 60 and 30 fps');
  assert.ok(a.cam.target[0] > -0.15 && a.cam.target[0] < -0.1, 'still easing in');
  run(a.control, 3);
  run(b.control, 3, 30);
  closeVec(a.cam.target, [-0.15, 0.1, 0], T, 'damped total equals the static pan');
  closeVec(b.cam.target, [-0.15, 0.1, 0], T);
  closeVec(a.cam.position, [-0.15, 0.1, 10], T);
  a.control.dispose();
  b.control.dispose();
});

test('trackball: zoom by wheel, middle drag, held keys and touch pinch; distance limits', () => {
  let { el, cam, control, events } = ball({ staticMoving: true });
  const wheel = el.dispatch('wheel', { deltaY: 400, deltaMode: 0 });
  assert.equal(wheel.defaultPrevented, true);
  assert.deepEqual(events, ['start', 'end']);
  control.update();
  assert.ok(cam.position[2] > 10, 'wheel toward the user zooms out');
  const out = cam.position[2];
  el.dispatch('wheel', { deltaY: -400, deltaMode: 0 });
  control.update();
  close(cam.position[2], 10, T, 'and back');
  for (const mode of [1, 2]) {
    el.dispatch('wheel', { deltaY: -3, deltaMode: mode });
    control.update();
    assert.ok(cam.position[2] < 10, `line/page mode ${mode} zooms in`);
    el.dispatch('wheel', { deltaY: 3, deltaMode: mode });
    control.update();
  }
  close(cam.position[2], 10, T);
  gesture(
    el,
    control,
    [
      [400, 300],
      [400, 360],
    ],
    { button: 1 },
  );
  assert.ok(cam.position[2] > 10, 'middle drag down zooms out');
  closeVec(cam.target, [0, 0, 0], 0);
  control.dispose();

  // Damped zoom ends where the static zoom does.
  ({ el, cam, control } = ball());
  el.dispatch('wheel', { deltaY: 400, deltaMode: 0 });
  control.update();
  assert.ok(cam.position[2] > 10 && cam.position[2] < out, 'eases in');
  run(control, 3);
  close(cam.position[2], out, T, 'damped total equals the static zoom');
  control.dispose();

  // Held KeyS makes the left button zoom, KeyD pan; any keyup clears it.
  let k;
  ({ el, keys: k, cam, control } = ball({ staticMoving: true }));
  key(k, 'keydown', 'KeyS');
  gesture(el, control, [
    [400, 300],
    [400, 360],
  ]);
  key(k, 'keyup', 'KeyS');
  assert.ok(cam.position[2] > 10, 'S + left drag zooms');
  close(cam.position[0], 0, T);
  const zoomed = cam.position[2];
  key(k, 'keydown', 'KeyD');
  gesture(el, control, [
    [400, 300],
    [440, 300],
  ]);
  key(k, 'keyup', 'KeyD');
  closeVec(cam.target, [-(40 / 800) * zoomed * 0.3, 0, 0], T, 'D + left drag pans');
  gesture(el, control, [
    [400, 300],
    [440, 300],
  ]);
  close(len(eye(cam)), zoomed, T, 'after keyup the left button rotates again');
  control.dispose();

  // Two fingers spread 40 -> 80 px: closer by exactly the spread ratio.
  ({ el, cam, control } = ball({ staticMoving: true }));
  const touch = (type, id, x, y) => pointer(el, type, x, y, { pointerId: id, pointerType: 'touch' });
  touch('pointerdown', 1, 380, 300);
  assert.equal(control.state, 'touch-rotate');
  touch('pointerdown', 2, 420, 300);
  assert.equal(control.state, 'touch-zoom-pan');
  touch('pointermove', 1, 360, 300);
  touch('pointermove', 2, 440, 300);
  control.update();
  closeVec(cam.position, [0, 0, 5], T, 'pinch halves the distance');
  touch('pointermove', 1, 380, 300);
  touch('pointermove', 2, 460, 300);
  control.update();
  close(cam.position[0], -(20 / 800) * 5 * 0.3, T, 'two-finger move pans');
  touch('pointerup', 2, 460, 300);
  assert.equal(control.state, 'touch-rotate');
  touch('pointerup', 1, 380, 300);
  assert.equal(control.state, 'none');
  assert.equal(el.captured.size, 0);
  control.dispose();

  ({ el, cam, control } = ball({ staticMoving: true, minDistance: 5, maxDistance: 12 }));
  el.dispatch('wheel', { deltaY: 5000, deltaMode: 0 });
  control.update();
  closeVec(cam.position, [0, 0, 12], T, 'maxDistance');
  el.dispatch('wheel', { deltaY: -50000, deltaMode: 0 });
  control.update();
  closeVec(cam.position, [0, 0, 5], T, 'minDistance');
  control.dispose();
});

test('trackball: no* flags, disabling mid-drag, contextmenu, saveState and reset', () => {
  let { el, cam, control, events } = ball({ staticMoving: true, noRotate: true, noPan: true, noZoom: true });
  gesture(el, control, [
    [400, 300],
    [480, 300],
  ]);
  gesture(
    el,
    control,
    [
      [400, 300],
      [480, 300],
    ],
    { button: 2 },
  );
  const wheel = el.dispatch('wheel', { deltaY: 400, deltaMode: 0 });
  assert.equal(wheel.defaultPrevented, false);
  assert.equal(control.update(), false);
  assert.deepEqual(events, []);
  assert.equal(el.captured.size, 0);
  control.dispose();

  ({ el, cam, control, events } = ball({ staticMoving: true }));
  pointer(el, 'pointerdown', 400, 300);
  assert.ok(el.captured.has(1));
  control.enabled = false;
  pointer(el, 'pointermove', 480, 300);
  assert.equal(control.state, 'none');
  assert.equal(el.captured.size, 0);
  assert.deepEqual(events, ['start', 'end']);
  assert.equal(control.update(), false);
  assert.equal(el.dispatch('contextmenu').defaultPrevented, false);
  control.enabled = true;
  assert.equal(el.dispatch('contextmenu').defaultPrevented, true);

  control.saveState();
  gesture(el, control, [
    [400, 300],
    [480, 300],
  ]);
  el.dispatch('wheel', { deltaY: 400, deltaMode: 0 });
  control.staticMoving = false;
  control.reset();
  closeVec(cam.position, [0, 0, 10], 0);
  closeVec(cam.target, [0, 0, 0], 0);
  assert.equal(control.update(), false, 'reset drops pending zoom and coasting');
  // Position equal to the target does not produce NaN.
  cam.position = [0, 0, 0];
  gesture(el, control, [
    [400, 300],
    [480, 300],
  ]);
  assert.ok([...cam.position, ...cam.target].every(Number.isFinite));
  control.dispose();
});
