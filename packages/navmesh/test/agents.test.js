import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd, NavMesh } from '../dist/index.js';
import { buildNavMesh } from '../dist/build.js';
import { NavAgents } from '../dist/agents.js';
import { TiledNavMesh } from '../dist/tiles.js';

function box(positions, indices, [x0, x1, z0, z1, height = 3]) {
  const base = positions.length / 3;
  for (const y of [0, height]) positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
  for (const [a, b, c, d] of [
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ])
    indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
}
/** Two halves of a 30 x 30 floor split by a wall along z = 15, with a 1.2 m gap at x = 5 and a 6 m one at x = 24. */
function gaps() {
  const positions = [0, 0, 0, 30, 0, 0, 30, 0, 30, 0, 0, 30],
    indices = [0, 2, 1, 0, 3, 2];
  box(positions, indices, [0, 4.4, 14.5, 15.5]);
  box(positions, indices, [5.6, 21, 14.5, 15.5]);
  box(positions, indices, [27, 30, 14.5, 15.5]);
  return [positions, indices];
}
const length = (path) =>
  path.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - path[i - 1][0], p[2] - path[i - 1][2]) : sum), 0);
const grid = { cs: 0.1, ch: 0.1 };

test('a big body does not fit where a small one does: same level, a mesh per size', () => {
  const [positions, indices] = gaps(),
    agents = new NavAgents(positions, indices, {
      ...grid,
      types: {
        soldier: { radius: 0.3, height: 1.8 },
        monster: { radius: 1.5, height: 2.8 },
        guard: { radius: 0.3, height: 1.8 },
      },
    }),
    from = [5, 0, 5],
    to = [5, 0, 25];
  assert.equal(agents.meshCount, 2, 'soldier and guard share one');
  assert.equal(agents.mesh('soldier'), agents.mesh('guard'));
  const soldier = agents.path('soldier', from, to),
    monster = agents.path('monster', from, to);
  assert.ok(length(soldier) < 21, 'through the small gap');
  assert.ok(length(monster) > 35, 'round by the wide gap');
});

test('filters forbid and price areas without another mesh', () => {
  const positions = [0, 0, 0, 30, 0, 0, 30, 0, 30, 0, 0, 30],
    indices = [0, 2, 1, 0, 3, 2],
    agents = new NavAgents(positions, indices, {
      ...grid,
      walkableRadius: undefined,
      areas: [
        { min: [10, -1, 0], max: [20, 1, 26], area: 'water' },
        { min: [0, -1, 26], max: [30, 1, 30], area: 'road' },
      ],
      types: {
        walker: { radius: 0.4, areas: { water: Infinity } },
        swimmer: { radius: 0.4, areas: { ground: Infinity, road: Infinity } },
        wader: { radius: 0.4, areas: { water: 2 } },
        vehicle: { radius: 0.4, areas: { ground: 5, water: Infinity } },
      },
    }),
    left = [5, 0, 5],
    right = [25, 0, 5];
  assert.equal(agents.meshCount, 1);
  assert.deepEqual(agents.areas, ['ground', 'water', 'road']);
  const walker = agents.path('walker', left, right);
  assert.ok(length(walker) > 40, `goes round the water: ${length(walker)}`);
  const wader = agents.path('wader', left, right);
  assert.ok(length(wader) < 21, `crosses at double cost, cheaper than going round: ${length(wader)}`);
  assert.equal(agents.path('swimmer', left, right), null, 'neither end is water, and it cannot leave it');
  assert.ok(agents.path('swimmer', [12, 0, 5], [18, 0, 20]), 'in the water it swims');
  assert.equal(agents.path('swimmer', [12, 0, 5], [5, 0, 5]), null);
  const vehicle = agents.path('vehicle', left, [25, 0, 24]);
  assert.ok(
    vehicle.some((p) => p[2] >= 25.9),
    'the road is worth the trip',
  );
});

