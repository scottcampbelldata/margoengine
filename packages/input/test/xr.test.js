import test from 'node:test';
import assert from 'node:assert/strict';
import { Input } from '../dist/index.js';
import { XRBindings } from '../dist/xr.js';
import { InputRecorder, InputReplay } from '../dist/replay.js';
const event = (session, type, inputSource) => session.dispatchEvent(Object.assign(new Event(type), { inputSource }));
const source = (handedness = 'left') => ({
  handedness,
  gamepad: { axes: [0.5, -0.25], buttons: [{ value: 0.6, pressed: true, touched: false }] },
});
const setup = (sources) => {
  const session = new EventTarget();
  session.inputSources = sources;
  return session;
};
test('XR descriptors produce ordinary actions for buttons, axes and hand/source filters', () => {
  const left = source(),
    right = source('right'),
    second = source();
  second.gamepad.axes[0] = -0.75;
  const session = setup([left, right, second]),
    xr = new XRBindings(session);
  const input = new Input(
    xr.map({
      left: [{ type: 'xr-axis', index: 0, hand: 'left', source: 1 }],
      button: [{ type: 'xr-button', index: 0, hand: 'right' }],
      pressed: [{ type: 'xr-button', index: 0, value: 'pressed' }],
      touched: [{ type: 'xr-button', index: 0, value: 'touched' }],
      native: [{ type: 'key', code: 'Space' }],
    }),
    { target: new EventTarget(), gamepads: () => [] },
  );
  xr.attach(input);
  xr.update();
  input.update();
  assert.equal(input.state('left').value, -0.75);
  assert.equal(input.state('button').value, 0.6);
  assert.equal(input.state('pressed').value, 1);
  assert.equal(input.state('touched').value, 0);
  right.gamepad.buttons[0].value = NaN;
  xr.update();
  input.update();
  assert.equal(input.state('button').value, 0);
  xr.dispose();
  input.dispose();
});
test('select and squeeze retain complete taps, then clear on source removal and session end', () => {
  const s = source(),
    session = setup([s]),
    xr = new XRBindings(session),
    input = new Input(xr.map({ select: [{ type: 'xr-select' }], grip: [{ type: 'xr-grip' }] }), {
      target: new EventTarget(),
      gamepads: () => [],
    });
  xr.attach(input);
  event(session, 'selectstart', s);
  event(session, 'selectend', s);
  event(session, 'squeezestart', s);
  event(session, 'squeezeend', s);
  xr.update();
  input.update();
  assert.equal(input.state('select').pressed, true);
  assert.equal(input.state('grip').pressed, true);
  xr.update();
  input.update();
  assert.equal(input.state('select').released, true);
  assert.equal(input.state('grip').released, true);
  event(session, 'selectstart', s);
  xr.update();
  input.update();
  session.inputSources = [];
  session.dispatchEvent(new Event('inputsourceschange'));
  xr.update();
  input.update();
  assert.equal(input.state('select').released, true);
  session.inputSources = [s];
  xr.update();
  input.update();
  assert.equal(input.state('select').down, false);
  event(session, 'squeezestart', s);
  xr.update();
  input.update();
  session.dispatchEvent(new Event('end'));
  input.update();
  assert.equal(input.state('grip').released, true);
  xr.update();
  input.update();
  assert.equal(input.state('grip').down, false);
  xr.dispose();
  input.dispose();
});
test('joint pinch uses metre thresholds, hysteresis and releases when joints are untracked', () => {
  const thumb = {},
    index = {},
    s = {
      handedness: 'left',
      hand: new Map([
        ['thumb-tip', thumb],
        ['index-finger-tip', index],
      ]),
    },
    session = setup([s]),
    xr = new XRBindings(session);
  const input = new Input(
    { pinch: [xr.binding({ type: 'xr-pinch' })] },
    { target: new EventTarget(), gamepads: () => [] },
  );
  xr.attach(input);
  let distance = 0.01,
    tracked = true;
  const frame = {
    getJointPose: (joint) =>
      tracked ? { transform: { position: { x: joint === index ? distance : 0, y: 0, z: 0 } } } : null,
  };
  xr.update(frame, {});
  input.update();
  assert.equal(input.state('pinch').pressed, true);
  distance = 0.025;
  xr.update(frame, {});
  input.update();
  assert.equal(input.state('pinch').down, true);
  distance = 0.031;
  xr.update(frame, {});
  input.update();
  assert.equal(input.state('pinch').released, true);
  distance = 0.025;
  xr.update(frame, {});
  input.update();
  assert.equal(input.state('pinch').down, false);
  distance = 0.01;
  xr.update(frame, {});
  input.update();
  tracked = false;
  xr.update(frame, {});
  input.update();
  assert.equal(input.state('pinch').released, true);
  xr.dispose();
  input.dispose();
});
test('grip pose channels publish position, orientation and tracking, and reset without a frame', () => {
  const s = { ...source(), gripSpace: {} },
    session = setup([s]),
    xr = new XRBindings(session);
  const input = new Input(
    xr.map({
      x: [{ type: 'xr-grip-pose', component: 'x', scale: 0.1 }],
      qw: [{ type: 'xr-grip-pose', component: 'qw' }],
      tracked: [{ type: 'xr-grip-pose', component: 'tracked' }],
    }),
    { target: new EventTarget(), gamepads: () => [] },
  );
  xr.attach(input);
  xr.update(
    { getPose: () => ({ transform: { position: { x: 2, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } }) },
    {},
  );
  input.update();
  assert.equal(input.state('x').value, 0.2);
  assert.equal(input.state('qw').value, 1);
  assert.equal(input.state('tracked').value, 1);
  xr.update();
  input.update();
  assert.equal(input.state('tracked').released, true);
  assert.equal(input.state('x').value, 0);
  xr.dispose();
  input.dispose();
});
test('XR samples replay without hardware; detach, disposal and contexts work', async () => {
  const s = source(),
    session = setup([s]),
    xr = new XRBindings(session),
    actions = xr.map({ use: [{ type: 'xr-select' }], axis: [{ type: 'xr-axis', index: 0 }] }),
    input = new Input(actions, { target: new EventTarget(), gamepads: () => [], contexts: { game: ['use'] } });
  const detach = xr.attach(input),
    record = new InputRecorder(input, { now: () => 0 });
  event(session, 'selectstart', s);
  xr.update();
  input.update();
  record.capture();
  input.setContext('game', false);
  xr.update();
  input.update();
  record.capture();
  assert.equal(input.state('use').down, false);
  input.setContext('game', true);
  detach();
  input.update();
  assert.equal(input.state('axis').value, 0);
  detach();
  xr.dispose();
  xr[Symbol.dispose]();
  assert.throws(() => xr.update(), { code: 'disposed' });
  const replay = new InputReplay(input, record.clip());
  input.update();
  assert.equal(input.state('use').pressed, true);
  assert.equal(input.state('axis').value, 0.5);
  input.update();
  assert.equal(input.state('use').released, true);
  replay.stop();
  await replay.finished;
  input.dispose();
});
test('invalid descriptors and thresholds reject, and attaching twice never steals a host', () => {
  const xr = new XRBindings(setup([]));
  for (const b of [
    { type: 'xr-axis', index: -1 },
    { type: 'xr-button', index: 0, value: 'bad' },
    { type: 'xr-axis' },
    { type: 'xr-pinch', hand: 'bad' },
    { type: 'xr-grip', source: 0.5 },
    { type: 'xr-grip-pose', component: 'bad' },
  ])
    assert.throws(() => xr.binding(b), TypeError);
  for (const opts of [{ pinchStart: 0 }, { pinchEnd: 0.01 }, { pinchStart: NaN }])
    assert.throws(() => new XRBindings(setup([]), opts), RangeError);
  const host = { control: () => ({}), removeControl: () => {} };
  xr.attach(host);
  assert.throws(() => xr.attach(host), TypeError);
  xr.dispose();
});
