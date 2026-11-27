import test from 'node:test';
import assert from 'node:assert/strict';
import { NavMesh } from '../dist/index.js';
import { TiledNavMesh } from '../dist/tiles.js';
import { AnyAngleSearch } from '../dist/any-angle.js';
import { grid, random, randomMap } from './support/grid-map.mjs';

/** Whether the closed segment stays on free cells: every stretch between grid lines lies in or beside a free cell. */
function sees(rows, a, b) {
  const cuts = [0, 1];
  for (const axis of [0, 1]) {
    const d = b[axis] - a[axis];
    if (Math.abs(d) < 1e-12) continue;
    for (let line = Math.ceil(Math.min(a[axis], b[axis])); line <= Math.max(a[axis], b[axis]); line++) {
      const t = (line - a[axis]) / d;
      if (t > 0 && t < 1) cuts.push(t);
    }
  }
  cuts.sort((x, y) => x - y);
  const free = (x, z) => rows[z]?.[x] !== undefined && rows[z][x] !== '#';
  const cells = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? [Math.round(v) - 1, Math.round(v)] : [Math.floor(v)]);
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] - cuts[i - 1] < 1e-9) continue;
    const t = (cuts[i] + cuts[i - 1]) / 2,
      x = a[0] + t * (b[0] - a[0]),
      z = a[1] + t * (b[1] - a[1]);
    if (!cells(x).some((cx) => cells(z).some((cz) => free(cx, cz)))) return false;
  }
  return true;
}

/** The oracle: Dijkstra over the visibility graph of every grid corner (Lozano-Perez and Wesley 1979). */
function oracle(rows, start, end) {
  const nodes = [start, end];
  for (let z = 0; z <= rows.length; z++) for (let x = 0; x <= rows[0].length; x++) nodes.push([x, z]);
  const best = nodes.map(() => Infinity),
    done = new Set();
  best[0] = 0;
  for (;;) {
    let next = -1;
    for (let i = 0; i < nodes.length; i++)
      if (!done.has(i) && best[i] < Infinity && (next < 0 || best[i] < best[next])) next = i;
    if (next < 0) return null;
    if (next === 1) return best[1];
    done.add(next);
    for (let i = 0; i < nodes.length; i++) {
      if (done.has(i)) continue;
      const d = best[next] + Math.hypot(nodes[i][0] - nodes[next][0], nodes[i][1] - nodes[next][1]);
      if (d < best[i] && sees(rows, nodes[next], nodes[i])) best[i] = d;
    }
  }
}

const length = (points) =>
  points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - points[i][0], p[2] - points[i][2]), 0);
const near = (a, b, label, slack = 1e-8) => assert.ok(Math.abs(a - b) <= slack, `${label}: ${a} against ${b}`);
const at = ([x, z]) => [x, 0, z];

test('known answers: around one block and around staggered walls', () => {
  const ring = grid(['...', '.#.', '...']),
    route = new AnyAngleSearch(ring).route([0.5, 0, 1.5], [2.5, 0, 1.5]);
  near(route.length, 1 + Math.SQRT2, 'ring');
  near(length(route.points), route.length, 'ring points');
  assert.equal(route.points.length, 4);
  assert.deepEqual(route.offMesh, []);
  // Two walls, one open at the bottom and one at the top: the path bends at both ends of each.
  const rows = ['..#....', '..#....', '..#.#..', '....#..', '....#..'],
    weave = new AnyAngleSearch(grid(rows)).route([0.5, 0, 0.5], [6.5, 0, 4.5]),
    corners = [
      [0.5, 0.5],
      [2, 3],
      [3, 3],
      [4, 2],
      [5, 2],
      [6.5, 4.5],
    ];
  near(weave.length, length(corners.map(at)), 'weave');
  assert.deepEqual(
    weave.points.map((p) => [p[0], p[2]]),
    corners,
  );
});

test('simple cases agree with the funnel', () => {
  const mesh = grid(['..##', '..##', '....', '....']),
    search = new AnyAngleSearch(mesh);
  for (const [start, end] of [
    [
      [0.5, 0.5],
      [3.5, 3.5],
    ],
    [
      [0.5, 0.5],
      [1.5, 3.5],
    ],
    [
      [3.5, 2.5],
      [0.2, 0.2],
    ],
    [
      [1.2, 1.2],
      [1.3, 1.4],
    ],
    [
      [2, 2],
      [0.5, 0.5],
    ],
    [
      [2, 3],
      [2, 3],
    ],
  ]) {
    const funnel = mesh.path(at(start), at(end)),
      exact = search.path(at(start), at(end));
    near(length(exact), length(funnel), `${start} to ${end}`);
    assert.deepEqual(exact[0], at(start));
    assert.deepEqual(exact.at(-1), at(end));
  }
});

