import test from 'node:test';
import assert from 'node:assert/strict';
import { project, unproject, tileAt, tileBounds, tilesIn, WGS84, MERCATOR_MAX_LAT } from '@margoengine/sciviz/geo';

const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// Snyder (1987), table 7: Mercator y on the sphere of radius 1, five decimals. project() gives y / pi.
test('Mercator northings match Snyder table 7 for the sphere', () => {
  for (const [lat, y] of [
    [5, 0.08738],
    [30, 0.54931],
    [45, 0.88137],
    [60, 1.31696],
    [85, 3.1313],
  ]) {
    close(project(0, lat)[1] * Math.PI, y, 5e-6);
    close(project(0, -lat)[1] * Math.PI, -y, 5e-6);
    // Snyder 7-4a, the inverse, gives the latitude back.
    close(unproject(0, project(0, lat)[1])[1], lat, 1e-9);
  }
  // The square Web Mercator world ends where y reaches pi; latitudes past it sit on the edge.
  close(project(0, MERCATOR_MAX_LAT)[1], 1, 1e-12);
  close(project(0, 89.9)[1], 1, 1e-12);
});

test('longitudes outside +-180 wrap by 360 degrees, as Snyder sets out under 7-1 and 12-1', () => {
  assert.deepEqual(project(190, 10), project(-170, 10));
  assert.deepEqual(project(-540, 0, 0, 'plate'), project(-180, 0, 0, 'plate'));
  close(project(180, 0)[0], 1, 0);
  close(project(-180, 0)[0], -1, 0);
  close(project(725, 0, 0, 'globe')[1], project(5, 0, 0, 'globe')[1], 1e-12);
  assert.throws(() => project(0, 91), /Latitude/);
  assert.throws(() => project(NaN, 0), RangeError);
});

test('plate carree is x = lon / 180, y = lat / 180 (Snyder 12-1 to 12-3, standard parallel the Equator)', () => {
  assert.deepEqual(project(90, 45, 0, 'plate'), [0.5, 0.25, 0]);
  assert.deepEqual(unproject(0.5, 0.25, 'plate'), [90, 45]);
});

test('the globe puts WGS 84 geodetic points at Earth-centred places, equatorial radius 1', () => {
  const b = WGS84.a * (1 - WGS84.f);
  close(b, 6356752.314245, 1e-6);
  const equator = project(0, 0, 0, 'globe');
  close(equator[0], 1, 1e-15);
  close(project(90, 0, 0, 'globe')[1], 1, 1e-15);
  close(project(0, 90, 0, 'globe')[2], b / WGS84.a, 1e-15);
  // Height runs along the ellipsoid normal: at the pole straight up, at 45 degrees along (cos, 0, sin).
  close(project(0, 90, 1000, 'globe')[2], (b + 1000) / WGS84.a, 1e-15);
  const low = project(0, 45, 0, 'globe'),
    high = project(0, 45, WGS84.a, 'globe');
  close(high[0] - low[0], Math.SQRT1_2, 1e-12);
  close(high[2] - low[2], Math.SQRT1_2, 1e-12);
  // N, Snyder 4-20, is the normal's length from the surface to the polar axis: the point at 45 degrees lies on it.
  const n = 1 / Math.sqrt(1 - WGS84.e2 * 0.5);
  close(low[0], n * Math.SQRT1_2, 1e-15);
});

test('slippy-map tiles: the whole world at zoom 0, each tile edge where the next starts, the 180th meridian crossed', () => {
  const world = tileBounds(0, 0, 0);
  close(world[0], -180, 1e-12);
  close(world[2], 180, 1e-12);
  close(world[3], MERCATOR_MAX_LAT, 1e-9);
  close(world[1], -MERCATOR_MAX_LAT, 1e-9);
  assert.deepEqual(tileAt(0, 0, 1), [1, 1]);
  assert.deepEqual(tileAt(-0.001, 0.001, 1), [0, 0]);
  // Zoom 10 tile 165/360 holds part of the terrain fixtures' area; a point inside it maps back to it.
  const [w, s, e, n] = tileBounds(10, 165, 360);
  assert.deepEqual(tileAt((w + e) / 2, (s + n) / 2, 10), [165, 360]);
  close(tileBounds(10, 166, 360)[0], e, 1e-9);
  close(tileBounds(10, 165, 361)[3], s, 1e-9);
  assert.deepEqual(
    tilesIn([170, -10, -170, 10], 2)
      .map(([, x, y]) => `${x},${y}`)
      .sort(),
    ['0,1', '0,2', '3,1', '3,2'],
  );
  assert.deepEqual(tilesIn([-180, -80, 180, 80], 0), [[0, 0, 0]]);
  assert.deepEqual(tilesIn([10, -5, -10, 5], 0), [[0, 0, 0]]);
});
