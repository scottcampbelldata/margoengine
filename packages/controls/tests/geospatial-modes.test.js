// GeospatialControls navigation modes: globe, local orbit, top-down map, first-person fly and walk, with smooth switches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { degToRad, ecefToCartographic } from '@margoengine/math/geo';
import { GeospatialControls } from '../dist/geospatial.js';
import { FakeElement, FakeTarget, camera, key, pointer } from './control-fakes.js';

const hills = (lon, lat) => 100 + 50 * Math.sin(lon * 20000) * Math.cos(lat * 20000);
const rig = (options = {}) => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }),
    el = new FakeElement(),
    keys = new FakeTarget(),
    control = new GeospatialControls(cam, el, {
      view: { longitude: degToRad(-105), latitude: degToRad(40), heading: 0.3, pitch: degToRad(45), range: 3000 },
      heightAt: hills,
      clipPlanes: false,
      keyTarget: keys,
      ...options,
    });
  return { cam, el, keys, control };
};
// Eye in geodetic (the default world is the Y-up (x, z, -y) of ECEF).
const eyeOf = (cam) => ecefToCartographic(cam.position[0], -cam.position[2], cam.position[1]);
const settle = (control, seconds = 1) => {
  for (let i = 0; i < seconds * 60 + 1; i++) control.update(1 / 60);
};

test('fly keeps the pose on entry; W moves along the view at a height-scaled speed; drag looks about the eye', async () => {
  const { control, cam, keys, el } = rig();
  const before = [...cam.position];
  assert.equal(await control.setMode('fly'), true);
  assert.equal(control.mode, 'fly');
  assert.ok(Math.hypot(...cam.position.map((v, i) => v - before[i])) < 1e-3, 'entering fly does not move the eye');
  const e0 = eyeOf(cam),
    speed = control.moveSpeed;
  assert.ok(Math.abs(speed - (e0.height - hills(e0.longitude, e0.latitude))) < 1e-6 * speed, `fly speed ${speed}`);
  key(keys, 'keydown', 'KeyW');
  control.update(0.5);
  key(keys, 'keyup', 'KeyW');
  const moved = Math.hypot(...cam.position.map((v, i) => v - before[i]));
  assert.ok(Math.abs(moved - speed * 0.5) < 0.02 * speed, `moved ${moved} of ${speed * 0.5}`);
  assert.ok(eyeOf(cam).height < e0.height, 'W at a 45 degree pitch descends along the view');
  // A drag turns the view about the eye: the eye stays.
  const at = [...cam.position];
  pointer(el, 'pointerdown', 400, 300);
  pointer(el, 'pointermove', 500, 200);
  pointer(el, 'pointerup', 500, 200);
  assert.ok(Math.hypot(...cam.position.map((v, i) => v - at[i])) < 1e-3, 'looking keeps the eye in place');
  control.dispose();
});

test('walk lands on the ground at eyeHeight with a level view and follows the ground as it moves', async () => {
  const { control, cam, keys } = rig({ eyeHeight: 1.8, walkSpeed: 10 });
  const switching = control.setMode('walk', { duration: 0.5 });
  settle(control, 0.6);
  assert.equal(await switching, true);
  const check = () => {
    const e = eyeOf(cam);
    assert.ok(
      Math.abs(e.height - hills(e.longitude, e.latitude) - 1.8) < 1e-3,
      `eye ${e.height - hills(e.longitude, e.latitude)} above the ground`,
    );
  };
  check();
  assert.ok(Math.abs(control.view.pitch) < 1e-6, 'the view is level');
  for (let i = 0; i < 30; i++) {
    key(keys, 'keydown', 'KeyW');
    control.update(0.1);
    check();
  }
  key(keys, 'keyup', 'KeyW');
  // Walk to fly keeps the pose: no move to wait for, even at a 1 m orbit range on the planet.
  const fly = control.setMode('fly');
  assert.equal(control.flightTime, null);
  assert.equal(await fly, true);
  control.dispose();
});

test('map turns straight down and the right drag turns the heading only; local swaps the buttons', async () => {
  const { control, el } = rig();
  const m = control.setMode('map', { duration: 0.3 });
  settle(control, 0.4);
  assert.equal(await m, true);
  assert.equal(control.view.pitch, Math.PI / 2);
  const h = control.view.heading;
  pointer(el, 'pointerdown', 400, 300, { button: 2 });
  pointer(el, 'pointermove', 450, 350, { button: 2 });
  pointer(el, 'pointerup', 450, 350, { button: 2 });
  assert.equal(control.view.pitch, Math.PI / 2, 'no tilt in map');
  assert.notEqual(control.view.heading, h);
  // Local: the left button turns about the centre, the centre stays.
  await control.setMode('local', { duration: 0 });
  const v = control.view;
  pointer(el, 'pointerdown', 400, 300);
  pointer(el, 'pointermove', 380, 280);
  pointer(el, 'pointerup', 380, 280);
  assert.notEqual(control.view.heading, v.heading);
  assert.ok(
    Math.abs(control.view.longitude - v.longitude) < 1e-7 && Math.abs(control.view.latitude - v.latitude) < 1e-7,
  );
  control.dispose();
});

test('a switch moves smoothly: no frame jumps more than a small part of the whole move, and back to globe clamps pitch', async () => {
  const { control, cam } = rig();
  await control.setMode('fly');
  control.look(0, -0.4); // look above the horizon: beyond the globe's pitch range
  const start = [...cam.position];
  const back = control.setMode('globe', { duration: 1 });
  let last = [...cam.position],
    worst = 0;
  for (let i = 0; i < 61; i++) {
    control.update(1 / 60);
    worst = Math.max(worst, Math.hypot(...cam.position.map((v, j) => v - last[j])));
    last = [...cam.position];
  }
  assert.equal(await back, true);
  const total = Math.hypot(...cam.position.map((v, j) => v - start[j]));
  assert.ok(control.view.pitch >= 0, 'globe pitch is back in range');
  assert.ok(total > 0 && worst < total / 10, `largest step ${worst} of ${total}`);
  assert.throws(() => control.setMode('swim'), RangeError);
  control.dispose();
});
