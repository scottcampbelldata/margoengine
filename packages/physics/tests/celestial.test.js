import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASTRONOMICAL_UNIT,
  CelestialSolver,
  SpkEphemeris,
  earthFrame,
  localHorizon,
  sampleInsolation,
  tidalDrive,
  toEarthFixed,
  toJ2000,
  trackSolarRow,
} from '../dist/celestial.js';
import { PhysicsWorld } from '../dist/world.js';

const rad = (degrees) => (degrees * Math.PI) / 180;
const tolerance = (value, expected, error) =>
  assert.ok(Math.abs(value - expected) <= error, 'expected ' + expected + ' ± ' + error + ', got ' + value);

function spkFile(segments, littleEndian = true) {
  const summaryOffset = 1024;
  const dataOffset = 3 * 1024;
  const dataWords = segments.reduce((total, segment) => total + segment.records.flat().length + 4, 0);
  const file = new ArrayBuffer(Math.ceil((dataOffset + dataWords * 8) / 1024) * 1024);
  const view = new DataView(file);
  const i32 = (offset, i) => view.setInt32(offset, i, littleEndian);
  const f64 = (offset, n) => view.setFloat64(offset, n, littleEndian);
  const encoder = new TextEncoder();
  new Uint8Array(file).set(encoder.encode('DAF/SPK '));
  new Uint8Array(file, 88).set(encoder.encode(littleEndian ? 'LTL-IEEE' : 'BIG-IEEE'));
  i32(8, 2);
  i32(12, 6);
  i32(76, 2);
  i32(80, 2);
  i32(84, dataOffset / 8 + dataWords + 1);
  f64(summaryOffset + 16, segments.length);
  let word = dataOffset / 8;
  for (const [id, segment] of segments.entries()) {
    const [{ length: recordWords }] = segment.records;
    const length = segment.records.length;
    const descriptor = summaryOffset + 24 + 40 * id;
    const first = word + 1;
    const last = word + recordWords * length + 4;
    f64(descriptor, segment.start);
    f64(descriptor + 8, segment.start + segment.interval * length);
    [segment.target, segment.observer, segment.frame ?? 1, segment.type, first, last].forEach((value, index) =>
      i32(descriptor + 16 + 4 * index, value),
    );
    for (const value of [...segment.records.flat(), segment.start, segment.interval, recordWords, length])
      f64(8 * word++, value);
  }
  return file;
}

function constantSegment(target, observer, x, start = 0, interval = 20) {
  return { target, observer, type: 2, start, interval, records: [[start + interval / 2, interval / 2, x, 0, 0]] };
}

test('SPK position and velocity use Chebyshev values and analytic derivatives, including the last boundary', () => {
  for (const littleEndian of [true, false]) {
    // x = 1 + 2T₁ + 3T₂; d(x)/dt = 2 + 12t when the record radius is 1 s.
    const kernel = new SpkEphemeris(
      spkFile(
        [
          {
            target: 301,
            observer: 399,
            type: 2,
            start: -1,
            interval: 2,
            records: [[0, 1, 1, 2, 3, 0, 0, 0, -2, 1, 0]],
          },
        ],
        littleEndian,
      ),
    );
    assert.deepEqual(kernel.state(301, 399, 0.5), { position: [500, 0, -1500], velocity: [8000, 0, 1000] });
    assert.deepEqual(kernel.state(301, 399, 1), { position: [6000, 0, -1000], velocity: [14000, 0, 1000] });
    assert.throws(() => kernel.state(301, 399, 1 + Number.EPSILON), /connected coverage/);
  }
});

test('SPK type 3 velocity uses its own series, and source bytes may be changed after construction', () => {
  const bytes = new Uint8Array(
    spkFile([
      {
        target: 10,
        observer: 0,
        type: 3,
        start: -1,
        interval: 2,
        records: [[0, 1, 1, 2, -3, 0, 4, -5, 11, 0, 13, 0, -17, 3]],
      },
    ]),
  );
  const wrapped = new Uint8Array(bytes.length + 7);
  wrapped.set(bytes, 7);
  const kernel = new SpkEphemeris(wrapped.subarray(7));
  wrapped.fill(0);
  assert.deepEqual(kernel.state(10, 0, 0.5), {
    position: [2000, -3000, 1500],
    velocity: [11000, 13000, -15500],
  });
});

