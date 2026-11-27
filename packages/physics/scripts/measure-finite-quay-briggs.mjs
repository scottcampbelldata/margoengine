// npm run build --workspace @margoengine/physics
// node scripts/run-with-timeout.mjs --max 4 -- node packages/physics/scripts/measure-finite-quay-briggs.mjs
// Optional --grid=coarse or --grid=fine selects one of the two fixed grid sizes.
// Optional --horizontal-order=4 uses the higher-order interior stencil with its matching incident carrier.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FiniteQuayWake } from '../dist/loads.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

// Briggs, Thompson and Vincent (1995), Fig. 2 and Tables 1 to 4, case M4.
// Coordinates are metres from the wall tip. The wall heads +X and waves travel −Z.
const m4 = {
  paper: 'https://doi.org/10.1061/(ASCE)0733-950X(1995)121:1(23)',
  g: 9.81,
  density: 1000,
  depth: 0.46,
  height: 0.0901,
  period: 1.32,
  directionalHalfWidthDeg: 2,
  basin: [35, 29],
  wallLength: 18.22,
  paddleWidth: 27.43,
  approach: 8.38,
  duration: 14,
  fps: 60,
  pulseSigma: 1.75,
  spongeMetres: 3,
  spongeRate: 3,
  nominalWavelength: 2.25,
};
const transects = [
  {
    bearing: 30,
    samples: [
      [0.58, 0.34, 0.29],
      [0.89, 0.51, 0.24],
      [1.18, 0.68, 0.21],
      [1.47, 0.85, 0.17],
      [1.76, 1.02, 0.17],
      [2.05, 1.19, 0.16],
      [2.35, 1.36, 0.16],
      [2.66, 1.53, 0.15],
    ],
  },
  {
    bearing: 60,
    samples: [
      [0.17, 0.29, 0.41],
      [0.34, 0.58, 0.36],
      [0.51, 0.89, 0.3],
      [0.68, 1.18, 0.27],
      [0.85, 1.47, 0.24],
      [1.02, 1.76, 0.22],
      [1.19, 2.05, 0.21],
      [1.36, 2.35, 0.19],
      [1.53, 2.66, 0.17],
    ],
  },
  {
    bearing: 90,
    samples: [
      [0, 0.34, 0.55],
      [0, 0.67, 0.51],
      [0, 1.03, 0.44],
      [0, 1.36, 0.41],
      [0, 1.7, 0.43],
      [0, 2.04, 0.49],
      [0, 2.37, 0.52],
      [0, 2.72, 0.58],
      [0, 3.07, 0.55],
    ],
  },
];
// The solver receives only the gauge coordinates. The third column is read when scoring.
const sensors = transects.flatMap(({ bearing, samples }) =>
  samples.map(([x, z]) => ({ bearing, x: x * m4.nominalWavelength, z: -z * m4.nominalWavelength })),
);
const omega = (2 * Math.PI) / m4.period;
const dt = 1 / m4.fps;

function gridAt(cellSize, layers) {
  const cells = m4.basin.map((length) => Math.round(length / cellSize));
  const origin = [
    -Math.round((m4.basin[0] - m4.wallLength) / cellSize) * cellSize,
    -Math.round((m4.basin[1] - m4.approach) / cellSize) * cellSize,
  ];
  const depths = Array.from({ length: layers + 1 }, (_, i) => (m4.depth * i) / layers);
  return { cells, cellSize, origin, depths };
}

function incidentPacket({ cells, cellSize, origin, depths, horizontalOrder }) {
  const dy = depths[1];
  const rate = (k) => {
    const secondOrder = (2 / cellSize) * Math.sin((k * cellSize) / 2);
    const horizontal =
      horizontalOrder === 4 ? secondOrder * Math.sqrt(1 + (cellSize * secondOrder) ** 2 / 12) : secondOrder;
    const alpha = Math.acosh(1 + 0.5 * (horizontal * dy) ** 2) / dy;
    return Math.sqrt(m4.g * (2 / dy) * Math.tanh(alpha * m4.depth) * Math.tanh((alpha * dy) / 2));
  };
  let low = 2;
  let high = 4;
  for (let j = 0; j < 42; j++) {
    const k = 0.5 * (low + high);
    if ((2 / dt) * Math.atan(0.5 * dt * rate(k)) < omega) low = k;
    else high = k;
  }
  const carrier = (low + high) / 2;

  // The measured height and period set the carrier. A fixed incident packet
  // replaces the unpublished paddle history. Normal incidence, fresh water and
  // the perimeter sponge are fixed assumptions. The lab also had horsehair
  // absorption on the seaward side and recorded a 2° directional half-width.
  const step = Math.PI / 100;
  const modes = [];
  for (let k = step; k < Math.min(10, Math.PI / cellSize); k += step) {
    const weight =
      (m4.height / 2) *
      ((m4.pulseSigma * step) / Math.sqrt(2 * Math.PI)) *
      Math.exp(-0.5 * (m4.pulseSigma * (k - carrier)) ** 2);
    modes.push([k, weight, (weight * m4.g) / rate(k)]);
  }
  const bins = Array.from({ length: cells[1] }, (_, i) => {
    const z = origin[1] + (i + 0.5) * cellSize;
    let height = 0;
    let potential = 0;
    for (const [k, weight, amplitude] of modes) {
      const phase = k * (z - m4.approach / 2);
      height += weight * Math.cos(phase);
      potential -= amplitude * Math.sin(phase);
    }
    return [height, potential];
  });
  return {
    carrier,
    initial(x, z) {
      const fade = Math.min(1, Math.max(0, (m4.paddleWidth / 2 - Math.abs(x)) / (Math.PI / carrier)));
      const weight = 0.5 * (1 - Math.cos(Math.PI * fade));
      const [height, potential] = bins[Math.floor((z - origin[1]) / cellSize)];
      return [weight * height, weight * potential];
    },
  };
}

