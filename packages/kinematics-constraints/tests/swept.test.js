// @margoengine/kinematics-constraints/swept and /robot: every expected time here is the closed-form contact of the scene,
// or a dense brute-force scan of the same motion. A check that looked only at the two ends would fail each of them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AvoidanceSolver, CapsuleVolume, ConvexHullVolume, SolveStatus, SphereVolume } from '../dist/index.js';
import { Robot } from '../dist/robot.js';
import { sweepChain, sweepHull, sweepRobot } from '../dist/swept.js';

const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const rotateZ = (angle, x = 0, y = 0, z = 0) => {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, y, z, 1];
};
function box(half) {
  const points = [];
  for (const x of [-half, half]) for (const y of [-half, half]) for (const z of [-half, half]) points.push(x, y, z);
  return points;
}
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

test('Robot: forward kinematics of a planar two-link arm is the closed form', () => {
  const arm = new Robot({
    joints: [
      { lower: -4, upper: 4 },
      { origin: translate(1, 0, 0), lower: -4, upper: 4 },
      { type: 'fixed', origin: translate(0.5, 0, 0) },
    ],
  });
  assert.equal(arm.dof, 2);
  assert.equal(arm.jointCount, 3);
  arm.forward([0.4, -1.1]);
  const tip = arm.pointOn(2, [0, 0, 0]);
  assert.ok(Math.abs(tip[0] - (Math.cos(0.4) + 0.5 * Math.cos(0.4 - 1.1))) < 1e-12);
  assert.ok(Math.abs(tip[1] - (Math.sin(0.4) + 0.5 * Math.sin(0.4 - 1.1))) < 1e-12);
  const m = arm.frameMatrix(1);
  assert.ok(Math.abs(m[0] - Math.cos(0.4 - 1.1)) < 1e-12);
  assert.equal(m[15], 1);
});

test('Robot: a prismatic joint slides, a mimic joint repeats, ranges are read and enforced', () => {
  const robot = new Robot({
    joints: [
      { name: 'slide', type: 'prismatic', axis: [2, 0, 0], lower: -1, upper: 1 },
      { name: 'wheel', type: 'continuous', parent: null },
      { name: 'follow', type: 'prismatic', axis: [0, 1, 0], parent: 'slide', mimic: { joint: 'slide', multiplier: 2, offset: 0.5 } },
    ],
  });
  assert.equal(robot.dof, 2);
  assert.deepEqual(robot.variableNames, ['slide', 'wheel']);
  assert.equal(robot.upper[1], Infinity);
  robot.forward([0.25, 9]);
  const p = robot.pointOn(2, [0, 0, 0]);
  assert.deepEqual([...p], [0.25, 1, 0]);
  assert.equal(robot.within([0.5, 1000]), true);
  assert.equal(robot.within([1.5, 0]), false);
  assert.deepEqual([...robot.clamp([1.5, 2])], [1, 2]);
  assert.throws(() => robot.forward([0]), /2 numbers/);
  assert.throws(() => new Robot({ joints: [{ lower: 1, upper: 0 }] }), /lower at or below upper/);
  assert.throws(() => new Robot({ joints: [{ parent: 'nobody', lower: 0, upper: 1 }] }), /earlier joint/);
});

test('motionBounds: no point of a shape outruns its bound, on revolute, prismatic and mimic chains', () => {
  const rand = random(7);
  for (let round = 0; round < 40; round++) {
    const joints = [],
      shapes = [];
    for (let j = 0; j < 6; j++) {
      const axis = [rand() - 0.5, rand() - 0.5, rand() - 0.5],
        origin = rotateZ(rand() * 6, rand() - 0.5, rand() - 0.5, rand() - 0.5);
      if (j === 3) joints.push({ type: 'fixed', origin });
      else if (j === 2) joints.push({ type: 'prismatic', axis, origin, lower: -1, upper: 1 });
      else if (j === 5) joints.push({ axis, origin, mimic: { joint: 1, multiplier: -1.5, offset: 0.2 } });
      else joints.push({ axis, origin, lower: -3, upper: 3 });
    }
    shapes.push({ joint: 4, start: [0.1, 0, 0], end: [0.3, 0.4, 0.2], radius: 0.05 });
    shapes.push({ joint: 5, points: box(0.2), matrix: translate(0.3, -0.1, 0.2) });
    const robot = new Robot({ joints, shapes }),
      from = Array.from({ length: robot.dof }, () => rand() * 2 - 1),
      to = Array.from({ length: robot.dof }, () => rand() * 2 - 1),
      speed = robot.motionBounds(from, to),
      probes = [
        [4, [0.3, 0.4, 0.2], 0],
        [5, [0.5, 0.1, 0.4], 1],
        [5, [0.1, -0.3, 0], 1],
      ];
    const steps = 400,
      q = new Float64Array(robot.dof);
    for (const [joint, point, shape] of probes) {
      let last = null,
        fastest = 0;
      for (let i = 0; i <= steps; i++) {
        for (let k = 0; k < q.length; k++) q[k] = from[k] + ((to[k] - from[k]) * i) / steps;
        robot.forward(q);
        const now = [...robot.pointOn(joint, point)];
        if (last) fastest = Math.max(fastest, Math.hypot(now[0] - last[0], now[1] - last[1], now[2] - last[2]) * steps);
        last = now;
      }
      assert.ok(fastest > 0);
      assert.ok(fastest <= speed[shape], `point speed ${fastest} over bound ${speed[shape]}`);
    }
  }
});

