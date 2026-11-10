import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createDataSet } from '../dist/datasets.js';
import { elementNodes, elementWeights } from '../src/datasets-elements.ts';
import { integrateGrid, probeGrid } from '../dist/probe.js';
import { gridSurface } from '../dist/grids.js';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/datasets/vtk-oracle.json', import.meta.url)));
const physical = (p, shape) =>
  shape === 'pyramid' ? [p[0] * (1 - p[2]) + 0.5 * p[2], p[1] * (1 - p[2]) + 0.5 * p[2], p[2]] : p;
const near = (a, b, t = 1e-10) => assert.ok(Math.abs(a - b) <= t, `${a} vs ${b}`);
test('rotated adjacent higher-order cells share the same face triangulation and interpolated nodes', async () => {
  const nodes = elementNodes('hex', 2),
    positions = [],
    shared = new Map(),
    cells = [];
  for (const right of [false, true]) {
    const ids = nodes.map(([x, y, z]) => {
      const p = right ? [1 + y, 1 - x, z] : [x, y, z],
        key = p.join(',');
      if (!shared.has(key)) {
        shared.set(key, positions.length / 3);
        positions.push(...p);
      }
      return shared.get(key);
    });
    cells.push({ type: 'lagrange', shape: 'hex', order: 2, ids });
  }
  const grid = await createDataSet({ kind: 'unstructured', points: positions, cells }, { subdivisions: 4 }),
    surface = gridSurface(grid);
  near((await integrateGrid(grid)).volume.measure, 2);
  for (let i = 0; i < surface.positions.length; i += 9)
    assert.ok(
      ![0, 3, 6].every((k) => surface.positions[i + k] === 1),
      'shared interior face must not leak into the outer surface',
    );
});
test('clean-room shape functions match VTK 9.7.2 output, quadratic shapes and all six Lagrange families through order six', () => {
  for (const [type, shapes] of [
    ['lagrange', oracle.nodes],
    ['quadratic', oracle.quadratic],
  ])
    for (const [shape, orders] of Object.entries(shapes))
      for (const [order, data] of type === 'quadratic' ? [[2, orders]] : Object.entries(orders)) {
        const actual = elementNodes(shape, +order, type === 'quadratic'),
          nodes = data.nodes.map((p) => physical(p, shape));
        assert.equal(actual.length, nodes.length);
        for (let i = 0; i < nodes.length; i++) for (let a = 0; a < 3; a++) near(actual[i][a], nodes[i][a]);
        const descriptor = { type, shape, order: +order, ids: actual.map((_, i) => i) },
          weights = elementWeights(descriptor);
        for (const sample of data.samples) {
          const result = weights(physical(sample.at, shape));
          for (let i = 0; i < result.length; i++) near(result[i], sample.weights[i]);
        }
        for (let i = 0; i < nodes.length; i++) {
          const w = weights(nodes[i]);
          for (let j = 0; j < w.length; j++) near(w[j], +(i === j));
        }
      }
});
test('order seven through ten preserve cardinality and reproduce affine geometry and polynomials', () => {
  for (const shape of Object.keys(oracle.nodes))
    for (let order = 7; order <= 10; order++) {
      const nodes = elementNodes(shape, order),
        weights = elementWeights({ type: 'lagrange', shape, order, ids: nodes.map((_, i) => i) }),
        at =
          shape === 'curve'
            ? [0.17, 0, 0]
            : shape === 'triangle' || shape === 'quad'
              ? [0.17, 0.23, 0]
              : [0.17, 0.23, 0.19],
        w = weights(at);
      near(
        w.reduce((a, b) => a + b, 0),
        1,
      );
      for (let a = 0; a < 3; a++)
        near(
          w.reduce((sum, x, i) => sum + x * nodes[i][a], 0),
          at[a],
        );
      near(
        w.reduce((sum, x, i) => sum + x * nodes[i][0] ** 3, 0),
        at[0] ** 3,
      );
    }
});
test('higher-order geometry and every tuple component are interpolated before filters run', async () => {
  for (const [shape, measure, dimension] of [
    ['curve', 1, 'length'],
    ['triangle', 0.5, 'area'],
    ['quad', 1, 'area'],
    ['tetra', 1 / 6, 'volume'],
    ['hex', 1, 'volume'],
    ['wedge', 0.5, 'volume'],
    ['pyramid', 1 / 3, 'volume'],
  ]) {
    const nodes = elementNodes(shape, 2, true),
      grid = await createDataSet(
        {
          kind: 'unstructured',
          points: nodes.flat(),
          cells: [{ type: 'quadratic', shape, ids: nodes.map((_, i) => i) }],
          pointData: nodes.map((p) => p[0]),
          pointArrays: { affine: nodes.flatMap((p) => [p[0] + 2 * p[1], 3 * p[2]]) },
          cellData: [7],
        },
        { subdivisions: 4 },
      );
    near((await integrateGrid(grid))[dimension].measure, measure, 1e-9);
    assert.ok(grid.sourceCells.every((c) => c === 0));
    assert.ok(grid.cellData.every((v) => v === 7));
    for (let i = 0; i < grid.points.length / 3; i++) {
      near(grid.pointData[i], grid.points[3 * i]);
      near(grid.pointArrays.affine[2 * i], grid.points[3 * i] + 2 * grid.points[3 * i + 1]);
    }
  }
  const nodes = elementNodes('triangle', 2, true),
    points = nodes.map((p) => [p[0], p[1], p[0] * p[1]]),
    grid = await createDataSet(
      {
        kind: 'unstructured',
        points: points.flat(),
        cells: [{ type: 'quadratic', shape: 'triangle', ids: [0, 1, 2, 3, 4, 5] }],
        pointData: nodes.map((p) => p[0] + p[1]),
      },
      { subdivisions: 4 },
    );
  assert.ok(grid.points.some((v, i) => i % 3 === 2 && v > 0));
  near((await probeGrid(grid, [0.25, 0.25, 0.0625])).pointData, 0.5);
});
