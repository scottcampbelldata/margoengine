// Batch 132 audit regressions: each test fails on the source before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Input, Gestures } from '../dist/index.js';
import { Pen } from '../dist/pen.js';

const fire = (target, type, props) => target.dispatchEvent(Object.assign(new Event(type), props));
const mouse = (target, type, button, buttons) =>
  fire(target, type, { pointerType: 'mouse', button, buttons, movementX: 0, movementY: 0 });

test('chorded mouse buttons (Pointer Events 3, 4.1.1.1) press and release through pointermove', () => {
  const target = new EventTarget();
  const input = new Input(
    { fire: [{ type: 'mouse', button: 0 }], aim: [{ type: 'mouse', button: 2 }] },
    { target, gamepads: () => [] },
  );
  mouse(target, 'pointerdown', 0, 1); // left down: pointerdown
  input.update();
  mouse(target, 'pointermove', 2, 3); // right added while left is held: pointermove only
  input.update();
  assert.equal(input.state('aim').pressed, true, 'right press during a left drag');
  mouse(target, 'pointermove', 0, 2); // left lifted while right is held: pointermove only
  input.update();
  assert.equal(input.state('fire').released, true, 'left release during a right hold');
  assert.equal(input.state('aim').down, true);
  mouse(target, 'pointerup', 2, 0);
  input.update();
  assert.equal(input.state('aim').down, false);
  input.dispose();
});

test('a pinch that ends with one finger lifting fast is neither a tap nor a swipe', () => {
  const target = new EventTarget();
  let t = 0;
  const g = new Gestures(target, { now: () => t });
  const seen = [];
  for (const type of ['tap', 'doubletap', 'swipe']) g.on(type, (e) => seen.push(e.type));
  const touch = (type, id, x, y) => fire(target, type, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' });
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  t = 50;
  touch('pointermove', 2, 300, 100); // spread
  touch('pointerup', 1, 100, 100);
  t = 100;
  touch('pointerup', 2, 300, 100); // 100 px in 100 ms from its start: would read as a swipe
  // Two fingers down and up without moving: would read as a tap.
  t = 1000;
  touch('pointerdown', 3, 100, 100);
  touch('pointerdown', 4, 150, 100);
  touch('pointerup', 3, 100, 100);
  t = 1050;
  touch('pointerup', 4, 150, 100);
  assert.deepEqual(seen, []);
  // A single finger still taps afterwards.
  t = 2000;
  touch('pointerdown', 5, 10, 10);
  t = 2050;
  touch('pointerup', 5, 10, 10);
  assert.deepEqual(seen, ['tap']);
  g.dispose();
});

test('captureBinding takes Ctrl then S as a chord, and a lone modifier on its release', async () => {
  const target = new EventTarget();
  const input = new Input({ jump: [{ type: 'key', code: 'Space' }] }, { target, gamepads: () => [] });
  const key = (type, code, extra = {}) => fire(target, type, { code, ...extra });
  let p = input.captureBinding();
  key('keydown', 'ControlLeft', { ctrlKey: true });
  key('keydown', 'KeyS', { ctrlKey: true });
  assert.deepEqual(await p, { type: 'key', code: 'KeyS', modifiers: ['ctrl'] });
  key('keyup', 'KeyS', { ctrlKey: true });
  key('keyup', 'ControlLeft');
  p = input.captureBinding();
  key('keydown', 'ShiftLeft', { shiftKey: true });
  key('keyup', 'ShiftLeft');
  assert.deepEqual(await p, { type: 'key', code: 'ShiftLeft' });
  input.dispose();
});

test('captureBinding waits for a new gamepad press, not the button already held', async () => {
  const buttons = Array.from({ length: 4 }, () => ({ pressed: false, value: 0 }));
  const pad = { index: 0, buttons, axes: [] };
  buttons[0].pressed = true; // the A press that opened the rebind prompt
  const frames = [];
  globalThis.requestAnimationFrame = (f) => frames.push(f);
  globalThis.cancelAnimationFrame = () => {};
  try {
    const input = new Input(
      { jump: [{ type: 'key', code: 'Space' }] },
      { target: new EventTarget(), gamepads: () => [pad] },
    );
    let result;
    input.captureBinding().then((b) => (result = b));
    const step = async () => {
      frames.shift()?.();
      await null;
    };
    await step();
    assert.equal(result, undefined, 'the held A is not the answer');
    buttons[2].pressed = true;
    await step();
    assert.deepEqual(result, { type: 'gamepad-button', index: 2, gamepad: 0 });
    input.dispose();
  } finally {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
});

test('a flat pen on an axis gets the specification tilt (Pointer Events 3, 4.1.5)', () => {
  const element = Object.assign(new EventTarget(), { setPointerCapture() {} });
  const pen = new Pen(element);
  const read = (azimuthAngle) => {
    fire(element, 'pointermove', {
      pointerType: 'pen',
      pointerId: 1,
      buttons: 0,
      button: -1,
      tiltX: 0,
      tiltY: 0,
      altitudeAngle: 0,
      azimuthAngle,
    });
    const { tiltX, tiltY } = pen.take().at(-1);
    return [tiltX, tiltY];
  };
  assert.deepEqual(read(0), [90, 0]);
  assert.deepEqual(read(Math.PI / 2), [0, 90]);
  assert.deepEqual(read(Math.PI), [-90, 0]);
  assert.deepEqual(read((3 * Math.PI) / 2), [0, -90]);
  assert.deepEqual(read(Math.PI / 4), [90, 90]);
  assert.deepEqual(read((5 * Math.PI) / 4), [-90, -90]);
  pen.dispose();
});

test('Gyro reads rotationRate alpha, beta and gamma as the rates about device x, y and z (Device Orientation 6.3.2)', async () => {
  const { Gyro } = await import('../dist/motion.js');
  const target = new EventTarget();
  let time = 1000;
  const gyro = new Gyro({ target, now: () => time, screenAngle: () => 0, deadzone: 0 });
  const rate = (alpha, beta, gamma) => {
    for (let i = 0; i < 10; i++) {
      time += 10;
      target.dispatchEvent(Object.assign(new Event('devicemotion'), { rotationRate: { alpha, beta, gamma } }));
    }
    gyro.update();
  };
  rate(0, 0, 0);
  rate(90, 0, 0); // about x: the top of the device tips back, aiming up
  assert.ok(Math.abs(gyro.pitch - (9 * Math.PI) / 180) < 1e-9, `pitch ${gyro.pitch}`);
  assert.equal(gyro.roll, 0);
  rate(0, -90, 0); // about y, negative: turning right
  assert.ok(Math.abs(gyro.yaw - (9 * Math.PI) / 180) < 1e-9, `yaw ${gyro.yaw}`);
  rate(0, 0, -90); // about z, negative: clockwise as the player sees the screen
  assert.ok(Math.abs(gyro.roll - (9 * Math.PI) / 180) < 1e-9, `roll ${gyro.roll}`);
  gyro.dispose();
});
