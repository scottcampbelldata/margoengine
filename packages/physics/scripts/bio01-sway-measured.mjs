// Run after building Physics: node packages/physics/scripts/bio01-sway-measured.mjs
//
// H.-C. Spatz, F. Brüchert & J. Pfisterer (2007), Multiple resonance damping
// or how do trees escape dangerously large oscillations?, American Journal of
// Botany 94, 1603–1611. https://doi.org/10.3732/ajb.94.10.1603
//
// Table 1 gives static Instron three-point bending moduli. The morphology and
// mass measurements are separate from the held-out ringdown frequencies in
// "Bending vibrations" and Figs. 6–7. These are two states of the same young
// Douglas fir. Ringdowns were recorded on a calm day with neighbours bound
// back. An inclinometer detected no movement at the roots.
//
// PlantSway uses one constant E and linearly tapering circular stems. The
// paper reports a nearly linear taper and nearly circular section but no
// complete diameter profile. The main stem is approximated by a linear cone
// ending at zero diameter, truncated 0.8 m below the tip for the stripped run.
// The intact-tree approximation smears measured branch mass over the stem in
// proportion to its cross-sectional area. The paper describes the combined
// stem+branch equivalent density as nearly constant. Individual branch
// dynamics, variation of E with height and the 320 g extensometer load at the
// measurement point are outside this setup. Treat the two measurements as a
// qualified sensitivity comparison, not two independent specimens.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PlantSway } from '../dist/vegetation.js';
import { PhysicsWorld } from '../dist/world.js';

const fullHeight = 5.03;
const baseDiameter = 0.07;
const sensorHeight = 2.26;
const pullHeight = 2.63;
const removedTop = 0.8;
const remainingMass = 6.3;
const removedMass = 9.6;
const moduli = [
  [0.54, 2.84],
  [1.03, 4.05],
  [2.09, 3.04],
  [3.05, 2.75],
  [3.64, 0.96],
  [3.99, 1.05],
  [4.4, 0.82],
  [4.66, 0.56],
];
const references = [
  { case: 'debranched and shortened', height: fullHeight - removedTop, mass: remainingMass, omega: 11.4, spread: 0.5 },
  { case: 'intact', height: fullHeight, mass: remainingMass + removedMass, omega: 3.78, spread: 0.09 },
];

function diameter(z, fullTip) {
  return baseDiameter + (fullTip - baseDiameter) * (z / fullHeight);
}

function modulus(z) {
  const index = moduli.findIndex(([height]) => z < height);
  if (index === 0) return moduli[0][1] * 1e9;
  if (index === -1) return moduli.at(-1)[1] * 1e9;
  const [low, eLow] = moduli[index - 1];
  const [high, eHigh] = moduli[index];
  return (eLow + ((eHigh - eLow) * (z - low)) / (high - low)) * 1e9;
}

function staticEquivalentModulus(loadedHeight, fullTip) {
  // Match static compliance at a specified pull height using unit-load bending
  // work: delta/F = integral((loadedHeight-z)^2 / (E(z) I(z))) dz.
  // The common pi/64 and uniform quadrature spacing cancel in the ratio.
  let uniform = 0;
  let measured = 0;
  const samples = 1024;
  for (let i = 0; i < samples; i++) {
    const z = ((i + 0.5) * loadedHeight) / samples;
    const integrand = (loadedHeight - z) ** 2 / diameter(z, fullTip) ** 4;
    uniform += integrand;
    measured += integrand / modulus(z);
  }
  return uniform / measured;
}

const assumptions = [
  { case: 'nominal', fullTip: 0, loadedHeight: pullHeight },
  { case: 'static weighting at sensor height', fullTip: 0, loadedHeight: sensorHeight },
  // The unknown terminal diameter affects the taper along the whole shaft.
  { case: '5 mm terminal-diameter sensitivity', fullTip: 0.005, loadedHeight: pullHeight },
];

const bodies = references.flatMap(({ height, mass }) =>
  assumptions.map(({ fullTip, loadedHeight }, index) => {
    const tipDiameter = diameter(height, fullTip);
    const volume = (Math.PI * height * (baseDiameter ** 2 + baseDiameter * tipDiameter + tipDiameter ** 2)) / 12;
    return {
      root: [index, 0, 0],
      height,
      baseDiameter,
      tipDiameter,
      density: mass / volume,
      youngModulus: staticEquivalentModulus(loadedHeight, fullTip),
      initialDisplacement: [0.01, 0, 0, 0],
    };
  }),
);
const solver = await PlantSway.load();
const rate = { num: 240, den: 1 };
const world = new PhysicsWorld({ rate }).add(solver, { plants: bodies });
const zeroes = bodies.map(() => []);
const previous = bodies.map((_, i) => solver.sample(i, sensorHeight).displacement[0]);
for (let frame = 1; frame <= rate.num * 28; frame++) {
  world.advance(frame);
  for (let i = 0; i < bodies.length; i++) {
    const value = solver.sample(i, sensorHeight).displacement[0];
    if (previous[i] > 0 && value <= 0) {
      const fraction = previous[i] / (previous[i] - value);
      zeroes[i].push((frame - 1 + fraction) / rate.num);
    }
    previous[i] = value;
  }
}

const results = references.map(({ case: label, omega, spread }, index) => ({
  measuredCase: label,
  observedRadiansPerSecond: omega,
  reportedSpreadRadiansPerSecond: spread,
  predictions: assumptions.map((assumption, j) => {
    const i = index * assumptions.length + j;
    const crossings = zeroes[i];
    assert.ok(crossings.length > 5, 'Measure several same-direction zero crossings in the production trajectory.');
    const predicted = (2 * Math.PI * (crossings.length - 1)) / (crossings.at(-1) - crossings[0]);
    // The clock reads the integrated motion. The dry eigenfrequency reports
    // the unloaded modal solve, kept separately from the holdout.
    const dryOmega = solver.dryFrequencies(i)[0] * 2 * Math.PI;
    assert.ok(Number.isFinite(predicted) && Math.abs(predicted - dryOmega) < dryOmega * 0.015);
    return {
      assumption: assumption.case,
      equivalentYoungModulusGPa: bodies[i].youngModulus / 1e9,
      densityKgPerCubicMetre: bodies[i].density,
      predictedRadiansPerSecond: predicted,
      dryEigenRadiansPerSecond: dryOmega,
      predictedMinusObservedRadiansPerSecond: predicted - omega,
      insideReportedSpread: Math.abs(predicted - omega) <= spread,
    };
  }),
}));
const artifacts = Object.fromEntries(
  await Promise.all(
    ['vegetation.js', 'vegetation-kernel.wasm'].map(async (name) => {
      const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
      return [name, createHash('sha256').update(bytes).digest('hex')];
    }),
  ),
);
console.log(JSON.stringify({ artifacts, results }, null, 2));
