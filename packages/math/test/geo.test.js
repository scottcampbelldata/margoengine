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

test('Flinders Peak to Buninyong: 54972.271 m, azimuth 306 52 05.37', () => {
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

// An independent reference: Vincenty's 1975 inverse iteration, valid away from antipodal points.
const vincenty = (l1, p1, l2, p2) => {
  const f = 1 / 298.257223563, a = WGS84_A, b = a * (1 - f), L = l2 - l1;
  const U1 = Math.atan((1 - f) * Math.tan(p1)), U2 = Math.atan((1 - f) * Math.tan(p2));
  let lam = L, ss, cs, sg, ca2, c2m;
  for (let i = 0; i < 500; i++) {
    ss = Math.hypot(Math.cos(U2) * Math.sin(lam), Math.cos(U1) * Math.sin(U2) - Math.sin(U1) * Math.cos(U2) * Math.cos(lam));
    cs = Math.sin(U1) * Math.sin(U2) + Math.cos(U1) * Math.cos(U2) * Math.cos(lam);
    sg = Math.atan2(ss, cs);
    const sa = (Math.cos(U1) * Math.cos(U2) * Math.sin(lam)) / ss;
    ca2 = 1 - sa * sa;
    c2m = ca2 ? cs - (2 * Math.sin(U1) * Math.sin(U2)) / ca2 : 0;
    const C = (f / 16) * ca2 * (4 + f * (4 - 3 * ca2));
    lam = L + (1 - C) * f * sa * (sg + C * ss * (c2m + C * cs * (-1 + 2 * c2m * c2m)));
  }
  const u2 = (ca2 * (a * a - b * b)) / (b * b), A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2))),
    B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const ds = B * ss * (c2m + (B / 4) * (cs * (-1 + 2 * c2m * c2m) - (B / 6) * c2m * (-3 + 4 * ss * ss) * (-3 + 4 * c2m * c2m)));
  return b * A * (sg - ds);
};
const ll = (lat, lon) => [degToRad(lon), degToRad(lat)];

test('Karney geodesics agree with Vincenty (independent) away from antipodal points, both ways', () => {
  let n = 0;
  for (const [la1, lo1] of [[0, 0], [37.8, -122.4], [-33.9, 151.2], [89, 10], [-60, 170], [0.001, 20], [51.5, -0.1]])
    for (const [la2, lo2] of [[48.9, 2.35], [-1.3, 103.9], [10, 100], [0, 60], [-80, -30], [51.5, 0.2], [0.002, -100]]) {
      const g = geodesicInverse(...ll(la1, lo1), ...ll(la2, lo2));
      assert.ok(Math.abs(g.distance - vincenty(...ll(la1, lo1), ...ll(la2, lo2))) < 2e-3, `${la1} ${lo1} ${la2} ${lo2}`);
      const back = geodesicInverse(...ll(la2, lo2), ...ll(la1, lo1));
      assert.ok(Math.abs(back.distance - g.distance) < 1e-6);
      const d = geodesicDirect(...ll(la1, lo1), g.initialBearing, g.distance);
      assert.ok(Math.abs(d.latitude - degToRad(la2)) < 1e-12);
      assert.ok(Math.abs(Math.atan2(Math.sin(d.longitude - degToRad(lo2)), Math.cos(d.longitude - degToRad(lo2)))) < 1e-12);
      assert.ok(Math.abs(Math.atan2(Math.sin(d.finalBearing - g.finalBearing), Math.cos(d.finalBearing - g.finalBearing))) < 1e-9);
      n++;
    }
  assert.equal(n, 49);
});

test('antipodal and near-antipodal pairs converge: published meridian length, round trips', () => {
  // WGS84 quarter meridian 10001965.7293 m, so equator point to its antipode runs over a pole: 2 x that.
  const anti = geodesicInverse(0, 0, Math.PI, 0);
  assert.ok(Math.abs(anti.distance - 20003931.4586) < 1e-2, String(anti.distance));
  assert.ok(Math.abs(geodesicInverse(1, 0.5, 1 + Math.PI, -0.5).distance - geodesicInverse(1, 0.5, 1, Math.PI / 2).distance - geodesicInverse(1, -0.5, 1, Math.PI / 2).distance) < 1e-6);
  // Pairs at and around the antipode, including those that made Vincenty fail.
  for (const [dl, dp] of [[1e-4, 1e-4], [0.5, 0.2], [0.01, -0.3], [1e-9, 0], [-0.003, 0.0004], [0.2, 0]])
    for (const lat of [0, 0.3, -0.9, 1.4]) {
      const l2 = Math.PI - dl, p2 = -lat + degToRad(dp);
      const g = geodesicInverse(0.1, lat, 0.1 + l2, p2);
      if (Math.abs(dl) < 0.05 && Math.abs(dp) < 0.05) assert.ok(g.distance > 19.9e6 && g.distance < 20.04e6, String(g.distance));
      const d = geodesicDirect(0.1, lat, g.initialBearing, g.distance);
      const dist = geodesicInverse(d.longitude, d.latitude, 0.1 + l2, p2).distance;
      assert.ok(dist < 1e-5, `round trip misses by ${dist} m at ${dl} ${dp} ${lat}`);
    }
});

test('equatorial geodesic is the equator up to PI(1 - f) of longitude, then continuous', () => {
  const edge = Math.PI * (1 - 1 / 298.257223563), a = geodesicInverse(0, 0, edge, 0), b = geodesicInverse(0, 0, edge + 1e-9, 0);
  assert.ok(Math.abs(a.distance - WGS84_A * edge) < 1e-6 && Math.abs(a.initialBearing - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(b.distance - a.distance) < 0.01);
  assert.ok(geodesicInverse(0, 0, edge + 0.01, 0).distance < 20.004e6);
});

test('6000 seeded random pairs, a third near-antipodal, all converge and round trip to under a micrometre', () => {
  let seed = 7;
  const R = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < 6000; i++) {
    const l1 = (R() - 0.5) * 6.28, p1 = (R() - 0.5) * 3.14, near = i % 3 === 0;
    const l2 = near ? l1 + Math.PI + (R() - 0.5) * 0.02 : (R() - 0.5) * 6.28,
      p2 = near ? -p1 + (R() - 0.5) * 0.02 : (R() - 0.5) * 3.14;
    const q = geodesicInverse(l1, p1, l2, p2), d = geodesicDirect(l1, p1, q.initialBearing, q.distance);
    const miss = geodesicInverse(d.longitude, d.latitude, l2, p2).distance;
    assert.ok(miss < 1e-5, `pair ${i} misses by ${miss} m`);
  }
});

test('bad input is a RangeError, a repeated point has zero length', () => {
  assert.throws(() => geodesicInverse(NaN, 0, 0, 0), RangeError);
  assert.equal(geodesicInverse(0.3, 0.4, 0.3, 0.4).distance, 0);
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
