// Pins Triangle against references written differently from the source: areas by Heron, barycentric weights by
// sub-triangle areas, nearest points by plane projection plus segment minima, and box overlap by vertex, edge and
// box-edge tests. Also pins mathutils.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Matrix4, Triangle, Vector3 } from '../dist/index.js';
import * as mu from '../dist/mathutils.js';

const near = (a, b, e = 1e-10, what = '') => assert.ok(Math.abs(a - b) <= e, `${what} ${a} vs ${b}`);
const v3 = (a) => new Vector3(...a);
const arr = (v) => [v.x, v.y, v.z];
const nearV = (v, a, e = 1e-10) => a.forEach((c, i) => near(arr(v)[i], c, e, 'axis ' + i));
const tri = (a, b, c) => new Triangle(v3(a), v3(b), v3(c));
const sub = (p, q) => p.map((x, i) => x - q[i]);
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const len = (p) => Math.hypot(...p);
const A = [1, 0, 0],
  B = [0, 2, 0],
  C = [0, 0, 3];

test('Triangle: set, positions, copy, clone, equals, area, midpoint, normal, plane', () => {
  const t = tri(A, B, C);
  assert.deepEqual([arr(t.a), arr(t.b), arr(t.c)], [A, B, C]);
  const d = new Triangle();
  assert.deepEqual(arr(d.b), [0, 0, 0]);
  const p = new Triangle().setFromPositions([9, 9, 9, ...A, ...B, ...C], 1, 2, 3);
  assert.deepEqual([arr(p.a), arr(p.b), arr(p.c)], [A, B, C]);
  const q = new Triangle().setFromPositions([...C, ...B, ...A], 2, 1, 0);
  assert.deepEqual([arr(q.a), arr(q.b), arr(q.c)], [A, B, C]);
  assert.ok(t.clone() instanceof Triangle);
  assert.equal(t.clone().equals(t), true);
  assert.equal(new Triangle().copy(t).equals(t), true);
  assert.equal(t.equals(tri(A, B, [0, 0, 4])), false);
  assert.equal(t.equals(tri(A, [0, 3, 0], C)), false);
  assert.equal(t.equals(tri([2, 0, 0], B, C)), false);
  assert.equal(t.equals(tri([1, 0, 0.5], B, [0, 0, 3.5]), 0.5), true);
  assert.equal(t.equals(tri([1, 0, 0.5], B, [0, 0, 3.5]), 0.4), false);
  const ab = sub(B, A),
    ac = sub(C, A);
  near(t.getArea(), len(cross(ab, ac)) / 2);
  // Heron
  const [s1, s2, s3] = [len(sub(B, A)), len(sub(C, B)), len(sub(A, C))];
  const s = (s1 + s2 + s3) / 2;
  near(t.getArea(), Math.sqrt(s * (s - s1) * (s - s2) * (s - s3)));
  assert.equal(tri(A, A, A).getArea(), 0);
  nearV(t.getMidpoint(new Vector3()), [1 / 3, 2 / 3, 1]);
  const n = cross(ab, ac);
  nearV(
    t.getNormal(new Vector3()),
    n.map((x) => x / len(n)),
  );
  assert.deepEqual(arr(tri(A, A, A).getNormal(new Vector3(9, 9, 9))), [0, 0, 0]);
  const plane = { normal: new Vector3(), constant: 0 };
  assert.equal(t.getPlane(plane), plane);
  nearV(
    plane.normal,
    n.map((x) => x / len(n)),
  );
  near(
    plane.constant,
    -dot(
      n.map((x) => x / len(n)),
      A,
    ),
  );
  assert.equal(tri(A, A, A).getPlane({ normal: new Vector3(), constant: 5 }).constant, -0);
  const m = new Matrix4().makeTranslation(1, 2, 3);
  const moved = t.clone().applyMatrix4(m);
  assert.deepEqual(
    [arr(moved.a), arr(moved.b), arr(moved.c)],
    [
      [2, 2, 3],
      [1, 4, 3],
      [1, 2, 6],
    ],
  );
});

