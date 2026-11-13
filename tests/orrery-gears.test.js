// The Orrery demo's gear trains (examples/orrery/gears.ts) and layout (layout.ts): every train turns its planet's wheel
// at the planet's mean motion to the error stated in examples/orrery/README.md, every wheel fits the frame, meshing
// wheels interleave their teeth at every angle, nothing on the arms collides, and blender/layout.json (what Blender
// builds the model from) is current.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLANETS, centuries, meanMotion, planetPosition, J2000, FITTED_SPAN } from '../examples/orrery/ephemeris.ts';
import {
  CLEARANCE,
  DRIVE_RATE,
  FRAME,
  L1,
  L2,
  bestTrain,
  designTrains,
  driveAngle,
  misfit,
  modules,
  radii,
  ratio,
  target,
  toothPhase,
  wheelAngles,
} from '../examples/orrery/gears.ts';
import { DOME, PLANET_Z, SUN, planetLayouts, reach } from '../examples/orrery/layout.ts';
import { layoutJSON } from '../examples/orrery/blender/layout-json.mjs';

const trains = designTrains();
// Ratio error ceilings, measured: every train is within 2 parts per million except Neptune's, whose ratio (1 to 55)
// the tooth range reaches only to 2.57e-5.
const RATIO_ERROR = {
  mercury: 1.64e-6,
  venus: 1.69e-6,
  earth: 0,
  mars: 6e-7,
  jupiter: 6.7e-7,
  saturn: 1.21e-6,
  uranus: 7.4e-7,
  neptune: 2.57e-5,
};

test('the trains are the ones the model was built from', () => {
  assert.deepEqual(trains, {
    mercury: { a: 125, b: 22, c: 114, d: 52 },
    venus: { a: 57, b: 23, c: 61, d: 31 },
    earth: { a: 36, b: 18, c: 39, d: 26 },
    mars: { a: 25, b: 32, c: 49, d: 24 },
    jupiter: { a: 33, b: 68, c: 37, d: 71 },
    saturn: { a: 59, b: 73, c: 15, d: 119 },
    uranus: { a: 15, b: 89, c: 25, d: 118 },
    neptune: { a: 16, b: 113, c: 18, d: 140 },
  });
  const committed = readFileSync(new URL('../examples/orrery/blender/layout.json', import.meta.url), 'utf8');
  assert.equal(
    committed.replace(/\r\n/g, '\n'),
    layoutJSON(),
    'run node examples/orrery/blender/write-layout.mjs and rebuild the model',
  );
});

test('each train turns its tube at the planet mean motion within its ratio error', () => {
  for (const name of PLANETS) {
    const error = Math.abs(ratio(trains[name]) / target(name) - 1);
    assert.ok(error <= RATIO_ERROR[name], `${name}: ${error}`);
    // Through the angles the page uses: a century of drive turns gives the planet's century of mean longitude.
    const turned =
      (wheelAngles(trains[name], driveAngle(J2000 + 36525)).d - wheelAngles(trains[name], driveAngle(J2000)).d) *
      (180 / Math.PI);
    const wanted = meanMotion(name) * 36525;
    assert.ok(Math.abs(turned / wanted - 1) <= RATIO_ERROR[name] + 1e-12, `${name}: ${turned} for ${wanted}`);
  }
  assert.equal(DRIVE_RATE * 3, meanMotion('earth') * 36525);
});

test('over 1800 to 2050 no wheel drifts more than 0.62 degrees from its planet mean longitude', () => {
  for (const name of PLANETS) {
    const [a, b] = FITTED_SPAN;
    const wheel =
      (wheelAngles(trains[name], driveAngle(b)).d - wheelAngles(trains[name], driveAngle(a)).d) * (180 / Math.PI);
    const mean = meanMotion(name) * (b - a);
    assert.ok(Math.abs(wheel - mean) < 0.62, `${name}: ${Math.abs(wheel - mean)} degrees`);
  }
});

