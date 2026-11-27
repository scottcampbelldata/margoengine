// Grids and path checks shared by the tilemap search tests.
import assert from 'node:assert/strict';
import { cellNeighbors } from '../dist/hex.js';

// A linear congruential generator in 32-bit integer arithmetic (the multiplier and increment of Numerical Recipes).
// Math.imul keeps the low bits a float product would lose, which is what keeps its full period.
export const random = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

export const walled = (width, height, cost) => ({
  width,
  height,
  cost: Float64Array.from({ length: width * height }, (_, i) => cost(i % width, Math.floor(i / width))),
});

export const hexLayout = (width, height, staggerAxis) => ({
  orientation: 'hexagonal',
  width,
  height,
  tileWidth: 14,
  tileHeight: 16,
  hexSideLength: 8,
  staggerAxis,
  staggerIndex: 'odd',
});

export const near = (a, b, what = '') => assert.ok(Math.abs(a - b) < 1e-7, `${what}: ${a} vs ${b}`);

const open = (g, x, y) => g.cost[y * g.width + x] > 0 && g.cost[y * g.width + x] < Infinity;

/** The cells within `reach` rows and columns of `at`. */
export const cellsOf = (g, [x, y], reach) => {
  const out = [];
  for (let cy = Math.max(0, y - reach); cy <= Math.min(g.height - 1, y + reach); cy++)
    for (let cx = Math.max(0, x - reach); cx <= Math.min(g.width - 1, x + reach); cx++) out.push([cx, cy]);
  return out;
};

/** A path joins start to goal by legal steps whose costs add up to its cost. */
export const checkPath = (g, path, start, goal, diagonal = 'no-corners') => {
  assert.deepEqual(path.cells[0], start);
  assert.deepEqual(path.cells.at(-1), goal);
  let sum = 0;
  for (let i = 1; i < path.cells.length; i++) {
    const [ax, ay] = path.cells[i - 1],
      [bx, by] = path.cells[i],
      dx = bx - ax,
      dy = by - ay;
    assert.ok(open(g, bx, by), `step ${i} enters an open cell`);
    let length = 1;
    if (g.layout)
      assert.ok(
        cellNeighbors(g.layout, ax, ay).some(([x, y]) => x === bx && y === by),
        `step ${i} crosses an edge`,
      );
    else {
      assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy), `step ${i} is one cell`);
      if (dx && dy) {
        assert.notEqual(diagonal, 'never');
        if (diagonal === 'no-corners') assert.ok(open(g, bx, ay) && open(g, ax, by), `step ${i} cuts no corner`);
        length = Math.SQRT2;
      }
    }
    sum += g.cost[by * g.width + bx] * length;
  }
  near(sum, path.cost, 'the cost of the steps');
};