test('Triangle: barycentric weights, containment, interpolation and facing', () => {
  const t = tri(A, B, C);
  for (const w of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0.2, 0.3, 0.5],
    [-0.5, 0.75, 0.75],
    [0.5, 0.5, 0],
    [1.5, -0.25, -0.25],
  ]) {
    const p = [0, 1, 2].map((i) => A[i] * w[0] + B[i] * w[1] + C[i] * w[2]);
    nearV(t.getBarycoord(v3(p), new Vector3()), w);
    assert.equal(
      t.containsPoint(v3(p)),
      w.every((x) => x >= 0),
      w.join(),
    );
  }
  // a point off the plane takes the weights of its projection
  const mid = [0.2, 0.3, 0.5].map((_, i) => 0.2 * A[i] + 0.3 * B[i] + 0.5 * C[i]);
  const nrm = cross(sub(B, A), sub(C, A)).map((x) => x / len(cross(sub(B, A), sub(C, A))));
  nearV(t.getBarycoord(v3(mid.map((x, i) => x + nrm[i] * 5)), new Vector3()), [0.2, 0.3, 0.5]);
  assert.equal(t.containsPoint(v3(mid.map((x, i) => x + nrm[i] * 5))), true);
  // epsilon lets a slightly negative weight pass
  const edgeOut = [0.5, 0.5, 0].map((_, i) => 0.55 * A[i] + 0.55 * B[i] - 0.1 * C[i]);
  assert.equal(t.containsPoint(v3(edgeOut)), false);
  assert.equal(t.containsPoint(v3(edgeOut), 0.11), true);
  assert.equal(t.containsPoint(v3(edgeOut), 0.05), false);
  const left = new Vector3(7, 7, 7);
  assert.equal(tri(A, A, B).getBarycoord(v3(A), left), null);
  assert.deepEqual(arr(left), [7, 7, 7]);
  assert.equal(tri(A, A, B).containsPoint(v3(A)), false);
  assert.equal(tri([0, 0, 0], [1, 0, 0], [2, 0, 0]).getBarycoord(v3([1, 0, 0]), new Vector3()), null);
  const va = { x: 1, y: 2, z: 3 },
    vb = { x: 4, y: 6, z: 8 },
    vc = { x: -1, y: 0, z: 5 };
  const w = [0.2, 0.3, 0.5];
  const out = tri(A, B, C).getInterpolation(v3(mid), va, vb, vc, new Vector3());
  nearV(out, [
    va.x * w[0] + vb.x * w[1] + vc.x * w[2],
    va.y * w[0] + vb.y * w[1] + vc.y * w[2],
    va.z * w[0] + vb.z * w[1] + vc.z * w[2],
  ]);
  assert.equal(tri(A, A, B).getInterpolation(v3(A), va, vb, vc, new Vector3()), null);
  const ccw = tri([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  assert.equal(ccw.isFrontFacing(v3([0, 0, -1])), true);
  assert.equal(ccw.isFrontFacing(v3([0, 0, 1])), false);
  assert.equal(ccw.isFrontFacing(v3([1, 0, 0])), false);
  assert.equal(tri(A, A, A).isFrontFacing(v3([0, 0, -1])), false);
});

