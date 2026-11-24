// FG-08: spray and debris emitter sites from a flood frame. The rates are checked against the formulas the package
// documents, written out here: spray, Ihmsen et al. 2012's count k x breaker x area with a lift of k sqrt(g h); debris,
// the Manning bed shear's Shields number and Meyer-Peter and Mueller's bedload counted in pieces of d^3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { floodBirths, floodEmitters } from '../dist/flood-bake.js';

// A 4 x 1 strip of 2 m x 3 m cells at origin [10, 20]: a breaking cell, a calm deep one, a fast shallow one, a dry one.
const reading = () => ({
  time: 0,
  width: 4,
  height: 1,
  depth: Float32Array.from([4, 4, 1, 0]),
  bed: Float32Array.from([-4, -3, -0.5, 1]),
  velocity: Float32Array.from([2, 0, 0.5, 0, 3, -4, 9, 9]),
  foam: new Float32Array(4),
  breaker: Float32Array.from([1, 0.1, 0, 1]),
});
const place = { origin: [10, 20], size: [8, 3] };

test('spray rises where the water breaks, at the breaker-scaled rate and lift', () => {
  const { spray } = floodEmitters(reading(), { place });
  assert.equal(spray.count, 1, 'the breaking cell only: 0.1 is under the threshold, a dry cell makes none');
  assert.equal(spray.cell[0], 0);
  assert.ok(Math.abs(spray.rate[0] - 20 * 1 * 6) < 1e-4, `rate ${spray.rate[0]}`);
  assert.deepEqual(Array.from(spray.position), [11, 0, 21.5]);
  const lift = 0.5 * Math.sqrt(9.81 * 4);
  assert.deepEqual(Array.from(spray.velocity), [2, Math.fround(lift), 0]);
  const low = floodEmitters(reading(), { place, sprayThreshold: 0.05, sprayRate: 5, sprayLift: 0 }).spray;
  assert.equal(low.count, 2);
  assert.deepEqual(Array.from(low.cell), [0, 1], 'highest rate first');
  assert.equal(low.velocity[1], 0);
});

test('debris is picked up where the bed shear passes the Shields threshold, at the Meyer-Peter and Mueller rate', () => {
  // Fine gravel of 1 cm: theta 0.139 under 5 m/s over 1 m, 0.014 under 2 m/s over 4 m.
  const { debris } = floodEmitters(reading(), { place, debrisSize: 0.01 });
  assert.equal(debris.count, 1, 'only the 5 m/s cell: 2 m/s over 4 m is under theta_c');
  assert.equal(debris.cell[0], 2);
  const n = 0.03,
    d = 0.01,
    s = 2.65,
    g = 9.81,
    U2 = 3 * 3 + 4 * 4,
    theta = (n * n * U2) / Math.cbrt(1) / ((s - 1) * g * d),
    q = 8 * (theta - 0.047) ** 1.5 * Math.sqrt((s - 1) * g * d ** 3),
    width = (3 * 3 + 4 * 2) / 5;
  assert.ok(theta > 0.047);
  assert.ok(Math.abs(debris.rate[0] / ((q / d ** 3) * width) - 1) < 1e-6, `rate ${debris.rate[0]}`);
  assert.deepEqual(Array.from(debris.position), [15, -0.5, 21.5], 'on the bed at the cell centre');
  assert.deepEqual(Array.from(debris.velocity), [3, 0, -4]);
  assert.equal(floodEmitters(reading(), { place }).debris.count, 0, 'the default 5 cm gravel stays (theta 0.028)');
  assert.equal(floodEmitters(reading(), { place, debrisSize: 0.01, debrisRate: 0 }).debris.count, 0);
});

test('sites are capped by rate and the same reading gives the same sites', () => {
  const a = floodEmitters(reading(), { place, sprayThreshold: 0.05, maxSites: 1 }),
    b = floodEmitters(reading(), { place, sprayThreshold: 0.05, maxSites: 1 });
  assert.equal(a.spray.count, 1);
  assert.equal(a.spray.cell[0], 0);
  assert.deepEqual(a, b);
});

test('births: rate x seconds on average, inside the cell, the same call the same births', () => {
  const { spray } = floodEmitters(reading(), { place });
  let total = 0;
  for (let frame = 0; frame < 2000; frame++) {
    const births = floodBirths(spray, 1 / 48, { cell: [2, 3], frame });
    total += births.count;
    for (let i = 0; i < births.count; i++) {
      assert.ok(births.position[3 * i] >= 10 && births.position[3 * i] <= 12);
      assert.ok(births.position[3 * i + 2] >= 20 && births.position[3 * i + 2] <= 23);
    }
  }
  const expected = 120 / 48;
  assert.ok(Math.abs(total / 2000 / expected - 1) < 0.01, `mean ${total / 2000} against ${expected}`);
  assert.deepEqual(
    floodBirths(spray, 0.1, { cell: [2, 3], seed: 7 }),
    floodBirths(spray, 0.1, { cell: [2, 3], seed: 7 }),
  );
  assert.equal(floodBirths(spray, 10, { cell: [2, 3], max: 5 }).count, 5);
});

test('bad input is refused', () => {
  assert.throws(() => floodEmitters({}, { place }), TypeError);
  assert.throws(() => floodEmitters(reading(), {}), TypeError);
  assert.throws(() => floodEmitters(reading(), { place, sprayRate: -1 }), RangeError);
  assert.throws(() => floodEmitters(reading(), { place, maxSites: 1.5 }), RangeError);
  const { spray } = floodEmitters(reading(), { place });
  assert.throws(() => floodBirths(spray, -1, { cell: [2, 3] }), RangeError);
  assert.throws(() => floodBirths(spray, 1, { cell: [0, 3] }), RangeError);
});
