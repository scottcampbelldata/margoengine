// node scripts/run-with-timeout.mjs --max=3 -- node packages/physics/scripts/sea06-draehne-runup.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TsunamiSolver } from '../dist/tsunami.js';
import { PhysicsWorld } from '../dist/world.js';

const wave = process.argv[2] ?? 'T30_H2';
const bed = process.argv[3] ?? 'inviscid';
assert.ok(bed === 'inviscid' || bed === 'laminar', 'Choose inviscid or laminar.');
// Drähne et al. §2.3 uses the nominal freshwater viscosity at 20 °C for its Reynolds scaling.
const laminarBed = bed === 'laminar' ? { kinematicViscosity: 1e-6, period: wave === 'T20_H2' ? 20 : 30 } : undefined;
assert.ok(wave === 'T20_H2' || wave === 'T30_H2', 'Choose T20_H2 or T30_H2.');
const fixture = new URL(`../tests/fixtures/sea06-draehne-${wave.toLowerCase().replace('_', '')}.json`, import.meta.url);
const { secondsPerSample, scoreIntervalSeconds, runs } = JSON.parse(readFileSync(fixture, 'utf8'));
const [start, end] = scoreIntervalSeconds;
const ticksPerSecond = 60;
const rate = { num: ticksPerSecond, den: 1 };
const gravity = [0, -9.81, 0];
const origin = [-4.28, 0];
const length = 32;
const stillDepth = 0.3;
const slope = 1 / 40;
const gaugeLocations = [18.16, 12];
const cameraAccuracy = 0.005;
const cameraTape = 0.1;
const dryDepth = 1e-8; // Drähne et al. §2.4.
const gridSpacings = [0.04, 0.02];
const ticksPerSample = ticksPerSecond * secondsPerSample;

function boundary(run, time) {
  const knot = Math.min(time / secondsPerSample, run.etaMicrometres.length - 1);
  const low = Math.floor(knot);
  const high = Math.ceil(knot);
  const mix = (series) => (series[low] + (series[high] - series[low]) * (knot - low)) * 1e-6;
  return { surface: mix(run.etaMicrometres), outwardVelocity: mix(run.outwardVelocityMicrometresPerSecond) };
}

function gaugeSurface(solver, spacing, x) {
  const at = (x - origin[0]) / spacing - 0.5;
  const low = Math.floor(at);
  const fraction = at - low;
  const left = solver.sample(low, 0).height;
  return left + fraction * (solver.sample(low + 1, 0).height - left);
}

function shorelinePosition(solver, spacing) {
  const coast = Math.ceil(-origin[0] / spacing);
  for (let i = 0; i < coast; i++) {
    if (solver.sample(i, 0).depth > dryDepth) return -(origin[0] + (i + 0.5) * spacing);
  }
  return 0; // Before positive run-up the shoreline is at or seaward of x=0.
}

function compileGaugeReceipt(series, observed, gauge) {
  let squaredError = 0;
  let measuredCrest = { height: -Infinity };
  let modeledCrest = { height: -Infinity };
  for (let i = 0; i < series.length; i++) {
    const measured = observed[i][gauge] * 1e-6;
    const modeled = series[i];
    const time = i * secondsPerSample;
    squaredError += (modeled - measured) ** 2;
    if (measured > measuredCrest.height) measuredCrest = { height: measured, time };
    if (modeled > modeledCrest.height) modeledCrest = { height: modeled, time };
  }
  return {
    x: gaugeLocations[gauge],
    samples: series.length,
    rmse: Math.sqrt(squaredError / series.length),
    measuredCrest,
    modeledCrest,
  };
}

async function measure(run, spacing) {
  const cells = [length / spacing, 1];
  const bathymetry = Array.from({ length: cells[0] }, (_, i) => {
    const x = origin[0] + (i + 0.5) * spacing;
    return Math.max(-stillDepth, -slope * x);
  });
  const solver = await TsunamiSolver.load();
  const world = new PhysicsWorld({ rate, gravity });
  world.add(solver, {
    cells,
    spacing,
    origin,
    bathymetry,
    dryDepth,
    laminarBed,
    open: [false, true, false, false],
    incoming: [undefined, (time) => boundary(run, time), undefined, undefined],
  });
  const observed = run.holdoutShorelineSecondsMetres
    .filter(([, position]) => position !== null)
    .reduce((farthest, sample) => (sample[1] > farthest[1] ? sample : farthest));
  // The camera reports tape crossings rather than the continuous turning point.
  // §2.2 gives 0.1 m tape intervals and ±5 mm readout error. §2.4 bounds a
  // cell-centred wet/dry front by one grid cell.
  const minimum = (observed[1] - cameraAccuracy - spacing) * slope;
  const maximum = (observed[1] + cameraTape + cameraAccuracy + spacing) * slope;
  let modeledRunup = 0;
  let modeledRunupTime = start;
  let maxVolumeResidualPerWidth = 0;
  let maxBoundaryImportPerWidth = 0;
  const gaugeHeights = gaugeLocations.map(() => []);
  for (let tick = 0; tick <= end * ticksPerSecond; tick++) {
    world.advance(tick);
    if (tick % ticksPerSample === 0) {
      for (let i = 0; i < gaugeLocations.length; i++) {
        gaugeHeights[i].push(gaugeSurface(solver, spacing, gaugeLocations[i]));
      }
    }
    if (tick >= start * ticksPerSecond) {
      const runup = slope * shorelinePosition(solver, spacing);
      if (runup > modeledRunup) {
        modeledRunup = runup;
        modeledRunupTime = tick / ticksPerSecond;
      }
    }
    const budget = solver.budget;
    const residual =
      budget.storedVolume - budget.initialVolume - budget.admittedSourceVolume + budget.boundaryExportVolume;
    const roundoff =
      64 * Math.max(1, tick) * Number.EPSILON * (budget.initialVolume + Math.abs(budget.boundaryExportVolume));
    assert.ok(Math.abs(residual) <= roundoff, `Flume volume residual at tick ${tick}: ${residual}.`);
    maxVolumeResidualPerWidth = Math.max(maxVolumeResidualPerWidth, Math.abs(residual) / spacing);
    maxBoundaryImportPerWidth = Math.max(maxBoundaryImportPerWidth, -budget.boundaryExportVolume / spacing);
  }
  assert.equal(gaugeHeights[0].length, run.holdoutGaugeMicrometres.length);
  return {
    measuredLastTapeHeight: observed[1] * slope,
    measuredLastTapeTime: observed[0],
    measuredRunupBandWithCellError: [minimum, maximum],
    modeledRunup,
    modeledRunupTime,
    runupPass: minimum <= modeledRunup && modeledRunup <= maximum,
    maxVolumeResidualPerWidth,
    maxBoundaryImportPerWidth,
    gauges: gaugeHeights.map((series, i) => compileGaugeReceipt(series, run.holdoutGaugeMicrometres, i)),
  };
}

const report = [];
for (const spacing of gridSpacings) {
  for (let i = 0; i < runs.length; i++) {
    const results = await measure(runs[i], spacing);
    const entry = { wave, bed, spacing, run: i + 1, ...results };
    report.push(entry);
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}
assert.ok(
  report.every(({ runupPass }) => runupPass),
  'One or more paired runs missed the independent camera band.',
);