const pointSegment = (p, c, d) => {
  const dx = sub(d, c),
    l2 = dot(dx, dx);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(dx, sub(p, c)) / l2));
  const q = c.map((x, i) => x + dx[i] * t);
  return q;
};
const refClosest = (p, a, b, c) => {
  const n = cross(sub(b, a), sub(c, a));
  const nn = dot(n, n);
  if (nn > 1e-12) {
    const proj = p.map((x, i) => x - (n[i] * dot(n, sub(p, a))) / nn);
    const inside = [
      [a, b],
      [b, c],
      [c, a],
    ].every(([u, w]) => dot(cross(sub(w, u), sub(proj, u)), n) >= 0);
    if (inside) return proj;
  }
  let best = null,
    bd = Infinity;
  for (const [u, w] of [
    [a, b],
    [b, c],
    [c, a],
  ]) {
    const q = pointSegment(p, u, w);
    const d = len(sub(q, p));
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
};

test('Triangle: closest point and distance match plane-projection-plus-segments, degenerate cases included', () => {
  const rand = mu.createLcgRandom(31337);
  const pt = (k) => [rand() * k - k / 2, rand() * k - k / 2, rand() * k - k / 2];
  for (let i = 0; i < 3000; i++) {
    const [a, b, c, p] = [pt(6), pt(6), pt(6), pt(12)];
    const t = tri(a, b, c);
    const want = refClosest(p, a, b, c);
    nearV(t.closestPointToPoint(v3(p), new Vector3()), want, 1e-9);
    near(t.distanceToPoint(v3(p)), len(sub(want, p)), 1e-9);
  }
  // a point outside each vertex and edge region, and inside
  const t = tri([0, 0, 0], [4, 0, 0], [0, 4, 0]);
  const cases = [
    [1, 1, 3],
    [-2, -2, 0],
    [6, -1, 1],
    [-1, 6, 0],
    [3, 3, 2],
    [2, -3, 0],
    [-3, 2, 1],
    [3, 2, -1],
    [1, 1, 0],
  ];
  for (const p of cases)
    nearV(t.closestPointToPoint(v3(p), new Vector3()), refClosest(p, [0, 0, 0], [4, 0, 0], [0, 4, 0]), 1e-12);
  // collapsed to a segment or a point
  nearV(tri([0, 0, 0], [4, 0, 0], [2, 0, 0]).closestPointToPoint(v3([5, 1, 0]), new Vector3()), [4, 0, 0]);
  nearV(tri([0, 0, 0], [0, 0, 0], [4, 0, 0]).closestPointToPoint(v3([2, 1, 0]), new Vector3()), [2, 0, 0]);
  nearV(tri([4, 0, 0], [0, 0, 0], [0, 0, 0]).closestPointToPoint(v3([-2, 1, 0]), new Vector3()), [0, 0, 0]);
  nearV(tri([1, 1, 1], [1, 1, 1], [1, 1, 1]).closestPointToPoint(v3([5, 5, 5]), new Vector3()), [1, 1, 1]);
  nearV(tri([0, 0, 0], [0, 4, 0], [0, 0, 0]).closestPointToPoint(v3([1, 2, 0]), new Vector3()), [0, 2, 0]);
});

const segBox = (p, q, lo, hi) => {
  let t0 = 0,
    t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = q[i] - p[i];
    if (d === 0) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
      continue;
    }
    const a = (lo[i] - p[i]) / d,
      b = (hi[i] - p[i]) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1;
};
const segTri = (p, q, a, b, c) => {
  const n = cross(sub(b, a), sub(c, a));
  const dp = dot(n, sub(p, a)),
    dq = dot(n, sub(q, a));
  if ((dp > 0 && dq > 0) || (dp < 0 && dq < 0) || dp === dq) return false;
  const t = dp / (dp - dq);
  const x = p.map((v, i) => v + (q[i] - v) * t);
  return [
    [a, b],
    [b, c],
    [c, a],
  ].every(([u, w]) => dot(cross(sub(w, u), sub(x, u)), n) >= 0);
};
const refBoxTri = (a, b, c, lo, hi) => {
  const inside = (p) => p.every((x, i) => x >= lo[i] && x <= hi[i]);
  if ([a, b, c].some(inside)) return true;
  if (
    [
      [a, b],
      [b, c],
      [c, a],
    ].some(([u, w]) => segBox(u, w, lo, hi))
  )
    return true;
  const cs = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) cs.push([x, y, z]);
  const edges = [];
  for (let i = 0; i < 8; i++)
    for (let j = i + 1; j < 8; j++) if (((i ^ j) & ((i ^ j) - 1)) === 0) edges.push([cs[i], cs[j]]);
  return edges.some(([u, w]) => segTri(u, w, a, b, c));
};

test('Triangle.intersectsBox matches a vertex, edge and box-edge reference', () => {
  const rand = mu.createLcgRandom(2024);
  let yes = 0,
    no = 0;
  for (let i = 0; i < 4000; i++) {
    const pt = (k) => [rand() * k - k / 2, rand() * k - k / 2, rand() * k - k / 2];
    const a = pt(8),
      b = pt(8),
      c = pt(8);
    const lo = pt(6),
      size = [rand() * 3, rand() * 3, rand() * 3];
    const hi = lo.map((x, k) => x + size[k]);
    const want = refBoxTri(a, b, c, lo, hi);
    const got = tri(a, b, c).intersectsBox(new Box3(v3(lo), v3(hi)));
    assert.equal(got, want, `case ${i}`);
    if (want) yes++;
    else no++;
  }
  assert.ok(yes > 300 && no > 300, `${yes} yes ${no} no`);
  const big = new Box3(v3([-1, -1, -1]), v3([1, 1, 1]));
  assert.equal(tri([-5, -5, 0.5], [5, -5, 0.5], [0, 8, 0.5]).intersectsBox(big), true);
  assert.equal(tri([-5, -5, 1.5], [5, -5, 1.5], [0, 8, 1.5]).intersectsBox(big), false);
  assert.equal(tri([-5, -5, 1], [5, -5, 1], [0, 8, 1]).intersectsBox(big), true);
  assert.equal(tri([0, 0, 0], [0.5, 0, 0], [0, 0.5, 0]).intersectsBox(big), true);
  assert.equal(tri([0, 0, 0], [0.5, 0, 0], [0, 0.5, 0]).intersectsBox(new Box3()), false);
  assert.equal(tri([2, 0, 0], [3, 0, 0], [2, 1, 0]).intersectsBox(big), false);
  assert.equal(tri([0, 2, 0], [0, 3, 0], [1, 2, 0]).intersectsBox(big), false);
  assert.equal(tri([0, 0, 2], [0, 1, 2], [1, 0, 2]).intersectsBox(big), false);
  // edge-edge separation: a thin diagonal triangle passing a box edge
  assert.equal(tri([2, 0, 1.2], [0, 2, 1.2], [1, 1, 3]).intersectsBox(big), false);
  assert.equal(tri([2, 0, 0.9], [0, 2, 0.9], [1.2, 1.2, 3]).intersectsBox(big), true);
});

