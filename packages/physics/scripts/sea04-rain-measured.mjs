// node scripts/run-with-timeout.mjs --max=3 -- node packages/physics/scripts/sea04-rain-measured.mjs
// Pass --refined to use the smaller spatial sampling interval with all other settings fixed.
import assert from 'node:assert/strict';
import { RealFft2 } from '@margoengine/math/fft';
import { wakeRainSource, WakeSolver } from '../dist/sea.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const paper = 'https://doi.org/10.1109/48.775294';
const rate = 60;
const nominalTime = 0.8;
const timingUncertainty = 0.04;
const coordinateUncertainty = 0.02;
const heightDriftMillimetres = 0.02;
const readoutBand = [50, 500]; // Approximate optical-processing limits in §III-D, rad/m.
const gravity = 9.81;
const depth = 0.2;
const molecularViscosity = 1e-6;
const side = 0.768;
const refined = process.argv.includes('--refined');
assert.ok(
  process.argv.slice(2).every((arg) => arg === '--refined'),
  'Use --refined for the fixed finer grid.',
);
const n = refined ? 768 : 480;
const spacing = side / n;
const origin = [-side / 2 + spacing / 2, -side / 2 + spacing / 2];
const grid = { cells: [n, n], cellSize: spacing, origin };

// Figure 6 (2.8 mm) and Figure 7 (2.2 mm), 5.5 m fall, both observations.
// Digitized dominant adjacent crest and trough locations and half their
// difference, in mm. Constant vertical offsets cancel in this amplitude.
// Measurements are supplied only to the final comparison.
const observations = {
  '2.2-fresh': [
    [94, 116, 0.065],
    [103, 121, 0.061],
  ],
  '2.2-salt': [
    [108, 122, 0.056],
    [111, 128, 0.035],
  ],
  '2.8-fresh': [
    [112, 125, 0.106],
    [118, 131, 0.107],
  ],
  '2.8-salt': [
    [113, 127, 0.187],
    [103, 118, 0.148],
  ],
};
const plotRadiusReadoutMillimetres = 2;
const plotAmplitudeReadoutMillimetres = 0.004;
const terminalSpeeds = [
  [2.2, 6.9],
  [2.8, 7.82],
]; // Gunn & Kinzer (1949), laboratory terminal speeds.
const fallSpeedFraction = 0.93; // Craeye et al. §II, 5.5 m.
// The paper reports salinity and measured surface tensions, but no numeric
// densities. Use standard fresh and seawater densities for those two fluids.
const waters = {
  fresh: { density: 1000, surfaceTension: 0.07 },
  salt: { density: 1025, surfaceTension: 0.06 },
};
// §III-C also reports a film-equivalent ν=7.28 mm²/s at the observed k_m.
// Keep the molecular fluid value above. Surface-film damping and the crater,
// crown and collapsing stalk are absent from the one-tick impact model.

function radialSamples(heights) {
  const step = 0.00025;
  const firstRadius = 0.05;
  const directions = Array.from({ length: 16 }, (_, i) => {
    const angle = (2 * Math.PI * i) / 16;
    return [Math.cos(angle), Math.sin(angle)];
  });
  function sample(x, z) {
    const u = (x - origin[0]) / spacing - 0.5;
    const v = (z - origin[1]) / spacing - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const a = u - i;
    const b = v - j;
    const index = i + j * n;
    return (
      (1 - b) * ((1 - a) * heights[index] + a * heights[index + 1]) +
      b * ((1 - a) * heights[index + n] + a * heights[index + n + 1])
    );
  }
  return Array.from({ length: 601 }, (_, i) => {
    const radius = firstRadius + i * step;
    const height = directions.reduce((sum, [x, z]) => sum + sample(radius * x, radius * z), 0) / directions.length;
    return { radius, height };
  });
}

function dominantPair(profile) {
  let crest;
  let dominant;
  for (let i = 1; i < profile.length - 1; i++) {
    const point = profile[i];
    const before = profile[i - 1].height;
    const after = profile[i + 1].height;
    if (point.height > 0 && point.height > before && point.height >= after) crest = point;
    if (point.height < 0 && point.height < before && point.height <= after && crest) {
      const halfRange = (crest.height - point.height) / 2;
      if (!dominant || halfRange > dominant.halfRange) {
        dominant = { crest: crest.radius, trough: point.radius, halfRange };
      }
      crest = undefined;
    }
  }
  assert.ok(dominant, 'Resolve a positive crest followed by its negative trough within the plotted radial window.');
  return Object.fromEntries(Object.entries(dominant).map(([key, value]) => [key, 1000 * value]));
}

