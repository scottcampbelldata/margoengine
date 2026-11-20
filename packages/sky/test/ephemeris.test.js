// @margoengine/sky/ephemeris against JPL Horizons (DE441): heliocentric ecliptic
// longitudes of the eight planets and the Moon's geocentric longitude at 51 dates from 1800 to 2050
// (test/fixtures/horizons/horizons.json, fetched by fetch-horizons.mjs beside it). The ceilings are the errors
// measured on 2026-11-13 and stated in the README (Ephemeris section).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FITTED_SPAN,
  J2000,
  HELIOCENTRIC_PLANETS as PLANETS,
  dateOfJulianDay,
  eccentricAnomaly,
  julianDay,
  meanMotion,
  moonLongitude,
  planetPosition,
  wrap180,
} from '../dist/ephemeris.js';

const reference = JSON.parse(readFileSync(new URL('./fixtures/horizons/horizons.json', import.meta.url), 'utf8'));
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

test("yearCalendar: one tick a day at Earth's longitude, months start on day 1", async () => {
  const { yearCalendar } = await import('../dist/ephemeris.js');
  const { year, days } = yearCalendar(2026);
  assert.equal(year, 2026);
  assert.equal(days.length, 365);
  assert.equal(yearCalendar(2024).days.length, 366);
  assert.deepEqual(
    days.filter((d) => d.day === 1).map((d) => d.month),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  // Each tick is Earth's heliocentric longitude at 0h UTC; the Earth moves about a degree a day.
  assert.equal(days[0].longitude, planetPosition('earth', julianDay(Date.UTC(2026, 0, 1))).longitude);
  for (let i = 1; i < days.length; i++) {
    const step = wrap180(days[i].longitude - days[i - 1].longitude);
    assert.ok(step > 0.95 && step < 1.03, `day ${i}: ${step}`);
  }
  assert.throws(() => yearCalendar(2026.5), RangeError);
});

test('solarSystem gives every planet, and bad input is refused with a fix', async () => {
  const { solarSystem, STANDISH_ELEMENTS } = await import('../dist/ephemeris.js');
  const all = solarSystem(J2000);
  assert.deepEqual(Object.keys(all), [...PLANETS]);
  for (const name of PLANETS) assert.deepEqual(all[name], planetPosition(name, J2000));
  assert.ok(Object.isFrozen(STANDISH_ELEMENTS) && Object.isFrozen(STANDISH_ELEMENTS.earth.at));
  assert.throws(() => planetPosition('pluto', J2000), /"pluto" is not a planet; pass one of mercury/);
  assert.throws(() => planetPosition('toString', J2000), RangeError);
  assert.throws(() => meanMotion('sun'), RangeError);
  assert.throws(() => eccentricAnomaly(1, 1), /not in \[0, 1\)/);
  assert.throws(() => eccentricAnomaly(Number.NaN, 0.1), /not finite/);
});
