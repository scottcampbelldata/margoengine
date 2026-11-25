// Collision of GeospatialControls: the whole near plane stays clear of terrain, tiles and meshes, in flights too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { WGS84_A, degToRad, ecefToCartographic } from '@margoengine/math/geo';
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
const eyeOf = (cam) => ecefToCartographic(cam.position[0], -cam.position[2], cam.position[1]);
// Near-plane corners of the camera, world coordinates (Y-up world of ECEF).
function nearCorners(cam, width = 800, height = 600) {
  const p = cam.position,
    f = cam.target.map((v, i) => v - p[i]),
    l = Math.hypot(...f),
    fw = f.map((v) => v / l),
    u0 = cam.up,
    r = [fw[1] * u0[2] - fw[2] * u0[1], fw[2] * u0[0] - fw[0] * u0[2], fw[0] * u0[1] - fw[1] * u0[0]],
    rl = Math.hypot(...r),
    right = r.map((v) => v / rl),
    up = [right[1] * fw[2] - right[2] * fw[1], right[2] * fw[0] - right[0] * fw[2], right[0] * fw[1] - right[1] * fw[0]],
    h = cam.near * Math.tan((cam.fov * Math.PI) / 360),
    w = (h * width) / height;
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) out.push(p.map((v, i) => v + fw[i] * cam.near + right[i] * sx * w + up[i] * sy * h));
  return out;
}
const heightOf = (w) => ecefToCartographic(w[0], -w[2], w[1]);

test('every near-plane corner keeps the clearance above heightAt, not only the eye', () => {
  // A cliff: 0 m west of longitude 0, 400 m east. The eye stands west of the edge looking east into the cliff.
  const cliff = (lon) => (lon > 0 ? 400 : 0),
    cam = camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }),
    control = new GeospatialControls(cam, new FakeElement(), {
      view: { longitude: 2e-6, latitude: 0, height: 0, heading: Math.PI / 2, pitch: 0.05, range: 30 },
      heightAt: cliff,
      clearance: 2,
      clipPlanes: false,
    });
  cam.near = 1;
  control.setView({});
  for (const c of nearCorners(cam)) {
    const g = heightOf(c);
    assert.ok(g.height >= cliff(g.longitude) + 2 - 1e-3, `corner at ${g.height} m over ground ${cliff(g.longitude)}`);
  }
  control.dispose();
});

test('a building between the centre and the eye pulls the camera in front of it (scene sweep)', async () => {
  const { engine } = await world();
  // A 200 m tall, 100 m thick wall 300 m east of the centre at longitude 0, latitude 0 (ECEF up is world +X).
  engine.createMesh().setGeometry(box()).setPosition([WGS84_A + 100, 0, -300]).setScale([200, 2000, 100]);
  // Camera 600 m east of the centre looking west, low: the wall stands between.
  const control = GeospatialControls.attach(engine, undefined, {
    view: { longitude: 0, latitude: 0, height: 0, heading: -Math.PI / 2, pitch: 0.1, range: 600 },
    clearance: 3,
  });
  const e = eyeOf(engine.camera);
  const eastOfCentre = (e.longitude * WGS84_A);
  assert.ok(eastOfCentre < 250 - 3 + 1, `the eye is ${eastOfCentre} m east, behind the wall`);
  assert.ok(control.collisionRange < 600, 'the arm was shortened');
  control.underground = true;
  control.setView({});
  assert.ok(eyeOf(engine.camera).longitude * WGS84_A > 500, 'underground mode turns collision off');
  control.dispose();
  engine.dispose();
});

test('a roof under the eye lifts it by the clearance (scene down rays)', async () => {
  const { engine } = await world();
  engine.createMesh().setGeometry(box()).setPosition([WGS84_A, 0, 0]).setScale([300, 4000, 4000]);
  const control = GeospatialControls.attach(engine, undefined, {
    view: { longitude: 0, latitude: 0, height: 0, heading: 0, pitch: Math.PI / 2, range: 151 },
    clearance: 5,
  });
  assert.ok(eyeOf(engine.camera).height >= 155 - 1, `eye at ${eyeOf(engine.camera).height} m over a 150 m roof`);
  control.dispose();
  engine.dispose();
});

test('flyTo never takes the eye below the terrain clearance on the way', async () => {
  const ridge = (lon) => (lon > degToRad(0.5) && lon < degToRad(0.6) ? 3000 : 100),
    cam = camera({ position: [0, 0, 1], target: [0, 0, 0] }),
    control = new GeospatialControls(cam, new FakeElement(), {
      view: { longitude: 0, latitude: 0, height: 100, heading: Math.PI / 2, pitch: 0.2, range: 300 },
      heightAt: ridge,
      clearance: 10,
    });
  const p = control.flyTo({ longitude: degToRad(1), latitude: 0, height: 100, range: 300 }, { duration: 2, arc: false });
  let lowest = Infinity;
  for (let i = 0; i < 200; i++) {
    control.update(0.01);
    const e = eyeOf(cam);
    lowest = Math.min(lowest, e.height - ridge(e.longitude));
  }
  assert.equal(await p, true);
  assert.ok(lowest >= 10 - 1e-3, `the eye came within ${lowest} m of the ground`);
  control.dispose();
});
