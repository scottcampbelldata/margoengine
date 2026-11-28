// Run after building Physics: node packages/physics/scripts/atmo06-droplet-settling.mjs
//
// Independent still-air, distilled-water terminal-speed references, five rows apiece.
// Gunn & Kinzer (1949), J. Meteorol. 6, 243–248, experiment and stated overall
// mass–velocity accuracy: https://doi.org/10.1175/1520-0469(1949)006%3C0243:TTVOFF%3E2.0.CO;2
// Their published series, normalised to 760 mm Hg, 20 °C and 50% RH, is
// reproduced in Smithsonian Meteorological Tables (1951), table 114, p. 396:
// https://repository.si.edu/items/5b259e9c-a900-48e0-ad68-07bb46302156
// Equivalent spherical diameters are inferred from weighed drop masses.
//
// Beard & Pruppacher (1969), J. Atmos. Sci. 26, 1066–1072, independently
// measured drop drag in a water-saturated wind tunnel:
// https://doi.org/10.1175/1520-0469(1969)026%3C1066:ADOTTV%3E2.0.CO;2
// Derived dry-bulb 20 °C, 1013 mb reference velocities below 1 mm are reproduced
// in NASA-hosted report NTRS 19790017494, table 3-1, printed p. 17:
// https://ntrs.nasa.gov/api/citations/19790017494/downloads/19790017494.pdf
// These tunnel-derived speeds have no per-row measurement uncertainty here.
//
// Neither series was used to fit the solver's sphere law: Schiller & Naumann
// (1933), https://cir.nii.ac.jp/crid/1570854176015659520 (modern Eq. 3.5:
// https://doi.org/10.1017/jfm.2025.10526), and Davies' 1945 gas slip correction,
// https://doi.org/10.1088/0959-5309/57/4/301.
//
// Separately, Kinzer & Gunn (1951), J. Meteorol. 8, 71–83 measured evaporation
// during free fall: https://doi.org/10.1175/1520-0469(1951)008%3C0071:TETATR%3E2.0.CO;2
// Smithsonian table 117 A/B, pp. 398–399, combines an experimentally derived
// ventilation term with temperature/humidity transport factors and gives a
// probable uncertainty of less than 4%. Values at 20 °C were transcribed from
// the scanned page. These are measurement-derived rates, not raw records.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AirborneParticles } from '../dist/airborne.js';
import { PhysicsWorld } from '../dist/world.js';

const diametersMm = [0.1, 0.2, 0.3, 0.4, 0.5];
const standardPressurePa = 101325;
const references = [
  {
    series: 'Gunn–Kinzer still-air fall',
    relativeHumidity: 0.5,
    pressurePa: standardPressurePa,
    speedCmPerSecond: [27, 72, 117, 162, 206],
    accuracyFraction: 0.007,
    roundingMPerSecond: 0.005,
  },
  {
    series: 'Beard–Pruppacher tunnel-derived speeds',
    relativeHumidity: 1,
    pressurePa: 101300,
    speedCmPerSecond: [25.6, 71, 115, 160, 204],
  },
];

// Table 117 A has centimetre units. Table 117 B values here are in units of
// 10^-6 g/(cm s), so the product is directly in micrograms per second.
const evaporationLengthCm = [0.079, 0.29, 0.48, 0.71, 0.97];
const evaporationTransport = [
  { relativeHumidity: 0.5, coefficient: 0.78, halfDigit: 0.005 },
  { relativeHumidity: 0.9, coefficient: 0.159, halfDigit: 0.0005 },
];
const rate = { num: 60, den: 1 };
const oneNativeStep = { num: 240, den: 1 };
const temperature = 293.15;
// The pure water saturation pressure at 20 °C is 2338.8 Pa (IAPWS).
// https://iapws.org/relguide/Supp-sat.html
const saturationPressurePa = 2338.8;
const initial = diametersMm.map((diameterMm, i) => {
  const diameter = diameterMm / 1000;
  return {
    kind: 'freshwater-mist',
    diameter,
    mass: (1000 * Math.PI * diameter ** 3) / 6,
    position: [i, 20, 0],
  };
});

const artifactNames = ['airborne.js', 'airborne-kernel.wasm'];
const artifact = Object.fromEntries(
  await Promise.all(
    artifactNames.map(async (name) => {
      const bytes = await readFile(new URL(`../dist/${name}`, import.meta.url));
      return [name, createHash('sha256').update(bytes).digest('hex')];
    }),
  ),
);

function moistAir(relativeHumidity, pressurePa) {
  const vapourPressure = relativeHumidity * saturationPressurePa;
  return (pressurePa - vapourPressure) / (287.05 * temperature) + vapourPressure / (461.5 * temperature);
}

