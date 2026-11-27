import test from 'node:test';
import assert from 'node:assert/strict';
import { NavMesh } from '../dist/index.js';
import { TiledNavMesh } from '../dist/tiles.js';
import { AnyAngleSearch } from '../dist/any-angle.js';
import { WeightedAnyAngleSearch } from '../dist/weighted-any-angle.js';
import { grid, random, randomMap } from './support/grid-map.mjs';

const near = (a, b, label, slack = 1e-8) => assert.ok(Math.abs(a - b) <= slack, `${label}: ${a} against ${b}`);
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Asks for a closer bound than the default, with the work to reach it. */
const CLOSE = { tolerance: 0.01, maxWork: 200_000_000 };

/** What every answer must hold, against the least cost (or a real path's cost, which is no less). */
function bracket(route, least, label, { tolerance = 0.01, exact = true } = {}) {
  assert.ok(route.lowerBound <= least + 1e-7, `${label}: bound ${route.lowerBound} above ${least}`);
  assert.ok(route.cost <= route.lowerBound * (1 + tolerance) + 1e-8, `${label}: gap ${route.cost / route.lowerBound}`);
  if (exact) assert.ok(route.cost >= least - 1e-7, `${label}: cost ${route.cost} below ${least}`);
}

/** The least of a convex function on [low, high]. */
function minimise(f, low, high) {
  for (let i = 0; i < 200; i++) {
    const a = low + (high - low) / 3,
      b = high - (high - low) / 3;
    if (f(a) <= f(b)) high = b;
    else low = a;
  }
  return low;
}

/** Strips 1 m wide along x, each its own weight, 2 m deep. */
function strips(weights) {
  const vertices = [];
  for (let x = 0; x <= weights.length; x++) vertices.push([x, 0, 0], [x, 0, 2]);
  const mesh = new NavMesh(
    vertices,
    weights.map((_, x) => [2 * x, 2 * x + 2, 2 * x + 3, 2 * x + 1]),
  );
  weights.forEach((weight, p) => mesh.setAreaCost(p, weight));
  return mesh;
}

test('refraction through weighted strips matches the least cost found by convex descent', () => {
  for (const weights of [
    [1, 3],
    [5, 1],
    [1, 4, 2, 7, 1.5],
    [2, 2, 2],
  ]) {
    const mesh = strips(weights),
      start = [0.1, 0, 0.2],
      end = [weights.length - 0.1, 0, 1.8],
      zs = weights.map(() => 1).slice(1),
      point = (i) => (i === 0 ? start : i === weights.length ? end : [i, 0, zs[i - 1]]),
      total = () => weights.reduce((sum, w, i) => sum + w * flat(point(i), point(i + 1)), 0);
    for (let sweep = 0; sweep < 300; sweep++)
      for (let i = 0; i < zs.length; i++)
        zs[i] = minimise(
          (z) => weights[i] * flat(point(i), [i + 1, 0, z]) + weights[i + 1] * flat([i + 1, 0, z], point(i + 2)),
          0,
          2,
        );
    const least = total(),
      search = new WeightedAnyAngleSearch(mesh);
    for (const tolerance of [0.01, 0.0002]) {
      const route = search.route(start, end, { tolerance, maxWork: CLOSE.maxWork });
      bracket(route, least, `${weights} at ${tolerance}`, { tolerance });
      assert.deepEqual(route.points[0], start);
      assert.deepEqual(route.points.at(-1), end);
    }
    // Snell's law: the crossings sit where the least cost puts them.
    const route = search.route(start, end, { tolerance: 1e-4, maxWork: CLOSE.maxWork });
    for (const [x, , z] of route.points.slice(1, -1)) near(z, zs[x - 1], `${weights}: crossing at ${x}`, 0.03);
    bracket(search.route(end, start, CLOSE), least, `${weights} back`);
  }
});

test('a cheap strip beside dear ground is joined and walked at the critical angle', () => {
  const mesh = new NavMesh(
    [
      [0, 0, -1],
      [20, 0, -1],
      [20, 0, 0],
      [0, 0, 0],
      [20, 0, 2],
      [0, 0, 2],
    ],
    [
      [0, 1, 2, 3],
      [3, 2, 4, 5],
    ],
  );
  mesh.setAreaCost(1, 10);
  const angle = Math.asin(1 / 10),
    least = (2 * 10) / Math.cos(angle) + (18 - 2 * Math.tan(angle)),
    route = new WeightedAnyAngleSearch(mesh).route([1, 0, 1], [19, 0, 1], { ...CLOSE, tolerance: 0.001 });
  bracket(route, least, 'refraction along the edge', { tolerance: 0.001 });
  assert.equal(route.points.length, 4);
  near(route.points[1][0], 1 + Math.tan(angle), 'onto the edge', 0.05);
  near(route.points[2][0], 19 - Math.tan(angle), 'off the edge', 0.05);
  for (const p of route.points.slice(1, -1)) near(p[2], 0, 'on the edge', 1e-5);
});

