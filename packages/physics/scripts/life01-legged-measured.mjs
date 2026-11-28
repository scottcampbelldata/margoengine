// Independent instrumented-treadmill comparison. Run from the repository root with
// node scripts/run-with-timeout.mjs --max=1 -- node packages/physics/scripts/life01-legged-measured.mjs
//
// A.I. Gmel, E.H. Haraldsdóttir, F.M. Serra Bragança, A.M. Cruz & M.A. Weishaupt (2024),
// Journal of Equine Veterinary Science 133, 105005, Tables 1, 2 and 4.
// https://doi.org/10.1016/j.jevs.2024.105005 (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/).
// Transcribed cohort inputs and measured means across all speeds, with published standard
// deviations. Each central run models the reported mean belt speed on level ground. This
// is a representative-body diagnostic. The source averages over different bodies and speeds,
// and provides no matching limb geometry for Warmbloods. Keep the same unrecalibrated
// engine-default body dimensions for both breeds. Withers height is not an effective leg length.
// The holdout observables and their standard deviations never enter the solver.

import assert from 'node:assert/strict';
import { LeggedLocomotion } from '../dist/legged.js';
import { PhysicsWorld } from '../dist/world.js';

const DEFAULT_LEG_METRES = 1.08;
const WARMUP_SECONDS = 10;
const MEASURE_SECONDS = 20; // Same per-speed interval as the instrumented test.
const COHORTS = [
  { group: 'Franches-Montagnes', horses: 24, mass: 526.3, withersMetres: 1.57 },
  { group: 'Warmblood', horses: 38, mass: 565, withersMetres: 1.68 },
];
const MEASUREMENTS = [
  {
    cohort: 0,
    gait: 'walk',
    speed: [1.73, 0.15],
    observed: {
      strideRate: [55.13, 3.64],
      foreDuty: [62.27, 1.36],
      hindDuty: [61.38, 1.14],
      foreImpulseShare: [59.26, 1.58],
    },
  },
  {
    cohort: 1,
    gait: 'walk',
    speed: [1.66, 0.18],
    observed: {
      strideRate: [51.46, 3.78],
      foreDuty: [62.85, 1.66],
      hindDuty: [62.57, 1.21],
      foreImpulseShare: [58.11, 1.17],
    },
  },
  {
    cohort: 0,
    gait: 'trot',
    speed: [4.35, 0.72],
    observed: {
      strideRate: [89.58, 6.12],
      foreDuty: [39.54, 3.05],
      hindDuty: [35.39, 2.04],
      foreImpulseShare: [56.27, 1.8],
    },
  },
  {
    cohort: 1,
    gait: 'trot',
    speed: [4.16, 0.58],
    observed: {
      strideRate: [82.44, 5.39],
      foreDuty: [38.79, 3.15],
      hindDuty: [35.29, 1.95],
      foreImpulseShare: [56.42, 1.1],
    },
  },
];

function atInput(measurement, speed, legLength = DEFAULT_LEG_METRES) {
  return {
    kind: 'quadruped',
    mass: COHORTS[measurement.cohort].mass,
    legLength,
    velocity: [0, 0, speed],
    target: { speed, heading: 0 },
  };
}

function read(solver, body) {
  const status = solver.read(body);
  const frontAndHind = Array.from({ length: 4 }, (_, foot) => solver.readContact(body, foot));
  return {
    gait: status.gait,
    fallen: status.fallen,
    forwardPosition: status.position[2],
    foreStance: Number(frontAndHind[0].stance) + Number(frontAndHind[1].stance),
    hindStance: Number(frontAndHind[2].stance) + Number(frontAndHind[3].stance),
    foreForce: frontAndHind[0].force[1] + frontAndHind[1].force[1],
    hindForce: frontAndHind[2].force[1] + frontAndHind[3].force[1],
    leftForeContact: frontAndHind[0].stance,
  };
}

