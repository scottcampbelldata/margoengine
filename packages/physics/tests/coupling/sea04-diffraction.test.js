import assert from 'node:assert/strict';
import test from 'node:test';
import { FiniteQuayWake } from '../../dist/loads.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { cylinderMode } from './fixtures/sea04-diffraction-cylinder.js';

const gravity = 9.81;
const amplitude = 0.025;
const depth = 0.25;
const wavelength = 1;
const waveNumber = (2 * Math.PI) / wavelength;
const frequency = Math.sqrt(gravity * waveNumber * Math.tanh(waveNumber * depth));
const rate = 32;
const modeTicks = [4, 8];

function fresnel(argument, intervals = 384) {
  const step = argument / intervals;
  let c = 1;
  let s = 0;
  for (let j = 1; j <= intervals; j++) {
    const angle = (Math.PI / 2) * (j * step) ** 2;
    const weight = j === intervals ? 1 : j % 2 === 0 ? 2 : 4;
    c += weight * Math.cos(angle);
    s += weight * Math.sin(angle);
  }
  return [(c * step) / 3, (s * step) / 3];
}

// Penney & Price (1952), DOI 10.1098/rsta.1952.0003.
// Takayama & Kamiyama (1977), eqs. 25–27, gives the two Fresnel terms.
// The screen starts at (0, 0) and extends in +X. Reflect the published
// coordinates in Z and conjugate its convention, so a unit plane wave travels
// from negative Z and physical elevation is the real part of U exp(−i omega t).
function thinScreen(x, z, intervals, k = waveNumber) {
  const radius = Math.hypot(x, z);
  const azimuth = z > 0 ? 2 * Math.PI + Math.atan2(-z, x) : Math.atan2(-z, x);
  let real = 0;
  let imaginary = 0;
  for (const angle of [azimuth - Math.PI / 2, azimuth + Math.PI / 2]) {
    const argument = Math.sqrt((4 * k * radius) / Math.PI) * Math.cos(angle / 2);
    const [c, s] = fresnel(argument, intervals);
    const coefficientReal = (1 + c + s) / 2;
    const coefficientImaginary = (c - s) / 2;
    const phase = k * radius * Math.cos(angle);
    const cosine = Math.cos(phase);
    const sine = Math.sin(phase);
    real += coefficientReal * cosine - coefficientImaginary * sine;
    imaginary += coefficientReal * sine + coefficientImaginary * cosine;
  }
  return [real, -imaginary];
}

function initialEnvelope(x, z) {
  const distance = Math.min(3 - Math.abs(x), 3 - Math.abs(z));
  return distance >= 1 ? 1 : (1 - Math.cos(Math.PI * distance)) / 2;
}

const screenProbes = [
  [-1.3, -0.45],
  [-1.3, 0.45],
  [-0.55, -0.25],
  [-0.55, 0.25],
  [0.55, -0.25],
  [0.55, 0.25],
  [1.3, -0.15],
  [1.3, 0.15],
  [1.3, -0.65],
  [1.3, 0.65],
];

function recoverPhasor(first, second) {
  const [a, b] = modeTicks.map((tick) => (frequency * tick) / rate);
  const denominator = amplitude * Math.sin(b - a);
  return [
    (first * Math.sin(b) - second * Math.sin(a)) / denominator,
    (second * Math.cos(a) - first * Math.cos(b)) / denominator,
  ];
}

function assessMode(cellSize, layers, probes, reference, geometry) {
  const extent = Math.round(6 / cellSize);
  const cells = [extent, extent];
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const wake = new FiniteQuayWake();
  world.add(wake, {
    cells,
    cellSize,
    origin: [-3, -3],
    depths: Array.from({ length: layers + 1 }, (_, layer) => (depth * layer) / layers),
    initial(x, z) {
      const weight = amplitude * initialEnvelope(x, z);
      if (weight === 0) return [0, 0];
      const [real, imaginary] = reference(x, z);
      return [weight * real, (weight * gravity * imaginary) / frequency];
    },
    ...geometry(extent, layers, cellSize),
  });
  const initialEnergy = wake.energy();
  const snapshot = world.takeSnapshot();
  const readings = modeTicks.map((tick) => {
    world.advance(tick);
    return probes.map(([x, z]) => wake.sample(x, z).height);
  });
  const phasors = probes.map((_, i) => recoverPhasor(readings[0][i], readings[1][i]));
  const errors = probes.map(([x, z], i) => {
    const [real, imaginary] = phasors[i];
    const [referenceReal, referenceImaginary] = reference(x, z);
    return Math.hypot(real - referenceReal, imaginary - referenceImaginary);
  });
  assert.ok(Math.abs(wake.energy() - initialEnergy) < 1e-9 * initialEnergy);
  return { errors, phasors, wake, world, snapshot };
}

