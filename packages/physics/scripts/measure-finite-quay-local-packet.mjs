// Requires the combined fourth-order FiniteQuayWake build, available on main at 97fe6eeca3.
// Run from the repository root on a built physics package. Each case is also runnable in isolation.
// node scripts/run-with-timeout.mjs --max=12 -- node packages/physics/scripts/measure-finite-quay-local-packet.mjs
// Optional case labels: apron, sealed, open, wide. Without a label the script runs and scores all four.
//
// The fixed ray and apron cross-section use local coordinates with the still-water face at z = 0.
// This diagnostic starts a manufactured packet 1.84 m from that point, without a hull actuator.
// Linear finite-depth modes and the no-flux plane image follow Porter & Evans, JFM 294 (1995),
// doi:10.1017/S0022112095002849. The plane image is an external reference for the stepped quay.
// The local comparison covers the incoming wave, face, reflected waveform and off-ray control.

import assert from 'node:assert/strict';
import { FiniteQuayWake, QuayPotential } from '../dist/loads.js';
import { PhysicsWorld, regionWords, worldMemory } from '../dist/world.js';

const dx = 0.15;
const steps = 240;
const recessDepth = 0.23;
const recessOffset = 0.150308162887804;
const apronBottom = 5.72;
// Positive Z is seaward. The local origin is on the surveyed still-water face.
const normal = Object.freeze([60, 36]);
const wider = Object.freeze([80, 48]);
const cases = {
  apron: ['apron', normal, 8],
  sealed: ['sealed', normal, 8],
  open: ['open', normal, 8],
  wide: ['apron', wider, 11],
};

const depths = [
  0, 0.02, 0.045, 0.075, 0.11, 0.155, 0.21, 0.28, 0.37, 0.5, 0.68, 0.92, 1.27, 1.76, 2.48, 3.58, 5.05, 5.72, 7.4, 9.7,
];
const carrier = (2 * Math.PI) / 1.2908700371131923;
const travelX = 12.922883155426561;
const travelZ = -18.574520576072853;
const norm = Math.hypot(travelX, travelZ);
const ux = travelX / norm;
const uz = travelZ / norm;
const waveCentre = [ux * -1.84, uz * -1.84];
const g = 9.81;
const dispersion = (k) => Math.sqrt(g * k * Math.tanh(k * depths.at(-1)));
const omega = dispersion(carrier);
const spectral = [];
let sum = 0;
// A bounded spectral packet with one oblique carrier, not a standing/box mode.
// Each cosine term solves finite-depth linear wave equations with the paired sine potential.
for (let i = -8; i <= 8; i++)
  for (let j = -8; j <= 8; j++) {
    const kp = carrier + i * 0.25;
    const kq = j * 0.24;
    const weight = Math.exp(-0.5 * (((i * 0.25) / 0.9) ** 2 + ((j * 0.24) / 1) ** 2));
    const kx = kp * ux - kq * uz,
      kz = kp * uz + kq * ux;
    if (kz >= 0) continue;
    spectral.push([kx, kz, dispersion(Math.hypot(kx, kz)), weight]);
    sum += weight;
  }
function packet(x, z, t, reflected = false) {
  const rx = x - waveCentre[0],
    rz = (reflected ? -z : z) - waveCentre[1];
  let h = 0,
    potential = 0;
  for (const [kx, kz, w, weight] of spectral) {
    const p = kx * rx + kz * rz - w * t;
    h += weight * Math.cos(p);
    potential += weight * (g / w) * Math.sin(p);
  }
  return [(h * 0.01) / sum, (potential * 0.01) / sum];
}

