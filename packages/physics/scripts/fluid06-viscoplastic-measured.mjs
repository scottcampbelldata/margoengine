// Huang & García (1998), J. Fluid Mech. 374, 305–333, §4.5, Table 2 and Fig. 16,
// https://doi.org/10.1017/S0022112098002845. The independently measured front
// comes from their experimental series in Parvin et al. (2024), Fig. 3 left.
// Reproduce after building Physics:
// node packages/physics/scripts/fluid06-viscoplastic-measured.mjs [spacingMetres ...]
// Default: 25 mm and 20 mm. For a finer control, pass 0.02 0.01 explicitly.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ViscoplasticSolver } from '../dist/viscoplastic.js';
import { PhysicsWorld } from '../dist/world.js';

const fixture = await readFile(new URL('./fixtures/fluid06-huang-garcia-1998.json', import.meta.url), 'utf8');
const { source, inputs, observations } = JSON.parse(fixture);
const artifacts = ['viscoplastic.js', 'viscoplastic-kernel.wasm'];
const artifactHashes = Object.fromEntries(
  await Promise.all(
    artifacts.map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(new URL(`../dist/${name}`, import.meta.url)))
        .digest('hex'),
    ]),
  ),
);
const rate = { num: 60, den: 1 };
const gravity = 9.81;
const slope = (inputs.slopeDegrees * Math.PI) / 180;
const totalM3 = inputs.initialCrossSectionM2 * inputs.tankWidthM;
const markers = observations.timeSecondsAndFrontMetres;
const friction = 0.25; // Existing solver default; laboratory wall contact was not calibrated.

function initialPoints(dx) {
  // The lab's retained fluid is at rest before a sudden gate pull. In coordinates
  // aligned with the tank, the horizontal free surface gains tan(slope)·dx.
  // Deposit midpoint quadrature in x/z and volume-weighted partial top bands in y.
  const pitch = dx / 2;
  const nx = Math.ceil(inputs.reservoirLengthM / pitch);
  const nz = Math.ceil(inputs.tankWidthM / pitch);
  const width = inputs.reservoirLengthM / nx;
  const depth = inputs.tankWidthM / nz;
  const meanHeight = inputs.initialCrossSectionM2 / inputs.reservoirLengthM;
  const points = [];
  for (let i = 0; i < nx; i++) {
    const x = (i + 0.5) * width;
    const height = meanHeight + Math.tan(slope) * (x - inputs.reservoirLengthM / 2);
    for (let k = 0; k < nz; k++) {
      const z = (k + 0.5) * depth;
      for (let lo = 0; lo < height; lo += pitch) {
        const span = Math.min(height - lo, pitch);
        points.push({
          position: [x, lo + span / 2, z],
          volume: width * span * depth,
        });
      }
    }
  }
  assert.ok(Math.abs(points.reduce((sum, point) => sum + point.volume, 0) - totalM3) <= 1e-12 * totalM3);
  return points;
}

function measureFront(solver, count) {
  let front = -Infinity;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const sample = solver.sample(i);
    if (sample.present) {
      front = Math.max(front, sample.position[0]);
      height = Math.max(height, sample.position[1]);
    }
  }
  assert.ok(Number.isFinite(front), 'The release must keep a measurable material front.');
  return { front, height };
}

