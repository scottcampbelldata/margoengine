import test from 'node:test';
import assert from 'node:assert/strict';
import { NavMesh } from '../dist/index.js';
import { TiledNavMesh } from '../dist/tiles.js';
import { NavHierarchy } from '../dist/hierarchy.js';
import { NavMeshQuery } from '../dist/queries.js';

/** A strip of `n` unit cells along X, one metre wide: cell i spans x = i to i + 1. */
const strip = (n) => {
  const vertices = [],
    polygons = [];
  for (let i = 0; i <= n; i++) vertices.push([i, 0, 0], [i, 0, 1]);
  for (let i = 0; i < n; i++) polygons.push([2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1]);
  return new NavMesh(vertices, polygons);
};
const centre = (i) => [i + 0.5, 0, 0.5];
/** What a route costs: walked segments by length times the area cost under them, off-mesh crossings by link cost. */
const costOf = (mesh, route, links) => {
  let total = 0;
  for (let i = 0; i + 1 < route.points.length; i++) {
    const a = route.points[i],
      b = route.points[i + 1];
    if (route.offMesh.includes(i)) {
      // Two links may join the same cells; the route does not say which, so charge the cheaper.
      const matching = links.filter(
        (l) =>
          (l.from === a[0] - 0.5 && l.to === b[0] - 0.5) || (l.both && l.to === a[0] - 0.5 && l.from === b[0] - 0.5),
      );
      assert.ok(matching.length, `segment ${i} crosses a known link`);
      total += Math.min(...matching.map((l) => l.cost));
      continue;
    }
    // Walks run along z = 0.5, so split at every cell line and charge each piece its cell's cost.
    const lo = Math.min(a[0], b[0]),
      hi = Math.max(a[0], b[0]);
    for (let x = lo; x < hi; ) {
      const next = Math.min(hi, Math.floor(x) + 1);
      total += (next - x) * mesh.areaCost(Math.floor(x));
      x = next;
    }
  }
  return total;
};
/**
 * Independent oracle: Floyd-Warshall over every point the search can stand on (cell lines, cell centres, where the
 * links start and land), with walks inside one cell at its area cost and links at what they cost.
 */
const oracle = (n, areaCosts, links, from, to) => {
  // Nodes 0..n are the cell lines x = 0..n, n + 1 + i the centre of cell i.
  const size = 2 * n + 1,
    d = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => (i === j ? 0 : Infinity))),
    edge = (a, b, w) => {
      if (w < d[a][b]) d[a][b] = w;
    };
  for (let i = 0; i < n; i++) {
    const c = n + 1 + i,
      w = areaCosts[i];
    for (const [a, b, len] of [
      [i, i + 1, 1],
      [i, c, 0.5],
      [c, i + 1, 0.5],
    ]) {
      edge(a, b, len * w);
      edge(b, a, len * w);
    }
  }
  for (const link of links) {
    edge(n + 1 + link.from, n + 1 + link.to, link.cost);
    if (link.both) edge(n + 1 + link.to, n + 1 + link.from, link.cost);
  }
  for (let k = 0; k < size; k++)
    for (let i = 0; i < size; i++)
      for (let j = 0; j < size; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  return d[n + 1 + from][n + 1 + to];
};
/** Mulberry32, so a failing seed can be run again. */
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('a free teleporter behind the start is taken: cheap off-mesh links keep the A* estimate a lower bound', () => {
  const mesh = strip(10),
    links = [{ from: 4, to: 9, cost: 0, both: false }];
  mesh.addOffMeshLink(centre(4), centre(9), { cost: 0, bidirectional: false });
  const route = mesh.route(centre(5), centre(9));
  assert.deepEqual(route.points, [centre(5), centre(4), centre(9)]);
  assert.deepEqual(route.offMesh, [1]);
  assert.equal(costOf(mesh, route, links), 1);
});

test('seeded strips with discounted links route at the Floyd-Warshall oracle cost', () => {
  let checked = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed),
      n = 6 + Math.floor(next() * 10),
      mesh = strip(n),
      areaCosts = [],
      links = [];
    // Unit area costs and whole link costs keep a cell centre's cost a half step off its edges' costs. The search
    // keeps one entry point per polygon, so only then do it and the point oracle meet the same optimum.
    for (let i = 0; i < n; i++) areaCosts.push(1);
    const count = 1 + Math.floor(next() * 3);
    for (let k = 0; k < count; k++) {
      const from = Math.floor(next() * n),
        to = (from + 2 + Math.floor(next() * (n - 2))) % n,
        // A whole number below the straight length, free included.
        cost = Math.floor(next() * Math.abs(to - from)),
        both = next() < 0.5;
      links.push({ from, to, cost, both });
      mesh.addOffMeshLink(centre(from), centre(to), { cost, bidirectional: both });
    }
    const from = Math.floor(next() * n);
    let to = Math.floor(next() * n);
    if (to === from) to = (from + 1) % n;
    const route = mesh.route(centre(from), centre(to)),
      want = oracle(n, areaCosts, links, from, to);
    assert.ok(route, `seed ${seed}: a route exists`);
    assert.equal(costOf(mesh, route, links), want, `seed ${seed}: route cost equals the oracle`);
    checked++;
  }
  assert.equal(checked, 300);
});

test('removing the only cheap link brings back the straight-line estimate and the same routes', () => {
  const mesh = strip(10),
    id = mesh.addOffMeshLink(centre(4), centre(9), { cost: 0, bidirectional: false });
  assert.ok(mesh.removeOffMeshLink(id));
  const route = mesh.route(centre(5), centre(9));
  assert.deepEqual(route.points, [centre(5), centre(9)]);
  assert.deepEqual(route.offMesh, []);
});

/** A 40 m by 4 m floor as two triangles, for the tiled mesh. */
const floor = () => [
  [0, 0, 0, 40, 0, 0, 40, 0, 4, 0, 0, 4],
  [0, 2, 1, 0, 3, 2],
];
const tiledOptions = { cs: 0.25, ch: 0.1, walkableRadius: 0, walkableHeight: 8, walkableClimb: 2, tileSize: 32 };
const walked = (route) => {
  let total = 0;
  for (let i = 0; i + 1 < route.points.length; i++)
    if (!route.offMesh.includes(i)) {
      const [a, b] = [route.points[i], route.points[i + 1]];
      total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    }
  return total;
};

test('tiled meshes, their hierarchy and partial queries take a free teleporter behind the start', () => {
  const [positions, indices] = floor(),
    world = new TiledNavMesh(positions, indices, tiledOptions),
    start = [20, 0, 2],
    goal = [38, 0, 2];
  world.addOffMeshLink([18, 0, 2], goal, { cost: 0, bidirectional: false });
  for (const [name, route] of [
    ['tiled', world.route(start, goal)],
    ['hierarchy', new NavHierarchy(world, { clusterTiles: 1 }).route(start, goal)],
    ['query', new NavMeshQuery(world).route(start, goal)],
  ]) {
    assert.ok(route, `${name}: a route exists`);
    assert.equal(route.offMesh.length, 1, `${name}: the route takes the teleporter`);
    assert.ok(walked(route) < 2.5, `${name}: walks ${walked(route)} m, not the 18 m straight on`);
  }
});