test('random maps match a visibility graph oracle, whatever the polygons and wherever the mesh lies', () => {
  const next = random(20261127);
  let found = 0,
    none = 0,
    bent = 0,
    shorter = 0,
    worst = 0;
  for (let map = 0; map < 60; map++) {
    const width = 4 + Math.floor(next() * 7),
      depth = 4 + Math.floor(next() * 7),
      rows = randomMap(next, width, depth, 0.15 + next() * 0.3);
    if (!rows.some((row) => row.includes('.'))) continue;
    // Quads, then triangles split either way, then triangles turned and moved far from the origin.
    const angle = next() * Math.PI,
      turn = ([x, y, z]) => [
        3000 + x * Math.cos(angle) - z * Math.sin(angle),
        y,
        -2000 + x * Math.sin(angle) + z * Math.cos(angle),
      ],
      same = (p) => p,
      split = () => (next() < 0.5 ? 0 : 1),
      meshes = [
        [grid(rows), same],
        [grid(rows, { split }), same],
        [grid(rows, { split, move: turn }), turn],
      ],
      searches = meshes.map(([mesh]) => new AnyAngleSearch(mesh));
    const pick = () => {
      for (;;) {
        // A quarter of the coordinates sit on grid lines, the degenerate places.
        const round = (v) => (next() < 0.25 ? Math.round(v) : v),
          p = [round(next() * width), round(next() * depth)];
        if (meshes[0][0].locate(at(p)) >= 0) return p;
      }
    };
    for (let query = 0; query < 12; query++) {
      const start = pick(),
        end = pick(),
        truth = oracle(rows, start, end);
      meshes.forEach(([mesh, move], i) => {
        const s = move(at(start)),
          e = move(at(end));
        // Turning a point on the border can round it off the mesh.
        if (mesh.locate(s) < 0 || mesh.locate(e) < 0) return;
        const route = searches[i].route(s, e),
          label = `map ${map} mesh ${i} ${JSON.stringify(rows)} ${start} to ${end}`;
        if (truth === null) {
          assert.equal(route, null, label);
          none++;
          return;
        }
        assert.ok(route, label);
        near(route.length, truth, label, 1e-6);
        near(length(route.points), route.length, `${label} points`, 1e-6);
        found++;
        if (route.points.length > 2) bent++;
        worst = Math.max(worst, route.expanded);
        if (i !== 0) return;
        for (let k = 1; k < route.points.length; k++) {
          const a = route.points[k - 1],
            b = route.points[k];
          assert.ok(sees(rows, [a[0], a[2]], [b[0], b[2]]), `${label} segment ${k} leaves the mesh`);
        }
        const funnel = length(mesh.path(s, e));
        assert.ok(route.length <= funnel + 1e-8, `${label}: longer than the funnel`);
        if (funnel > route.length + 1e-6) shorter++;
      });
    }
  }

  assert.ok(found > 1000 && none > 20 && bent > 300, `found ${found}, none ${none}, bent ${bent}`);
  assert.ok(shorter > 0, 'some funnel route is longer than the shortest');
  assert.ok(worst < 600, `most expanded nodes ${worst}`);
});

test('area filters wall ground off; weighted ground is refused', () => {
  const mesh = grid(['...', '.m.', '...'], { areas: { m: 1 } }),
    search = new AnyAngleSearch(mesh),
    start = [0.5, 0, 1.5],
    end = [2.5, 0, 1.5];
  near(search.route(start, end).length, 2, 'open');
  near(search.route(start, end, { filter: [1, Infinity] }).length, 1 + Math.SQRT2, 'forbidden');
  near(search.route(start, end, { filter: [1, 1] }).length, 2, 'weightless filter');
  assert.throws(() => search.route(start, end, { filter: [1, 3] }), /cannot weigh area costs/);
  assert.throws(() => search.route(start, end, { filter: [0.5] }), RangeError);
  // A walker standing on forbidden ground leaves it; none walks onto it.
  near(search.route([1.5, 0, 1.5], end, { filter: [1, Infinity] }).length, 1, 'walk out');
  assert.equal(search.route(start, [1.5, 0, 1.5], { filter: [1, Infinity] }), null);
  // A change to the mesh is seen by the next query.
  const middle = mesh.locate([1.5, 0, 1.5]);
  mesh.setAreaCost(middle, Infinity);
  near(search.route(start, end).length, 1 + Math.SQRT2, 'blocked');
  mesh.setAreaCost(middle, 2);
  assert.throws(() => search.route(start, end), /cannot weigh area costs/);
  mesh.setAreaCost(middle, 1);
  near(search.route(start, end).length, 2, 'open again');
});