function screenFaces(extent, layers) {
  return { openZ: singleTipFaces(extent, extent, layers, extent / 2 - 1) };
}

function singleTipFaces(nx, nz, layers, rowBelow) {
  const plane = nx * nz;
  const openZ = new Float64Array(layers * plane).fill(1);
  for (let layer = 0; layer < layers; layer++) {
    const row = layer * plane + rowBelow * nx;
    openZ.fill(0, row + nx / 2, row + nx);
  }
  return openZ;
}

function rms(values) {
  return Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length);
}

test('SEA-04 advances the complex Penney–Price tip mode through the connected finite-quay grid', (t) => {
  for (const [x, z] of screenProbes) {
    const coarse = thinScreen(x, z, 384);
    const fine = thinScreen(x, z, 768);
    assert.ok(Math.hypot(coarse[0] - fine[0], coarse[1] - fine[1]) < 1e-7);
  }
  // This is a normal-mode propagation test. Initialize the analytic field,
  // then advance without gauge, edge, or wavemaker forcing.
  const coarse = assessMode(1 / 8, 4, screenProbes, thinScreen, screenFaces);
  const fine = assessMode(1 / 12, 6, screenProbes, thinScreen, screenFaces);
  const open = assessMode(1 / 12, 6, screenProbes, thinScreen, () => ({}));
  const coarseError = rms(coarse.errors);
  const fineError = rms(fine.errors);
  const openError = rms(open.errors);
  t.diagnostic(JSON.stringify({ coarseError, fineError, openError, maximumFineError: Math.max(...fine.errors) }));
  assert.ok(fineError < 0.055, 'fine complex RMS relative to the incident amplitude');
  assert.ok(Math.max(...fine.errors) < 0.09, 'individual fine complex errors');
  assert.ok(fineError < 0.72 * coarseError, 'complex error decreases under horizontal and vertical refinement');
  assert.ok(openError > 4 * fineError, 'opening the screen destroys the reference mode');
  const x = fine.wake.grid.cells[0];
  const mask = fine.wake.surfaceMask();
  const face = (x / 2 - 1) * x;
  assert.equal(mask[face + x / 2] & 4, 0);
  assert.equal(mask[face + x / 2 - 1] & 4, 4);
  assert.equal(open.wake.surfaceMask()[face + x / 2] & 4, 4);
  const hash = fine.world.hash();
  fine.world.restoreSnapshot(fine.snapshot.bytes);
  fine.world.advance(modeTicks.at(-1));
  assert.equal(fine.world.hash(), hash);
});

function makePacket() {
  const sigma = 0.36;
  const centre = -2.1;
  const interval = 0.125;
  return Array.from({ length: 144 }, (_, i) => {
    const k = (i + 0.5) * interval;
    const omega = Math.sqrt(gravity * k * Math.tanh(k * depth));
    const weight = (sigma * interval * Math.exp(-0.5 * (sigma * (k - waveNumber)) ** 2)) / Math.sqrt(2 * Math.PI);
    return { k, omega, phase: -k * centre, weight };
  });
}

function propagatePacket(cellSize, layers, packet, probes, ticks, barrier) {
  const nx = Math.round(8 / cellSize);
  const nz = Math.round(7 / cellSize);
  const rowBelow = Math.round(4 / cellSize) - 1;
  const openZ = barrier ? singleTipFaces(nx, nz, layers, rowBelow) : undefined;
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const wake = new FiniteQuayWake();
  const incidentRows = Array.from({ length: nz }, (_, row) => {
    const z = -4 + (row + 0.5) * cellSize;
    let eta = 0;
    let potential = 0;
    for (const { k, omega, phase, weight } of packet) {
      eta += weight * Math.cos(k * z + phase);
      potential += (weight * gravity * Math.sin(k * z + phase)) / omega;
    }
    return [eta, potential];
  });
  world.add(wake, {
    cells: [nx, nz],
    cellSize,
    origin: [-4, -4],
    depths: Array.from({ length: layers + 1 }, (_, layer) => (depth * layer) / layers),
    initial(x, z) {
      const fade = Math.min(1, Math.max(0, 4 - Math.abs(x)), Math.max(0, (z + 4) / 0.6), Math.max(0, -2 * z));
      const taper = (1 - Math.cos(Math.PI * fade)) / 2;
      const [eta, potential] = incidentRows[Math.floor((z + 4) / cellSize)];
      return [amplitude * taper * eta, amplitude * taper * potential];
    },
    openZ,
    horizontalOrder: 4,
    sponge: { cells: Math.round(0.75 / cellSize), rate: 3 },
  });
  const energy = wake.energy();
  const traces = ticks.map((tick) => {
    world.advance(tick);
    return probes.map(([x, z]) => wake.sample(x, z).height / amplitude);
  });
  assert.ok(Math.abs(wake.energy() + wake.work().absorbedJoules - energy) < 1e-8 * energy);
  return traces;
}

