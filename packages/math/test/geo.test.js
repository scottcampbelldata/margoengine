import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WGS84_A, degToRad, radToDeg, cartographicToEcef, ecefToCartographic, enuToEcef, ecefToEnu, enuBasis,
  geodesicInverse, geodesicDirect, orbitPose,
} from '@margoengine/math/geo';

const dms = (d, m, s) => degToRad(Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600));

test('geodetic <-> ECEF round trips to the millimetre from the core to GEO height', () => {
  for (const lat of [-90, -89.99, -60, -1, 0, 0.5, 45, 89.9, 90])
    for (const lon of [-180, -90, 0, 37, 179.9])
      for (const h of [-6e6, -10000, 0, 8848, 3.6e7]) {
        const p = cartographicToEcef(degToRad(lon), degToRad(lat), h),
          g = ecefToCartographic(...p),
          q = cartographicToEcef(g.longitude, g.latitude, g.height);
        assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-3, `${lat} ${lon} ${h}`);
        assert.ok(Math.abs(g.height - h) < 1e-3, `height ${lat} ${lon} ${h}`);
      }
  assert.deepEqual(cartographicToEcef(0, 0, 0), [WGS84_A, 0, 0]);
});

test('ENU offsets round trip and east/north/up are orthonormal', () => {
  const o = { longitude: degToRad(-122.4), latitude: degToRad(37.8), height: 120 },
    p = enuToEcef(o, 300, -450, 25),
    e = ecefToEnu(o, ...p);
  for (const [a, b] of [[e[0], 300], [e[1], -450], [e[2], 25]]) assert.ok(Math.abs(a - b) < 1e-6);
  const b = enuBasis(o.longitude, o.latitude),
    d = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  assert.ok(Math.abs(d(b.east, b.north)) < 1e-15 && Math.abs(d(b.up, b.up) - 1) < 1e-15);
});

test('Vincenty 1975 Flinders Peak to Buninyong: 54972.271 m, azimuth 306 52 05.37', () => {
  const g = geodesicInverse(dms(144, 25, 29.5244), dms(-37, 57, 3.7203), dms(143, 55, 35.3839), dms(-37, 39, 10.1561));
  assert.ok(Math.abs(g.distance - 54972.271) < 1e-3, String(g.distance));
  assert.ok(Math.abs(g.initialBearing - dms(306, 52, 5.37)) < 1e-7);
});

test('geodesic known lengths: equator arc a*dLon, pole-to-equator meridian arc', () => {
  const eq = geodesicInverse(0, 0, Math.PI / 2, 0);
  assert.ok(Math.abs(eq.distance - WGS84_A * Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(radToDeg(eq.initialBearing) - 90) < 1e-9);
  const m = geodesicInverse(0, 0, 0, Math.PI / 2);
  assert.ok(Math.abs(m.distance - 10001965.729) < 1e-2, String(m.distance));
});

test('geodesicDirect inverts geodesicInverse', () => {
  const pts = [[0.1, 0.5], [2, -0.7], [-3, 1.2], [1, 0]];
  for (const [l1, p1] of pts)
    for (const [l2, p2] of pts) {
      if (l1 === l2 && p1 === p2) continue;
      const i = geodesicInverse(l1, p1, l2, p2),
        d = geodesicDirect(l1, p1, i.initialBearing, i.distance);
      assert.ok(Math.abs(d.latitude - p2) < 1e-10 && Math.abs(Math.atan2(Math.sin(d.longitude - l2), Math.cos(d.longitude - l2))) < 1e-10);
    }
});

test('nearly antipodal points throw a coded failure, bad input a RangeError', () => {
  assert.throws(() => geodesicInverse(0, 0, Math.PI - 1e-4, 1e-4), (e) => e.code === 'failed');
  assert.throws(() => geodesicInverse(NaN, 0, 0, 0), RangeError);
});

test('orbitPose looks at the centre from the heading side, range away, up toward the sky', () => {
  const c = { longitude: 0.3, latitude: 0.8, height: 50 },
    p = orbitPose(c, Math.PI / 2, Math.PI / 4, 1000),
    t = cartographicToEcef(c.longitude, c.latitude, c.height);
  assert.ok(Math.abs(Math.hypot(p.position[0] - t[0], p.position[1] - t[1], p.position[2] - t[2]) - 1000) < 1e-6);
  const enu = ecefToEnu(c, ...p.position); // looking east and down: the eye is west of and above the centre
  assert.ok(enu[0] < -700 && Math.abs(enu[1]) < 1e-6 && enu[2] > 700);
  const b = enuBasis(c.longitude, c.latitude);
  assert.ok(p.up[0] * b.up[0] + p.up[1] * b.up[1] + p.up[2] * b.up[2] > 0.7);
});
