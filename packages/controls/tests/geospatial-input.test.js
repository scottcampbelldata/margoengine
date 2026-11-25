// GeospatialControls input devices: two-finger pinch, twist and tilt; pen; gamepad sticks and triggers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { degToRad, geodesicInverse } from '@margoengine/math/geo';
import { GeospatialControls } from '../dist/geospatial.js';
import { FakeElement, camera, pointer } from './control-fakes.js';

const start = { longitude: degToRad(-105), latitude: degToRad(40), heading: 0, pitch: degToRad(50), range: 8000 };
const rig = (options = {}) => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }),
    el = new FakeElement(),
    control = new GeospatialControls(cam, el, { view: start, clipPlanes: false, reducedMotion: true, ...options });
  return { el, control };
};
const touch = (el, type, id, x, y) => pointer(el, type, x, y, { pointerId: id, pointerType: 'touch' });

test('pinch zooms, a twist turns the heading, two fingers moving down tilt', () => {
  const { el, control } = rig();
  touch(el, 'pointerdown', 1, 300, 300);
  touch(el, 'pointerdown', 2, 500, 300);
  const v = control.view;
  // Spread from 200 to 400 px: twice as close.
  touch(el, 'pointermove', 1, 200, 300);
  touch(el, 'pointermove', 2, 600, 300);
  assert.ok(Math.abs(control.view.range / v.range - 0.5) < 0.05, `range ${control.view.range} from ${v.range}`);
  // A quarter turn of the finger pair turns the heading by a quarter turn.
  const h = control.view.heading;
  touch(el, 'pointermove', 1, 400, 100);
  touch(el, 'pointermove', 2, 400, 500);
  const turned = Math.abs(Math.abs(control.view.heading - h) - Math.PI / 2);
  assert.ok(turned < 0.2, `heading changed by ${control.view.heading - h}`);
  // Both fingers down by 60 px: tilt grows.
  const p = control.view.pitch;
  touch(el, 'pointermove', 1, 400, 160);
  touch(el, 'pointermove', 2, 400, 560);
  assert.ok(control.view.pitch !== p, 'two-finger drag tilts');
  touch(el, 'pointerup', 1, 400, 160);
  touch(el, 'pointerup', 2, 400, 560);
  // One finger after the gesture pans again.
  const c = control.view;
  touch(el, 'pointerdown', 3, 400, 300);
  touch(el, 'pointermove', 3, 450, 300);
  touch(el, 'pointerup', 3, 450, 300);
  assert.ok(geodesicInverse(c.longitude, c.latitude, control.view.longitude, control.view.latitude).distance > 0);
  control.dispose();
});

test('a pen pans with the tip and turns with the barrel button', () => {
  const { el, control } = rig();
  const v = control.view;
  pointer(el, 'pointerdown', 400, 300, { pointerType: 'pen' });
  pointer(el, 'pointermove', 440, 300, { pointerType: 'pen' });
  pointer(el, 'pointerup', 440, 300, { pointerType: 'pen' });
  assert.ok(geodesicInverse(v.longitude, v.latitude, control.view.longitude, control.view.latitude).distance > 0);
  const h = control.view.heading;
  pointer(el, 'pointerdown', 400, 300, { pointerType: 'pen', button: 2 });
  pointer(el, 'pointermove', 440, 300, { pointerType: 'pen', button: 2 });
  pointer(el, 'pointerup', 440, 300, { pointerType: 'pen', button: 2 });
  assert.notEqual(control.view.heading, h);
  control.dispose();
});

test('gamepad: the left stick pans at the height above the ground, the right trigger zooms in, a resting stick does nothing', () => {
  const pad = {
    connected: true,
    axes: [0, -1, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  };
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [null, pad] }, configurable: true });
  try {
    const { control } = rig({ gamepad: true });
    const v = control.view,
      above = control.eye.height;
    control.update(0.5);
    const d = geodesicInverse(v.longitude, v.latitude, control.view.longitude, control.view.latitude);
    assert.ok(Math.abs(d.distance - above / 2) < 0.05 * above, `stick moved ${d.distance} m at ${above} m up`);
    assert.ok(Math.abs(d.initialBearing) < 1e-3, 'stick up is north at heading 0');
    pad.axes = [0.1, -0.1, 0, 0]; // inside the dead zone
    pad.buttons[7] = { pressed: true, value: 1 };
    const r = control.view.range,
      at = control.view;
    control.update(1);
    assert.ok(Math.abs(control.view.range - r / 2) < 1e-6 * r, 'the right trigger halves the range in a second');
    assert.equal(control.view.longitude, at.longitude, 'a stick in the dead zone rests');
    control.dispose();
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    else delete globalThis.navigator;
  }
});