test('mathutils: clamp, lerp, ranges, easing, modulo, powers of two', () => {
  assert.equal(mu.clamp(5, 0, 3), 3);
  assert.equal(mu.clamp(-5, 0, 3), 0);
  assert.equal(mu.clamp(2, 0, 3), 2);
  assert.ok(Number.isNaN(mu.clamp(NaN, 0, 3)));
  assert.equal(mu.lerp(2, 10, 0.25), 4);
  assert.equal(mu.lerp(2, 10, 2), 18);
  assert.equal(mu.inverseLerp(2, 10, 6), 0.5);
  assert.equal(mu.inverseLerp(3, 3, 9), 0);
  assert.equal(mu.inverseLerp(10, 2, 6), 0.5);
  assert.equal(mu.mapLinear(5, 0, 10, 100, 200), 150);
  assert.equal(mu.mapLinear(5, 10, 0, 100, 200), 150);
  assert.equal(mu.mapLinear(0, 0, 10, 100, 300), 100);
  near(mu.damp(0, 10, 2, 0.5), 10 * (1 - Math.exp(-1)));
  assert.equal(mu.damp(0, 10, 2, 0), 0);
  assert.equal(mu.smoothstep(0, 1, 3), 0);
  assert.equal(mu.smoothstep(1, 1, 3), 0);
  assert.equal(mu.smoothstep(3, 1, 3), 1);
  assert.equal(mu.smoothstep(9, 1, 3), 1);
  assert.equal(mu.smoothstep(2, 1, 3), 0.5);
  near(mu.smoothstep(1.5, 1, 3), 3 * 0.0625 - 2 * 0.015625);
  assert.equal(mu.smootherstep(0, 1, 3), 0);
  assert.equal(mu.smootherstep(1, 1, 3), 0);
  assert.equal(mu.smootherstep(3, 1, 3), 1);
  assert.equal(mu.smootherstep(9, 1, 3), 1);
  assert.equal(mu.smootherstep(2, 1, 3), 0.5);
  near(mu.smootherstep(1.5, 1, 3), 6 * 0.25 ** 5 - 15 * 0.25 ** 4 + 10 * 0.25 ** 3);
  near(mu.degToRad(180), Math.PI);
  near(mu.radToDeg(Math.PI / 2), 90);
  near(mu.DEG2RAD * 90, Math.PI / 2);
  near(mu.RAD2DEG * Math.PI, 180);
  assert.equal(mu.euclideanModulo(-1, 5), 4);
  assert.equal(mu.euclideanModulo(7, 5), 2);
  assert.equal(mu.euclideanModulo(-10, 5) + 0, 0);
  for (const [v, want] of [
    [1, true],
    [2, true],
    [1024, true],
    [2 ** 50, true],
    [3, false],
    [0, false],
    [-4, false],
    [1.5, false],
    [2 ** 50 + 1, false],
    [6, false],
  ])
    assert.equal(mu.isPowerOfTwo(v), want, String(v));
  for (const [v, c, f] of [
    [1, 1, 1],
    [3, 4, 2],
    [4, 4, 4],
    [5, 8, 4],
    [1000, 1024, 512],
    [2 ** 50 + 1, 2 ** 51, 2 ** 50],
    [2 ** 50, 2 ** 50, 2 ** 50],
    [0.3, 0.5, 0.25],
    [0.5, 0.5, 0.5],
  ]) {
    assert.equal(mu.ceilPowerOfTwo(v), c, 'ceil ' + v);
    assert.equal(mu.floorPowerOfTwo(v), f, 'floor ' + v);
  }
});

