// Node checks of @margoengine/tilemap/hpa: it finds a way whenever A* does, costs exactly the same with a detour of 0
// and stays inside its stated bound otherwise, and rebuilds around changed cells to what a fresh build gives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PathHierarchy } from '../dist/hpa.js';
import { findPath } from '../dist/path.js';
import { checkPath, hexLayout, near, random, walled } from './grid-fixtures.js';

/** The cluster borders a path crosses. */
const crossings = (cells, side) =>
  cells.filter(
    ([x, y], i) =>
      i > 0 &&
      (Math.floor(x / side) !== Math.floor(cells[i - 1][0] / side) ||
        Math.floor(y / side) !== Math.floor(cells[i - 1][1] / side)),
  ).length;

const make = (n, next) => {
  const width = 3 + Math.floor(next() * 36),
    height = 3 + Math.floor(next() * 36),
    walls = next() * 0.45,
    mixed = n % 2 === 1,
    g = walled(width, height, () => (next() < walls ? Infinity : mixed ? 1 + Math.floor(next() * 6) : 1)),
    diagonal = ['never', 'always', 'no-corners'][n % 3];
  if (n % 5 === 4) g.layout = hexLayout(width, height, n % 10 === 4 ? 'y' : 'x');
  return { g, diagonal, cell: () => [Math.floor(next() * width), Math.floor(next() * height)] };
};

test('hpa: the same reachability as A*; exact at detour 0, inside the bound above it', () => {
  const next = random(23);
  let compared = 0,
    over = 0,
    cheapest = 0,
    found = 0,
    plainFound = 0;
  for (let n = 0; n < 450; n++) {
    const { g, diagonal, cell } = make(n, next),
      cluster = 2 + Math.floor(next() * 9),
      detour = n % 4 === 0 ? 0 : 1 + Math.floor(next() * 5),
      graph = new PathHierarchy(g, { diagonal, cluster, detour });
    const highest = Math.max(1, ...g.cost.filter((c) => c < Infinity)),
      length = g.layout || diagonal === 'never' ? 1 : Math.SQRT2;
    for (let q = 0; q < 12; q++) {
      const start = cell(),
        goal = cell(),
        plain = findPath(g, start, goal, { diagonal });
      for (const smooth of [false, true]) {
        const path = graph.findPath(start, goal, { smooth }),
          what = `grid ${n} query ${q} cluster ${cluster} detour ${detour} ${diagonal} smooth ${smooth}`;
        assert.equal(path === null, plain === null, `${what}: the same goals are reachable`);
        if (!path) continue;
        checkPath(g, path, start, goal, diagonal);
        assert.ok(path.cost >= plain.cost - 1e-7, `${what}: never below the cheapest`);
        if (detour === 0) near(path.cost, plain.cost, what);
        // The bound counts the borders a cheapest path crosses; A*'s path is one.
        const bound = detour
          ? plain.cost + crossings(plain.cells, cluster) * (2 * detour + 1) * length * highest
          : plain.cost;
        assert.ok(path.cost <= bound + 1e-7, `${what}: ${path.cost} above the bound ${bound}`);
        compared++;
        if (smooth) {
          found += path.cost;
          plainFound += plain.cost;
          if (path.cost > plain.cost + 1e-7) over++;
          else cheapest++;
        }
      }
    }
  }
  assert.ok(compared > 5000, `${compared} paths compared`);
  assert.ok(over > 0 && cheapest > over, `${cheapest} cheapest, ${over} above`);
  assert.ok(found < plainFound * 1.02, `smoothed paths cost ${(found / plainFound).toFixed(4)} of the cheapest`);
});

test('hpa: updated clusters give what a fresh build gives', () => {
  const next = random(31);
  for (let n = 0; n < 120; n++) {
    const { g, diagonal, cell } = make(n, next),
      options = { diagonal, cluster: 3 + Math.floor(next() * 6), detour: n % 3 },
      graph = new PathHierarchy(g, options);
    for (let round = 0; round < 8; round++) {
      const changed = [];
      for (let k = 0; k < 1 + Math.floor(next() * 6); k++) {
        const c = cell();
        g.cost[c[1] * g.width + c[0]] = next() < 0.5 ? Infinity : n % 2 ? 1 + Math.floor(next() * 6) : 1;
        changed.push(c);
      }
      graph.update(changed);
      const fresh = new PathHierarchy(g, options);
      assert.deepEqual(graph.nodes, fresh.nodes, `grid ${n} round ${round}: the same nodes`);
      for (let q = 0; q < 6; q++) {
        const start = cell(),
          goal = cell(),
          a = graph.findPath(start, goal),
          b = fresh.findPath(start, goal);
        assert.equal(a === null, b === null, `grid ${n} round ${round}`);
        if (a) near(a.cost, b.cost, `grid ${n} round ${round} query ${q}`);
      }
    }
  }
});

test('hpa: long paths expand a fraction of the cells; fewer transitions with a wider detour', () => {
  const next = random(5),
    size = 256,
    g = walled(size, size, () => (next() < 0.2 ? Infinity : 1)),
    goal = [size - 1, size - 1];
  g.cost[0] = g.cost[size * size - 1] = 1;
  const graph = new PathHierarchy(g),
    exact = new PathHierarchy(g, { detour: 0 }),
    plain = findPath(g, [0, 0], goal),
    raw = graph.findPath([0, 0], goal, { smooth: false }),
    path = graph.findPath([0, 0], goal);
  assert.ok(graph.nodes.length * 2 < exact.nodes.length, `${graph.nodes.length} nodes against ${exact.nodes.length}`);
  near(exact.findPath([0, 0], goal).cost, plain.cost);
  assert.ok(raw.searched * 3 < plain.searched, `${raw.searched} expanded against ${plain.searched}`);
  assert.ok(path.cost <= raw.cost && path.cost < plain.cost * 1.03, `${path.cost} against ${plain.cost}`);
});

test('hpa: one cell, walls, budget and bad input', () => {
  const g = walled(20, 4, (x) => (x === 10 ? 0 : 1)),
    graph = new PathHierarchy(g, { cluster: 4 });
  assert.deepEqual(graph.findPath([3, 2], [3, 2]).cells, [[3, 2]]);
  assert.equal(graph.findPath([0, 0], [19, 0]), null);
  assert.equal(graph.findPath([10, 0], [19, 0]), null, 'a blocked start');
  g.cost[2 * 20 + 10] = 1;
  const through = graph.update([[10, 2]]).findPath([0, 0], [19, 0]);
  checkPath(g, through, [0, 0], [19, 0]);
  assert.equal(new PathHierarchy(g, { cluster: 4, maxCells: 5 }).findPath([0, 0], [19, 0]), null);
  assert.throws(() => new PathHierarchy(g, { cluster: 1 }), /cluster/);
  assert.throws(() => new PathHierarchy(g, { detour: -1 }), /detour/);
  assert.throws(() => graph.findPath([20, 0], [0, 0]), /outside/);
  assert.throws(() => graph.update([[0, 4]]), /outside/);
});