/** The oracle: Dijkstra over points spread along every grid edge, a real path whose cost is no less than the least. */
function dense(rows, weights, start, end, parts) {
  const points = [start, end],
    ids = new Map(),
    cells = new Map();
  const at = (x, z) => {
    const key = `${Math.round(x * parts)},${Math.round(z * parts)}`;
    let id = ids.get(key);
    if (id === undefined) {
      ids.set(key, (id = points.length));
      points.push([x, z]);
    }
    return id;
  };
  rows.forEach((row, z) =>
    [...row].forEach((cell, x) => {
      if (cell === '#') return;
      const list = new Set();
      for (let k = 0; k <= parts; k++) {
        const t = k / parts;
        list.add(at(x + t, z)).add(at(x + t, z + 1));
        list.add(at(x, z + t)).add(at(x + 1, z + t));
      }
      for (const [id, [px, pz]] of [start, end].entries())
        if (px >= x && px <= x + 1 && pz >= z && pz <= z + 1) list.add(id);
      cells.set(`${x},${z}`, { weight: weights[cell], list: [...list] });
    }),
  );
  const members = points.map(() => []);
  for (const cell of cells.values()) for (const id of cell.list) members[id].push(cell);
  const best = points.map(() => Infinity),
    done = new Uint8Array(points.length),
    heap = [[0, 0]];
  best[0] = 0;
  while (heap.length) {
    let low = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[low][0]) low = i;
    const [cost, id] = heap[low];
    heap[low] = heap.at(-1);
    heap.pop();
    if (done[id]) continue;
    if (id === 1) return cost;
    done[id] = 1;
    for (const { weight, list } of members[id])
      for (const other of list) {
        const next = cost + weight * Math.hypot(points[id][0] - points[other][0], points[id][1] - points[other][1]);
        if (next < best[other]) heap.push([(best[other] = next), other]);
      }
  }
  return null;
}

/** The cost of a path over a grid map from its corners alone: each stretch at the cheapest cell it lies in or beside. */
function walked(rows, weights, points) {
  const cells = (v) => (Math.abs(v - Math.round(v)) < 1e-5 ? [Math.round(v) - 1, Math.round(v)] : [Math.floor(v)]);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      cuts = [0, 1];
    for (const axis of [0, 2]) {
      const d = b[axis] - a[axis];
      if (Math.abs(d) < 1e-9) continue;
      for (let line = Math.ceil(Math.min(a[axis], b[axis])); line <= Math.max(a[axis], b[axis]); line++) {
        const t = (line - a[axis]) / d;
        if (t > 0 && t < 1) cuts.push(t);
      }
    }
    cuts.sort((x, y) => x - y);
    for (let k = 1; k < cuts.length; k++) {
      if (cuts[k] - cuts[k - 1] < 1e-7) continue;
      const t = (cuts[k] + cuts[k - 1]) / 2,
        x = a[0] + t * (b[0] - a[0]),
        z = a[2] + t * (b[2] - a[2]),
        over = cells(x).flatMap((cx) => cells(z).map((cz) => weights[rows[cz]?.[cx]] ?? Infinity));
      total += Math.min(...over) * (cuts[k] - cuts[k - 1]) * flat(a, b);
    }
  }
  return total;
}

const WEIGHTS = { '.': 1, b: 2, c: 5, d: 20 };

