// @margoengine/kinematics-constraints/plan: every scene has a fixed seed and a straight path that collides, and the local
// solver is shown stuck first. Paths are rechecked here with a dense scan that shares no code with the swept check's
// stepping, so a planner that returned a colliding edge fails.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBVH } from '../../bvh/dist/index.js';
import { CapsuleVolume, ConvexHullVolume, SphereVolume } from '../dist/index.js';
import { armRobot, JointLimitSolver } from '../dist/limits.js';
import { planPath, planPathSync, planToPose, Roadmap } from '../dist/plan.js';
import { Robot } from '../dist/robot.js';
import { MeshVolume } from '../dist/sdf.js';
import { sweepRobot } from '../dist/swept.js';

const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
function box(min, max) {
  const points = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) points.push(x, y, z);
  return new ConvexHullVolume({ points });
}
/** A planar arm of unit links about +Z with a fixed tip. */
function planar(count, radius = 0.05) {
  const joints = [];
  for (let i = 0; i < count; i++) joints.push({ lower: -3.1, upper: 3.1, origin: i ? translate(1, 0, 0) : undefined });
  joints.push({ name: 'tip', type: 'fixed', origin: translate(1, 0, 0) });
  return new Robot({
    joints,
    shapes: joints.slice(0, count).map((_, i) => ({ joint: i, end: [1, 0, 0], radius })),
  });
}
/** A dense scan of a path: each step at most `step` of joint space, every pose in range and keeping the gap. */
function assertClear(robot, path, colliders, minClearance, selfCollision = false, step = 2e-3) {
  const q = new Float64Array(robot.dof);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i],
      length = Math.hypot(...a.map((value, k) => value - b[k])),
      count = Math.max(2, Math.ceil(length / step));
    for (let s = 0; s <= count; s++) {
      for (let k = 0; k < q.length; k++) q[k] = a[k] + ((b[k] - a[k]) * s) / count;
      assert.ok(robot.within(q), 'path leaves a joint range');
      const gap = robot.clearance(q, colliders, selfCollision);
      assert.ok(gap >= minClearance - 1e-9, `edge ${i}: gap ${gap}`);
    }
  }
}
const same = (a, b) => assert.deepEqual([...a], [...b]);

/** Two links and a post in reach: the elbow must swing right over to pass it, which no step toward the target does. */
function walledScene() {
  const robot = planar(2),
    colliders = [new CapsuleVolume({ start: [1.3, 0, -1], end: [1.3, 0, 1], radius: 0.1 })],
    start = [0.9, -1.2],
    goal = [-0.9, 1.2];
  return { robot, colliders, start, goal };
}

for (const algorithm of ['rrt-connect', 'rrt', 'prm']) {
  test(`${algorithm}: finds a clear way where the straight path collides and the local solver stalls`, async () => {
    const { robot, colliders, start, goal } = walledScene(),
      minClearance = 0.02;
    assert.ok(robot.clearance(start, colliders) > minClearance);
    assert.ok(robot.clearance(goal, colliders) > minClearance);
    assert.equal(sweepRobot(robot, start, goal, colliders, { minClearance }).clear, false, 'the straight path collides');
    robot.forward(goal);
    const position = [...robot.pointOn(2, [0, 0, 0])],
      local = new JointLimitSolver(robot, { tip: 'tip', colliders, minClearance }).solve(start, { position });
    assert.equal(local.reached, false, 'the local solver stalls');
    assert.equal(local.blocked, true);
    const plan = await planPath(robot, start, goal, { colliders, minClearance, algorithm, seed: 85 });
    assert.equal(plan.status, 'found');
    same(plan.path[0], start);
    same(plan.path.at(-1), goal);
    assertClear(robot, plan.path, colliders, minClearance);
    assert.ok(plan.samples > 0 && plan.edgeChecks > 0);
  });
}