async function particleWorld(density, humidity, particles, rate) {
  const solver = await AirborneParticles.load();
  const world = new PhysicsWorld({ rate, gravity: [0, -9.80665, 0] }).add(solver, {
    initial: particles,
    humidity,
    drag: 'sphere',
    wind: {
      medium: 'air',
      cell: [0, 0, 0],
      sample() {
        return { velocity: [0, 0, 0], density, temperature };
      },
    },
  });
  return { solver, world };
}

async function settle(density) {
  // The wind supplies moist-air density. A separate RH of one disables size
  // loss and isolates terminal drag at the stated equivalent diameter.
  const { solver, world } = await particleWorld(density, 1, initial, rate);
  world.advance(180);
  const first = solver.readParticles();
  world.advance(240);
  const last = solver.readParticles();
  assert.equal(first.length, initial.length);
  assert.equal(last.length, initial.length);
  return last.map((particle, index) => {
    const speed = -particle.velocity[1];
    const drift = Math.abs(speed + first[index].velocity[1]);
    assert.equal(particle.diameter, initial[index].diameter);
    assert.equal(particle.mass, initial[index].mass);
    assert.ok(speed > 0 && drift < 1e-6, 'The released drops must reach a stable downward speed by 4 s.');
    return { speed, drift };
  });
}

async function compareSettling(reference) {
  const density = moistAir(reference.relativeHumidity, reference.pressurePa);
  const speeds = await settle(density);
  const rows = speeds.map(({ speed, drift }, index) => {
    const observed = reference.speedCmPerSecond[index] / 100;
    const residual = observed - speed;
    // Overall stated accuracy plus half a printed digit, as a conservative
    // screening band rather than a pointwise confidence interval.
    const band =
      reference.accuracyFraction === undefined
        ? null
        : observed * reference.accuracyFraction + reference.roundingMPerSecond;
    return {
      diameterMm: diametersMm[index],
      observedMPerSecond: observed,
      predictedMPerSecond: speed,
      observedMinusPredictedMPerSecond: residual,
      residualPercent: (100 * residual) / observed,
      driftMPerSecondBetween3And4Seconds: drift,
      screeningBandMPerSecond: band,
      insideScreeningBand: band === null ? null : Math.abs(residual) <= band,
    };
  });
  return { series: reference.series, temperatureK: temperature, airDensityKgPerCubicMetre: density, rows };
}

async function compareEvaporation({ relativeHumidity, coefficient, halfDigit }) {
  const density = moistAir(relativeHumidity, standardPressurePa);
  const speeds = await settle(density);
  // The settling speeds here are solver predictions in the same air density.
  // None of the mass losses or the measured speed series enters the forcing.
  const falling = initial.map((parcel, i) => ({ ...parcel, velocity: [0, -speeds[i].speed, 0] }));
  const { solver, world } = await particleWorld(density, relativeHumidity, falling, oneNativeStep);
  world.advance(1);
  const particles = solver.readParticles();
  assert.equal(particles.length, falling.length);
  const rows = particles.map((particle, i) => {
    assert.equal(particle.age, 1 / 240);
    const relativeDiameterLoss = 1 - particle.diameter / falling[i].diameter;
    assert.ok(relativeDiameterLoss > 0 && relativeDiameterLoss < 0.001, 'Measure only the local mass-loss rate.');
    const observed = evaporationLengthCm[i] * coefficient;
    const predicted = ((falling[i].mass - particle.mass) * 1e9) / particle.age;
    const residual = observed - predicted;
    const halfLengthDigit = i === 0 ? 0.0005 : 0.005;
    const maxRoundedRate = (evaporationLengthCm[i] + halfLengthDigit) * (coefficient + halfDigit);
    const band = observed * 0.04 + maxRoundedRate - observed;
    return {
      diameterMm: diametersMm[i],
      observedMicrogramsPerSecond: observed,
      predictedMicrogramsPerSecond: predicted,
      observedMinusPredictedMicrogramsPerSecond: residual,
      residualPercent: (100 * residual) / observed,
      relativeDiameterLoss,
      screeningBandMicrogramsPerSecond: band,
      insideScreeningBand: Math.abs(residual) <= band,
    };
  });
  return { relativeHumidity, temperatureK: temperature, airDensityKgPerCubicMetre: density, rows };
}

const settling = [];
for (const reference of references) settling.push(await compareSettling(reference));
const evaporation = [];
for (const reference of evaporationTransport) evaporation.push(await compareEvaporation(reference));
console.log(JSON.stringify({ artifact, settling, evaporation }, null, 2));
