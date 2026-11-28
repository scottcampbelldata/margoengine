// Run after building Physics: node packages/physics/scripts/life03-swim-measured.mjs
//
// Sparks, Rajeev, Koley, Canestrelli & Liao (2024), J. Exp. Biol. 227,
// jeb247873, https://doi.org/10.1242/jeb.247873. Table 1 freestream rows and
// Fig. 2 give measured gait and cohort length (five juvenile rainbow trout).
// Section "Fish swimming experimental conditions" reports 15 ± 1 °C and
// station holding relative to the three tunnel speeds. No cylinder or wake
// trials are used. Only the gait, length and water conditions enter the solve;
// the speeds are withheld. The stated setpoints have no reported speed
// confidence interval. This experiment postdates Sánchez-Rodríguez et al.
// (2023), https://doi.org/10.1038/s41467-023-41368-6. Their Table 2 uses
// Bainbridge (1958), Hunter & Zweifel (1971), and Videler & Hess (1984)
// as sources of ray-finned fish frequency and speed data.
//
// The Sparks cohort lacked mass, fin span and both transverse dimensions.
// Use independent same-species morphology from Webb, Kostecki & Stevens
// (1984), J. Exp. Biol. 109, 77–95, Eq. (2) for mass, and Fig. 2D/p. 83 for
// trailing-edge span near 5–8 cm. https://doi.org/10.1242/jeb.109.1.77
// Width/height form a neutral-volume ellipsoid, not a measured trout contour.
// Wetted area and form drag retain the solver defaults. No parameter fits any
// speed or Strouhal value in the held-out experiment.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SwimSolver } from '../dist/life.js';
import { PhysicsWorld } from '../dist/world.js';

const gaitCases = [
  {
    tunnelSpeed: 0.22,
    wavelength: 1.17,
    wavelengthSe: 0.027,
    frequency: 4.73,
    frequencySe: 0.107,
    amplitude: 0.117,
    amplitudeSe: 0.012,
  },
  {
    tunnelSpeed: 0.48,
    wavelength: 1.17,
    wavelengthSe: 0.03,
    frequency: 7.36,
    frequencySe: 0.264,
    amplitude: 0.122,
    amplitudeSe: 0.008,
  },
  {
    tunnelSpeed: 0.74,
    wavelength: 1.24,
    wavelengthSe: 0.053,
    frequency: 8.77,
    frequencySe: 0.393,
    amplitude: 0.129,
    amplitudeSe: 0.008,
  },
];
const rate = { num: 960, den: 1 };
// Liquid water at the stated 15 °C flume temperature and standard pressure.
// See IAPWS R6-95 and R12-08.
const water = { density: 999.1, kinematicViscosity: 1.139e-6 };
const length = 0.074;
const lengthSe = 0.001;
const nominalSpanFraction = 0.2;
const nominalAspectRatio = 1;
const reducedInputs = { length: length - lengthSe, spanFraction: 0.18, aspectRatio: 2, gaitSe: -1 };
const raisedInputs = { length: length + lengthSe, spanFraction: 0.22, aspectRatio: 2, gaitSe: 1 };
const nominalInputs = { length, spanFraction: nominalSpanFraction, aspectRatio: nominalAspectRatio, gaitSe: 0 };
const inputs = [nominalInputs, reducedInputs, raisedInputs, { ...nominalInputs, formDragArea: 0 }];

function body(gait, geometry, index) {
  const { length, spanFraction, aspectRatio, gaitSe, formDragArea } = geometry;
  // Webb et al. Eq. (2) uses centimetres and grams.
  const mass = (0.071 * (length * 100) ** 2.52) / 1000;
  const volume = mass / water.density;
  const transverseDiameter = Math.sqrt((6 * volume) / (Math.PI * length));
  const height = transverseDiameter * Math.sqrt(aspectRatio);
  const width = transverseDiameter / Math.sqrt(aspectRatio);
  const frequency = gait.frequency + gaitSe * gait.frequencySe;
  return {
    position: [index, -1, 0],
    mass,
    length,
    width,
    height,
    volume,
    formDragArea,
    frequency,
    maximumFrequency: frequency,
    tail: {
      span: length * spanFraction,
      wavelength: length * (gait.wavelength + gaitSe * gait.wavelengthSe),
      // Table 1 defines the one-sided amplitude, matching SwimTail.
      amplitude: length * (gait.amplitude + gaitSe * gait.amplitudeSe),
    },
  };
}

