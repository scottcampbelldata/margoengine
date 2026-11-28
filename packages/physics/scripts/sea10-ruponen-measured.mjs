// Run after building Physics: node packages/physics/scripts/sea10-ruponen-measured.mjs
// Use --early for the 20 s side-damage window and optionally --rate=20 to run one step size.
// --through=1 runs the short opening/near-dry receipt without the measured windows.
// --check-warnings repeats the live first second and checks the accepted convergence warning and dry stairs.
// Pekka Ruponen (2007), Progressive flooding of a damaged passenger ship, TKK Dissertations 94, ch. 5, Case A.
// https://urn.fi/urn:nbn:fi:tkk-010597
// Aalto PDF SHA-256 06e86b6039149248018926c0f6716fd0f727362cd546b06abe8334c70105cc58.
// Ruponen, Sundell and Larmela (2007), Validation of a simulation method for progressive flooding, ISP 54(4).
// https://doi.org/10.3233/SHP-2007-isp032
import assert from 'node:assert/strict';
import { COMPARTMENT_WORDS, Flooding } from '../dist/seakeeping.js';

const rho = 1000;
const gravity = 9.81;
const length = 4;
const beam = 0.8;
const draft = 0.5;
const volume = 1.45;
const kg = 0.278;
const gm = 0.11;
const sea = { elevation: () => 0 };
const initialPose = { position: [0, -draft, 0], rotation: [0, 0, 0, 1] };

// Distances in metres. Model coordinates have x forward from midships, y up from keel and z toward port.
// Compartment traces in dissertation Fig. 5.2, the 10 mm plates of §5.2.2 and the 335 mm clear lengths
// in the journal Table 1 define the boxes. Clear floor/ceiling elevations are reconstructed from the
// deck and opening midplanes. Transverse bulkheads are at z=±0.235 m per Dankowski (2013), Table 4.3.
// https://tore.tuhh.de/dspace-cris-server/api/core/bitstreams/1396f96c-04c7-4b75-a6eb-41433e3d0dbf/content
const room = {
  R21S: [
    [0.505, 0.15, -0.39],
    [0.84, 0.45, -0.24],
  ],
  R21: [
    [0.505, 0.15, -0.23],
    [0.84, 0.45, 0.23],
  ],
  R21P: [
    [0.505, 0.15, 0.24],
    [0.84, 0.45, 0.39],
  ],
  R11: [
    [0.16, 0.15, -0.39],
    [0.495, 0.45, 0.39],
  ],
  R22: [
    [0.505, 0.46, -0.39],
    [0.84, 0.79, 0.39],
  ],
  R12: [
    [0.16, 0.46, -0.39],
    [0.495, 0.79, 0.39],
  ],
};
const names = Object.keys(room);

