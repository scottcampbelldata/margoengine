// Run after building Physics: node packages/physics/scripts/bio01-blade-measured.mjs
//
// M. Luhar & H. Nepf (2016), Wave-induced dynamics of flexible blades,
// J. Fluids Struct. 61, 20–41. https://doi.org/10.1016/j.jfluidstructs.2015.11.007
// Independent inputs are the geometry and hydrograph reported in §3.1,
// Table 1 and Fig. 5 (https://arxiv.org/pdf/1510.01237). The excluded outputs
// are the measured HDPE peak-to-peak tip excursions in §4.1 and Figs. 6–7.
// The authors give an estimated image-based excursion uncertainty of ±2 mm.
//
// PlantSway uses an upright, small-angle circular cross-section. The
// equivalent section below preserves material mass and displaced area,
// measured EI, projected normal drag width and the flat plate's normal
// added mass. It does not reproduce finite-angle, inextensible reconfiguration
// or the effect of the vertical wave velocity on a tilted blade.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PlantSway } from '../dist/vegetation.js';
import { PhysicsWorld } from '../dist/world.js';

const references = [
  { length: 0.05, cauchy: 0.5, measuredExcursion: 0.005 },
  { length: 0.2, cauchy: 36, measuredExcursion: 0.175 },
];
const period = 2;
const rootVelocity = 0.206;
const width = 0.02;
const thickness = 0.0004;
const density = 950;
const waterDensity = 1000;
const area = width * thickness;
const equivalentDiameter = Math.sqrt((4 * area) / Math.PI);
const equivalentSecondMoment = (Math.PI * equivalentDiameter ** 4) / 64;
// Section 3.1: cross-sectional curvature doubled I versus flat bd³/12
// in separately measured self-weight cantilever bending in air.
const measuredStiffness = (0.93e9 * width * thickness ** 3) / 6;
const nominalModulus = measuredStiffness / equivalentSecondMoment;
// Section 2.2: external flat-plate data, with KC from Table 1. Use the
// paper's stated CM=1 alternative. No inverse fit to observed excursions.
const flatPlateCd = Math.max(10 * ((rootVelocity * period) / width) ** (-1 / 3), 1.95);
const addedMassCoefficient = (Math.PI * width ** 2) / (4 * area);
const dragCoefficient = (flatPlateCd * width) / equivalentDiameter;
const waveOmega = (2 * Math.PI) / period;

// Digitized Fig. 5 solid four-harmonic PIV fit at z=0 from the three
// repetitions. Samples are at t/T = 0, 1/16, …, 15/16; units cm/s.
// Rebuild four harmonics and normalize their positive peak to Table 1 Uw
// to remove sub-pixel vertical scale error. No blade-response curve is used.
const piv = [-2.55, 8.4, 17.2, 20, 17.4, 11.1, 4.7, -0.8, -5.2, -8.45, -11, -12.9, -15, -16.2, -15.6, -11.2];
const harmonics = Array.from({ length: 4 }, (_, i) => {
  const order = i + 1;
  let cosine = 0;
  let sine = 0;
  for (let j = 0; j < piv.length; j++) {
    const phase = (2 * Math.PI * order * j) / piv.length;
    cosine += piv[j] * Math.cos(phase);
    sine += piv[j] * Math.sin(phase);
  }
  return { order, cosine: (2 * cosine) / piv.length, sine: (2 * sine) / piv.length };
});

function waveform(t) {
  let u = 0;
  for (const { order, cosine, sine } of harmonics) {
    const phase = waveOmega * order * t;
    u += cosine * Math.cos(phase) + sine * Math.sin(phase);
  }
  return u;
}

const crest = Math.max(...Array.from({ length: 256 }, (_, i) => waveform((period * i) / 256)));
const rate = { num: 240, den: 1 };
const sensitivity = [
  { case: 'nominal', heightGain: 0.085, velocity: rootVelocity, stiffnessRatio: 1 },
  { case: 'stiffer and weaker flow', heightGain: 0.06, velocity: rootVelocity - 0.009, stiffnessRatio: 1.2 },
  { case: 'softer and stronger flow', heightGain: 0.11, velocity: rootVelocity + 0.009, stiffnessRatio: 0.8 },
];

async function measure({ heightGain, velocity, stiffnessRatio }) {
  const solver = await PlantSway.load();
  const world = new PhysicsWorld({ rate }).add(solver, {
    plants: references.map(({ length }, i) => ({
      root: [i, 0, 0],
      height: length,
      baseDiameter: equivalentDiameter,
      youngModulus: nominalModulus * stiffnessRatio,
      density,
      dragCoefficient,
      addedMassCoefficient,
    })),
    flow: {
      medium: 'water',
      cell: [0, 0, 0],
      sample(_x, y, _z, seconds) {
        // §3.1: horizontal amplitude increases by 6–11% from the base to
        // 20 cm above it in the 2 s runs. Interpolate that stated range.
        const amplitude = velocity * (1 + (heightGain * y) / 0.2);
        return {
          velocity: [(amplitude * waveform(seconds)) / crest, 0, 0],
          density: waterDensity,
          temperature: 293.15,
        };
      },
    },
  });
  const score = [];
  for (const start of [40, 42]) {
    const extrema = references.map(() => ({ min: Infinity, max: -Infinity, slope: 0 }));
    for (let frame = start * rate.num; frame <= (start + period) * rate.num; frame++) {
      world.advance(frame);
      for (const [i, { length }] of references.entries()) {
        const sample = solver.sample(i, length);
        const displacement = sample.displacement[0];
        extrema[i].min = Math.min(extrema[i].min, displacement);
        extrema[i].max = Math.max(extrema[i].max, displacement);
        extrema[i].slope = Math.max(extrema[i].slope, Math.abs(sample.slope[0]));
      }
    }
    score.push(extrema);
  }
  return references.map(({ measuredExcursion, length, cauchy }, i) => {
    const { min, max, slope } = score[1][i];
    const reached = max - min;
    const previous = score[0][i].max - score[0][i].min;
    assert.ok(Number.isFinite(reached) && Math.abs(reached - previous) < 1e-5, 'The periodic excursion must converge.');
    return {
      lengthMetres: length,
      referenceCauchyNumber: cauchy,
      observedMetres: measuredExcursion,
      predictedMetres: reached,
      predictedMinusObservedMetres: reached - measuredExcursion,
      insideImageUncertainty: Math.abs(reached - measuredExcursion) <= 0.002,
      changeBetweenPeriodsMetres: reached - previous,
      peakAbsTipSlope: slope,
    };
  });
}

const results = [];
for (const scenario of sensitivity) results.push({ ...scenario, rows: await measure(scenario) });
const artifacts = Object.fromEntries(
  await Promise.all(
    ['vegetation.js', 'vegetation-kernel.wasm'].map(async (name) => {
      const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
      return [name, createHash('sha256').update(bytes).digest('hex')];
    }),
  ),
);
console.log(JSON.stringify({ artifacts, results }, null, 2));