async function run(level) {
  const bodies = gaitCases.flatMap((gait) => inputs.map((input, index) => body(gait, input, index)));
  const solver = await SwimSolver.load({ level });
  const world = new PhysicsWorld({ rate }).add(solver, { ...water, bodies });
  const start = 24 * rate.num;
  const end = 28 * rate.num;
  world.advance(start);
  const first = bodies.map((_, i) => solver.read(i));
  const peak = bodies.map(() => ({ min: Infinity, max: -Infinity }));
  // Evaluate the live spine tip over another four seconds to measure the
  // actual excursion at cruise, including the motion/phase chosen by the solver.
  for (let frame = start + 1; frame <= end; frame++) {
    world.advance(frame);
    for (let i = 0; i < bodies.length; i++) {
      const side = solver.sampleSpine(i, 1).position[0];
      peak[i].min = Math.min(peak[i].min, side);
      peak[i].max = Math.max(peak[i].max, side);
    }
  }
  return bodies.map((fish, i) => {
    const next = solver.read(i);
    const speed = next.velocity[2];
    assert.equal(next.wetFraction, 1);
    assert.equal(next.frequency, fish.frequency);
    const drift = Math.abs(speed - first[i].velocity[2]);
    assert.ok(
      speed > 0 && drift < 1e-6,
      `Body ${i} at level ${level} must reach steady forward speed by 28 s. Speed ${speed}, drift ${drift} m/s.`,
    );
    const excursion = peak[i].max - peak[i].min;
    assert.ok(
      Math.abs(excursion / (2 * fish.tail.amplitude) - 1) < 0.003,
      `Resolve both excursion extrema for body ${i} at level ${level}, got ${excursion} m.`,
    );
    return { speed, strouhal: (excursion * next.frequency) / speed, excursion, drift };
  });
}

const [coarse, refined] = await Promise.all([run(3), run(4)]);
const results = gaitCases.map((gait, index) => {
  const offset = index * inputs.length;
  const [nominal, smaller, larger, skinOnly] = refined.slice(offset, offset + inputs.length);
  const speedDifference = nominal.speed - gait.tunnelSpeed;
  return {
    tunnelSpeedMPerSecond: gait.tunnelSpeed,
    reachedSpeedMPerSecond: nominal.speed,
    predictedMinusTunnelMPerSecond: speedDifference,
    predictedMinusTunnelPercent: (100 * speedDifference) / gait.tunnelSpeed,
    measuredGaitStrouhal: (2 * length * gait.amplitude * gait.frequency) / gait.tunnelSpeed,
    reachedStrouhal: nominal.strouhal,
    reachedInsideTaylorCruiseBand: nominal.strouhal > 0.2 && nominal.strouhal < 0.4,
    reachedExcursionMetres: nominal.excursion,
    speedDriftLastFourSecondsMPerSecond: nominal.drift,
    coarseToRefinedSpeedDifferenceMPerSecond: Math.abs(coarse[offset].speed - nominal.speed),
    inputSensitivity: { smaller, larger, skinOnly },
  };
});

const artifacts = Object.fromEntries(
  await Promise.all(
    ['life.js', 'swim-kernel.wasm'].map(async (name) => {
      const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
      return [name, createHash('sha256').update(bytes).digest('hex')];
    }),
  ),
);
console.log(
  JSON.stringify(
    {
      artifacts,
      // Jointly varied morphology and reported gait SEMs are sensitivity cases.
      // No covariance or tunnel-speed error is available to infer a pass band.
      inputs,
      // Taylor, Nudds & Thomas (2003), Nature 425, 707-711. Their comparative
      // cruise range is a separate screen rather than this experiment's uncertainty.
      taylorReference: 'https://doi.org/10.1038/nature02000',
      results,
    },
    null,
    2,
  ),
);