test('sweepRobot: a link swung through a thin post stops at the closed-form contact, though both ends are clear', () => {
  const r = 0.05,
    rho = 0.01,
    D = 0.8,
    phi = 1,
    arm = new Robot({
      joints: [{ lower: -4, upper: 4 }],
      shapes: [{ joint: 0, end: [1, 0, 0], radius: r }],
    }),
    post = new CapsuleVolume({
      start: [D * Math.cos(phi), D * Math.sin(phi), -1],
      end: [D * Math.cos(phi), D * Math.sin(phi), 1],
      radius: rho,
    });
  assert.ok(arm.clearance([0], [post]) > 0.5);
  assert.ok(arm.clearance([2], [post]) > 0.5);
  const tolerance = 1e-6,
    hit = sweepRobot(arm, [0], [2], [post], { tolerance });
  assert.equal(hit.clear, false);
  assert.equal(hit.exhausted, false);
  assert.equal(hit.shape, 0);
  assert.equal(hit.collider, 0);
  // Contact: the post's distance to the link's line, D sin(phi - angle), equals r + rho.
  const contact = (phi - Math.asin((r + rho) / D)) / 2;
  assert.ok(hit.time <= contact, 'stopped past the contact');
  // Stopped when the gap read `tolerance`: at most that gap, over the slowest closing rate near contact, before it.
  assert.ok(contact - hit.time < (2 * tolerance) / (D * Math.cos(Math.asin((r + rho) / D))) / 2);
  arm.place([hit.time * 2]);
  assert.ok(arm.shapeGap(0, post) >= 0, 'the stop pose overlaps');
  assert.ok(arm.shapeGap(0, post) <= tolerance);
});

test('sweepRobot: however thin the wall and fast the slide, a prismatic joint meets it; minClearance stops it early', () => {
  const slider = new Robot({
      joints: [{ type: 'prismatic', axis: [1, 0, 0], lower: -1e6, upper: 1e6 }],
      shapes: [{ joint: 0, radius: 0.1 }],
    }),
    wall = new ConvexHullVolume({ points: [50, -9, -9, 50, 9, -9, 50, -9, 9, 50, 9, 9] }),
    span = 1e3,
    hit = sweepRobot(slider, [0], [span], [wall], { tolerance: 1e-6 });
  assert.equal(hit.clear, false);
  assert.ok(Math.abs(hit.time * span - (50 - 0.1)) < 2e-6);
  const shell = sweepRobot(slider, [0], [span], [wall], { tolerance: 1e-6, minClearance: 2 });
  assert.ok(Math.abs(shell.time * span - (50 - 0.1 - 2)) < 2e-6);
  assert.equal(sweepRobot(slider, [0], [40], [wall]).clear, true);
});

test('sweepRobot: a clear result holds on a dense scan, and a contact is the first, across seeded random motions', () => {
  const rand = random(85),
    robot = new Robot({
      joints: [
        { lower: -3, upper: 3 },
        { origin: translate(0, 0, 0.4), axis: [0, 1, 0], lower: -3, upper: 3 },
        { origin: translate(0.6, 0, 0), axis: [0, 1, 0], lower: -3, upper: 3 },
      ],
      shapes: [
        { joint: 1, end: [0.6, 0, 0], radius: 0.04 },
        { joint: 2, points: box(0.08), matrix: translate(0.4, 0, 0) },
      ],
    }),
    minClearance = 0.01,
    tolerance = 1e-4;
  let clear = 0,
    hits = 0;
  for (let round = 0; round < 120; round++) {
    const colliders = [
      new SphereVolume({ center: [rand() * 2 - 1, rand() * 2 - 1, rand() * 1.6 - 0.2], radius: 0.05 + rand() * 0.1 }),
      new CapsuleVolume({
        start: [rand() * 2 - 1, rand() * 2 - 1, rand()],
        end: [rand() * 2 - 1, rand() * 2 - 1, rand()],
        radius: 0.02,
      }),
      new ConvexHullVolume({ points: box(0.1), matrix: translate(rand() * 2 - 1, rand() * 2 - 1, rand()) }),
    ];
    const from = [rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2],
      to = [rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2];
    if (robot.clearance(from, colliders) < minClearance + tolerance) continue;
    const result = sweepRobot(robot, from, to, colliders, { minClearance, tolerance, maxSteps: 100000 }),
      q = [0, 0, 0],
      at = (t) => {
        for (let k = 0; k < 3; k++) q[k] = from[k] + (to[k] - from[k]) * t;
        return robot.clearance(q, colliders);
      };
    assert.equal(result.exhausted, false);
    const end = result.clear ? 1 : result.time;
    for (let i = 0; i <= 1500; i++) {
      assert.ok(at((end * i) / 1500) >= minClearance - 1e-9, `round ${round}: gap broken before the reported time`);
    }
    if (result.clear) clear++;
    else {
      hits++;
      assert.ok(at(result.time) <= minClearance + tolerance + 1e-9);
    }
  }
  assert.ok(clear > 10 && hits > 10, `scene mix: ${clear} clear, ${hits} hit`);
});

