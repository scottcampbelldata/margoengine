// Node checks of @margoengine/tilemap/path: A* and flow fields against costs worked out by hand and by a plain
// Bellman-Ford relaxation, diagonal rules, hex steps and costs from tile properties.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexDistance } from '../dist/hex.js';
import { createTileLayer } from '../dist/index.js';
import { findPath, flowField, followFlow, tileCosts } from '../dist/path.js';
import { random } from './grid-fixtures.js';

const grid = (width, height, cost = () => 1) => ({
  width,
  height,
  cost: Float64Array.from({ length: width * height }, (_, i) => cost(i % width, Math.floor(i / width))),
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('open grids: 8 steps along the edges without corners, 4 sqrt(2) across them', () => {
  const g = grid(5, 5);
  const square = findPath(g, [0, 0], [4, 4], { diagonal: 'never' });
  assert.equal(square.cells.length, 9);
  near(square.cost, 8);
  const corner = findPath(g, [0, 0], [4, 4], { diagonal: 'always' });
  assert.deepEqual(corner.cells, [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ]);
  near(corner.cost, 4 * Math.SQRT2);
  // (0, 0) to (4, 2): two corner steps and two straight ones.
  near(findPath(g, [0, 0], [4, 2]).cost, 2 + 2 * Math.SQRT2);
  assert.deepEqual(findPath(g, [2, 2], [2, 2]), { cells: [[2, 2]], cost: 0, searched: 1, scanned: 0 });
});

test('walls: no-corners will not cut past a wall corner, always will, and closed goals give null', () => {
  const g = grid(3, 3, (x, y) => (x === 1 && y === 0 ? Infinity : 1));
  near(findPath(g, [0, 0], [1, 1], { diagonal: 'always' }).cost, Math.SQRT2);
  // The wall at (1, 0) closes the corner, so the way is down then right.
  const safe = findPath(g, [0, 0], [1, 1]);
  near(safe.cost, 2);
  assert.deepEqual(safe.cells, [
    [0, 0],
    [0, 1],
    [1, 1],
  ]);
  const walled = grid(3, 3, (x) => (x === 1 ? 0 : 1));
  assert.equal(findPath(walled, [0, 0], [2, 2]), null);
  assert.equal(findPath(g, [0, 0], [1, 0]), null, 'a blocked goal');
  assert.equal(findPath(grid(50, 1), [0, 0], [49, 0], { maxCells: 10 }), null, 'the search budget ran out');
  assert.throws(() => findPath(g, [0, 0], [3, 0]), /outside/);
  assert.throws(() => findPath(g, [0, 0], [1, 1], { diagonal: 'some' }), /diagonal/);
});

test('costs: a swamp column of cost 5 is passed by its one open cell', () => {
  // 5 x 3, swamp at x = 2 except the bottom row. Straight across the top enters cells costing 1 + 5 + 1 + 1 = 8; four
  // corner steps down through (2, 2) and back up enter four cells of cost 1: 4 sqrt(2), about 5.66.
  const g = grid(5, 3, (x, y) => (x === 2 && y < 2 ? 5 : 1));
  const path = findPath(g, [0, 0], [4, 0]);
  near(path.cost, 4 * Math.SQRT2);
  assert.deepEqual(path.cells, [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 1],
    [4, 0],
  ]);
  // Without corners both ways cost 8: 4 cells across the top, or 8 cells of cost 1 round the bottom.
  near(findPath(g, [0, 0], [4, 0], { diagonal: 'never' }).cost, 8);
});

test('flow fields agree with a plain relaxation and with A* from every cell', () => {
  const next = random(7);
  const g = grid(9, 7, () => (next() < 0.15 ? Infinity : 1 + Math.floor(next() * 4)));
  g.cost[3 * 9 + 4] = 1;
  for (const diagonal of ['never', 'always', 'no-corners']) {
    const field = flowField(g, [[4, 3]], { diagonal });
    // Bellman-Ford: relax every step until nothing changes.
    const best = new Float64Array(g.cost.length).fill(Infinity);
    best[3 * 9 + 4] = 0;
    const open = (i) => g.cost[i] > 0 && g.cost[i] < Infinity;
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < best.length; i++) {
        if (!open(i)) continue;
        const x = i % 9,
          y = Math.floor(i / 9);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy,
              j = ny * 9 + nx;
            if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= 9 || ny >= 7 || !open(j)) continue;
            const corner = dx && dy;
            if (corner && diagonal === 'never') continue;
            if (corner && diagonal === 'no-corners' && !(open(y * 9 + nx) && open(ny * 9 + x))) continue;
            const total = best[j] + g.cost[j] * (corner ? Math.SQRT2 : 1);
            if (total < best[i] - 1e-12) {
              best[i] = total;
              changed = true;
            }
          }
      }
    }
    for (let i = 0; i < best.length; i++) {
      const x = i % 9,
        y = Math.floor(i / 9);
      if (best[i] === Infinity) {
        assert.equal(field.distance[i], Infinity);
        continue;
      }
      near(field.distance[i], best[i]);
      near(findPath(g, [x, y], [4, 3], { diagonal }).cost, best[i]);
      const walk = followFlow(field, x, y);
      assert.deepEqual(walk.at(-1), [4, 3]);
    }
  }
  // Several goals: each cell goes to the nearest one.
  const two = flowField(grid(7, 1), [
    [0, 0],
    [6, 0],
  ]);
  assert.deepEqual([...two.distance], [0, 1, 2, 3, 2, 1, 0]);
  assert.deepEqual(followFlow(two, 3, 0).at(-1), [0, 0], 'a tie goes to the goal reached first');
});

