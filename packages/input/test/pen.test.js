import test from 'node:test';
import assert from 'node:assert/strict';
import { Input } from '../dist/index.js';
import { Pen } from '../dist/pen.js';

const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message ?? ''} ${a} vs ${b}`);
const AXES = ['pressure', 'tiltX', 'tiltY', 'altitude', 'azimuth', 'twist', 'tangential', 'down', 'barrel', 'eraser', 'hover'];
function rig(options) {
  const element = Object.assign(new EventTarget(), { captured: [], setPointerCapture: (id) => element.captured.push(id) }),
    input = new Input(Object.fromEntries(AXES.map((axis) => [axis, [{ type: 'control', id: 'pen', axis }]])), {
      target: new EventTarget(),
      gamepads: () => [],
    }),
    pen = new Pen(element, options);
  pen.attach(input);
  const send = (type, fields = {}) =>
    element.dispatchEvent(
      Object.assign(new Event(type), {
        pointerType: 'pen',
        pointerId: 3,
        clientX: 10,
        clientY: 20,
        buttons: 0,
        button: -1,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
        ...fields,
      }),
    );
  const tick = () => {
    pen.update();
    input.update();
  };
  return { element, input, pen, send, tick };
}

test('pressure and tilt reach actions as values', () => {
  const { input, send, tick } = rig();
  send('pointerdown', { buttons: 1, pressure: 0.6, tiltX: 45, tiltY: -18, twist: 90, tangentialPressure: -0.5 });
  tick();
  near(input.state('pressure').value, 0.6);
  assert.equal(input.state('pressure').pressed, true);
  near(input.state('tiltX').value, 0.5);
  near(input.state('tiltY').value, -0.2);
  near(input.state('twist').value, 0.25);
  near(input.state('tangential').value, -0.5);
  assert.equal(input.state('down').value, 1);
  assert.equal(input.state('hover').value, 0);
  send('pointerup', { buttons: 0, pressure: 0, tiltX: 45 });
  tick();
  assert.equal(input.state('down').released, true);
  assert.equal(input.state('pressure').value, 0);
  assert.equal(input.state('hover').value, 1, 'lifted but still in range');
  near(input.state('tiltX').value, 0.5, 'tilt reads while hovering, for a brush preview');
});

test('hover moves read position and tilt with no pressure, and leaving clears everything', () => {
  const { input, pen, send, tick } = rig();
  assert.equal(pen.latest, undefined);
  tick();
  assert.equal(input.state('altitude').value, 0);
  send('pointermove', { tiltX: 30, clientX: 5 });
  tick();
  assert.equal(pen.inRange, true);
  assert.equal(pen.latest.x, 5);
  assert.equal(pen.latest.down, false);
  assert.equal(input.state('pressure').value, 0);
  assert.ok(input.state('tiltX').value > 0);
  send('pointerleave');
  tick();
  assert.equal(pen.inRange, false);
  assert.equal(input.state('tiltX').value, 0);
  assert.equal(input.state('hover').value, 0);
});

test('leaving the element during a stroke does not end it', () => {
  const { pen, send } = rig();
  send('pointerdown', { buttons: 1, pressure: 1 });
  send('pointerleave');
  assert.equal(pen.inRange, true);
});

test('barrel button and eraser read apart from the tip', () => {
  const { input, send, tick } = rig();
  send('pointerdown', { buttons: 3, pressure: 0.5 });
  tick();
  assert.equal(input.state('barrel').value, 1);
  assert.equal(input.state('eraser').value, 0);
  send('pointerup');
  send('pointerdown', { buttons: 32, button: 5, pressure: 0.5 });
  tick();
  assert.equal(input.state('eraser').value, 1);
  assert.equal(input.state('down').value, 1, 'the eraser touching is a touch');
  assert.equal(input.state('barrel').value, 0);
});

test('mouse and touch are ignored', () => {
  const { pen, send, tick, input } = rig();
  send('pointerdown', { pointerType: 'mouse', buttons: 1, pressure: 0.5 });
  send('pointermove', { pointerType: 'touch', buttons: 1, pressure: 0.5 });
  send('pointercancel', { pointerType: 'mouse' });
  send('pointerleave', { pointerType: 'mouse' });
  tick();
  assert.equal(pen.latest, undefined);
  assert.deepEqual(pen.take(), []);
  assert.equal(input.state('pressure').value, 0);
});

test('take gives every coalesced reading of a stroke, once, oldest first', () => {
  const { pen, send } = rig();
  send('pointerdown', { buttons: 1, pressure: 0.1, clientX: 0 });
  const part = (clientX, pressure) => ({ buttons: 1, pressure, clientX, clientY: 0, tiltX: 0, tiltY: 0, timeStamp: clientX });
  send('pointermove', { getCoalescedEvents: () => [part(1, 0.2), part(2, 0.3), part(3, 0.4)] });
  send('pointermove', { buttons: 1, pressure: 0.5, clientX: 4, getCoalescedEvents: () => [] });
  send('pointermove', { buttons: 1, pressure: 0.6, clientX: 5 });
  send('pointerup', { clientX: 6 });
  const samples = pen.take();
  assert.deepEqual(
    samples.map((s) => s.x),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    samples.map((s) => s.pressure),
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0],
  );
  assert.equal(samples.at(-1).down, false, 'the stroke ends');
  assert.equal(samples[2].time, 2);
  assert.deepEqual(pen.take(), []);
});

test('samples nobody takes stop at maxSamples, keeping the newest', () => {
  const { pen, send } = rig({ maxSamples: 2 });
  for (let i = 0; i < 5; i++) send('pointermove', { clientX: i });
  assert.deepEqual(
    pen.take().map((s) => s.x),
    [3, 4],
  );
});

test('a dab between two updates counts as down for one update', () => {
  const { input, send, tick } = rig();
  send('pointerdown', { buttons: 1, pressure: 0.5 });
  send('pointerup');
  tick();
  assert.equal(input.state('down').pressed, true);
  tick();
  assert.equal(input.state('down').released, true);
});

test('cancel ends the stroke with a closing sample', () => {
  const { input, pen, send, tick } = rig();
  send('pointerdown', { buttons: 3, pressure: 0.5 });
  tick();
  send('pointercancel');
  tick();
  assert.equal(input.state('pressure').released, true);
  assert.equal(input.state('barrel').value, 0);
  assert.equal(pen.inRange, false);
  const samples = pen.take();
  assert.equal(samples.length, 2);
  assert.deepEqual([samples[1].down, samples[1].pressure, samples[1].barrel], [false, 0, false]);
  send('pointercancel');
  assert.deepEqual(pen.take(), [], 'nothing more to close');
});

test('the curve shapes pressure, stays in range and leaves a hover at 0', () => {
  const { pen, send } = rig({ curve: (p) => p * p * 4 });
  send('pointerdown', { buttons: 1, pressure: 0.25 });
  near(pen.latest.pressure, 0.25);
  send('pointermove', { buttons: 1, pressure: 0.9 });
  assert.equal(pen.latest.pressure, 1);
  send('pointerup');
  assert.equal(pen.latest.pressure, 0);
  const broken = rig({ curve: () => NaN });
  broken.send('pointerdown', { buttons: 1, pressure: 0.5 });
  assert.equal(broken.pen.latest.pressure, 0.5, 'a curve that gives no number leaves the reading');
  const lifted = rig({ curve: () => 1 });
  lifted.send('pointermove', { pressure: 0 });
  assert.equal(lifted.pen.latest.pressure, 0);
});

test('angles come from tilt where the browser gives only tilt', () => {
  const { pen, send } = rig(),
    read = (tiltX, tiltY) => {
      send('pointermove', { tiltX, tiltY });
      return pen.latest;
    };
  near(read(0, 0).altitude, Math.PI / 2, 'upright');
  near(read(45, 0).altitude, Math.PI / 4);
  near(pen.latest.azimuth, 0, 'leaning right');
  near(read(0, 45).azimuth, Math.PI / 2, 'leaning toward the user');
  near(read(-45, 0).azimuth, Math.PI);
  near(read(0, -45).azimuth, Math.PI * 1.5);
  near(read(90, 0).altitude, 0, 'flat');
  near(pen.latest.azimuth, 0);
  near(read(0, -90).altitude, 0);
  near(pen.latest.azimuth, Math.PI * 1.5);
  near(read(45, 45).azimuth, Math.PI / 4);
  near(pen.latest.altitude, Math.atan(1 / Math.SQRT2));
});

test('tilt comes from angles where the browser gives only angles, and the two conversions agree', () => {
  const { pen, send } = rig();
  for (const [tiltX, tiltY] of [
    [30, 0],
    [0, -60],
    [45, 45],
    [-20, 70],
  ]) {
    send('pointermove', { tiltX, tiltY });
    const { altitude, azimuth } = pen.latest;
    send('pointermove', { tiltX: 0, tiltY: 0, altitudeAngle: altitude, azimuthAngle: azimuth });
    near(pen.latest.tiltX, tiltX, 'tiltX');
    near(pen.latest.tiltY, tiltY, 'tiltY');
  }
  send('pointermove', { tiltX: 10, tiltY: 0, altitudeAngle: 1, azimuthAngle: 2 });
  assert.equal(pen.latest.tiltX, 10, 'both given: each is kept');
  assert.equal(pen.latest.altitude, 1);
});

test('a stroke is captured to the pointer on the element', () => {
  const { element, send } = rig();
  element.setPointerCapture = (id) => element.captured.push(id);
  const event = Object.assign(new Event('pointerdown'), { pointerType: 'pen', pointerId: 9, buttons: 1, pressure: 1 });
  element.dispatchEvent(event);
  send('pointerup');
  assert.deepEqual(element.captured, [9]);
});

test('dispose stops listening, removes controls and can repeat', () => {
  const { input, pen, send } = rig(),
    control = input.control('pen');
  pen.dispose();
  pen.dispose();
  assert.notEqual(input.control('pen'), control);
  send('pointerdown', { buttons: 1, pressure: 1 });
  assert.equal(pen.latest, undefined);
  assert.equal(pen.inRange, false);
  using scoped = new Pen(new EventTarget());
  assert.equal(scoped.inRange, false);
});

test('options are checked', () => {
  assert.throws(() => new Pen(new EventTarget(), { maxSamples: 0 }), RangeError);
  assert.throws(() => new Pen(new EventTarget(), { curve: 1 }), TypeError);
});
