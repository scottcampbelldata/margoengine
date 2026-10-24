import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { box } from '@margoengine/core';
import { CameraProjection } from '../../cameras/dist/index.js';
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
test('orbit: drags turn half a turn per element height; right lowers the azimuth, down lowers the polar angle', () => {
  const el = new FakeElement(),
    cam = camera({ position: [3, 4, 9], target: [0, 1, 0] }),
    orbit = new OrbitControls(cam, el);
  const events = [];
  for (const type of ['start', 'change', 'end']) orbit.addEventListener(type, () => events.push(type));
  const azimuth = orbit.getAzimuthalAngle(),
    polar = orbit.getPolarAngle(),
    distance = orbit.getDistance();
  drag(el, [400, 300], [460, 300]);
  close(orbit.getAzimuthalAngle(), azimuth - (Math.PI * 60) / 600, 1e-12, 'azimuth');
  close(orbit.getPolarAngle(), polar, 1e-12, 'polar unchanged');
  drag(el, [400, 300], [400, 330]);
  close(orbit.getPolarAngle(), polar - (Math.PI * 30) / 600, 1e-12, 'polar');
  close(orbit.getDistance(), distance, 1e-12, 'distance kept');
  closeVec(cam.target, [0, 1, 0], 0, 'target kept');
  assert.deepEqual([...new Set(events)], ['start', 'change', 'end']);
  orbit.rotateSpeed = 2;
  const a = orbit.getAzimuthalAngle();
  drag(el, [400, 300], [370, 300]);
  close(orbit.getAzimuthalAngle(), a + (2 * Math.PI * 30) / 600, 1e-12, 'rotateSpeed scales the rate');
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
  const run = (damping, fps, seconds) => {
    const el = new FakeElement(),
      cam = camera(),
      orbit = new OrbitControls(cam, el);
    orbit.enableDamping = damping;
    orbit.dampingFactor = 0.1;
    orbit.pan(30, -20); // before the drag, so both runs pan in the same screen frame
    drag(el, [400, 300], [520, 240]);
    const states = {},
      frames = Math.round(seconds * fps);
    for (let frame = 1; frame <= frames; frame++) {
      orbit.update(1 / fps);
      for (const mark of [1 / 6, 1])
        if (frame === Math.round(mark * fps)) states[mark] = [...cam.position, ...cam.target];
    }
    const final = [...cam.position, ...cam.target],
      quiet = orbit.update(1 / fps);
    orbit.dispose();
    return { states, quiet, final };
  };
  const at60 = run(true, 60, 20),
    at30 = run(true, 30, 20),
    undamped = run(false, 60, 1 / 6);
  for (const mark of [1 / 6, 1])
    closeVec(at30.states[mark], at60.states[mark], 1e-9, `30 fps equals 60 fps at ${mark} s`);
  assert.ok(Math.hypot(...sub(at60.states[1 / 6], undamped.final)) > 0.1, 'still easing after 1/6 s');
  closeVec(at60.final, undamped.final, 1e-6, 'settles on the undamped result');
  closeVec(at30.final, undamped.final, 1e-6, 'and at 30 fps');
  assert.equal(at60.quiet, false, 'a settled update reports no motion');
  // delta 0 keeps the pending motion.
  const cam = camera(),
    orbit = new OrbitControls(cam, new FakeElement());
  orbit.enableDamping = true;
  orbit.rotateLeft(0.5);
  assert.equal(orbit.update(0), false);
  closeVec(cam.position, [0, 0, 10], 0);
  assert.equal(orbit.update(1 / 60), true);
  orbit.dispose();
});

