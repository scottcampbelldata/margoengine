// GeospatialControls.followPath: a cinematic move through views on a centripetal Catmull-Rom curve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { degToRad, geodesicInverse } from '@margoengine/math/geo';
import { GeospatialControls } from '../dist/geospatial.js';
import { FakeElement, camera } from './control-fakes.js';

const rig = () => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }),
    el = new FakeElement(),
    control = new GeospatialControls(cam, el, {
      view: { longitude: degToRad(-83), latitude: degToRad(42), heading: 0, pitch: degToRad(40), range: 2000 },
      clipPlanes: false,
    });
  return { el, control };
};
// A shoreline: four views a few km apart, turning and climbing.
const views = [
  { longitude: degToRad(-82.98), latitude: degToRad(42.01), heading: degToRad(30), range: 1500 },
  { longitude: degToRad(-82.95), latitude: degToRad(42.03), heading: degToRad(80), pitch: degToRad(25), range: 2500 },
  { longitude: degToRad(-82.9), latitude: degToRad(42.02), heading: degToRad(170), range: 4000 },
];

test('followPath passes through every view, lands on the last, and every step is small', async () => {
  const { control } = rig();
  const done = control.followPath(views, { duration: 6, easing: (t) => t });
  const near = views.map(() => Infinity);
  let last = control.view,
    worst = 0;
  for (let i = 0; i < 6 * 120 + 2; i++) {
    control.update(1 / 120);
    const v = control.view;
    views.forEach((w, k) => {
      near[k] = Math.min(near[k], geodesicInverse(v.longitude, v.latitude, w.longitude, w.latitude).distance);
    });
    worst = Math.max(worst, geodesicInverse(last.longitude, last.latitude, v.longitude, v.latitude).distance);
    last = v;
  }
  assert.equal(await done, true);
  // 120 frames a second over about 10 km: a frame moves tens of metres, and the curve meets each view within one.
  near.forEach((d, k) => assert.ok(d < worst, `view ${k} missed by ${d} m (step ${worst} m)`));
  const end = control.view;
  assert.ok(Math.abs(end.heading - degToRad(170)) < 1e-9 && Math.abs(end.range - 4000) < 1e-6);
  assert.ok(worst < 100, `largest step ${worst} m`);
  control.dispose();
});

test('followPath picks a duration from its length, and a wheel turn cancels it', async () => {
  const { control, el } = rig();
  const p = control.followPath(views);
  assert.ok(control.flightTime.duration > 1);
  el.dispatch('wheel', { deltaY: -100, deltaMode: 0, clientX: 400, clientY: 300 });
  assert.equal(await p, false);
  assert.throws(() => control.followPath([]), RangeError);
  control.dispose();
});
