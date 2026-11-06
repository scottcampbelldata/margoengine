// @margoengine/kinematics-constraints/limits: each scene first shows the failure the solver exists to stop (a free solve
// that leaves its range or runs into the obstacle), then the solver keeping out of it. Stops are compared with the
// closed-form stop of the scene.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CapsuleVolume, ConvexHullVolume, SphereVolume } from '../dist/index.js';
import { armRobot, JointLimitSolver } from '../dist/limits.js';
import { Robot } from '../dist/robot.js';

const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A planar arm of unit links about +Z, ending in a fixed tip. */
function planar(ranges, radius = 0.05) {
  const joints = ranges.map(([lower, upper], i) => ({ lower, upper, origin: i ? translate(1, 0, 0) : undefined }));
  joints.push({ name: 'tip', type: 'fixed', origin: translate(1, 0, 0) });
  return new Robot({
    joints,
    shapes: ranges.map((_, i) => ({ joint: i, end: [1, 0, 0], radius })),
  });
}
function tipOf(robot, q) {
  robot.forward(q);
  return [...robot.pointOn(robot.jointCount - 1, [0, 0, 0])];
}

test('Robot.jacobian: matches finite differences on revolute, prismatic, fixed and mimic joints', () => {
  const rand = random(3);
  for (let round = 0; round < 30; round++) {
    const axis = () => [rand() - 0.5, rand() - 0.5, rand() - 0.5],
      offset = () => translate(rand() - 0.5, rand() - 0.5, rand() - 0.5),
      robot = new Robot({
        joints: [
          { axis: axis(), origin: offset(), lower: -3, upper: 3 },
          { type: 'prismatic', axis: axis(), origin: offset(), lower: -3, upper: 3 },
          { type: 'fixed', origin: offset() },
          { axis: axis(), origin: offset(), mimic: { joint: 0, multiplier: -0.7, offset: 0.3 } },
          { axis: axis(), origin: offset(), lower: -3, upper: 3 },
        ],
      }),
      q = [rand(), rand(), rand()],
      local = [0.3, -0.2, 0.1],
      j = new Float64Array(6 * 3);
    robot.forward(q);
    robot.jacobian(4, local, j);
    const h = 1e-6;
    for (let k = 0; k < 3; k++) {
      const up = [...q],
        down = [...q];
      up[k] += h;
      down[k] -= h;
      robot.forward(up);
      const a = [...robot.pointOn(4, local)];
      robot.forward(down);
      const b = [...robot.pointOn(4, local)];
      for (let r = 0; r < 3; r++) assert.ok(Math.abs(j[r * 3 + k] - (a[r] - b[r]) / (2 * h)) < 1e-6);
    }
  }
});

test('a target past a joint stop: the joint stops on its limit, the rest does its best, and the solver names it', () => {
  const target = tipOf(planar([[-4, 4], [-4, 4]]), [0.3, 1.5]),
    free = new JointLimitSolver(planar([[-4, 4], [-4, 4]]), { tip: 'tip' }).solve([0, 0.5], { position: target });
  assert.equal(free.reached, true, 'with no limit the target is reachable');
  assert.ok(free.q[1] > 1, 'and needs the elbow past 1');
  const out = new JointLimitSolver(planar([[-4, 4], [-1, 1]]), { tip: 'tip' }).solve([0, 0.5], { position: target });
  assert.equal(out.reached, false);
  assert.equal(out.q[1], 1);
  assert.deepEqual(out.limited, [1]);
  assert.equal(out.blocked, false);
  // At elbow 1 the tip stands 2 cos(1/2) from the root, and the target 2 cos(3/4): the rest is the shortest gap.
  assert.ok(Math.abs(out.error - (2 * Math.cos(0.5) - 2 * Math.cos(0.75))) < 1e-3);
});

test('an obstacle in the way of the free solution: the redundant arm goes round it and still reaches the target', () => {
  const ranges = [
      [-3, 3],
      [-3, 3],
      [-3, 3],
    ],
    target = [1.6, 0.9, 0],
    start = [1.2, -1.2, -0.3],
    free = new JointLimitSolver(planar(ranges), { tip: 'tip' }).solve(start, { position: target }),
    robot = planar(ranges);
  assert.equal(free.reached, true);
  // A ball on the middle of the free solution's second link: that solution is now a collision by construction.
  robot.forward(free.q);
  const ball = new SphereVolume({ center: [...robot.pointOn(1, [0.5, 0, 0])], radius: 0.12 });
  assert.ok(robot.clearance(free.q, [ball]) < 0);
  assert.ok(robot.clearance(start, [ball]) > 0.05);
  const out = new JointLimitSolver(robot, { tip: 'tip', colliders: [ball], minClearance: 0.02 }).solve(start, {
    position: target,
  });
  assert.equal(out.reached, true);
  assert.ok(out.error <= 1e-4);
  assert.ok(robot.clearance(out.q, [ball]) >= 0.02 - 1e-4);
  assert.ok(robot.within(out.q));
});