test('sweepRobot: a budget that runs out says so and never reads as clear', () => {
  const arm = new Robot({ joints: [{ lower: -4, upper: 4 }], shapes: [{ joint: 0, end: [1, 0, 0], radius: 0.01 }] }),
    near = new SphereVolume({ center: [0, 2, 0], radius: 0.99 }),
    out = sweepRobot(arm, [0], [Math.PI], [near], { maxSteps: 2 });
  assert.equal(out.clear, false);
  assert.equal(out.exhausted, true);
  assert.ok(out.time < 1);
  assert.equal(out.steps, 2);
});

test('sweepRobot: selfCollision finds a link folding through another, and pairs built to touch can be left out', () => {
  const folding = () =>
    new Robot({
      joints: [
        { lower: -4, upper: 4 },
        { origin: translate(1, 0, 0), lower: -4, upper: 4 },
        { origin: translate(0.2, 0, 0), lower: -4, upper: 4 },
      ],
      shapes: [
        { joint: 0, end: [1, 0, 0], radius: 0.02 },
        { joint: 2, end: [1, 0, 0], radius: 0.02 },
      ],
    });
  const robot = folding();
  assert.deepEqual([...robot.selfCollisionPairs], [0, 1]);
  // The last link sweeps from one side of the first to the other, about its joint at x = 1.2.
  const from = [0, 0, 2.6],
    to = [0, 0, 3.7];
  assert.ok(robot.clearance(from, [], true) > 0.04);
  assert.ok(robot.clearance(to, [], true) > 0.04);
  assert.equal(sweepRobot(robot, from, to, []).clear, true);
  const hit = sweepRobot(robot, from, to, [], { selfCollision: true });
  assert.equal(hit.clear, false);
  assert.equal(hit.shape, 0);
  assert.equal(hit.collider, -3);
  const free = folding().ignoreContactsAt([0, 0, Math.PI]);
  assert.equal(free.selfCollisionPairs.length, 0);
  assert.equal(sweepRobot(free, from, to, [], { selfCollision: true }).clear, true);
});

test('sweepChain: bones keep their length through the motion and the chain ends on the target pose', () => {
  const seen = [],
    spy = {
      evaluate: () => 1,
      segmentClearance(a, b) {
        seen.push([[...a], [...b]]);
        return 1000;
      },
    },
    from = [[0, 0, 0], [0.6, 0.8, 0], [0.6, 0.8, 2]],
    to = [[1, 0, 0], [1, 1, 0], [-1, 1, 0]],
    result = sweepChain(from, to, [spy], { radius: 0 });
  assert.equal(result.clear, true);
  for (const [a, b] of seen) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    assert.ok(Math.abs(length - 1) < 1e-9 || Math.abs(length - 2) < 1e-9, `bone length ${length}`);
  }
  const last = seen.at(-1);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(last[1][k] - to[2][k]) < 1e-9);
});

