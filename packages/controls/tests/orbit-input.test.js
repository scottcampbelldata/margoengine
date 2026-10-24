// OrbitControls touch reservation, per-profile capture, listener arbitration and fixed-size orthographic cursor dolly.
// Mouse capture ownership and exact top/bottom views are covered by orbit-ownership-poles.test.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Camera } from '@margoengine/core';
import { OrbitControls, MapControls, PROFILES, TOUCH, SOLIDWORKS } from '../dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';

class Element {
  listeners = new Map();
  clientWidth = 800;
  clientHeight = 600;
  style = { touchAction: 'auto' };
  captured = new Set();
  calls = [];
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
    this.calls.push(['set', id]);
    this.captured.add(id);
  }
  releasePointerCapture(id) {
    this.calls.push(['release', id]);
    this.captured.delete(id);
  }
  hasPointerCapture(id) {
    return this.captured.has(id);
  }
  emit(type, extra = {}) {
    const event = { type, pointerId: 1, clientX: 200, clientY: 200, pointerType: 'mouse', button: 0, timeStamp: 100 };
    Object.assign(event, { preventDefault() {}, stopImmediatePropagation: () => (event.stopped = true) }, extra);
    for (const fn of [...(this.listeners.get(type) ?? [])]) if (!event.stopped) fn(event);
  }
}
const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const orbit = (configure = () => {}) => {
  const element = new Element(),
    control = new OrbitControls(new Camera({ position: [0, 0, 5] }), element);
  configure(control);
  return { element, control };
};
// The pixel of world point p on an 800x600 view.
const screen = (camera, p) => {
  const m = camera.matrix,
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [
    ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w) * 400 + 400,
    300 - ((m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) * 300,
  ];
};

test('unhandled pen, touch and disabled presses leave another handler’s pointer capture alone', () => {
  const cases = [
    [{ button: 3 }],
    [{ button: 0 }, (c) => c.setProfile(SOLIDWORKS)], // left is selection in SolidWorks
    [{ button: 2, pointerType: 'pen' }, (c) => (c.enablePan = false)],
    [{ button: 0 }, (c) => (c.enabled = false)],
    [{ pointerType: 'touch' }, (c) => (c.touches = { ONE: null, TWO: null })],
    [{ pointerType: 'touch' }, (c) => (c.enableRotate = c.enableZoom = c.enablePan = false)],
  ];
  for (const [event, configure] of cases) {
    const { element, control } = orbit(configure);
    element.captured.add(1);
    element.emit('pointerdown', event);
    assert.equal(control.state, 'none');
    control.dispose();
    assert.deepEqual(element.calls, [], JSON.stringify(event));
    assert.ok(element.hasPointerCapture(1));
  }
});

test('every profile captures only the drags it binds', () => {
  for (const profile of Object.values(PROFILES))
    for (let button = 0; button < 5; button++) {
      const { element, control } = orbit((c) => c.setProfile(profile));
      element.emit('pointerdown', { button });
      assert.deepEqual(element.calls, control.state === 'none' ? [] : [['set', 1]]);
      control.dispose();
    }
});

test('the first touch is reserved for an enabled two-touch gesture when one-touch is unbound', () => {
  for (const action of [TOUCH.DOLLY_PAN, TOUCH.DOLLY_ROTATE]) {
    const { element, control } = orbit((c) => (c.touches = { ONE: null, TWO: action })),
      touch = (type, id) => element.emit(type, { pointerType: 'touch', pointerId: id, clientX: id * 100 });
    touch('pointerdown', 1);
    assert.equal(control.state, 'none');
    touch('pointerdown', 2);
    assert.equal(control.state, action === TOUCH.DOLLY_PAN ? 'touch-dolly-pan' : 'touch-dolly-rotate');
    touch('pointerup', 2);
    touch('pointerup', 1);
    assert.deepEqual(element.calls, [
      ['set', 1],
      ['set', 2],
      ['release', 2],
      ['release', 1],
    ]);
    control.dispose();
  }
});

