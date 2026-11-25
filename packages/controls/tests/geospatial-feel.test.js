// GeospatialControls feel: per-axis glide after a fling, presets, height-scaled keys, double click, reduced motion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { degToRad, geodesicInverse } from '@margoengine/math/geo';
import { GeospatialControls } from '../dist/geospatial.js';
import { FakeElement, FakeTarget, camera, key, pointer } from './control-fakes.js';

const start = { longitude: degToRad(-87.6), latitude: degToRad(41.9), heading: 0, pitch: degToRad(60), range: 5000 };
const rig = (options = {}) => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }),
    el = new FakeElement(),
    keys = new FakeTarget(),
    control = new GeospatialControls(cam, el, {
      view: start,
      clipPlanes: false,
      keyTarget: keys,
      reducedMotion: false,
      ...options,
    });
  return { cam, el, keys, control };
};
const moved = (a, b) => geodesicInverse(a.longitude, a.latitude, b.longitude, b.latitude).distance;
// A quick drag: three moves 16 ms apart, released at once (or after a pause).
const fling = (el, button = 0, pause = 0) => {
  pointer(el, 'pointerdown', 400, 300, { button, timeStamp: 1000 });
  for (let i = 1; i <= 3; i++) pointer(el, 'pointermove', 400 + 30 * i, 300, { button, timeStamp: 1000 + 16 * i });
  pointer(el, 'pointerup', 490, 300, { button, timeStamp: 1048 + pause });
};

test('a fling glides on and slows down; a pause before release stops dead', () => {
  const { control, el } = rig();
  fling(el);
  const released = control.view;
  control.update(0.05);
  const first = moved(released, control.view);
  for (let i = 0; i < 80; i++) control.update(0.05);
  const total = moved(released, control.view);
  assert.ok(first > 0, 'the view keeps moving after release');
  assert.ok(total > first * 2 && total < first * 20, `glide ${first} then ${total} m`);
  const rest = control.view;
  control.update(0.05);
  assert.ok(moved(rest, control.view) < first * 1e-3, 'the glide has died away');
  // Same drag, held still for 200 ms before release: no glide.
  const b = rig();
  fling(b.el, 0, 200);
  const held = b.control.view;
  b.control.update(0.05);
  assert.equal(moved(held, b.control.view), 0);
  control.dispose();
  b.control.dispose();
});

test('inertia is per axis: no pan glide, but a turn still glides', () => {
  const { control, el } = rig({ inertia: { pan: 0 } });
  fling(el);
  const v = control.view;
  control.update(0.05);
  assert.equal(moved(v, control.view), 0, 'pan stops at once');
  fling(el, 2);
  const h = control.view.heading;
  control.update(0.05);
  assert.notEqual(control.view.heading, h, 'the heading glides on');
  assert.throws(() => control.setInertia({ rotate: -1 }), RangeError);
  control.dispose();
});

test('keys pan at the height above the ground per second, along the heading', () => {
  const { control, keys } = rig({ view: { ...start, heading: Math.PI / 2 } });
  const v = control.view,
    above = control.eye.height;
  key(keys, 'keydown', 'KeyW');
  for (let i = 0; i < 10; i++) control.update(0.1);
  key(keys, 'keyup', 'KeyW');
  const g = geodesicInverse(v.longitude, v.latitude, control.view.longitude, control.view.latitude);
  assert.ok(Math.abs(g.distance - above) < 0.05 * above, `moved ${g.distance} m at ${above} m up`);
  assert.ok(Math.abs(g.initialBearing - Math.PI / 2) < 1e-3, 'east, the heading');
  key(keys, 'keydown', 'Equal');
  control.update(1);
  key(keys, 'keyup', 'Equal');
  assert.ok(Math.abs(control.view.range - v.range / 2) < 1e-6 * v.range, 'plus halves the range in a second');
  control.dispose();
});

test('the dcc preset leaves the left button free and orbits with the middle; double click zooms only in globe', () => {
  const { control, el } = rig({ preset: 'dcc' });
  assert.equal(control.preset, 'dcc');
  const v = control.view;
  fling(el, 0);
  assert.deepEqual(control.view, v, 'left drag does nothing in dcc');
  fling(el, 1);
  assert.notEqual(control.view.heading, v.heading, 'middle drag turns');
  const r = control.view.range;
  el.dispatch('dblclick', { clientX: 400, clientY: 300, button: 0 });
  assert.equal(control.view.range, r);
  control.applyPreset('globe');
  el.dispatch('dblclick', { clientX: 400, clientY: 300, button: 0 });
  assert.ok(control.view.range < r * 0.6, 'double click zooms in two times');
  assert.throws(() => control.applyPreset('cad'), RangeError);
  control.dispose();
});

test('reduced motion: automatic flights land at once and nothing glides; an explicit duration still flies', async () => {
  const { control, el } = rig({ reducedMotion: true });
  const p = control.flyTo({ longitude: degToRad(-83), latitude: degToRad(42.3) });
  assert.equal(control.flightTime, null);
  assert.equal(await p, true);
  fling(el);
  const v = control.view;
  control.update(0.05);
  assert.equal(moved(v, control.view), 0);
  control.flyTo({ longitude: degToRad(-84), latitude: degToRad(42.3) }, { duration: 2 });
  assert.equal(control.flightTime.duration, 2);
  control.dispose();
});
