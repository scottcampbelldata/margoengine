// OrbitControls geometry that does not depend on the tuning (rates, wheel law): pan follows the cursor, pinch ratio,
// auto-rotation period, view snaps, angle limits, reset, position equal to target; plus the gizmo hide rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { CameraProjection } from '../../cameras/dist/index.js';
import { OrbitControls, MapControls, SOLIDWORKS, TOUCH, buildGizmo } from '../dist/index.js';

class Element {
  listeners = new Map();
  clientWidth = 800;
  clientHeight = 600;
  style = { touchAction: 'auto' };
  captured = new Set();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 };
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
  dispatch(type, extra = {}) {
    const event = {
      type,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 400,
      clientY: 300,
      timeStamp: 0,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...extra,
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    return event;
  }
}
const close = (actual, expected, tolerance, message = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} expected ${expected}, got ${actual}`);
const closeVec = (a, b, tolerance, message = '') => b.forEach((v, i) => close(a[i], v, tolerance, `${message}[${i}]`));
const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (a) => Math.hypot(...a);
const rig = (position = [3, 4, 9], target = [0, 1, 0], Control = OrbitControls) => {
  const camera = new Camera({ position, target }),
    element = new Element(),
    orbit = new Control(camera, element);
  const events = [];
  for (const type of ['start', 'change', 'end', 'fit']) orbit.addEventListener(type, () => events.push(type));
  return { camera, element, orbit, events };
};
const drag = (element, from, to, extra = {}, steps = 4) => {
  element.dispatch('pointerdown', { clientX: from[0], clientY: from[1], ...extra });
  for (let i = 1; i <= steps; i++)
    element.dispatch('pointermove', {
      clientX: from[0] + ((to[0] - from[0]) * i) / steps,
      clientY: from[1] + ((to[1] - from[1]) * i) / steps,
      ...extra,
    });
  element.dispatch('pointerup', { clientX: to[0], clientY: to[1], ...extra });
};

test('pan: the point at the target depth follows the cursor (perspective, fixed and default orthographic)', () => {
  // Perspective: world units per pixel at the target are 2 * distance * tan(fov / 2) / height.
  const { camera, element, orbit } = rig();
  const d = orbit.getDistance(),
    perPixel = (2 * d * Math.tan(Math.PI / 6)) / 600;
  const forward = sub([0, 1, 0], [3, 4, 9]).map((v) => v / d),
    right = [-forward[2], 0, forward[0]].map((v, _, a) => v / Math.hypot(a[0], a[2]));
  drag(element, [400, 300], [460, 300], { button: 2 });
  closeVec(
    sub(camera.target, [0, 1, 0]),
    right.map((v) => -60 * perPixel * v),
    1e-9,
    'perspective',
  );
  orbit.dispose();
  // Fixed height 4 (half height 2): 90 px is 90 * 4 / 600 = 0.6 world units.
  for (const [options, half] of [
    [{ mode: 'orthographic', height: 4 }, 2],
    [{ mode: 'orthographic' }, Math.sqrt(50) * Math.tan(Math.PI / 6)],
  ]) {
    const r = rig([3, 4, 5], [0, 0, 0]),
      projection = new CameraProjection(options);
    projection.attach(r.camera);
    r.camera.update(4 / 3, true);
    r.orbit.pan(90, 0);
    r.orbit.update(0);
    const moved = sub(r.camera.target, [0, 0, 0]);
    close(len(moved), (90 * 2 * half) / 600, 1e-6, `ortho ${JSON.stringify(options)} pan length`);
    close(moved[1], 0, 1e-12, 'pan along screen right stays level');
    closeVec(sub(r.camera.position, r.camera.target), [3, 4, 5], 1e-12, 'position follows');
    r.orbit.dispose();
    projection.dispose();
  }
});

test('map controls: ground pan keeps the height of target and camera; one finger pans, two fingers dolly and rotate', () => {
  const { camera, element, orbit } = rig([3, 4, 9], [0, 1, 0], MapControls);
  drag(element, [400, 300], [450, 360]);
  assert.equal(camera.target[1], 1);
  assert.equal(camera.position[1], 4);
  assert.deepEqual(orbit.touches, { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE });
  const touch = (type, id, x, y) =>
    element.dispatch(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y });
  touch('pointerdown', 4, 380, 300);
  assert.equal(orbit.state, 'touch-pan');
  touch('pointerdown', 5, 420, 300);
  assert.equal(orbit.state, 'touch-dolly-rotate');
  const azimuth = orbit.getAzimuthalAngle(),
    distance = orbit.getDistance();
  touch('pointermove', 5, 460, 300);
  assert.ok(orbit.getDistance() < distance, 'spread dollies in');
  assert.ok(orbit.getAzimuthalAngle() < azimuth, 'midpoint moving right turns like a right drag');
  touch('pointerup', 5, 460, 300);
  touch('pointerup', 4, 380, 300);
  assert.equal(element.captured.size, 0);
  orbit.dispose();
});

test('pinch: 40 px to 80 px apart halves the distance at zoomSpeed 1 (and squares with zoomSpeed 2)', () => {
  for (const zoomSpeed of [1, 2]) {
    const { element, orbit } = rig([0, 0, 10], [0, 0, 0]);
    orbit.zoomSpeed = zoomSpeed;
    orbit.enablePan = false;
    const touch = (type, id, x) =>
      element.dispatch(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: 300 });
    touch('pointerdown', 1, 380);
    touch('pointerdown', 2, 420);
    touch('pointermove', 2, 440);
    touch('pointermove', 1, 360);
    close(orbit.getDistance(), 10 * 0.5 ** zoomSpeed, 1e-9, `zoomSpeed ${zoomSpeed}`);
    orbit.dispose();
  }
});

test('autoRotate: speed 2 is one turn every 30 s, counterclockwise from above; never during a gesture', () => {
  const { camera, element, orbit } = rig([0, 0, 10], [0, 0, 0]);
  orbit.autoRotate = true;
  assert.equal(orbit.update(1), true);
  close(orbit.getAzimuthalAngle(), (2 * Math.PI) / 30, 1e-12, 'one second');
  for (let i = 0; i < 29 * 60; i++) orbit.update(1 / 60);
  closeVec(camera.position, [0, 0, 10], 1e-9, 'a full turn after 30 s');
  element.dispatch('pointerdown', {});
  const before = [...camera.position];
  orbit.update(1);
  closeVec(camera.position, before, 0, 'paused while dragging');
  orbit.dispose();
});

test('view snaps keep distance and target; azimuth and polar limits end exactly on the limits', () => {
  const views = {
    Digit1: [0, 0, 1],
    Digit3: [-1, 0, 0],
    Digit5: [0, 1, 0],
    Digit7: [1, 1, 1].map((v) => v / Math.sqrt(3)),
  };
  for (const [code, want] of Object.entries(views)) {
    const { camera, element, orbit } = rig();
    orbit.setProfile(SOLIDWORKS);
    orbit.listenToKeyEvents(element);
    const r0 = orbit.getDistance();
    assert.ok(element.dispatch('keydown', { code, key: code, ctrlKey: true }).defaultPrevented);
    const d = sub(camera.position, camera.target);
    closeVec(
      d.map((v) => v / len(d)),
      want,
      2e-6,
      code,
    );
    close(len(d), r0, 1e-9, `${code} distance`);
    assert.deepEqual([...camera.target], [0, 1, 0]);
    orbit.dispose();
  }
  // Wrapping azimuth range through PI: allowed [3, PI] and [-PI, -3].
  const { element, orbit } = rig([0, 0, -10], [0, 0, 0]);
  orbit.minAzimuthAngle = 3;
  orbit.maxAzimuthAngle = -3;
  drag(element, [400, 300], [700, 300]);
  close(orbit.getAzimuthalAngle(), 3, 1e-9, 'right drag stops at min');
  drag(element, [400, 300], [100, 300]);
  drag(element, [400, 300], [100, 300]);
  close(orbit.getAzimuthalAngle(), -3, 1e-9, 'left drag stops at max');
  orbit.dispose();
});

test('saveState / reset, fit double click, and position equal to target stays finite', () => {
  const { camera, element, orbit, events } = rig();
  drag(element, [400, 300], [470, 340]);
  orbit.saveState();
  const saved = [...camera.position];
  drag(element, [400, 300], [300, 200]);
  orbit.reset();
  closeVec(camera.position, saved, 0, 'reset to the saved state');
  assert.deepEqual([...new Set(events)], ['start', 'change', 'end']);
  orbit.dispose();
  // SolidWorks: double middle click within 400 ms and 6 px fits; the presses also start (and end) a rotate gesture.
  const r = rig();
  r.orbit.setProfile(SOLIDWORKS);
  for (const timeStamp of [1000, 1300]) {
    r.element.dispatch('pointerdown', { button: 1, timeStamp });
    r.element.dispatch('pointerup', { button: 1 });
  }
  assert.deepEqual([...new Set(r.events)], ['start', 'end', 'fit']);
  closeVec(r.camera.position, [3, 4, 9], 0, 'a click without motion keeps the camera');
  r.orbit.dispose();
  // Position equal to the target: no NaN, the camera steps off along +Z by the distance floor.
  const n = rig([1, 2, 3], [1, 2, 3]);
  n.orbit.update();
  assert.ok([...n.camera.position, ...n.camera.target].every(Number.isFinite), 'finite');
  assert.ok(len(sub(n.camera.position, n.camera.target)) > 0, 'separated');
  n.orbit.minDistance = 2;
  n.orbit.update();
  close(n.orbit.getDistance(), 2, 1e-12, 'pushed out to minDistance');
  n.orbit.dispose();
});

test('gizmo: axes within 5 degrees of the view and planes within 10 degrees of edge-on are hidden', () => {
  const names = (mode, degrees) => {
    const a = (degrees * Math.PI) / 180;
    return buildGizmo({
      mode,
      origin: [0, 0, 0],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      size: 1,
      eye: [Math.sin(a), 0, Math.cos(a)],
      up: [0, 1, 0],
      show: { X: true, Y: true, Z: true },
      axis: null,
      dragging: false,
    })
      .map((h) => h.name)
      .sort();
  };
  assert.deepEqual(names('translate', 0), ['X', 'XY', 'XYZ', 'Y']);
  assert.deepEqual(names('translate', 45), ['X', 'XY', 'XYZ', 'Y', 'YZ', 'Z']);
  assert.deepEqual(names('translate', 90), ['XYZ', 'Y', 'YZ', 'Z']);
  assert.deepEqual(names('scale', 0), ['X', 'XY', 'XYZ', 'Y']);
  assert.deepEqual(names('translate', 4.9), names('translate', 0), 'axis still hidden at 4.9 degrees');
  assert.ok(names('translate', 5.1).includes('Z'), 'axis back at 5.1 degrees');
  assert.ok(!names('translate', 9.9).includes('YZ') && names('translate', 10.1).includes('YZ'), 'plane at 10 degrees');
  assert.ok(names('rotate', 0).includes('Z'), 'rotate mode unaffected');
});
