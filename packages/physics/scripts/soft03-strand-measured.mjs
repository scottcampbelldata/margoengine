// Run against built Physics from the repository root:
// node scripts/run-with-timeout.mjs --max=1 -- node packages/physics/scripts/soft03-strand-measured.mjs
//
// Akanda, Tohmyoh & Saka (2010), §4.1 and Fig. 7(a), rightmost measurement of each specimen.
// "An Integrated Compact Unit for Wide Range Micro-Newton Force Measurement"
// https://doi.org/10.1299/jmmp.4.545
// Only the four measured markers and their geometric inputs are transcribed. The fitted slope of
// Fig. 7(b) does not enter the model. Use the repository's nominal 3 GPa straight-hair modulus.
// Quasistatic incremental bending ignores self-weight. At physical density 1300 kg/m³
// the heaviest loaded span weighs 0.17 µN, smaller than the force readout allowance.

import assert from 'node:assert/strict';
import { StrandSolver } from '../dist/strands.js';
import { PhysicsWorld } from '../dist/world.js';

const MICRO = 1e-6;
const YOUNG = 3e9;
const NUMERICAL_DENSITY = 1.3e9; // Inertial scaling resolves the static load ramp. The 4–6 s solve time has no experimental meaning.
const AIR_DENSITY = 1.225;
const DRAG_COEFFICIENT = 1.2;
const ZERO = [0, 0, 0];
const WORLD_RATE = { num: 60, den: 1 };
const SPECIMENS = [
  { diameter: 89.9, span: 2078, force: 70.3, deflection: 23.4 },
  { diameter: 52.4, span: 1000, force: 94.7, deflection: 31.0 },
  { diameter: 37.6, span: 1000, force: 36.6, deflection: 46.5 },
  { diameter: 52.9, span: 900, force: 75.0, deflection: 17.8 },
];
// At 280 dpi, 50 µm spans 689 px and 140 µN spans 482 px. ±6 px plus readout
// rounding gives ≤0.5 µm and 1.8 µN. Add the paper's Cant.-1 40 nN resolution and
// up to 0.2% of the 262.5 µN configured range for a ±2.5 µN force sensitivity.
const DEFLECTION_READOUT = 0.5;
const FORCE_ALLOWANCE = 2.5;

async function tipDeflection(specimen, force, links, rate, density = NUMERICAL_DENSITY) {
  const solver = await StrandSolver.load();
  const span = specimen.span * MICRO;
  const radius = (specimen.diameter * MICRO) / 2;
  const area = Math.PI * radius ** 2;
  const halfLink = span / (2 * links);
  const tipMass = area * density * halfLink;
  const dt = 1 / (WORLD_RATE.num * 2 ** rate);

  const unloaded = { velocity: ZERO, temperature: 293.15, density: 0 };
  const wind = {
    medium: 'air',
    cell: ZERO,
    sample(x, y, z, time) {
      const { position, velocity, rotation } = solver.sample(0, links);
      if (x !== position[0] || y !== position[1] || z !== position[2]) return unloaded;
      // Encode the probe's known X load as a prescribed increment through the public
      // per-point forcing input. This artificial field represents the probe at the tip.
      // With no gravity or extra damping, the implicit drag update adds k dt u²/(1+k dt u)
      // to vx, where k is the instantaneous drag factor divided by tip mass.
      const [qx, qy, qz, qw] = rotation;
      const tangentX = 2 * (qx * qz + qy * qw);
      const cross = Math.sqrt(Math.max(0, 1 - tangentX ** 2));
      const ramp = Math.min(1, time / 2);
      const deltaVelocity = (force * MICRO * dt * ramp * ramp * (3 - 2 * ramp)) / tipMass;
      const projectedArea = 2 * radius * halfLink * cross + area * (1 - cross);
      const k = (0.5 * AIR_DENSITY * DRAG_COEFFICIENT * projectedArea) / tipMass;
      const u = (deltaVelocity + Math.sqrt(deltaVelocity ** 2 + (4 * deltaVelocity) / (k * dt))) / 2;
      return { ...unloaded, velocity: [velocity[0] + u, velocity[1], velocity[2]], density: AIR_DENSITY };
    },
  };
  const points = Array.from({ length: links + 1 }, (_, i) => [0, 0, (i * span) / links]);
  const world = new PhysicsWorld({ rate: WORLD_RATE, gravity: ZERO }).add(solver, {
    strands: [{ points, radius, density, young: YOUNG, drag: DRAG_COEFFICIENT }],
    rate,
    damping: 0,
    selfCollision: false,
    wind,
  });
  world.advance(240);
  const early = solver.sample(0, links).position[0] / MICRO;
  world.advance(360);
  const final = solver.sample(0, links);
  assert.ok(final.position[0] > 0 && Number.isFinite(final.position[0]));
  return { deflection: final.position[0] / MICRO, settlingDelta: final.position[0] / MICRO - early };
}

for (const specimen of SPECIMENS) {
  const slow = await tipDeflection(specimen, specimen.force, 48, 2);
  const coarse = await tipDeflection(specimen, specimen.force, 48, 3);
  const fine = await tipDeflection(specimen, specimen.force, 96, 3);
  const lowForce = await tipDeflection(specimen, specimen.force - FORCE_ALLOWANCE, 96, 3);
  const highForce = await tipDeflection(specimen, specimen.force + FORCE_ALLOWANCE, 96, 3);
  const error = fine.deflection - specimen.deflection;
  const continuumDeflection =
    (64 * specimen.force * MICRO * (specimen.span * MICRO) ** 3) /
    (3 * YOUNG * Math.PI * (specimen.diameter * MICRO) ** 4 * MICRO);
  console.log(
    JSON.stringify({
      diameterMicrometres: specimen.diameter,
      spanMicrometres: specimen.span,
      measuredForceMicronewtons: specimen.force,
      forceAllowanceMicronewtons: FORCE_ALLOWANCE,
      measuredDeflectionMicrometres: specimen.deflection,
      deflectionReadoutMicrometres: DEFLECTION_READOUT,
      strandsDeflectionMicrometres: fine.deflection,
      predictionMinusMeasurementMicrometres: error,
      predictionAtForceBoundsMicrometres: [lowForce.deflection, highForce.deflection],
      spatialRefinementDeltaMicrometres: fine.deflection - coarse.deflection,
      timeRefinementDeltaMicrometres: coarse.deflection - slow.deflection,
      betweenFourAndSixSolverSecondsDeltaMicrometres: fine.settlingDelta,
      smallDeflectionBeamMicrometres: continuumDeflection,
    }),
  );
}

const longest = SPECIMENS[0];
const reference = await tipDeflection(longest, longest.force, 96, 3);
const lighter = await tipDeflection(longest, longest.force, 96, 3, NUMERICAL_DENSITY / 4);
console.log(
  JSON.stringify({
    longestSpanMicrometres: longest.span,
    quarterNumericalDensityDeltaMicrometres: lighter.deflection - reference.deflection,
    quarterNumericalDensitySettlingDeltaMicrometres: lighter.settlingDelta,
  }),
);
