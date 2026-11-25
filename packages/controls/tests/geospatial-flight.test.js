// GeospatialControls flights on the van Wijk and Nuij (2003) optimal zoom-and-pan path, and framing helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cartographicToEcef, degToRad, ecefToCartographic, geodesicInverse } from '@margoengine/math/geo';
import { GeospatialControls, zoomPanPath } from '../dist/geospatial.js';
import { FakeElement, camera } from './control-fakes.js';

const rig = (view) => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }),
    el = new FakeElement(),
    control = new GeospatialControls(cam, el, { view, clipPlanes: false });
  return { cam, el, control };
};
const start = { longitude: 0, latitude: 0, height: 0, heading: 0, pitch: Math.PI / 2, range: 1000 };

test('zoomPanPath meets both ends, and matches the closed form of the paper', () => {
  const w0 = 1000,
    w1 = 500,
    u1 = 1e6,
    rho = 1.42,
    p = zoomPanPath(w0, w1, u1, rho);
  const a = p.at(0),
    b = p.at(p.S);
  assert.ok(Math.abs(a.u) < 1e-6 && Math.abs(a.w - w0) < 1e-6);
  assert.ok(Math.abs(b.u - u1) < 1e-3 * u1 * 1e-3 && Math.abs(b.w - w1) < 1e-6 * w1, `end ${b.u}, ${b.w}`);
  // The paper's S for these numbers, worked by hand from its equations (9) and (10).
  const r2 = rho * rho,
    bb = (wi, sgn) => (w1 * w1 - w0 * w0 + sgn * r2 * r2 * u1 * u1) / (2 * wi * r2 * u1),
    r = (x) => Math.log(Math.sqrt(x * x + 1) - x);
  assert.ok(Math.abs(p.S - (r(bb(w1, -1)) - r(bb(w0, 1))) / rho) < 1e-9);
  // Pure zoom: S = |ln(w1 / w0)| / rho.
  assert.ok(Math.abs(zoomPanPath(1000, 10, 0, rho).S - Math.log(100) / rho) < 1e-12);
  assert.throws(() => zoomPanPath(0, 1, 1), RangeError);
});

test('flyTo climbs on the optimal path: the peak range is the path peak, pan progress never reverses', async () => {
  const { control, cam } = rig(start);
  const dest = { longitude: degToRad(10), latitude: 0, height: 0, heading: 0, pitch: Math.PI / 2, range: 1000 };
  const flight = control.flyTo(dest, { duration: 4, easing: (t) => t });
  const scale = 1 / (2 * Math.tan(Math.PI / 6)),
    u1 = geodesicInverse(0, 0, dest.longitude, 0).distance,
    path = zoomPanPath(1000 / scale, 1000 / scale, u1);
  let peak = 0,
    last = 0;
  // 401 steps: 400 x 0.01 sums to just under 4 in floating point.
  for (let i = 0; i < 401; i++) {
    control.update(0.01);
    const v = control.view,
      u = geodesicInverse(0, 0, v.longitude, v.latitude).distance;
    assert.ok(u >= last - 1e-6, 'pan went backward');
    last = u;
    peak = Math.max(peak, v.range);
  }
  assert.equal(await flight, true);
  // Symmetric hop: the peak width is at s = S / 2.
  const top = path.at(path.S / 2).w * scale;
  assert.ok(Math.abs(peak - top) / top < 1e-3, `peak ${peak} vs path ${top}`);
  assert.ok(peak > 1e5, 'the path climbs over a long hop');
  void cam;
  control.dispose();
});

test('duration follows the path length when not given, within 1 s and maxDuration', () => {
  const { control } = rig(start);
  control.flyTo({ longitude: degToRad(0.01), latitude: 0, range: 1000 });
  const near = control.flightTime.duration;
  control.flyTo({ longitude: degToRad(60), latitude: 0, range: 1000 });
  const far = control.flightTime.duration;
  assert.ok(near >= 1 && far > near && far <= 10, `${near} and ${far}`);
  control.flyTo({ longitude: degToRad(60), latitude: 0, range: 1000 }, { maxDuration: 3 });
  assert.equal(control.flightTime.duration, 3);
  control.dispose();
});

test('a pointer press or the wheel cancels a flight; cancelOnInput false keeps it', async () => {
  const { control, el } = rig(start);
  const a = control.flyTo({ longitude: 1, latitude: 0 }, { duration: 5 });
  control.update(0.5);
  el.dispatch('wheel', { deltaY: -100, deltaMode: 0, clientX: 400, clientY: 300 });
  assert.equal(await a, false);
  const b = control.flyTo({ longitude: 1, latitude: 0 }, { duration: 5 });
  el.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  el.dispatch('pointerup', { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  assert.equal(await b, false);
  const c = control.flyTo({ longitude: 1, latitude: 0 }, { duration: 1, cancelOnInput: false });
  el.dispatch('pointerdown', { pointerId: 2, button: 0, clientX: 10, clientY: 10 });
  el.dispatch('pointerup', { pointerId: 2, button: 0, clientX: 10, clientY: 10 });
  for (let i = 0; i < 20; i++) control.update(0.1);
  assert.equal(await c, true);
  control.dispose();
});

test('flyToBoundingSphere frames the sphere; fitBounds keeps every corner in view', async () => {
  const { control, cam } = rig(start);
  const done = control.flyToBoundingSphere({ longitude: 0.2, latitude: 0.1, height: 50 }, 500, {
    duration: 0,
    padding: 1,
  });
  assert.equal(await done, true);
  // Width 800 / height 600: the vertical 30 degree half angle bounds it.
  assert.ok(Math.abs(control.view.range - 500 / Math.sin(Math.PI / 6)) < 1e-6);
  const box = { west: degToRad(-0.2), south: degToRad(-0.1), east: degToRad(0.3), north: degToRad(0.25) };
  assert.equal(await control.fitBounds(box, { duration: 0 }), true);
  const eye = cam.position,
    f = cam.target.map((v, i) => v - eye[i]),
    fl = Math.hypot(...f);
  for (const lon of [box.west, box.east])
    for (const lat of [box.south, box.north]) {
      const p = cartographicToEcef(lon, lat, 0),
        w = [p[0], p[2], -p[1]],
        d = w.map((v, i) => v - eye[i]);
      const angle = Math.acos(d.reduce((s, v, i) => s + v * f[i], 0) / (Math.hypot(...d) * fl));
      assert.ok(angle < Math.PI / 6, `corner ${lon}, ${lat} is ${angle} rad off the axis`);
    }
  assert.ok(Math.abs(ecefToCartographic(...[eye[0], -eye[2], eye[1]]).latitude - degToRad(0.075)) < 1e-3);
  control.dispose();
});