function simulate([scenario, cells, backCells]) {
  const span = cells.map((size) => size * dx);
  const origin = [-span[0] / 2, -backCells * dx];
  const [nx, nz] = cells,
    plane = nx * nz;
  const faceRow = backCells;
  assert.equal(origin[1] + faceRow * dx, 0, 'Keep the absolute quay face fixed when enlarging the grid.');
  const wet = new Uint8Array(plane * (depths.length - 1)).fill(1);
  const openZ = new Float64Array(wet.length).fill(1);
  for (let layer = 0; layer + 1 < depths.length; layer++) {
    const layerCentre = (depths[layer] + depths[layer + 1]) / 2;
    // The apron front recedes at depth 0.23 m. The aligned face differs by less than 0.00031 m.
    // The .05 m wide recess frame posts are subcell and omitted at .15 m.
    const land = faceRow - (layerCentre >= recessDepth ? Math.round(recessOffset / dx) : 0);
    if (scenario !== 'open' && (layerCentre < apronBottom || scenario === 'sealed')) {
      for (let j = 0; j < land; j++) wet.fill(0, plane * layer + nx * j, plane * layer + nx * (j + 1));
    }
    if (scenario === 'sealed') openZ.fill(0, plane * layer + nx * (land - 1), plane * layer + nx * land);
  }
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -g, 0], memory: worldMemory(false) });
  const wake = new FiniteQuayWake();
  const grid = { cells, cellSize: dx, origin, depths, wet, openZ, horizontalOrder: 4 };
  // Use the public face operator on the solver's accepted volume potential.
  const faces = scenario === 'open' ? undefined : new QuayPotential(grid);
  world.add(wake, {
    ...grid,
    temporalOrder: 4,
    sponge: { cells: Math.round(0.9 / dx), rate: 5 },
    initial: (x, z) => packet(x, z, 0),
  });
  const points = [
    ['incoming', -0.64, 1.02],
    ['face', 0.015, 0.12],
    ['return', 0.82, 1.03],
    ['control', 1.22, 1.33],
  ];
  const traces = points.map(([name, x, z]) => ({ name, x, z, rows: [] }));
  const initialEnergy = wake.energy();
  const initialVolume = wake.heights().reduce((s, h) => s + h, 0) * dx * dx;
  let maxEnergyDefect = 0,
    maxMassDefect = 0,
    maxSolidFlux = 0,
    maxGapFlux = 0,
    maxGapFluxSquared = 0,
    totalIterations = 0;
  let checkpoint;
  for (let j = 0; j <= steps; j++) {
    if (j > 0) world.advance(j);
    if (j === steps - 12) checkpoint = world.takeSnapshot();
    const time = j / 60;
    const w = wake.work();
    totalIterations += w.iterations;
    maxEnergyDefect = Math.max(maxEnergyDefect, Math.abs(wake.energy() + w.absorbedJoules - initialEnergy));
    if (j % 3 === 0) {
      maxMassDefect = Math.max(
        maxMassDefect,
        Math.abs(wake.heights().reduce((s, h) => s + h, 0) * dx * dx + w.absorbedVolume - initialVolume),
      );
      for (const sample of traces)
        sample.rows.push([
          time,
          wake.sample(sample.x, sample.z).height,
          packet(sample.x, sample.z, time)[0],
          packet(sample.x, sample.z, time, true)[0],
        ]);
      if (faces) {
        const bulk = regionWords(world.memory, wake.stateRegions()[2]);
        let stepGap2 = 0;
        for (let layer = 0; layer + 1 < depths.length; layer++) {
          const layerCentre = (depths[layer] + depths[layer + 1]) / 2;
          const land = faceRow - (layerCentre >= recessDepth ? Math.round(recessOffset / dx) : 0);
          for (let i = 0; i < nx; i++) {
            const f = faces.faceFlux('z', i + (land - 1) * nx + layer * plane, bulk);
            if (layerCentre >= apronBottom && scenario === 'apron') {
              maxGapFlux = Math.max(maxGapFlux, Math.abs(f));
              stepGap2 += f * f;
            } else maxSolidFlux = Math.max(maxSolidFlux, Math.abs(f));
          }
        }
        maxGapFluxSquared = Math.max(maxGapFluxSquared, stepGap2);
      }
    }
    if (j === 60 || j === 120 || j === 180 || j === 240) console.error(scenario, dx, j, w.iterations);
  }
  const ledger = wake.work(),
    hash = world.hash();
  assert.equal(ledger.joules, 0);
  assert.equal(ledger.displacedVolume, 0);
  if (scenario === 'apron') assert.ok(maxGapFlux > 0);
  world.restoreSnapshot(checkpoint.bytes);
  world.advance(steps);
  assert.equal(world.hash(), hash);
  assert.ok(maxSolidFlux === 0 && maxEnergyDefect < 1e-7 && maxMassDefect < 1e-9);
  return {
    dx,
    span,
    cells,
    origin,
    scenario,
    depths,
    waveCentre,
    carrier,
    omega,
    initialEnergy,
    initialVolume,
    maxEnergyDefect,
    maxMassDefect,
    maxSolidFlux,
    maxGapFlux,
    maxGapFluxSquared,
    totalIterations,
    ledger,
    hash,
    traces,
  };
}

const windows = [
  [0, 1.8],
  [1.3, 3.9],
  [2.3, 4],
  [1.2, 3.5],
];
function compare(rows, window) {
  const [from, to] = window;
  let a = 0,
    b = 0,
    c = 0,
    d = 0,
    squared = 0,
    baseline = 0,
    maxError = 0;
  for (const [t, actual, reference] of rows) {
    if (t <= from || t >= to) continue;
    const h = Math.sin((Math.PI * (t - from)) / (to - from)) ** 2;
    const u = h * Math.cos(omega * t),
      v = h * Math.sin(omega * t);
    a += u * actual;
    b += v * actual;
    c += u * reference;
    d += v * reference;
    squared += h * (actual - reference) ** 2;
    baseline += h * reference ** 2;
    maxError = Math.max(maxError, Math.abs(actual - reference));
  }
  return {
    amplitude: Math.hypot(a, b) / Math.hypot(c, d),
    phase: Math.atan2(b * c - a * d, a * c + b * d),
    relativeRms: Math.sqrt(squared / baseline),
    maxError,
  };
}

export function scoreAll({ apron, sealed, open, wide }) {
  return apron.traces.map(({ name, rows }, i) => {
    const seal = sealed.traces[i].rows,
      free = open.traces[i].rows,
      wider = wide.traces[i].rows;
    const window = windows[i];
    return {
      name,
      window,
      incident: compare(
        free.map(([t, h, ref]) => [t, h, ref]),
        window,
      ),
      totalAgainstFlatImage: compare(
        rows.map(([t, h, ref, image]) => [t, h, ref + image]),
        window,
      ),
      reflectionAgainstFlatImage: compare(
        rows.map(([t, h, , image], j) => [t, h - free[j][1], image]),
        window,
      ),
      apertureVersusSealed: compare(
        rows.map(([t, h], j) => [t, h, seal[j][1]]),
        window,
      ),
      cropSensitivity: compare(
        rows.map(([t, h], j) => [t, h, wider[j][1]]),
        window,
      ),
    };
  });
}

if (import.meta.main) {
  const choice = process.argv[2];
  assert.ok(choice === undefined || Object.hasOwn(cases, choice), 'Choose apron, sealed, open or wide.');
  if (choice) console.log(JSON.stringify(simulate(cases[choice]), null, 2));
  else {
    const runs = Object.fromEntries(Object.entries(cases).map(([name, params]) => [name, simulate(params)]));
    const scores = scoreAll(runs);
    console.log(JSON.stringify({ runs, scores }, null, 2));
  }
}
