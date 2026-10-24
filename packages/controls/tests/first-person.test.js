import test from 'node:test';
import assert from 'node:assert/strict';
import { FirstPersonControls, PointerLockControls } from '../dist/index.js';
import { FakeElement, FakeTarget, camera, close, closeVec, key, pointer, run } from './control-fakes.js';

const T = 1e-9;
const RAD = Math.PI / 180;

// ---------- FirstPersonControls ----------
function walker(options = {}, cameraOptions) {
  const el = new FakeElement(),
    keys = new FakeTarget(),
    cam = camera(cameraOptions),
    control = new FirstPersonControls(cam, el, { keyTarget: keys });
  Object.assign(control, options);
  return { el, keys, cam, control };
}
const hold = (keys, control, code, seconds) => {
  key(keys, 'keydown', code);
  run(control, seconds);
  key(keys, 'keyup', code);
};
// Polar angle of the view from +Y and heading atan2(x, z).
const view = (cam) => {
  const d = cam.target.map((v, i) => v - cam.position[i]),
    l = Math.hypot(...d);
  return { polar: Math.acos(d[1] / l), heading: Math.atan2(d[0], d[2]), length: l };
};

test('first person: defaults and orientation read from the camera', () => {
  const { control } = walker();
  for (const [name, value] of Object.entries({
    movementSpeed: 1,
    lookSpeed: 0.005,
    lookVertical: true,
    autoForward: false,
    activeLook: true,
    heightSpeed: false,
    heightCoef: 1,
    heightMin: 0,
    heightMax: 1,
    constrainVertical: false,
    verticalMin: 0,
    verticalMax: Math.PI,
    mouseDragOn: false,
  }))
    assert.equal(control[name], value, name);
  close(control.latitude, 0, T);
  close(control.longitude, 180, T);
  control.dispose();
  const tilted = walker({}, { position: [3, 4, 9], target: [0, 1, 0] });
  close(tilted.control.latitude, -17.5484006138, T);
  close(tilted.control.longitude, -161.565051177, T);
  tilted.control.update(1);
  closeVec(tilted.cam.target, [0, 1, 0], T, 'a centred pointer keeps the view');
  tilted.control.dispose();
});

test('first person: keys and buttons move in the camera frame', () => {
  let { control, keys, cam } = walker({ movementSpeed: 4 });
  hold(keys, control, 'KeyW', 0.5);
  hold(keys, control, 'KeyA', 0.25);
  closeVec(cam.position, [-1, 0, 8], T);
  closeVec(cam.target, [-1, 0, -2], T);
  control.dispose();

  ({ control, keys, cam } = walker());
  hold(keys, control, 'ArrowUp', 0.5);
  hold(keys, control, 'ArrowRight', 0.5);
  hold(keys, control, 'KeyR', 0.5);
  hold(keys, control, 'KeyF', 0.25);
  closeVec(cam.position, [0.5, 0.25, 9.5], T, 'arrows and R/F');
  closeVec(cam.target, [0.5, 0.25, -0.5], T);
  hold(keys, control, 'ArrowDown', 0.5);
  hold(keys, control, 'ArrowLeft', 0.5);
  hold(keys, control, 'KeyD', 0.25);
  hold(keys, control, 'KeyS', 0.25);
  closeVec(cam.position, [0.25, 0.25, 10.25], T, 'back and sideways');
  control.dispose();

  ({ control, keys, cam } = walker());
  const el = control.element;
  pointer(el, 'pointermove', 400, 300);
  pointer(el, 'pointerdown', 400, 300, { button: 0 });
  assert.equal(control.mouseDragOn, true);
  assert.ok(el.captured.has(1));
  run(control, 1);
  pointer(el, 'pointerup', 400, 300, { button: 0 });
  assert.equal(control.mouseDragOn, false);
  assert.equal(el.captured.size, 0);
  closeVec(cam.position, [0, 0, 9], T, 'left button walks forward');
  closeVec(cam.target, [0, 0, -1], T);
  pointer(el, 'pointerdown', 400, 300, { button: 2 });
  run(control, 0.5);
  pointer(el, 'pointercancel', 400, 300, { button: 2 });
  assert.equal(control.moveState.backward, false);
  closeVec(cam.position, [0, 0, 9.5], T, 'right button walks back');
  control.dispose();

  ({ control, keys, cam } = walker({ autoForward: true }));
  run(control, 1);
  closeVec(cam.position, [0, 0, 9], T, 'autoForward');
  control.dispose();

  ({ control, keys, cam } = walker({ heightSpeed: true, heightMax: 20 }, { position: [0, 5, 10], target: [0, 5, 0] }));
  hold(keys, control, 'KeyW', 1);
  closeVec(cam.position, [0, 5, 4], T, 'heightSpeed');
  closeVec(cam.target, [0, 5, -6], T);
  control.dispose();

  // R/F move along the screen up axis of a tilted view.
  ({ control, keys, cam } = walker({}, { position: [0, 0, 10], target: [0, 10, 0] }));
  hold(keys, control, 'KeyR', 1);
  closeVec(cam.position, [0, Math.SQRT1_2, 10 + Math.SQRT1_2], T, 'R along screen up');
  control.dispose();
});

