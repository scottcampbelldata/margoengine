// Node checks of @margoengine/tilemap/replan (D* Lite): after changes and moves its paths cost what a fresh A* search
// finds, every step legal, for less work.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPath } from '../dist/path.js';
import { PathReplanner } from '../dist/replan.js';
import { cellsOf, checkPath, hexLayout, near, random, walled } from './grid-fixtures.js';

test('replan: as cheap as a fresh A* over 400 grids that change while the start moves', () => {
  const next = random(11);
  let compared = 0,
    unreachable = 0;
  for (let n = 0; n < 400; n++) {
    const width = 3 + Math.floor(next() * 24),
      height = 3 + Math.floor(next() * 24),
      walls = next() * 0.4,
      mixed = n % 2 === 1,
      price = () => (next() < walls ? Infinity : mixed ? 1 + Math.floor(next() * 6) : 1),
      diagonal = ['never', 'always', 'no-corners'][n % 3],
      g = walled(width, height, price);
    if (n % 5 === 4) g.layout = hexLayout(width, height, n % 10 === 4 ? 'y' : 'x');
    const cell = () => [Math.floor(next() * width), Math.floor(next() * height)],
      goal = cell(),
      plan = new PathReplanner(g, goal, { diagonal });
    let start = cell();
    for (let round = 0; round < 25; round++) {
      const fresh = findPath(g, start, goal, { diagonal }),
        path = plan.findPath(start);
      assert.equal(path === null, fresh === null, `grid ${n} round ${round}: the same goals are reachable`);
      if (path) {
        near(path.cost, fresh.cost, `grid ${n} round ${round}`);
        checkPath(g, path, start, goal, diagonal);
        compared++;
        // Move along the path, as a unit would, or jump elsewhere.
        start = next() < 0.8 ? path.cells[Math.min(path.cells.length - 1, 1 + Math.floor(next() * 3))] : cell();
      } else {
        unreachable++;
        start = cell();
      }
      // Walls appear and vanish and costs change, often beside the unit; now and then the goal itself.
      const changed = [];
      const count = round % 4 === 3 ? 0 : Math.floor(next() * 5);
      for (let k = 0; k < count; k++) {
        const near1 = next() < 0.5;
        const x = near1 ? Math.min(width - 1, Math.max(0, start[0] + Math.floor(next() * 5) - 2)) : cell()[0],
          y = near1 ? Math.min(height - 1, Math.max(0, start[1] + Math.floor(next() * 5) - 2)) : cell()[1],
          c = next() < 0.04 ? goal : [x, y];
        g.cost[c[1] * width + c[0]] = next() < 0.45 ? Infinity : mixed ? 1 + Math.floor(next() * 6) : 1;
        changed.push(c);
      }
      plan.update(changed);
    }
  }
  assert.ok(compared > 5000, `${compared} paths compared`);
  assert.ok(unreachable > 200, `${unreachable} rounds without a way`);
});

test('replan: a unit finding walls on its way expands a fraction of the cells A* would', () => {
  const next = random(3),
    size = 120,
    truth = walled(size, size, () => (next() < 0.2 ? Infinity : 1)),
    known = walled(size, size, () => 1),
    goal = [size - 1, size - 1];
  // The corners themselves and the cells beside them stay open.
  for (const corner of [[0, 0], goal]) for (const [x, y] of cellsOf(truth, corner, 2)) truth.cost[y * size + x] = 1;
  assert.ok(findPath(truth, [0, 0], goal), 'the room has a way through');
  // The unit sees the cells within two steps of it and plans through everything it has not seen.
  const plan = new PathReplanner(known, goal);
  let at = [0, 0],
    replanned = 0,
    fresh = 0,
    moves = 0,
    first = 0;
  while (at[0] !== goal[0] || at[1] !== goal[1]) {
    const changed = [];
    for (const [x, y] of cellsOf(known, at, 2)) {
      const c = y * size + x;
      if (known.cost[c] !== truth.cost[c]) {
        known.cost[c] = truth.cost[c];
        changed.push([x, y]);
      }
    }
    plan.update(changed);
    const path = plan.findPath(at),
      full = findPath(known, at, goal);
    assert.ok(path && full, 'the goal stays reachable');
    near(path.cost, full.cost, `move ${moves}`);
    if (moves === 0) first = path.searched;
    else {
      replanned += path.searched;
      fresh += full.searched;
    }
    at = path.cells[1];
    assert.ok(++moves < 2000);
  }
  // Deterministic work counts: cells expanded after the first plan.
  assert.ok(first > 0);
  assert.ok(replanned * 5 < fresh, `${replanned} cells expanded against ${fresh} over ${moves} moves`);
});

test('replan: no change costs no work; a new low cost, a budget and bad input', () => {
  const g = walled(40, 40, () => 2),
    plan = new PathReplanner(g, [39, 39]),
    first = plan.findPath([0, 0]);
  near(first.cost, 2 * 39 * Math.SQRT2);
  assert.equal(plan.findPath([0, 0]).searched, 0);
  // A cost below the estimate's lowest starts afresh and stays exact.
  const road = [];
  for (let x = 0; x < 40; x++) {
    g.cost[x] = g.cost[x * 40 + 39] = 0.1;
    road.push([x, 0], [39, x]);
  }
  plan.update(road);
  const cheap = plan.findPath([0, 0]);
  near(cheap.cost, findPath(g, [0, 0], [39, 39]).cost);
  assert.ok(cheap.cost < first.cost / 5);
  // maxCells limits one call; the next carries on.
  const small = new PathReplanner(
    walled(40, 40, () => 1),
    [39, 39],
    { maxCells: 15 },
  );
  let tries = 1,
    got = small.findPath([0, 0]);
  while (!got) {
    got = small.findPath([0, 0]);
    assert.ok(++tries < 500);
  }
  assert.ok(tries > 1, `${tries} calls`);
  near(got.cost, 39 * Math.SQRT2);
  // minCost keeps the work already done when a cost drops to it.
  const kept = walled(30, 30, () => 2),
    known = new PathReplanner(kept, [29, 29], { minCost: 1 });
  known.findPath([0, 0]);
  kept.cost[29 * 30 + 28] = 1;
  const after = known.update([[28, 29]]).findPath([0, 0]);
  near(after.cost, findPath(kept, [0, 0], [29, 29]).cost);
  // A blocked start or goal has no path, and comes back when opened.
  const shut = walled(5, 1, () => 1),
    p = new PathReplanner(shut, [4, 0]);
  shut.cost[4] = 0;
  assert.equal(p.update([[4, 0]]).findPath([0, 0]), null);
  shut.cost[4] = 1;
  near(p.update([[4, 0]]).findPath([0, 0]).cost, 4);
  shut.cost[0] = 0;
  assert.equal(p.update([[0, 0]]).findPath([0, 0]), null);
  assert.deepEqual(p.findPath([4, 0]).cells, [[4, 0]]);
  assert.throws(() => new PathReplanner(shut, [5, 0]), /outside/);
  assert.throws(() => new PathReplanner(shut, [4, 0], { minCost: 0 }), /minCost/);
  assert.throws(() => p.update([[0, 1]]), /outside/);
  assert.throws(() => p.findPath([-1, 0]), /outside/);
});
