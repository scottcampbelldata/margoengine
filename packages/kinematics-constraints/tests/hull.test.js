import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AvoidanceSolver, CapsuleVolume, ConvexHullVolume, SolveStatus, SphereVolume } from '../dist/index.js';

const close = (actual, expected, tolerance = 1e-8, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} is not within ${tolerance} of ${expected}`);

// Corners of the box from `min` to `max`.
function boxPoints(min, max) {
  const points = [];
  for (let i = 0; i < 8; i++) points.push(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
  return points;
}
const cube = (half = 1) => new ConvexHullVolume({ points: boxPoints([-half, -half, -half], [half, half, half]) });
const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The exact signed distance of a point to an axis-aligned box.
function boxDistance(p, half) {
  const q = p.map((v, i) => Math.abs(v) - half[i]);
  const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
  return outside + Math.min(Math.max(q[0], q[1], q[2]), 0);
}

const elbowAt = (_root, _target, angle, out) => {
  out[0] = 0.6;
  out[1] = 0.8 * Math.cos(angle);
  out[2] = 0.8 * Math.sin(angle);
};
const root = [0, 0, 0],
  hand = [1.2, 0, 0];

test('a target that clears the fitted capsule but hits the box corner is pushed out by the hull', () => {
  const corner = [0.9, 0.9, 0];
  const capsule = new CapsuleVolume({ start: [0, 0, -1], end: [0, 0, 1], radius: 1 });
  const passed = new AvoidanceSolver([capsule], { minClearance: 0, complianceMargin: 0 });
  assert.deepEqual(
    [...passed.resolveTarget(corner, 1 / 60)].map((v) => +v.toFixed(5)),
    corner,
  );
  const hull = new AvoidanceSolver([cube()], { minClearance: 0.01, complianceMargin: 0 });
  const target = hull.resolveTarget(corner, 1 / 60);
  assert.ok(hull.targetResult.resolved);
  close(Math.max(...target), 1.01, 1e-5, 'pushed out through the nearest face');
  close(boxDistance([...target], [1, 1, 1]), 0.01, 1e-5, 'the required shell');
});

test('evaluate matches the exact signed distance of a box, inside and out', () => {
  const half = [1, 0.5, 2],
    hull = new ConvexHullVolume({ points: boxPoints([-1, -0.5, -2], half) }),
    surface = [0, 0, 0],
    normal = [0, 0, 0],
    next = random(7);
  for (let i = 0; i < 2000; i++) {
    const p = [(next() - 0.5) * 6, (next() - 0.5) * 6, (next() - 0.5) * 8],
      distance = hull.evaluate(p, surface, normal),
      exact = boxDistance(p, half);
    close(distance, exact, 1e-7, `distance at ${p}`);
    close(Math.hypot(...normal), 1, 1e-9, 'unit normal');
    // Moving from the surface along the normal gives the same point at the reported distance, and it is on the box.
    for (let a = 0; a < 3; a++) close(surface[a] + normal[a] * distance, p[a], 1e-7, 'surface + normal');
    close(boxDistance(surface, half), 0, 1e-7, 'the surface point is on the box');
  }
});

test('evaluate certifies its answer on random point clouds: every point is behind the supporting plane', () => {
  const next = random(11),
    surface = new Float64Array(3),
    normal = new Float64Array(3);
  for (let i = 0; i < 300; i++) {
    const points = [];
    for (let j = 0, n = 4 + (i % 40); j < n; j++) points.push(next() * 2 - 1, next() * 2 - 1, next() * 2 - 1);
    const hull = new ConvexHullVolume({ points }),
      p = [next() * 4 - 2, next() * 4 - 2, next() * 4 - 2];
    hull.evaluate(p, surface, normal);
    const plane = surface[0] * normal[0] + surface[1] * normal[1] + surface[2] * normal[2];
    let high = -Infinity;
    for (let j = 0; j < points.length; j += 3)
      high = Math.max(high, points[j] * normal[0] + points[j + 1] * normal[1] + points[j + 2] * normal[2]);
    close(high, plane, 1e-7, 'support of the hull along the normal');
  }
});

test('segmentClearance matches a dense walk along the segment outside, and the exact depth inside', () => {
  const half = [1, 1, 1],
    hull = cube(),
    next = random(3);
  let outside = 0;
  for (let i = 0; i < 300; i++) {
    const a = [next() * 8 - 4, next() * 8 - 4, next() * 8 - 4],
      b = [next() * 8 - 4, next() * 8 - 4, next() * 8 - 4];
    let walked = Infinity;
    for (let t = 0; t <= 4000; t++) {
      const f = t / 4000;
      walked = Math.min(
        walked,
        boxDistance([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], half),
      );
    }
    const gap = hull.segmentClearance(a, b, 0);
    if (walked > 0) {
      outside++;
      assert.ok(gap <= walked + 1e-9, `${gap} above the walked ${walked}`);
      assert.ok(gap >= walked - 0.005, `${gap} far below the walked ${walked}`);
    } else assert.ok(gap <= 1e-9, `overlapping segment reported ${gap}`);
  }
  assert.ok(outside > 50, 'the walk saw clear segments');
  // Straight through the middle along x: the way out is sideways.
  close(hull.segmentClearance([-5, 0, 0], [5, 0, 0], 0), -1, 1e-8, 'through the middle');
  close(hull.segmentClearance([-5, 0.75, 0], [5, 0.75, 0], 0), -0.25, 1e-8, 'near the top face');
  // The radius subtracts from a gap and adds to a depth.
  close(hull.segmentClearance([3, 0, 0], [4, 0, 0], 0.5), 1.5, 1e-9, 'gap less radius');
  close(hull.segmentClearance([-5, 0, 0], [5, 0, 0], 0.25), -1.25, 1e-8, 'depth plus radius');
  // A zero-length segment is a point.
  close(hull.segmentClearance([3, 0, 0], [3, 0, 0], 0), 2, 1e-9, 'a point');
});

test('hullClearance matches the exact gap and depth of axis-aligned boxes', () => {
  const next = random(23);
  for (let i = 0; i < 1500; i++) {
    const ha = [next() + 0.1, next() + 0.1, next() + 0.1],
      hb = [next() + 0.1, next() + 0.1, next() + 0.1],
      offset = [next() * 5 - 2.5, next() * 5 - 2.5, next() * 5 - 2.5];
    const a = new ConvexHullVolume({
        points: boxPoints(
          ha.map((v) => -v),
          ha,
        ),
      }),
      b = new ConvexHullVolume({
        points: boxPoints(
          hb.map((v) => -v),
          hb,
        ),
        matrix: translation(...offset),
      });
    const across = offset.map((v, k) => Math.abs(v) - ha[k] - hb[k]);
    const exact =
      Math.max(...across) > 0
        ? Math.hypot(Math.max(across[0], 0), Math.max(across[1], 0), Math.max(across[2], 0))
        : Math.max(...across);
    close(a.hullClearance(b), exact, 1e-7, `boxes at ${offset}`);
    close(b.hullClearance(a), exact, 1e-7, 'the other way round');
  }
});

test('setTransform moves, rotates and scales the hull, with any array type', () => {
  const hull = cube();
  const surface = [0, 0, 0],
    normal = [0, 0, 0];
  assert.equal(hull.setTransform(translation(10, 0, 0)), hull, 'it chains');
  close(hull.evaluate([12, 0, 0], surface, normal), 1, 1e-9, 'translated');
  assert.deepEqual(surface, [11, 0, 0]);
  // 45 degrees about Z in a Float32Array: the corner now points along +X.
  const c = Math.SQRT1_2;
  hull.setTransform(new Float32Array([c, c, 0, 0, -c, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  close(hull.evaluate([3, 0, 0], surface, normal), 3 - Math.SQRT2, 1e-6, 'rotated corner');
  // Scale and shear keep the support mapping exact.
  hull.setTransform(new Float64Array([3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]));
  close(hull.evaluate([4, 0, 0], surface, normal), 1, 1e-9, 'scaled x');
  close(hull.evaluate([0, 0, 1], surface, normal), 0.5, 1e-9, 'scaled z');
  hull.setTransform(translation(0, 0, 0));
  close(hull.evaluate([2, 0, 0], surface, normal), 1, 1e-9, 'moved back');
  const placed = new ConvexHullVolume({ points: boxPoints([0, 0, 0], [1, 1, 1]), matrix: translation(5, 0, 0) });
  close(placed.segmentClearance([3, 0.5, 0.5], [4, 0.5, 0.5], 0), 1, 1e-9, 'constructor matrix');
});

test('duplicate points are dropped and a corner of a flat or line hull still answers', () => {
  const twin = new ConvexHullVolume({
    points: [...boxPoints([0, 0, 0], [1, 1, 1]), ...boxPoints([0, 0, 0], [1, 1, 1])],
  });
  assert.equal(twin.pointCount, 8);
  close(twin.segmentClearance([2, 0.5, 0.5], [3, 0.5, 0.5], 0), 1, 1e-9, 'twinned box');
  const surface = [0, 0, 0],
    normal = [0, 0, 0];

  // One point repeated.
  const dot = new ConvexHullVolume({ points: [1, 1, 1, 1, 1, 1] });
  assert.equal(dot.pointCount, 1);
  close(dot.evaluate([1, 1, 3], surface, normal), 2, 1e-12, 'distance to a point');
  assert.deepEqual(normal, [0, 0, 1]);
  assert.equal(dot.evaluate([1, 1, 1], surface, normal), 0);
  assert.deepEqual(normal, [1, 0, 0], 'on the point, the fixed fallback normal');
  close(dot.segmentClearance([0, 1, 1], [2, 1, 1], 0.25), -0.25, 1e-12, 'segment through a point');

  // A line.
  const rod = new ConvexHullVolume({ points: [0, 0, 0, 1, 1, 1, 2, 2, 2] });
  close(rod.evaluate([2, 0, 2], surface, normal), Math.sqrt(8 / 3), 1e-9, 'beside a line');
  assert.equal(rod.evaluate([0.5, 0.5, 0.5], surface, normal), 0, 'on a line');
  close(Math.hypot(...normal), 1, 1e-12, 'unit normal on a line');
  close(normal[0] + normal[1] + normal[2], 0, 1e-9, 'the normal on a line is across it');

  // A flat square in the z = 0 plane.
  const plate = new ConvexHullVolume({ points: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0] });
  close(plate.evaluate([0.5, 0.5, 2], surface, normal), 2, 1e-9, 'above the plate');
  assert.deepEqual([...normal].map(Math.abs), [0, 0, 1]);
  close(plate.evaluate([3, 0, 0], surface, normal), 2, 1e-9, 'off its edge in its plane');
  assert.equal(plate.evaluate([0.25, 0.25, 0], surface, normal), 0, 'on the plate');
  assert.deepEqual(normal, [0, 0, 1], 'the normal on a plate is repeatable');
  assert.deepEqual(surface, [0.25, 0.25, 0]);
  // A segment through it has real depth (plate plus segment make a solid); one lying in it has none.
  close(
    plate.segmentClearance([0, 0, -1], [0, 0, 1], 0),
    -1,
    1e-9,
    'a segment through the plate must move by its half length',
  );
  assert.equal(plate.segmentClearance([-5, 0, 0], [5, 0, 0], 0), 0, 'in its plane');
  // Flat against flat, same plane, overlapping and clear.
  const other = new ConvexHullVolume({ points: [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0] });
  assert.equal(plate.hullClearance(other), 0, 'two coplanar plates overlap with no depth');
  other.setTransform(translation(3, 0, 0));
  close(plate.hullClearance(other), 2, 1e-9, 'two coplanar plates apart');

  // A matrix that flattens a solid hull onto a plane, and onto a point, leaves valid degenerate hulls.
  const squashed = cube();
  squashed.setTransform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  close(squashed.evaluate([0, 0, 2], surface, normal), 2, 1e-9, 'flattened');
  squashed.setTransform([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 1]);
  close(squashed.evaluate([7, 0, 0], surface, normal), 2, 1e-9, 'collapsed');
});

test('touching shapes read zero and deep overlap reads the way out', () => {
  const surface = [0, 0, 0],
    normal = [0, 0, 0],
    a = cube(),
    b = cube();
  // Face to face, edge to edge and corner to corner.
  for (const offset of [
    [2, 0, 0],
    [2, 2, 0],
    [2, 2, 2],
    [2, 0.5, 0.25],
  ]) {
    b.setTransform(translation(...offset));
    close(a.hullClearance(b), 0, 1e-9, `touching at ${offset}`);
  }
  // A point exactly on a face, edge and corner.
  close(a.evaluate([1, 0, 0], surface, normal), 0, 1e-12, 'on a face');
  assert.deepEqual(normal, [1, 0, 0]);
  close(a.evaluate([1, 1, 1], surface, normal), 0, 1e-12, 'on a corner');
  close(Math.hypot(...normal), 1, 1e-12, 'unit normal at a corner');
  // At the centre of a cube all six faces tie: the normal is one of the axes.
  close(a.evaluate([0, 0, 0], surface, normal), -1, 1e-9, 'at the centre');
  close(Math.max(...normal.map(Math.abs)), 1, 1e-9, 'an axis');
  // The same hull against itself: the whole size deep.
  b.setTransform(translation(0, 0, 0));
  close(a.hullClearance(a), -2, 1e-8, 'against itself');
  close(a.hullClearance(b), -2, 1e-8, 'against its copy');
  // One inside another, off centre.
  const small = new ConvexHullVolume({ points: boxPoints([0.5, -0.1, -0.1], [0.7, 0.1, 0.1]) });
  close(a.hullClearance(small), -0.5, 1e-8, 'nested');
});

test('queries stay accurate at the scale and place the caller works in', () => {
  const surface = [0, 0, 0],
    normal = [0, 0, 0];
  for (const unit of [1e-4, 1e-2, 1e2, 1e6]) {
    const hull = new ConvexHullVolume({ points: boxPoints([-unit, -unit, -unit], [unit, unit, unit]) });
    close(hull.evaluate([3 * unit, 0, 0], surface, normal), 2 * unit, unit * 1e-9, `${unit} outside`);
    close(hull.evaluate([0.5 * unit, 0, 0], surface, normal), -0.5 * unit, unit * 1e-7, `${unit} inside`);
    close(hull.segmentClearance([2 * unit, 0, 0], [3 * unit, 0, 0], 0), unit, unit * 1e-9, `${unit} segment`);
  }
  const far = cube().setTransform(translation(1e5, -1e5, 1e5));
  close(far.evaluate([1e5 + 3, -1e5, 1e5], surface, normal), 2, 1e-8, 'far from the origin, outside');
  close(far.evaluate([1e5 + 0.5, -1e5, 1e5], surface, normal), -0.5, 1e-6, 'far from the origin, inside');
  // A gap small next to the hull's size still reads true.
  const hull = cube();
  close(hull.evaluate([1 + 1e-6, 0, 0], surface, normal), 1e-6, 1e-10, 'a micrometre from a metre box');
  assert.deepEqual(normal, [1, 0, 0]);
});

test('bad input throws, and names the fix', () => {
  const surface = [0, 0, 0],
    normal = [0, 0, 0],
    hull = cube();
  assert.throws(() => new ConvexHullVolume({}), TypeError);
  assert.throws(() => new ConvexHullVolume({ points: [1, 2] }), /flat x, y, z/);
  assert.throws(() => new ConvexHullVolume({ points: [] }), /at least one point/);
  assert.throws(() => new ConvexHullVolume({ points: [0, NaN, 0] }), RangeError);
  assert.throws(() => new ConvexHullVolume({ points: [0, Infinity, 0] }), RangeError);
  assert.throws(() => new ConvexHullVolume({ points: [0, 0, 0], maxPoints: 0 }), /maxPoints/);
  assert.throws(() => new ConvexHullVolume({ points: boxPoints([0, 0, 0], [1, 1, 1]), maxPoints: 7 }), /maxPoints/);
  const many = [];
  for (let i = 0; i < 65; i++) many.push(i, i * i, i * i * i);
  assert.throws(() => new ConvexHullVolume({ points: many }), /raise it/);
  assert.equal(new ConvexHullVolume({ points: many, maxPoints: 65 }).pointCount, 65);
  assert.throws(() => hull.setTransform(new Float32Array(12)), /16 values/);
  assert.throws(() => hull.setTransform(null), /16 values/);
  const nan = translation(0, 0, 0);
  nan[13] = NaN;
  assert.throws(() => hull.setTransform(nan), /non-finite/);
  const projective = translation(0, 0, 0);
  projective[3] = 1;
  assert.throws(() => hull.setTransform(projective), /affine/);
  // A failed setTransform leaves the hull where it was.
  close(hull.evaluate([2, 0, 0], surface, normal), 1, 1e-9, 'unmoved');
  assert.throws(() => hull.evaluate([NaN, 0, 0], surface, normal), RangeError);
  assert.throws(() => hull.evaluate([0, 0, 0], surface, surface), /overlap/);
  assert.throws(() => hull.segmentClearance([0, 0, 0], [Infinity, 0, 0], 0), RangeError);
  assert.throws(() => hull.segmentClearance([0, 0, 0], [1, 0, 0], NaN), RangeError);
  assert.throws(() => hull.segmentClearance([0, 0, 0], [1, 0, 0], -1), RangeError);
});

test('query point may alias the surface output', () => {
  const hull = cube(),
    point = [3, 0, 0],
    normal = [0, 0, 0];
  close(hull.evaluate(point, point, normal), 2, 1e-9, 'aliased');
  assert.deepEqual(point, [1, 0, 0]);
  const buffer = new Float32Array(3);
  buffer[0] = 3;
  close(hull.evaluate(buffer, buffer, normal), 2, 1e-6, 'aliased typed array');
  close(buffer[0], 1, 1e-6, 'surface x');
});

test('a hull subclass or instance override decides what the solver checks', () => {
  let calls = 0;
  class Custom extends ConvexHullVolume {
    segmentClearance() {
      calls++;
      return -0.1;
    }
  }
  const far = boxPoints([0, 4, 0], [1, 5, 1]);
  const solve = (solver) => solver.solve(root, hand, hand, 1, 1, 0.03, 0.05, 1 / 60, elbowAt);
  assert.ok(solve(new AvoidanceSolver([new ConvexHullVolume({ points: far })])).resolved);
  assert.equal(solve(new AvoidanceSolver([new Custom({ points: far })])).status, SolveStatus.ObstacleOccluded);
  assert.ok(calls > 0);
  const hull = new ConvexHullVolume({ points: far }),
    solver = new AvoidanceSolver([hull]);
  hull.evaluate = () => NaN;
  assert.throws(() => solve(solver), /Non-finite volume distance/);
});

// A forearm with a fin along its local +X, the hinge direction. For the centre pole below, the bend normal is -Z.
const fin = () => new ConvexHullVolume({ points: boxPoints([-0.02, 0, -0.02], [0.3, 1, 0.02]) });
const forearmMiddle = [0.9, 0.4, 0];
const linkOptions = { minClearance: 0.001, complianceMargin: 0 };

test('a link checked as a hull is refused where its capsule passes, and the swivel search finds a way round', () => {
  const obstacle = new SphereVolume({ center: [forearmMiddle[0], forearmMiddle[1], -0.25], radius: 0.05 });
  const capsule = new AvoidanceSolver([obstacle], linkOptions).solve(root, hand, hand, 1, 1, 0.02, 0.02, 1, elbowAt);
  assert.equal(capsule.status, SolveStatus.Success);
  assert.equal(capsule.poleAngle, 0, 'the capsule passes at the first pole');

  const solver = new AvoidanceSolver([obstacle], { ...linkOptions, links: [null, { hull: fin() }] });
  const result = solver.solve(root, hand, hand, 1, 1, 0.02, 0.02, 1, elbowAt);
  assert.equal(result.status, SolveStatus.Success);
  assert.notEqual(result.poleAngle, 0, 'the hull does not');
  assert.ok(result.clearance >= -solver.tolerance);
  assert.ok(result.iterations > 2, 'it searched');
});

test('the link frame follows the hinge: the same obstacle on the far side of the fin does not block it', () => {
  const obstacle = new SphereVolume({ center: [forearmMiddle[0], forearmMiddle[1], 0.25], radius: 0.05 });
  const solver = new AvoidanceSolver([obstacle], { ...linkOptions, links: [null, { hull: fin() }] });
  const result = solver.solve(root, hand, hand, 1, 1, 0.02, 0.02, 1, elbowAt);
  assert.equal(result.status, SolveStatus.Success);
  assert.equal(result.poleAngle, 0);
  // Reversing the hinge turns the fin to face that obstacle.
  const reversed = new AvoidanceSolver([obstacle], {
    ...linkOptions,
    links: [null, { hull: fin(), hinge: [-1, 0, 0] }],
  });
  assert.notEqual(reversed.solve(root, hand, hand, 1, 1, 0.02, 0.02, 1, elbowAt).poleAngle, 0);
});

test('axis, hinge and origin place the link hull exactly', () => {
  // Points in a local frame whose link runs along +Z, starting at (1, 2, 3), hinge along +Y.
  const hull = new ConvexHullVolume({ points: [1, 2, 3, 1, 2, 4, 1, 2.5, 3.5] }),
    far = new SphereVolume({ center: [0, 50, 0], radius: 1 });
  const solver = new AvoidanceSolver([far], {
    links: [{ hull, origin: [1, 2, 3], axis: [0, 0, 2], hinge: [0, 3, 1] }],
  });
  const result = solver.solve(root, hand, hand, 1, 1, 0, 0, 1 / 60, elbowAt);
  assert.equal(result.status, SolveStatus.Success);
  // The upper link runs from the root to the elbow (0.6, 0.8, 0), the normal is -Z, and hinge [0, 3, 1] has its
  // part square to the axis on +Y. So local (1, 2.5, 3.5) lands half way along the link and 0.5 down Z.
  const surface = [0, 0, 0],
    normal = [0, 0, 0];
  close(hull.evaluate([0, 0, 0], surface, normal), 0, 1e-6, 'the root on the start point');
  close(hull.evaluate([...result.elbow], surface, normal), 0, 1e-5, 'the elbow on the end point');
  close(hull.evaluate([0.3, 0.4, -0.5], surface, normal), 0, 1e-5, 'the third point');
  close(hull.evaluate([0.3, 0.4, 0.5], surface, normal), 0.5, 1e-5, 'and the other side of the link is clear');
});

test('link hulls check against sphere, capsule and hull colliders alike, on both links', () => {
  // The upper link runs root to (0.6, 0.8, 0). A wide plate on it, across the bend plane.
  const plate = () => new ConvexHullVolume({ points: boxPoints([-0.4, 0, -0.01], [0.4, 1, 0.01]) });
  const at = [0.3, 0.4, 0.3];
  for (const collider of [
    new SphereVolume({ center: at, radius: 0.05 }),
    new CapsuleVolume({ start: at, end: [at[0], at[1], at[2] + 0.5], radius: 0.05 }),
    new ConvexHullVolume({ points: boxPoints([0.25, 0.35, 0.25], [0.35, 0.45, 0.35]) }),
  ]) {
    const clear = new AvoidanceSolver([collider], linkOptions).solve(root, hand, hand, 1, 1, 0.01, 0.01, 1, elbowAt);
    assert.equal(clear.poleAngle, 0, `${collider.constructor.name} misses the capsule`);
    const blocked = new AvoidanceSolver([collider], { ...linkOptions, links: [{ hull: plate() }] }).solve(
      root,
      hand,
      hand,
      1,
      1,
      0.01,
      0.01,
      1,
      elbowAt,
    );
    assert.equal(blocked.status, SolveStatus.Success);
    assert.notEqual(blocked.poleAngle, 0, `${collider.constructor.name} hits the hull`);
  }
});

test('calculatePoleClearance also honours link hulls', () => {
  const obstacle = new SphereVolume({ center: [forearmMiddle[0], forearmMiddle[1], -0.25], radius: 0.05 });
  const plain = new AvoidanceSolver([obstacle], linkOptions);
  const hulled = new AvoidanceSolver([obstacle], { ...linkOptions, links: [null, { hull: fin() }] });
  const elbow = [0.6, 0.8, 0];
  assert.equal(plain.calculatePoleClearance(root, elbow, hand, 0.02).poleAngleOffset, 0);
  const result = hulled.calculatePoleClearance(root, elbow, hand, 0.02);
  assert.ok(result.resolved);
  assert.notEqual(result.poleAngleOffset, 0);
});

test('link hull options are checked', () => {
  const sphere = new SphereVolume({ center: [0, 9, 0], radius: 1 });
  const links = [{ hull: fin() }];
  assert.throws(() => new AvoidanceSolver([sphere], { links: [{ hull: {} }] }), /must be a ConvexHullVolume/);
  assert.throws(() => new AvoidanceSolver([sphere], { links: [{ hull: fin(), axis: [0, 0, 0] }] }), /not parallel/);
  assert.throws(
    () => new AvoidanceSolver([sphere], { links: [{ hull: fin(), axis: [0, 1, 0], hinge: [0, 2, 0] }] }),
    /not parallel/,
  );
  assert.throws(() => new AvoidanceSolver([sphere], { links: [{ hull: fin(), hinge: [0, 0, NaN] }] }), RangeError);
  assert.throws(() => new AvoidanceSolver([sphere], { links, upperArmRadius: null }), /replaces upperArmRadius/);
  assert.throws(() => new AvoidanceSolver([sphere], { links, upperArmRadius: 0.1 }), /replaces upperArmRadius/);
  assert.throws(() => new AvoidanceSolver([sphere], { links, rootExclusion: 0.1 }), /replaces upperArmRadius/);
  // upperArmRadius and rootExclusion still apply when only the forearm has a hull.
  new AvoidanceSolver([sphere], { links: [null, { hull: fin() }], upperArmRadius: null, rootExclusion: 0.1 });

  const shared = fin();
  assert.throws(() => new AvoidanceSolver([shared], { links: [{ hull: shared }] }), /cannot also be a collider/);
  const custom = {
    evaluate: sphere.evaluate.bind(sphere),
    segmentClearance: sphere.segmentClearance.bind(sphere),
  };
  assert.throws(() => new AvoidanceSolver([custom], { links }), /hullClearanceInto/);
  const solver = new AvoidanceSolver([sphere], { links });
  assert.throws(() => solver.addVolume(custom), /hullClearanceInto/);
  // A custom volume that answers for hulls is welcome, and a plain solver takes the bare one as before.
  new AvoidanceSolver([{ ...custom, hullClearanceInto() {} }], { links });
  new AvoidanceSolver([custom]);

  class Odd extends SphereVolume {
    segmentClearance() {
      return 1;
    }
  }
  const odd = new AvoidanceSolver([new Odd({ center: [0, 9, 0], radius: 1 })], { links });
  assert.throws(() => odd.solve(root, hand, hand, 1, 1, 0, 0, 1 / 60, elbowAt), /override hullClearanceInto/);
});

test('a flat parallelogram of the difference is not an overlap, whatever the rounding says', () => {
  // A box edge and a segment span an exactly flat parallelogram of the Minkowski difference. On this pose GJK's fourth
  // vertex closed it, the four volume signs were all rounding, and the query read a false contact with the gap at 0.046.
  const half = 0.08,
    box = [];
  for (const x of [-half, half]) for (const y of [-half, half]) for (const z of [-half, half]) box.push(x + 0.5, y, z);
  const c = -0.9840033905007274,
    s = 0.17814973332304776,
    place = [0.5532603470254689, -0.13950151039659978, 0.41050181024055926],
    hull = new ConvexHullVolume({ points: box, matrix: [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, ...place, 1] }),
    start = [-0.21866270992904902, 0.5544222625903785, 0.059496855130419135],
    end = [0.10583414882421494, -0.11072446638718247, 0.6986636039800942];
  // The same gap by brute force: walk the segment in the box's own frame and clamp each point to the box.
  let truth = Infinity;
  for (let i = 0; i <= 20000; i++) {
    const t = i / 20000,
      x = start[0] + (end[0] - start[0]) * t - place[0],
      y = start[1] + (end[1] - start[1]) * t - place[1],
      z = start[2] + (end[2] - start[2]) * t - place[2],
      lx = c * x + s * y,
      ly = -s * x + c * y,
      dx = lx - Math.min(Math.max(lx, 0.5 - half), 0.5 + half),
      dy = ly - Math.min(Math.max(ly, -half), half),
      dz = z - Math.min(Math.max(z, -half), half);
    truth = Math.min(truth, Math.hypot(dx, dy, dz));
  }
  assert.ok(truth > 0.04);
  assert.ok(Math.abs(hull.segmentClearance(start, end, 0) - truth) < 1e-6);
  assert.ok(Math.abs(hull.hullClearance(new ConvexHullVolume({ points: [...start, ...end] })) - truth) < 1e-6);
});