test('slopes and steps sort vehicles from people', () => {
  const positions = [
      // A floor, a stair-steep ramp to a platform, and the platform.
      0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10, 10, 0, 0, 14, 3, 0, 14, 3, 10, 10, 0, 10, 14, 3, 0, 24, 3, 0, 24, 3, 10,
      14, 3, 10,
    ],
    indices = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 8, 11, 10],
    agents = new NavAgents(positions, indices, {
      ...grid,
      types: { person: { radius: 0.4, maxSlope: 45 }, truck: { radius: 0.4, maxSlope: 20 } },
    });
  assert.ok(agents.path('person', [5, 0, 5], [20, 3, 5]));
  assert.equal(agents.path('truck', [5, 0, 5], [20, 3, 5]), null);
});

test('a filter works on a plain NavMesh and on tiles', () => {
  const mesh = new NavMesh(
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [0, 0, 1],
      [1, 0, 1],
      [2, 0, 1],
    ],
    [
      [0, 1, 4, 3],
      [1, 2, 5, 4],
    ],
  );
  assert.equal(mesh.polygonArea(1), 0);
  mesh.setPolygonArea(1, 3);
  assert.equal(mesh.polygonArea(1), 3);
  assert.ok(mesh.path([0.5, 0, 0.5], [1.5, 0, 0.5]));
  const version = mesh.version;
  assert.equal(mesh.path([0.5, 0, 0.5], [1.5, 0, 0.5], [1, 1, 1, Infinity]), null);
  assert.ok(mesh.path([0.5, 0, 0.5], [1.5, 0, 0.5], [1, 1, 1, 2]));
  assert.ok(mesh.path([0.5, 0, 0.5], [1.5, 0, 0.5], []), 'an area a filter does not list costs 1');
  mesh.setPolygonArea(0, 2);
  assert.ok(mesh.version > version, 'crowds replan');
  assert.throws(() => mesh.setPolygonArea(0, 256), RangeError);
  assert.throws(() => mesh.setPolygonArea(0, 1.5), RangeError);

  const positions = [0, 0, 0, 40, 0, 0, 40, 0, 40, 0, 0, 40],
    indices = [0, 2, 1, 0, 3, 2],
    areas = [{ min: [10, -1, 0], max: [30, 1, 38], area: 1 }],
    options = { cs: 0.25, ch: 0.1, walkableRadius: 1, areas },
    tiled = new TiledNavMesh(positions, indices, { ...options, tileSize: 32 }),
    whole = buildNavMesh(positions, indices, options),
    filter = [1, Infinity],
    a = [5, 0, 5],
    b = [35, 0, 5];
  assert.ok(length(tiled.path(a, b)) < 31);
  assert.ok(length(tiled.path(a, b, filter)) > 60);
  assert.ok(length(whole.path(a, b, filter)) > 60);
  assert.equal(tiled.polygonArea(tiled.locate([20, 0, 20])), 1);
  assert.equal(tiled.polygonArea(tiled.locate([5, 0, 20])), 0);
});

test('area borders are polygon borders, and the walkable area does not change', () => {
  const positions = [0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 20],
    indices = [0, 2, 1, 0, 3, 2],
    plain = buildNavMesh(positions, indices, { cs: 0.25, ch: 0.1 }),
    marked = buildNavMesh(positions, indices, {
      cs: 0.25,
      ch: 0.1,
      areas: [{ min: [5, -1, 5], max: [9, 1, 9], area: 7 }],
    });
  for (let x = 0.5; x < 20; x += 0.5)
    for (let z = 0.5; z < 20; z += 0.5) {
      const at = [x + 0.05, 0, z + 0.05],
        polygon = marked.locate(at);
      assert.equal(polygon >= 0, plain.locate(at) >= 0);
      if (polygon < 0) continue;
      const inside = at[0] > 5 && at[0] < 9 && at[2] > 5 && at[2] < 9;
      assert.equal(marked.polygonArea(polygon), inside ? 7 : 0, `(${at[0]}, ${at[2]})`);
    }
  assert.throws(
    () => buildNavMesh(positions, indices, { areas: [{ min: [0, 0, 0], max: [1, 1, 1], area: 300 }] }),
    RangeError,
  );
});

