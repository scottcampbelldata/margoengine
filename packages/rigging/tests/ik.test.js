import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addIKChain, elbowEvaluator, rotationBetween, solveFABRIK, solvePoseIK, solveSkeletonIK } from '../dist/ik.js';
import { Skeleton } from '../../animation/dist/index.js';
import { AvoidanceSolver, CapsuleVolume, SolveStatus } from '../../kinematics-constraints/dist/index.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const point = (points, i) => Array.from(points.subarray(i * 3, i * 3 + 3));
/** A chain standing up the y axis with the given bone lengths. */
const straight = (lengths) => {
  const points = new Float64Array((lengths.length + 1) * 3);
  lengths.forEach((l, i) => (points[(i + 1) * 3 + 1] = points[i * 3 + 1] + l));
  return points;
};
/** A random pose of the same chain, and its end point: a target the chain can reach. */
const reachable = (next, lengths) => {
  const points = new Float64Array((lengths.length + 1) * 3);
  lengths.forEach((l, i) => {
    const d = [next() * 2 - 1, next() * 2 - 1, next() * 2 - 1],
      n = Math.hypot(...d) || 1;
    for (let c = 0; c < 3; c++) points[(i + 1) * 3 + c] = points[i * 3 + c] + (d[c] / n) * l;
  });
  return point(points, lengths.length);
};

test('FABRIK reaches reachable targets within tolerance and keeps every bone length', () => {
  const next = random(2011),
    iterations = [];
  for (const joints of [2, 3, 4, 6, 10]) {
    for (let trial = 0; trial < 40; trial++) {
      const lengths = Array.from({ length: joints }, () => 0.3 + 0.7 * next()),
        target = reachable(next, lengths),
        points = straight(lengths),
        result = solveFABRIK(points, target, { iterations: 200, tolerance: 1e-4 });
      assert.ok(result.reached, `${joints} joints: stopped ${result.distance} away`);
      assert.ok(distance(point(points, joints), target) <= 1e-4);
      lengths.forEach((l, i) => assert.ok(Math.abs(distance(point(points, i), point(points, i + 1)) - l) < 1e-9));
      assert.deepEqual(point(points, 0), [0, 0, 0], 'the root stays put');
      iterations.push(result.iterations);
    }
  }
  iterations.sort((a, b) => a - b);
  assert.ok(iterations[Math.floor(iterations.length / 2)] <= 32, `median iterations ${iterations[100]}`);
});

test('FABRIK straightens toward an unreachable target', () => {
  const points = straight([1, 1]),
    result = solveFABRIK(points, [3, 4, 0]);
  assert.equal(result.reached, false);
  assert.ok(Math.abs(result.distance - 3) < 1e-9);
  assert.ok(distance(point(points, 2), [1.2, 1.6, 0]) < 1e-9);
});

test('the pole picks the bend side', () => {
  for (const side of [1, -1]) {
    const points = straight([1, 1]),
      result = solveFABRIK(points, [0, 1.2, 0.3], { pole: [0, 1, side * 5] });
    assert.ok(result.reached);
    // The elbow sits off the root-target line (in the y-z plane) on the pole's side: along n = (0, -0.3, 1.2).
    const elbow = point(points, 1);
    assert.equal(Math.sign(-0.3 * elbow[1] + 1.2 * elbow[2]), side, `side ${side}: elbow ${elbow}`);
  }
  const bent = straight([1, 1]);
  solveFABRIK(bent, [0, 1, 0], { pole: [3, 0.5, 0] });
  assert.ok(point(bent, 1)[0] > 0.8, 'a fold toward +x');
});

test('solvePoseIK turns local rotations so the end reaches the target in a rotated, offset pose', () => {
  const s = Math.sin(0.35),
    c = Math.cos(0.35),
    // root (turned about z, scale 2) -> shoulder -> elbow -> hand, each one unit up its parent's y.
    local = Float64Array.from([
      ...[1, 0, 0, 0, 0, s, c, 2, 2, 2],
      ...[0, 0.5, 0, 0, 0, 0, 1, 1, 1, 1],
      ...[0, 1, 0, 0, 0, 0, 1, 1, 1, 1],
      ...[0, 1, 0, 0, 0, 0, 1, 1, 1, 1],
    ]),
    parents = [-1, 0, 1, 2],
    target = [1.5, 2.5, 1.2],
    result = solvePoseIK({ parents, local }, { joints: [1, 2, 3], target, pole: [3, 2, -2] });
  assert.ok(result.reached, `stopped ${result.distance} away`);
  // Forward kinematics of the written pose.
  let position = [0, 0, 0],
    rotation = [0, 0, 0, 1],
    scale = 1;
  const rotate = (q, v) => {
    const [x, y, z, w] = q,
      t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [
      v[0] + w * t[0] + y * t[2] - z * t[1],
      v[1] + w * t[1] + z * t[0] - x * t[2],
      v[2] + w * t[2] + x * t[1] - y * t[0],
    ];
  };
  const multiply = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  for (let b = 0; b < 4; b++) {
    const l = b * 10,
      o = rotate(rotation, [local[l] * scale, local[l + 1] * scale, local[l + 2] * scale]);
    position = position.map((v, k) => v + o[k]);
    rotation = multiply(rotation, Array.from(local.subarray(l + 3, l + 7)));
    scale *= local[l + 7];
    assert.ok(Math.abs(Math.hypot(...local.subarray(l + 3, l + 7)) - 1) < 1e-9, 'unit rotations');
  }
  assert.ok(distance(position, target) <= 1e-4, `hand at ${position}`);
});