test('SPK observes relative to the common centre and uses the last overlap and the next interval boundary', () => {
  const kernel = new SpkEphemeris(
    spkFile([
      constantSegment(301, 3, 17),
      constantSegment(399, 3, 15),
      constantSegment(3, 0, 1e12),
      constantSegment(301, 3, 20, 10, 2),
      {
        target: 5,
        observer: 0,
        type: 2,
        start: 0,
        interval: 10,
        records: [
          [5, 5, 4, 0, 0],
          [15, 5, 9, 0, 0],
        ],
      },
    ]),
  );
  assert.equal(kernel.state(301, 399, 4).position[0], 2000);
  assert.equal(kernel.state(301, 399, 11).position[0], 5000);
  assert.equal(kernel.state(399, 301, 11).position[0], -5000);
  assert.equal(kernel.state(301, 399, 13).position[0], 2000);
  assert.equal(kernel.state(5, 0, 10).position[0], 9000);
  assert.equal(kernel.state(5, 0, 20).position[0], 9000);
});

test('SPK rejects invalid records, unsupported winning segments and centre cycles', () => {
  assert.throws(() => new SpkEphemeris(new Uint8Array(25)), /DAF records/);
  const cycle = new SpkEphemeris(spkFile([constantSegment(1, 2, 0), constantSegment(2, 1, 0)]));
  assert.throws(() => cycle.state(1, 0, 0), /cycle/);
  const unsupported = new SpkEphemeris(
    spkFile([constantSegment(10, 0, 1), { ...constantSegment(10, 0, 2), frame: 11 }]),
  );
  assert.throws(() => unsupported.state(10, 0, 0), /J2000-frame type 2 or type 3/);
  const bad = spkFile([constantSegment(10, 0, 1)]);
  new DataView(bad).setFloat64(3 * 1024 + 8, 0, true);
  assert.throws(() => new SpkEphemeris(bad).state(10, 0, 0), /does not cover/);
});

test('Earth rotation agrees with the Wallace and Capitaine reference procedure and is orthogonal', () => {
  // Table A.14 and equation A.16, converted from the published split dates. Use the modelled pole, whose
  // short nutation series has a published 0.5″ longitude and 0.1″ obliquity precision (Meeus Ch.22).
  const tt = (2205.5 + 0.892855138888889) * 86400;
  const ut1 = (2205.5 + 0.892104561342593) * 86400;
  const frame = earthFrame(tt, ut1, { tio: 0 });
  tolerance(frame.rotation, rad(76.265431053522), 1.0e-10);
  const published = [
    [0.23742421473054043, 0.97140604802742436, -0.00017920749858993],
    [-0.97140588849284706, 0.23742427873021974, 0.0005582748940321],
    [0.00058485981985452, 0.00004153524101576, 0.99999982810689266],
  ];
  const poleError = rad((0.5 + 0.1) / 3600);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tolerance(frame.matrix[i][j], published[i][j], poleError);
  const vector = [123, -567, 789];
  toJ2000(frame, toEarthFixed(frame, vector)).forEach((n, axis) => tolerance(n, vector[axis], 5e-13));

  const equator = localHorizon({ latitude: 0, longitude: 0 });
  assert.deepEqual(equator.position, [6378137, 0, 0]);
  tolerance(localHorizon({ latitude: Math.PI / 2, longitude: 0 }).position[2], 6356752.314245179, 1e-8);
});

test('solar eclipses distinguish total, annular, partial and no eclipse, and remove only obscured insolation', () => {
  const site = { latitude: 0, longitude: 0 };
  const {
    position: [earth],
  } = localHorizon(site);
  const solar = [earth + ASTRONOMICAL_UNIT, 0, 0];
  const sunlight = sampleInsolation(solar, [-360e6, 1, 0], site);
  assert.equal(sunlight.eclipse, 'none');
  assert.equal(sunlight.horizontal, 1361);
  assert.equal(sunlight.elevation, Math.PI / 2);

  const total = sampleInsolation(solar, [earth + 360e6, 0, 0], site);
  assert.equal(total.eclipse, 'total');
  assert.equal(total.obscuration, 1);
  assert.equal(total.horizontal, 0);
  const annular = sampleInsolation(solar, [earth + 404e6, 0, 0], site);
  assert.equal(annular.eclipse, 'annular');
  const ratio = Math.asin(1737400 / 404e6) / Math.asin(695700000 / ASTRONOMICAL_UNIT);
  tolerance(annular.obscuration, ratio * ratio, 3e-15);
  tolerance(annular.horizontal, 1361 * (1 - ratio * ratio), 5e-12);
  const partial = sampleInsolation(solar, [earth + 370e6, 1.15e6, 0], site);
  assert.equal(partial.eclipse, 'partial');
  assert.ok(partial.obscuration > 0 && partial.obscuration < 1);
});