test('the test grids come from a generator that does not fall into a short cycle', () => {
  const next = random(7),
    seen = new Set();
  for (let i = 0; i < 100_000; i++) seen.add(next());
  assert.equal(seen.size, 100_000);
});

test('hexagonal maps step to the six cells sharing an edge', () => {
  const layout = {
    orientation: 'hexagonal',
    width: 8,
    height: 8,
    tileWidth: 14,
    tileHeight: 16,
    hexSideLength: 8,
    staggerAxis: 'y',
    staggerIndex: 'odd',
  };
  const g = { ...grid(8, 8), layout };
  for (const goal of [
    [5, 6],
    [7, 1],
    [0, 7],
  ]) {
    const path = findPath(g, [2, 3], goal);
    assert.equal(path.cells.length - 1, hexDistance(layout, [2, 3], goal));
    for (let i = 1; i < path.cells.length; i++) assert.equal(hexDistance(layout, path.cells[i - 1], path.cells[i]), 1);
  }
});

test('tileCosts reads solid and cost properties; the highest layer cost wins; gaps take empty', () => {
  const map = {
    width: 3,
    height: 1,
    tileWidth: 16,
    tileHeight: 16,
    tilesets: [
      {
        name: 't',
        firstGid: 1,
        tileWidth: 16,
        tileHeight: 16,
        tileCount: 3,
        columns: 3,
        tiles: [
          { id: 1, properties: { cost: 4 } },
          { id: 2, properties: { solid: true } },
        ],
      },
    ],
    layers: [
      createTileLayer('ground', 3, 1, Uint32Array.of(1, 2, 0)),
      createTileLayer('top', 3, 1, Uint32Array.of(0, 1, 3)),
    ],
  };
  assert.deepEqual([...tileCosts(map).cost], [1, 4, Infinity]);
  assert.deepEqual([...tileCosts(map, { layers: ['ground'], empty: Infinity }).cost], [1, 4, Infinity]);
  assert.deepEqual([...tileCosts(map, { layers: ['top'], empty: Infinity }).cost], [Infinity, 1, Infinity]);
  assert.equal(tileCosts(map).layout, map);
  assert.throws(() => tileCosts(map, { fallback: 0 }), RangeError);
});

