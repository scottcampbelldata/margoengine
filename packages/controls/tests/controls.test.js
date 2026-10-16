import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { box } from '@margoengine/core';
import {
  OrbitControls,
  MapControls,
  TrackballControls,
  FlyControls,
  FirstPersonControls,
  PointerLockControls,
  TransformControls,
  tessellate,
} from '../dist/index.js';

// ---------- fakes ----------
class FakeTarget {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  get listenerCount() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  dispatch(type, props = {}) {
    const event = {
      type,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
      ...props,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
      if (event.stopped) break;
    }
    return event;
  }
}
class FakeElement extends FakeTarget {
  constructor(width = 800, height = 600) {
    super();
    this.clientWidth = width;
    this.clientHeight = height;
    this.width = width;
    this.height = height;
    this.style = { touchAction: 'auto' };
    this.captured = new Set();
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
  hasPointerCapture(id) {
    return this.captured.has(id);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  getContext() {
    return null;
  }
}
const pointer = (el, type, x, y, extra = {}) =>
  el.dispatch(type, { clientX: x, clientY: y, pointerId: 1, button: 0, pointerType: 'mouse', ...extra });
function drag(el, from, to, extra = {}, steps = 4) {
  pointer(el, 'pointerdown', from[0], from[1], extra);
  for (let i = 1; i <= steps; i++)
    pointer(
      el,
      'pointermove',
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
      extra,
    );
  pointer(el, 'pointerup', to[0], to[1], extra);
}
const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} expected ${expected}, got ${actual}`);
const closeVec = (a, b, tolerance, message) => a.forEach((v, i) => close(v, b[i], tolerance, `${message ?? ''}[${i}]`));
const camera = (options = {}) => new Camera({ position: [0, 0, 10], target: [0, 0, 0], ...options });
const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (a) => Math.hypot(...a);

test('continuous orbit updates reuse their camera vectors without mutating the initial values', () => {
  const initialPosition = [0, 2, 10],
    initialTarget = [1, 0, 0];
  const c = camera({ position: initialPosition, target: initialTarget }),
    control = new OrbitControls(c, new FakeElement());
  control.autoRotate = true;
  control.enableDamping = true;
  control.update(1 / 60);
  const position = c.position,
    target = c.target;
  for (let i = 0; i < 120; i++) {
    control.update(1 / 60);
    assert.equal(c.position, position);
    assert.equal(c.target, target);
    close(control.getDistance(), Math.sqrt(105), 1e-10);
  }
  assert.deepEqual(initialPosition, [0, 2, 10]);
  assert.deepEqual(initialTarget, [1, 0, 0]);
  control.dispose();
});
// Same projection as the engine (WebGPU matrix from Camera.update) to CSS pixels.
function toPixel(cam, point, width = 800, height = 600) {
  cam.update(width / height, true);
  const m = cam.matrix,
    p = [...point, 1],
    c = [0, 1, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * p[3]);
  return [((c[0] / c[2] + 1) / 2) * width, ((1 - c[1] / c[2]) / 2) * height];
}

// ---------- module safety ----------
test('import and construction touch no browser globals', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  const el = new FakeElement(),
    controls = [
      new OrbitControls(camera(), el),
      new TrackballControls(camera(), el, { keyTarget: new FakeTarget() }),
      new FlyControls(camera(), el, { keyTarget: new FakeTarget() }),
      new FirstPersonControls(camera(), el, { keyTarget: new FakeTarget() }),
      new PointerLockControls(camera(), el, { document: new FakeTarget() }),
    ];
  assert.ok(el.listenerCount > 0);
  for (const control of controls) control.dispose();
  assert.equal(el.listenerCount, 0);
});

// ---------- OrbitControls ----------
test('orbit: horizontal and vertical drags change azimuth and polar angles by 2*PI*pixels/height', () => {
  const el = new FakeElement(),
    cam = camera(),
    orbit = new OrbitControls(cam, el);
  const events = [];
  for (const type of ['start', 'change', 'end']) orbit.addEventListener(type, () => events.push(type));
  drag(el, [400, 300], [460, 300]);
  close(orbit.getAzimuthalAngle(), (-2 * Math.PI * 60) / 600, 1e-9, 'azimuth');
  close(orbit.getDistance(), 10, 1e-9, 'distance');
  drag(el, [400, 300], [400, 360]);
  close(orbit.getPolarAngle(), Math.PI / 2 - (2 * Math.PI * 60) / 600, 1e-9, 'polar');
  closeVec(cam.target, [0, 0, 0], 1e-12);
  assert.equal(events[0], 'start');
  assert.ok(events.includes('change'));
  assert.equal(events.at(-1), 'end');
  assert.equal(el.captured.size, 0, 'pointer capture released');
  orbit.dispose();
});

test('orbit: leaving an exact pole keeps the heading given by camera.up (ViewCube top view from the side)', () => {
  for (const [y, up, heading] of [
    [10, [-1, 0, 0], Math.PI / 2],
    [-10, [1, 0, 0], Math.PI / 2],
    [10, [0, 0, -1], 0],
  ]) {
    const cam = camera(),
      orbit = new OrbitControls(cam, new FakeElement());
    cam.up = up;
    cam.position = [0, y, 0];
    close(orbit.getAzimuthalAngle(), heading, 1e-12, `pole azimuth ${y} ${up}`);
    orbit.rotateUp(y > 0 ? -0.1 : 0.1);
    orbit.update(0);
    close(Math.atan2(cam.position[0], cam.position[2]), heading, 1e-9, `azimuth after leaving the pole ${y} ${up}`);
    orbit.dispose();
  }
});

test('orbit: polar and azimuth clamping, and the poles stay renderable', () => {
  const el = new FakeElement(),
    cam = camera(),
    orbit = new OrbitControls(cam, el);
  orbit.minPolarAngle = 1;
  orbit.maxPolarAngle = 2;
  orbit.minAzimuthAngle = -0.5;
  orbit.maxAzimuthAngle = 0.5;
  drag(el, [400, 300], [400, 900]);
  close(orbit.getPolarAngle(), 1, 1e-9, 'min polar');
  drag(el, [400, 300], [400, -900]);
  close(orbit.getPolarAngle(), 2, 1e-9, 'max polar');
  drag(el, [400, 300], [550, 300]);
  close(orbit.getAzimuthalAngle(), -0.5, 1e-9, 'min azimuth');
  drag(el, [400, 300], [100, 300]);
  close(orbit.getAzimuthalAngle(), 0.5, 1e-9, 'max azimuth');
  orbit.minPolarAngle = 0;
  orbit.maxPolarAngle = Math.PI;
  drag(el, [400, 300], [400, 5000]);
  assert.ok(orbit.getPolarAngle() > 0 && orbit.getPolarAngle() < 1e-5);
  assert.doesNotThrow(() => cam.update(4 / 3, true), 'camera near the pole still renders');
  orbit.dispose();
});

test('orbit: damping converges to the undamped result, frame-rate independently', () => {
  const run = (fps) => {
    const el = new FakeElement(),
      cam = camera(),
      orbit = new OrbitControls(cam, el);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.1;
    drag(el, [400, 300], [460, 330]);
    for (let i = 0; i < fps / 2; i++) orbit.update(1 / fps);
    const half = [orbit.getAzimuthalAngle(), orbit.getPolarAngle()];
    let changes = 0;
    orbit.addEventListener('change', () => changes++);
    for (let i = 0; i < fps * 20; i++) orbit.update(1 / fps);
    const final = [orbit.getAzimuthalAngle(), orbit.getPolarAngle()];
    const quiet = orbit.update(1 / fps);
    orbit.dispose();
    return { half, final, quiet, changes };
  };
  const a = run(60),
    b = run(30);
  closeVec(a.final, [(-2 * Math.PI * 60) / 600, Math.PI / 2 - (2 * Math.PI * 30) / 600], 1e-6, 'converged');
  closeVec(a.half, b.half, 1e-9, '30 fps matches 60 fps after 0.5 s');
  assert.ok(Math.abs(a.half[0]) < Math.abs(a.final[0]) && Math.abs(a.half[0]) > 0.9 * Math.abs(a.final[0]));
  assert.equal(a.quiet, false, 'no change once settled');
});

test('orbit: wheel dolly respects min and max distance', () => {
  const el = new FakeElement(),
    orbit = new OrbitControls(camera(), el);
  orbit.minDistance = 5;
  orbit.maxDistance = 20;
  el.dispatch('wheel', { deltaY: -100, deltaMode: 0, clientX: 400, clientY: 300 });
  close(orbit.getDistance(), 10 * 0.95 ** 1, 1e-9, 'one notch dollies in by 0.95');
  for (let i = 0; i < 100; i++) el.dispatch('wheel', { deltaY: -500, deltaMode: 0, clientX: 400, clientY: 300 });
  close(orbit.getDistance(), 5, 1e-12, 'min distance');
  for (let i = 0; i < 100; i++) el.dispatch('wheel', { deltaY: 500, deltaMode: 0, clientX: 400, clientY: 300 });
  close(orbit.getDistance(), 20, 1e-12, 'max distance');
  const event = el.dispatch('wheel', { deltaY: 100, deltaMode: 0, clientX: 400, clientY: 300 });
  assert.ok(event.defaultPrevented);
  orbit.dispose();
});

test('orbit: zoom to cursor keeps the point under the cursor fixed', () => {
  const el = new FakeElement(),
    cam = camera({ position: [3, 4, 9], target: [0, 1, 0] }),
    orbit = new OrbitControls(cam, el);
  orbit.zoomToCursor = true;
  const cursor = [610, 180];
  // World point under the cursor on the plane through the target facing the camera.
  cam.update(800 / 600, true);
  const f = sub(cam.target, cam.position).map((v) => v / len(sub(cam.target, cam.position)));
  const r = [-f[2], 0, f[0]].map((v) => v / Math.hypot(f[0], f[2])),
    u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const t = Math.tan(Math.PI / 6),
    nx = (cursor[0] / 800) * 2 - 1,
    ny = 1 - (cursor[1] / 600) * 2;
  const dir = f.map((v, i) => v + (r[i] * nx * t * 4) / 3 + u[i] * ny * t),
    k = len(sub(cam.target, cam.position)) / dir.reduce((s, v, i) => s + v * f[i], 0);
  const point = cam.position.map((v, i) => v + dir[i] * k);
  closeVec(toPixel(cam, point), cursor, 1e-4, 'setup (Float32 camera matrix)');
  const before = orbit.getDistance();
  for (let i = 0; i < 5; i++)
    el.dispatch('wheel', { deltaY: -200, deltaMode: 0, clientX: cursor[0], clientY: cursor[1] });
  assert.ok(orbit.getDistance() < before * 0.85, 'dollied in');
  closeVec(toPixel(cam, point), cursor, 1e-4, 'point stays under cursor');
  el.dispatch('wheel', { deltaY: 300, deltaMode: 0, clientX: cursor[0], clientY: cursor[1] });
  closeVec(toPixel(cam, point), cursor, 1e-4, 'and when zooming out');
  orbit.dispose();
});

test('orbit: panning moves target and position equally, in screen space or on the ground', () => {
  const el = new FakeElement(),
    cam = camera({ position: [0, 3, 10], target: [0, 3, 0] }),
    orbit = new OrbitControls(cam, el);
  drag(el, [400, 300], [450, 330], { button: 2 });
  const dt = sub(cam.target, [0, 3, 0]),
    dp = sub(cam.position, [0, 3, 10]),
    scale = (2 * 10 * Math.tan(Math.PI / 6)) / 600;
  closeVec(dt, dp, 1e-12, 'equal motion');
  closeVec(dt, [-50 * scale, 30 * scale, 0], 1e-9, 'screen-space pan follows the cursor');
  orbit.screenSpacePanning = false;
  const start = [...cam.target];
  drag(el, [400, 300], [400, 360], { button: 0, shiftKey: true });
  const d = sub(cam.target, start);
  close(d[1], 0, 1e-12, 'ground pan keeps height');
  close(d[2], -60 * scale, 1e-9, 'ground pan moves forward');
  orbit.listenToKeyEvents(el);
  const before = [...cam.target];
  const key = el.dispatch('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' });
  assert.ok(key.defaultPrevented);
  close(cam.target[0] - before[0], -7 * scale, 1e-9, 'arrow key pans 7 px');
  orbit.dispose();
  assert.equal(el.listenerCount, 0, 'key listener removed on dispose');
});

test('orbit: touch rotate, two-finger dolly and pan, pointer capture, enabled and reset', () => {
  const el = new FakeElement(),
    cam = camera(),
    orbit = new OrbitControls(cam, el);
  orbit.saveState();
  const touch = (type, id, x, y) =>
    el.dispatch(type, { clientX: x, clientY: y, pointerId: id, button: 0, pointerType: 'touch' });
  touch('pointerdown', 1, 400, 300);
  touch('pointermove', 1, 460, 300);
  close(orbit.getAzimuthalAngle(), (-2 * Math.PI * 60) / 600, 1e-9, 'one finger rotates');
  touch('pointerdown', 2, 500, 300);
  assert.ok(el.captured.has(1) && el.captured.has(2));
  const distance = orbit.getDistance(),
    target = [...cam.target];
  touch('pointermove', 2, 540, 300); // spread 40 -> 80: dolly in by 2, midpoint +20 px
  close(orbit.getDistance(), distance / 2, 1e-9, 'pinch dollies');
  assert.ok(len(sub(cam.target, target)) > 0, 'midpoint pans');
  touch('pointerup', 2, 540, 300);
  touch('pointerup', 1, 460, 300);
  assert.equal(el.captured.size, 0);
  assert.equal(orbit.state, 'none');
  orbit.enabled = false;
  const frozen = [...cam.position];
  drag(el, [400, 300], [500, 300]);
  closeVec(cam.position, frozen, 0, 'disabled ignores input');
  orbit.enabled = true;
  orbit.reset();
  closeVec(cam.position, [0, 0, 10], 0);
  closeVec(cam.target, [0, 0, 0], 0);
  orbit.autoRotate = true;
  orbit.update(1);
  close(orbit.getAzimuthalAngle(), (2 * Math.PI) / 30, 1e-9, 'auto-rotate: one turn per 30 s at speed 2');
  orbit.dispose();
  assert.equal(el.listenerCount, 0);
  assert.equal(el.style.touchAction, 'auto');
});

test('orbit: disabling mid-drag (as TransformControls does) stops the gesture', () => {
  const el = new FakeElement(),
    cam = camera(),
    orbit = new OrbitControls(cam, el);
  pointer(el, 'pointerdown', 400, 300);
  pointer(el, 'pointermove', 420, 300);
  const position = [...cam.position];
  orbit.enabled = false;
  pointer(el, 'pointermove', 500, 300);
  orbit.enabled = true;
  pointer(el, 'pointermove', 600, 300);
  closeVec(cam.position, position, 0);
  assert.equal(orbit.state, 'none');
  assert.equal(el.captured.size, 0);
  orbit.dispose();
});

test('map controls: left drag pans along the ground plane', () => {
  const el = new FakeElement(),
    cam = camera({ position: [0, 10, 10], target: [0, 0, 0] }),
    map = new MapControls(cam, el);
  drag(el, [400, 300], [450, 250]);
  close(cam.target[1], 0, 1e-12, 'stays on the ground');
  assert.ok(cam.target[0] < 0 && cam.target[2] > 0);
  close(cam.position[1], 10, 1e-12);
  drag(el, [400, 300], [460, 300], { button: 2 });
  assert.ok(Math.abs(map.getAzimuthalAngle()) > 0.1, 'right drag rotates');
  map.dispose();
});

// ---------- TrackballControls ----------
test('trackball: rotates around the target, coasts with damping, and never crosses a pole', () => {
  const el = new FakeElement(),
    keys = new FakeTarget(),
    cam = camera(),
    ball = new TrackballControls(cam, el, { keyTarget: keys });
  pointer(el, 'pointerdown', 400, 300);
  pointer(el, 'pointermove', 480, 300);
  ball.update(1 / 60);
  close(len(cam.position), 10, 1e-9, 'distance kept');
  const angle = Math.atan2(cam.position[0], cam.position[2]);
  close(angle, -80 / 400, 1e-6, 'horizontal drag of half-width/5 turns 0.2 rad');
  pointer(el, 'pointerup', 480, 300);
  const coastStart = Math.atan2(cam.position[0], cam.position[2]);
  for (let i = 0; i < 600; i++) ball.update(1 / 60);
  const coastEnd = Math.atan2(cam.position[0], cam.position[2]);
  assert.ok(coastEnd < coastStart - 0.05, 'keeps coasting');
  assert.equal(ball.update(1 / 60), false, 'and stops');
  ball.staticMoving = true;
  pointer(el, 'pointerdown', 400, 300);
  for (let i = 1; i <= 40; i++) {
    pointer(el, 'pointermove', 400, 300 + i * 30);
    ball.update(1 / 60);
    assert.doesNotThrow(() => cam.update(4 / 3, true));
  }
  pointer(el, 'pointerup', 400, 1500);
  assert.ok(
    Math.hypot(cam.position[0] - cam.target[0], cam.position[2] - cam.target[2]) > 0,
    'eye stays off the Y axis',
  );
  assert.ok(cam.position[1] > 9.99, 'stopped at the top pole');
  // Pan and zoom.
  const target = [...cam.target];
  drag(el, [400, 300], [440, 300], { button: 2 });
  ball.update(1 / 60);
  close(len(sub(cam.target, target)), (40 / 800) * 10 * 0.3, 1e-6, 'pan');
  el.dispatch('wheel', { deltaY: 400, deltaMode: 0 });
  ball.update(1 / 60);
  close(len(sub(cam.position, cam.target)), 10 * (1 + 0.1 * 1.2), 1e-6, 'wheel zoom');
  ball.dispose();
  assert.equal(el.listenerCount + keys.listenerCount, 0);
});

// ---------- FlyControls ----------
test('fly: WASD moves in the camera frame, arrows yaw and pitch, roll keys are ignored', () => {
  const el = new FakeElement(),
    keys = new FakeTarget(),
    cam = camera(),
    fly = new FlyControls(cam, el, { keyTarget: keys });
  fly.movementSpeed = 2;
  keys.dispatch('keydown', { code: 'KeyW' });
  fly.update(1);
  keys.dispatch('keyup', { code: 'KeyW' });
  closeVec(cam.position, [0, 0, 8], 1e-9, 'forward');
  closeVec(cam.target, [0, 0, -2], 1e-9);
  keys.dispatch('keydown', { code: 'KeyD' });
  fly.update(0.5);
  keys.dispatch('keyup', { code: 'KeyD' });
  closeVec(cam.position, [1, 0, 8], 1e-9, 'strafe right');
  keys.dispatch('keydown', { code: 'KeyR' });
  fly.update(0.5);
  keys.dispatch('keyup', { code: 'KeyR' });
  closeVec(cam.position, [1, 1, 8], 1e-9, 'up');
  fly.rollSpeed = 0.25;
  keys.dispatch('keydown', { code: 'ArrowLeft' });
  fly.update(1);
  keys.dispatch('keyup', { code: 'ArrowLeft' });
  const d = sub(cam.target, cam.position);
  close(Math.atan2(-d[0], -d[2]), 0.5, 1e-9, 'yaw left by 2 * rollSpeed per second');
  const before = [...cam.target];
  keys.dispatch('keydown', { code: 'KeyQ' });
  fly.update(1);
  keys.dispatch('keyup', { code: 'KeyQ' });
  closeVec(cam.target, before, 0, 'no roll');
  keys.dispatch('keydown', { code: 'ArrowUp' });
  for (let i = 0; i < 100; i++) fly.update(1);
  assert.doesNotThrow(() => cam.update(1, true), 'pitch stops short of the pole');
  fly.dispose();
  assert.equal(el.listenerCount + keys.listenerCount, 0);
});

test('fly: pointer offset steers and the left button flies forward', () => {
  const el = new FakeElement(),
    cam = camera(),
    fly = new FlyControls(cam, el, { keyTarget: new FakeTarget() });
  pointer(el, 'pointermove', 600, 300); // half-way to the right edge
  fly.rollSpeed = 1;
  fly.update(0.1);
  const d = sub(cam.target, cam.position);
  close(Math.atan2(-d[0], -d[2]), -0.5 * 2 * 0.1, 1e-9, 'turns right');
  pointer(el, 'pointerdown', 400, 300);
  pointer(el, 'pointermove', 400, 300);
  fly.update(1);
  assert.ok(cam.position[2] < 10, 'flies forward');
  pointer(el, 'pointerup', 400, 300);
  fly.dispose();
});

// ---------- FirstPersonControls ----------
test('first person: movement, pointer look and latitude limits', () => {
  const el = new FakeElement(),
    keys = new FakeTarget(),
    cam = camera(),
    fp = new FirstPersonControls(cam, el, { keyTarget: keys });
  close(fp.longitude, 180, 1e-9);
  close(fp.latitude, 0, 1e-9);
  fp.movementSpeed = 4;
  keys.dispatch('keydown', { code: 'KeyW' });
  fp.update(0.5);
  keys.dispatch('keyup', { code: 'KeyW' });
  closeVec(cam.position, [0, 0, 8], 1e-9, 'forward');
  keys.dispatch('keydown', { code: 'KeyA' });
  fp.update(0.25);
  keys.dispatch('keyup', { code: 'KeyA' });
  closeVec(cam.position, [-1, 0, 8], 1e-9, 'left');
  pointer(el, 'pointermove', 500, 300);
  fp.update(1);
  close(fp.longitude, 180 - (100 * 0.005 * 180) / Math.PI, 1e-9, 'turn right by lookSpeed per pixel');
  pointer(el, 'pointermove', 400, -100000);
  fp.update(1);
  close(fp.latitude, 85, 1e-9, 'latitude clamp');
  assert.doesNotThrow(() => cam.update(4 / 3, true));
  fp.lookAt(0, 0, 100);
  close(fp.latitude, 0, 1e-6);
  assert.ok(Math.abs(fp.longitude) < 1);
  fp.dispose();
  assert.equal(el.listenerCount + keys.listenerCount, 0);
});

// ---------- PointerLockControls ----------
test('pointer lock: lock events, mouse look with polar limits, WASD helpers', () => {
  const el = new FakeElement(),
    doc = new FakeTarget(),
    cam = camera(),
    plc = new PointerLockControls(cam, el, { document: doc });
  let requested = null;
  el.requestPointerLock = (options) => {
    requested = options;
  };
  const events = [];
  for (const type of ['lock', 'unlock', 'change']) plc.addEventListener(type, () => events.push(type));
  plc.lock();
  assert.deepEqual(requested, { unadjustedMovement: false });
  doc.pointerLockElement = el;
  doc.dispatch('pointerlockchange');
  assert.equal(plc.isLocked, true);
  assert.equal(events[0], 'lock');
  doc.dispatch('mousemove', { movementX: 100, movementY: 0 });
  let d = plc.getDirection();
  close(Math.atan2(-d[0], -d[2]), -0.2, 1e-9, 'yaw by 0.002 rad per pixel');
  plc.maxPolarAngle = Math.PI / 2 + 0.3;
  doc.dispatch('mousemove', { movementX: 0, movementY: 100000 });
  d = plc.getDirection();
  close(Math.asin(d[1]), -0.3, 1e-9, 'pitch limited by maxPolarAngle');
  // WASD moves along the ground even when looking down.
  plc.movementSpeed = 3;
  const start = [...cam.position];
  doc.dispatch('keydown', { code: 'KeyW' });
  plc.update(1);
  doc.dispatch('keyup', { code: 'KeyW' });
  const moved = sub(cam.position, start);
  close(moved[1], 0, 1e-12, 'no vertical motion');
  close(Math.hypot(moved[0], moved[2]), 3, 1e-9, 'speed');
  doc.dispatch('keydown', { code: 'KeyD' });
  doc.dispatch('keydown', { code: 'KeyW' });
  plc.update(1);
  close(len(sub(cam.position, start)) > 3 ? 1 : 0, 1, 0);
  doc.pointerLockElement = null;
  doc.dispatch('pointerlockchange');
  assert.equal(plc.isLocked, false);
  assert.equal(events.includes('unlock'), true);
  assert.equal(plc.pressed.size, 0, 'keys cleared on unlock');
  const frozen = [...cam.target];
  doc.dispatch('mousemove', { movementX: 50, movementY: 0 });
  closeVec(cam.target, frozen, 0, 'no look when unlocked');
  plc.dispose();
  assert.equal(el.listenerCount + doc.listenerCount, 0);
});

// ---------- TransformControls ----------
async function engineWith(cameraOptions = { position: [0, 0, 10], target: [0, 0, 0] }) {
  const canvas = new FakeElement(800, 600);
  const store = await TransformStore.create(32);
  const renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Runtime(canvas, store, renderer, cameraOptions, null);
  return { engine, canvas };
}
// Grab a handle at world point `from` and release at world point `to`, through real pointer events.
function dragWorld(canvas, engine, from, to, steps = 3) {
  const a = toPixel(engine.camera, from),
    b = toPixel(engine.camera, to);
  drag(canvas, a, b, {}, steps);
  return [a, b];
}
const at = (o, axis, t) => o.map((v, i) => v + axis[i] * t);

test('transform: dragging the X arrow moves the mesh by the dragged world distance', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box());
  const gizmo = new TransformControls(engine);
  gizmo.attach(mesh);
  engine.render();
  const f = gizmo.frame(),
    s = f.size;
  close(s, (10 * 1.9 * Math.tan(Math.PI / 6)) / 4, 1e-9, 'three.js constant screen size');
  const pixelsPerUnit = 600 / (2 * 10 * Math.tan(Math.PI / 6));
  const grab = [400 + 0.5 * s * pixelsPerUnit, 300];
  assert.equal(gizmo.pick(grab[0], grab[1]), 'X');
  const events = [];
  for (const type of ['dragging-changed', 'mouseDown', 'mouseUp', 'objectChange'])
    gizmo.addEventListener(type, (e) => events.push(type + (e.value === undefined ? '' : ':' + e.value)));
  drag(canvas, grab, [grab[0] + 104, grab[1] + 37]);
  close(mesh.position.x, 104 / pixelsPerUnit, 1e-4, 'x');
  close(mesh.position.y, 0, 1e-12);
  close(mesh.position.z, 0, 1e-12);
  assert.deepEqual(
    [events[0], events[1], events.at(-2), events.at(-1)],
    ['dragging-changed:true', 'mouseDown', 'mouseUp', 'dragging-changed:false'],
  );
  assert.ok(events.includes('objectChange'));
  // Snapping in world space.
  engine.render();
  gizmo.setTranslationSnap(0.5);
  dragWorld(
    canvas,
    engine,
    at([mesh.position.x, 0, 0], [1, 0, 0], 0.5 * s),
    at([mesh.position.x, 0, 0], [1, 0, 0], 0.5 * s + 0.6),
  );
  close(mesh.position.x, 2.5, 1e-6, 'snapped world x');
  // Plane handle XY moves in both axes, screen handle moves in the view plane.
  engine.render();
  gizmo.setTranslationSnap(null);
  const o = [mesh.position.x, 0, 0],
    corner = [o[0] + 0.22 * s, 0.22 * s, 0];
  const pc = toPixel(engine.camera, corner);
  assert.equal(gizmo.pick(pc[0], pc[1]), 'XY');
  dragWorld(canvas, engine, corner, [corner[0] + 1, corner[1] - 0.5, 0]);
  close(mesh.position.x, o[0] + 1, 1e-4);
  close(mesh.position.y, -0.5, 1e-4);
  close(mesh.position.z, 0, 1e-9);
  engine.render();
  const centre = toPixel(engine.camera, [mesh.position.x, mesh.position.y, 0]);
  assert.equal(gizmo.pick(centre[0], centre[1]), 'XYZ');
  gizmo.dispose();
  engine.dispose();
});

test('transform: constant screen size, picking and drags under an orthographic camera (@margoengine/cameras)', async () => {
  const { CameraProjection } = await import('../../cameras/dist/index.js');
  const { engine, canvas } = await engineWith(),
    projection = new CameraProjection({ height: 4 });
  engine.use(projection);
  const mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine);
  gizmo.attach(mesh);
  const arrowPixels = () => {
    engine.render();
    const s = gizmo.frame().size,
      a = toPixel(
        engine.camera,
        mesh.position.x === undefined ? [0, 0, 0] : [mesh.position.x, mesh.position.y, mesh.position.z],
      ),
      b = toPixel(engine.camera, [mesh.position.x + s, mesh.position.y, mesh.position.z]);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  };
  // Same on-screen size as the perspective gizmo: 1.9 / 8 of the view height.
  close(arrowPixels(), (600 * 1.9) / 8, 1e-6, 'height 4');
  projection.zoom = 2;
  close(arrowPixels(), (600 * 1.9) / 8, 1e-6, 'zoomed in');
  mesh.setPosition([0, 0, 12]);
  close(arrowPixels(), (600 * 1.9) / 8, 1e-6, 'nearer than the eye (inside the orthographic depth range)');
  assert.deepEqual(gizmo.frame().eye, [-0, -0, 1], 'parallel view: the eye direction is the view direction everywhere');
  const s = gizmo.frame().size,
    grab = toPixel(engine.camera, [0.5 * s, 0, 12]);
  assert.equal(gizmo.pick(grab[0], grab[1]), 'X');
  drag(canvas, grab, [grab[0] + 90, grab[1] + 20]);
  close(mesh.position.x, 90 / 300, 1e-6, '300 px per unit at half-height 1');
  close(mesh.position.y, 0, 1e-9);
  gizmo.dispose();
  const orbit = new OrbitControls(engine);
  orbit.pan(90, 0);
  orbit.update(0);
  close(engine.camera.target[0], -90 / 300, 1e-9, 'orbit pan follows the cursor at any orthographic zoom');
  orbit.dispose();
  engine.dispose();
});

test('transform: local versus world space for a rotated mesh', async () => {
  const { engine, canvas } = await engineWith({ position: [6, 5, 9], target: [0, 0, 0] });
  const mesh = engine
    .createMesh()
    .setGeometry(box())
    .setRotation([0, Math.PI / 2, 0]); // local X points along world -Z
  const gizmo = new TransformControls(engine, { space: 'local' });
  gizmo.attach(mesh);
  engine.render();
  let f = gizmo.frame();
  closeVec(f.axes[0], [0, 0, -1], 1e-6, 'local X axis');
  dragWorld(canvas, engine, at([0, 0, 0], f.axes[0], 0.6 * f.size), at([0, 0, 0], f.axes[0], 0.6 * f.size + 1.25));
  closeVec([mesh.position.x, mesh.position.y, mesh.position.z], [0, 0, -1.25], 1e-4, 'moved along local X');
  gizmo.setSpace('world');
  engine.render();
  f = gizmo.frame();
  closeVec(f.axes[0], [1, 0, 0], 0, 'world X axis');
  const o = [0, 0, -1.25];
  dragWorld(canvas, engine, at(o, [1, 0, 0], 0.6 * f.size), at(o, [1, 0, 0], 0.6 * f.size + 0.75));
  closeVec([mesh.position.x, mesh.position.y, mesh.position.z], [0.75, 0, -1.25], 1e-4, 'moved along world X');
  // Local-space snapping snaps the offset along the local axis.
  gizmo.setSpace('local');
  gizmo.setTranslationSnap(1);
  engine.render();
  f = gizmo.frame();
  const p = [0.75, 0, -1.25];
  dragWorld(canvas, engine, at(p, f.axes[0], 0.6 * f.size), at(p, f.axes[0], 0.6 * f.size + 1.4));
  closeVec([mesh.position.x, mesh.position.y, mesh.position.z], [0.75, 0, -2.25], 1e-4, 'local snap of offset');
  gizmo.dispose();
  engine.dispose();
});

test('transform: rotation follows the ring exactly and snaps', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box());
  const gizmo = new TransformControls(engine, { mode: 'rotate' });
  gizmo.attach(mesh);
  engine.render();
  const s = gizmo.frame().size,
    ring = (angle) => [Math.cos(angle) * s, Math.sin(angle) * s, 0];
  const start = toPixel(engine.camera, ring(Math.PI / 4));
  assert.equal(gizmo.pick(start[0], start[1]), 'Z');
  const toAngle = (a) => {
    const p = toPixel(engine.camera, ring(a));
    return p;
  };
  pointer(canvas, 'pointerdown', ...start);
  for (const a of [0.6, 0.9, 1.2, Math.PI / 4 + (37 * Math.PI) / 180]) pointer(canvas, 'pointermove', ...toAngle(a));
  close(mesh.rotation.z, (37 * Math.PI) / 180, 1e-4, 'follows cursor');
  pointer(canvas, 'pointerup', ...toAngle(1));
  gizmo.setRotationSnap(Math.PI / 12);
  mesh.setRotation([0, 0, 0]);
  engine.render();
  drag(canvas, start, toAngle(Math.PI / 4 + (37 * Math.PI) / 180));
  close(mesh.rotation.z, Math.PI / 6, 1e-6, '37 degrees snaps to 30');
  // Through the atan2 seam: more than 180 degrees stays continuous.
  gizmo.setRotationSnap(null);
  mesh.setRotation([0, 0, 0]);
  engine.render();
  pointer(canvas, 'pointerdown', ...start);
  let turned = 0;
  for (let i = 1; i <= 15; i++) {
    turned = i * 0.3;
    pointer(canvas, 'pointermove', ...toAngle(Math.PI / 4 + turned));
  }
  const angles = [];
  gizmo.addEventListener('objectChange', () => angles.push(mesh.rotation.z));
  pointer(canvas, 'pointermove', ...toAngle(Math.PI / 4 + turned));
  pointer(canvas, 'pointerup', 0, 0);
  const z = mesh.rotation.z;
  close(Math.cos(z), Math.cos(turned), 1e-4, 'cos');
  close(Math.sin(z), Math.sin(turned), 1e-4, 'sin past 180 degrees');
  // View ring (E) rotates about the view axis.
  mesh.setRotation([0, 0, 0]);
  engine.render();
  const e0 = toPixel(engine.camera, [1.25 * s, 0, 0]);
  assert.equal(gizmo.pick(e0[0], e0[1]), 'E');
  drag(canvas, e0, toPixel(engine.camera, [0, 1.25 * s, 0]));
  close(mesh.rotation.z, Math.PI / 2, 1e-4, 'E ring quarter turn');
  // Free trackball inside the rings.
  mesh.setRotation([0, 0, 0]);
  engine.render();
  const inside = toPixel(engine.camera, [0.3 * s, -0.4 * s, 0]);
  assert.equal(gizmo.pick(inside[0], inside[1]), 'XYZE');
  drag(canvas, inside, [inside[0] + 50, inside[1]]);
  assert.ok(Math.abs(mesh.rotation.y) > 0.1 && Math.abs(mesh.rotation.x) < 1e-4, 'horizontal free drag turns about Y');
  gizmo.dispose();
  engine.dispose();
});

test('transform: scale handles, uniform scale and scale snapping', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box());
  const gizmo = new TransformControls(engine, { mode: 'scale' });
  gizmo.attach(mesh);
  engine.render();
  const s = gizmo.frame().size;
  dragWorld(canvas, engine, [0.5 * s, 0, 0], [1.0 * s, 0, 0]);
  closeVec([mesh.scale.x, mesh.scale.y, mesh.scale.z], [2, 1, 1], 1e-4, 'axis drag doubles X');
  gizmo.setScaleSnap(0.25);
  engine.render();
  dragWorld(canvas, engine, [0, 0.5 * s, 0], [0, 0.5 * s * 1.6, 0]);
  closeVec([mesh.scale.x, mesh.scale.y, mesh.scale.z], [2, 1.5, 1], 1e-6, '1.6 snaps to 1.5');
  gizmo.setScaleSnap(null);
  engine.render();
  const pixelsPerUnit = (600 / (2 * 10 * Math.tan(Math.PI / 6))) * s;
  assert.equal(gizmo.pick(400, 300), 'XYZ');
  drag(canvas, [400, 300], [400 + pixelsPerUnit / 2, 300]);
  closeVec([mesh.scale.x, mesh.scale.y, mesh.scale.z], [3, 2.25, 1.5], 1e-4, 'uniform x1.5');
  gizmo.dispose();
  engine.dispose();
});

test('transform: parented meshes are dragged in the parent space', async () => {
  const { engine, canvas } = await engineWith({ position: [4, 6, 12], target: [1, 2, 1] });
  const parent = engine
    .createMesh()
    .setPosition([1, 2, 3])
    .setScale([2, 2, 2])
    .setRotation([0, Math.PI / 2, 0]);
  const child = engine.createMesh(parent).setGeometry(box()).setPosition([1, 0, 0]);
  const gizmo = new TransformControls(engine);
  gizmo.attach(child);
  engine.render();
  const store = engine.store,
    world = (id) => Array.from(store.matrices.subarray(id * 16 + 12, id * 16 + 15));
  closeVec(gizmo.frame().origin, [1, 2, 1], 1e-5, 'gizmo at the world position');
  let s = gizmo.frame().size;
  dragWorld(canvas, engine, [1 + 0.6 * s, 2, 1], [1 + 0.6 * s + 1.5, 2, 1]);
  closeVec(
    [child.position.x, child.position.y, child.position.z],
    [1, 0, 0.75],
    1e-4,
    'local position in parent space',
  );
  engine.render();
  closeVec(world(1), [2.5, 2, 1], 1e-4, 'world moved by exactly 1.5 along world X');
  // World-space rotation about Z of a child whose parent is rotated about Y.
  gizmo.setMode('rotate');
  engine.render();
  s = gizmo.frame().size;
  const o = world(1),
    ring = (a) => [o[0] + Math.cos(a) * s, o[1] + Math.sin(a) * s, o[2]];
  const cam = engine.camera,
    p0 = toPixel(cam, ring(Math.PI / 4));
  assert.equal(gizmo.pick(p0[0], p0[1]), 'Z');
  drag(canvas, p0, toPixel(cam, ring(Math.PI / 4 + Math.PI / 2)), {}, 6);
  engine.render();
  const m = store.matrices.subarray(16, 32),
    column = (c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]].map((v) => v / 2);
  // Before: world X axis of the child = parent R_y(90) X = -Z. After R_z(90) in world: -Z stays -Z; world Y axis (+Y) turns to -X.
  closeVec(column(0), [0, 0, -1], 1e-4, 'child X column');
  closeVec(column(1), [-1, 0, 0], 1e-4, 'child Y column');
  closeVec(world(1), [2.5, 2, 1], 1e-4, 'rotation keeps the position');
  // Scale is local to the child.
  gizmo.setMode('scale');
  engine.render();
  s = gizmo.frame().size;
  const ax = gizmo.frame().axes[0];
  dragWorld(canvas, engine, at(world(1), ax, 0.5 * s), at(world(1), ax, 0.75 * s));
  close(child.scale.x, 1.5, 1e-4, 'local X scale');
  gizmo.dispose();
  engine.dispose();
});

test('transform: hover, axis toggles, dragging-changed disables OrbitControls, dispose', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box());
  const orbit = new OrbitControls(engine.camera, canvas);
  const gizmo = new TransformControls(engine);
  gizmo.addEventListener('dragging-changed', (event) => {
    orbit.enabled = !event.value;
  });
  gizmo.attach(mesh);
  engine.render();
  const s = gizmo.frame().size,
    x = toPixel(engine.camera, [0.6 * s, 0, 0]);
  const axes = [];
  gizmo.addEventListener('axis-changed', (e) => axes.push(e.value));
  pointer(canvas, 'pointermove', ...x);
  assert.equal(gizmo.axis, 'X');
  assert.deepEqual(axes, ['X']);
  const yellow = gizmo.handles().find((h) => h.name === 'X').prims[0].colors[0];
  assert.deepEqual(yellow, [1, 1, 0, 1], 'hovered handle is highlighted');
  const camera = [...engine.camera.position];
  drag(canvas, x, [x[0] + 80, x[1]]);
  closeVec(engine.camera.position, camera, 0, 'orbit did not move while dragging the gizmo');
  assert.ok(mesh.position.x > 0.5);
  assert.equal(orbit.enabled, true);
  drag(canvas, [100, 100], [160, 100]);
  assert.ok(len(sub(engine.camera.position, camera)) > 1, 'orbit works away from the gizmo');
  gizmo.showX = false;
  engine.render();
  assert.equal(
    gizmo.handles().some((h) => h.name.includes('X')),
    false,
    'X handles hidden',
  );
  // Tessellation for the overlay: highlighted handle produces yellow triangles in front of nothing else needed.
  gizmo.showX = true;
  gizmo.axis = 'X';
  const prims = gizmo.handles().flatMap((h) => h.prims);
  engine.camera.update(800 / 600, true);
  const vertices = tessellate(prims, engine.camera.matrix, 800, 600);
  assert.ok(vertices.length > 0 && vertices.length % 24 === 0);
  let yellowVertices = 0;
  for (let i = 0; i < vertices.length; i += 8)
    if (vertices[i + 4] === 1 && vertices[i + 5] === 1 && vertices[i + 6] === 0) yellowVertices++;
  assert.ok(yellowVertices > 30);
  for (const mode of ['translate', 'rotate', 'scale']) {
    gizmo.setMode(mode);
    gizmo.setSpace('local');
    mesh.setRotation([0.4, 0.6, 0]);
    engine.render();
    engine.camera.update(800 / 600, true);
    const handles = gizmo.handles(),
      lines = handles
        .flatMap((h) => h.prims)
        .filter((p) => p.kind === 'lines')
        .reduce((n, p) => n + p.points.length / 2, 0);
    const triangles = handles
      .flatMap((h) => h.prims)
      .filter((p) => p.kind === 'triangles')
      .reduce((n, p) => n + p.points.length / 3, 0);
    const out = tessellate(
      handles.flatMap((h) => h.prims),
      engine.camera.matrix,
      800,
      600,
    );
    assert.equal(out.length, (2 * lines + triangles) * 24, `${mode}: every line becomes two triangles`);
    for (let i = 0; i < out.length; i += 8)
      assert.ok(out[i + 3] > 0 && out.slice(i, i + 8).every(Number.isFinite), `${mode}: finite clip vertex`);
  }
  gizmo.setMode('translate');
  gizmo.setSpace('world');
  mesh.setRotation([0, 0, 0]);
  assert.equal(engine.hasPlugin(gizmo.pluginName), true);
  gizmo.dispose();
  orbit.dispose();
  assert.equal(canvas.listenerCount, 0, 'every listener removed');
  assert.equal(engine.hasPlugin(gizmo.pluginName), false, 'overlay plugin removed');
  // A disposed mesh detaches.
  const g2 = new TransformControls(engine);
  g2.attach(mesh);
  mesh.dispose();
  assert.equal(g2.frame(), null);
  g2.dispose();
  engine.dispose();
});

test('controls built from an engine update before each render and are disposed with it', async () => {
  const { engine, canvas } = await engineWith();
  const orbit = new OrbitControls(engine);
  assert.equal(orbit.element, canvas);
  orbit.autoRotate = true;
  engine.render({ delta: 0.5 });
  close(orbit.getAzimuthalAngle(), ((2 * Math.PI) / 60) * 2 * 0.5, 1e-9, 'auto-updated by the render');
  engine.dispose();
  assert.equal(canvas.listenerCount, 0, 'engine dispose disposes controls');
});

test('Fly Shift preserves configured speed and remains slow until both Shift keys release',()=>{
 const c=camera(),el=new FakeElement(),control=new FlyControls(c,el,{keyTarget:el});control.movementSpeed=2;control.movementSpeedMultiplier=3;
 try{
  el.dispatch('keydown',{code:'KeyW'});control.update(1);close(c.position[2],4,1e-9);
  el.dispatch('keydown',{code:'ShiftLeft'});el.dispatch('keydown',{code:'ShiftRight'});assert.equal(control.movementSpeedMultiplier,3);control.update(1);close(c.position[2],3.4,1e-9);
  el.dispatch('keyup',{code:'ShiftLeft'});control.update(1);close(c.position[2],2.8,1e-9);
  el.dispatch('keyup',{code:'ShiftRight'});control.update(0.1);close(c.position[2],2.2,1e-9);assert.equal(control.movementSpeedMultiplier,3);
 }finally{control.dispose();}
});