test('random weighted maps: the bound holds under a dense oracle and the path costs what it says', () => {
  const next = random(20261127);
  let found = 0,
    none = 0,
    beatsCorridor = 0,
    beatsDense = 0;
  for (let map = 0; map < 50; map++) {
    const width = 4 + Math.floor(next() * 5),
      depth = 4 + Math.floor(next() * 5),
      rows = randomMap(next, width, depth, 0.15 + next() * 0.3).map((row) =>
        row.replaceAll('.', () => '..bcd'[Math.floor(next() * 5)]),
      ),
      mesh = grid(rows),
      free = [];
    rows.forEach((row, z) =>
      [...row].forEach((cell, x) => {
        if (cell !== '#') free.push([x, z, cell]);
      }),
    );
    free.forEach(([, , cell], p) => mesh.setAreaCost(p, WEIGHTS[cell]));
    const search = new WeightedAnyAngleSearch(mesh);
    for (let query = 0; query < 8; query++) {
      const pick = () => {
          const [x, z] = free[Math.floor(next() * free.length)];
          return [x + 0.05 + next() * 0.9, z + 0.05 + next() * 0.9];
        },
        a = pick(),
        b = pick(),
        start = [a[0], 0, a[1]],
        end = [b[0], 0, b[1]],
        real = dense(rows, WEIGHTS, a, b, 8),
        route = search.route(start, end),
        label = `map ${map} query ${query}`;
      assert.equal(route === null, real === null, label);
      if (!route) {
        none++;
        continue;
      }
      found++;
      bracket(route, real, label, { exact: false, tolerance: 0.05 });
      // The path itself is far nearer the least than what is proved of it.
      assert.ok(route.cost <= real * 1.01 + 1e-8, `${label}: ${route.cost} against a real path of ${real}`);
      // Never dearer than walking the corners, and no cheaper than the bound.
      const cost = walked(rows, WEIGHTS, route.points);
      assert.ok(cost <= route.cost + 1e-3, `${label}: corners cost ${cost}, reported ${route.cost}`);
      assert.ok(cost >= route.lowerBound - 1e-3, `${label}: corners cost ${cost}, bound ${route.lowerBound}`);
      if (route.cost < real - 1e-3) beatsDense++;
      if (route.cost < walked(rows, WEIGHTS, mesh.path(start, end)) * 0.98) beatsCorridor++;
    }
  }
  assert.ok(found > 250 && none > 5, `found ${found}, none ${none}`);
  assert.ok(beatsCorridor > 20, `beats the corridor path ${beatsCorridor}`);
  assert.ok(beatsDense > 20, `beats the dense graph ${beatsDense}`);
});

test('on even ground the bounds hold the exact length, whatever the polygons and wherever the mesh lies', () => {
  const next = random(99);
  let found = 0;
  for (let map = 0; map < 30; map++) {
    const width = 4 + Math.floor(next() * 6),
      depth = 4 + Math.floor(next() * 6),
      rows = randomMap(next, width, depth, 0.15 + next() * 0.3);
    if (!rows.some((row) => row.includes('.'))) continue;
    const angle = next() * Math.PI,
      turn = ([x, y, z]) => [
        3000 + x * Math.cos(angle) - z * Math.sin(angle),
        y,
        -2000 + x * Math.sin(angle) + z * Math.cos(angle),
      ],
      move = map % 3 === 2 ? turn : (p) => p,
      mesh = grid(rows, { split: map % 3 ? () => Math.floor(next() * 2) : null, move }),
      exact = new AnyAngleSearch(mesh),
      search = new WeightedAnyAngleSearch(mesh);
    const free = rows.flatMap((row, z) => [...row].flatMap((cell, x) => (cell === '#' ? [] : [[x, z]])));
    for (let query = 0; query < 10; query++) {
      const pick = () => {
          const [x, z] = free[Math.floor(next() * free.length)];
          // Cell corners and middles too, where many ways meet.
          const inside = () => (query % 2 ? [0, 0.5, 1][Math.floor(next() * 3)] : 0.05 + next() * 0.9);
          return move([x + inside(), 0, z + inside()]);
        },
        start = pick(),
        end = pick(),
        least = exact.route(start, end),
        route = search.route(start, end),
        label = `map ${map} query ${query}`;
      assert.equal(route === null, least === null, label);
      if (!route) continue;
      found++;
      bracket(route, least.length, label, { tolerance: 0.05 });
      assert.ok(route.cost <= least.length * 1.01 + 1e-8, `${label}: ${route.cost} against ${least.length}`);
    }
  }
  assert.ok(found > 180, `found ${found}`);
});

