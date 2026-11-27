// npm run build --workspace @margoengine/physics
// node scripts/run-with-timeout.mjs --max 2 -- node packages/physics/scripts/measure-finite-quay-dispersion.mjs

import assert from 'node:assert/strict';
import { FiniteQuayWake, QuayPotential } from '../dist/loads.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const gravity = 9.81;
const depth = 9.7;
const tick = 1 / 60;
const one = [1];
const two = [0.5, 0.5];
// Yoshida (1990), symmetric composition of the reversible midpoint step.
// DOI 10.1016/0375-9601(90)90092-3. Damping and source impulses remain outside it.
const a = 1 / (2 - Math.cbrt(2));
const fourth = [a, 1 - 2 * a, a];
const profiles = [
  { name: '13 layers', faces: [0, 0.035, 0.075, 0.13, 0.21, 0.32, 0.5, 0.79, 1.24, 1.94, 3.05, 5.03, 7.221, 9.7] },
  { name: '29 layers', faces: stretch(0.015, 1.18) },
  { name: '42 layers', faces: stretch(0.01, 1.12) },
];

function stretch(first, growth) {
  const faces = [0];
  let thickness = first;
  for (const anchor of [5.03, 7.221, depth]) {
    while (faces.at(-1) < anchor) {
      const previous = faces.at(-1);
      faces.push(anchor - previous < 1.4 * thickness ? anchor : previous + thickness);
      thickness *= growth;
    }
  }
  return faces;
}

