import test from 'node:test';
import assert from 'node:assert/strict';
import { FlyControls } from '../dist/index.js';
import { FakeElement, FakeTarget, camera, close, closeVec, key, pointer, run } from './control-fakes.js';

const T = 1e-9;
function fly(options = {}) {
  const el = new FakeElement(),
    keys = new FakeTarget(),
    cam = camera(),
    control = new FlyControls(cam, el, { keyTarget: keys });
  Object.assign(control, options);
  return { el, keys, cam, control };
}
const hold = (keys, control, code, seconds, extra) => {
  key(keys, 'keydown', code, extra);
  run(control, seconds);
  key(keys, 'keyup', code);
};

test('fly: defaults, and the turn rate is rollSpeed radians per second', () => {
  const { control, keys, cam } = fly();
  assert.equal(control.movementSpeed, 1);
  assert.equal(control.rollSpeed, 0.01);
  assert.equal(control.dragToLook, false);
  assert.equal(control.autoForward, false);
  assert.equal(control.movementSpeedMultiplier, 1);
  hold(keys, control, 'ArrowLeft', 1);
  // 0.01 rad in 1 s: the same feel as the earlier default of 0.005 at twice the rate.
  close(Math.atan2(-cam.target[0], -(cam.target[2] - 10)), 0.01, 1e-9, 'yaw');
  control.dispose();
});

test('fly: W/A/S/D/R/F translate in the camera frame', () => {
  let { control, keys, cam } = fly({ movementSpeed: 2 });
  hold(keys, control, 'KeyW', 1);
  closeVec(cam.position, [0, 0, 8], T);
  closeVec(cam.target, [0, 0, -2], T);
  control.dispose();

  ({ control, keys, cam } = fly());
  hold(keys, control, 'KeyD', 0.5);
  hold(keys, control, 'KeyR', 0.5);
  hold(keys, control, 'KeyS', 0.25);
  hold(keys, control, 'KeyF', 0.25);
  closeVec(cam.position, [0.5, 0.25, 10.25], T);
  closeVec(cam.target, [0.5, 0.25, 0.25], T);
  hold(keys, control, 'KeyA', 0.5);
  closeVec(cam.position, [0, 0.25, 10.25], T);
  control.dispose();

  ({ control, keys, cam } = fly({ autoForward: true }));
  run(control, 1);
  closeVec(cam.position, [0, 0, 9], T);
  closeVec(cam.target, [0, 0, -1], T);
  control.dispose();
});

test('fly: R/F follow the pitched screen up axis and W the pitched view', () => {
  const { control, keys, cam } = fly();
  cam.target = [0, 10, 0]; // 45 degrees up, toward -Z
  hold(keys, control, 'KeyW', 1);
  const s = Math.SQRT1_2;
  closeVec(cam.position, [0, s, 10 - s], T);
  hold(keys, control, 'KeyR', 1);
  closeVec(cam.position, [0, 2 * s, 10], T);
  control.dispose();
});

test('fly: Shift slows by 0.1 until both Shift keys are released and keeps the configured multiplier', () => {
  const { control, keys, cam } = fly({ movementSpeedMultiplier: 3 });
  key(keys, 'keydown', 'ShiftLeft');
  hold(keys, control, 'KeyW', 1);
  closeVec(cam.position, [0, 0, 9.7], T, 'ShiftLeft');
  key(keys, 'keydown', 'ShiftRight');
  key(keys, 'keyup', 'ShiftLeft');
  hold(keys, control, 'KeyW', 1);
  closeVec(cam.position, [0, 0, 9.4], T, 'still slow while ShiftRight is held');
  key(keys, 'keyup', 'ShiftRight');
  assert.equal(control.movementSpeedMultiplier, 3);
  hold(keys, control, 'KeyW', 1);
  closeVec(cam.position, [0, 0, 6.4], T, 'full speed after both release');
  // Shift with Alt held is ignored like any Alt combination.
  key(keys, 'keydown', 'ShiftLeft', { altKey: true });
  hold(keys, control, 'KeyW', 1);
  closeVec(cam.position, [0, 0, 3.4], T, 'alt+Shift ignored');
  control.dispose();

  const plain = fly();
  key(plain.keys, 'keydown', 'ShiftLeft');
  hold(plain.keys, plain.control, 'KeyW', 1);
  closeVec(plain.cam.position, [0, 0, 9.9], T);
  closeVec(plain.cam.target, [0, 0, -0.1], T);
  plain.control.dispose();
});