test('off-mesh links are taken when they make the shortest way', () => {
  const mesh = grid(['..#..', '..#..', '..#..']),
    search = new AnyAngleSearch(mesh),
    start = [0.5, 0, 0.5],
    end = [4.5, 0, 0.5];
  assert.equal(search.route(start, end), null);
  mesh.addOffMeshLink([1.5, 0, 2.5], [3.5, 0, 2.5], { cost: 5 });
  const route = search.route(start, end);
  near(route.length, 2 * Math.hypot(1, 2) + 5, 'one link');
  assert.deepEqual(route.offMesh, [1]);
  assert.deepEqual(route.points, [start, [1.5, 0, 2.5], [3.5, 0, 2.5], end]);
  // A teleporter is cheaper than its length: the estimate drops to it.
  const teleport = mesh.addOffMeshLink([0.5, 0, 1.5], [4.5, 0, 1.5], { cost: 0 }),
    jumped = search.route(start, end);
  near(jumped.length, 2, 'teleport');
  assert.deepEqual(jumped.offMesh, [1]);
  near(search.route(end, start).length, 2, 'both ways');
  // A link that lands on the end.
  const landing = search.route(start, [4.5, 0, 1.5]);
  near(landing.length, 1, 'lands on the end');
  assert.deepEqual(landing.offMesh, [1]);
  assert.equal(landing.points.length, 3);
  mesh.removeOffMeshLink(teleport);
  near(search.route(start, end).length, route.length, 'removed');
  // Walking beats a dear link.
  const open = grid(['.....']);
  open.addOffMeshLink([0.5, 0, 0.5], [4.5, 0, 0.5], { cost: 9 });
  assert.deepEqual(new AnyAngleSearch(open).route([0.5, 0, 0.5], [4.5, 0, 0.5]).offMesh, []);
});

test('a tiled mesh: seams do not bend the path, and obstacles are rounded at their corners', () => {
  const positions = [0, 0, 0, 24, 0, 0, 24, 0, 24, 0, 0, 24],
    world = new TiledNavMesh(positions, [0, 2, 1, 0, 3, 2], { cs: 0.25, ch: 0.1, tileSize: 16, walkableRadius: 1 }),
    search = new AnyAngleSearch(world),
    straight = search.route([2.1, 0, 3.3], [21.7, 0, 19.2]);
  near(straight.length, Math.hypot(19.6, 15.9), 'across the seams', 1e-6);
  assert.equal(straight.points.length, 2);
  for (const [x, z] of [
    [6, 5],
    [11, 10],
    [16, 14],
    [8, 15],
    [15, 6],
  ])
    world.addObstacle({ min: [x, -1, z], max: [x + 3, 2, z + 3] });
  world.update();
  const next = random(7);
  let bent = 0;
  for (let query = 0; query < 150; query++) {
    const a = [1 + next() * 22, 0, 1 + next() * 22],
      b = [1 + next() * 22, 0, 1 + next() * 22];
    if (world.locate(a) < 0 || world.locate(b) < 0) continue;
    const funnel = world.path(a, b),
      route = search.route(a, b);
    assert.equal(route === null, funnel === null, `query ${query}`);
    if (!route) continue;
    assert.ok(route.length <= length(funnel) + 1e-6, `query ${query}: ${route.length} against ${length(funnel)}`);
    near(length(route.points), route.length, `query ${query}`, 1e-6);
    // The reverse way is as long, and every metre of it is on the mesh.
    near(search.route(b, a).length, route.length, `query ${query} back`, 1e-6);
    if (route.points.length > 2) bent++;
    for (let i = 1; i < route.points.length; i++) {
      const p = route.points[i - 1],
        q = route.points[i],
        steps = Math.ceil(length([p, q]) / 0.05);
      for (let k = 0; k <= steps; k++) {
        const on = p.map((v, axis) => v + ((q[axis] - v) * k) / steps);
        assert.ok(world.locate(on) >= 0, `query ${query} leaves the mesh at ${on}`);
      }
    }
  }
  assert.ok(bent > 30, `bent ${bent}`);
});

