import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FlyControls, TrackballControls } from '../dist/index.js';
import { FlyControls as EntryFly } from '../dist/fly.js';
import { TrackballControls as EntryTrackball } from '../dist/trackball.js';
import { FakeElement, FakeTarget, camera, close, closeVec, key, pointer, run } from './control-fakes.js';

const T = 1e-9;
const len = (a) => Math.hypot(...a);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const unit = (a) => a.map((v) => v / len(a));

function fly(options = {}, cam = camera()) {
  const el = new FakeElement(),
    keys = new FakeTarget(),
    control = new FlyControls(cam, el, { keyTarget: keys });
  Object.assign(control, { enableRoll: true, rollSpeed: 0.5 }, options);
  return { el, keys, cam, control };
}
function ball(options = {}, cam = camera()) {
  const el = new FakeElement(),
    control = new TrackballControls(cam, el, { keyTarget: new FakeTarget() });
  Object.assign(control, { enableRoll: true, staticMoving: true }, options);
  return { el, cam, control };
}
const hold = (keys, control, code, seconds) => {
  key(keys, 'keydown', code);
  run(control, seconds);
  key(keys, 'keyup', code);
};
function drag(el, control, points, delta = 1 / 60) {
  pointer(el, 'pointerdown', ...points[0]);
  for (const point of points.slice(1)) {
    pointer(el, 'pointermove', ...point);
    control.update(delta);
  }
  pointer(el, 'pointerup', ...points[points.length - 1]);
}
function orthonormal(cam, message = '') {
  const view = unit(sub(cam.target, cam.position));
  close(len(cam.up), 1, 1e-9, `${message} up length`);
  close(dot(cam.up, view), 0, 1e-9, `${message} up off the view`);
}
// NDC x and y of a world point through the camera core actually renders with.
function ndc(cam, p) {
  cam.update(4 / 3, true);
  const m = cam.matrix,
    x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w];
}

test('roll: off by default, Q and E leave camera.up alone in both controls', () => {
  const { control, keys, cam } = fly({ enableRoll: false });
  key(keys, 'keydown', 'KeyQ');
  key(keys, 'keydown', 'KeyE');
  assert.equal(run(control, 1), false);
  assert.deepEqual(cam.up, [0, 1, 0]);
  control.dispose();
  assert.equal(new FlyControls(camera()).enableRoll, false);
  assert.equal(new TrackballControls(camera()).enableRoll, false);

  const b = ball({ enableRoll: false });
  drag(b.el, b.control, [
    [700, 300],
    [700, 360],
  ]);
  assert.deepEqual(b.cam.up, [0, 1, 0]);
  b.control.dispose();
});

test('fly roll: Q and E turn the horizon at rollSpeed, the eye and view stay, and a pure roll reports a change', () => {
  const { control, keys, cam } = fly();
  const changes = [];
  control.addEventListener('change', () => changes.push(1));
  key(keys, 'keydown', 'KeyE');
  assert.equal(control.update(1 / 60), true, 'only camera.up moved');
  assert.equal(changes.length, 1);
  run(control, 59 / 60);
  key(keys, 'keyup', 'KeyE');
  closeVec(cam.up, [Math.sin(0.5), Math.cos(0.5), 0], T, 'roll right tips the top of the view to the right');
  closeVec(cam.position, [0, 0, 10], T);
  closeVec(cam.target, [0, 0, 0], T);
  // The picture turns the other way: banking right lifts the horizon on the right of the screen.
  const [x, y] = ndc(cam, [5, 0, 0]);
  assert.ok(x > 0 && y > 0, `a point on the right rises when the camera rolls right, got ${x}, ${y}`);
  hold(keys, control, 'KeyQ', 1);
  closeVec(cam.up, [0, 1, 0], T, 'Q undoes it');
  assert.equal(control.update(1 / 60), false, 'and nothing is held');
  control.dispose();
});