test('fly: Alt combinations, Q/E and unknown keys do nothing; keyup is processed while disabled', () => {
  const { control, keys, cam } = fly();
  key(keys, 'keydown', 'KeyW', { altKey: true });
  key(keys, 'keydown', 'KeyQ');
  key(keys, 'keydown', 'KeyE');
  key(keys, 'keydown', 'KeyZ');
  assert.equal(run(control, 1), false);
  closeVec(cam.position, [0, 0, 10], 0);
  closeVec(cam.target, [0, 0, 0], 0);
  key(keys, 'keydown', 'KeyW');
  control.enabled = false;
  key(keys, 'keyup', 'KeyW');
  assert.equal(control.moveState.forward, 0);
  control.dispose();
});

test('fly: arrows yaw and pitch at rollSpeed rad/s, pitch stops at MAX_PITCH', () => {
  let { control, keys, cam } = fly({ rollSpeed: 0.5 });
  hold(keys, control, 'ArrowLeft', 1);
  closeVec(cam.position, [0, 0, 10], T);
  closeVec(cam.target, [-4.79425538604, 0, 1.2241743811], T, 'yaw left');
  hold(keys, control, 'ArrowRight', 1);
  closeVec(cam.target, [0, 0, 0], T, 'yaw back');
  control.dispose();

  ({ control, keys, cam } = fly({ rollSpeed: 0.5 }));
  hold(keys, control, 'ArrowUp', 1);
  closeVec(cam.target, [0, 4.79425538604, 1.2241743811], T, 'pitch up');
  hold(keys, control, 'ArrowDown', 1);
  closeVec(cam.target, [0, 0, 0], T, 'pitch back');
  control.dispose();

  ({ control, keys, cam } = fly({ rollSpeed: 0.5 }));
  key(keys, 'keydown', 'ArrowUp');
  for (let i = 0; i < 100; i++) control.update(1);
  closeVec(cam.target, [0, 9.999995, 9.99000000167], T, 'clamped just short of the pole');
  assert.doesNotThrow(() => cam.update(4 / 3, true));
  assert.ok(cam.matrix.every(Number.isFinite));
  control.dispose();
});

test('fly: the pointer offset steers proportionally; buttons fly forward and back', () => {
  let { control, el, cam } = fly({ rollSpeed: 2 });
  pointer(el, 'pointermove', 600, 450);
  assert.equal(control.moveState.yawLeft, -0.5);
  assert.equal(control.moveState.pitchDown, 0.5);
  assert.equal(control.moveState.yawRight, 0);
  assert.equal(control.moveState.pitchUp, 0);
  control.update(0.1);
  closeVec(cam.position, [0, 0, 10], T);
  closeVec(cam.target, [0.993346653975, -0.998334166468, 0.0996671107938], T);
  control.dispose();

  ({ control, el, cam } = fly());
  pointer(el, 'pointermove', 400, 300);
  pointer(el, 'pointerdown', 400, 300, { button: 0 });
  assert.ok(el.captured.has(1));
  run(control, 1);
  pointer(el, 'pointerup', 400, 300, { button: 0 });
  assert.equal(el.captured.size, 0);
  closeVec(cam.position, [0, 0, 9], T);
  closeVec(cam.target, [0, 0, -1], T);
  pointer(el, 'pointerdown', 400, 300, { button: 2 });
  run(control, 0.5);
  pointer(el, 'pointercancel', 400, 300, { button: 2 });
  assert.equal(control.moveState.back, 0);
  closeVec(cam.position, [0, 0, 9.5], T);
  closeVec(cam.target, [0, 0, -0.5], T);
  const menu = el.dispatch('contextmenu');
  assert.equal(menu.defaultPrevented, true);
  control.dispose();
});

test('fly: dragToLook steers only while pressed', () => {
  const { control, el, cam } = fly({ dragToLook: true, rollSpeed: 0.5 });
  pointer(el, 'pointermove', 800, 300);
  run(control, 1);
  closeVec(cam.target, [0, 0, 0], 0, 'no press, no steering');
  pointer(el, 'pointerdown', 400, 300);
  assert.equal(control.moveState.forward, 0, 'dragToLook buttons do not fly');
  pointer(el, 'pointermove', 800, 300);
  run(control, 1);
  closeVec(cam.target, [4.79425538604, 0, 1.2241743811], T, 'press + move steers right');
  pointer(el, 'pointerup', 800, 300);
  assert.equal(control.moveState.yawLeft, 0);
  run(control, 1);
  closeVec(cam.target, [4.79425538604, 0, 1.2241743811], T, 'release stops steering');
  control.dispose();
});

test('fly: disconnect clears every input', () => {
  const { control, keys, el } = fly();
  key(keys, 'keydown', 'KeyW');
  key(keys, 'keydown', 'ShiftLeft');
  pointer(el, 'pointermove', 700, 100);
  control.disconnect();
  assert.ok(Object.values(control.moveState).every((v) => v === 0));
  assert.equal(el.listenerCount, 0);
  assert.equal(keys.listenerCount, 0);
  assert.equal(control.update(1), false);
  control.dispose();
});