test('first person: pointer offset turns the view, linear in offset and time; latitude stays inside 89 degrees', () => {
  let { control, el, cam } = walker();
  pointer(el, 'pointermove', 500, 300);
  assert.equal(control.pointerX, 100);
  assert.equal(control.pointerY, 0);
  control.update(1);
  close(control.longitude, 180 - 0.5 / RAD, T, '100 px right for 1 s turns right by 0.5 rad');
  closeVec(cam.target, [10 * Math.sin(0.5), 0, 10 - 10 * Math.cos(0.5)], T);
  control.update(0.5);
  close(control.longitude, 180 - 0.75 / RAD, T, 'linear in delta');
  control.dispose();

  ({ control, el, cam } = walker());
  pointer(el, 'pointermove', 400, 200);
  control.update(1);
  close(control.latitude, 0.5 / RAD, T, '100 px above looks up');
  closeVec(cam.target, [0, 10 * Math.sin(0.5), 10 - 10 * Math.cos(0.5)], T);
  pointer(el, 'pointermove', 400, -100000);
  control.update(1);
  close(control.latitude, 89, T, 'latitude limit');
  closeVec(cam.target, [0, 10 * Math.sin(89 * RAD), 10 - 10 * Math.cos(89 * RAD)], T);
  assert.doesNotThrow(() => cam.update(4 / 3, true));
  control.dispose();

  ({ control, el, cam } = walker({ lookVertical: false }));
  pointer(el, 'pointermove', 450, 100);
  control.update(1);
  close(control.latitude, 0, T);
  close(control.longitude, 180 - 0.25 / RAD, T);
  control.dispose();

  ({ control, el, cam } = walker({ activeLook: false }));
  pointer(el, 'pointermove', 700, 50);
  pointer(el, 'pointerdown', 700, 50, { button: 0 });
  run(control, 1);
  closeVec(cam.position, [0, 0, 10], T, 'activeLook off: buttons do not walk');
  closeVec(cam.target, [0, 0, 0], T, 'activeLook off: pointer ignored');
  control.dispose();
});

test('first person: constrainVertical maps the look range onto [verticalMin, verticalMax]', () => {
  const { control, el, cam } = walker({ constrainVertical: true, verticalMin: 1, verticalMax: 2 });
  control.update(0);
  close(view(cam).polar, 1.5, T, 'horizon maps to the middle of the range');
  pointer(el, 'pointermove', 400, 200);
  let last = view(cam).polar;
  for (let i = 0; i < 20; i++) {
    control.update(0.1);
    const polar = view(cam).polar;
    assert.ok(polar <= last + 1e-12 && polar >= 1 - 1e-12, `polar ${polar} within range and rising view`);
    last = polar;
  }
  pointer(el, 'pointermove', 400, 100000);
  for (let i = 0; i < 20; i++) control.update(1);
  assert.ok(view(cam).polar <= 2 + 1e-12 && view(cam).polar > 1.9, 'bottom of the range');
  control.dispose();
});

test('first person: lookAt aims and resynchronises; disconnect clears held input', () => {
  const { control, keys, cam } = walker();
  assert.equal(control.lookAt(0, 0, 100), control);
  closeVec(cam.target, [0, 0, 100], 0);
  close(control.latitude, 0, T);
  close(control.longitude, 0, T);
  control.update(1);
  closeVec(cam.target, [0, 0, 100], T, 'update keeps the lookAt direction and distance');
  control.lookAt([10, 10, 10]);
  close(control.latitude, 45, T);
  close(control.longitude, 90, T);
  key(keys, 'keydown', 'KeyW');
  control.enabled = false;
  key(keys, 'keyup', 'KeyW');
  assert.equal(control.moveState.forward, false, 'keyup works while disabled');
  control.enabled = true;
  key(keys, 'keydown', 'KeyS');
  control.disconnect();
  assert.ok(Object.values(control.moveState).every((v) => v === false));
  assert.equal(keys.listenerCount, 0);
  control.dispose();
});

