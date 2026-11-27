import assert from 'node:assert/strict';
import test from 'node:test';
import { QuayPotential } from '../../dist/loads.js';

test('the eighth-order quay coarse correction remains positive on high-frequency masked grids', (t) => {
  const grids = [
    { cells: [64, 48], depths: [0, 1] },
    { cells: [65, 49], depths: [0, 1] },
    { cells: [48, 28], depths: [0, 0.02, 0.04, 0.07, 0.11, 0.16, 0.23, 0.34, 0.5, 0.75, 1.1, 1.85, 5.72, 7.4, 9.7] },
  ];
  const cellSize = 0.15;
  for (const { cells, depths } of grids) {
    const [nx, nz] = cells,
      plane = nx * nz,
      count = plane * (depths.length - 1);
    const wet = new Uint8Array(count);
    const openZ = new Float64Array(count).fill(1);
    for (let layer = 0; layer + 1 < depths.length; layer++) {
      const dryRows = depths[layer] >= 5.72 ? 0 : Math.floor(nz / 3) - Number(depths[layer] >= 0.23);
      wet.fill(1, plane * layer + nx * dryRows, plane * (layer + 1));
      for (let x = Math.floor(nx / 4) + 1; x < nx / 2; x++)
        openZ[layer * plane + Math.floor(nz / 2) * nx + x] = x % 2 ? 0 : 0.15;
    }
    const boundary = Float64Array.from({ length: plane }, (_, i) => {
      const parity = ((i % nx) + Math.floor(i / nx)) % 2;
      return (parity ? -1 : 1) + (((i * 1723) % 421) - 210) / 205;
    });
    const operator = new QuayPotential({ cells, cellSize, depths, wet, openZ, horizontalOrder: 8 });
    const rise = new Float64Array(plane),
      bulk = new Float64Array(count);
    const iterations = operator.project(boundary, rise, undefined, 0, bulk);
    assert.ok(iterations > 0 && iterations < 80, `Projection work for ${cells.join('×')}: ${iterations} iterations`);
    const flux = (axis, i) => (i < 0 ? 0 : operator.faceFlux(axis, i, bulk));
    let residual = 0;
    let volume = 0;
    for (let i = 0; i < count; i++) {
      if (!wet[i]) continue;
      const top = i < plane ? rise[i] * cellSize ** 2 : 0;
      const divergence =
        flux('x', i) - flux('x', i - 1) + flux('z', i) - flux('z', i - nx) + flux('down', i) - flux('down', i - plane);
      residual = Math.max(residual, Math.abs(divergence + top));
      volume += top;
    }
    assert.ok(residual < 1e-9 && Math.abs(volume) < 1e-12);
    t.diagnostic(JSON.stringify({ cells, layers: depths.length - 1, iterations, residual, volume }));
  }
});