test('a path passing close by a vertex is found on its cheaper side, whichever side that is', () => {
  // Four cells round (1, 1). The least path rounds the vertex a few hundredths off it through the cheaper side cell,
  // nearer than the first search's points are spaced, so those points cannot tell the two sides apart.
  for (const mirror of [false, true]) {
    const swap = ([x, y, z]) => (mirror ? [z, y, x] : [x, y, z]),
      mesh = grid(['ab', 'cd']);
    (mirror ? [3, 2, 5, 1] : [3, 5, 2, 1]).forEach((weight, p) => mesh.setAreaCost(p, weight));
    // Solved on the side with the cheaper cell below the start: across z = 1, then across x = 1.
    const start = [0.7, 0, 0.7],
      end = [1.8, 0, 1.3],
      path = (x, z) => 3 * flat(start, [x, 0, 1]) + 2 * flat([x, 0, 1], [1, 0, z]) + flat([1, 0, z], end),
      inner = (x) =>
        path(
          x,
          minimise((z) => path(x, z), 1, 2),
        ),
      x = minimise(inner, 0, 1),
      least = inner(x);
    assert.ok(x > 15 / 16 && x < 1, `the bend is nearer the vertex than a point's spacing: ${x}`);
    const route = new WeightedAnyAngleSearch(mesh).route(swap(start), swap(end), { maxWork: 1 });
    near(route.cost, least, mirror ? 'mirrored' : 'cheap side below', 1e-7);
  }
});

test('an answer does not hang on what was searched before', () => {
  const next = random(5),
    rows = randomMap(next, 12, 12, 0.15),
    mesh = grid(rows),
    cells = rows.join('').replaceAll('#', '').length,
    weights = Array.from({ length: cells }, () => [1, 2, 5, 20][Math.floor(next() * 4)]);
  weights.forEach((weight, p) => mesh.setAreaCost(p, weight));
  const free = rows.flatMap((row, z) => [...row].flatMap((cell, x) => (cell === '#' ? [] : [[x, z]]))),
    pick = () => {
      const [x, z] = free[Math.floor(next() * free.length)];
      return [x + 0.05 + next() * 0.9, 0, z + 0.05 + next() * 0.9];
    },
    used = new WeightedAnyAngleSearch(mesh);
  for (let query = 0; query < 40; query++) {
    const start = pick(),
      end = pick();
    assert.deepEqual(used.route(start, end), new WeightedAnyAngleSearch(mesh).route(start, end), `query ${query}`);
  }
});

test('filters weigh and forbid ground, and a changed cost is read again', () => {
  const mesh = grid(['.....', '.mmm.', '.....'], { areas: { m: 1 } }),
    search = new WeightedAnyAngleSearch(mesh),
    start = [0.5, 0, 1.5],
    end = [4.5, 0, 1.5];
  bracket(search.route(start, end, CLOSE), 4, 'unweighted');
  const round = search.route(start, end, { ...CLOSE, filter: [1, 10] });
  bracket(round, new AnyAngleSearch(mesh).route(start, end, { filter: [1, Infinity] }).length, 'dear', {
    exact: false,
  });
  assert.ok(round.points.every((p) => !(p[0] > 1.001 && p[0] < 3.999 && p[2] > 1.001 && p[2] < 1.999)));
  const forbidden = search.route(start, end, { ...CLOSE, filter: [1, Infinity] });
  bracket(forbidden, 2 * Math.hypot(0.5, 0.5) + 3, 'forbidden');
  assert.equal(search.route(start, [2.5, 0, 1.5], { filter: [1, Infinity] }), null);
  // A walker on forbidden ground may still leave it, at weight 1.
  const out = search.route([1.5, 0, 1.5], [0.5, 0, 1.5], { ...CLOSE, filter: [1, Infinity] });
  bracket(out, 1, 'leaves forbidden ground');
  // A weight of 1.05 is worth crossing; the area cost of the mesh multiplies with the filter and is read again.
  bracket(search.route(start, end, { ...CLOSE, filter: [1, 1.05] }), 1 + 3 * 1.05, 'cheap enough');
  const mud = [...Array(mesh.polygonCount ?? 15).keys()].filter((p) => mesh.polygonArea(p) === 1);
  for (const p of mud) mesh.setAreaCost(p, Infinity);
  bracket(search.route(start, end, CLOSE), forbidden.cost, 'closed by area cost');
  for (const p of mud) mesh.setAreaCost(p, 1);
  bracket(search.route(start, end, CLOSE), 4, 'opened again');
});