test('mathutils: seeded generators are fixed sequences, ranges hold', () => {
  const r = mu.createRandom(7);
  const first = [r(), r(), r()];
  const again = mu.createRandom(7);
  assert.deepEqual([again(), again(), again()], first);
  assert.ok(first.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual([mu.createRandom(8)()], [first[0]]);
  assert.equal(mu.createRandom(1.7)(), mu.createRandom(1)());
  assert.equal(mu.createRandom(NaN)(), mu.createRandom(0)());
  assert.equal(mu.createRandom()(), mu.createRandom(0)());
  near(first[0], 0.011704753153026104, 1e-15);
  const l = mu.createLcgRandom(1);
  assert.equal(l(), (1664525 * 1 + 1013904223) / 4294967296);
  assert.equal(mu.createLcgRandom(-1)(), mu.createLcgRandom(4294967295)());
  const s1 = mu.seededRandom(7);
  assert.equal(s1, first[0]);
  assert.equal(mu.seededRandom(), first[1]);
  assert.equal(mu.seededRandom(7), first[0]);
  assert.equal(
    mu.randFloat(2, 4, () => 0.25),
    2.5,
  );
  assert.equal(
    mu.randFloat(2, 4, () => 0),
    2,
  );
  assert.equal(
    mu.randInt(3, 7, () => 0),
    3,
  );
  assert.equal(
    mu.randInt(3, 7, () => 0.9999),
    7,
  );
  assert.equal(
    mu.randInt(3, 7, () => 0.5),
    5,
  );
  assert.equal(
    mu.randFloatSpread(10, () => 0.25),
    2.5,
  );
  assert.equal(
    mu.randFloatSpread(10, () => 0.5),
    0,
  );
  const m = Math.random;
  Math.random = () => 0.75;
  try {
    assert.equal(mu.randFloat(0, 4), 3);
    assert.equal(mu.randInt(0, 3), 3);
    assert.equal(mu.randFloatSpread(8), -2);
  } finally {
    Math.random = m;
  }
});

test('Triangle: area, centroid, interpolation and facing with generic coordinates', () => {
  const a = [1, 2, 3],
    b = [4, -1, 2],
    c = [-2, 5, 7];
  const t = tri(a, b, c);
  const n = cross(sub(b, a), sub(c, a));
  near(t.getArea(), len(n) / 2);
  near(t.getArea(), 0.5 * Math.hypot(-3 * 4 - -1 * 3, -1 * -3 - 3 * 4, 3 * 3 - -3 * 3 - 0) * 0 + len(n) / 2);
  nearV(t.getMidpoint(new Vector3()), [1, 2, 4]);
  const va = { x: 1, y: 2, z: 3 },
    vb = { x: -4, y: 6, z: 8 },
    vc = { x: 5, y: -7, z: 9 };
  const w = [0.2, 0.3, 0.5];
  const p = [0, 1, 2].map((i) => a[i] * w[0] + b[i] * w[1] + c[i] * w[2]);
  nearV(t.getInterpolation(v3(p), va, vb, vc, new Vector3()), [
    va.x * w[0] + vb.x * w[1] + vc.x * w[2],
    va.y * w[0] + vb.y * w[1] + vc.y * w[2],
    va.z * w[0] + vb.z * w[1] + vc.z * w[2],
  ]);
  const nn = n.map((x) => x / len(n));
  const dir = (k) => v3(nn.map((x, i) => -x * k + [0.3, -0.2, 0.1][i] * 0));
  assert.equal(t.isFrontFacing(dir(1)), true);
  assert.equal(t.isFrontFacing(dir(-1)), false);
  const slanted = v3(nn.map((x, i) => -x + [0.3, -0.5, 0.2][i]));
  assert.equal(t.isFrontFacing(slanted), dot(nn, arr(slanted)) < 0);
  for (const d of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [-1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
    [1, 2, 3],
    [-3, 2, -1],
  ])
    assert.equal(t.isFrontFacing(v3(d)), dot(nn, d) < 0, d.join());
});

test('Triangle.intersectsBox treats a point box as a box and a box empty on one axis as empty', () => {
  const t = tri([-1, -1, 0], [2, -1, 0], [0, 2, 0]);
  const point = new Box3(v3([0, 0, 0]), v3([0, 0, 0]));
  assert.equal(t.intersectsBox(point), true);
  assert.equal(t.intersectsBox(new Box3(v3([0, 0, 1]), v3([0, 0, 1]))), false);
  for (const [lo, hi] of [
    [
      [1, 0, -1],
      [0, 1, 1],
    ],
    [
      [0, 1, -1],
      [1, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 1, 0],
    ],
  ])
    assert.equal(t.intersectsBox(new Box3(v3(lo), v3(hi))), false, lo.join() + '|' + hi.join());
  assert.equal(t.intersectsBox(new Box3(v3([-3, -3, -3]), v3([3, 3, 3]))), true);
});

test('smoothstep and smootherstep of a zero-width range are 0 at the edge', () => {
  assert.equal(mu.smoothstep(5, 5, 5), 0);
  assert.equal(mu.smootherstep(5, 5, 5), 0);
});