test('a thin post between the arm and its target: it stops at the closed-form angle, whatever the step size', () => {
  const r = 0.05,
    rho = 0.01,
    D = 0.8,
    phi = 1,
    gap = 0.02,
    post = new CapsuleVolume({
      start: [D * Math.cos(phi), D * Math.sin(phi), -1],
      end: [D * Math.cos(phi), D * Math.sin(phi), 1],
      radius: rho,
    }),
    goal = [Math.cos(2), Math.sin(2), 0];
  for (const maxStep of [0.05, 0.2, 3]) {
    const robot = new Robot({
        joints: [{ lower: -4, upper: 4 }, { name: 'tip', type: 'fixed', origin: translate(1, 0, 0) }],
        shapes: [{ joint: 0, end: [1, 0, 0], radius: r }],
      }),
      out = new JointLimitSolver(robot, { tip: 'tip', colliders: [post], minClearance: gap, maxStep }).solve([0], {
        position: goal,
      }),
      stop = phi - Math.asin((r + rho + gap) / D);
    assert.equal(out.reached, false);
    assert.equal(out.blocked, true);
    assert.ok(out.q[0] <= stop + 1e-9, `maxStep ${maxStep} passed the stop: ${out.q[0]} > ${stop}`);
    assert.ok(stop - out.q[0] < 1e-2, `maxStep ${maxStep} stopped short: ${out.q[0]} of ${stop}`);
    assert.ok(robot.clearance(out.q, [post]) >= gap - 2e-4);
  }
});

test('poses near the answer always converge, inside every range, on a seven-joint arm', () => {
  const rand = random(85),
    axes = [
      [0, 0, 1],
      [0, 1, 0],
      [0, 0, 1],
      [0, 1, 0],
      [0, 0, 1],
      [0, 1, 0],
      [0, 0, 1],
    ],
    joints = axes.map((axis, i) => ({ axis, lower: -2.5, upper: 2.5, origin: i ? translate(0, 0, 0.3) : undefined })),
    robot = new Robot({
      joints: [...joints, { name: 'tip', type: 'fixed', origin: translate(0, 0, 0.2) }],
      shapes: joints.map((_, i) => ({ joint: i, end: [0, 0, 0.3], radius: 0.03 })),
    }),
    solver = new JointLimitSolver(robot, { tip: 'tip', maxIterations: 200 });
  for (let round = 0; round < 60; round++) {
    const answer = axes.map(() => rand() * 3 - 1.5),
      start = answer.map((value) => value + (rand() - 0.5) * 0.6),
      position = tipOf(robot, answer),
      out = solver.solve(start, { position });
    assert.equal(out.reached, true, `round ${round}: error ${out.error}`);
    assert.equal(robot.within(out.q), true);
  }
});

test('a rotation target on a six-joint arm is met to within its angle tolerance', () => {
  const rand = random(11),
    axes = [
      [0, 0, 1],
      [0, 1, 0],
      [0, 1, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
    ],
    robot = new Robot({
      joints: axes.map((axis, i) => ({
        axis,
        lower: -3,
        upper: 3,
        origin: i === 0 ? undefined : i < 3 ? translate(0, 0, 0.5) : translate(0.2, 0, 0),
      })),
    }),
    solver = new JointLimitSolver(robot, { tip: 5, point: [0.1, 0, 0], maxIterations: 300 });
  for (let round = 0; round < 25; round++) {
    const answer = axes.map(() => rand() * 2 - 1),
      start = answer.map((value) => value + (rand() - 0.5) * 0.3);
    robot.forward(answer);
    const m = robot.frameMatrix(5),
      position = [...robot.pointOn(5, [0.1, 0, 0])],
      rotation = quaternionOf(m),
      out = solver.solve(start, { position, rotation });
    assert.equal(out.reached, true, `round ${round}: ${out.error} ${out.angleError}`);
    assert.ok(out.angleError <= 1e-3);
  }
  // With no rotation asked for, none is reported.
  assert.equal(solver.solve([0, 0.1, 0.2, 0, 0, 0], { position: [0.5, 0, 1.2] }).angleError, 0);
});

function quaternionOf(m) {
  const trace = m[0] + m[5] + m[10],
    s = Math.sqrt(Math.max(trace + 1, 1e-12)) * 2;
  return [(m[6] - m[9]) / s, (m[8] - m[2]) / s, (m[1] - m[4]) / s, s / 4];
}

test('the path from start to result is clear, across seeded scenes on an arm with limits', () => {
  const rand = random(21),
    arm = armRobot({ upperLength: 1, forearmLength: 1, radius: 0.05, elbow: [0.1, 2.6] });
  let reached = 0;
  for (let round = 0; round < 40; round++) {
    const colliders = [
        new SphereVolume({ center: [rand() * 3 - 1.5, rand() * 3 - 1.5, rand() * 3 - 1.5], radius: 0.1 + rand() * 0.3 }),
        new ConvexHullVolume({
          points: [-0.2, -0.2, -0.2, 0.2, -0.2, -0.2, -0.2, 0.2, -0.2, -0.2, -0.2, 0.2, 0.2, 0.2, 0.2],
          matrix: translate(rand() * 3 - 1.5, rand() * 3 - 1.5, rand() * 3 - 1.5),
        }),
      ],
      start = [rand() - 0.5, rand() - 0.5, rand() - 0.5, 0.5 + rand()],
      minClearance = 0.02;
    if (arm.clearance(start, colliders) < minClearance + 1e-3) continue;
    const position = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1],
      solver = new JointLimitSolver(arm, { tip: 'hand', colliders, minClearance }),
      out = solver.solve(start, { position });
    assert.equal(arm.within(out.q), true);
    assert.ok(arm.clearance(out.q, colliders) >= minClearance - 1e-3, `round ${round}`);
    if (out.reached) reached++;
  }
  assert.ok(reached > 0);
});