test('sweepChain: a pose the solver accepts in one frame through a thin plate is stopped at the plate', () => {
  const plate = new ConvexHullVolume({ points: [0.6, 0, -1, 2, 0, -1, 0.6, 0, 1, 2, 0, 1] }),
    solver = new AvoidanceSolver([plate], { minClearance: 0.02, complianceMargin: 0, targetRadius: 0.05 }),
    elbowFor = (_root, target, angle, out) => {
      const d = Math.hypot(target[0], target[1], target[2]),
        ux = target[0] / d,
        uy = target[1] / d,
        // Square to the reach, in the plane z = 0, then z.
        vx = -uy,
        vy = ux,
        h = Math.sqrt(1 - (d / 2) ** 2);
      out[0] = (ux * d) / 2 + vx * h * Math.cos(angle);
      out[1] = (uy * d) / 2 + vy * h * Math.cos(angle);
      out[2] = h * Math.sin(angle);
    },
    root = [0, 0, 0],
    startHand = [1, 0.8, 0],
    elbow = new Float64Array(3);
  elbowFor(root, startHand, Math.PI / 2, elbow);
  const startElbow = [...elbow],
    result = solver.solve(root, startHand, [1, -0.8, 0], 1, 1, 0.05, 0.05, 1, elbowFor, {
      swivelSpeedLimit: 10,
      searchBudget: 64,
    });
  assert.equal(result.status, SolveStatus.Success, 'the static check clears the far pose');
  const to = [root, [...result.elbow], [...result.target]],
    hit = sweepChain([root, startElbow, startHand], to, [plate], { radius: 0.05, minClearance: 0.01 });
  assert.equal(hit.clear, false);
  assert.ok(hit.time > 0 && hit.time < 1);
  assert.equal(hit.shape, 1, 'the forearm meets the plate');
});

test('sweepChain: a joint sphere wider than its links is checked on its own path', () => {
  const ball = new SphereVolume({ center: [Math.SQRT1_2, Math.SQRT1_2, 0.3], radius: 0.1 }),
    from = [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
    to = [[0, 0, 0], [0, 1, 0], [0, 2, 0]];
  // The links turn in the plane z = 0, 0.3 under the ball's centre: 0.15 clear of it at their closest.
  assert.equal(sweepChain(from, to, [ball], { radius: 0.05, minClearance: 0.1 }).clear, true);
  assert.equal(sweepChain(from, to, [ball], { radius: 0.05, minClearance: 0.2 }).clear, false);
  const hit = sweepChain(from, to, [ball], { radius: 0.05, jointRadius: [0, 0.4, 0], minClearance: 0 });
  assert.equal(hit.clear, false);
  assert.equal(hit.shape, 2);
});

test('sweepHull: a square turning a quarter turn hits a plate only on the way, at the closed-form angle', () => {
  const half = 0.5,
    w = 0.6,
    cube = new ConvexHullVolume({ points: box(half) }),
    plate = new ConvexHullVolume({ points: [w, -3, -3, w, 3, -3, w, -3, 3, w, 3, 3] }),
    tolerance = 1e-6,
    to = rotateZ(Math.PI / 2);
  cube.setTransform(rotateZ(0));
  assert.ok(cube.hullClearance(plate) > 0.09);
  cube.setTransform(to);
  assert.ok(cube.hullClearance(plate) > 0.09);
  const hit = sweepHull(cube, rotateZ(0), to, [plate], { tolerance });
  assert.equal(hit.clear, false);
  // A corner at radius half * sqrt 2, 45 degrees off the axis, reaches x = w at this angle.
  const contact = (Math.PI / 4 - Math.acos(w / (half * Math.SQRT2))) / (Math.PI / 2);
  assert.ok(hit.time <= contact);
  assert.ok(contact - hit.time < 1e-4);
  assert.ok(Math.abs(cube.hullClearance(plate) - (w - half)) < 1e-9, 'the hull is left at `to`');
});

test('sweepHull: a fast shot through a thin plate is caught; scale and turn count in the bound; shear is refused', () => {
  const pellet = new ConvexHullVolume({ points: box(0.01) }),
    plate = new ConvexHullVolume({ points: [5, -1, -1, 5, 1, -1, 5, -1, 1, 5, 1, 1] }),
    hit = sweepHull(pellet, translate(0, 0, 0), translate(100, 0, 0), [plate]);
  assert.equal(hit.clear, false);
  assert.ok(Math.abs(hit.time * 100 - 4.99) < 0.01);
  // Growing from 1 to 3 in place reaches x = 3 * 0.5 from the middle of a plate at 1.
  const grower = new ConvexHullVolume({ points: box(0.5) }),
    near = new SphereVolume({ center: [1, 0, 0], radius: 0.01 }),
    grown = [3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1],
    grow = sweepHull(grower, translate(0, 0, 0), grown, [near], { tolerance: 1e-6 });
  assert.equal(grow.clear, false);
  assert.ok(Math.abs(0.5 * (1 + 2 * grow.time) - 0.99) < 1e-4);
  assert.throws(() => sweepHull(grower, [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], translate(0, 0, 0), []), /no shear/);
  assert.throws(() => sweepHull(grower, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], translate(0, 0, 0), []), /no shear/);
});

test('a collider that gives NaN stops the check instead of reading clear', () => {
  const arm = new Robot({ joints: [{ lower: -4, upper: 4 }], shapes: [{ joint: 0, end: [1, 0, 0], radius: 0.01 }] }),
    broken = { evaluate: () => NaN, segmentClearance: () => NaN };
  assert.throws(() => sweepRobot(arm, [0], [1], [broken]), /finite clearance/);
});
