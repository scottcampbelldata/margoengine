// node scripts/run-with-timeout.mjs --max=3 -- node packages/physics/scripts/sea06-canonical-beach.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TsunamiSolver } from '../dist/tsunami.js';
import { PhysicsWorld } from '../dist/world.js';

const fixture = new URL('../tests/fixtures/sea06-canonical-beach.json', import.meta.url);
const observations = JSON.parse(readFileSync(fixture, 'utf8'));
const ticksPerUnitTime = 60;
const rate = { num: ticksPerUnitTime, den: 1 };
const origin = [-20, 0];
const offshoreEdge = 100;
const toe = 19.85;
const grids = [0.125, 0.0625, 0.03125];

function bed(x) {
  return -Math.min(1, x / toe);
}

async function releaseSolitaryWave(amplitude, spacing) {
  // Synolakis (1987) §5.2 and Kristina et al. (2014) §5.1 fix the first launch position.
  // The second uses NOAA's rule that the height at the toe is 5% of the offshore crest.
  const inverseWidth = Math.sqrt((3 * amplitude) / 4);
  const centre = amplitude === 0.0185 ? 37.35 : toe + Math.acosh(Math.sqrt(20)) / inverseWidth;
  const speed = Math.sqrt(1 + amplitude);
  const nx = (offshoreEdge - origin[0]) / spacing;
  const centres = Array.from({ length: nx }, (_, i) => origin[0] + (i + 0.5) * spacing);
  const bathymetry = centres.map(bed);
  const surface = centres.map((x) => amplitude / Math.cosh(inverseWidth * (x - centre)) ** 2);
  // Translating offshore soliton satisfies h*u = -c*eta by continuity. Extend this
  // same velocity through the small tail at the toe using actual local wet depth.
  const dischargeX = surface.map((eta, i) => ((-speed * eta) / (1 + eta)) * Math.max(0, eta - bathymetry[i]));
  const solver = await TsunamiSolver.load();
  const world = new PhysicsWorld({ rate, gravity: [0, -1, 0] });
  world.add(solver, { cells: [nx, 1], spacing, origin, bathymetry, surface, dischargeX });
  return { solver, world, centre };
}

function compareProfile(solver, points, spacing) {
  let squaredError = 0;
  let belowBed = 0;
  let worst;
  let observedCrest;
  let modeledCrest;
  for (const [x, measured] of points) {
    const at = (x - origin[0]) / spacing - 0.5;
    const left = Math.floor(at);
    const fraction = at - left;
    const low = solver.sample(left, 0).depth;
    const high = solver.sample(left + 1, 0).depth;
    const bottom = bed(x);
    // Exact bathymetry + interpolated depth. Zero depth reports the dry bed,
    // with a separate flag in each worst-point record if it is not a surface.
    const depth = (1 - fraction) * low + fraction * high;
    const predicted = bottom + depth;
    const error = predicted - measured;
    squaredError += error ** 2;
    belowBed += Number(measured < bottom);
    if (worst === undefined || Math.abs(error) > Math.abs(worst.error)) {
      worst = { x, measured, predicted, depth, error, measuredBelowBed: measured < bottom };
    }
    if (observedCrest === undefined || measured > observedCrest.height) observedCrest = { x, height: measured };
    if (depth > 0 && (modeledCrest === undefined || predicted > modeledCrest.height)) {
      modeledCrest = { x, height: predicted };
    }
  }
  return {
    samples: points.length,
    rmse: Math.sqrt(squaredError / points.length),
    belowBed,
    observedCrest,
    modeledCrest,
    worst,
  };
}

const output = [];
for (const [height, { url, profiles }] of Object.entries(observations)) {
  const amplitude = Number(height);
  for (const spacing of grids) {
    const { solver, world, centre } = await releaseSolitaryWave(amplitude, spacing);
    const snapshots = [];
    for (const { time, points } of profiles) {
      world.advance(time * ticksPerUnitTime);
      const budget = solver.budget;
      const closedVolumePerWidth = (budget.storedVolume - budget.initialVolume) / spacing;
      const roundoff = (64 * time * ticksPerUnitTime * Number.EPSILON * budget.initialVolume) / spacing;
      assert.ok(Math.abs(closedVolumePerWidth) <= roundoff, `Closed-flume volume drift at t=${time}.`);
      snapshots.push({
        time,
        ...compareProfile(solver, points, spacing),
        closedVolumePerWidth,
        sampledRunup: budget.runup,
      });
    }
    output.push({ amplitude, url, centre, spacing, snapshots });
  }
}

// Report measurements and misses without treating a successful run as a scientific pass.
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