function cuboid([x, y, z], [X, Y, Z]) {
  return {
    vertices: [x, y, z, X, y, z, X, Y, z, x, Y, z, x, y, Z, X, y, Z, X, Y, Z, x, Y, Z],
    indices: [
      0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
  };
}

function network() {
  const widthAtArea = (diameter) => Math.sqrt(Math.PI / 4) * diameter;
  const vent = widthAtArea(0.007);
  const pipe = widthAtArea(0.02);
  // Width and height are Table 4.3 where compatible with the primary article. Use the experiment's
  // independently drained Cd values and its stated 185 mm breach submergence (journal §4.3).
  // The DB2 manhole and the upper transverse door are shut for Test06. Pipe squares preserve area.
  const openings = [
    ['R21S', 'outside', [0.6725, draft - 0.185, -0.395], [0, 0, -1], 0.04, 0.06, 0.78],
    ['R21S', 'R21', [0.6725, 0.265, -0.235], [0, 0, 1], 0.02, 0.2, 0.75],
    ['R21', 'R21P', [0.6725, 0.265, 0.235], [0, 0, 1], 0.02, 0.2, 0.75],
    ['R21', 'R11', [0.5, 0.305, 0], [-1, 0, 0], pipe, pipe, 0.8],
    ['R21', 'R22', [0.74, 0.455, -0.18], [0, 1, 0], 0.1, 0.1, 0.72],
    ['R11', 'R12', [0.395, 0.455, -0.18], [0, 1, 0], 0.1, 0.1, 0.72],
    // The small pipes connect the side-room roof air to atmosphere. Their 0.67 coefficient is the
    // dissertation's Darcy estimate. The opening approximation omits water storage/lift in these pipes.
    ['R21S', 'outside', [0.6725, 0.8, -0.315], [0, 1, 0], vent, vent, 0.67],
    ['R21P', 'outside', [0.6725, 0.8, 0.315], [0, 1, 0], vent, vent, 0.67],
    ['R22', 'outside', [0.6725, 0.8, 0], [0, 1, 0], 0.1, 0.1, 0.72],
    ['R12', 'outside', [0.3275, 0.8, 0], [0, 1, 0], 0.1, 0.1, 0.72],
  ].map(([from, to, centre, normal, width, height, discharge]) => ({
    from: names.indexOf(from),
    to: to === 'outside' ? to : names.indexOf(to),
    centre,
    normal,
    width,
    height,
    discharge,
  }));
  return new Flooding(
    names.map((name) => ({ mesh: cuboid(...room[name]), permeability: 1 })),
    openings,
  );
}

function floatingPose(result) {
  // Small-angle equilibrium of the rectangular waterplane, driven solely by accepted floodwater
  // mass and its computed centroid. The intact transverse righting stiffness is rho g volume GM.
  // Both trim and roll use the same KB−KG inferred from the intact transverse GM and waterplane.
  // No measured motion history, water level, event time or discharge law is fitted to the holdout.
  const rollMoment = result.mass.reduce((sum, mass, i) => sum + (mass / rho) * result.centre[3 * i + 2], 0);
  const trimMoment = result.mass.reduce((sum, mass, i) => sum + (mass / rho) * result.centre[3 * i], 0);
  const sinkage = result.mass.reduce((sum, mass) => sum + mass / rho, 0) / (length * beam);
  const kb = kg + gm - (length * beam ** 3) / (12 * volume);
  const roll = rollMoment / (volume * gm);
  const trim = -trimMoment / ((beam * length ** 3) / 12 + volume * (kb - kg));
  const [sr, cr, sp, cp] = [Math.sin(roll / 2), Math.cos(roll / 2), Math.sin(trim / 2), Math.cos(trim / 2)];
  return { position: [0, -draft - sinkage, 0], rotation: [sr * cp, sr * sp, cr * sp, cr * cp] };
}

// Only readings from the measured vector paths of Ruponen (2007), Figs. 5.8–5.10.
// Each row is room, elapsed seconds, center mm, min/max in a fixed ±0.5 s window around that time.
// Positions within the plotting window reflect real local fluctuations; the paper does not give
// Test06 repeat trials or per-probe calibration. Saturated lower-deck plateaux are omitted.
const observations = [
  ['R21P', 5, 55.2, 42.8, 57.0],
  ['R21P', 10, 139.5, 128.5, 149.2],
  ['R21P', 20, 229.6, 227.0, 233.8],
  ['R21S', 5, 76.0, 68.6, 79.9],
  ['R21S', 10, 154.6, 139.3, 158.6],
  ['R21S', 20, 220.4, 219.2, 230.6],
  ['R21', 10, 151.5, 148.0, 155.8],
  ['R21', 20, 265.6, 261.8, 273.9],
  ['R11', 60, 77.3, 76.1, 78.8],
  ['R11', 120, 187.9, 185.5, 192.9],
  ['R22', 60, 67.5, 66.7, 67.8],
  ['R22', 120, 81.3, 78.3, 86.0],
  ['R22', 240, 104.0, 103.7, 108.9],
  ['R12', 240, 48.2, 47.4, 49.7],
  ['R12', 300, 88.5, 85.9, 89.1],
];

function gauge(result, pose, name) {
  const [[x0, y, z0], [x1, , z1]] = room[name];
  const [qx, qy, qz, qw] = pose.rotation;
  const ux = 2 * (qx * qy + qz * qw);
  const uy = 1 - 2 * (qx * qx + qz * qz);
  const uz = 2 * (qy * qz - qx * qw);
  const level = result.level[names.indexOf(name)];
  const height = (x, z) => (1000 * Math.max(0, level - pose.position[1] - ux * x - uy * y - uz * z)) / uy;
  // Exact Test06 probes' positions were only published in the unavailable M-292 report. Use the
  // assumed center-floor probe for the estimate and bracket its lateral position by all floor corners.
  return {
    center: height((x0 + x1) / 2, (z0 + z1) / 2),
    corners: [height(x0, z0), height(x0, z1), height(x1, z0), height(x1, z1)],
  };
}

function run(rate, through) {
  const flooding = network();
  const state = new Float64Array(flooding.words);
  flooding.initialise(state);
  const ends = Array.from({ length: flooding.openingCount }, (_, k) => flooding.ends(k));
  let pose = initialPose;
  const samples = new Map();
  const dt = 1 / rate;
  const maximumSweeps = [0, 0];
  const cappedSteps = [0, 0];
  const maxBalanceError = [0, 0];
  const initialStairFlowsM3s = [];
  let firstWarning;
  const sampleTimes = new Set(observations.map(([, time]) => time));
  for (let step = 1; step <= through * rate; step++) {
    const previous = state.slice();
    const result = flooding.step(state, pose, sea, (step - 0.5) * dt, dt, rho, gravity);
    if (step === 1) {
      for (const [k, [, to]] of ends.entries()) {
        if (to === names.indexOf('R22') || to === names.indexOf('R12')) initialStairFlowsM3s.push(result.water[k]);
      }
    }
    for (let j = 0; j < 2; j++) {
      maximumSweeps[j] = Math.max(maximumSweeps[j], result.sweeps[j]);
      if (result.sweeps[j] >= 200) cappedSteps[j]++;
    }
    const warning = flooding.convergenceWarning;
    assert.equal(
      Boolean(warning),
      result.sweeps.some((sweeps) => sweeps >= 200),
    );
    if (warning && !firstWarning) {
      assert.equal(warning.name, 'MargoError');
      assert.equal(warning.code, 'failed');
      assert.match(warning.message, /Reduce the step.*flow and mass balance.*errors#hull-flooding/);
      firstWarning = { step, code: warning.code, message: warning.message };
    }
    for (const [phase, flow] of [result.water, result.air].entries()) {
      const net = new Float64Array(names.length);
      for (const [k, [from, to]] of ends.entries()) {
        net[from] -= flow[k];
        if (to >= 0) net[to] += flow[k];
      }
      for (let i = 0; i < names.length; i++) {
        const index = i * COMPARTMENT_WORDS + phase;
        maxBalanceError[phase] = Math.max(
          maxBalanceError[phase],
          Math.abs(state[index] - previous[index] - dt * net[i]),
        );
      }
    }
    const time = step / rate;
    if (sampleTimes.has(time)) {
      samples.set(time, Object.fromEntries(names.map((name) => [name, gauge(result, pose, name)])));
    }
    pose = floatingPose(result);
    assert.ok(pose.rotation.every(Number.isFinite), 'Expected a finite quasi-static pose.');
  }
  return { rate, samples, maximumSweeps, cappedSteps, maxBalanceError, initialStairFlowsM3s, firstWarning };
}

const checkWarnings = process.argv.includes('--check-warnings');
const through = process.argv.includes('--early') ? 20 : 300;
const chosenEnd = process.argv.find((argument) => argument.startsWith('--through='));
const stop = checkWarnings ? 1 : chosenEnd ? Number(chosenEnd.slice('--through='.length)) : through;
const chosenRate = process.argv.find((argument) => argument.startsWith('--rate='));
const rates = checkWarnings ? [5] : chosenRate ? [Number(chosenRate.slice('--rate='.length))] : [5, 10, 20];
assert.ok(
  rates.every((rate) => [5, 10, 20, 40, 80].includes(rate)),
  'Use rate 5, 10, 20, 40 or 80 Hz.',
);
assert.ok(Number.isInteger(stop) && stop > 0 && stop <= 300, 'Use an integer --through time from 1 to 300 seconds.');
const runs = rates.map((rate) => {
  const result = run(rate, stop);
  if (checkWarnings) {
    assert.deepEqual(result.initialStairFlowsM3s, [0, 0]);
    assert.deepEqual(run(rate, stop), result);
  }
  const { maximumSweeps, cappedSteps, maxBalanceError, initialStairFlowsM3s, firstWarning } = result;
  const [maxWaterBalanceErrorM3, maxAirBalanceErrorKg] = maxBalanceError;
  console.log(
    JSON.stringify({
      through: stop,
      rate,
      maximumSweeps,
      cappedSteps,
      maxWaterBalanceErrorM3,
      maxAirBalanceErrorKg,
      initialStairFlowsM3s,
      firstWarning,
    }),
  );
  return result;
});

for (const [name, time, observed, low, high] of observations) {
  if (time > stop) continue;
  const predictions = runs.map(({ samples }) => samples.get(time)[name]);
  const fine = predictions.at(-1);
  const stepAllowance =
    predictions.length === 3
      ? Math.max(Math.abs(fine.center - predictions[1].center), Math.abs(predictions[1].center - predictions[0].center))
      : null;
  // One PDF point on the steepest plotted 350 mm axis is 1.7 mm. Allow 2 mm in addition to local
  // observed variation. This interval describes the published plot, not instrument confidence.
  const band = [low - 2, high + 2];
  const error = stepAllowance ?? 0;
  const predictionRange = [Math.min(...fine.corners) - error, Math.max(...fine.corners) + error];
  console.log(
    JSON.stringify({
      name,
      time,
      observed,
      predicted: fine.center,
      residual: fine.center - observed,
      stepAllowance,
      observedRangeMM: band,
      predictionRangeMM: predictionRange,
      overlaps: predictionRange[0] <= band[1] && band[0] <= predictionRange[1],
      resolvedAtObservedScale: stepAllowance === null ? null : stepAllowance <= (band[1] - band[0]) / 2,
    }),
  );
}