test('SEA-04 diffracts a free incident wave packet into the lee of the single-tip screen', (t) => {
  // Launch only the incoming plane packet upstream of the screen. Reconstruct
  // the independent propagating reference by integrating the continuum
  // diffraction solution over the identical incident spectrum.
  const packet = makePacket();
  const probes = [
    [-0.6, 0.35],
    [0.35, 0.35],
    [0.85, 0.45],
    [1.4, 0.35],
    [0.35, -0.35],
    [0.85, -0.45],
  ];
  const ticks = Array.from({ length: 23 }, (_, i) => 62 + 2 * i);
  const reference = (withScreen) => {
    const coefficients = probes.map(([x, z]) =>
      packet.map(({ k }) => (withScreen ? thinScreen(x, z, 384, k) : [Math.cos(k * z), Math.sin(k * z)])),
    );
    return ticks.map((tick) =>
      coefficients.map((probe) =>
        probe.reduce((sum, [real, imaginary], j) => {
          const { phase, omega, weight } = packet[j];
          const angle = (omega * tick) / rate - phase;
          return sum + weight * (real * Math.cos(angle) + imaginary * Math.sin(angle));
        }, 0),
      ),
    );
  };
  const closedReference = reference(true);
  const openReference = reference(false);
  const closed = propagatePacket(1 / 8, 6, packet, probes, ticks, true);
  const open = propagatePacket(1 / 8, 6, packet, probes, ticks, false);
  const error = (observed, target) => rms(observed.flatMap((row, i) => row.map((height, j) => height - target[i][j])));
  const closedError = error(closed, closedReference);
  const openError = error(open, openReference);
  const wrongGeometryError = error(open, closedReference);
  t.diagnostic(JSON.stringify({ closedError, openError, wrongGeometryError, observedDifference: error(closed, open) }));
  assert.ok(closedError < 0.125 && openError < 0.115, 'first-pass gauge traces relative to initial incident amplitude');
  assert.ok(wrongGeometryError > 2.8 * closedError, 'open water loses the analytic tip diffraction pattern');
});

test('SEA-04 advances MacCamy–Fuchs complex cylinder run-up on the full-depth finite-quay grid', (t) => {
  const radius = 0.5;
  const field = cylinderMode(waveNumber, radius);
  const surface = radius + 1e-10;
  const probes = [
    [-surface, 0],
    [surface, 0],
    [0, surface],
    [-0.55, 0.25],
    [0.55, 0.25],
    [1, 0.75],
  ];
  // Independent SciPy jvp/h1vp and the 50-order sum, frozen at k*a = pi.
  const runUp = [1.9075150980183362, 0.6106740950432151, 1.3547076088013155];
  probes.slice(0, 3).forEach(([x, z], i) => assert.ok(Math.abs(Math.hypot(...field(x, z)) - runUp[i]) < 1e-10));
  const cylinder = (extent, layers, cellSize) => {
    const plane = extent ** 2;
    const wet = Uint8Array.from({ length: plane * layers }, (_, i) => {
      const x = (i % extent) + 0.5 - extent / 2;
      const z = Math.floor((i % plane) / extent) + 0.5 - extent / 2;
      return Number(Math.hypot(x, z) * cellSize >= radius);
    });
    return { wet };
  };
  const coarse = assessMode(1 / 8, 4, probes, field, cylinder);
  const fine = assessMode(1 / 12, 6, probes, field, cylinder);
  const open = assessMode(1 / 12, 6, probes, field, () => ({}));
  const coarseError = rms(coarse.errors);
  const fineError = rms(fine.errors);
  const openError = rms(open.errors);
  const observed = fine.phasors.slice(0, 3).map(([real, imaginary]) => Math.hypot(real, imaginary));
  t.diagnostic(
    JSON.stringify({ coarseError, fineError, openError, runUp: observed, maximumFineError: Math.max(...fine.errors) }),
  );
  // The circular obstacle is a stair-step wet mask on these meshes. Compare
  // complex gauge error, convergence, and the front, rear and flank run-up.
  assert.ok(fineError < 0.095 && Math.max(...fine.errors) < 0.125);
  assert.ok(fineError < 0.8 * coarseError && openError > 5 * fineError);
  observed.forEach((value, i) =>
    assert.ok(Math.abs(value - runUp[i]) < 0.06, 'cylinder run-up amplitude at a face gauge'),
  );
  assert.equal(fine.wake.wet(0, 0), false);
  assert.equal(open.wake.wet(0, 0), true);
});