function filteredObservation(heights, fft, density) {
  const spectrum = fft.forward(heights);
  const stride = n / 2 + 1;
  let total = 0;
  let firstMoment = 0;
  for (let j = 0; j < n; j++) {
    const kz = (2 * Math.PI * (j <= n / 2 ? j : j - n)) / side;
    for (let i = 0; i < stride; i++) {
      const k = Math.hypot((2 * Math.PI * i) / side, kz);
      const at = 2 * (j * stride + i);
      if (k < readoutBand[0] || k > readoutBand[1]) {
        spectrum[at] = spectrum[at + 1] = 0;
      } else {
        const copies = i > 0 && i < n / 2 ? 2 : 1;
        const square = copies * (spectrum[at] ** 2 + spectrum[at + 1] ** 2);
        total += square;
        firstMoment += k * square;
      }
    }
  }
  const filtered = fft.inverse(spectrum);
  const profile = radialSamples(filtered);
  const area = spacing ** 2;
  const gravityPotentialJoules =
    (density * gravity * area * filtered.reduce((sum, height) => sum + height ** 2, 0)) / 2;
  return {
    ...dominantPair(profile),
    gravityPotentialJoules,
    // A Cartesian snapshot-spectrum diagnostic. The paper's characteristic
    // wavenumber instead uses the complex Hankel transform of its transect.
    snapshotMeanWavenumberPerMetre: firstMoment / total,
  };
}

function compare(frames, repeated) {
  const nominal = frames.find((frame) => frame.time === nominalTime);
  return repeated.map(([crest, trough, halfRange]) => {
    const toleranceCrest = coordinateUncertainty * crest + plotRadiusReadoutMillimetres;
    const toleranceTrough = coordinateUncertainty * trough + plotRadiusReadoutMillimetres;
    const toleranceHeight = heightDriftMillimetres + plotAmplitudeReadoutMillimetres;
    const compatible = (frame) =>
      Math.abs(frame.crest - crest) <= toleranceCrest &&
      Math.abs(frame.trough - trough) <= toleranceTrough &&
      Math.abs(frame.halfRange - halfRange) <= toleranceHeight;
    return {
      measured: { crest, trough, halfRange },
      nominalError: {
        crest: nominal.crest - crest,
        trough: nominal.trough - trough,
        halfRange: nominal.halfRange - halfRange,
      },
      jointAgreementWithinObservationUncertainty: frames.some(compatible),
    };
  });
}

async function runCase(diameterMillimetres, terminalSpeed, water, { density, surfaceTension }, fft) {
  const drop = {
    x: 0,
    z: 0,
    diameter: diameterMillimetres / 1000,
    fallSpeed: terminalSpeed * fallSpeedFraction,
    density: 1000, // §II, all drops were tap water.
  };
  const wake = await WakeSolver.load({ signal: AbortSignal.timeout(10_000) });
  const impact = wakeRainSource(drop, grid, 1 / rate);
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  world.add(wake, {
    cells: grid.cells,
    cellSize: spacing,
    centre: [spacing / 2, spacing / 2],
    depth,
    density,
    surfaceTension,
    kinematicViscosity: molecularViscosity,
    sponge: 0,
    sources: (time) => (time < 1 / rate ? [impact] : []),
  });
  const firstTick = Math.ceil((nominalTime - timingUncertainty) * rate);
  const lastTick = Math.floor((nominalTime + timingUncertainty) * rate);
  const frames = [];
  for (let tick = firstTick; tick <= lastTick; tick++) {
    world.advance(tick);
    const heights = wake.heights();
    const volume = spacing ** 2 * heights.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(volume / impact.volume - 1) < 1e-9);
    frames.push({ time: tick / rate, ...filteredObservation(heights, fft, density) });
  }
  return {
    diameterMillimetres,
    water,
    fallSpeed: drop.fallSpeed,
    pressureFootprintMillimetres: 1000 * impact.radius,
    frames,
    comparison: compare(frames, observations[`${diameterMillimetres}-${water}`]),
  };
}

// In the selected optical band kD >= 10. The deep-water group-speed bound
// is 0.5 sqrt(g/k_min) + 1.5 sqrt((surfaceTension/density) k_max).
// Allow 0.001 m/s for the finite-depth tanh correction. The optical band
// stays inside the pre-return group window. Its Fourier filter has tails.
const groupSpeedBound =
  0.5 * Math.sqrt(gravity / readoutBand[0]) + 1.5 * Math.sqrt((0.07 / 1000) * readoutBand[1]) + 0.001;
assert.ok(groupSpeedBound * (nominalTime + timingUncertainty) < side - 0.2);
const fft = new RealFft2(n, n);
const cases = [];
for (const [diameter, terminalSpeed] of terminalSpeeds) {
  for (const [water, properties] of Object.entries(waters)) {
    cases.push(await runCase(diameter, terminalSpeed, water, properties, fft));
  }
}
console.log(
  JSON.stringify(
    {
      paper,
      experiment: { fallHeight: 5.5, depth, waterSide: 1.1, saltSalinityPartsPerThousand: 34, molecularViscosity },
      modeledWaters: waters,
      protocol: { nominalTime, timingUncertainty, rate, grid, readoutBand, radiusWindowMillimetres: [50, 200] },
      units: { crest: 'mm', trough: 'mm', halfRange: 'mm' },
      cases,
    },
    null,
    2,
  ),
);