test('armRobot: the hand reaches a point, and a bent-only elbow stops short of full reach', () => {
  const arm = armRobot({ upperLength: 1, forearmLength: 1, radius: 0.05, elbow: [0.5, 2.6] }),
    solver = new JointLimitSolver(arm, { tip: 'hand' }),
    reach = solver.solve([0, 0, 0, 1], { position: [0.5, 1, 0.4] });
  assert.equal(reach.reached, true);
  const far = solver.solve([0, 0, 0, 1], { position: [0, 3, 0] });
  assert.equal(far.reached, false);
  assert.ok(Math.abs(far.q[3] - 0.5) < 1e-12);
  assert.ok(far.limited.includes(3));
  // Two unit bones with a 0.5 rad bend stand 2 cos(1/4) apart at the ends.
  assert.ok(Math.abs(far.error - (3 - 2 * Math.cos(0.25))) < 1e-3);
});

test('a pose already inside the gap is pushed out before anything else', () => {
  const robot = new Robot({
      joints: [{ lower: -4, upper: 4 }, { name: 'tip', type: 'fixed', origin: translate(1, 0, 0) }],
      shapes: [{ joint: 0, end: [1, 0, 0], radius: 0.05 }],
    }),
    ball = new SphereVolume({ center: [0.8, 0.09, 0], radius: 0.05 });
  assert.ok(robot.clearance([0], [ball]) < 0);
  const out = new JointLimitSolver(robot, { tip: 'tip', colliders: [ball], minClearance: 0.02 }).solve([0], {
    position: [Math.cos(-1), Math.sin(-1), 0],
  });
  assert.equal(out.reached, true);
  assert.ok(robot.clearance(out.q, [ball]) >= 0.02);
});

test('rest leans the spare freedom toward a pose without moving the target', () => {
  const ranges = [
      [-3, 3],
      [-3, 3],
      [-3, 3],
    ],
    position = [1.5, 0.5, 0],
    start = [0.2, 0.3, 0.3],
    rest = [0.9, -0.2, -0.6],
    apart = (q) => Math.hypot(q[0] - rest[0], q[1] - rest[1], q[2] - rest[2]),
    plain = new JointLimitSolver(planar(ranges), { tip: 'tip', restWeight: 0 }).solve(start, { position }),
    leaning = new JointLimitSolver(planar(ranges), { tip: 'tip', rest, maxIterations: 300 }).solve(start, { position });
  assert.equal(plain.reached, true);
  assert.equal(leaning.reached, true);
  assert.ok(apart(leaning.q) < apart(plain.q));
  assert.ok(leaning.error <= 1e-4);
});

test('bad settings are refused with a reason', () => {
  const robot = planar([[-1, 1]]);
  assert.throws(() => new JointLimitSolver({}, { tip: 0 }), /needs a Robot/);
  assert.throws(() => new JointLimitSolver(robot, { tip: 'nobody' }), /not a joint/);
  assert.throws(() => new JointLimitSolver(robot, { tip: 0, tolerance: 0 }), /tolerance/);
  assert.throws(() => new JointLimitSolver(robot, { tip: 0, rest: [1, 2] }), /rest/);
  const solver = new JointLimitSolver(robot, { tip: 0 });
  assert.throws(() => solver.solve([0, 0], { position: [0, 0, 0] }), /numbers/);
  assert.throws(() => solver.solve([0], { position: [NaN, 0, 0] }), /finite/);
});