test('a crowd holds walkers of every size and kind, each on its own mesh and ground', () => {
  const [positions, indices] = gaps(),
    agents = new NavAgents(positions, indices, {
      ...grid,
      areas: [{ min: [22, -1, 0], max: [26, 1, 14], area: 'lava' }],
      types: {
        soldier: { radius: 0.3, height: 1.8, maxSpeed: 4, areas: { lava: Infinity } },
        monster: { radius: 1.2, height: 2.8, maxSpeed: 4 },
      },
    }),
    crowd = new Crowd(agents.mesh('soldier'), { neighborDistance: 4 }),
    soldier = agents.addAgent(crowd, 'soldier', { position: [5, 0, 5] }),
    monster = agents.addAgent(crowd, 'monster', { position: [5, 0, 7] });
  assert.equal(monster.radius, 1.2);
  assert.notEqual(soldier.surface, monster.surface);
  soldier.setTarget([5, 0, 25]);
  monster.setTarget([12, 0, 25]);
  let soldierLava = 0;
  for (let i = 0; i < 600 && monster.state !== 'arrived'; i++) {
    crowd.update(1 / 30);
    if (soldier.position[0] > 22 && soldier.position[0] < 26 && soldier.position[2] < 14) soldierLava++;
  }
  assert.equal(soldier.state, 'arrived');
  assert.equal(monster.state, 'arrived');
  assert.equal(soldierLava, 0);
});

test('an agent on a filter does not slide onto ground it may not enter', () => {
  const positions = [0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 20],
    indices = [0, 2, 1, 0, 3, 2],
    mesh = buildNavMesh(positions, indices, {
      cs: 0.25,
      ch: 0.1,
      areas: [{ min: [10, -1, 0], max: [20, 1, 20], area: 1 }],
    }),
    crowd = new Crowd(mesh),
    agent = crowd.addAgent({ position: [8, 0, 10], filter: [1, Infinity] }),
    free = crowd.addAgent({ position: [8, 0, 3] });
  agent.setTarget([15, 0, 10]);
  free.setTarget([15, 0, 3]);
  for (let i = 0; i < 200; i++) crowd.update(1 / 30);
  assert.equal(agent.state, 'unreachable');
  assert.ok(agent.position[0] <= 10.01);
  assert.equal(free.state, 'arrived');
});

test('a filter cost below 1 is refused: it would break the search bound', () => {
  const positions = [0, 0, 0, 20, 0, 0, 20, 0, 20, 0, 0, 20],
    indices = [0, 2, 1, 0, 3, 2],
    options = { cs: 0.5, ch: 0.1 },
    mesh = buildNavMesh(positions, indices, options),
    tiled = new TiledNavMesh(positions, indices, { ...options, tileSize: 16 });
  for (const surface of [mesh, tiled]) {
    assert.throws(() => surface.route([2, 0, 2], [18, 0, 18], [0.5]), RangeError);
    assert.throws(() => surface.route([2, 0, 2], [18, 0, 18], [Number.NaN]), RangeError);
    assert.ok(surface.route([2, 0, 2], [18, 0, 18], [2]));
  }
});

test('types are checked', () => {
  const [positions, indices] = gaps();
  assert.throws(() => new NavAgents(positions, indices, { types: {} }), RangeError);
  assert.throws(() => new NavAgents(positions, indices, { types: { a: { radius: -1 } } }), RangeError);
  assert.throws(() => new NavAgents(positions, indices, { types: { a: { maxSlope: 90 } } }), RangeError);
  assert.throws(() => new NavAgents(positions, indices, { types: { a: { areas: { water: 0.5 } } } }), RangeError);
  const agents = new NavAgents(positions, indices, { ...grid, types: { a: {} } });
  assert.throws(() => agents.path('b', [1, 0, 1], [2, 0, 2]), /a\./);
});
