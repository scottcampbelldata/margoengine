// GeospatialControls in a local frame (a tileset's east-north-up frame) and on a world-space ground (terrain, biomes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cartographicToEcef, degToRad, enuBasis } from '@margoengine/math/geo';
import { GeospatialControls } from '../dist/geospatial.js';
import { FakeElement, camera } from './control-fakes.js';

const site = { longitude: degToRad(-105.6), latitude: degToRad(40.3), height: 2500 };
// ECEF to a Y-up ENU world at the site (x east, y up, z south), column-major: the frame a TilesRenderer has.
function enuFrame({ longitude, latitude, height }) {
  const b = enuBasis(longitude, latitude),
    c = cartographicToEcef(longitude, latitude, height),
    rows = [b.east, b.up, b.north.map((v) => -v)],
    t = rows.map((r) => -(r[0] * c[0] + r[1] * c[1] + r[2] * c[2]));
  return [
    rows[0][0],
    rows[1][0],
    rows[2][0],
    0,
    rows[0][1],
    rows[1][1],
    rows[2][1],
    0,
    rows[0][2],
    rows[1][2],
    rows[2][2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}
const view = { ...site, heading: 0.4, pitch: degToRad(35), range: 1200 };
const rig = (options) =>
  new GeospatialControls(camera({ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }), new FakeElement(), {
    view,
    clipPlanes: false,
    reducedMotion: true,
    ...options,
  });

test('a local frame puts the camera near the world origin and keeps every geodetic answer', () => {
  const plain = rig({}),
    local = rig({ frame: { frame: enuFrame(site) } });
  // In ECEF the eye is millions of metres out; in the site frame, within the range of the origin.
  assert.ok(Math.hypot(...plain.camera.position) > 6e6);
  assert.ok(Math.hypot(...local.camera.position) < 1300, `eye at ${local.camera.position}`);
  const a = plain.eye,
    b = local.eye;
  assert.ok(Math.abs(a.longitude - b.longitude) < 1e-12 && Math.abs(a.latitude - b.latitude) < 1e-12);
  assert.ok(Math.abs(a.height - b.height) < 1e-6);
  // Up on screen is up at the site: world +Y.
  assert.ok(local.camera.up[1] > 0.5);
  const p = local.pick(400, 300);
  assert.ok(p && Math.abs(p.longitude - site.longitude) < 1e-6, 'the screen middle picks the orbit centre');
  assert.throws(() => rig({ frame: [1, 2, 3] }), RangeError);
  assert.throws(() => rig({ frame: new Array(16).fill(0) }), RangeError);
});

test('a world-space ground (terrain query, biomes world or function) drives clearance and heights', () => {
  const frame = enuFrame(site),
    flat = 120; // world Y of the ground: 120 m above the frame origin, which sits at 2500 m
  for (const ground of [{ height: () => flat }, { heightAt: () => flat }, () => flat]) {
    const c = rig({ frame, ground });
    const h = c.heights;
    // Near the site origin world Y is height above the ellipsoid minus 2500 (to curvature, a few cm at 1 km).
    assert.ok(Math.abs(h.ellipsoid - h.terrain - (2500 + flat)) < 0.2, `ground ${h.ellipsoid - h.terrain}`);
    // A low orbit is lifted to clearance above that ground.
    c.setView({ height: 2500, pitch: 0.05, range: 5 });
    assert.ok(c.heights.terrain >= c.clearance - 1e-3, `eye ${c.heights.terrain} m above the ground`);
  }
  assert.throws(() => rig({ frame, ground: { elevation: () => 0 } }), RangeError);
});
