import assert from 'node:assert/strict';
import test from 'node:test';
import { keplerDiskSample, keplerState, OrbitSolver } from '../dist/orbit.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const tolerance = (actual, expected, error) =>
  assert.ok(Math.abs(actual - expected) <= error, `${actual} differs from ${expected} by more than ${error}`);

async function make(options) {
  const orbit = await OrbitSolver.load();
  const world = new PhysicsWorld({ rate }).add(orbit, options);
  return { world, orbit };
}

test('integrated binary follows the exact orbit and fourth-order refinement, conserving barycentre', async () => {
  const omega = Math.sqrt(2);
  const speed = omega / 2;
  const bodies = [
    { position: [0.5, 0, 0], velocity: [0, speed, 0], mass: 1 },
    { position: [-0.5, 0, 0], velocity: [0, -speed, 0], mass: 1 },
  ];
  const exact = [0.5 * Math.cos(omega), 0.5 * Math.sin(omega), 0];
  const coarse = await make({ bodies, gravitationalConstant: 1 });
  const fine = await make({ bodies, gravitationalConstant: 1, substeps: 2 });
  for (const { world } of [coarse, fine]) world.advance(60);
  const error = (orbit) => Math.hypot(...orbit.sample(0).position.map((value, i) => value - exact[i]));
  const coarseError = error(coarse.orbit);
  const fineError = error(fine.orbit);
  // For a fourth-order method, halving the step reduces the leading global error by 16.
  assert.ok(
    coarseError / fineError > 14 && coarseError / fineError < 18,
    `step-halving ratio ${coarseError / fineError}`,
  );
  // One time unit moves through less than π/2. Bound displacement by the angular scale of the h^4 truncation.
  assert.ok(coarseError < 2 * (omega / 60) ** 4);
  const a = coarse.orbit.sample(0);
  const b = coarse.orbit.sample(1);
  for (let i = 0; i < 3; i++) {
    assert.equal(a.position[i] + b.position[i], 0);
    assert.equal(a.velocity[i] + b.velocity[i], 0);
  }
});

test('Kepler elements preserve the periapsis, apoapsis and inclined orbital plane', () => {
  const a = 7e6;
  const mu = 3.986004418e14;
  const e = 0.4;
  const elements = { semimajorAxis: a, gravitationalParameter: mu, eccentricity: e, inclination: Math.PI / 2 };
  const halfPeriod = (Math.PI * a) / Math.sqrt(mu / a);
  const start = keplerState(elements);
  const half = keplerState(elements, halfPeriod);
  tolerance(start.position[0], a * (1 - e), 8 * a * Number.EPSILON);
  tolerance(half.position[0], -a * (1 + e), 8 * a * Number.EPSILON);
  for (const result of [start, half]) {
    const radius = Math.hypot(...result.position);
    const speed = Math.hypot(...result.velocity);
    tolerance((speed * speed) / 2 - mu / radius, -mu / (2 * a), (16 * mu * Number.EPSILON) / a);
    tolerance(result.position[1], 0, 8 * a * Number.EPSILON);
  }
  assert.ok(start.velocity[2] > 0);
  assert.throws(() => keplerState({ ...elements, eccentricity: 1 }), /choose a bound orbit/);
});

test('the primary quadrupole yields the independently derived equatorial orbital frequency', async () => {
  const r = 2;
  const radius = 1;
  const j2 = 0.1;
  const omega = Math.sqrt((1 + 1.5 * j2 * (radius / r) ** 2) / (r * r * r));
  const { orbit, world } = await make({
    bodies: [
      { position: [0, 0, 0], mass: 1 },
      { position: [r, 0, 0], velocity: [0, r * omega, 0] },
    ],
    primary: { body: 0, radius, j2 },
    gravitationalConstant: 1,
  });
  world.advance(60);
  const sample = orbit.sample(1);
  const error = 4 * r * (omega / 60) ** 4;
  tolerance(sample.position[0], r * Math.cos(omega), error);
  tolerance(sample.position[1], r * Math.sin(omega), error);
});

test('drag matches the exact differential equation at constant density and reduces relative speed', async () => {
  const speed = 10;
  const density = 1;
  const areaPerMass = 0.5;
  const { orbit, world } = await make({
    bodies: [
      { position: [0, 0, 0], mass: 1 },
      { position: [10, 0, 0], velocity: [-speed, 0, 0], dragAreaPerMass: areaPerMass },
    ],
    primary: { body: 0, radius: 10, density },
    gravitationalConstant: 0,
  });
  world.advance(1);
  const exact = -speed / (1 + (0.5 * density * areaPerMass * speed) / 60);
  const sample = orbit.sample(1);
  tolerance(sample.velocity[0], exact, 16 * speed * Number.EPSILON);
  assert.ok(sample.position[0] < 10);
  assert.ok(-sample.velocity[0] < speed);
});

test('failed force evaluation leaves the prior orbital state and clock intact', async () => {
  const { world, orbit } = await make({ bodies: [{ position: [0, 0, 0], mass: 1 }, { position: [0, 0, 0] }] });
  const saved = orbit.sample(1);
  assert.throws(() => world.advance(1), /reduce time scale or set softening/);
  assert.deepEqual(orbit.sample(1), saved);
  assert.equal(orbit.elapsedSeconds, 0);
});

test('the optional kernel honors a cancelled load', async () => {
  const signal = AbortSignal.abort(new Error('cancelled load'));
  await assert.rejects(OrbitSolver.load({ signal }), (error) => error === signal.reason);
});

test('EVENTHORIZON-1 and EVENTHORIZON-3: Kepler tracers orbit, shear and advect inward', () => {
  const body = { gravitationalParameter: 1 };
  const inner = keplerDiskSample({ ...body, radius: 4 }, 4);
  const outer = keplerDiskSample({ ...body, radius: 16 }, 4);
  assert.notDeepEqual(inner.position, [4, 0, 0]);
  tolerance(inner.azimuth / outer.azimuth, 8, 16 * Number.EPSILON);
  const radialVelocity = -0.02;
  const drifting = keplerDiskSample({ ...body, radius: 4, radialVelocity }, 4);
  tolerance(drifting.radius, 3.92, 8 * Number.EPSILON);
  assert.ok(drifting.azimuth > inner.azimuth);
  const recovered = keplerDiskSample(
    { ...body, radius: drifting.radius, azimuth: drifting.azimuth, radialVelocity },
    -4,
  );
  tolerance(recovered.radius, 4, 8 * Number.EPSILON);
  tolerance(recovered.azimuth, 0, 8 * Number.EPSILON);
});
