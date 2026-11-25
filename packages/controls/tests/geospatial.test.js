import test from 'node:test';
import assert from 'node:assert/strict';
import { GeospatialControls } from '../dist/geospatial.js';
import { cartographicToEcef, ecefToCartographic, degToRad, geodesicInverse } from '@margoengine/math/geo';
import { camera, FakeElement } from './control-fakes.js';

const rig = (options = {}) => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], near: 1, far: 1e9 }),
    el = new FakeElement(),
    control = new GeospatialControls(cam, el, options);
  return { cam, el, control };
};
const view = { longitude: degToRad(10), latitude: degToRad(50), height: 100, heading: 0.4, pitch: 0.9, range: 5000 };
const eyeOf = (cam) => ecefToCartographic(cam.position[0], -cam.position[2], cam.position[1]); // Y-up world -> ECEF
const targetOf = (cam) => ecefToCartographic(cam.target[0], -cam.target[2], cam.target[1]);

test('the camera orbits the geodetic centre at range, heading and pitch', () => {
  const { cam, control } = rig({ view });
  const t = targetOf(cam), e = eyeOf(cam);
  assert.ok(Math.abs(t.longitude - view.longitude) < 1e-9 && Math.abs(t.height - 100) < 1e-4);
  const a = cartographicToEcef(t.longitude, t.latitude, t.height), b = cartographicToEcef(e.longitude, e.latitude, e.height);
  assert.ok(Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - 5000) < 1e-4);
  assert.ok(e.height > 100 + 5000 * Math.sin(0.9) - 20);
  control.dispose();
});

test('pan follows the geodesic by the metres asked; pitch and range clamp', () => {
  const { control } = rig({ view });
  control.pan(0, 2000);
  const v = control.view, g = geodesicInverse(view.longitude, view.latitude, v.longitude, v.latitude);
  assert.ok(Math.abs(g.distance - 2000) < 1e-3 && Math.abs(g.initialBearing) < 1e-9);
  control.setView({ pitch: 9, range: 1e12 });
  assert.equal(control.view.pitch, Math.PI / 2);
  assert.equal(control.view.range, control.maxRange);
});

test('terrain clearance holds: a hill under the eye lifts the view, and it settles when the hill goes', () => {
  let hill = 900;
  const { cam, control } = rig({ view: { ...view, height: 0, pitch: 0.2, range: 300 }, heightAt: () => hill, clearance: 5 });
  assert.ok(eyeOf(cam).height >= 905 - 1e-3);
  assert.ok(control.terrainLift > 0);
  hill = 0;
  control.setView({});
  assert.ok(control.terrainLift === 0 && eyeOf(cam).height < 100);
  control.dispose();
});

test('without heightAt the eye keeps the clearance above the ellipsoid', () => {
  const { cam, control } = rig({ view: { ...view, height: -500, range: 100 }, clearance: 10 });
  assert.ok(eyeOf(cam).height >= 10 - 1e-6);
  control.dispose();
});

test('zoomAt keeps the surface point under the cursor', () => {
  const { control } = rig({ view: { ...view, height: 0, pitch: 1.2, range: 20000 } });
  const before = control.pick(500, 250);
  control.zoomAt(500, 250, 0.5);
  const after = control.pick(500, 250), a = cartographicToEcef(before.longitude, before.latitude, 0), b = cartographicToEcef(after.longitude, after.latitude, 0);
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 30, 'the point under the cursor drifted');
  assert.ok(Math.abs(control.view.range - 10000) < 1e-6);
});

test('flyTo arrives, resolves true, and follows the geodesic with an arc', async () => {
  const { control } = rig({ view: { ...view, height: 0, range: 1000 } });
  const dest = { longitude: degToRad(-70), latitude: degToRad(-30), height: 0, range: 2000, heading: 1, pitch: 0.7 };
  const p = control.flyTo(dest, { duration: 2 });
  let peak = 0;
  for (let i = 0; i < 20; i++) { control.update(0.1); peak = Math.max(peak, control.view.range); }
  assert.equal(await p, true);
  assert.ok(peak > 1e6, 'arc raises the range over a long hop');
  const v = control.view;
  assert.ok(Math.abs(v.longitude - dest.longitude) < 1e-12 && Math.abs(v.latitude - dest.latitude) < 1e-12 && Math.abs(v.range - 2000) < 1e-6);
  control.dispose();
});

test('flyTo is cancelled by AbortSignal, a new flight and dispose; an aborted signal does nothing', async () => {
  const { control } = rig({ view });
  const ac = new AbortController();
  const a = control.flyTo({ longitude: 0, latitude: 0 }, { signal: ac.signal });
  control.update(0.5);
  ac.abort();
  assert.equal(await a, false);
  const mid = control.view;
  control.update(1);
  assert.deepEqual(control.view, mid);
  const b = control.flyTo({ longitude: 0, latitude: 0 });
  const c = control.flyTo({ longitude: 1, latitude: 0 });
  assert.equal(await b, false);
  control.dispose();
  assert.equal(await c, false);
  assert.equal(await rig({ view }).control.flyTo({ longitude: 0, latitude: 0 }, { signal: AbortSignal.abort() }), false);
});

test('bad input is rejected with coded errors', () => {
  const { control } = rig({ view });
  assert.throws(() => control.setView({ latitude: 90 }), RangeError);
  assert.throws(() => control.setView({ longitude: NaN }), RangeError);
  assert.throws(() => control.zoom(0), RangeError);
  assert.throws(() => rig({ minPitch: 2, maxPitch: 1 }), RangeError);
  control.dispose();
  assert.throws(() => control.pan(1, 1), (e) => e.code === 'disposed');
});

test('drag pans, right-drag rotates, wheel zooms; listeners are removed on dispose', () => {
  const { control, el } = rig({ view });
  const start = control.view;
  el.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  el.dispatch('pointermove', { pointerId: 1, button: 0, clientX: 160, clientY: 130 });
  el.dispatch('pointerup', { pointerId: 1, button: 0, clientX: 160, clientY: 130 });
  assert.notEqual(control.view.latitude, start.latitude);
  const h = control.view.heading;
  el.dispatch('pointerdown', { pointerId: 2, button: 2, clientX: 100, clientY: 100 });
  el.dispatch('pointermove', { pointerId: 2, button: 2, clientX: 140, clientY: 100 });
  el.dispatch('pointerup', { pointerId: 2, button: 2, clientX: 140, clientY: 100 });
  assert.notEqual(control.view.heading, h);
  const r = control.view.range;
  el.dispatch('wheel', { deltaY: -500, deltaMode: 0, clientX: 400, clientY: 300 });
  assert.ok(Math.abs(control.view.range - r / 2) < 1e-6);
  control.dispose();
  assert.equal(el.listenerCount, 0);
});