// ---------- PointerLockControls ----------
class LockDocument extends FakeTarget {
  pointerLockElement = null;
  exitPointerLock() {
    this.pointerLockElement = null;
    this.dispatch('pointerlockchange');
  }
}
class LockElement extends FakeElement {
  constructor(doc) {
    super();
    this.doc = doc;
    this.requests = [];
    this.reject = null;
  }
  requestPointerLock(options) {
    this.requests.push(options);
    if (this.reject) return Promise.reject(this.reject);
    this.doc.pointerLockElement = this;
    this.doc.dispatch('pointerlockchange');
    return Promise.resolve();
  }
}
function locker(options = {}, cameraOptions) {
  const doc = new LockDocument(),
    el = new LockElement(doc),
    cam = camera(cameraOptions),
    control = new PointerLockControls(cam, el, { document: doc }),
    events = [];
  Object.assign(control, options);
  for (const type of ['lock', 'unlock', 'change', 'error']) control.addEventListener(type, () => events.push(type));
  return { doc, el, cam, control, events };
}
const elevation = (cam) => {
  const d = cam.target.map((v, i) => v - cam.position[i]);
  return Math.asin(d[1] / Math.hypot(...d));
};
const yaw = (cam) => {
  const d = cam.target.map((v, i) => v - cam.position[i]);
  return Math.atan2(-d[0], -d[2]); // positive = turned left from -Z
};

test('pointer lock: defaults, lock and unlock events, requested options, keys cleared on unlock', () => {
  const { doc, el, control, events } = locker();
  assert.equal(control.isLocked, false);
  assert.equal(control.minPolarAngle, 0);
  assert.equal(control.maxPolarAngle, Math.PI);
  assert.equal(control.pointerSpeed, 1);
  assert.equal(control.movementSpeed, 1);
  assert.equal(control.requireLock, true);
  assert.deepEqual(control.keys.FORWARD, ['KeyW', 'ArrowUp']);
  assert.deepEqual(control.keys.UP, ['KeyR']);
  control.lock();
  assert.deepEqual(el.requests, [{ unadjustedMovement: false }]);
  assert.equal(control.isLocked, true);
  doc.dispatch('pointerlockchange');
  assert.deepEqual(events, ['lock'], 'repeated equal states dispatch nothing');
  key(doc, 'keydown', 'KeyW');
  assert.equal(control.pressed.size, 1);
  control.unlock();
  assert.equal(control.isLocked, false);
  assert.equal(control.pressed.size, 0);
  assert.deepEqual(events, ['lock', 'unlock']);
  control.lock(true);
  assert.deepEqual(el.requests[1], { unadjustedMovement: true });
  control.dispose();
  assert.equal(doc.listenerCount, 0);
});

test('pointer lock: a rejected request and pointerlockerror dispatch error', async () => {
  const { doc, el, control, events } = locker();
  el.reject = new Error('denied');
  control.lock();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['error']);
  doc.dispatch('pointerlockerror');
  assert.deepEqual(events, ['error', 'error']);
  control.dispose();
});

