import assert from 'node:assert/strict';
import test from 'node:test';
import { QuayPotential } from '../../dist/loads.js';

function aperture(h, cells, depths, opening = false) {
  const [nx, nz] = cells,
    plane = nx * nz,
    volume = plane * (depths.length - 1),
    faceRow = Math.round(1.2 / h);
  const wet = new Uint8Array(volume);
  const openZ = new Float64Array(volume).fill(1);
  for (let layer = 0; layer + 1 < depths.length; layer++) {
    const dryRows = depths[layer] >= 5.72 ? 0 : faceRow - Number(depths[layer] >= 0.23) * Math.round(0.15 / h);
    const start = layer * plane;
    wet.fill(1, start + dryRows * nx, start + plane);
    if (opening) {
      for (let x = Math.floor(nx / 4) + 1; x < nx / 2; x++) {
        openZ[start + Math.floor(nz / 2) * nx + x] = x % 2 ? 0 : 0.15;
      }
    }
  }
  return { grid: { cells, cellSize: h, depths, wet, openZ, horizontalOrder: 8 }, plane, volume, faceRow };
}

function instrument(fixture, multiplicative) {
  const operator = new QuayPotential(fixture.grid);
  assert.equal(operator.coarseWork, undefined);
  // Keep exactly the same eighth-order matrix, anchors and coarse graph for the parent route.
  if (multiplicative) operator.coarseWork = new Float64Array(fixture.volume);
  const matrix = operator.multiply.bind(operator);
  const fineFaces = [operator.east, operator.north, operator.down].reduce(
    (count, faces) => faces.reduce((sum, opening) => sum + Number(opening > 0), count),
    0,
  );
  let products, coarseFaces;
  operator.multiply = (...args) => {
    products++;
    return matrix(...args);
  };
  for (let level = operator.coarse; level; level = level.child) {
    const graph = level.graph;
    const faces = graph.faces.bind(graph);
    const count = graph.edgePages.reduce((sum, page) => sum + page.from.length, 0);
    graph.faces = (visit) => {
      coarseFaces += count;
      faces(visit);
    };
  }
  return {
    operator,
    project(surface, source, length) {
      products = 0;
      coarseFaces = 0;
      const rise = new Float64Array(fixture.plane),
        bulk = new Float64Array(fixture.volume);
      const iterations = operator.project(surface, rise, source, length, bulk);
      const work = { iterations, products, coarseFaces, faces: fineFaces * products + coarseFaces };
      return { rise, bulk, work };
    },
  };
}

const maxDifference = (a, b) => a.reduce((max, x, i) => Math.max(max, Math.abs(x - b[i])), 0);

test('the large eighth-order solve cuts total face visits across a refined stepped aperture', (t) => {
  const depths = [
    0, 0.02, 0.045, 0.075, 0.11, 0.155, 0.23, 0.28, 0.37, 0.5, 0.68, 0.92, 1.27, 1.76, 2.48, 3.58, 5.05, 5.72, 7.4, 9.7,
  ];
  // A graded stress mesh keeps the number of layers fixed during horizontal refinement.
  const graded = depths.flatMap((depth, i) => (i > 0 && i <= 15 ? [(depth + depths[i - 1]) / 2, depth] : [depth]));
  for (const h of [0.15, 0.075]) {
    const nx = Math.round(7.2 / h),
      nz = Math.round(4.2 / h);
    const fixture = aperture(h, [nx, nz], graded);
    const wave = Float64Array.from({ length: fixture.plane }, (_, i) => {
      const x = ((i % nx) + 0.5) * h - 3.6;
      const z = (Math.floor(i / nx) + 0.5) * h - 1.2;
      return (0.04 * Math.sin(2.78 * x - 3.99 * z)) / (1 + x * x + z * z);
    });
    const source = new Float64Array(fixture.volume);
    const face = (fixture.faceRow - 1) * nx + Math.floor(nx / 2);
    const lower = graded.indexOf(5.72) * fixture.plane + face;
    source[lower] = 0.001;
    source[face + 2 * nx] = -0.001;
    const reference = instrument(fixture, true),
      candidate = instrument(fixture, false);
    for (const [surface, impulse, length] of [
      [wave, undefined, 0.0012],
      [new Float64Array(wave.length), source, 0],
    ]) {
      const parent = reference.project(surface, impulse, length);
      const additive = candidate.project(surface, impulse, length);
      assert.equal(additive.work.products, additive.work.iterations);
      assert.ok(additive.work.products < 0.65 * parent.work.products);
      assert.ok(additive.work.faces < 0.85 * parent.work.faces);
      assert.ok(maxDifference(additive.rise, parent.rise) < 5e-11);
      assert.ok(maxDifference(additive.bulk, parent.bulk) < 5e-12);
      assert.equal(candidate.operator.faceFlux('z', face, additive.bulk), 0);
      assert.ok(Math.abs(candidate.operator.faceFlux('z', lower, additive.bulk)) > 1e-8);
      assert.ok(Math.abs(additive.rise.reduce((sum, value) => sum + value, 0) * h * h) < 1e-12);
      t.diagnostic(JSON.stringify({ h, forced: !!impulse, parent: parent.work, additive: additive.work }));
    }
  }
});

test('the additive correction stays bounded just above its activation size on a masked high-frequency trace', (t) => {
  const [nx, nz] = [49, 48];
  const depths = [0, 0.02, 0.04, 0.07, 0.11, 0.16, 0.23, 0.34, 0.5, 0.75, 1.1, 1.85, 5.72, 7.4, 9.7];
  const fixture = aperture(0.15, [nx, nz], depths, true);
  const wave = Float64Array.from({ length: fixture.plane }, (_, i) => {
    const parity = ((i % nx) + Math.floor(i / nx)) % 2;
    return (parity ? -1 : 1) + (((1723 * i) % 421) - 210) / 205;
  });
  const parent = instrument(fixture, true).project(wave, undefined, 0);
  const additive = instrument(fixture, false).project(wave, undefined, 0);
  assert.ok(additive.work.iterations <= 2 * parent.work.iterations);
  assert.ok(additive.work.faces < 0.9 * parent.work.faces);
  assert.ok(maxDifference(additive.rise, parent.rise) < 1e-9);
  assert.ok(maxDifference(additive.bulk, parent.bulk) < 1e-10);
  t.diagnostic(JSON.stringify({ volume: fixture.volume, parent: parent.work, additive: additive.work }));
});
