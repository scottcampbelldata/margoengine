import test from 'node:test';
import assert from 'node:assert/strict';
import { Input, bindingLabel } from '../dist/index.js';
import { Gyro } from '../dist/motion.js';

const DEG = Math.PI / 180;
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message ?? ''} ${a} vs ${b}`);
function rig(options = {}) {
  const target = new EventTarget();
  let time = 1000,
    angle = options.angle ?? 0;
  const gyro = new Gyro({ target, now: () => time, screenAngle: () => angle, deadzone: 0, ...options });
  // Arguments are the rates about the device's z, x and y axes; rotationRate carries x, y and z as alpha, beta and
  // gamma (Device Orientation 6.3.2).
  const motion = (z, x, y) =>
    target.dispatchEvent(Object.assign(new Event('devicemotion'), { rotationRate: { alpha: x, beta: y, gamma: z } }));
  const orient = (beta, gamma) =>
    target.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta, gamma, alpha: 123 }));
  // One sensor event every 10 ms at a constant rate.
  const turn = (alpha, beta, gamma, events = 10) => {
    for (let i = 0; i < events; i++) {
      time += 10;
      motion(alpha, beta, gamma);
    }
  };
  return {
    target,
    gyro,
    motion,
    orient,
    turn,
    advance: (ms) => (time += ms),
    setAngle: (value) => (angle = value),
  };
}

test('turns add up to radians in the screen frame, in portrait', () => {
  const { gyro, turn } = rig();
  turn(0, 0, 0, 1);
  gyro.update();
  turn(0, 0, -90);
  gyro.update();
  near(gyro.yaw, 9 * DEG, 'turning right about the screen up axis');
  assert.equal(gyro.pitch, 0);
  turn(0, 90, 0);
  gyro.update();
  near(gyro.pitch, 9 * DEG, 'tipping the top of the device back aims up');
  assert.equal(gyro.yaw, 0);
  turn(-90, 0, 0);
  gyro.update();
  near(gyro.roll, 9 * DEG, 'clockwise as the player sees it');
  gyro.update();
  assert.equal(gyro.yaw + gyro.pitch + gyro.roll, 0, 'each turn is read once');
});

test('landscape and upside down map the same physical turn to the same aim', () => {
  // The same turn about the viewer's up axis, as device rates, for each screen angle.
  const cases = [
    { angle: 0, beta: 0, gamma: -90 },
    { angle: 90, beta: -90, gamma: 0 },
    { angle: 180, beta: 0, gamma: 90 },
    { angle: 270, beta: 90, gamma: 0 },
  ];
  for (const { angle, beta, gamma } of cases) {
    const { gyro, turn } = rig({ angle });
    turn(0, 0, 0, 1);
    gyro.update();
    turn(0, beta, gamma);
    gyro.update();
    near(gyro.yaw, 9 * DEG, `yaw at ${angle}`);
    near(gyro.pitch, 0, `pitch at ${angle}`);
  }
  const { gyro, turn, setAngle } = rig();
  turn(0, 0, 0, 1);
  setAngle(90);
  gyro.update();
  turn(0, 0, -90);
  gyro.update();
  near(gyro.pitch, 9 * DEG, 'in landscape the device y axis is the screen right, reversed');
});

test('actions read the rate as a share of maxRate, through a control binding', () => {
  const { gyro, turn, advance } = rig({ maxRate: 100 }),
    input = new Input(
      {
        aimX: [{ type: 'control', id: 'gyro', axis: 'yaw' }],
        aimY: [{ type: 'control', id: 'gyro', axis: 'pitch', scale: -1 }],
      },
      { target: new EventTarget(), gamepads: () => [] },
    );
  gyro.attach(input);
  turn(0, 0, 0, 1);
  gyro.update();
  turn(0, 25, -50);
  gyro.update();
  input.update();
  near(input.state('aimX').value, 0.5);
  near(input.state('aimY').value, -0.25);
  turn(0, 0, -500);
  gyro.update();
  input.update();
  assert.equal(input.state('aimX').value, 1, 'an action stays within -1 to 1');
  assert.ok(gyro.yaw > 0.5, 'the radians do not clamp');
  advance(16);
  gyro.update();
  input.update();
  assert.equal(input.state('aimX').value, 0, 'no sensor events: no aim');
  assert.equal(input.state('aimX').released, true);
  gyro.detach(input);
  assert.deepEqual({ ...input.control('gyro') }, {}, 'detach removes the control');
  input.dispose();
});

test('a gap in sensor events cannot jump the aim', () => {
  const { gyro, motion, advance } = rig();
  motion(0, 0, 0);
  advance(5000);
  motion(0, 0, -100);
  gyro.update();
  near(gyro.yaw, 10 * DEG, 'one event counts for 100 ms at most');
});

test('the first event integrates one frame, and an empty event counts for nothing', () => {
  const { gyro, target, motion } = rig();
  assert.equal(gyro.available, false);
  target.dispatchEvent(Object.assign(new Event('devicemotion'), { rotationRate: null }));
  motion(null, null, null);
  assert.equal(gyro.available, false, 'desktops send these');
  gyro.update();
  assert.equal(gyro.yaw, 0);
  const fresh = rig();
  fresh.motion(0, 0, -60);
  fresh.gyro.update();
  near(fresh.gyro.yaw, 1 * DEG);
  assert.equal(fresh.gyro.available, true);
});

test('the deadzone drops a resting hand and a slow turn passes it', () => {
  const { gyro, turn } = rig({ deadzone: 2 });
  turn(1, 1, 1);
  gyro.update();
  assert.equal(gyro.yaw + gyro.pitch + gyro.roll, 0);
  turn(0, 0, -3);
  gyro.update();
  assert.ok(gyro.yaw > 0);
});

test('enabled false reads nothing and keeps nothing for later', () => {
  const { gyro, turn, orient } = rig();
  orient(90, 0);
  turn(0, 0, 0, 1);
  gyro.enabled = false;
  orient(60, 30);
  turn(0, 0, -90);
  gyro.update();
  assert.equal(gyro.yaw, 0);
  assert.equal(gyro.steer, 0);
  gyro.enabled = true;
  gyro.update();
  assert.equal(gyro.yaw, 0);
  assert.notEqual(gyro.steer, 0);
});

test('steer reads tilt like a wheel, in either screen orientation', () => {
  const portrait = rig();
  portrait.orient(90, 0);
  portrait.gyro.update();
  near(portrait.gyro.steer, 0, 'upright');
  // Upright, turned 22.5 degrees clockwise: gamma 90 lays the world's up in the screen plane, at 67.5 degrees of beta.
  portrait.orient(67.5, 90);
  portrait.gyro.update();
  near(portrait.gyro.steer, 0.5, 'half of maxTilt');

  const landscape = rig({ angle: 90 });
  landscape.orient(0, -90);
  landscape.gyro.update();
  near(landscape.gyro.steer, 0, 'upright with the top of the device to the left');
  landscape.orient(22.5, -90);
  landscape.gyro.update();
  near(landscape.gyro.steer, 0.5, 'the wheel turns clockwise');
  landscape.orient(70, -90);
  landscape.gyro.update();
  assert.equal(landscape.gyro.steer, 1, 'clamped');
  landscape.orient(-22.5, -90);
  landscape.gyro.update();
  near(landscape.gyro.steer, -0.5);
});

test('recenter makes the present tilt straight ahead, also across the wrap', () => {
  const { gyro, orient } = rig({ angle: 90 });
  orient(179, -90);
  gyro.recenter();
  gyro.update();
  near(gyro.steer, 0);
  orient(-179, -90);
  gyro.update();
  near(gyro.steer, 2 / 45, 'two degrees across the wrap, not 358 back');
});

test('a device lying flat holds the steering at neutral', () => {
  const { gyro, orient } = rig();
  orient(90, 0);
  orient(1, 1);
  gyro.update();
  assert.equal(gyro.steer, 0);
  orient(null, null);
  gyro.update();
  assert.equal(gyro.steer, 0);
});

test('calibrate measures the resting error and subtracts it', async () => {
  const { gyro, turn } = rig(),
    done = gyro.calibrate({ duration: 5 });
  turn(1, 2, 3, 4);
  assert.equal(await done, true);
  gyro.update();
  turn(1, 2, 3);
  gyro.update();
  near(gyro.yaw, 0);
  near(gyro.pitch, 0);
  near(gyro.roll, 0);
  turn(1, 2, -87);
  gyro.update();
  near(gyro.yaw, 9 * DEG);
});

test('calibrate with no readings changes nothing, and a signal stops it', async () => {
  const { gyro, turn } = rig();
  assert.equal(await gyro.calibrate({ duration: 1 }), false);
  const controller = new AbortController(),
    waiting = gyro.calibrate({ duration: 10_000, signal: controller.signal });
  turn(5, 5, 5, 3);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  await assert.rejects(gyro.calibrate({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  gyro.update();
  turn(0, 0, -90);
  gyro.update();
  near(gyro.yaw, 9 * DEG, 'no bias was kept');
  await assert.rejects(gyro.calibrate({ duration: -1 }), RangeError);
});

test('dispose stops listening, removes controls and can repeat', () => {
  const { gyro, turn } = rig(),
    input = new Input({ a: [{ type: 'key', code: 'KeyA' }] }, { target: new EventTarget(), gamepads: () => [] });
  gyro.attach(input);
  const control = input.control('gyro');
  gyro.dispose();
  gyro.dispose();
  assert.notEqual(input.control('gyro'), control);
  turn(0, 0, -90);
  gyro.update();
  assert.equal(gyro.yaw, 0);
  using scoped = rig().gyro;
  assert.equal(scoped.enabled, true);
});

test('options are checked', () => {
  for (const options of [{ maxRate: 0 }, { maxTilt: -1 }, { deadzone: -1 }, { maxRate: Infinity }, { deadzone: NaN }])
    assert.throws(() => rig(options), RangeError);
});

test('permission: asks where the browser needs it and answers without where it does not', async (t) => {
  const had = { motion: globalThis.DeviceMotionEvent, orientation: globalThis.DeviceOrientationEvent };
  t.after(() => {
    globalThis.DeviceMotionEvent = had.motion;
    globalThis.DeviceOrientationEvent = had.orientation;
  });
  delete globalThis.DeviceMotionEvent;
  assert.equal(Gyro.supported(), false);
  assert.equal(await Gyro.requestPermission(), false);
  globalThis.DeviceMotionEvent = class {};
  assert.equal(Gyro.supported(), true);
  assert.equal(await Gyro.requestPermission(), true, 'no permission needed');
  globalThis.DeviceMotionEvent.requestPermission = async () => 'granted';
  globalThis.DeviceOrientationEvent = { requestPermission: async () => 'denied' };
  assert.equal(await Gyro.requestPermission(), false);
  globalThis.DeviceOrientationEvent.requestPermission = async () => 'granted';
  assert.equal(await Gyro.requestPermission(), true);
});

test('control bindings: reads, defaults, reset, labels and checks', () => {
  const target = new EventTarget(),
    input = new Input(
      {
        slide: [{ type: 'control', id: 'slider' }],
        lean: [{ type: 'control', id: 'pad', axis: 'x', scale: 0.5 }],
        gone: [{ type: 'control', id: 'nobody' }],
      },
      { target, gamepads: () => [] },
    );
  const slider = input.control('slider'),
    pad = input.control('pad');
  assert.equal(input.control('slider'), slider, 'one id is one control');
  slider.value = 0.75;
  pad.x = 1;
  pad.__proto__ = 5;
  input.update();
  assert.equal(input.state('slide').value, 0.75);
  assert.equal(input.state('lean').value, 0.5);
  assert.equal(input.state('gone').value, 0);
  target.dispatchEvent(new Event('blur'));
  input.update();
  assert.equal(input.state('slide').value, 0, 'reset releases controls too');
  assert.equal(bindingLabel({ type: 'control', id: 'gyro', axis: 'yaw' }), 'gyro yaw');
  assert.equal(bindingLabel({ type: 'control', id: 'slider' }), 'slider');
  assert.throws(() => input.control(''), TypeError);
  for (const binding of [{ type: 'control' }, { type: 'control', id: '' }, { type: 'control', id: 'a', axis: '' }])
    assert.throws(() => input.rebind('slide', [binding]), TypeError);
  input.removeControl('slider');
  slider.value = 1;
  input.update();
  assert.equal(input.state('slide').value, 0, 'a removed control reads 0');
  input.dispose();
  assert.throws(() => input.control('late'), /disposed/);
});
