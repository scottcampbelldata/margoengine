// @margoengine/sky/sun: typed angles, named sun and ambient setters over core's packed arrays, and a sky that lights.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Angle,
  degrees,
  radians,
  isAngle,
  sunDirectionFrom,
  setSun,
  getSun,
  setAmbient,
  getAmbient,
  sunlitSky,
  sunPath,
} from '@margoengine/sky/sun';
import { Sky, sunDirectionFromAngles, skyEnvironmentFloor } from '@margoengine/sky';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// Core's defaults, as in packages/core/src/engine.ts.
const scene = () => ({
  lighting: {
    direction: new Float32Array([3, 5, 4, 3]),
    radiance: new Float32Array([1, 1, 1, 0.15]),
    ambient: new Float32Array([1, 1, 1]),
  },
  plugins: new Map(),
});
const elevationOf = (d) => (Math.asin(d[1] / Math.hypot(d[0], d[1], d[2])) * 180) / Math.PI;
const close = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} is not ${b}`);

test('angles carry their unit and convert both ways', () => {
  const a = degrees(35),
    b = radians((35 * Math.PI) / 180);
  assert.equal(a.degrees, 35);
  close(a.radians, (35 * Math.PI) / 180, 1e-12);
  close(b.degrees, 35, 1e-12);
  assert.ok(isAngle(a) && a instanceof Angle && !isAngle(35));
  assert.equal(`${a}`, '35deg');
  assert.ok(Object.isFrozen(a));
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => degrees(bad), RangeError);
    assert.throws(() => radians(bad), RangeError);
  }
});

test('regression: an angle can never be read as a number of the wrong unit', () => {
  // The terrain editor's bug: degrees converted to radians, then passed where degrees were expected.
  const wrong = sunDirectionFromAngles(135, (35 * Math.PI) / 180);
  close(elevationOf(wrong), 0.6109, 1e-3); // the old mistake: a 35 degree sun on the horizon
  // With typed angles the same radians value is a 35 degree sun, and the numbers cannot be mixed up.
  const right = sunDirectionFrom(degrees(135), radians((35 * Math.PI) / 180));
  close(elevationOf(right), 35);
  const angle = radians(0.61);
  assert.throws(() => angle * 2, TypeError);
  assert.throws(() => Number(angle), TypeError);
  assert.throws(() => angle + 1, TypeError);
  assert.throws(() => sunDirectionFromAngles(degrees(135), degrees(35)), RangeError, 'sky/base takes plain degrees');
  assert.throws(() => sunDirectionFrom(135, 35), /wrap the number as degrees\(135\)/);
  assert.throws(() => setSun(scene(), { azimuth: 135, elevation: 0.61 }), TypeError);
  // A tiny elevation is legitimate (a sun on the horizon), so it is accepted, not guessed at.
  close(elevationOf(sunDirectionFrom(degrees(0), degrees(0.6))), 0.6);
  assert.throws(() => sunDirectionFrom(degrees(0), degrees(91)), RangeError);
});

test('setSun writes a 35 degree sun with its strength into the packed arrays', () => {
  const s = scene(),
    sun = setSun(s, { azimuth: degrees(135), elevation: degrees(35), intensity: 4, color: [1, 0.9, 0.8] });
  const d = s.lighting.direction;
  close(elevationOf(d), 35);
  close(Math.atan2(d[0], d[2]), (135 * Math.PI) / 180);
  assert.equal(d[3], 4, 'intensity is the fourth direction component');
  assert.deepEqual([...s.lighting.radiance.slice(0, 3)], [1, Math.fround(0.9), Math.fround(0.8)]);
  close(s.lighting.radiance[3], 0.15, 1e-7);
  assert.equal(sun.intensity, 4);
  close(elevationOf(sun.direction), 35);
  assert.deepEqual(getSun(s), sun);
  // The getter's shape feeds the setter back.
  const other = scene();
  setSun(other, getSun(s));
  assert.deepEqual(getSun(other), getSun(s));
});

test('setSun keeps what it is not given, checks everything first and refuses mixed directions', () => {
  const s = scene();
  assert.equal(setSun(s, { direction: [0, 1, 0] }).intensity, 3, 'core default intensity is kept, and visible');
  const before = [...s.lighting.direction, ...s.lighting.radiance];
  for (const bad of [
    { direction: [0, 0, 0] },
    { direction: [1, 2] },
    { intensity: -1 },
    { intensity: Number.NaN },
    { color: [1, -1, 1] },
    { direction: [0, 1, 0], elevation: degrees(10), azimuth: degrees(0) },
    { elevation: degrees(10) },
    { direction: [0, 1, 0], intensity: -2 },
  ])
    assert.throws(() => setSun(s, bad), bad.intensity < 0 || Number.isNaN(bad.intensity) ? RangeError : Error);
  assert.deepEqual([...s.lighting.direction, ...s.lighting.radiance], before, 'a bad call changes nothing');
  assert.throws(() => setSun({}, { intensity: 1 }), TypeError);
  assert.throws(() => setSun(s, null), TypeError);
});

test('setAmbient writes the ambient strength and colour', () => {
  const s = scene();
  assert.deepEqual(getAmbient(s), { color: [1, 1, 1], intensity: Math.fround(0.15) });
  const ambient = setAmbient(s, { color: [0.5, 0.75, 1], intensity: 0.25 });
  assert.equal(s.lighting.radiance[3], 0.25, 'ambient strength is the fourth radiance component');
  assert.deepEqual([...s.lighting.ambient], [0.5, 0.75, 1]);
  assert.deepEqual(ambient, { color: [0.5, 0.75, 1], intensity: 0.25 });
  assert.deepEqual(getSun(s).intensity, 3, 'the sun is untouched');
  assert.throws(() => setAmbient(s, { intensity: -0.1 }), RangeError);
  assert.throws(() => setAmbient(s, { color: 'white' }), TypeError);
});

test('a sky that drives the light makes the setters throw a coded error instead of being overwritten', () => {
  const s = scene();
  s.plugins.set('sky', new Sky(sunlitSky()));
  assert.throws(
    () => setSun(s, { intensity: 2 }),
    (e) => e.name === 'MargoError' && e.code === 'state' && /sky\.options/.test(e.message),
  );
  assert.throws(
    () => setAmbient(s, { intensity: 2 }),
    (e) => e.code === 'state',
  );
  const backdrop = scene();
  backdrop.plugins.set('sky', new Sky({}));
  assert.doesNotThrow(() => setSun(backdrop, { intensity: 2 }), 'a backdrop-only sky leaves the light to the app');
  const lightOnly = scene();
  lightOnly.plugins.set('sky', new Sky(sunlitSky({ skyAmbient: false })));
  assert.doesNotThrow(() => setAmbient(lightOnly, { intensity: 0.3 }));
});

test('sunlitSky lights the scene from a 35 degree sun with core-like strength', () => {
  const options = sunlitSky({ elevation: degrees(35) });
  assert.deepEqual(options.lighting.ambient, skyEnvironmentFloor, 'same floor as the sky environment fallback');
  close(elevationOf(options.sunDirection), 35);
  assert.equal(sunlitSky({ skyAmbient: false }).lighting.ambient, undefined);
  assert.throws(() => sunlitSky({ elevation: 35 }), TypeError);
  assert.throws(() => sunlitSky({ intensity: -1 }), RangeError);
  const h = optionalGPU();
  h.engine.lighting = { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) };
  const sky = new Sky(sunlitSky({ elevation: degrees(35), skyAmbient: false }));
  h.engine.use(sky);
  try {
    h.frame();
    const d = h.engine.lighting.direction;
    close(elevationOf(d), 35, 1e-4);
    // The atmosphere dims a 35 degree sun a little below the overhead strength of 3.
    assert.ok(d[3] > 2.4 && d[3] <= 3, `sun strength ${d[3]}`);
  } finally {
    sky.dispose();
  }
});

test('sunPath: Spencer 1971 declination, solstice noon elevation and the compass', () => {
  // Spencer's declination peaks near 23.44 degrees at the June solstice (day 172).
  const june = sunPath({ latitude: degrees(0), dayOfYear: 172, hour: 12 });
  close(june.declination.degrees, 23.44, 0.05);
  // At solar noon of the solstice the sun stands 90 - |latitude - 23.44| degrees high, north or south of the tropic.
  for (const lat of [0, 23.44, 45, 60, -30]) {
    const p = sunPath({ latitude: degrees(lat), dayOfYear: 172, hour: 12 });
    close(p.elevation.degrees, 90 - Math.abs(lat - 23.44), 0.05);
    close(p.elevation.degrees, 90 - Math.abs(lat - p.declination.degrees), 1e-9);
    close(Math.hypot(...p.direction), 1, 1e-12);
  }
  // North of the sun at noon it stands due south (+Z, azimuth 0); south of it, due north (-Z, azimuth 180).
  close(sunPath({ latitude: degrees(45), dayOfYear: 172, hour: 12 }).azimuth.degrees, 0, 1e-9);
  close(sunPath({ latitude: degrees(-30), dayOfYear: 172, hour: 12 }).azimuth.degrees, 180, 1e-9);
  // Equinox: the declination crosses 0 between 20 and 21 March (days 79 and 80).
  const a = sunPath({ latitude: degrees(0), dayOfYear: 79, hour: 12 }).declination.degrees,
    b = sunPath({ latitude: degrees(0), dayOfYear: 80, hour: 12 }).declination.degrees;
  assert.ok(Math.abs(a) < 0.6 && Math.abs(b) < 0.6 && Math.min(Math.abs(a), Math.abs(b)) < 0.25, `equinox ${a}, ${b}`);
  // The December solstice mirrors June.
  close(sunPath({ latitude: degrees(0), dayOfYear: 355, hour: 12 }).declination.degrees, -23.44, 0.1);
  // Morning and afternoon mirror about the meridian: same height, east and west of south.
  for (const lat of [10, 45, -35]) {
    const am = sunPath({ latitude: degrees(lat), dayOfYear: 100, hour: 9 }),
      pm = sunPath({ latitude: degrees(lat), dayOfYear: 100, hour: 15 });
    close(am.elevation.degrees, pm.elevation.degrees, 1e-9);
    close(am.direction[0], -pm.direction[0], 1e-12);
    close(am.direction[2], pm.direction[2], 1e-12);
  }
  // The morning sun is in the east (+X), the afternoon sun in the west.
  assert.ok(sunPath({ latitude: degrees(45), dayOfYear: 172, hour: 8 }).direction[0] > 0);
  assert.ok(sunPath({ latitude: degrees(45), dayOfYear: 172, hour: 16 }).direction[0] < 0);
  // Equation of time: Spencer's curve reaches about -14 minutes in February and +16 in early November.
  assert.ok(sunPath({ latitude: degrees(0), dayOfYear: 42, hour: 12 }).equationOfTime < -13.5);
  assert.ok(sunPath({ latitude: degrees(0), dayOfYear: 307, hour: 12 }).equationOfTime > 16);
  // Polar night and polar day: no NaN, the sun stays below or above the horizon all day.
  for (let hour = 0; hour <= 24; hour += 1.5) {
    const night = sunPath({ latitude: degrees(80), dayOfYear: 355, hour }),
      day = sunPath({ latitude: degrees(80), dayOfYear: 172, hour }),
      pole = sunPath({ latitude: degrees(-90), dayOfYear: 172, hour });
    assert.ok(night.elevation.degrees < 0, `polar night ${night.elevation}`);
    assert.ok(day.elevation.degrees > 0, `polar day ${day.elevation}`);
    for (const p of [night, day, pole])
      assert.ok([p.azimuth.degrees, p.elevation.degrees, ...p.direction].every(Number.isFinite));
  }
  // Validation names the fix.
  assert.throws(() => sunPath({ latitude: 45, dayOfYear: 1, hour: 12 }), TypeError);
  assert.throws(() => sunPath(null), TypeError);
  assert.throws(() => sunPath({ latitude: degrees(91), dayOfYear: 1, hour: 12 }), RangeError);
  assert.throws(() => sunPath({ latitude: degrees(45), dayOfYear: 0, hour: 12 }), RangeError);
  assert.throws(() => sunPath({ latitude: degrees(45), dayOfYear: 367, hour: 12 }), RangeError);
  assert.throws(() => sunPath({ latitude: degrees(45), dayOfYear: 1.5, hour: 12 }), RangeError);
  assert.throws(() => sunPath({ latitude: degrees(45), dayOfYear: 1, hour: 24.5 }), RangeError);
  assert.throws(() => sunPath({ latitude: degrees(45), dayOfYear: 1, hour: Number.NaN }), RangeError);
  assert.throws(() => sunPath({ latitude: degrees(45), dayOfYear: '1', hour: 12 }), TypeError);
  assert.doesNotThrow(() => sunPath({ latitude: degrees(45), dayOfYear: 366, hour: 24 }));
});