const eclipseCases = [
  ['2017-08-21T18:25:31Z', 37, -87.7, 'total', 'none'],
  ['2024-04-08T18:42:34Z', 32.7767, -96.797, 'total', 'none'],
  ['2022-11-08T10:59:00Z', 40, -90, 'none', 'total'],
];

test('the analytic ephemeris reproduces the 2017 and 2024 total solar and the 2022 total lunar eclipses', () => {
  for (const [utc, latitude, longitude, sun, moon] of eclipseCases) {
    // TT is 69.184 s after UTC for all three dates; treating UT1 as UTC changes the local rotation by under 14″.
    const ut1Seconds = (Date.parse(utc) - Date.parse('2000-01-01T12:00Z')) / 1000;
    const solver = new CelestialSolver();
    new PhysicsWorld().add(solver, { epoch: { ut1Seconds, ttSeconds: ut1Seconds + 69.184 } });
    assert.equal(solver.insolation({ latitude: rad(latitude), longitude: rad(longitude) }).eclipse, sun);
    assert.equal(solver.lunarEclipse().type, moon);
  }
});

test('tidal potential and acceleration retain the exact Newton result along the bodies’ line at large and tiny offsets', () => {
  const moon = 370e6;
  const sun = ASTRONOMICAL_UNIT;
  for (const offset of [6378137, 0.0001]) {
    const expected = (gm, distance) => {
      const q = offset / distance;
      return {
        potential: (gm / distance) * ((q * q) / (1 - q)),
        acceleration: (gm / distance / distance) * ((q * (2 - q)) / ((1 - q) * (1 - q))),
      };
    };
    const m = expected(4.902800118e12, moon);
    const s = expected(1.3271244e20, sun);
    const actual = tidalDrive([sun, 0, 0], [moon, 0, 0], [offset, 0, 0]);
    tolerance(actual.potential, m.potential + s.potential, 10 * Number.EPSILON * actual.potential);
    tolerance(actual.acceleration[0], m.acceleration + s.acceleration, 10 * Number.EPSILON * actual.acceleration[0]);
    assert.equal(actual.acceleration[1], 0);
    assert.equal(actual.acceleration[2], 0);
  }
  assert.deepEqual(tidalDrive([sun, 0, 0], [moon, 0, 0], [0, 0, 0]), { potential: 0, acceleration: [0, 0, 0] });
});

test('SOLARFIELD-2: independent slopes and rack tolerance produce different commands, with immediate wind stow', () => {
  const dawn = [Math.cos(rad(6)), 0, Math.sin(rad(6))];
  const flat = trackSolarRow(dawn, { groundCoverageRatio: 0.5 });
  const hill = trackSolarRow(dawn, { groundCoverageRatio: 0.5, crossAxisSlope: rad(4), rotationOffset: rad(0.2) });
  assert.equal(flat.mode, 'backtrack');
  assert.equal(hill.mode, 'backtrack');
  assert.notEqual(flat.command, hill.command);
  tolerance(hill.rotation - hill.command, rad(0.2), 1e-15);
  const storm = trackSolarRow(dawn, { windSpeed: 20, stowAt: 20, stowAngle: rad(-8) });
  assert.equal(storm.mode, 'wind-stow');
  assert.equal(storm.rotation, rad(-8));
  assert.equal(trackSolarRow([-1, 0, -1]).mode, 'night-stow');
});

test('SOLARFIELD-3: the next row is shaded at low sun until the backtracking angle clears the projected aperture', () => {
  const elevation = rad(6);
  const dawn = [Math.cos(elevation), 0, Math.sin(elevation)];
  const uncorrected = trackSolarRow(dawn, { groundCoverageRatio: 0.5, backtrack: false });
  tolerance(uncorrected.shadedFraction, 1 - 2 * Math.sin(elevation), 2e-15);
  const corrected = trackSolarRow(dawn, { groundCoverageRatio: 0.5 });
  assert.equal(corrected.mode, 'backtrack');
  tolerance(corrected.command, Math.PI / 2 - elevation - Math.acos(2 * Math.sin(elevation)), 2e-15);
  tolerance(corrected.shadedFraction, 0, 2e-15);
});