function increasingRoot(low, high, fn, target) {
  for (let i = 0; i < 52; i++) {
    const middle = (low + high) / 2;
    if (fn(middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

// Reference ray from the corrected First Wake course at film 71 s
// (vessel time 66.75 s). The emit point is the near side of the archived
// geometry-derived hull, at local x=30 m and still-water depth 0.5 m.
// Pethiyagoda et al. (2022), eqs. (10)–(15), arxiv.org/abs/2107.09195.
const emit = [99.07711684457344, 8.024828738960657];
const velocity = [2.859789554298686, 0.2601922848361582];
const receive = [112, -10.549692];
const chord = receive.map((value, i) => value - emit[i]);
const distance = Math.hypot(...chord);
const direction = chord.map((value) => value / distance);
const c = (chord[0] * velocity[0] + chord[1] * velocity[1]) / distance;
const carrier = increasingRoot(0, gravity / (c * c), (k) => k * c * c - gravity * Math.tanh(depth * k), 0);
const continuous = (k, h = depth) => k * Math.tanh(k * h);
const angularFrequency = Math.sqrt(gravity * continuous(carrier));
const tanh = Math.tanh(carrier * depth);
const group = (gravity * (tanh + carrier * depth * (1 - tanh * tanh))) / (2 * angularFrequency);
const travelTime = distance / group;

function horizontal(kx, kz, dx, order) {
  return Math.sqrt(
    [kx, kz].reduce((sum, k) => {
      const symbol = (2 * Math.sin((k * dx) / 2)) ** 2;
      return sum + (symbol + (order === 4 ? symbol ** 2 / 12 : 0)) / dx ** 2;
    }, 0),
  );
}

function layeredDtn(k, faces) {
  let admittance = 0;
  let previous = 0;
  for (let i = faces.length - 1; i > 0; i--) {
    const dy = faces[i] - faces[i - 1];
    const conductance = 2 / (previous + dy);
    admittance = k * k * dy + (conductance * admittance) / (conductance + admittance);
    previous = dy;
  }
  const surface = 2 / previous;
  return (surface * admittance) / (surface + admittance);
}

function midpointFrequency(omega, stages) {
  return (2 / tick) * stages.reduce((sum, stage) => sum + Math.atan((omega * tick * stage) / 2), 0);
}

function phase(dx, depths, horizontalOrder = 2) {
  const kh = (k) => horizontal(k * direction[0], k * direction[1], dx, horizontalOrder);
  const omega = (k) => Math.sqrt(gravity * layeredDtn(kh(k), depths));
  const at = (model) => increasingRoot(carrier / 2, 2 * carrier, model, angularFrequency);
  const horizontalOnly = at((k) => Math.sqrt(gravity * continuous(kh(k))));
  const semiDiscrete = at(omega);
  const shift = (stage) => distance * (at((k) => midpointFrequency(omega(k), stage)) - semiDiscrete);
  const horizontalPhase = distance * (horizontalOnly - carrier);
  const verticalPhase = distance * (semiDiscrete - horizontalOnly);
  const timePhase = { midpoint: shift(one), halfSteps: shift(two), fourthOrder: shift(fourth) };
  return {
    dx,
    horizontalOrder,
    horizontalPhase,
    verticalPhase,
    timePhase,
    midpointTotal: horizontalPhase + verticalPhase + timePhase.midpoint,
    fourthOrderTotal: horizontalPhase + verticalPhase + timePhase.fourthOrder,
  };
}

function live(dx, depths, temporalOrder = 2, horizontalOrder = 2) {
  // Neumann carrier within 0.1% of the reference ray. Width and length are
  // unchanged between grids, and measured phase is separate from the oracle.
  const cells = [Math.round(4.5 / dx), Math.round(3.15 / dx)];
  const [nx, nz] = cells;
  const kx = (4 * Math.PI) / (nx * dx);
  const kz = (4 * Math.PI) / (nz * dx);
  const grid = { cells, cellSize: dx, depths, horizontalOrder };
  const exact = (x, z) => Math.cos(kx * x) * Math.cos(kz * z);
  const mode = Float64Array.from({ length: nx * nz }, (_, i) =>
    exact(((i % nx) + 0.5) * dx, (Math.floor(i / nx) + 0.5) * dx),
  );
  const dtn = layeredDtn(horizontal(kx, kz, dx, horizontalOrder), depths);
  const rate = new Float64Array(nx * nz);
  const op = new QuayPotential(grid);
  op.project(mode, rate);
  const residual = rate.reduce((max, value, i) => Math.max(max, Math.abs(value - dtn * mode[i])), 0);
  assert.ok(residual < 2e-9);

  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -gravity, 0], memory: worldMemory(false) });
  const wake = new FiniteQuayWake();
  const amplitude = 0.04;
  const ticks = 12;
  world.add(wake, { ...grid, temporalOrder, initial: (x, z) => [amplitude * exact(x, z), 0] });
  const start = world.takeSnapshot();
  const startEnergy = wake.energy();
  world.advance(ticks);
  const elapsed = tick * ticks;
  const height = wake.heights();
  const measured =
    Math.acos(
      height.reduce((sum, value, i) => sum + value * mode[i], 0) /
        (amplitude * mode.reduce((sum, value) => sum + value * value, 0)),
    ) / elapsed;
  const frequency = midpointFrequency(Math.sqrt(gravity * dtn), temporalOrder === 4 ? fourth : one);
  const energyError = Math.abs(wake.energy() - startEnergy);
  assert.ok(Math.abs(frequency - measured) < 1e-9 && energyError < 1e-9);
  const hash = world.hash();
  world.restoreSnapshot(start.bytes);
  world.advance(ticks);
  assert.equal(world.hash(), hash);
  return {
    temporalOrder,
    horizontalOrder,
    dx,
    cells,
    layers: depths.length - 1,
    measured,
    frequency,
    residual,
    energyError,
    iterations: wake.work().iterations,
    hash,
  };
}

const full = profiles[1].faces;
const clip = full.slice(0, full.findIndex((value) => value >= 1.6) + 1);
const fullLive = live(0.075, full);
const clipLive = live(0.075, clip);
const fourthLive = live(0.075, clip, 4);
const lowBandK = increasingRoot(0, carrier, (k) => gravity * continuous(k), (0.9 * angularFrequency) ** 2);
const minimumDepth = clip.at(-1);
console.log(
  JSON.stringify(
    {
      reference: { emit, velocity, receive, distance, carrier, angularFrequency, travelTime },
      productionMode: [
        live(0.15, profiles[0].faces),
        live(0.075, profiles[0].faces),
        live(0.15, profiles[1].faces, 4, 4),
      ],
      phase: profiles.map(({ name, faces }) => ({
        name,
        cases: [2, 4].flatMap((order) => [0.15, 0.075, 0.05, 0.035].map((dx) => phase(dx, faces, order))),
      })),
      narrowBand: {
        minimumDepth,
        lowBandK,
        dispersionBound: 2 * Math.exp(-2 * lowBandK * minimumDepth),
        fullLive,
        clipLive,
        fourthLive,
      },
    },
    null,
    2,
  ),
);
