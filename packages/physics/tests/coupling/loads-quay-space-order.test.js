import assert from 'node:assert/strict';
import test from 'node:test';
import { FiniteQuayWake, QuayPotential } from '../../dist/loads.js';
import { PhysicsWorld } from '../../dist/world.js';

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

function layeredRate(horizontal, depth, layer) {
  const alpha = (2 / layer) * Math.asinh((horizontal * layer) / 2);
  return (2 / layer) * Math.tanh(alpha * depth) * Math.tanh((alpha * layer) / 2);
}

function boxMode(n, horizontalOrder) {
  const nx = 12 * n,
    nz = 8 * n,
    dx = 0.3 / n,
    depth = 0.48,
    layer = depth / 16;
  const depths = Array.from({ length: 17 }, (_, i) => i * layer);
  const kx = (6 * Math.PI) / (nx * dx),
    kz = (2 * Math.PI) / (nz * dx);
  const trace = Float64Array.from({ length: nx * nz }, (_, i) => {
    const x = (i % nx) + 0.5,
      z = Math.floor(i / nx) + 0.5;
    return Math.cos(kx * dx * x) * Math.cos(kz * dx * z);
  });
  const wake = new QuayPotential({ cells: [nx, nz], cellSize: dx, depths, horizontalOrder });
  const rise = new Float64Array(trace.length);
  wake.project(trace, rise);
  const squared = [kx, kz].map((k) => ((2 / dx) * Math.sin((k * dx) / 2)) ** 2);
  const modified = squared.reduce((sum, k) => sum + k + (horizontalOrder === 4 ? (dx * k) ** 2 / 12 : 0), 0);
  const exactDiscrete = layeredRate(Math.sqrt(modified), depth, layer);
  const exactHorizontal = layeredRate(Math.hypot(kx, kz), depth, layer);
  assert.ok(rise.every((v, i) => Math.abs(v - exactDiscrete * trace[i]) < 2e-9));
  return Math.abs(dot(rise, trace) / dot(trace, trace) - exactHorizontal);
}

test('the finite quay fourth-order horizontal flux improves a diagonal carrier at fixed vertical resolution', (t) => {
  const second = [1, 2, 4].map((factor) => boxMode(factor, 2));
  const fourth = [1, 2, 4].map((factor) => boxMode(factor, 4));
  assert.ok(second[0] / second[1] > 3.7 && second[1] / second[2] > 3.9);
  assert.ok(fourth[0] / fourth[1] > 13 && fourth[1] / fourth[2] > 15);
  // Compare the original shot's proposed .15 m and .075 m horizontal meshes.
  assert.ok(fourth[1] < second[2]);
  t.diagnostic(JSON.stringify({ second, fourth }));
});

test('fourth-order flux stays reciprocal at a layered opening, with no gradients across a sealed face', () => {
  const cells = [11, 7],
    cellSize = 0.25,
    depths = [0, 0.12, 0.45, 1.2],
    [nx, nz] = cells,
    plane = nx * nz,
    count = plane * (depths.length - 1),
    wallX = 5;
  const openX = new Float64Array(count).fill(1);
  for (let i = 0; i < count; i++) if (i % nx === wallX) openX[i] = 0;
  const trace = Float64Array.from({ length: plane }, (_, i) => (i % nx <= wallX ? Math.sin(i + 0.5) : 0));
  const other = Float64Array.from({ length: plane }, (_, i) => (i % nx > wallX ? Math.cos(i + 0.5) : 0));
  const a = new Float64Array(plane),
    b = new Float64Array(plane),
    bulk = new Float64Array(count);
  const sealed = new QuayPotential({ cells, cellSize, depths, openX, horizontalOrder: 4 });
  sealed.project(trace, a, undefined, 0, bulk);
  assert.ok(a.every((value, i) => i % nx <= wallX || value === 0));
  assert.ok(bulk.every((value, i) => i % nx <= wallX || value === 0));

  // The lower two layers have a fractional aperture while the top remains fully sealed.
  openX[plane + 2 * nx + wallX] = 0.4;
  openX[2 * plane + 2 * nx + wallX] = 0.8;
  const open = new QuayPotential({ cells, cellSize, depths, openX, horizontalOrder: 4 });
  open.project(other, b);
  open.project(trace, a, undefined, 0, bulk);
  const pairing = dot(a, other);
  assert.ok(Math.abs(pairing) > 1e-5);
  assert.ok(Math.abs(pairing - dot(b, trace)) < 1e-10);
  assert.ok(dot(trace, a) > 0);
  for (let i = 0; i < count; i++) {
    const x = i % nx,
      z = Math.floor(i / nx) % nz;
    const fluxX = open.faceFlux('x', i, bulk),
      fluxZ = open.faceFlux('z', i, bulk),
      fluxDown = open.faceFlux('down', i, bulk);
    if (openX[i] === 0) assert.equal(fluxX, 0);
    const outward =
      fluxX +
      fluxZ +
      fluxDown -
      (x === 0 ? 0 : open.faceFlux('x', i - 1, bulk)) -
      (z === 0 ? 0 : open.faceFlux('z', i - nx, bulk)) -
      (i < plane ? 0 : open.faceFlux('down', i - plane, bulk));
    assert.ok(Math.abs(outward + (i < plane ? a[i] * cellSize ** 2 : 0)) < 1e-10);
  }

  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  const wake = new FiniteQuayWake();
  world.add(wake, {
    cells,
    cellSize,
    depths,
    openX,
    horizontalOrder: 4,
    pressureAtDepth: true,
    initial: (x, z) => [0.01 * Math.exp(-((x - 1) ** 2 + (z - 0.8) ** 2) / 0.2), 0],
    sponge: { cells: 2, rate: 1.5 },
  });
  const energy = wake.energy(),
    snapshot = world.takeSnapshot();
  world.advance(40);
  assert.ok(wake.work().absorbedJoules > 0);
  assert.ok(Math.abs(wake.energy() + wake.work().absorbedJoules - energy) < 1e-9);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(40);
  assert.equal(world.hash(), hash);
});