test('orbit: wheel dolly is exponential and inverse in and out, normalises line and page modes, respects min and max distance', () => {
  const el = new FakeElement(),
    cam = camera({ position: [3, 4, 9], target: [0, 1, 0] }),
    orbit = new OrbitControls(cam, el);
  const events = [];
  for (const type of ['start', 'change', 'end']) orbit.addEventListener(type, () => events.push(type));
  const wheel = (deltaY, deltaMode = 0, extra = {}) =>
    el.dispatch('wheel', { deltaY, deltaMode, clientX: 400, clientY: 300, ...extra });
  const d0 = orbit.getDistance();
  assert.ok(wheel(-100).defaultPrevented);
  assert.deepEqual(events, ['start', 'change', 'end']);
  close(orbit.getDistance(), d0 * 2 ** (-100 / 500), 1e-9, 'forward moves closer');
  wheel(100);
  close(orbit.getDistance(), d0, 1e-9, 'back is the exact inverse');
  wheel(-3, 1);
  close(orbit.getDistance(), d0 * 2 ** (-100 / 500), 1e-9, 'three lines equal one 100 px notch');
  wheel(3, 1);
  wheel(-1, 2);
  close(orbit.getDistance(), d0 * 2 ** (-800 / 500), 1e-9, 'a page is 800 px');
  wheel(1, 2);
  wheel(-10, 0, { ctrlKey: true });
  close(orbit.getDistance(), d0 * 2 ** (-80 / 500), 1e-9, 'Ctrl (pinch) boost');
  wheel(10, 0, { ctrlKey: true });
  orbit.zoomSpeed = 2;
  wheel(-100);
  close(orbit.getDistance(), d0 * 2 ** (-200 / 500), 1e-9, 'zoomSpeed scales the exponent');
  orbit.zoomSpeed = 1;
  orbit.minDistance = 5;
  orbit.maxDistance = 12;
  for (let i = 0; i < 50; i++) wheel(-100);
  close(orbit.getDistance(), 5, 1e-12, 'min distance');
  for (let i = 0; i < 50; i++) wheel(100);
  close(orbit.getDistance(), 12, 1e-12, 'max distance');
  closeVec(cam.target, [0, 1, 0], 1e-12, 'centre zoom keeps the target');
  orbit.enableZoom = false;
  assert.equal(wheel(-100).defaultPrevented, false, 'disabled zoom leaves the page alone');
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
  assert.equal(el.style.touchAction, 'none');
  const touch = (type, id, x, y) =>
    el.dispatch(type, { pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y });
  touch('pointerdown', 1, 400, 300);
  assert.equal(orbit.state, 'touch-rotate');
  touch('pointermove', 1, 460, 300);
  close(orbit.getAzimuthalAngle(), (-Math.PI * 60) / 600, 1e-12, 'one finger rotates like the mouse');
  // Second finger 40 px away; spreading to 80 px about a fixed midpoint halves the distance and does not pan.
  touch('pointerdown', 2, 500, 300);
  assert.equal(orbit.state, 'touch-dolly-pan');
  touch('pointermove', 2, 500, 300);
  const d = orbit.getDistance(),
    target = [...cam.target];
  touch('pointerdown', 9, 0, 0); // a third finger is tracked and ends the two-finger gesture
  assert.equal(orbit.state, 'none');
  touch('pointerup', 9, 0, 0);
  assert.equal(orbit.state, 'touch-dolly-pan');
  touch('pointermove', 1, 440, 300);
  touch('pointermove', 2, 520, 300);
  close(orbit.getDistance(), d / 2, 1e-9, '40 to 80 px halves the distance');
  touch('pointermove', 1, 460, 300);
  touch('pointermove', 2, 540, 300);
  assert.ok(Math.hypot(...sub(cam.target, target)) > 1e-3, 'a moving midpoint pans');
  assert.deepEqual([...el.captured].sort(), [1, 2]);
  touch('pointerup', 2, 540, 300);
  assert.equal(orbit.state, 'touch-rotate', 'one finger left continues as rotate');
  touch('pointerup', 1, 460, 300);
  assert.equal(orbit.state, 'none');
  assert.equal(el.captured.size, 0, 'captures released');
  orbit.enabled = false;
  touch('pointerdown', 3, 400, 300);
  assert.equal(orbit.state, 'none', 'disabled controls ignore touches');
  assert.equal(el.captured.size, 0);
  orbit.enabled = true;
  let changes = 0;
  orbit.addEventListener('change', () => changes++);
  orbit.reset();
  closeVec(cam.position, [0, 0, 10], 0, 'reset position');
  closeVec(cam.target, [0, 0, 0], 0, 'reset target');
  assert.equal(changes, 1, 'reset dispatches change');
  orbit.dispose();
  assert.equal(el.style.touchAction, 'auto', 'touch-action restored');
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

// ---------- FlyControls ----------

// ---------- FirstPersonControls ----------

// ---------- PointerLockControls ----------

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

test('transform: one gizmo unit is a fifth of the view height; dragging the X arrow moves the mesh by the dragged world distance', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine);
  gizmo.attach(mesh);
  engine.render();
  const half = 10 * Math.tan(Math.PI / 6);
  close(gizmo.frame().size, 0.2 * 2 * half, 1e-12, 'size at distance 10, fov 60');
  gizmo.setSize(2.5);
  close(gizmo.frame().size, 2.5 * 0.2 * 2 * half, 1e-12, 'user multiplier');
  gizmo.setSize(1);
  engine.camera.position = [0, 0, 20];
  close(gizmo.frame().size, 0.2 * 2 * 20 * Math.tan(Math.PI / 6), 1e-12, 'linear in distance');
  engine.camera.fov = 170;
  const wide = gizmo.frame().size;
  assert.ok(Number.isFinite(wide) && wide < 20 * 2 * 0.2 * 2.5, 'very wide lenses stay bounded');
  engine.camera.fov = 60;
  engine.camera.position = [0, 0, 10];
  engine.render();
  const pixelsPerUnit = 600 / (2 * half),
    s = gizmo.frame().size;
  close(s * pixelsPerUnit, 120, 1e-9, 'a gizmo unit is 120 px of a 600 px view');
  const grab = [400 + 0.5 * s * pixelsPerUnit, 300];
  assert.equal(gizmo.pick(grab[0], grab[1]), 'X');
  drag(canvas, grab, [grab[0] + 75, grab[1] + 10]);
  close(mesh.position.x, 75 / pixelsPerUnit, 1e-4, 'moved by the dragged distance');
  close(mesh.position.y, 0, 1e-9, 'constrained to X');
  gizmo.dispose();
  engine.dispose();
});