function score(marker, index, actual, sampleTime, dx) {
  const [seconds, expected] = marker;
  const first = markers[Math.max(0, index - 1)];
  const last = markers[Math.min(index + 1, markers.length - 1)];
  const leftSpeed = index > 0 ? (expected - first[1]) / (seconds - first[0]) : 0;
  const rightSpeed = index < markers.length - 1 ? (last[1] - expected) / (last[0] - seconds) : 0;
  const speed = Math.max(Math.abs(leftSpeed), Math.abs(rightSpeed));
  const digits = source.calibrationPixels;
  const digitX = digits.markerCenterRadiusPixels / (digits.xMetresZeroToOne[1] - digits.xMetresZeroToOne[0]);
  const digitTime =
    (2 * digits.markerCenterRadiusPixels) / (digits.timeSecondsZeroToTwo[0] - digits.timeSecondsZeroToTwo[1]);
  // Conservative linear sum of half the physical grid, half the camera frame, the
  // digitisation precision, and the known sample-to-observation time displacement.
  // This is a resolution envelope, as the paper does not give camera error bars.
  const observationEnvelope =
    observations.bottomGridM / 2 +
    digitX +
    speed * (0.5 / observations.frameRateHz + digitTime + Math.abs(sampleTime - seconds));
  const error = actual - expected;
  const allowance = observationEnvelope + dx;
  return {
    seconds,
    sampleTime,
    expected,
    actual,
    error,
    observationEnvelope,
    allowance,
    within: Math.abs(error) <= allowance,
  };
}

async function run(dx) {
  const sx = inputs.tankLengthM / dx;
  const sz = inputs.tankWidthM / dx;
  assert.ok(
    dx > 0 && Math.abs(sx - Math.round(sx)) < 1e-9 && Math.abs(sz - Math.round(sz)) < 1e-9,
    'Choose a positive spacing that evenly divides the measured tank length and width.',
  );
  const points = initialPoints(dx);
  const mud = await ViscoplasticSolver.load();
  const world = new PhysicsWorld({
    rate,
    gravity: [gravity * Math.sin(slope), -gravity * Math.cos(slope), 0],
  });
  // Use an open top above the taller end. There is no inflow or floor terrain, and
  // the model uses one Coulomb coefficient rather than a measured no-slip wall law.
  world.add(mud, {
    cells: [Math.round(sx), Math.ceil(inputs.downstreamWallHeightM / dx), Math.round(sz)],
    spacing: dx,
    points,
    walls: [true, true, true, false, true, true],
    friction,
    density: inputs.densityKgM3,
    yieldStress: inputs.yieldStressPa,
    consistency: inputs.consistencyPaSN,
    exponent: inputs.exponent,
  });
  const rows = [];
  let highWaterM = 0;
  for (const [i, marker] of markers.entries()) {
    const frame = Math.round(rate.num * marker[0]);
    world.advance(frame);
    const measurement = measureFront(mud, points.length);
    highWaterM = Math.max(highWaterM, measurement.height);
    rows.push(score(marker, i, measurement.front, frame / rate.num, dx));
  }
  const { escapedReferenceVolume, storedReferenceVolume, storedVolume, activePoints } = mud.budget;
  assert.ok(
    Math.abs(storedReferenceVolume + escapedReferenceVolume - totalM3) <= 1e-12 * totalM3,
    'The released material must close its reference-volume ledger.',
  );
  return {
    spacingM: dx,
    points: points.length,
    activePoints,
    storedReferenceVolume,
    escapedReferenceVolume,
    storedVolume,
    highWaterM,
    meanAbsoluteErrorM: rows.reduce((sum, { error }) => sum + Math.abs(error), 0) / rows.length,
    maxAbsoluteErrorM: Math.max(...rows.map(({ error }) => Math.abs(error))),
    withinResolution: rows.filter(({ within }) => within).length,
    rows,
  };
}

const requested = process.argv.slice(2).map(Number);
const spacings = requested.length > 0 ? requested : [0.025, 0.02];
const runs = [];
for (const dx of spacings) {
  const result = await run(dx);
  runs.push(result);
}
const sameObservableRefinementM = runs
  .slice(1)
  .map(({ rows }, i) => Math.max(...rows.map(({ actual }, j) => Math.abs(actual - runs[i].rows[j].actual))));
console.log(
  JSON.stringify(
    {
      scenario: 'Huang & García 1998, kaolinite sudden release',
      artifacts: artifactHashes,
      modeledFriction: friction,
      expectedReferenceVolumeM3: totalM3,
      sameObservableRefinementM,
      runs,
    },
    null,
    2,
  ),
);
