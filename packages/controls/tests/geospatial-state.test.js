// GeospatialControls readouts and state: heights, ENU orientation, north-up, compass and moveend events, save/restore
// and the URL hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { degToRad } from '@margoengine/math/geo';
import { GeospatialControls } from '../dist/geospatial.js';
import { FakeElement, camera } from './control-fakes.js';

const start = {
  longitude: degToRad(-84.5),
  latitude: degToRad(45.8),
  heading: degToRad(120),
  pitch: degToRad(35),
  range: 3000,
};
const rig = (options = {}) => {
  const cam = camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }),
    el = new FakeElement(),
    control = new GeospatialControls(cam, el, { view: start, clipPlanes: false, reducedMotion: true, ...options });
  return { el, control };
};

test('heights above the ellipsoid, the terrain and the geoid; orientation in the eye ENU frame', () => {
  const { control } = rig({ heightAt: () => 180, geoid: () => -35 });
  const h = control.heights;
  assert.ok(Math.abs(h.terrain - (h.ellipsoid - 180)) < 1e-6);
  assert.ok(Math.abs(h.seaLevel - (h.ellipsoid + 35)) < 1e-6);
  const o = control.orientation;
  // At 3 km range the eye frame and the centre frame differ by about range / radius.
  assert.ok(Math.abs(o.heading - start.heading) < 1e-3 && Math.abs(o.pitch - start.pitch) < 1e-3, JSON.stringify(o));
  // Level in the centre's frame: in the eye's frame, 3 km away, the roll is of the order of range / radius.
  assert.ok(Math.abs(o.roll) < 1e-3, `roll ${o.roll}`);
  assert.equal(rig().control.heights.seaLevel, null, 'no geoid, no sea level');
});

test('compass events on heading changes only; moveend once the view settles; north-up turns to heading 0', async () => {
  const { control } = rig();
  const compass = [],
    ends = [];
  control.addEventListener('compass', (e) => compass.push(e.heading));
  control.addEventListener('moveend', (e) => ends.push(e.view));
  control.setView({ range: 2000 });
  assert.equal(compass.length, 0, 'a zoom is not a compass change');
  control.update(0);
  control.update(0);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].range, 2000);
  control.rotate(0.1, 0);
  assert.equal(compass.length, 1);
  assert.equal(await control.resetNorth(), true);
  assert.ok(Math.abs(control.view.heading) < 1e-12);
  control.dispose();
});

test('saveView and restoreView round trip, mode included; the hash form round trips to its precision', async () => {
  const { control } = rig();
  await control.setMode('map');
  const saved = control.saveView();
  assert.equal(saved.mode, 'map');
  control.setView({ longitude: 0, latitude: 0 });
  await control.setMode('globe');
  assert.equal(await control.restoreView(JSON.parse(JSON.stringify(saved)), { duration: 0 }), true);
  assert.deepEqual(control.saveView(), saved);
  const hash = control.toHash(),
    back = GeospatialControls.parseHash(`#x=1&${hash.slice(1)}`);
  assert.match(hash, /^#geo=45\.8,-84\.5,0,3000,120,90,map$/);
  assert.equal(back.mode, 'map');
  assert.ok(Math.abs(back.latitude - saved.latitude) < 1e-9 && Math.abs(back.range - 3000) < 0.01);
  assert.equal(GeospatialControls.parseHash('#geo=95,0,0,10,0,0'), null, 'latitude past the pole');
  assert.equal(GeospatialControls.parseHash('#zoom=3'), null);
  // Untrusted links: anything not finite or out of range gives no view.
  for (const bad of [
    '#geo=NaN,0,0,10,0,0',
    '#geo=0,Infinity,0,10,0,0',
    '#geo=0,0,1e300,10,0,0',
    '#geo=0,0,-1e7,10,0,0',
    '#geo=0,0,0,0,0,0',
    '#geo=0,0,0,-5,0,0',
    '#geo=0,0,0,1e12,0,0',
    '#geo=0,0,0,10,1e9,0',
    '#geo=0,0,0,10,0,500',
    '#geo=0,0,0,10,0,0,swim',
    '#geo=0,0,0,10,0',
    '#geo=0,0,,10,0,0,globe,extra',
  ])
    assert.equal(GeospatialControls.parseHash(bad), null, bad);
  // A valid hash with a range past maxRange is clamped by the controls.
  const far = GeospatialControls.parseHash('#geo=0,0,0,60000000,0,45');
  control.restoreView(far, { duration: 0 });
  assert.equal(control.view.range, 4 * 6378137);
  // restoreView takes the same checks for objects: a coded RangeError, the view unchanged.
  const before = control.saveView();
  for (const bad of [{ height: Infinity }, { height: 1e12 }, { range: Number.NaN }, { latitude: 3 }, { mode: 'swim' }])
    assert.throws(
      () => control.restoreView(bad, { duration: 0 }),
      (e) => e instanceof RangeError && /controls-arguments/.test(e.message),
    );
  assert.deepEqual(control.saveView(), before);
  control.dispose();
});

test('hash: true starts from the page hash and writes it back when the view settles', () => {
  const saved = {
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    history: Object.getOwnPropertyDescriptor(globalThis, 'history'),
  };
  const loc = { hash: '#geo=41.9,-87.6,0,1500,45,30,local&layer=sat', pathname: '/map', search: '' },
    history = { state: null, replaceState: (_s, _t, url) => (loc.hash = url.slice(url.indexOf('#'))) };
  Object.defineProperty(globalThis, 'location', { value: loc, configurable: true });
  Object.defineProperty(globalThis, 'history', { value: history, configurable: true });
  try {
    const { control } = rig({ hash: true });
    assert.equal(control.mode, 'local');
    assert.ok(Math.abs(control.view.range - 1500) < 1e-9);
    control.setView({ range: 1000 });
    control.update(0);
    control.update(0);
    assert.equal(loc.hash, '#geo=41.9,-87.6,0,1000,45,30,local&layer=sat');
    control.dispose();
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  }
});