function run(grid, initial, barrier) {
  const {
    cells: [nx, nz],
    cellSize,
    depths,
    origin,
  } = grid;
  const plane = nx * nz,
    layers = depths.length - 1;
  const tip = -Math.round(origin[0] / cellSize);
  const wallRow = -Math.round(origin[1] / cellSize) - 1;
  const openZ = new Float64Array(plane * layers).fill(1);
  // The plywood at the tip is 1.27 cm thick. The thin-wall model puts it on
  // the face at z=0 throughout the measured depth and opens round x=0.
  if (barrier)
    for (let layer = 0; layer < layers; layer++) {
      const start = wallRow * nx + layer * plane;
      openZ.fill(0, start + tip, start + nx);
    }
  const world = new PhysicsWorld({ rate: { num: m4.fps, den: 1 }, gravity: [0, -m4.g, 0], memory: worldMemory(false) });
  const wake = new FiniteQuayWake();
  world.add(wake, {
    ...grid,
    density: m4.density,
    initial,
    openZ,
    sponge: { cells: Math.round(m4.spongeMetres / cellSize), rate: m4.spongeRate },
  });
  const gauge = { height: 0, slope: [0, 0], velocity: [0, 0, 0] };
  const traces = sensors.map(() => new Float64Array(m4.duration * m4.fps + 1));
  const initialEnergy = wake.energy();
  let maxEnergyResidual = 0,
    maxIterations = 0,
    sumIterations = 0;
  for (let tick = 0; tick < traces[0].length; tick++) {
    if (tick > 0) world.advance(tick);
    sensors.forEach(({ x, z }, i) => {
      traces[i][tick] = wake.sample(x, z, gauge).height;
    });
    const { iterations, absorbedJoules } = wake.work();
    maxIterations = Math.max(maxIterations, iterations);
    sumIterations += iterations;
    maxEnergyResidual = Math.max(maxEnergyResidual, Math.abs(wake.energy() + absorbedJoules - initialEnergy));
  }
  assert.ok(maxEnergyResidual < 1e-8 * initialEnergy);
  const solvedTicks = m4.duration * m4.fps;
  const checkpoint = world.takeSnapshot();
  world.advance(solvedTicks + 2);
  const replayHash = world.hash();
  world.restoreSnapshot(checkpoint.bytes);
  world.advance(solvedTicks + 2);
  assert.equal(world.hash(), replayHash);
  const edgeCount = ((nx - 1) * nz + nx * (nz - 1) - (barrier ? nx - tip : 0)) * layers + plane * (layers - 1);
  return {
    traces,
    diagnostics: {
      initialEnergy,
      maxEnergyResidual,
      maxIterations,
      sumIterations,
      solvedTicks,
      edgeCount,
      fineEdgeVisits: edgeCount * (3 * sumIterations + 2 * solvedTicks),
      replayHash,
    },
  };
}

function phasorMagnitude(trace, ticks) {
  let real = 0;
  let imaginary = 0;
  for (let i = 0; i <= ticks; i++) {
    const trapezoid = i === 0 || i === ticks ? 0.5 : 1;
    real += Math.cos(omega * i * dt) * trace[i] * trapezoid;
    imaginary += Math.sin(omega * i * dt) * trace[i] * trapezoid;
  }
  return dt * Math.hypot(real, imaginary);
}

function compare(name, cellSize, layers, horizontalOrder) {
  const grid = { ...gridAt(cellSize, layers), horizontalOrder };
  const { carrier, initial } = incidentPacket(grid);
  const wall = run(grid, initial, true);
  const open = run(grid, initial, false);
  const measurements = transects.flatMap(({ samples }) => samples.map((point) => point[2]));
  const windows = [8, 10, 12, 14].map((seconds) => {
    const rows = sensors.map((sensor, i) => {
      const count = seconds * m4.fps;
      const lee = phasorMagnitude(wall.traces[i], count);
      const incident = phasorMagnitude(open.traces[i], count);
      assert.ok(incident > 0 && Number.isFinite(lee));
      return { ...sensor, lee, incident, ratio: lee / incident, measured: measurements[i] };
    });
    const error = (data) => {
      const residuals = data.map((point) => point.ratio - point.measured);
      const square = residuals.reduce((sum, value) => sum + value ** 2, 0);
      return { rms: Math.sqrt(square / data.length), maximum: Math.max(...residuals.map(Math.abs)) };
    };
    return {
      seconds,
      rows,
      all: error(rows),
      transects: transects.map(({ bearing }) => ({
        bearing,
        ...error(rows.filter((row) => row.bearing === bearing)),
      })),
    };
  });
  return { name, ...grid, layers, carrier, wall: wall.diagnostics, open: open.diagnostics, windows };
}

const sizes = [
  ['coarse', 0.5, 4],
  ['fine', 0.25, 6],
];
const args = process.argv.slice(2);
assert.ok(
  args.every((arg) => /^--grid=(coarse|fine)$|^--horizontal-order=[24]$/.test(arg)),
  'Use --grid=coarse or --grid=fine and --horizontal-order=2 or --horizontal-order=4.',
);
const argument = args.find((arg) => arg.startsWith('--grid='));
const selected = argument ? sizes.filter(([name]) => argument === `--grid=${name}`) : sizes;
const horizontalOrder = args.includes('--horizontal-order=4') ? 4 : 2;
const solver = createHash('sha256')
  .update(readFileSync(new URL('../dist/loads.js', import.meta.url)))
  .digest('hex');
console.log(
  JSON.stringify({ inputs: m4, solver, results: selected.map((size) => compare(...size, horizontalOrder)) }, null, 2),
);