test('solveSkeletonIK poses an animation Skeleton by bone names', () => {
  const skeleton = new Skeleton([
    { name: 'shoulder', parent: -1 },
    { name: 'elbow', parent: 0, translation: [0, 1, 0] },
    { name: 'hand', parent: 1, translation: [0, 1, 0] },
  ]);
  const result = solveSkeletonIK(skeleton, {
    joints: ['shoulder', 'elbow', 'hand'],
    target: [1, 1, 0.5],
    pole: [0, 1, 3],
  });
  assert.ok(result.reached);
  const m = skeleton.matrices;
  assert.ok(distance([m[32 + 12], m[32 + 13], m[32 + 14]], [1, 1, 0.5]) <= 1e-4);
  assert.ok(m[16 + 14] > 0, 'the elbow bends toward the pole (+z)');
});

test('elbowEvaluator places the elbow for AvoidanceSolver and clears a torso', () => {
  const evaluate = elbowEvaluator(0.3, 0.28, [0.2, 1.2, -0.5]),
    out = new Float32Array(3),
    root = [0.2, 1.4, 0],
    target = [0.25, 1.2, 0.4];
  evaluate(root, target, 0, out);
  assert.ok(Math.abs(distance(out, root) - 0.3) < 1e-6);
  assert.ok(Math.abs(distance(out, target) - 0.28) < 1e-6);
  assert.ok(out[2] < 0.2, 'angle 0 bends toward the pole side (-z)');
  evaluate(root, target, Math.PI, out);
  assert.ok(out[2] > 0.1, 'angle π bends away');
  const torso = new CapsuleVolume({ start: [0, 0.9, 0], end: [0, 1.5, 0], radius: 0.18 }),
    solver = new AvoidanceSolver([torso], { minClearance: 0.01, targetRadius: 0.04 }),
    hand = new Float32Array([0.5, 1.2, 0.2]),
    solved = solver.solve(root, hand, [-0.1, 1.2, 0.35], 0.3, 0.28, 0.05, 0.04, 1 / 60, evaluate);
  assert.notEqual(solved.status, SolveStatus.Failed);
  assert.ok(Math.abs(distance(solved.elbow, root) - 0.3) < 1e-4);
  assert.throws(() => elbowEvaluator(0, 1, [0, 0, 0]), RangeError);
});

test('rotationBetween and input checks', () => {
  const q = rotationBetween([1, 0, 0], [0, 2, 0]);
  assert.ok(Math.abs(q[2] - Math.SQRT1_2) < 1e-12 && Math.abs(q[3] - Math.SQRT1_2) < 1e-12);
  const flip = rotationBetween([1, 0, 0], [-1, 0, 0]);
  assert.ok(Math.abs(flip[3]) < 1e-12 && Math.abs(flip[0]) < 1e-12);
  assert.throws(() => rotationBetween([0, 0, 0], [1, 0, 0]), RangeError);
  assert.throws(() => solveFABRIK(new Float64Array(3), [0, 0, 0]), RangeError);
  assert.throws(() => solveFABRIK(new Float64Array(6), [0, 0, 0]), /zero length/);
  assert.throws(() => solveFABRIK(straight([1]), [0, 0, 0], { iterations: 0 }), RangeError);
  assert.throws(
    () => solvePoseIK({ parents: [-1, 0], local: new Float64Array(20) }, { joints: [1, 0], target: [0, 0, 0] }),
    RangeError,
  );
  assert.equal(typeof addIKChain, 'function');
});

test('a chain folded onto its own line still reaches, keeping its lengths', () => {
  const points = straight([1, 1]),
    result = solveFABRIK(points, [0, 1, 0]);
  assert.ok(result.reached, `stopped ${result.distance} away`);
  assert.ok(Math.abs(distance(point(points, 0), point(points, 1)) - 1) < 1e-9);
  assert.ok(Math.abs(distance(point(points, 1), point(points, 2)) - 1) < 1e-9);
});

test('solvePoseIK takes a scale a little off uniform, as exported rigs have, and refuses a mirrored one', () => {
  // Regression: real rigs carry scales such as 0.9995, 1, 0.9986 (Seed-san's hair) and IK refused them.
  const uneven = [0.9995, 1, 0.9986],
    local = Float64Array.from([
      ...[0, 0, 0, 0, 0, 0, 1, ...uneven],
      ...[0, 1, 0, 0, 0, 0, 1, ...uneven],
      ...[0, 1, 0, 0, 0, 0, 1, ...uneven],
      ...[0, 1, 0, 0, 0, 0, 1, 1, 1, 1],
    ]),
    parents = [-1, 0, 1, 2],
    target = [1.1, 1.8, 0.3];
  solvePoseIK({ parents, local }, { joints: [1, 2, 3], target });
  // The last joint through full matrices, the way the engine places it.
  const rotate = (q, v) => {
    const [x, y, z, w] = q,
      t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [
      v[0] + w * t[0] + y * t[2] - z * t[1],
      v[1] + w * t[1] + z * t[0] - x * t[2],
      v[2] + w * t[2] + x * t[1] - y * t[0],
    ];
  };
  let point = [0, 0, 0];
  for (let bone = 3; bone >= 0; bone--) {
    const l = bone * 10,
      scaled = point.map((v, i) => v * local[l + 7 + i]),
      turned = rotate(Array.from(local.subarray(l + 3, l + 7)), scaled);
    point = turned.map((v, i) => v + local[l + i]);
  }
  const gap = Math.hypot(point[0] - target[0], point[1] - target[1], point[2] - target[2]);
  assert.ok(gap < 5e-3, `the hand lands within the 0.14% stretch of two bones: ${gap}`);
  local[17] = -1;
  assert.throws(() => solvePoseIK({ parents, local }, { joints: [1, 2, 3], target }), /positive scales/);
});
