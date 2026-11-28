// Reproduce after building Physics: node packages/physics/scripts/fluid07-sliding-drop-measured.mjs
// Le Grand, Daerr & Limat (2005), Shape and motion of drops sliding down an inclined plane,
// J. Fluid Mech. 541, 293–315, https://doi.org/10.1017/S0022112005006105, §2, Table 1 and Fig. 7.
// Separate, quasi-static 47V10/FC725 measurements: Podgorski (2000), Ruissellement en conditions
// de mouillage partiel, part II §2.1.2 and Table 2.1, https://theses.hal.science/tel-00003231.
// See also Podgorski, Flesselles & Limat (2001), Corners, Cusps, and Pearls in Running Drops,
// https://doi.org/10.1103/PhysRevLett.87.036102, Table I (receding angle and molecular scale).
// Only sparse measured facts and original computations appear here, with no reproduced artwork or data files.
import assert from 'node:assert/strict';
import { ThinFilmSolver } from '../dist/thin-film.js';
import { PhysicsWorld } from '../dist/world.js';

const degree = Math.PI / 180;
const gravity = 9.80665;
const density = 936;
const viscosity = 0.01;
const tension = 0.0201;
const volume = 6e-9;
const patchLength = 0.016;
const patchHalfWidth = 0.004;
const startX = 0.004;
const staticAngles = [42, 52];
const frameRate = 120;
const [selection = 'all', seconds = '0.5'] = process.argv.slice(2);
const maxTime = Number(seconds);
assert.ok(
  ['all', 'low', 'high'].includes(selection) && maxTime >= 0.5 && maxTime <= 3,
  'Use [all|low|high] [0.5–3 seconds].',
);

// Two individually measured 10 cP downward-triangle centers in Fig. 7 (no regression line).
// PDF occupied markers span 2.776 pt in x and y. Plot corners x=185.323–351.887 pt,
// y=231.359–64.794 pt map to Bo_alpha=0–1.4 and Ca=0–0.015. Use one marker half-width
// (0.012 on Bo_alpha and 0.000126 on Ca, rounded up) for an independent readout allowance.
const observations = [
  { name: 'low', bond: 0.33444, capillary: 0.00125 },
  { name: 'high', bond: 0.94889, capillary: 0.005333 },
];

function tilt(bond, volumeM3 = volume, densityKgM3 = density, tensionNm = tension) {
  return Math.asin((bond * tensionNm) / (volumeM3 ** (2 / 3) * densityKgM3 * gravity));
}

function capDepth(nx, ny, spacing, precursor, angle) {
  // Start from a spherical cap. Only volume and the midpoint of the quasi-static angles set its shape.
  // The discretized excess is renormalized to the independently measured volume.
  const cosine = Math.cos(angle);
  const capRadius = Math.cbrt((3 * volume) / (Math.PI * (1 - cosine) ** 2 * (2 + cosine)));
  const rim = capRadius * Math.sin(angle);
  const depth = Float64Array.from({ length: nx * ny }, (_, index) => {
    const x = ((index % nx) + 0.5) * spacing - startX;
    const y = (Math.floor(index / nx) + 0.5) * spacing;
    const square = x * x + y * y;
    return square < rim * rim ? Math.sqrt(capRadius * capRadius - square) - capRadius * cosine : 0;
  });
  const scale = volume / (spacing * spacing * depth.reduce((sum, height) => sum + height, 0));
  return depth.map((height) => precursor + (scale * height) / 2);
}

function sampleDrop(film, backing, nx, spacing, volumeM3) {
  const depth = film.depths();
  const blank = backing.depths();
  let moment = 0;
  let height = 0;
  let edge = 0;
  for (let index = 0; index < depth.length; index++) {
    const x = index % nx;
    const excess = depth[index] - blank[x];
    moment += ((x + 0.5) * spacing - startX) * excess;
    height = Math.max(height, excess);
    if (x === 0 || x === nx - 1 || index >= depth.length - nx) edge += Math.abs(excess);
  }
  const area = spacing * spacing;
  return { x: (area * moment) / volumeM3, height, edgeFraction: (area * edge) / volumeM3 };
}

