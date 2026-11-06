// @margoengine/kinematics-constraints/swept: every expected time here is the closed-form contact of the scene,
// or a dense brute-force scan of the same motion. A check that looked only at the two ends would fail each of them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AvoidanceSolver, CapsuleVolume, ConvexHullVolume, SolveStatus, SphereVolume } from '../dist/index.js';
import { sweepChain, sweepHull } from '../dist/swept.js';

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

test('sweepChain: a link swung through a thin post stops at the closed-form contact, though both ends are clear', () => {
  const r = 0.05,
    rho = 0.01,
    D = 0.8,
    phi = 1,
    pose = (angle) => [[0, 0, 0], [Math.cos(angle), Math.sin(angle), 0]],
    post = new CapsuleVolume({
      start: [D * Math.cos(phi), D * Math.sin(phi), -1],
      end: [D * Math.cos(phi), D * Math.sin(phi), 1],
      radius: rho,
    }),
    gapAt = (angle) => post.segmentClearance(...pose(angle), r);
  assert.ok(gapAt(0) > 0.5);
  assert.ok(gapAt(2) > 0.5);
  const tolerance = 1e-6,
    hit = sweepChain(pose(0), pose(2), [post], { radius: r, tolerance });
  assert.equal(hit.clear, false);
  assert.equal(hit.exhausted, false);
  assert.equal(hit.shape, 0);
  assert.equal(hit.collider, 0);
  // Contact: the post's distance to the link's line, D sin(phi - angle), equals r + rho.
  const contact = (phi - Math.asin((r + rho) / D)) / 2;
  assert.ok(hit.time <= contact, 'stopped past the contact');
  // Stopped when the gap read `tolerance`: at most that gap, over the slowest closing rate near contact, before it.
  assert.ok(contact - hit.time < (2 * tolerance) / (D * Math.cos(Math.asin((r + rho) / D))) / 2);
  assert.ok(gapAt(hit.time * 2) >= 0, 'the stop pose overlaps');
  assert.ok(gapAt(hit.time * 2) <= tolerance);
});

test('sweepChain: however thin the wall and fast the slide, a sphere meets it; minClearance stops it early', () => {
  const at = (x) => [[x, 0, 0], [x, 0, 0]],
    wall = new ConvexHullVolume({ points: [50, -9, -9, 50, 9, -9, 50, -9, 9, 50, 9, 9] }),
    span = 1e3,
    hit = sweepChain(at(0), at(span), [wall], { radius: 0.1, tolerance: 1e-6 });
  assert.equal(hit.clear, false);
  assert.ok(Math.abs(hit.time * span - (50 - 0.1)) < 2e-6);
  const shell = sweepChain(at(0), at(span), [wall], { radius: 0.1, tolerance: 1e-6, minClearance: 2 });
  assert.ok(Math.abs(shell.time * span - (50 - 0.1 - 2)) < 2e-6);
  assert.equal(sweepChain(at(0), at(40), [wall], { radius: 0.1 }).clear, true);
});

test('sweepHull: a clear result holds on a dense scan, and a contact is the first, across seeded random motions', () => {
  const rand = random(85),
    // Off its own origin, so a turn moves it as well as the line does.
    hull = new ConvexHullVolume({ points: box(0.08).map((value, i) => (i % 3 === 0 ? value + 0.5 : value)) }),
    minClearance = 0.01,
    tolerance = 1e-4,
    gap = new Float64Array(1);
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
    const start = rand() * 6 - 3,
      turn = rand() * 6 - 3,
      a = [rand() * 2 - 1, rand() * 2 - 1, rand()],
      b = [rand() * 2 - 1, rand() * 2 - 1, rand()],
      pose = (t) => rotateZ(start + turn * t, ...a.map((value, k) => value + (b[k] - value) * t)),
      at = (t) => {
        hull.setTransform(pose(t));
        let least = Infinity;
        for (const collider of colliders) {
          collider.hullClearanceInto(hull, gap);
          least = Math.min(least, gap[0]);
        }
        return least;
      };
    if (at(0) < minClearance + tolerance) continue;
    const result = sweepHull(hull, pose(0), pose(1), colliders, { minClearance, tolerance, maxSteps: 100000 });
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

test('sweepChain: a budget that runs out says so and never reads as clear', () => {
  const near = new SphereVolume({ center: [0, 2, 0], radius: 0.99 }),
    out = sweepChain([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [Math.cos(3), Math.sin(3), 0]], [near], { radius: 0.01, maxSteps: 2 });
  assert.equal(out.clear, false);
  assert.equal(out.exhausted, true);
  assert.ok(out.time < 1);
  assert.equal(out.steps, 2);
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
  const broken = { evaluate: () => NaN, segmentClearance: () => NaN };
  assert.throws(() => sweepChain([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [0, 1, 0]], [broken], { radius: 0.01 }), /finite clearance/);
});
