// @margoengine/sky/astro against the worked examples of Meeus, "Astronomical Algorithms" (2nd ed., 1998), and the real
// Yale Bright Star Catalogue (CDS V/50, in fixtures/bsc5). That the stars and planets land where this maths puts them on
// the screen, and that the moon's lit limb faces the sun, is proved on a real GPU by features-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  AstroSky,
  deltaT,
  greenwichSiderealTime,
  julianDay,
  moonPosition,
  nutation,
  parseBrightStarCatalog,
  planetPositions,
  precessionMatrix,
  refract,
  skyMatrix,
  starColor,
  sunPosition,
} from '@margoengine/sky/astro';
import { degrees } from '@margoengine/sky/sun';
import { tracedGPU } from '../../../tests/support/gpu-trace.js';

const catalogText = gunzipSync(readFileSync(new URL('./fixtures/bsc5/catalog.gz', import.meta.url))).toString('latin1');
const near = (actual, expected, bound, what) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${what}: ${actual} against ${expected}, bound ${bound}`);
// A moment given as a Julian Day of terrestrial time; the tests pass deltaT 0, so it is read as that TD.
const td = (jd) => new Date((jd - 2440587.5) * 86400000);
const tdOptions = { deltaT: 0 };
const greenwich = { latitude: degrees(0), longitude: degrees(0) };
const arcsec = 1 / 3600;

test('Julian Day and Delta T', () => {
  // Meeus 7.a: 1957 October 4.81 is JD 2436116.31; J2000.0 is 2451545.0.
  near(julianDay(new Date(Date.UTC(1957, 9, 4) + 0.81 * 86400000)), 2436116.31, 1e-6, 'JD 1957');
  assert.equal(julianDay(new Date(Date.UTC(2000, 0, 1, 12))), 2451545);
  assert.throws(() => julianDay(new Date(NaN)), /valid Date/);
  // Espenak and Meeus' polynomials meet where they hand over (to the 0.05 s their fits differ by there).
  for (const year of [1961, 1986, 2005, 2050]) {
    const before = deltaT(new Date(Date.UTC(year, 0, 1) - 3600000)),
      after = deltaT(new Date(Date.UTC(year, 0, 1) + 3600000));
    near(after, before, 0.6, `Delta T across ${year}`);
  }
  near(deltaT(new Date(Date.UTC(2000, 0, 1))), 63.86, 0.01, 'Delta T 2000');
  // Before 1961 the polynomials of Espenak and Meeus too, not the long-term parabola (which gave -18.7 s for 1800, where
  // Morrison and Stephenson's table has 13.7 s). Each value is the polynomial's constant at its epoch, the decimal
  // year of Julian years of 365.25 days from J2000.0.
  const atYear = (year) => new Date((2451545 + (year - 2000) * 365.25 - 2440587.5) * 86400000);
  for (const [year, seconds] of [
    [1950, 29.07],
    [1920, 21.2],
    [1900, -2.79],
    [1860, 7.62],
    [1800, 13.72],
    [1700, 8.83],
    [1600, 120],
    [1000, 1574.2],
    [0, 10583.6],
  ])
    near(deltaT(atYear(year)), seconds, 1e-6, `Delta T ${year}`);
  // The hand-overs before 1961 meet as closely as the published fits do (within 4 s at -500, 500 and 1600, where the
  // tabulated values are uncertain by minutes; within 0.6 s from 1700 on).
  for (const [year, bound] of [
    [-500, 4],
    [500, 4],
    [1600, 4],
    [1700, 0.6],
    [1800, 0.6],
    [1860, 0.6],
    [1900, 0.6],
    [1920, 0.6],
    [1941, 0.6],
  ]) {
    const date = atYear(year).getTime();
    near(deltaT(new Date(date + 3600000)), deltaT(new Date(date - 3600000)), bound, `Delta T across ${year}`);
  }
});

test('sidereal time and nutation (Meeus 12.a, 12.b, 22.a)', () => {
  near(greenwichSiderealTime(new Date(Date.UTC(1987, 3, 10))).degrees, 197.693195, 1e-6, 'mean 12.a');
  near(greenwichSiderealTime(new Date(Date.UTC(1987, 3, 10, 19, 21))).degrees, 128.7378734, 1e-6, 'mean 12.b');
  // Apparent 12.a is 13h10m46.1351s; the short nutation series is within 0.5 arcseconds in longitude.
  const apparent = (13 + 10 / 60 + 46.1351 / 3600) * 15;
  near(
    greenwichSiderealTime(new Date(Date.UTC(1987, 3, 10)), { apparent: true }).degrees,
    apparent,
    0.5 * arcsec,
    '12.a',
  );
  const n = nutation(td(2446895.5), tdOptions);
  near(n.longitude.degrees, -3.788 * arcsec, 0.5 * arcsec, 'delta psi');
  near(n.obliquity.degrees, 9.443 * arcsec, 0.1 * arcsec, 'delta epsilon');
  near(n.meanObliquity.degrees, 23 + 26 / 60 + 27.407 * arcsec, 0.001 * arcsec, 'mean obliquity');
  near(n.trueObliquity.degrees, 23 + 26 / 60 + 36.85 * arcsec, 0.1 * arcsec, 'true obliquity');
});

test('precession of theta Persei to 2028 November 13.19 (Meeus 21.b)', () => {
  const m = precessionMatrix(td(2462088.69), tdOptions),
    a = 41.054063 * (Math.PI / 180),
    d = 49.22775 * (Math.PI / 180),
    v = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)],
    w = [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
  // The rigorous rotation is exact; the bound is the rounding of Meeus' printed inputs and results (1e-6 degree).
  near((Math.atan2(w[1], w[0]) * 180) / Math.PI, 41.547214, 2e-6, 'alpha');
  near((Math.asin(w[2]) * 180) / Math.PI, 49.348483, 2e-6, 'delta');
});

test('the sun on 1992 October 13.0 TD (Meeus 25.a)', () => {
  const s = sunPosition(td(2448908.5), greenwich, tdOptions);
  // Meeus prints 5 decimals; this is his method, so the bound is that rounding.
  near(s.rightAscension.degrees, 198.38083, 1e-5, 'alpha');
  near(s.declination.degrees, -7.78507, 1e-5, 'delta');
  near(s.distance / 149597870.7, 0.99766, 1e-5, 'R');
});

test('the moon on 1992 April 12.0 TD (Meeus 47.a and 48.a)', () => {
  const m = moonPosition(td(2448724.5), greenwich, tdOptions);
  // Meeus' series in full; his nutation is the full theory and ours the short one, 0.5 arcseconds apart at most.
  near(m.rightAscension.degrees, 134.68847, 0.6 * arcsec, 'alpha');
  near(m.declination.degrees, 13.768368, 0.6 * arcsec, 'delta');
  near(m.distance, 368409.7, 0.1, 'distance');
  // 48.a: k 0.6786 at i 69.0756 degrees, with a sun of 0.01 degree (Meeus 25's low accuracy) moving i by as much.
  near(m.phaseAngle.degrees, 69.0756, 0.015, 'phase angle');
  near(m.illumination, 0.6786, 0.0002, 'lit fraction');
  assert.equal(m.waxing, true, 'new moon was 3 April, full 17 April');
  assert.ok(m.angularRadius.degrees > 0.25 && m.angularRadius.degrees < 0.28, `radius ${m.angularRadius}`);
});

test('Venus on 1992 December 20.0 TD (Meeus 33.a)', () => {
  const venus = planetPositions(td(2448976.5), greenwich, tdOptions)[1];
  assert.equal(venus.name, 'venus');
  // Meeus' place is VSOP87 with aberration. Standish's elements are within 20 arcseconds of the planet and of the
  // Earth-Moon barycentre (JPL's stated error for 1800 to 2050), each scaled by r / delta at most 1.1 here, and the
  // aberration not applied is at most 20.5: 20 x 1.1 x 2 + 20.5 = 64.5 arcseconds.
  const alpha = (21 + 4 / 60 + 41.454 / 3600) * 15,
    delta = -(18 + 53 / 60 + 16.84 / 3600),
    cosd = Math.cos((delta * Math.PI) / 180);
  near(venus.rightAscension.degrees * cosd, alpha * cosd, 64.5 * arcsec, 'alpha cos delta');
  near(venus.declination.degrees, delta, 64.5 * arcsec, 'delta');
  near(venus.distance / 149597870.7, 0.910947, 0.0005, 'distance');
  // Meeus 41: about -4 at that elongation; the brightest planet.
  assert.ok(venus.magnitude < -3.5 && venus.magnitude > -4.7, `magnitude ${venus.magnitude}`);
});

test('Saturn with its rings (Mallama and Hilton 2018, section 4.6)', () => {
  // The paper's brightest and faintest Saturn from 1987 to 2046 (Eq. 10, rings included): -0.55 on 2032 December 25
  // with the rings near their widest, +1.17 on 2025 April 20 with them nearly edge-on. Printed to 2 decimals; Standish's
  // elements against the paper's ephemeris move r and delta by under 1e-4 of themselves, so the bound is the rounding.
  // Until 2026-11-14 Saturn's magnitude was its globe alone (Meeus 41, -8.88): +0.42 and +1.12 on those dates, 0.97 too faint at the widest rings.
  const at = (day) => planetPositions(new Date(`${day}T00:00:00Z`), greenwich)[4];
  assert.equal(at('2032-12-25').name, 'saturn');
  near(at('2032-12-25').magnitude, -0.55, 0.006, 'brightest');
  near(at('2025-04-20').magnitude, 1.17, 0.006, 'faintest');
});

test('Mars with its rotation and season terms (Mallama and Hilton 2018, Eq. 6)', () => {
  // JPL Horizons' geocentric Mars magnitudes (APmag), which follow Eq. 6 with both tables: the API's observer table for
  // COMMAND 499, CENTER 500@399, QUANTITIES 9,14,15,19,20,24,44, every 7919 minutes from 1985-01-01 05:17 UT (held out
  // of the fit that recovered the tables; docs/limits.md). The last date has the sub-Earth and sub-solar latitudes 14
  // degrees apart, where the 3D midpoint of the two points sits 0.85 degree of longitude off their mean longitude.
  // Over all 18,786 Horizons dates from 1985 to 2045 the largest difference is 0.0029: 0.0005 of Horizons' rounding
  // and the rest Standish's elements in r and delta near opposition. Until 2026-11-15 the magnitude was Meeus 41's
  // phase law only: up to 0.17 off on these Horizons dates, 0.08 on 1997-03-13 and 2036-12-11 below.
  const expected = [
    ['1987-04-06T02:47Z', 1.449],
    ['1992-03-24T21:17Z', 1.176],
    ['1997-03-13T15:47Z', -1.328],
    ['2002-03-02T10:17Z', 1.314],
    ['2007-02-19T04:47Z', 1.344],
    ['2012-02-07T23:17Z', -0.808],
    ['2017-01-26T17:47Z', 1.082],
    ['2022-01-15T12:17Z', 1.522],
    ['2027-01-04T06:47Z', -0.213],
    ['2031-12-24T01:17Z', 0.951],
    ['2036-12-11T19:47Z', 1.556],
    ['2041-11-30T14:17Z', 0.118],
    ['2007-08-03T04:17Z', 0.521],
  ];
  for (const [day, magnitude] of expected) {
    const mars = planetPositions(new Date(day), greenwich)[2];
    assert.equal(mars.name, 'mars');
    near(mars.magnitude, magnitude, 0.003, day);
  }
});

test('refraction and the sky matrix', () => {
  // Saemundsson: 29 arcminutes at the horizon, none at the zenith.
  near(refract(0), 28.98 / 60, 0.01 / 60, 'horizon');
  near(refract(90), 90, 1e-7, 'zenith');
  // Below the horizon the lift is continuous: the body Saemundsson lifts to the apparent horizon (34.4 arcminutes, the
  // almanacs' 34) stays there from both sides, the lift fades to none at -6 degrees (civil twilight's geometric
  // altitude), and nothing moves faster than the true altitude does or reverses (the old step at -1 degree was 0.65).
  near(refract(-0.5739141574), 0, 1e-8, 'apparent horizon');
  near(refract(-0.5739141574) + 0.5739141574, 34.43 / 60, 0.01 / 60, 'horizontal refraction');
  near(refract(-0.5739141575), refract(-0.5739141573), 1e-8, 'continuous at the horizon');
  for (let h = -8; h < 2; h += 0.0005) {
    const step = refract(h + 0.0005) - refract(h);
    assert.ok(step > 0 && step < 0.0005 * 1.2, `refraction step at ${h.toFixed(4)}: ${step}`);
  }
  assert.ok(refract(-0.6) < 0 && refract(-3) < 0, 'below the horizon stays below it');
  assert.equal(refract(-6), -6);
  assert.equal(refract(-18), -18);
  assert.ok(Number.isNaN(refract(NaN)));
  // The matrix maps a J2000 vector as sunPosition does its own place: the sun, unrefracted, within its 0.01 degree.
  const date = new Date('2026-06-21T12:00:00Z'),
    observer = { latitude: degrees(48), longitude: degrees(11) },
    m = skyMatrix(date, observer),
    // Polaris near the pole: the matrix puts the pole's J2000 vector at the latitude's height, give or take precession.
    pole = [m[2], m[5], m[8]];
  near((Math.asin(pole[1]) * 180) / Math.PI, 48, 0.2, 'J2000 pole height in 2026');
  const north = -pole[2];
  assert.ok(north > 0.6 && Math.abs(pole[0]) < 0.01, `pole north, not east: ${pole}`);
});

test('the real Bright Star Catalogue', () => {
  const all = parseBrightStarCatalog(catalogText);
  // 9,110 records less the 14 the catalogue removed.
  assert.equal(all.count, 9096);
  assert.equal(all.numbers[0], 2491, 'Sirius first');
  assert.equal(all.magnitudes[0], Math.fround(-1.46), 'V -1.46, stored as float32');
  assert.equal(all.names[0], '9Alp CMa');
  const naked = parseBrightStarCatalog(catalogText, { maxMagnitude: 4 });
  assert.ok(naked.count > 400 && naked.count < 600, `${naked.count} stars to magnitude 4`);
  const polaris = all.numbers.indexOf(424),
    p = [...all.positions.subarray(polaris * 3, polaris * 3 + 3)];
  // atan2 reads the float32 vector well near the pole, where asin of z would magnify its rounding 78 times.
  near(
    (Math.atan2(p[2], Math.hypot(p[0], p[1])) * 180) / Math.PI,
    89 + 15 / 60 + 51 / 3600,
    1e-5,
    'Polaris declination',
  );
  // Proper motion: Arcturus moves 2.28 arcseconds a year (BSC5: -1.093 and -1.998).
  const arcturus = all.numbers.indexOf(5340),
    pm = all.motions.subarray(arcturus * 3, arcturus * 3 + 3);
  near((Math.hypot(...pm) * 180 * 3600) / Math.PI, Math.hypot(1.093, 1.998), 1e-4, 'Arcturus motion');
  // Seen from 52 degrees north, Polaris stands at the latitude within its 0.7 degree polar distance plus refraction.
  const astroDate = new Date('2026-11-07T22:00:00Z'),
    m = skyMatrix(astroDate, { latitude: degrees(52), longitude: degrees(0) }),
    w = [0, 1, 2].map((r) => m[r * 3] * p[0] + m[r * 3 + 1] * p[1] + m[r * 3 + 2] * p[2]);
  near((Math.asin(w[1]) * 180) / Math.PI, 52, 0.75, 'Polaris height');
  assert.throws(() => parseBrightStarCatalog(catalogText.slice(0, 200).replace(/ 6\.70/, ' 6.x0')), /does not parse/);
});

test('star colours follow B-V', () => {
  const sunLike = starColor(0.65),
    red = starColor(1.85),
    blue = starColor(-0.2);
  assert.ok(Math.max(...sunLike) === 1 && Math.min(...sunLike) > 0.7, `sun-like ${sunLike}`);
  assert.ok(red[0] === 1 && red[1] < 0.8 && red[2] < red[1], `red ${red}`);
  assert.ok(blue[2] === 1 && blue[0] < blue[1], `blue ${blue}`);
  assert.deepEqual(starColor(NaN), [1, 1, 1]);
});

test('AstroSky drives the sky and draws every star and planet at night', () => {
  const catalog = parseBrightStarCatalog(catalogText, { maxMagnitude: 5 }),
    sky = { options: { night: {} }, nightFactor: 1 },
    observer = { latitude: degrees(52), longitude: degrees(0) },
    astro = new AstroSky({ ...observer, date: new Date('2026-11-07T22:00:00Z'), timeScale: 60, sky, catalog }),
    h = tracedGPU();
  h.engine.use(astro);
  astro.onPreUpdate(10);
  // Ten seconds at 60 times real time is ten minutes on.
  assert.equal(astro.date.toISOString(), '2026-11-07T22:10:00.000Z');
  const moon = moonPosition(astro.date, observer);
  assert.deepEqual(sky.options.night.moonDirection, moon.direction);
  assert.deepEqual(sky.options.sunDirection, sunPosition(astro.date, observer).direction);
  near(sky.options.night.moonPhase, 2 * moon.illumination - 1, 1e-12, 'phase');
  assert.equal(sky.options.night.moonLitBySun, true);
  assert.equal(sky.options.night.starIntensity, 0, 'the catalogue replaces the procedural stars');
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  assert.deepEqual(
    h.commands().filter((c) => c.startsWith('draw 6 ')),
    [`draw 6 ${catalog.count + 7}`],
  );
  // By day nothing is drawn. The sky sets its night in its own pass, after this frame's update: AstroSky reads it there.
  astro.onPreUpdate(0);
  sky.nightFactor = 0;
  const before = h.commands().length;
  h.context.bindings = [];
  h.engine.frameGraph.execute(h.context);
  assert.equal(
    h
      .commands()
      .slice(before)
      .filter((c) => c.startsWith('draw 6 ')).length,
    0,
  );
  for (const bad of [{ timeScale: 2e6 }, { pointSize: 0.1 }, { latitude: 52 }, { catalog: {} }])
    assert.throws(() => new AstroSky({ ...observer, ...bad }), /AstroSky|observer|catalog/, JSON.stringify(bad));
  astro.dispose();
});
