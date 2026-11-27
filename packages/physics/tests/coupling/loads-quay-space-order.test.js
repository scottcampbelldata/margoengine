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
  const modified = squared.reduce((sum, k) => {
    const symbol = dx * dx * k;
    // Independent cosine form of the centered horizontal Laplacian.
    const correction = horizontalOrder === 8 ? symbol ** 2 / 90 + symbol ** 3 / 560 : 0;
    return sum + k * (1 + (horizontalOrder > 2 ? symbol / 12 : 0) + correction);
  }, 0);
  const exactDiscrete = layeredRate(Math.sqrt(modified), depth, layer);
  const exactHorizontal = layeredRate(Math.hypot(kx, kz), depth, layer);
  assert.ok(rise.every((v, i) => Math.abs(v - exactDiscrete * trace[i]) < 2e-9));
  return Math.abs(dot(rise, trace) / dot(trace, trace) - exactHorizontal);
}

test('higher-order finite quay flux resolves a diagonal carrier on fewer horizontal cells', (t) => {
  const second = [1, 2, 4].map((factor) => boxMode(factor, 2));
  const fourth = [1, 2, 4].map((factor) => boxMode(factor, 4));
  assert.ok(second[0] / second[1] > 3.7 && second[1] / second[2] > 3.9);
  assert.ok(fourth[0] / fourth[1] > 13 && fourth[1] / fourth[2] > 15);
  const eighth = [1, 2, 4].map((factor) => boxMode(factor, 8));
  assert.ok(eighth[0] / eighth[1] > 150 && eighth[1] / eighth[2] > 200);
  // Compare the original shot's proposed .15 m and .075 m horizontal meshes.
  assert.ok(fourth[1] < second[2]);
  assert.ok(eighth[1] < fourth[2] / 5);
  t.diagnostic(JSON.stringify({ second, fourth, eighth }));
});

for (const horizontalOrder of [4, 8]) {
  test(`order ${horizontalOrder} flux conserves water and leaves closed faces impermeable`, () => {
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
    const sealed = new QuayPotential({ cells, cellSize, depths, openX, horizontalOrder });
    sealed.project(trace, a, undefined, 0, bulk);
    assert.ok(a.every((value, i) => i % nx <= wallX || value === 0));
    assert.ok(bulk.every((value, i) => i % nx <= wallX || value === 0));

    // The lower two layers have a fractional aperture while the top remains fully sealed.
    openX[plane + 2 * nx + wallX] = 0.4;
    openX[2 * plane + 2 * nx + wallX] = 0.8;
    const open = new QuayPotential({ cells, cellSize, depths, openX, horizontalOrder });
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
      horizontalOrder,
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
}

test('the eighth-order interior stencil matches the face polynomial on either side of a cut', () => {
  const cells = [21, 1],
    cellSize = 0.15,
    depths = [0, 0.7],
    thickness = depths[1],
    size = cells[0];
  const openX = Float64Array.from({ length: size }, (_, i) => (i === 13 ? 0 : i === 16 ? 0.4 : 1));
  const bulk = Float64Array.from({ length: size }, (_, i) => Math.sin(i * 1.3) + Math.cos(i * 0.7));
  const control = new QuayPotential({ cells, cellSize, depths, openX, horizontalOrder: 8 });
  let term = Float64Array.from(openX, (opening, i) => (i + 1 < size ? opening * (bulk[i + 1] - bulk[i]) : 0));
  const expected = term.slice();
  for (const weight of [1 / 12, 1 / 90, 1 / 560]) {
    term = Float64Array.from(term, (value, i) =>
      i + 1 < size ? openX[i] * (2 * value - (term[i - 1] ?? 0) - term[i + 1]) : 0,
    );
    for (let i = 0; i < size; i++) expected[i] += weight * term[i];
  }
  for (let i = 0; i < size; i++) {
    assert.ok(Math.abs(control.faceFlux('x', i, bulk) - thickness * expected[i]) < 8e-16);
  }
});