test('off-mesh links are taken when they make the cheapest way', () => {
  const mesh = grid(['..#..', '..#..', '..#..']),
    search = new WeightedAnyAngleSearch(mesh),
    start = [0.5, 0, 1.5],
    end = [4.5, 0, 1.5];
  assert.equal(search.route(start, end), null);
  mesh.addOffMeshLink([1.5, 0, 1.5], [3.5, 0, 1.5], { cost: 2 });
  const jumped = search.route(start, end, CLOSE);
  bracket(jumped, 4, 'jump');
  assert.deepEqual(jumped.offMesh, [1]);
  assert.deepEqual(jumped.points, [start, [1.5, 0, 1.5], [3.5, 0, 1.5], end]);
  const teleport = mesh.addOffMeshLink([0.5, 0, 1.5], [4.5, 0, 1.5], { cost: 0 }),
    free = search.route(start, end);
  assert.equal(free.cost, 0);
  assert.equal(free.lowerBound, 0);
  assert.deepEqual(free.offMesh, [0]);
  mesh.removeOffMeshLink(teleport);
  bracket(search.route(start, end, CLOSE), 4, 'removed');
  const open = grid(['.....']);
  open.addOffMeshLink([0.5, 0, 0.5], [4.5, 0, 0.5], { cost: 9 });
  assert.deepEqual(new WeightedAnyAngleSearch(open).route([0.5, 0, 0.5], [4.5, 0, 0.5]).offMesh, []);
});

test('a tiled mesh across its seams', () => {
  const positions = [0, 0, 0, 24, 0, 0, 24, 0, 24, 0, 0, 24],
    world = new TiledNavMesh(positions, [0, 2, 1, 0, 3, 2], { cs: 0.25, ch: 0.1, tileSize: 16, walkableRadius: 1 });
  for (const [x, z] of [
    [6, 5],
    [11, 10],
    [16, 14],
    [8, 15],
    [15, 6],
  ])
    world.addObstacle({ min: [x, -1, z], max: [x + 3, 2, z + 3] });
  world.update();
  const exact = new AnyAngleSearch(world),
    search = new WeightedAnyAngleSearch(world),
    next = random(7);
  let bent = 0;
  for (let query = 0; query < 40; query++) {
    const a = [1 + next() * 22, 0, 1 + next() * 22],
      b = [1 + next() * 22, 0, 1 + next() * 22];
    if (world.locate(a) < 0 || world.locate(b) < 0) continue;
    const least = exact.route(a, b),
      route = search.route(a, b);
    assert.equal(route === null, least === null, `query ${query}`);
    if (!route) continue;
    // On many polygons the work runs out before the bound is close; the path is still near the least.
    assert.ok(route.lowerBound <= least.length + 1e-7 && route.cost >= least.length - 1e-7, `query ${query}`);
    assert.ok(route.cost <= least.length * 1.01, `query ${query}: ${route.cost} against ${least.length}`);
    if (route.points.length > 2) bent++;
    for (let i = 1; i < route.points.length; i++) {
      const p = route.points[i - 1],
        q = route.points[i],
        steps = Math.ceil(flat(p, q) / 0.05);
      for (let k = 0; k <= steps; k++) {
        const on = p.map((v, axis) => v + ((q[axis] - v) * k) / steps);
        assert.ok(world.locate(on) >= 0, `query ${query} leaves the mesh at ${on}`);
      }
    }
  }
  assert.ok(bent > 5, `bent ${bent}`);
});

test('on hundreds of polygons the default work proves every answer to 5 percent', () => {
  // Unit cells in 3 x 3 patches of five weights. Before a piece was left only through its other polygon, the relaxed
  // paths slid along touching pieces and 18 of 60 such queries stayed unproved, the worst by 72 percent.
  const next = random(5),
    size = 20;
  let found = 0,
    most = 0;
  for (let map = 0; map < 2; map++) {
    const patch = Array.from({ length: 200 }, () => '..bcd'[Math.floor(next() * 5)]),
      rows = randomMap(next, size, size, 0.15).map((row, z) =>
        [...row].map((c, x) => (c === '#' ? c : patch[Math.floor(x / 3) + 14 * Math.floor(z / 3)])).join(''),
      ),
      mesh = grid(rows),
      free = rows.flatMap((row, z) => [...row].flatMap((c, x) => (c === '#' ? [] : [[x, z, c]])));
    free.forEach(([, , c], p) => mesh.setAreaCost(p, WEIGHTS[c]));
    const search = new WeightedAnyAngleSearch(mesh);
    for (let query = 0; query < 10; query++) {
      const pick = () => {
          const [x, z] = free[Math.floor(next() * free.length)];
          return [x + 0.05 + next() * 0.9, 0, z + 0.05 + next() * 0.9];
        },
        route = search.route(pick(), pick());
      if (!route) continue;
      found++;
      most = Math.max(most, route.work);
      assert.ok(
        route.cost <= route.lowerBound * 1.05 + 1e-8,
        `map ${map} query ${query}: ${route.cost / route.lowerBound}`,
      );
    }
  }
  assert.ok(found >= 18, `found ${found}`);
  assert.ok(most < 6_000_000, `work ${most}`);
});