// Jump point search: on grids of one cost with no corner cutting it finds paths as cheap as plain A*'s, legal step by
// step, visiting fewer cells; elsewhere it is plain A*.
const legal = (g, cells) => {
  for (let i = 1; i < cells.length; i++) {
    const [ax, ay] = cells[i - 1],
      [bx, by] = cells[i],
      dx = bx - ax,
      dy = by - ay,
      open = (x, y) => g.cost[y * g.width + x] > 0 && g.cost[y * g.width + x] < Infinity;
    assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy), `step ${i} is one cell`);
    assert.ok(open(bx, by), `step ${i} enters an open cell`);
    if (dx && dy) assert.ok(open(ax + dx, ay) && open(ax, ay + dy), `step ${i} cuts no corner`);
  }
};

test('jumpPoints: as cheap as plain A* on 600 random walled grids, every step legal', () => {
  const next = random(7);
  let plainSearched = 0,
    jumpSearched = 0;
  for (let n = 0; n < 600; n++) {
    const width = 4 + Math.floor(next() * 40),
      height = 4 + Math.floor(next() * 40),
      walls = next() * 0.45,
      unit = [1, 2.5][n % 2],
      g = grid(width, height, () => (next() < walls ? Infinity : unit)),
      start = [Math.floor(next() * width), Math.floor(next() * height)],
      goal = [Math.floor(next() * width), Math.floor(next() * height)],
      plain = findPath(g, start, goal),
      jump = findPath(g, start, goal, { jumpPoints: true });
    assert.equal(jump === null, plain === null, `grid ${n}: the same goals are reachable`);
    if (!plain) continue;
    near(jump.cost, plain.cost);
    assert.deepEqual(jump.cells[0], start);
    assert.deepEqual(jump.cells.at(-1), goal);
    legal(g, jump.cells);
    // The cells' own costs add up to the reported cost.
    let sum = 0;
    for (let i = 1; i < jump.cells.length; i++) {
      const [ax, ay] = jump.cells[i - 1],
        [bx, by] = jump.cells[i];
      sum += unit * (ax !== bx && ay !== by ? Math.SQRT2 : 1);
    }
    near(sum, jump.cost);
    plainSearched += plain.searched;
    jumpSearched += jump.searched;
  }
  // Work counts, deterministic: cells expanded (a heap pop and up to 8 pushes each).
  assert.ok(jumpSearched * 2 < plainSearched, `${jumpSearched} cells expanded against ${plainSearched}`);
});

test('jumpPoints: an open 200 x 200 grid corner to corner visits a fraction of the cells', () => {
  const g = grid(200, 200),
    plain = findPath(g, [0, 0], [199, 120]),
    jump = findPath(g, [0, 0], [199, 120], { jumpPoints: true });
  near(jump.cost, plain.cost);
  assert.equal(jump.cells.length, 200);
  assert.ok(jump.searched * 20 < plain.searched, `${jump.searched} cells expanded against ${plain.searched}`);
  // A wall across most of the room makes plain A* spread.
  const wall = grid(200, 200, (x, y) => (x === 100 && y > 10 ? Infinity : 1)),
    a = findPath(wall, [10, 190], [190, 190]),
    b = findPath(wall, [10, 190], [190, 190], { jumpPoints: true });
  near(b.cost, a.cost);
  legal(wall, b.cells);
  assert.ok(b.searched * 20 < a.searched, `${b.searched} cells expanded against ${a.searched}`);
  assert.equal(findPath(wall, [10, 190], [190, 190], { jumpPoints: true, maxCells: 50 }), null);
});

test('jumpPoints: plain A* where pruning is not exact (mixed costs, no diagonals, corner cutting, hex)', () => {
  const mixed = grid(9, 9, (x, y) => 1 + ((x * 3 + y) % 4)),
    open = grid(9, 9);
  for (const [g, options] of [
    [mixed, {}],
    [open, { diagonal: 'never' }],
    [open, { diagonal: 'always' }],
    [
      {
        ...open,
        layout: { orientation: 'hexagonal', width: 9, height: 9, tileWidth: 14, tileHeight: 16, hexSideLength: 8 },
      },
      {},
    ],
  ])
    assert.deepEqual(
      findPath(g, [0, 0], [8, 5], { ...options, jumpPoints: true }),
      findPath(g, [0, 0], [8, 5], options),
    );
});