test('transform: a view gizmo uses its camera, picks and drags only inside its rectangle', async () => {
  const { engine, canvas } = await engineWith();
  const mesh = engine.createMesh().setGeometry(box()),
    camera = new Camera({ position: [0, 0, 10], target: [0, 0, 0] }),
    gizmo = new TransformControls(engine, { view: { camera, viewport: [0.5, 0, 0.5, 1] } });
  gizmo.attach(mesh);
  engine.camera.position = [0, 10, 0.01]; // the engine camera looks elsewhere
  const pixelsPerUnit = 600 / (2 * 10 * Math.tan(Math.PI / 6)),
    grab = [600 + 0.5 * gizmo.frame().size * pixelsPerUnit, 300];
  assert.equal(gizmo.pick(grab[0], grab[1]), 'X', 'centre of the right half');
  assert.equal(gizmo.pick(grab[0] - 400, grab[1]), null, 'outside the view');
  drag(canvas, grab, [grab[0] + 52, grab[1]]);
  close(mesh.position.x, 52 / pixelsPerUnit, 1e-4, 'x');
  gizmo.view = { camera, viewport: [400, 0, 400, 600], pixels: true };
  assert.equal(gizmo.pick(grab[0] + 52, grab[1]), 'X', 'pixel viewport');
  gizmo.dispose();
  engine.dispose();
});

test('transform: constant screen size, picking and drags under an orthographic camera (@margoengine/cameras)', async () => {
  const { engine, canvas } = await engineWith();
  const projection = new CameraProjection({ mode: 'orthographic', height: 2 });
  projection.attach(engine.camera);
  const mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine);
  gizmo.attach(mesh);
  engine.render();
  engine.camera.update(800 / 600, true);
  const size = gizmo.frame().size;
  close(size, 0.2 * 2, 1e-6, 'same screen fraction as the perspective gizmo (half height 1)');
  engine.camera.position = [0, 0, 40];
  engine.camera.update(800 / 600, true);
  close(gizmo.frame().size, size, 1e-6, 'independent of distance');
  mesh.setPosition([0, 0, 45]); // nearer than the eye, inside the orthographic depth range
  engine.render();
  engine.camera.update(800 / 600, true);
  close(gizmo.frame().size, size, 1e-6, 'and of a mesh behind the eye');
  mesh.setPosition([0, 0, 0]);
  projection.zoom = 2;
  engine.camera.update(800 / 600, true);
  close(gizmo.frame().size, size / 2, 1e-6, 'follows zoom');
  projection.zoom = 1;
  engine.render();
  engine.camera.update(800 / 600, true);
  // Half height 1 on a 600 px view: 300 px per world unit.
  const grab = [400 + 0.5 * size * 300, 300];
  assert.equal(gizmo.pick(grab[0], grab[1]), 'X');
  assert.equal(gizmo.pick(400, 300 - 0.5 * size * 300), 'Y');
  drag(canvas, grab, [grab[0] + 60, grab[1]]);
  close(mesh.position.x, 60 / 300, 1e-4, 'drag follows the cursor at 300 px per unit');
  gizmo.dispose();
  projection.dispose();
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
