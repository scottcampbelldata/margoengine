// Navmesh depth: area costs and blocked polygons, off-mesh links, closest points, one-sided ORCA neighbours, carved
// build obstacles, and the Crowd manager (arrival, staying on the mesh, mutual and obstacle avoidance, off-mesh links,
// replanning and unreachable targets).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd, CrowdAgent, NavMesh, avoid } from '../dist/index.js';
import { buildNavMesh } from '../dist/build.js';

const near = (a, b, tolerance, label) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} is not within ${tolerance} of ${b}`);

/** A columns x rows grid of 1 m square polygons at y 0, from (x0, z0). Cell (c, r) is polygon r * columns + c. */
function grid(columns, rows, { x0 = 0, z0 = 0, skip = () => false } = {}) {
  const vertices = [],
    polygons = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= columns; c++) vertices.push([x0 + c, 0, z0 + r]);
  const v = (c, r) => r * (columns + 1) + c;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++)
      if (!skip(c, r)) polygons.push([v(c, r), v(c + 1, r), v(c + 1, r + 1), v(c, r + 1)]);
  return { vertices, polygons };
}
const mesh = (g) => new NavMesh(g.vertices, g.polygons);
const maxZ = (path) => Math.max(...path.map((p) => p[2]));

test('area costs steer routes around expensive polygons, Infinity blocks them, and version counts changes', () => {
  const nav = mesh(grid(3, 3)); // polygon index = r * 3 + c
  const start = [0.5, 0, 0.5],
    end = [2.5, 0, 0.5];
  assert.equal(maxZ(nav.path(start, end)), 0.5, 'straight along the bottom row');
  assert.equal(nav.locate([1.5, 0, 0.5]), 1);
  const v0 = nav.version;
  nav.setAreaCost(1, 10);
  assert.equal(nav.areaCost(1), 10);
  assert.equal(nav.version, v0 + 1);
  assert.ok(maxZ(nav.path(start, end)) >= 1, 'mud in the middle: the route goes around through row 1');
  nav.setAreaCost(1, 1.2);
  assert.equal(maxZ(nav.path(start, end)), 0.5, 'a cheap detour is not worth it');
  for (const p of [1, 4, 7]) nav.setAreaCost(p, Infinity);
  assert.equal(nav.path(start, end), null, 'a blocked column cuts the mesh in two');
  nav.setAreaCost(7, 1);
  const around = nav.path(start, end);
  assert.ok(maxZ(around) >= 2, 'the only gap is the top row');
  assert.equal(nav.path(start, [1.5, 0, 1.5]), null, 'a blocked end polygon has no route');
  assert.throws(() => nav.setAreaCost(1, 0.5), /1 or more/);
  assert.throws(() => nav.setAreaCost(99, 2), /out of range/);
  assert.equal(nav.polygonCount, 9);
  assert.deepEqual(nav.polygonCenter(4), [1.5, 0, 1.5]);
});

test('off-mesh links join islands, one way or both, and route() marks the crossing', () => {
  // Two 2 x 1 islands with a 1 m gap between x 2 and x 3.
  const left = grid(2, 1),
    right = grid(2, 1, { x0: 3 }),
    offset = left.vertices.length,
    nav = new NavMesh(
      [...left.vertices, ...right.vertices],
      [...left.polygons, ...right.polygons.map((p) => p.map((i) => i + offset))],
    );
  const a = [0.5, 0, 0.5],
    b = [4.5, 0, 0.5];
  assert.equal(nav.path(a, b), null, 'no route across the gap');
  const v = nav.version,
    jump = nav.addOffMeshLink([1.9, 0, 0.5], [3.1, 0, 0.5], { bidirectional: false });
  assert.ok(nav.version > v);
  const route = nav.route(a, b);
  assert.deepEqual(
    route.points.map((p) => p.map((x) => Math.round(x * 10) / 10)),
    [
      [0.5, 0, 0.5],
      [1.9, 0, 0.5],
      [3.1, 0, 0.5],
      [4.5, 0, 0.5],
    ],
  );
  assert.deepEqual(route.offMesh, [1], 'segment 1 to 2 is the jump');
  assert.equal(nav.path(b, a), null, 'one way only');
  const back = nav.addOffMeshLink([3.1, 0, 0.6], [1.9, 0, 0.6]);
  assert.ok(nav.path(b, a), 'a second, two-way link');
  assert.ok(nav.removeOffMeshLink(jump));
  assert.ok(nav.removeOffMeshLink(back));
  assert.ok(!nav.removeOffMeshLink(back), 'already gone');
  assert.equal(nav.path(a, b), null);
  assert.throws(() => nav.addOffMeshLink([2.5, 0, 0.5], [3.5, 0, 0.5]), /on the navmesh/);
});

test('closestPoint returns the point on the mesh, on its surface or at the nearest edge', () => {
  const nav = mesh(grid(2, 2));
  assert.deepEqual(nav.closestPoint([0.5, 3, 0.5]), { point: [0.5, 0, 0.5], polygon: 0 });
  const outside = nav.closestPoint([3, 0, 1.5]);
  assert.deepEqual(outside.point, [2, 0, 1.5]);
  assert.equal(outside.polygon, 3);
  near(nav.heightAt(0, 0.3, 0.7), 0, 1e-12, 'flat plane height');
});

test('a neighbour that does not avoid back gets the whole avoidance, not half (one-sided ORCA)', () => {
  // An agent heading straight at a still disc 3 m ahead; closest approach over the horizon with the chosen velocity.
  const agent = { id: 1, position: [0, 0], velocity: [2, 0], preferred: [2, 0], radius: 0.5, maxSpeed: 2 };
  const approach = (reciprocal) => {
    const v = avoid(
      agent,
      [{ id: 2, position: [3, 0], velocity: [0, 0], preferred: [0, 0], radius: 0.5, maxSpeed: 0, reciprocal }],
      0.1,
      2,
    );
    // Closest distance between the moving agent and the still disc along the chosen velocity.
    const t = Math.max(0, (3 * v[0]) / (v[0] * v[0] + v[1] * v[1]));
    return Math.hypot(v[0] * t - 3, v[1] * t);
  };
  assert.ok(approach(false) >= 1 - 1e-6, `one-sided: clears the disc (${approach(false)})`);
  assert.ok(approach(true) < 1, `reciprocal: only half, expecting the other to move (${approach(true)})`);
});

test('build obstacles carve their boxes out of the walkable area, kept clear by the agent radius', () => {
  // A 10 x 10 floor; a 2 x 2 crate in the middle.
  const positions = [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5],
    indices = [0, 2, 1, 0, 3, 2];
  const open = buildNavMesh(positions, indices, { cs: 0.25, ch: 0.1, walkableRadius: 2 });
  assert.ok(open.locate([0, 0, 0]) >= 0, 'walkable without the crate');
  const carved = buildNavMesh(positions, indices, {
    cs: 0.25,
    ch: 0.1,
    walkableRadius: 2,
    obstacles: [{ min: [-1, 0, -1], max: [1, 1, 1] }],
  });
  assert.equal(carved.locate([0, 0, 0]), -1, 'the crate is carved out');
  assert.equal(carved.locate([1.2, 0, 0]), -1, 'and the agent radius around it (0.5 m)');
  assert.ok(carved.locate([2, 0, 0]) >= 0, 'beyond it is walkable');
  const path = carved.path([-3, 0, 0], [3, 0, 0]);
  assert.ok(path.length > 2, 'the route bends around the crate');
  for (let i = 1; i < path.length; i++)
    for (let t = 0; t <= 1; t += 0.05) {
      const x = path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
        z = path[i - 1][2] + (path[i][2] - path[i - 1][2]) * t;
      assert.ok(Math.max(Math.abs(x), Math.abs(z)) >= 1.4, `stays clear of the crate at (${x}, ${z})`);
    }
  // A box above head height or beside the floor carves nothing.
  const high = buildNavMesh(positions, indices, {
    cs: 0.25,
    ch: 0.1,
    obstacles: [{ min: [-1, 3, -1], max: [1, 4, 1] }],
  });
  assert.ok(high.locate([0, 0, 0]) >= 0, 'a box high above the floor is not an obstacle');
  assert.throws(
    () => buildNavMesh(positions, indices, { obstacles: [{ min: [1, 0, 0], max: [0, 1, 1] }] }),
    /min <= max/,
  );
});

const run = (crowd, seconds, dt = 1 / 30, each) => {
  for (let t = 0; t < seconds; t += dt) {
    crowd.update(dt);
    each?.();
  }
};

test('a crowd agent walks to its target around a corner, stays on the mesh and arrives', () => {
  // An L: a 6 x 2 strip along x and a 2 x 6 strip up z at its far end.
  const nav = mesh(grid(6, 6, { skip: (c, r) => r >= 2 && c < 4 }));
  const crowd = new Crowd(nav);
  const agent = crowd.addAgent({ position: [0.5, 5, 0.5], radius: 0.3, maxSpeed: 2 });
  assert.ok(agent instanceof CrowdAgent);
  near(agent.position[1], 0, 1e-12, 'placed on the mesh surface');
  const arrived = [];
  crowd.on('arrive', (a) => arrived.push(a));
  agent.setTarget([5, 0, 5.5]);
  run(crowd, 10, 1 / 30, () => assert.ok(nav.locate(agent.position) >= 0, `on the mesh at ${agent.position}`));
  assert.equal(agent.state, 'arrived');
  assert.deepEqual(arrived, [agent]);
  near(Math.hypot(agent.position[0] - 5, agent.position[2] - 5.5), 0, 0.1, 'at the target');
  assert.deepEqual(agent.velocity, [0, 0, 0], 'stopped');
  assert.ok(
    agent.path.some((p) => p[0] >= 3.9 && p[2] <= 2.1),
    'the route turns at the inner corner',
  );
  crowd.dispose();
  assert.ok(!agent.valid);
});

test('agents pass each other without overlapping, and steer around an obstacle', () => {
  const nav = mesh(grid(12, 4));
  const crowd = new Crowd(nav);
  const a = crowd.addAgent({ position: [0.5, 0, 2], radius: 0.4, maxSpeed: 2 }),
    b = crowd.addAgent({ position: [11.5, 0, 2], radius: 0.4, maxSpeed: 2 });
  a.setTarget([11.5, 0, 2]);
  b.setTarget([0.5, 0, 2]);
  let closest = Infinity;
  run(crowd, 12, 1 / 30, () => {
    closest = Math.min(closest, Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]));
  });
  assert.ok(closest >= 0.8 - 0.02, `head-on agents keep their radii apart (${closest})`);
  assert.equal(a.state, 'arrived');
  assert.equal(b.state, 'arrived');
  crowd.dispose();

  const solo = new Crowd(nav),
    walker = solo.addAgent({ position: [0.5, 0, 2], radius: 0.4, maxSpeed: 2 }),
    crate = { position: [6, 0, 2], radius: 0.6 },
    removeCrate = solo.addObstacle(crate);
  walker.setTarget([11.5, 0, 2]);
  let gap = Infinity;
  run(solo, 12, 1 / 30, () => {
    gap = Math.min(gap, Math.hypot(walker.position[0] - 6, walker.position[2] - 2));
  });
  assert.ok(gap >= 1 - 0.02, `the agent goes around the crate (${gap})`);
  assert.equal(walker.state, 'arrived');
  removeCrate();
  // A standing agent in the way: the walker goes round it instead of stopping in front of it.
  walker.teleport([0.5, 0, 2]).setTarget([11.5, 0, 2]);
  const bystander = solo.addAgent({ position: [6, 0, 2], radius: 0.4 });
  run(solo, 12);
  assert.equal(walker.state, 'arrived', 'passes the bystander');
  assert.equal(bystander.state, 'idle');
  solo.dispose();
});

test('agents cross off-mesh links, replan when area costs change and report unreachable targets', () => {
  const left = grid(2, 1),
    right = grid(2, 1, { x0: 3 }),
    offset = left.vertices.length,
    nav = new NavMesh(
      [...left.vertices, ...right.vertices],
      [...left.polygons, ...right.polygons.map((p) => p.map((i) => i + offset))],
    );
  const crowd = new Crowd(nav),
    agent = crowd.addAgent({ position: [0.5, 0, 0.5], radius: 0.2, maxSpeed: 2 }),
    unreachable = [];
  crowd.on('unreachable', (a) => unreachable.push(a));
  agent.setTarget([4.5, 0, 0.5]);
  crowd.update(1 / 30);
  assert.equal(agent.state, 'unreachable');
  assert.deepEqual(unreachable, [agent]);
  nav.addOffMeshLink([1.8, 0, 0.5], [3.2, 0, 0.5]);
  let crossed = false;
  run(crowd, 6, 1 / 30, () => {
    if (agent.state === 'offmesh') crossed = true;
  });
  assert.ok(crossed, 'the version change replans and the agent takes the link');
  assert.equal(agent.state, 'arrived');
  near(agent.position[0], 4.5, 0.1, 'on the far island');

  // Replanning: block the straight way after the agent has set off.
  const field = mesh(grid(3, 3)),
    crowd2 = new Crowd(field),
    walker = crowd2.addAgent({ position: [0.5, 0, 0.5], radius: 0.2, maxSpeed: 1 });
  walker.setTarget([2.5, 0, 0.5]);
  crowd2.update(1 / 30);
  assert.equal(maxZ(walker.path), 0.5);
  field.setAreaCost(1, Infinity);
  crowd2.update(1 / 30);
  assert.ok(maxZ(walker.path) >= 1, 'the route now goes around the blocked polygon');
  run(crowd2, 8);
  assert.equal(walker.state, 'arrived');
  walker.stop();
  assert.equal(walker.state, 'idle');
  walker.remove();
  assert.equal(crowd2.agents.length, 0);
  assert.throws(() => walker.setTarget([0, 0, 0]), /crowd.addAgent/);
  assert.throws(() => crowd2.update(Number.NaN), RangeError);
  assert.throws(() => new Crowd({}), /NavMesh/);
  assert.throws(() => crowd2.addAgent({ position: [0, 0, 0], radius: -1 }), /radius/);
});