test('a handler earlier in line can keep the pointer by disabling or stopping propagation', () => {
  for (const arbitration of ['disabled', 'stopped']) {
    const element = new Element();
    let control;
    element.addEventListener('pointerdown', (event) => {
      if (arbitration === 'disabled') control.enabled = false;
      else event.stopImmediatePropagation();
    });
    control = new OrbitControls(new Camera({ position: [0, 0, 5] }), element);
    element.emit('pointerdown');
    assert.equal(control.state, 'none');
    assert.deepEqual(element.calls, []);
    control.dispose();
  }
});

// Fixed-size orthographic projection: dolly changes only the distance, so the cursor must add no pan.
function fixedRig({ options = { height: 4 }, cursor = true, Control = OrbitControls, offset = [3, 4, 5] } = {}) {
  const target = [2, 3, -4],
    camera = new Camera({ position: target.map((v, i) => v + offset[i]), target }),
    projection = new CameraProjection({ mode: 'orthographic', ...options });
  projection.attach(camera);
  const element = new Element(),
    control = new Control(camera, element);
  control.zoomToCursor = cursor;
  camera.update(4 / 3, true);
  return { camera, projection, control, element, dispose: () => (control.dispose(), projection.dispose()) };
}
const wheel = (r, deltaY, x = 600, y = 150) =>
  r.element.emit('wheel', { deltaY, deltaMode: 0, clientX: x, clientY: y });

test('fixedOrthographic is true only for an orthographic projection with a fixed size', () => {
  for (const [options, fixed] of [
    [{ mode: 'orthographic', height: 4 }, true],
    [{ mode: 'orthographic', left: -1, right: 5, top: 4, bottom: -1 }, true],
    [{ mode: 'orthographic' }, false],
    [{ mode: 'perspective', height: 4 }, false],
  ]) {
    const camera = new Camera({ position: [0, 0, 5] }),
      projection = new CameraProjection(options);
    projection.attach(camera);
    assert.equal(projection.fixedOrthographic, fixed);
    assert.equal(camera.fixedOrthographic, fixed);
    projection.dispose();
    assert.equal('fixedOrthographic' in camera, false);
  }
});

test('fixed height or bounds: cursor dolly keeps the target and every pixel', () => {
  for (const options of [{ height: 4 }, { left: -1, right: 5, top: 4, bottom: -1, zoom: 2 }])
    for (const offset of [
      [0, 5, 0],
      [3, 4, 5],
    ]) {
      const r = fixedRig({ options, offset }),
        target = [...r.camera.target],
        point = [2.5, 3.2, -3.6],
        before = screen(r.camera, point),
        d = r.control.getDistance();
      wheel(r, -200);
      r.camera.update(4 / 3, true);
      assert.deepEqual(r.camera.target, target);
      assert.ok(r.control.getDistance() < d);
      assert.ok(distance(screen(r.camera, point), before) < 1e-6);
      r.dispose();
    }
});

test('fixed size: cursor-on equals cursor-off with pending pan and rotation', () => {
  for (const Control of [OrbitControls, MapControls]) {
    const rigs = [false, true].map((cursor) => fixedRig({ cursor, Control }));
    for (const r of rigs) {
      r.control.pan(37, -19);
      r.control.rotateLeft(0.11);
      wheel(r, -120);
      r.control.update(1 / 60);
    }
    assert.deepEqual(rigs[1].camera.position, rigs[0].camera.position);
    assert.deepEqual(rigs[1].camera.target, rigs[0].camera.target);
    for (const r of rigs) r.dispose();
  }
});

test('default orthographic and perspective still zoom about the cursor', () => {
  for (const mode of ['orthographic', 'perspective']) {
    const r = fixedRig({ options: { mode } }),
      target = [...r.camera.target];
    wheel(r, -200);
    assert.notDeepEqual(r.camera.target, target);
    r.dispose();
  }
});
