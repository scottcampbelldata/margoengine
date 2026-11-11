// Steering: each behaviour's direction and limits, blending and priorities, integration, flocking over ECS component
// fields, interop with navmesh crowd agents and routes, determinism, and malformed input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@margoengine/ecs';
import { Crowd, NavMesh } from '@margoengine/navmesh';
import { createRandom } from '@margoengine/math/mathutils';
import {
  Steering,
  alignment,
  arrive,
  avoidObstacles,
  cohesion,
  evade,
  flee,
  flock,
  followPath,
  integrate,
  pursue,
  seek,
  separation,
  wander,
} from '../dist/steering.js';
import * as root from '../dist/index.js';

const agent = (position = [0, 0, 0], velocity = [0, 0, 0], maxSpeed = 2, maxForce) => ({
  position,
  velocity,
  maxSpeed,
  maxForce,
});
const near = (a, b, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`);
const length = (v) => Math.hypot(v[0], v[1], v[2]);

test('the root entry re-exports the steering entry', () => {
  assert.equal(root.seek, seek);
  assert.equal(root.Steering, Steering);
});

test('seek, flee and arrive point the right way at the right speed', () => {
  assert.deepEqual(seek(agent(), [3, 0, 0]), [2, 0, 0]);
  assert.deepEqual(seek(agent([0, 0, 0], [1, 0, 0]), [0, 0, 5]), [-1, 0, 2], 'desired minus current velocity');
  assert.deepEqual(flee(agent(), [3, 0, 0]), [-2, 0, 0]);
  assert.deepEqual(flee(agent(), [3, 0, 0], [9, 9, 9], 1), [0, 0, 0], 'outside the panic distance');
  assert.deepEqual(arrive(agent(), [10, 0, 0], undefined, 2), [2, 0, 0], 'full speed far away');
  assert.deepEqual(
    arrive(agent(), [0.5, 0, 0], undefined, 2),
    [0.5, 0, 0],
    'a quarter of the way in: a quarter of top speed',
  );
  assert.deepEqual(arrive(agent([1, 0, 0], [1, 0, 0]), [1, 0, 0]), [-1, 0, 0], 'on the target: brake');
});

test('pursue and evade lead a moving target, bounded by maxPrediction', () => {
  const quarry = { position: [4, 0, 0], velocity: [0, 0, 1] };
  const out = pursue(agent(), quarry, [0, 0, 0], 1);
  // Distance 4 at speed 2 is 2 s, clamped to 1 s: aim at (4, 0, 1).
  near(out[0] / out[2], 4);
  near(length(out), 2);
  const away = evade(agent(), quarry, [0, 0, 0], 1);
  near(away[0] / away[2], 4);
  assert.ok(away[0] < 0);
  const noLead = pursue(agent(), quarry, [0, 0, 0], 0);
  assert.deepEqual(noLead, [2, 0, 0]);
});

test('wander is smooth, stays on the ground plane and replays from a seed', () => {
  const run = (seed) => {
    const a = agent([0, 0, 0], [1, 0, 0]),
      state = { angle: 0 },
      random = createRandom(seed),
      path = [];
    for (let i = 0; i < 200; i++) {
      const force = wander(a, state, random, { jitter: 0.3 });
      assert.ok(force[1] === -a.velocity[1], 'no vertical wander');
      integrate(a, force, 1 / 30);
      path.push([...a.position]);
    }
    return path;
  };
  const first = run(3);
  assert.deepEqual(run(3), first);
  assert.notDeepEqual(run(4), first);
  assert.ok(first.every((p) => p[1] === 0));
  assert.throws(() => wander(agent(), { angle: NaN }, Math.random), RangeError);
});

test('obstacle avoidance pushes sideways from an obstacle ahead and ignores those behind or beside the path', () => {
  const a = agent([0, 0, 0], [2, 0, 0]);
  const push = avoidObstacles(a, [{ position: [1.5, 0, 0.2], radius: 0.5 }], { radius: 0.3 });
  assert.ok(push[2] < 0, 'the obstacle is a little to +z, so steer to -z');
  assert.ok(push[0] === 0, 'no push along the heading');
  assert.deepEqual(avoidObstacles(a, [{ position: [-2, 0, 0], radius: 0.5 }]), [0, 0, 0], 'behind');
  assert.deepEqual(avoidObstacles(a, [{ position: [1, 0, 3], radius: 0.5 }]), [0, 0, 0], 'beside');
  assert.deepEqual(avoidObstacles(a, [{ position: [10, 0, 0], radius: 0.5 }]), [0, 0, 0], 'beyond the look-ahead');
  const dead = avoidObstacles(a, [{ position: [1, 0, 0], radius: 0.5 }]);
  assert.ok(Math.abs(dead[2]) > 0 && dead[0] === 0, 'dead ahead: a fixed side');
  assert.deepEqual(avoidObstacles(agent(), [{ position: [1, 0, 0], radius: 0.5 }]), [0, 0, 0], 'standing still');
  // An agent steering through a field of pillars never touches one.
  const walker = agent([0, 0, 0], [0, 0, 0], 2, 8),
    pillars = [
      { position: [3, 0, 0.1], radius: 0.5 },
      { position: [6, 0, -0.2], radius: 0.5 },
    ],
    steering = new Steering()
      .add((b, out) => void avoidObstacles(b, pillars, { radius: 0.3 }, out), { priority: 1 })
      .add((b, out) => void seek(b, [9, 0, 0], out));
  let closest = Infinity;
  for (let i = 0; i < 400; i++) {
    integrate(walker, steering.compute(walker), 1 / 60);
    for (const pillar of pillars)
      closest = Math.min(
        closest,
        Math.hypot(walker.position[0] - pillar.position[0], walker.position[2] - pillar.position[2]) - pillar.radius,
      );
  }
  assert.ok(closest > 0, `kept clear of the pillars (closest gap ${closest})`);
  assert.ok(walker.position[0] > 8, 'and reached the far side');
});

test('path following tracks a polyline, loops, and arrives at the end of an open path', () => {
  const path = [
    [0, 0, 0],
    [5, 0, 0],
    [5, 0, 5],
  ];
  const a = agent([0, 0, 1], [0, 0, 0], 2, 6);
  let worst = 0;
  for (let i = 0; i < 600; i++) {
    integrate(a, followPath(a, path, { radius: 0.3 }), 1 / 60);
    if (i > 60) worst = Math.max(worst, Math.min(Math.abs(a.position[2]), Math.abs(a.position[0] - 5)));
  }
  assert.ok(Math.hypot(a.position[0] - 5, a.position[2] - 5) < 0.2, `arrived at the end, at ${a.position}`);
  assert.ok(worst < 1, `stayed near the path (worst ${worst})`);
  const lap = agent([0, 0, 0], [1, 0, 0], 2, 6),
    square = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 4],
      [0, 0, 4],
    ];
  let corners = 0;
  for (let i = 0; i < 1200; i++) {
    integrate(lap, followPath(lap, square, { loop: true, radius: 0.3 }), 1 / 60);
    if (Math.hypot(lap.position[0], lap.position[2]) < 0.6) corners++;
  }
  assert.ok(corners > 0, 'a looped path comes back to its start');
  assert.deepEqual(
    followPath(agent([0, 0, 0]), [[2, 0, 0]], {}, [0, 0, 0]),
    arrive(agent(), [2, 0, 0]),
    'one point: arrive',
  );
  assert.throws(() => followPath(agent(), []), RangeError);
});

test('separation, cohesion and alignment respond to neighbours in range and skip the agent itself', () => {
  const self = agent([0, 0, 0], [0, 0, 0]);
  const others = [self, { position: [1, 0, 0], velocity: [0, 0, 2] }, { position: [9, 0, 0], velocity: [5, 0, 0] }];
  const push = separation(self, others, 2);
  assert.ok(push[0] < 0 && push[2] === 0);
  const pull = cohesion(self, others, 2);
  assert.ok(pull[0] > 0);
  assert.deepEqual(alignment(self, others, 2), [0, 0, 2]);
  assert.deepEqual(separation(self, [self], 2), [0, 0, 0]);
  assert.throws(() => separation(self, others, 0), RangeError);
});

test('Steering blends by weight inside a priority group, falls through idle groups, and clamps to maxForce', () => {
  const a = agent([0, 0, 0], [0, 0, 0], 2, 1);
  const steering = new Steering()
    .add((_, out) => void (out[0] = 1), { weight: 2 })
    .add((_, out) => void (out[2] = 1), { weight: 2 })
    .add((_, out) => void (out[1] = 0), { priority: 5 });
  const force = steering.compute(a);
  near(length(force), 1, 1e-12);
  near(force[0], force[2]);
  const urgent = new Steering().add((_, out) => void (out[1] = 3), { priority: 5 }).add((_, out) => void (out[0] = 1));
  assert.deepEqual(urgent.compute(agent()), [0, 3, 0], 'the higher group wins when it acts');
  assert.throws(() => new Steering().add((_, out) => void (out[0] = NaN)).compute(agent()), RangeError);
  assert.throws(() => new Steering().add(null), TypeError);
});

test('integrate clamps speed and moves the agent', () => {
  const a = agent([0, 0, 0], [0, 0, 0], 2);
  integrate(a, [100, 0, 0], 0.5);
  assert.deepEqual(a.velocity, [2, 0, 0]);
  assert.deepEqual(a.position, [1, 0, 0]);
  assert.throws(() => integrate(a, [0, 0, 0], -1), RangeError);
  assert.throws(() => integrate({ position: [0, 0], velocity: [0, 0, 0], maxSpeed: 1 }, [0, 0, 0], 1), RangeError);
});

test('flock steps boids stored in ECS component fields, deterministically, without NaN, and keeps them apart', () => {
  const run = () => {
    const world = new World(256),
      boid = world.component({
        x: Float64Array,
        y: Float64Array,
        z: Float64Array,
        vx: Float64Array,
        vy: Float64Array,
        vz: Float64Array,
      }),
      random = createRandom(11);
    for (let i = 0; i < 120; i++)
      boid.add(world.create(), {
        x: random() * 10,
        y: 0,
        z: random() * 10,
        vx: random() - 0.5,
        vy: 0,
        vz: random() - 0.5,
      });
    for (let step = 0; step < 300; step++) flock(boid.fields, boid.size, { radius: 2, maxSpeed: 3 }, 1 / 30);
    return boid;
  };
  const a = run(),
    b = run();
  assert.deepEqual([...a.fields.x], [...b.fields.x], 'same input, same output');
  const f = a.fields;
  let minGap = Infinity,
    meanX = 0,
    meanZ = 0,
    meanSpeed = 0;
  for (let i = 0; i < a.size; i++) {
    assert.ok([f.x[i], f.z[i], f.vx[i], f.vz[i]].every(Number.isFinite));
    assert.ok(Math.hypot(f.vx[i], f.vy[i], f.vz[i]) <= 3 + 1e-9);
    meanX += f.vx[i] / a.size;
    meanZ += f.vz[i] / a.size;
    meanSpeed += Math.hypot(f.vx[i], f.vz[i]) / a.size;
    for (let j = i + 1; j < a.size; j++) minGap = Math.min(minGap, Math.hypot(f.x[i] - f.x[j], f.z[i] - f.z[j]));
  }
  assert.ok(minGap > 0.05, `separation keeps boids apart (closest ${minGap})`);
  assert.ok(
    Math.hypot(meanX, meanZ) / meanSpeed > 0.8,
    'alignment gives the flock a common heading (polarisation above 0.8)',
  );
  assert.throws(() => flock({ x: [0], y: [0], z: [0], vx: [0], vy: [0], vz: [NaN] }, 1), RangeError);
  assert.throws(() => flock({ x: [], y: [], z: [], vx: [], vy: [], vz: [] }, 2), RangeError);
});

test('navmesh interop: crowd agents are steering agents and neighbours, and a crowd route is a path', () => {
  const vertices = [],
    polygons = [];
  for (let r = 0; r <= 4; r++) for (let c = 0; c <= 4; c++) vertices.push([c, 0, r]);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) polygons.push([r * 5 + c, r * 5 + c + 1, (r + 1) * 5 + c + 1, (r + 1) * 5 + c]);
  const nav = new NavMesh(vertices, polygons);
  using crowd = new Crowd(nav);
  const walker = crowd.addAgent({ position: [0.5, 0, 0.5] }),
    other = crowd.addAgent({ position: [1.5, 0, 0.5] });
  walker.setTarget([3.5, 0, 3.5]);
  crowd.update(1 / 60);
  // A crowd agent fits SteeringAgent as it is, and the crowd's agents are neighbours.
  const push = separation(walker, crowd.agents, 2);
  assert.ok(push[0] < 0, 'pushed away from the other agent');
  const route = nav.path([0.5, 0, 0.5], [3.5, 0, 3.5]);
  const follower = agent([0.5, 0, 0.5], [0, 0, 0], 2, 6);
  for (let i = 0; i < 600; i++) integrate(follower, followPath(follower, route, { radius: 0.2 }), 1 / 60);
  assert.ok(
    Math.hypot(follower.position[0] - 3.5, follower.position[2] - 3.5) < 0.2,
    'followed the navmesh route to its end',
  );
  assert.ok(other.valid);
});

test('fuzz: malformed agents and targets throw TypeError or RangeError, never NaN', () => {
  const random = createRandom(5);
  const junk = [undefined, null, NaN, Infinity, -1, 0, 1, [], [1, 2], [NaN, 0, 0], [0, 0, 0], 'x', {}];
  const pick = () => junk[Math.floor(random() * junk.length)];
  for (let i = 0; i < 3000; i++) {
    const a = { position: pick(), velocity: pick(), maxSpeed: pick() },
      target = pick();
    for (const fn of [
      () => seek(a, target),
      () => flee(a, target),
      () => arrive(a, target),
      () => pursue(a, { position: target, velocity: pick() }),
    ])
      try {
        const out = fn();
        assert.ok(out.every(Number.isFinite), 'a result is finite');
      } catch (error) {
        assert.ok(error instanceof RangeError || error instanceof TypeError, `got ${error}`);
      }
  }
});

test('coincident boids part: flock and separation push a pair at one point opposite ways (KB6027a)', () => {
  // Same point, same velocity: before the fix both stayed on one point for every step.
  const twins = { x: [0, 0], y: [0, 0], z: [0, 0], vx: [1, 1], vy: [0, 0], vz: [0, 0] };
  for (let step = 0; step < 30; step++) flock(twins, 2, {}, 1 / 30);
  assert.ok(Math.abs(twins.z[0] - twins.z[1]) > 0.1, `twins parted (${twins.z[0]} vs ${twins.z[1]})`);
  assert.ok(Math.abs(twins.z[0] + twins.z[1]) < 1e-9, 'symmetrically, to either side of the heading');
  // Reordered rows give the same set of boids.
  const swapped = { x: [0, 0], y: [0, 0], z: [0, 0], vx: [1, 1], vy: [0, 0], vz: [0, 0] };
  for (let step = 0; step < 30; step++) flock(swapped, 2, {}, 1 / 30);
  assert.deepEqual([...swapped.z].sort(), [...twins.z].sort());
  // Different velocities at one point part along the velocity difference, whatever the order.
  const a = agent([0, 0, 0], [1, 0, 0]),
    b = agent([0, 0, 0], [0, 0, 1]);
  const pa = separation(a, [b], 2),
    pb = separation(b, [a], 2);
  assert.ok(pa[0] > 0 && pa[2] < 0 && pb[0] < 0 && pb[2] > 0, `${pa} / ${pb}`);
  // Identical states: the order in the shared list breaks the tie; with the agent absent there is no order, no push.
  const c = agent([0, 0, 0], [1, 0, 0]),
    d = agent([0, 0, 0], [1, 0, 0]);
  const pc = separation(c, [c, d], 2),
    pd = separation(d, [c, d], 2);
  assert.ok(pc[2] !== 0 && Math.sign(pc[2]) === -Math.sign(pd[2]), `${pc} / ${pd}`);
  assert.deepEqual(separation(c, [d], 2), [0, 0, 0]);
});

test('obstacle avoidance push follows Buckland 2005: zero at a grazing path, largest dead ahead and near (KB6027b)', () => {
  const a = agent([0, 0, 0], [2, 0, 0]),
    push = (z, x = 1.5) => Math.hypot(...avoidObstacles(a, [{ position: [x, 0, z], radius: 0.5 }], { radius: 0.3 }));
  // Overlap fraction (r - off) / r with r = 0.8: grazing (off just under r) pushes almost nothing.
  assert.ok(push(0.7999) < 1e-3, `grazing push ${push(0.7999)}`);
  assert.ok(push(0.6) < push(0.2), 'more overlap, more push');
  assert.ok(push(0.2, 1) > push(0.2, 1.8), 'nearer along the path, more push');
  // Dead ahead at the agent: urgency 2 and overlap 1, so twice the agent's maximum speed.
  const s = a.maxSpeed ?? 2;
  assert.ok(Math.abs(push(0, 0) - 2 * Math.max(s, 1e-6)) < 1e-9, `${push(0, 0)}`);
});