test('a seven-joint arm with hull links plans among obstacles, keeping off itself too', async () => {
  const axes = [
      [0, 0, 1],
      [0, 1, 0],
      [0, 0, 1],
      [0, 1, 0],
      [0, 0, 1],
      [0, 1, 0],
      [0, 0, 1],
    ],
    link = (r, l) => [-r, -r, 0, r, -r, 0, -r, r, 0, r, r, 0, -r, -r, l, r, -r, l, -r, r, l, r, r, l],
    robot = new Robot({
      joints: axes.map((axis, i) => ({ axis, lower: -2.8, upper: 2.8, origin: i ? translate(0, 0, 0.32) : undefined })),
      shapes: axes.map((_, i) => ({ joint: i, points: link(0.04, 0.3) })),
    }).ignoreContactsAt(new Float64Array(7), 0.02),
    start = [0.2, 0.7, 0, 0.8, 0, 0.5, 0],
    goal = [-2, 0.9, 0.4, 1.1, 0.2, -0.7, 0.3],
    minClearance = 0.015,
    selfCollision = true;
  // A ball where the straight motion's last link passes at its middle, and a floor under the whole arm.
  robot.forward(start.map((value, i) => (value + goal[i]) / 2));
  const colliders = [
    new SphereVolume({ center: [...robot.pointOn(6, [0, 0, 0.15])], radius: 0.12 }),
    box([-3, -3, -0.2], [3, 3, -0.1]),
  ];
  assert.ok(robot.clearance(start, colliders, selfCollision) > minClearance);
  assert.ok(robot.clearance(goal, colliders, selfCollision) > minClearance);
  assert.equal(sweepRobot(robot, start, goal, colliders, { minClearance, selfCollision }).clear, false);
  const plan = await planPath(robot, start, goal, { colliders, minClearance, selfCollision, seed: 3, stepSize: 0.4 });
  assert.equal(plan.status, 'found');
  assertClear(robot, plan.path, colliders, minClearance, selfCollision, 5e-3);
});

test('out of a concave bay: a mesh obstacle with its mouth behind the arm must be backed out of', async () => {
  // A square cup open toward -X, read as a sheet: the arm starts inside and its goal is round the back.
  const quads = [
      [[0.5, -0.6, -1], [1.4, -0.6, -1], [1.4, -0.6, 1], [0.5, -0.6, 1]],
      [[0.5, 0.6, -1], [1.4, 0.6, -1], [1.4, 0.6, 1], [0.5, 0.6, 1]],
      [[1.4, -0.6, -1], [1.4, 0.6, -1], [1.4, 0.6, 1], [1.4, -0.6, 1]],
    ],
    positions = new Float32Array(quads.flat(2)),
    indices = new Uint32Array(quads.flatMap((_, i) => [i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3])),
    bay = new MeshVolume({ bvh: MeshBVH.build({ positions, indices }), solid: false }),
    slider = new Robot({
      joints: [
        { type: 'prismatic', axis: [1, 0, 0], lower: -0.5, upper: 2.5 },
        { type: 'prismatic', axis: [0, 1, 0], lower: -2, upper: 2 },
      ],
      shapes: [{ joint: 1, radius: 0.1 }],
    }),
    start = [1, 0],
    goal = [2, 0],
    minClearance = 0.02;
  assert.equal(sweepRobot(slider, start, goal, [bay], { minClearance }).clear, false, 'the back wall stands between them');
  const plan = await planPath(slider, start, goal, { colliders: [bay], minClearance, seed: 5 });
  assert.equal(plan.status, 'found');
  assertClear(slider, plan.path, [bay], minClearance);
  // The way out goes past the mouth: some pose must be left of the walls.
  assert.ok(plan.path.some((q) => q[0] < 0.5));
});