test('fly roll: yaw, pitch and movement use the rolled frame', () => {
  const { control, keys, cam } = fly({ rollSpeed: Math.PI / 2 });
  hold(keys, control, 'KeyE', 1); // on its side: camera up is +X, camera right is -Y
  closeVec(cam.up, [1, 0, 0], T);
  control.rollSpeed = 0.5;
  hold(keys, control, 'ArrowLeft', 1); // about camera up (+X): the view swings toward +Y
  closeVec(cam.target, [0, 10 * Math.sin(0.5), 10 - 10 * Math.cos(0.5)], T, 'yaw about the rolled up');
  closeVec(cam.up, [1, 0, 0], T);
  hold(keys, control, 'ArrowRight', 1);
  closeVec(cam.target, [0, 0, 0], T);
  hold(keys, control, 'ArrowUp', 1); // about camera right (-Y): the view swings toward +X
  closeVec(cam.target, [10 * Math.sin(0.5), 0, 10 - 10 * Math.cos(0.5)], T, 'pitch about the rolled right');
  hold(keys, control, 'ArrowDown', 1);
  closeVec(cam.target, [0, 0, 0], T);
  control.movementSpeed = 2;
  hold(keys, control, 'KeyR', 1);
  closeVec(cam.position, [2, 0, 10], T, 'R rises along the rolled up');
  hold(keys, control, 'KeyD', 1);
  closeVec(cam.position, [2, -2, 10], T, 'D strafes along the rolled right');
  hold(keys, control, 'KeyW', 1);
  closeVec(cam.position, [2, -2, 8], T, 'W flies along the view');
  control.dispose();
});

test('fly roll: a loop passes the vertical and comes back to the start', () => {
  const { control, keys, cam } = fly({ rollSpeed: 1 });
  key(keys, 'keydown', 'ArrowUp');
  for (let i = 0; i < 180; i++) {
    control.update(1 / 60);
    assert.doesNotThrow(() => cam.update(4 / 3, true), `frame ${i}`);
    orthonormal(cam, `frame ${i}`);
  }
  key(keys, 'keyup', 'ArrowUp');
  // Three radians of pitch: past straight up and upside down.
  closeVec(cam.up, [0, Math.cos(3), Math.sin(3)], T);
  closeVec(cam.target, [0, 10 * Math.sin(3), 10 - 10 * Math.cos(3)], T);
  key(keys, 'keydown', 'ArrowDown');
  run(control, 3);
  key(keys, 'keyup', 'ArrowDown');
  closeVec(cam.up, [0, 1, 0], T);
  closeVec(cam.target, [0, 0, 0], T);
  control.dispose();
});

test('fly roll: the frame stays square and the view length held over a long flight of every input', () => {
  const { control, keys, cam } = fly({ rollSpeed: 1.3, movementSpeed: 4 });
  const codes = ['KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyD', 'KeyR'];
  let seed = 7;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 400; i++) {
    const code = codes[Math.floor(next() * codes.length)];
    hold(keys, control, code, 0.25 + next() * 0.25);
    if (i % 3 === 0) hold(keys, control, codes[(i / 3) % codes.length], 0.1);
  }
  orthonormal(cam, 'after the flight');
  close(len(sub(cam.target, cam.position)), 10, 1e-6, 'view length');
  assert.doesNotThrow(() => cam.update(4 / 3, true));
  assert.ok(cam.matrix.every(Number.isFinite));
  control.dispose();
});

test('fly roll: an up parallel to the view falls back to the world frame, and disconnect clears Q and E', () => {
  const cam = camera({ position: [0, 0, 0], target: [0, 10, 0], up: [0, 1, 0] }),
    { control, keys } = fly({}, cam);
  hold(keys, control, 'KeyE', 0.5);
  assert.ok([...cam.up, ...cam.target].every(Number.isFinite));
  orthonormal(cam);
  assert.doesNotThrow(() => cam.update(4 / 3, true));
  key(keys, 'keydown', 'KeyQ');
  key(keys, 'keydown', 'KeyE');
  control.disconnect();
  assert.equal(control.moveState.rollLeft, 0);
  assert.equal(control.moveState.rollRight, 0);
  control.dispose();
});

test('trackball roll: a drag around the edge rolls the view and the scene follows the pointer', () => {
  const { el, cam, control } = ball(),
    points = [];
  // Clockwise around the ball's rim, at a steady radius of 300 px from the centre.
  for (let a = 0; a <= 0.6001; a += 0.05) points.push([400 + 300 * Math.cos(a), 300 + 300 * Math.sin(a)]);
  const before = ndc(cam, [4, 0, 0]);
  drag(el, control, points);
  assert.ok(cam.up[0] < -0.1, `the camera rolls against the drag, up ${cam.up}`);
  orthonormal(cam);
  close(len(sub(cam.position, cam.target)), 10, T);
  const after = ndc(cam, [4, 0, 0]);
  assert.ok(after[1] < before[1] - 0.05, 'a point on the right follows the pointer down the screen');
  control.dispose();
});

