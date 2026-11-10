import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { climateProjection, wrapLongitude } from '@margoengine/sciviz/projections';
const near = (a, b, e) => assert.ok(Math.abs(a - b) < e, `${a} differs from ${b} by ${Math.abs(a - b)} (bound ${e})`);
test('independent numerical reference: ellipsoidal/spherical conics, both polar aspects and global projections', () => {
  const reference = JSON.parse(readFileSync(new URL('fixtures/climate-projection-reference.json', import.meta.url)));
  for (const { name, options, samples } of reference.cases) {
    const p = climateProjection(name, options);
    for (const [lon, lat, x, y] of samples) {
      const xy = p.forward(lon, lat);
      // PROJ's Robinson table uses single-precision coefficients; the published table is decimal exact here.
      const bound = name === 'robinson' ? 1.2 : 1e-6;
      near(xy[0], x, bound);
      near(xy[1], y, bound);
      const ll = p.inverse(...xy);
      near(wrapLongitude(ll[0] - lon), 0, 1e-8);
      near(ll[1], lat, 1e-8);
    }
  }
});
test('off-knot inversion, geographic wrapping, tangent cones, false origins and pole singularities', () => {
  for (const name of [
    'lambert-conformal-conic',
    'albers',
    'polar-stereographic',
    'robinson',
    'mollweide',
    'mercator',
    'plate',
  ]) {
    const p = climateProjection(name, { radius: 1, flattening: 0, centralMeridian: 25, falseOrigin: [2, -3] });
    for (const lon of [-170, -24.123, 0, 25.123, 179.9, 530])
      for (const lat of [-87.654, -35.5, 0, 31.75, 89.123]) {
        const xy = p.forward(lon, lat),
          ll = p.inverse(...xy);
        near(wrapLongitude(ll[0] - lon), 0, 1e-7);
        near(ll[1], lat, 1e-7);
      }
    assert.throws(() => p.forward(0, 91));
    assert.throws(() => p.inverse(NaN, 0));
  }
  for (const name of ['albers', 'lambert-conformal-conic'])
    for (const sign of [-1, 1]) {
      const p = climateProjection(name, { standardParallels: [sign * 45], latitudeOrigin: sign * 45 });
      const xy = p.forward(0, sign * 45);
      near(xy[0], 0, 1e-8);
      near(xy[1], 0, 1e-8);
    }
  const north = climateProjection('polar-stereographic');
  assert.equal(north.forward(0, -90), undefined);
  near(north.forward(0, 90)[1], 0, 1e-8);
  const moll = climateProjection('mollweide', { radius: 1 });
  assert.equal(moll.inverse(3, 0), undefined);
  assert.equal(moll.inverse(0, 2), undefined);
  near(moll.forward(0, 90)[1], Math.SQRT2, 1e-12);
  const rob = climateProjection('robinson', { radius: 1 });
  assert.equal(rob.inverse(3, 0), undefined);
  assert.equal(rob.inverse(0, 2), undefined);
  assert.equal(wrapLongitude(540), -180);
  assert.equal(wrapLongitude(180), 180);
  assert.throws(() => climateProjection('albers', { standardParallels: [-30, 30] }), /degenerate/);
  assert.throws(() => climateProjection('polar-stereographic', { latitudeOrigin: 0 }), /latitudeOrigin/);
  assert.throws(() => climateProjection('robinson', { flattening: 0.01 }), /spherical/);
});
test('Albers and Mollweide preserve spherical area locally', () => {
  for (const name of ['albers', 'mollweide']) {
    const p = climateProjection(name, { radius: 1, flattening: 0 }),
      h = 0.0001,
      r = Math.PI / 180;
    for (const lat of [-60, -20, 0, 20, 60]) {
      const a = p.forward(-h, lat),
        b = p.forward(h, lat),
        c = p.forward(0, lat - h),
        d = p.forward(0, lat + h);
      const jac = ((b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0])) / (4 * h * h * r * r);
      near(jac, Math.cos(lat * r), 1e-8);
    }
  }
});