async function simulate({ angle, spacing, precursor }) {
  const nx = Math.round(patchLength / spacing);
  const ny = Math.round(patchHalfWidth / spacing);
  const [receding, advancing] = staticAngles.map((value) => value * degree);
  const contactAngle = (receding + advancing) / 2;
  // A reflection boundary at y=0 computes half of the symmetric drop. Seed with the full
  // volume's cap radius and transport half the independently measured volume on this patch.
  const halfVolume = volume / 2;
  const film = await ThinFilmSolver.load({ id: 'drop' });
  const backing = await ThinFilmSolver.load({ id: 'backing' });
  const options = {
    cells: [nx, ny],
    spacing,
    u: [Math.cos(angle), -Math.sin(angle), 0],
    density,
    viscosity,
    surfaceTension: tension,
    wetting: { contactAngle, precursorDepth: precursor },
    contactAngleHysteresis: [receding, advancing],
  };
  const world = new PhysicsWorld({ rate: { num: frameRate, den: 1 }, gravity: [0, -gravity, 0] })
    .add(film, { ...options, depth: capDepth(nx, ny, spacing, precursor, contactAngle) })
    // The matched blank stays uniform across the span by reflection symmetry.
    .add(backing, { ...options, cells: [nx, 1], depth: precursor });
  const initial = sampleDrop(film, backing, nx, spacing, halfVolume);
  const ticks = [];
  let previous = initial;
  let elapsedSeconds = 0;
  let frame = 0;
  let lastSpeed = 0;
  // The lab reaches terminal velocity within a few mm. Check two adjacent 2 mm windows
  // and report no terminal estimate if even these finite travel windows cannot be completed.
  for (frame = 3; frame <= frameRate * maxTime; frame += 3) {
    world.advance(frame);
    elapsedSeconds = frame / frameRate;
    const next = sampleDrop(film, backing, nx, spacing, halfVolume);
    while (ticks.length < 3 && next.x - initial.x >= (ticks.length + 1) * 0.002) {
      const crossingX = initial.x + (ticks.length + 1) * 0.002;
      const fraction = (crossingX - previous.x) / (next.x - previous.x);
      ticks.push((frame - 3 + 3 * fraction) / frameRate);
    }
    lastSpeed = ((next.x - previous.x) * frameRate) / 3;
    previous = next;
    if (ticks.length === 3) break;
  }
  const initialVolume = film.budget.initial - ny * backing.budget.initial;
  const difference = film.budget.stored - ny * backing.budget.stored - initialVolume;
  assert.ok(Math.abs(difference) < halfVolume * 1e-7, 'Conserve the difference from the matched backing-only run.');
  const travelSpeeds = ticks.slice(1).map((tick, index) => 2 / (tick - ticks[index]));
  // Window difference is a reported transient residual, not an extra measurement allowance.
  return {
    spacingMM: spacing * 1e3,
    precursorUM: precursor * 1e6,
    downPlaneTravelMM: (previous.x - initial.x) * 1e3,
    peakMM: previous.height * 1e3,
    edgeFraction: previous.edgeFraction,
    elapsedSeconds,
    crossingSeconds: ticks,
    windowSpeedsMMs: travelSpeeds,
    tailSpeedMMs: lastSpeed * 1e3,
  };
}

for (const { name, bond, capillary } of observations) {
  if (selection !== 'all' && selection !== name) continue;
  const angle = tilt(bond);
  const lowerAngle = tilt(bond - 0.012, volume + 0.2e-9, density + 2, tension - 0.00005);
  const upperAngle = tilt(bond + 0.012, volume - 0.2e-9, density - 2, tension + 0.00005);
  // Ca to speed includes symbol size, the measured ±0.2 mPa s viscosity range and half a surface-tension digit.
  // No run-to-run speed sampling uncertainty was reported. These are readout/parameter bands, not confidence intervals.
  const observedMMs = (capillary * tension * 1e3) / viscosity;
  const measuredBandMMs = [
    ((capillary - 0.000126) * (tension - 0.00005) * 1e3) / 0.0102,
    ((capillary + 0.000126) * (tension + 0.00005) * 1e3) / 0.0098,
  ];
  const comparison = {
    case: name,
    bond,
    angleDegrees: angle / degree,
    angleDegreesRange: [lowerAngle / degree, upperAngle / degree],
    observedMMs,
    measuredBandMMs,
  };
  for (const { spacing, precursor } of [
    { spacing: 0.0005, precursor: 80e-6 },
    { spacing: 1 / 3000, precursor: 80e-6 },
    { spacing: 1 / 3000, precursor: 40e-6 },
  ]) {
    console.log(JSON.stringify({ ...comparison, result: await simulate({ angle, spacing, precursor }) }));
  }
}