test('pointer lock: mouse look turns right and down, scales with pointerSpeed, respects polar limits', () => {
  let { doc, cam, control, events } = locker();
  doc.dispatch('mousemove', { movementX: 100, movementY: 0 });
  closeVec(cam.target, [0, 0, 0], 0, 'unlocked mousemove ignored');
  assert.deepEqual(events, []);
  control.lock();
  doc.dispatch('mousemove', { movementX: 100, movementY: 0 });
  const right = yaw(cam);
  assert.ok(right < 0, 'mouse right turns right');
  closeVec(cam.position, [0, 0, 10], 0);
  doc.dispatch('mousemove', { movementX: 100, movementY: 0 });
  close(yaw(cam), 2 * right, 1e-12, 'linear in movement');
  close(right, -100 * (Math.PI / 2 / 1600), 1e-12, '1600 counts (2 in at 800 DPI) turn 90 degrees');
  assert.deepEqual(events, ['lock', 'change', 'change']);
  control.dispose();

  ({ cam, control } = locker());
  control.look(0, -50);
  const one = elevation(cam);
  assert.ok(one > 0, 'mouse up looks up');
  control.dispose();
  ({ cam, control } = locker({ pointerSpeed: 2 }));
  control.look(0, -50);
  close(elevation(cam), 2 * one, 1e-12, 'pointerSpeed 2 turns twice as far');
  control.dispose();

  ({ cam, control } = locker({ maxPolarAngle: Math.PI / 2 + 0.3 }));
  control.look(0, 1e6);
  close(elevation(cam), -0.3, T, 'maxPolarAngle clamp');
  closeVec(cam.target, [0, -2.95520206661, 0.446635108744], T);
  control.dispose();

  ({ cam, control, events } = locker());
  control.look(0, -1e6);
  closeVec(cam.target, [0, 9.999995, 9.99000000167], T, 'MAX_PITCH clamp');
  control.look(0, -10);
  assert.deepEqual(events, ['change', 'change'], 'change even when clamped');
  control.dispose();

  ({ cam, control } = locker({ minPolarAngle: 1 }));
  control.look(0, -1e6);
  close(elevation(cam), Math.PI / 2 - 1, T, 'minPolarAngle clamp');
  control.dispose();
});

test('pointer lock: key movement on the ground plane, normalised diagonals, requireLock gating', () => {
  let { doc, cam, control, events } = locker(
    { movementSpeed: 3 },
    { position: [0, 5, 10], target: [0, -0.463024898438, 0] },
  );
  control.lock();
  key(doc, 'keydown', 'KeyW');
  assert.equal(control.update(1), true);
  closeVec(cam.position, [0, 5, 7], T, 'looking down still moves horizontally');
  closeVec(cam.target, [0, -0.463024898438, -3], T);
  control.dispose();

  ({ doc, cam, control } = locker());
  control.lock();
  key(doc, 'keydown', 'KeyW');
  key(doc, 'keydown', 'KeyD');
  control.update(1);
  closeVec(cam.position, [Math.SQRT1_2, 0, 10 - Math.SQRT1_2], T, 'diagonal normalised');
  key(doc, 'keyup', 'KeyW');
  key(doc, 'keyup', 'KeyD');
  key(doc, 'keydown', 'KeyR');
  control.update(1);
  key(doc, 'keyup', 'KeyR');
  key(doc, 'keydown', 'KeyF');
  control.update(0.5);
  closeVec(cam.position, [Math.SQRT1_2, 0.5, 10 - Math.SQRT1_2], T, 'R/F along world Y');
  key(doc, 'keydown', 'KeyR');
  assert.equal(control.update(1), false, 'R and F cancel');
  control.movementSpeed = 0;
  key(doc, 'keyup', 'KeyF');
  assert.equal(control.update(1), false, 'movementSpeed 0 disables keys');
  control.dispose();

  ({ doc, cam, control, events } = locker());
  key(doc, 'keydown', 'KeyW');
  assert.equal(control.update(1), false, 'requireLock: unlocked keys do nothing');
  closeVec(cam.position, [0, 0, 10], 0);
  assert.deepEqual(events, []);
  control.requireLock = false;
  assert.equal(control.update(1), true);
  closeVec(cam.position, [0, 0, 9], T);
  closeVec(cam.target, [0, 0, -1], T);
  assert.deepEqual(events, ['change']);
  control.enabled = false;
  key(doc, 'keyup', 'KeyW');
  assert.equal(control.pressed.size, 0, 'keyup is processed while disabled');
  key(doc, 'keydown', 'KeyW');
  assert.equal(control.pressed.size, 0, 'keydown ignored while disabled');
  control.dispose();
});

test('pointer lock: moveForward, moveRight, moveUp and getDirection', () => {
  const { cam, control } = locker({}, { position: [0, 5, 10], target: [1, 2, 0] });
  const d = control.getDirection();
  close(Math.hypot(...d), 1, 1e-12);
  control.moveForward(2);
  control.moveRight(1);
  control.moveUp(0.5);
  closeVec(cam.position, [1.19404462825, 5.5, 8.1094293386], T);
  closeVec(cam.target, [2.19404462825, 2.5, -1.8905706614], T);
  control.dispose();
});
