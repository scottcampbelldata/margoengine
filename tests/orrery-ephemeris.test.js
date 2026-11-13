// The Orrery demo's ephemeris (examples/orrery/ephemeris.ts) against JPL Horizons (DE441): heliocentric ecliptic
// longitudes of the eight planets and the Moon's geocentric longitude at 51 dates from 1800 to 2050
// (examples/orrery/reference/horizons.json, fetched by fetch-horizons.mjs beside it). The ceilings are the errors
// measured on 2026-11-13 and stated in examples/orrery/README.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FITTED_SPAN,
  J2000,
  PLANETS,
  dateOfJulianDay,
  eccentricAnomaly,
  julianDay,
  meanMotion,
  moonLongitude,
  planetPosition,
  wrap180,
} from '../examples/orrery/ephemeris.ts';

const reference = JSON.parse(
  readFileSync(new URL('../examples/orrery/reference/horizons.json', import.meta.url), 'utf8'),
);
const longitude = (row) => (Math.atan2(row.y, row.x) * 180) / Math.PI;

// Largest error in arcminutes over the 51 dates, as measured.
const CEILING = {
  mercury: 0.39,
  venus: 0.43,
  earth: 0.33,
  mars: 1.15,
  jupiter: 7.6,
  saturn: 11.9,
  uranus: 1.7,
  neptune: 0.99,
  moon: 16.9,
};

test('every planet is within its measured error of JPL Horizons, 1800 to 2050', () => {
  for (const name of PLANETS) {
    const rows = reference.rows[name];
    assert.equal(rows.length, 51);
    let worst = 0;
    for (const row of rows) {
      assert.ok(row.jd >= FITTED_SPAN[0] && row.jd <= FITTED_SPAN[1] + 1);
      worst = Math.max(worst, Math.abs(wrap180(planetPosition(name, row.jd).longitude - longitude(row))) * 60);
    }
    assert.ok(worst <= CEILING[name], `${name}: ${worst.toFixed(3)} arcmin, ceiling ${CEILING[name]}`);
  }
});

test('the Moon is within its measured error of JPL Horizons', () => {
  let worst = 0;
  for (const row of reference.rows.moon)
    worst = Math.max(worst, Math.abs(wrap180(moonLongitude(row.jd) - longitude(row))) * 60);
  assert.ok(worst <= CEILING.moon, `moon: ${worst.toFixed(3)} arcmin`);
});

test('distances from the Sun agree with Horizons to the measured 0.19 percent (Saturn, the worst)', () => {
  for (const name of PLANETS)
    for (const row of reference.rows[name]) {
      const r = planetPosition(name, row.jd).radius;
      assert.ok(Math.abs(r / Math.hypot(row.x, row.y, row.z) - 1) < 1.9e-3, `${name} at ${row.jd}`);
    }
});

test("Kepler's equation is solved to 1e-12 for every eccentricity the planets need and beyond", () => {
  for (const e of [0, 0.0068, 0.0167, 0.0934, 0.2056, 0.5, 0.9])
    for (let k = -36; k <= 36; k++) {
      const M = (k / 36) * Math.PI;
      const E = eccentricAnomaly(M, e);
      assert.ok(Math.abs(E - e * Math.sin(E) - M) < 1e-12, `e ${e} M ${M}`);
    }
});

test('Julian Days: J2000 is noon on 2000-01-01 and dates round trip', () => {
  assert.equal(julianDay(Date.UTC(2000, 0, 1, 12)), J2000);
  assert.equal(julianDay(Date.UTC(1970, 0, 1)), 2440587.5);
  const date = new Date(Date.UTC(1969, 6, 20, 20, 17));
  assert.equal(dateOfJulianDay(julianDay(date)).getTime(), date.getTime());
});

test('mean motions match the sidereal periods to a day', () => {
  // Sidereal periods in days (IAU values rounded): the table's rates of mean longitude must give them.
  const periods = {
    mercury: 87.969,
    venus: 224.701,
    earth: 365.256,
    mars: 686.98,
    jupiter: 4332.59,
    saturn: 10759.2,
    uranus: 30688.5,
    neptune: 60195,
  };
  for (const name of PLANETS) {
    const days = 360 / meanMotion(name);
    assert.ok(Math.abs(days - periods[name]) < Math.max(1, periods[name] * 2e-3), `${name}: ${days}`);
  }
});