test('trackball roll: a drag straight across the centre has no twist, and a rim arc reports a change', () => {
  const { cam, control, el } = ball();
  drag(el, control, [
    [400, 300],
    [480, 300],
  ]);
  closeVec(cam.up, [0, 1, 0], T, 'a straight drag across the centre does not roll');
  control.dispose();

  const b = ball(),
    seen = [];
  b.control.addEventListener('change', () => seen.push(1));
  pointer(b.el, 'pointerdown', 700, 300);
  pointer(b.el, 'pointermove', 400 + 300 * Math.cos(0.3), 300 + 300 * Math.sin(0.3));
  assert.equal(b.control.update(1 / 60), true);
  assert.equal(seen.length, 1);
  pointer(b.el, 'pointerup', 700, 300);
  b.control.dispose();
});

test('trackball roll: dragging through the top carries the eye over the pole, right round', () => {
  const { el, cam, control } = ball();
  let sign = 1,
    crossed = false;
  for (let i = 0; i < 16; i++) {
    drag(el, control, [
      [400, 200],
      [400, 400],
    ]);
    orthonormal(cam, `drag ${i}`);
    close(len(sub(cam.position, cam.target)), 10, 1e-9);
    assert.doesNotThrow(() => cam.update(4 / 3, true));
    if (Math.sign(cam.position[2]) !== sign) {
      sign = -sign;
      crossed = true;
    }
  }
  assert.ok(crossed, 'the eye went past the pole to the far side');
  control.dispose();
});

test('trackball roll: coasting turns up with the eye, the same at 30 and 60 fps', () => {
  // The same drag at the same speed; only the frame rate of the coast differs.
  const fling = () => {
    const { el, cam, control } = ball({ staticMoving: false });
    pointer(el, 'pointerdown', 700, 280);
    pointer(el, 'pointermove', 700, 320);
    control.update(1 / 30);
    pointer(el, 'pointerup', 700, 320);
    return { cam, control };
  };
  const a = fling(),
    b = fling();
  const flung = [...a.cam.up];
  run(a.control, 1, 60);
  run(b.control, 1, 30);
  assert.ok(len(sub(a.cam.up, flung)) > 1e-3, 'up keeps turning after release');
  closeVec(a.cam.up, b.cam.up, 1e-9, 'coast');
  closeVec(a.cam.position, b.cam.position, 1e-8, 'coast');
  orthonormal(a.cam);
  a.control.dispose();
  b.control.dispose();
});

test('trackball roll: pan follows the rolled screen, reset restores up, long tumbles stay square', () => {
  const { el, cam, control } = ball();
  control.saveState();
  cam.up = [1, 0, 0]; // on its side: screen right is -Y
  pointer(el, 'pointerdown', 400, 300, { button: 2 });
  pointer(el, 'pointermove', 440, 300, { button: 2 });
  control.update(1 / 60);
  pointer(el, 'pointerup', 440, 300, { button: 2 });
  closeVec(cam.target, [0, 0.15, 0], T, 'drag right moves the camera toward screen left');
  control.reset();
  closeVec(cam.up, [0, 1, 0], 0, 'reset restores up');
  closeVec(cam.target, [0, 0, 0], 0);

  let seed = 3;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 1000; i++)
    drag(el, control, [
      [next() * 800, next() * 600],
      [next() * 800, next() * 600],
    ]);
  orthonormal(cam, 'after 1000 drags');
  close(len(sub(cam.position, cam.target)), 10, 1e-6);
  control.dispose();
});

test('entries: /fly and /trackball are the root classes and load no orbit code', () => {
  assert.equal(EntryFly, FlyControls);
  assert.equal(EntryTrackball, TrackballControls);
  const seen = new Set(),
    walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');
      assert.ok(!/class \w* extends \w+\s*\{[^]*?screenSpacePanning/.test(text), `${file} holds OrbitControls`);
      for (const [, next] of text.matchAll(/from\s*["']\.\/([\w.-]+\.js)["']/g)) walk(next);
    };
  walk('fly.js');
  walk('trackball.js');
  assert.ok(seen.size >= 2);
});