test('on 1,600 polygons the default work proves every answer to 5 percent', () => {
  // Split by weight times length, only the dearest portals were halved at first: the cheap ones kept touching each other,
  // relaxed paths ran through them for nothing, and these queries spent 8 million arcs and ended 21 to 44 percent open.
  const next = random(5),
    maps = Array.from({ length: 5 }, () => {
      const patch = Array.from({ length: 200 }, () => '..bcd'[Math.floor(next() * 5)]),
        rows = randomMap(next, 40, 40, 0.15).map((row, z) =>
          [...row].map((c, x) => (c === '#' ? c : patch[Math.floor(x / 3) + 14 * Math.floor(z / 3)])).join(''),
        ),
        mesh = grid(rows),
        free = rows.flatMap((row, z) => [...row].flatMap((c, x) => (c === '#' ? [] : [[x, z, c]])));
      free.forEach(([, , c], p) => mesh.setAreaCost(p, WEIGHTS[c]));
      return { free, search: new WeightedAnyAngleSearch(mesh) };
    });
  let work = 0;
  for (let query = 0; query < 28; query++) {
    const { free, search } = maps[query % 5],
      pick = () => {
        const [x, z] = free[Math.floor(next() * free.length)];
        return [x + 0.05 + next() * 0.9, 0, z + 0.05 + next() * 0.9];
      },
      start = pick(),
      end = pick();
    if (![9, 15, 27].includes(query)) continue;
    const route = search.route(start, end);
    assert.ok(route.cost <= route.lowerBound * 1.05 + 1e-8, `query ${query}: ${route.cost / route.lowerBound}`);
    work += route.work;
  }
  assert.ok(work < 18_000_000, `work ${work}`);
});

test('a spent work budget answers with honest bounds, the same work every time, and bad input is refused', () => {
  const mesh = strips([1, 4, 2, 7, 1.5]),
    search = new WeightedAnyAngleSearch(mesh),
    start = [0.1, 0, 0.2],
    end = [4.9, 0, 1.8],
    close = search.route(start, end, { tolerance: 1e-5, maxWork: CLOSE.maxWork }),
    // The first search alone: a path, bounded below by the straight line.
    short = search.route(start, end, { tolerance: 0, maxWork: 1 });
  near(short.lowerBound, flat(start, end), 'straight line');
  assert.ok(short.cost >= close.lowerBound && short.cost <= close.cost * 1.01, `first path ${short.cost}`);
  const some = search.route(start, end, { tolerance: 0, maxWork: 20_000 });
  // The arc that passes the budget is counted with the rest of its node's.
  assert.ok(some.work < 21_000 && some.work > short.work, `work ${some.work}`);
  assert.ok(some.lowerBound > short.lowerBound && some.lowerBound <= close.cost);
  assert.deepEqual(search.route(start, end, { tolerance: 0, maxWork: 20_000 }), some);
  assert.deepEqual(search.path(start, end), search.route(start, end).points);
  assert.equal(search.route([-1, 0, 0], end), null);
  assert.equal(search.path(start, [9, 0, 9]), null);
  const same = search.route(start, start);
  assert.equal(same.cost, 0);
  assert.deepEqual(same.points, [start, start]);
  // A straight way over even ground is proved by the first search.
  const even = new WeightedAnyAngleSearch(strips([1, 1, 1])).route([0.1, 0, 0.2], [2.9, 0, 1.8], { tolerance: 0 });
  near(even.cost, even.lowerBound, 'straight');
  assert.equal(even.points.length, 2);
  assert.throws(() => search.route([NaN, 0, 0], end), RangeError);
  assert.throws(() => search.route(start, end, { tolerance: -1 }), RangeError);
  assert.throws(() => search.route(start, end, { maxWork: 0 }), RangeError);
  assert.throws(() => search.route(start, end, { filter: [0.5] }), RangeError);
  assert.throws(() => new WeightedAnyAngleSearch({}), TypeError);
});
