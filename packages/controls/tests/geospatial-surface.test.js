// Surface-true picking of GeospatialControls: zoom, pan and turn grab the real surface (bvh scene, raycast, heightAt).
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { WGS84_A, cartographicToEcef } from '@margoengine/math/geo';
import { GeospatialControls } from '../dist/geospatial.js';
import { FakeElement, camera } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
async function world() {
  const canvas = new Canvas();
  const engine = new Runtime(
    canvas,
    await TransformStore.create(64),
    { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 1], target: [0, 0, 0] },
    null,
  );
  return { engine, canvas };
}
// A 300 m tall, 4 km wide block standing on the ellipsoid at longitude 0, latitude 0 (ECEF up is +X, world (x, z, -y)).
const building = (engine) =>
  engine.createMesh().setGeometry(box()).setPosition([WGS84_A, 0, 0]).setScale([600, 4000, 4000]);
const down = { longitude: 0, latitude: 0, height: 0, heading: 0.3, pitch: 1.1, range: 5000 };
const ecef = (p) => cartographicToEcef(p.longitude, p.latitude, p.height);
const gap = (a, b) => Math.hypot(...ecef(a).map((v, i) => v - ecef(b)[i]));

test('pick hits the scene mesh roof, not the ellipsoid', async () => {
  const { engine } = await world();
  building(engine);
  const control = GeospatialControls.attach(engine, undefined, { view: down });
  const hit = control.pick(400, 300);
  assert.equal(hit.source, 'scene');
  assert.ok(Math.abs(hit.height - 300) < 2, `roof height, got ${hit.height}`);
  control.scene = false;
  assert.equal(control.pick(400, 300).source, 'ellipsoid');
  control.dispose();
  engine.dispose();
});

test('zoomAt keeps the roof point under the cursor', async () => {
  const { engine } = await world();
  building(engine);
  const control = GeospatialControls.attach(engine, undefined, { view: down });
  const before = control.pick(520, 230);
  assert.equal(before.source, 'scene');
  control.zoomAt(520, 230, 0.25);
  const after = control.pick(520, 230);
  assert.equal(after.source, 'scene');
  assert.ok(gap(before, after) < 1.5, `the roof point drifted ${gap(before, after)} m`);
  assert.ok(Math.abs(control.view.range - 1250) < 1e-6);
  // The eye moved toward the roof: a quarter of the way along the ray.
  assert.ok(Math.abs(after.distance - before.distance / 4) < 1.5);
  control.dispose();
  engine.dispose();
});

test('heightAt terrain is picked by a march, and the wheel zooms toward it', () => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], near: 1, far: 1e9 }),
    el = new FakeElement(),
    control = new GeospatialControls(cam, el, { view: { ...down, range: 20000 }, heightAt: () => 1200 });
  const hit = control.pick(300, 200);
  assert.equal(hit.source, 'terrain');
  assert.ok(Math.abs(hit.height - 1200) < 1e-3, `plateau height, got ${hit.height}`);
  el.dispatch('wheel', { deltaY: -500, deltaMode: 0, clientX: 300, clientY: 200 });
  const after = control.pick(300, 200);
  // Re-levelling at the new centre may turn the view by a hair: allow a tenth of a pixel (60 degrees over 600 px).
  assert.ok(gap(hit, after) / after.distance < 0.1 * (Math.PI / 3 / 600), `drifted ${gap(hit, after)} m`);
  control.dispose();
});

test('anchored drag: the grabbed surface point stays under the cursor', () => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], near: 1, far: 1e9 }),
    el = new FakeElement(),
    control = new GeospatialControls(cam, el, { view: { ...down, pitch: 0.7, range: 8000 }, heightAt: () => 500 });
  const grabbed = control.pick(300, 250);
  el.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 300, clientY: 250 });
  for (const [x, y] of [[340, 280], [420, 330], [500, 260]]) {
    el.dispatch('pointermove', { pointerId: 1, button: 0, clientX: x, clientY: y });
    const under = control.pick(x, y);
    assert.ok(gap(grabbed, under) < 0.05, `at (${x}, ${y}) the grab drifted ${gap(grabbed, under)} m`);
  }
  el.dispatch('pointerup', { pointerId: 1, button: 0, clientX: 500, clientY: 260 });
  control.dispose();
});

test('turns pivot about the surface in the middle of the screen', () => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], near: 1, far: 1e9 }),
    el = new FakeElement(),
    control = new GeospatialControls(cam, el, { view: { ...down, pitch: 0.8 }, heightAt: () => 800 });
  const centre = control.pick(400, 300);
  el.dispatch('pointerdown', { pointerId: 2, button: 2, clientX: 400, clientY: 300 });
  assert.ok(Math.abs(control.view.height - 800) < 1e-3, 'the orbit centre moved onto the plateau');
  el.dispatch('pointermove', { pointerId: 2, button: 2, clientX: 480, clientY: 340 });
  el.dispatch('pointerup', { pointerId: 2, button: 2, clientX: 480, clientY: 340 });
  const after = control.pick(400, 300);
  assert.ok(gap(centre, after) < 0.05, `the pivot moved ${gap(centre, after)} m`);
  control.dispose();
});

test('a raycast option is used, and the nearest of all surfaces wins', () => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], near: 1, far: 1e9 }),
    el = new FakeElement();
  let calls = 0;
  const control = new GeospatialControls(cam, el, {
    view: down,
    heightAt: () => 100,
    raycast: (origin, direction, far) => (calls++, Math.min(far, 1000)),
  });
  const hit = control.pick(400, 300);
  assert.ok(calls > 0);
  assert.equal(hit.source, 'raycast');
  assert.ok(Math.abs(hit.distance - 1000) < 1e-9);
  control.raycast = () => undefined;
  assert.equal(control.pick(400, 300).source, 'terrain');
  control.dispose();
});
