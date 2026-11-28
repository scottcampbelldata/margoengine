// APOLLO October 2020 measured station-to-reflector round-trip times, with full
// provenance and archived geometry in the accompanying fixture. Run after
// building Physics: node packages/physics/scripts/space01-apollo-measured.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ORBIT_GRAVITATIONAL_CONSTANT, OrbitSolver } from '../dist/orbit.js';
import { PhysicsWorld } from '../dist/world.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/space01-apollo-2020.json', import.meta.url), 'utf8'));
const stateArtifact = await readFile(new URL('../dist/orbit.js', import.meta.url));
const wasmArtifact = await readFile(new URL('../dist/orbit-kernel.wasm', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rate = { num: 60, den: 1 };
const c = 299_792_458;
const geometryIntervalS = 4;
const earthIndex = fixture.initialJ2000.findIndex(({ bodyId }) => bodyId === 399);
const moonIndex = fixture.initialJ2000.findIndex(({ bodyId }) => bodyId === 301);
const bodies = fixture.initialJ2000.map(({ gmM3S2, state }) => ({
  position: state.slice(0, 3),
  velocity: state.slice(3),
  mass: gmM3S2 / ORBIT_GRAVITATIONAL_CONSTANT,
}));

const add = (p, q) => p.map((value, i) => value + q[i]);
const subtract = (p, q) => p.map((value, i) => value - q[i]);
const distance = (p, q) => Math.hypot(...subtract(p, q));
const sampled = ({ position, velocity }) => [...position, ...velocity];

function interpolate([a, b], dt, time) {
  const x = time / dt;
  assert.ok(x >= 0 && x <= 1, 'The evaluation must be bracketed by the retained states.');
  const x2 = x * x;
  const x3 = x2 * x;
  return [0, 1, 2].map(
    (i) => a[i] + (3 * x2 - 2 * x3) * (b[i] - a[i]) + dt * ((x3 - 2 * x2 + x) * a[i + 3] + (x3 - x2) * b[i + 3]),
  );
}

function geometricRoundTrip(earth, moon, observation) {
  const station = (seconds) =>
    add(earth(seconds), interpolate(observation.stationOffsetJ2000, geometryIntervalS, seconds));
  const reflector = (seconds) =>
    add(moon(seconds), interpolate(observation.reflectorOffsetJ2000, geometryIntervalS, seconds));
  const from = station(0);
  let bounce = distance(reflector(0), from) / c;
  for (let i = 0; i < 5; i++) bounce = distance(reflector(bounce), from) / c;
  const reflectedAt = reflector(bounce);
  let receive = 2 * bounce;
  for (let i = 0; i < 5; i++) receive = bounce + distance(reflectedAt, station(receive)) / c;
  const error = Math.abs(receive - bounce - distance(reflectedAt, station(receive)) / c);
  assert.ok(error <= 16 * Number.EPSILON * receive, 'The round-trip light-time iteration must settle.');
  return receive;
}

async function predict(stepS) {
  const orbit = await OrbitSolver.load();
  const world = new PhysicsWorld({ rate }).add(orbit, { bodies, timeScale: stepS * rate.num });
  return fixture.observations.map((observation) => {
    const { elapsedTdbS, earthCenterJ2000, moonCenterJ2000 } = observation;
    const lo = Math.floor(elapsedTdbS / stepS);
    const hi = Math.ceil((elapsedTdbS + geometryIntervalS) / stepS);
    world.advance(lo);
    const earthBefore = sampled(orbit.sample(earthIndex));
    const moonBefore = sampled(orbit.sample(moonIndex));
    world.advance(hi);
    const earthStates = [earthBefore, sampled(orbit.sample(earthIndex))];
    const moonStates = [moonBefore, sampled(orbit.sample(moonIndex))];
    const duration = (hi - lo) * stepS;
    const offset = elapsedTdbS - lo * stepS;
    const earth = (dt) => interpolate(earthStates, duration, offset + dt);
    const moon = (dt) => interpolate(moonStates, duration, offset + dt);
    const centreErrorM = distance(
      subtract(moon(0), earth(0)),
      subtract(moonCenterJ2000[0].slice(0, 3), earthCenterJ2000[0].slice(0, 3)),
    );
    return { geometricS: geometricRoundTrip(earth, moon, observation), centreErrorM };
  });
}

const coarse = await predict(1200);
const fine = await predict(600);
const results = fixture.observations.map((observation, i) => {
  const earth = (t) => interpolate(observation.earthCenterJ2000, geometryIntervalS, t);
  const moon = (t) => interpolate(observation.moonCenterJ2000, geometryIntervalS, t);
  const de440GeometricS = geometricRoundTrip(earth, moon, observation);
  const { geometricS, centreErrorM } = fine[i];
  const geometricResidualM = (geometricS - observation.roundTripS) * (c / 2);
  const de440ResidualM = (de440GeometricS - observation.roundTripS) * (c / 2);
  return {
    launchUtc: observation.launchUtc,
    archiveLine: observation.line,
    observedRoundTripS: observation.roundTripS,
    instrumentSigmaEquivalentM: observation.sigmaS * (c / 2),
    orbitGeometricRoundTripS: geometricS,
    orbitGeometricResidualM: geometricResidualM,
    de440GeometricRoundTripS: de440GeometricS,
    de440GeometricResidualM: de440ResidualM,
    orbitVersusDe440GeometryM: (geometricS - de440GeometricS) * (c / 2),
    orbitVersusDe440RelativeCentreM: centreErrorM,
    refinementM: Math.abs(geometricS - coarse[i].geometricS) * (c / 2),
  };
});

console.log(
  JSON.stringify(
    {
      observationalSource: fixture.archive,
      independence: fixture.fitNotes,
      selection: fixture.selection,
      initialStateSource: fixture.fitSource,
      initialUtc: fixture.initialUtc,
      method:
        'Eleven Newtonian point masses. Two vacuum light-time legs evaluated in the barycentric J2000 frame, moving station and Apollo 15 reflector. OrbitSolver evolves all centres. The same observable from DE440 centre vectors is reported separately.',
      qualifications:
        'This reports geometric residuals. The model omits atmospheric delay, relativistic propagation and station proper time, reflector/station tides, plate motion, Earth and lunar figures and asteroid forces. Instrument sigma is not a total-model uncertainty.',
      integrations: { coarseStepS: 1200, fineStepS: 600 },
      artifactSha256: { orbit: digest(stateArtifact), wasm: digest(wasmArtifact) },
      results,
    },
    null,
    2,
  ),
);