test('planToPose: reaches a tip target behind an obstacle the local solver cannot pass', async () => {
  const arm = armRobot({ upperLength: 1, forearmLength: 1, radius: 0.05, elbow: [0.05, 2.8] }),
    plate = box([-0.1, 1.2, -0.1], [0.1, 1.25, 0.1]),
    start = [0, 0, 0, 2],
    target = { position: [0, 1.6, 0] },
    local = new JointLimitSolver(arm, { tip: 'hand', colliders: [plate], minClearance: 0.02 }).solve(start, target);
  assert.equal(local.reached, false);
  assert.equal(local.blocked, true);
  const plan = await planToPose(arm, start, target, { tip: 'hand', colliders: [plate], minClearance: 0.02, seed: 2 });
  assert.equal(plan.status, 'found');
  assertClear(arm, plan.path, [plate], 0.02);
  arm.forward(plan.path.at(-1));
  const hand = arm.pointOn(arm.jointIndex('hand'), [0, 0, 0]);
  // The joint-limit solver's default tolerance is what "reached" means.
  assert.ok(Math.hypot(hand[0], hand[1] - 1.6, hand[2]) <= 1e-4);
  await assert.rejects(planToPose(arm, start, target, { tip: 'hand', signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal((await planToPose(arm, [0, 0, 0, 0.05], target, { tip: 'hand', colliders: [plate] })).status, 'start-blocked');
  const wall = box([-3, 1.4, -3], [3, 3, 3]);
  assert.equal((await planToPose(arm, start, target, { tip: 'hand', colliders: [wall] })).status, 'goal-blocked');
});

/** A ball on two rails and four thin walls round the point 1.5, 1.5, closed at every corner. */
function sealedScene() {
  return {
    slider: new Robot({
      joints: [
        { type: 'prismatic', axis: [1, 0, 0], lower: -3, upper: 3 },
        { type: 'prismatic', axis: [0, 1, 0], lower: -3, upper: 3 },
      ],
      shapes: [{ joint: 1, radius: 0.05 }],
    }),
    walls: [
      box([1, 1, -1], [2, 1.02, 1]),
      box([1, 2, -1], [2, 2.02, 1]),
      box([1, 1, -1], [1.02, 2.02, 1]),
      box([2, 1, -1], [2.02, 2.02, 1]),
    ],
  };
}

test('a sealed goal is never reached: a budget that runs out reports no-path, and blocked ends say which', async () => {
  const { slider, walls } = sealedScene(),
    options = { colliders: walls, maxSamples: 600, seed: 4 };
  for (const algorithm of ['rrt-connect', 'rrt', 'prm']) {
    const plan = await planPath(slider, [0, 0], [1.5, 1.5], { ...options, algorithm });
    assert.equal(plan.status, 'no-path', algorithm);
    assert.equal(plan.path.length, 0);
  }
  assert.equal((await planPath(slider, [1, 1], [0, 0], options)).status, 'start-blocked');
  assert.equal((await planPath(slider, [0, 0], [1.5, 1], options)).status, 'goal-blocked');
  assert.equal((await planPath(slider, [9, 0], [0, 0], options)).status, 'start-blocked');
});

test('one seed gives one path; another seed gives another; shortcuts never lengthen it', () => {
  const { robot, colliders, start, goal } = walledScene(),
    run = (seed, shortcuts) => planPathSync(robot, start, goal, { colliders, seed, shortcuts }),
    a = run(1, 100),
    b = run(1, 100),
    c = run(2, 100),
    raw = run(1, 0);
  assert.equal(a.status, 'found');
  assert.equal(a.path.length, b.path.length);
  a.path.forEach((q, i) => same(q, b.path[i]));
  assert.notDeepEqual(a.path.map((q) => [...q]), c.path.map((q) => [...q]));
  assert.ok(a.length <= raw.length, `${a.length} over ${raw.length}`);
  assert.ok(a.path.length < raw.path.length);
  assertClear(robot, a.path, colliders, 0.01);
});

test('an AbortSignal stops the search, before it starts and during it', async () => {
  const { robot, colliders, start, goal } = walledScene();
  await assert.rejects(planPath(robot, start, goal, { colliders, signal: AbortSignal.abort() }), { name: 'AbortError' });
  // The goal is sealed off from the start, so the search has no end of its own and only the signal can stop it.
  const { slider, walls } = sealedScene(),
    busy = new AbortController();
  setTimeout(() => busy.abort(), 30);
  await assert.rejects(planPath(slider, [0, 0], [1.5, 1.5], { colliders: walls, maxSamples: 1e9, signal: busy.signal }), {
    name: 'AbortError',
  });
});

test('Roadmap: grown once, it answers many queries; a batch of poses joins it the same way', () => {
  const { robot, colliders, start, goal } = walledScene(),
    roadmap = new Roadmap(robot, { colliders, seed: 8 }).grow(300);
  assert.ok(roadmap.size > 100);
  const first = roadmap.query(start, goal),
    second = roadmap.query(goal, [0.4, -0.2]);
  assert.equal(first.status, 'found');
  assert.equal(second.status, 'found');
  assertClear(robot, first.path, colliders, 0.01);
  assertClear(robot, second.path, colliders, 0.01);
  const batch = new Roadmap(robot, { colliders, seed: 9 }),
    poses = batch.samplePoses(300),
    gaps = Float64Array.from({ length: 300 }, (_, i) => robot.clearance(poses.subarray(i * 2, i * 2 + 2), colliders));
  batch.addPoses(poses, gaps);
  let clear = 0;
  for (const gap of gaps) if (gap > 0.01) clear++;
  assert.ok(batch.size > 0 && batch.size <= clear);
  assert.equal(batch.query(start, goal).status, 'found');
});

test('a continuous joint plans on the line of its value; bad settings are refused', async () => {
  const wheel = new Robot({
      joints: [{ type: 'continuous' }],
      shapes: [{ joint: 0, end: [1, 0, 0], radius: 0.05 }],
    }),
    post = new CapsuleVolume({ start: [0, 0.6, -1], end: [0, 0.6, 1], radius: 0.02 }),
    options = { colliders: [post], seed: 6 };
  // The post stands at a quarter turn, between 0.1 and 3 on the line, and a pose past it is a different value.
  assert.equal(sweepRobot(wheel, [0.1], [3], [post]).clear, false);
  assert.equal((await planPath(wheel, [0.1], [3], { ...options, maxSamples: 500 })).status, 'no-path');
  // The same angle written one turn down is the way round, below zero, past the half turn: outside one turn of the start.
  const round = 3 - 2 * Math.PI,
    plan = await planPath(wheel, [0.1], [round], options);
  assert.equal(plan.status, 'found');
  same(plan.path.at(-1), [round]);
  assertClear(wheel, plan.path, [post], 0.01);
  const poses = new Roadmap(wheel, { around: [10], seed: 1 }).samplePoses(200);
  assert.ok(poses.every((q) => Math.abs(q - 10) <= Math.PI), 'samples stay one turn each way of the centre');
  assert.ok(poses.some((q) => q > 12) && poses.some((q) => q < 8));
  await assert.rejects(planPath(wheel, [0], [0], { algorithm: 'dijkstra' }), /Unknown plan algorithm/);
  await assert.rejects(planPath(wheel, [0, 1], [0]), /numbers/);
  await assert.rejects(planPath({}, [0], [0]), /needs a Robot/);
  await assert.rejects(planPath(wheel, [0], [0], { stepSize: 0 }), /stepSize/);
  await assert.rejects(planPath(wheel, [0], [0], { maxSamples: 0 }), /maxSamples/);
  await assert.rejects(planPath(wheel, [0], [0], { goalBias: 2 }), /goalBias/);
  await assert.rejects(planPath(wheel, [0], [0], { shortcuts: -1 }), /shortcuts/);
});