test('slopes are measured in the ground plane and bad input is refused', () => {
  const ramp = new NavMesh(
      [
        [0, 0, 0],
        [4, 3, 0],
        [4, 3, 4],
        [0, 0, 4],
      ],
      [[0, 1, 2, 3]],
    ),
    search = new AnyAngleSearch(ramp);
  near(search.route([0, 0, 2], [4, 3, 2]).length, 4, 'ground plane');
  assert.equal(search.route([-1, 0, 0], [1, 0, 1]), null);
  assert.equal(search.path([1, 0, 1], [9, 0, 9]), null);
  assert.throws(() => search.route([NaN, 0, 0], [1, 0, 1]), RangeError);
  assert.throws(() => search.route([1, 0, 1], [2, 0, 2], { maxNodes: 0 }), RangeError);
  assert.throws(() => new AnyAngleSearch({}), TypeError);
  const hairpin = new AnyAngleSearch(grid(['.....', '####.', '.....']));
  assert.throws(
    () => hairpin.route([0.5, 0, 0.5], [0.5, 0, 2.5], { maxNodes: 3 }),
    (error) => error.code === 'failed',
  );
  near(hairpin.route([0.5, 0, 0.5], [0.5, 0, 2.5]).length, 2 * Math.hypot(3.5, 0.5) + 1, 'hairpin');
});

test('two portals on one edge, as a tile seam makes them: the path bends and walks the edge', () => {
  // A long polygon over two small ones, each joined to a part of its lower edge, with a wall between.
  const quad = (x0, x1, z0, z1) => [
      [x0, 0, z0],
      [x1, 0, z0],
      [x1, 0, z1],
      [x0, 0, z1],
    ],
    polygons = [quad(0, 1, 0, 1), quad(0, 4, 1, 2), quad(3, 4, 0, 1)],
    portal = (to, x0, x1) => ({ to, left: [x0, 0, 1], right: [x1, 0, 1] }),
    links = [[portal(1, 0, 1)], [portal(0, 0, 1), portal(2, 3, 4)], [portal(1, 3, 4)]],
    mesh = {
      version: 0,
      locate: ([x, , z]) => polygons.findIndex((p) => x >= p[0][0] && x <= p[1][0] && z >= p[0][2] && z <= p[2][2]),
      polygonPoints: (p) => polygons[p],
      polygonLinks: (p) => links[p],
      polygonArea: () => 0,
    },
    search = new AnyAngleSearch(mesh);
  for (const [start, end, corners] of [
    [
      [0.5, 0, 0.5],
      [3.5, 0, 0.5],
      [
        [1, 0, 1],
        [3, 0, 1],
      ],
    ],
    [
      [3.5, 0, 0.5],
      [0.5, 0, 0.5],
      [
        [3, 0, 1],
        [1, 0, 1],
      ],
    ],
  ]) {
    const route = search.route(start, end);
    assert.deepEqual(route?.points, [start, ...corners, end]);
    near(route.length, 2 + Math.SQRT2, 'along the seam');
  }
});

test('work stays near the size of the map when many ways are equally long', () => {
  // A grid is full of equal ways. Before each view was kept once, copies multiplied at every corner: 556,203 nodes.
  const next = random(3),
    rows = randomMap(next, 30, 30, 0.15),
    mesh = grid(rows),
    search = new AnyAngleSearch(mesh),
    pick = () => {
      for (;;) {
        const p = at([Math.round(next() * 60) / 2, Math.round(next() * 60) / 2]);
        if (mesh.locate(p) >= 0) return p;
      }
    };
  let worst = 0,
    total = 0;
  for (let query = 0; query < 300; query++) {
    const expanded = search.route(pick(), pick())?.expanded ?? 0;
    worst = Math.max(worst, expanded);
    total += expanded;
  }
  console.log({ polygons: mesh.polygonCount, worst, mean: Math.round(total / 300) });
  assert.ok(worst < 3000, `most expanded nodes ${worst}`);
  assert.ok(total < 300 * 200, `expanded nodes ${total}`);
});