function reduce(series, fps) {
  const leftForeOnsets = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i].leftForeContact && !series[i - 1].leftForeContact) leftForeOnsets.push(i);
  }
  assert.ok(leftForeOnsets.length >= 2, 'At least one complete left-fore stride is required.');
  const start = leftForeOnsets[0];
  const end = leftForeOnsets.at(-1);
  const window = series.slice(start, end); // Compare full intervals between accepted left-fore onsets.
  const duration = window.length / fps;
  let foreStance = 0;
  let hindStance = 0;
  let foreForce = 0;
  let hindForce = 0;
  for (const frame of window) {
    foreStance += frame.foreStance;
    hindStance += frame.hindStance;
    foreForce += frame.foreForce;
    hindForce += frame.hindForce;
  }
  assert.ok(foreForce + hindForce > 0, 'Scored strides need measured support reactions.');
  return {
    gaits: [...new Set(window.map((frame) => frame.gait))],
    fallen: window.some((frame) => frame.fallen),
    strideCount: leftForeOnsets.length - 1,
    reachedSpeed: (series[end].forwardPosition - series[start].forwardPosition) / duration,
    // Match the left-fore detection used to segment the experimental strides. The observed
    // lab timing uses hoof position. The model publishes planted phase, which can include
    // an unloaded foot; do not infer a force threshold the source did not supply.
    strideRate: (60 * (leftForeOnsets.length - 1)) / duration,
    foreDuty: (50 * foreStance) / window.length,
    hindDuty: (50 * hindStance) / window.length,
    foreImpulseShare: (100 * foreForce) / (foreForce + hindForce),
  };
}

async function run(bodies, fps) {
  const solver = await LeggedLocomotion.load();
  const world = new PhysicsWorld({ rate: { num: fps, den: 1 } }).add(solver, { bodies });
  for (const row of bodies.keys()) {
    const fore = solver.readContact(row, 0).position[2];
    const hind = solver.readContact(row, 2).position[2];
    assert.ok(fore > hind, 'The fore contact must be ahead of the hind contact in the +Z fixture.');
  }
  world.advance(WARMUP_SECONDS * fps);
  const samples = bodies.map((_, row) => [read(solver, row)]);
  for (let i = 1; i <= MEASURE_SECONDS * fps; i++) {
    world.advance(WARMUP_SECONDS * fps + i);
    for (const [row, series] of samples.entries()) series.push(read(solver, row));
  }
  return samples.map((series) => reduce(series, fps));
}

const cases = MEASUREMENTS.flatMap((measurement) => {
  const [speed, sd] = measurement.speed;
  return [
    atInput(measurement, speed),
    atInput(measurement, speed - sd),
    atInput(measurement, speed + sd),
    atInput(measurement, speed, DEFAULT_LEG_METRES * 0.9),
    atInput(measurement, speed, DEFAULT_LEG_METRES * 1.1),
  ];
});
const all = await run(cases, 60);
const dense = await run(
  MEASUREMENTS.map((measurement) => atInput(measurement, measurement.speed[0])),
  120,
);
for (const [index, measurement] of MEASUREMENTS.entries()) {
  const [base, slow, fast, short, long] = all.slice(index * 5, index * 5 + 5);
  const metrics = {};
  for (const [metric, [mean, sd]] of Object.entries(measurement.observed)) {
    metrics[metric] = {
      measuredMean: mean,
      measuredSD: sd, // Observed spread across the pooled cases, not instrument error or a test tolerance.
      solver: base[metric],
      solverMinusMeasured: base[metric] - mean,
      // Diagnostic for observation clock sensitivity, not a change in the kernel's own stable rate.
      outputClockDelta60To120Hz: dense[index][metric] - base[metric],
      atBeltSpeedMinusPlusSD: [slow[metric], fast[metric]],
      atLegLengthMinusPlus10Percent: [short[metric], long[metric]],
    };
  }
  console.log(
    JSON.stringify({
      ...COHORTS[measurement.cohort],
      measuredGait: measurement.gait,
      measuredSpeedMeanAndSD: measurement.speed,
      gaitSequence: [base, slow, fast, short, long].map((row) => row.gaits),
      torsoContactSequence: [base, slow, fast, short, long].map((row) => row.fallen),
      reachedSpeeds: [base, slow, fast, short, long].map((row) => row.reachedSpeed),
      resolvedStrides: base.strideCount,
      metrics,
    }),
  );
}