test('the search finds the best fitting train: no fitting train with teeth 15 to 140 is closer', () => {
  // Spot check on Mars: every (a, b, c) with the best d, the same search, done without the tie rule.
  const wanted = target('mars');
  let best = Infinity;
  for (let a = 15; a <= 140; a++)
    for (let b = 15; b <= 140; b++)
      for (let c = 15; c <= 140; c++)
        for (const d of [Math.floor((a * c) / (b * wanted)), Math.ceil((a * c) / (b * wanted))]) {
          if (d < 15 || d > 140) continue;
          const t = { a, b, c, d };
          if (!misfit(t)) best = Math.min(best, Math.abs(ratio(t) / wanted - 1));
        }
  assert.equal(Math.abs(ratio(bestTrain(wanted)) / wanted - 1) <= Math.max(best, 2e-6), true);
});

test('every wheel fits: centre distances are the sums of pitch radii and tips clear what they do not mesh with', () => {
  for (const name of PLANETS) {
    const t = trains[name];
    assert.equal(misfit(t), null, name);
    const { A, B } = modules(t);
    assert.ok(Math.abs(radii(t.a, A).pitch + radii(t.b, A).pitch - FRAME.D12) < 1e-12);
    assert.ok(Math.abs(radii(t.c, B).pitch + radii(t.d, B).pitch - FRAME.D2) < 1e-12);
    assert.ok(radii(t.a, A).tip + 0.0165 + CLEARANCE <= Math.hypot(...L1));
  }
  assert.ok(Math.abs(Math.hypot(L1[0] - L2[0], L1[1] - L2[1]) - FRAME.D12) < 1e-12);
});

test('meshing wheels interleave: a tooth of one faces a gap of the other at any angle', () => {
  const toL2 = Math.atan2(L2[1] - L1[1], L2[0] - L1[0]),
    toC = Math.atan2(-L2[1], -L2[0]);
  for (const name of PLANETS) {
    const t = trains[name];
    for (let k = 0; k < 50; k++) {
      const drive = k * 0.7373 - 12;
      const w = wheelAngles(t, drive);
      const ab = (toothPhase(w.a, t.a, toL2) + toothPhase(w.b, t.b, toL2 + Math.PI)) % 1;
      const cd = (toothPhase(w.c, t.c, toC) + toothPhase(w.d, t.d, toC + Math.PI)) % 1;
      assert.ok(Math.abs(ab - 0.5) < 1e-6, `${name} a-b ${ab}`);
      assert.ok(Math.abs(cd - 0.5) < 1e-6, `${name} c-d ${cd}`);
    }
  }
});

test('planets, rings and moons never touch a neighbour, the Sun or the dome', () => {
  const layouts = planetLayouts();
  for (let i = 0; i < layouts.length; i++) {
    const p = layouts[i];
    if (i === 0) assert.ok(p.orbit - reach(p) > SUN.radius + 0.01);
    if (i > 0) {
      const q = layouts[i - 1];
      assert.ok(p.orbit - reach(p) > q.orbit + reach(q), `${q.name} and ${p.name} overlap`);
    }
    // Arms stack: inner planets higher, by more than an arm's thickness.
    if (i > 0) assert.ok(layouts[i - 1].armZ - p.armZ > 0.0028 + 0.004);
    assert.ok(p.armZ < PLANET_Z - p.radius);
  }
  const last = layouts.at(-1);
  assert.ok(last.orbit + reach(last) < DOME.radius - DOME.thickness - 0.01);
});

test('the arms point where the planets are', () => {
  // Spot values on 2026-11-13 00:00 UTC, so a sign or axis slip in the page shows here first.
  const jd = 2461357.5;
  assert.ok(Math.abs(centuries(jd) - 0.26864) < 1e-4);
  const earth = planetPosition('earth', jd).longitude;
  assert.ok(earth > 50 && earth < 51.5, String(earth));
});
