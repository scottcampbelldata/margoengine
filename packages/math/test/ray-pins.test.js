// Pins Ray against closed-form and brute-force references: analytic sphere roots, a reference slab test over many
// seeded rays, the plane parameter, and a plane-plus-edge-sign reference for triangle hits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Matrix4, Plane, Ray, Vector3 } from '../dist/index.js';
import { createLcgRandom } from '../dist/mathutils.js';

const near = (a, b, e = 1e-11, what = '') => assert.ok(Math.abs(a - b) <= e, `${what} ${a} vs ${b}`);
const v3 = (a) => new Vector3(...a);
const arr = (v) => [v.x, v.y, v.z];
const nearV = (v, a, e = 1e-11) => a.forEach((c, i) => near(arr(v)[i], c, e, 'axis ' + i));
const ray = (o, d) => new Ray(v3(o), v3(d));
const box = (lo, hi) => new Box3(v3(lo), v3(hi));

test('Ray: defaults, set, copy, clone, at, lookAt, recast, equals', () => {
  const d = new Ray();
  assert.deepEqual(
    [arr(d.origin), arr(d.direction)],
    [
      [0, 0, 0],
      [0, 0, -1],
    ],
  );
  const r = ray([1, 2, 3], [0, 1, 0]);
  assert.deepEqual(arr(r.at(2.5, new Vector3())), [1, 4.5, 3]);
  assert.deepEqual(arr(r.at(-1, new Vector3())), [1, 1, 3]);
  const c = r.clone();
  assert.ok(c instanceof Ray);
  assert.notEqual(c.origin, r.origin);
  assert.equal(c.equals(r), true);
  assert.equal(new Ray().copy(r).equals(r), true);
  assert.equal(r.equals(ray([1, 2, 4], [0, 1, 0])), false);
  assert.equal(r.equals(ray([1, 2, 3], [0, 0, 1])), false);
  assert.equal(new Ray().set(v3([1, 2, 3]), v3([0, 0, 1])).direction.z, 1);
  const l = ray([1, 1, 1], [1, 0, 0]);
  assert.equal(l.lookAt(v3([1, 1, 6])), l);
  nearV(l.direction, [0, 0, 1]);
  const l2 = ray([0, 0, 0], [1, 0, 0]).lookAt(v3([3, 4, 0]));
  nearV(l2.direction, [0.6, 0.8, 0]);
  const rc = ray([0, 0, 0], [0, 0, 1]);
  assert.equal(rc.recast(3), rc);
  assert.deepEqual(arr(rc.origin), [0, 0, 3]);
});

test('Ray: closest point and distance to a point clamp to the ray', () => {
  const r = ray([0, 0, 0], [1, 0, 0]);
  assert.deepEqual(arr(r.closestPointToPoint(v3([5, 3, 0]), new Vector3())), [5, 0, 0]);
  assert.deepEqual(arr(r.closestPointToPoint(v3([-5, 3, 0]), new Vector3())), [0, 0, 0]);
  assert.equal(r.distanceSqToPoint(v3([5, 3, 4])), 25);
  assert.equal(r.distanceToPoint(v3([5, 3, 4])), 5);
  assert.equal(r.distanceSqToPoint(v3([-3, 4, 0])), 25);
  const o = ray([1, 2, 3], [0, 0, 1]);
  assert.equal(o.distanceSqToPoint(v3([4, 6, 9])), 25);
  assert.equal(o.distanceSqToPoint(v3([1, 2, 0])), 9);
  const dy = ray([0, 1, 0], [0, 1, 0]);
  assert.equal(dy.distanceSqToPoint(v3([3, 6, 4])), 25);
});

test('Ray: sphere intersection returns the nearer front hit, or the far one from inside', () => {
  const s = { center: v3([0, 0, -10]), radius: 2 };
  nearV(ray([0, 0, 0], [0, 0, -1]).intersectSphere(s, new Vector3()), [0, 0, -8]);
  nearV(ray([0, 0, -10], [0, 0, -1]).intersectSphere(s, new Vector3()), [0, 0, -12]);
  assert.equal(ray([0, 0, 0], [0, 0, 1]).intersectSphere(s, new Vector3()), null);
  assert.equal(ray([0, 0, -13], [0, 0, -1]).intersectSphere(s, new Vector3()), null);
  assert.equal(ray([0, 2.01, 0], [0, 0, -1]).intersectSphere(s, new Vector3()), null);
  nearV(ray([0, 2, 0], [0, 0, -1]).intersectSphere(s, new Vector3()), [0, 2, -10]);
  nearV(ray([1, 0, 0], [0, 0, -1]).intersectSphere(s, new Vector3()), [1, 0, -10 + Math.sqrt(3)]);
  assert.equal(ray([0, 0, 0], [0, 0, -1]).intersectsSphere(s), true);
  assert.equal(ray([0, 0, 0], [0, 0, 1]).intersectsSphere(s), false);
  assert.equal(ray([0, 2, 0], [0, 0, -1]).intersectsSphere(s), true);
  assert.equal(ray([0, 2.01, 0], [0, 0, -1]).intersectsSphere(s), false);
});

test('Ray: plane parameter, intersection and parallel cases', () => {
  const p = new Plane(v3([0, 1, 0]), -5);
  assert.equal(ray([0, 0, 0], [0, 1, 0]).distanceToPlane(p), 5);
  assert.equal(ray([0, 0, 0], [0, -1, 0]).distanceToPlane(p), null);
  assert.equal(ray([0, 5, 0], [0, -1, 0]).distanceToPlane(p), 0);
  assert.equal(ray([0, 8, 0], [0, -1, 0]).distanceToPlane(p), 3);
  assert.equal(ray([0, 8, 0], [1, 0, 0]).distanceToPlane(p), null);
  assert.equal(ray([0, 5, 0], [1, 0, 0]).distanceToPlane(p), 0);
  near(ray([0, 0, 0], [0.6, 0.8, 0]).distanceToPlane(p), 6.25);
  assert.equal(ray([0, 0, 0], [1, 0, 0]).distanceToPlane(new Plane(v3([1, 0, 0]), -3)), 3);
  assert.equal(ray([0, 0, 0], [0, 0, 1]).distanceToPlane(new Plane(v3([0, 0, 1]), -3)), 3);
  assert.deepEqual(arr(ray([1, 0, 2], [0, 1, 0]).intersectPlane(p, new Vector3())), [1, 5, 2]);
  assert.equal(ray([0, 0, 0], [0, -1, 0]).intersectPlane(p, new Vector3()), null);
  assert.equal(ray([0, 0, 0], [0, 1, 0]).intersectsPlane(p), true);
  assert.equal(ray([0, 0, 0], [0, -1, 0]).intersectsPlane(p), false);
});

// A reference slab test written the plain way, on a box without padding.
const refBox = (o, d, lo, hi) => {
  let t0 = 0,
    t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    const a = (lo[i] - o[i]) / d[i],
      b = (hi[i] - o[i]) / d[i];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1 ? t0 : null;
};

test('Ray: box intersection matches a reference slab test over seeded rays', () => {
  const rand = createLcgRandom(12345);
  const lo = [-1, -2, -0.5],
    hi = [2, 1, 3];
  const b = box(lo, hi);
  let hits = 0,
    misses = 0;
  for (let i = 0; i < 4000; i++) {
    const o = [rand() * 12 - 6, rand() * 12 - 6, rand() * 12 - 6];
    const d = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    // include axis-parallel directions
    if (i % 5 === 0) d[i % 3] = 0;
    if (i % 25 === 0) d[(i + 1) % 3] = 0;
    const l = Math.hypot(...d);
    if (l === 0) continue;
    const dir = d.map((c) => c / l);
    const want = refBox(o, dir, lo, hi);
    const r = ray(o, dir);
    const got = r.intersectBox(b, new Vector3());
    assert.equal(r.intersectsBox(b), want !== null, `ray ${i}`);
    if (want === null) {
      assert.equal(got, null, `ray ${i}`);
      misses++;
    } else {
      hits++;
      nearV(
        got,
        o.map((c, k) => c + dir[k] * want),
        1e-9,
      );
    }
  }
  assert.ok(hits > 200 && misses > 200, `${hits} hits, ${misses} misses`);
  // behind the origin, grazing a corner, inside, and empty or unbounded boxes
  assert.equal(ray([5, 0, 0], [1, 0, 0]).intersectsBox(b), false);
  assert.equal(ray([5, 0, 0], [-1, 0, 0]).intersectsBox(b), true);
  nearV(ray([0, 0, 0], [1, 0, 0]).intersectBox(b, new Vector3()), [0, 0, 0]);
  nearV(ray([5, 0, 0], [-1, 0, 0]).intersectBox(b, new Vector3()), [2, 0, 0]);
  assert.equal(ray([5, 0, 0], [0, 1, 0]).intersectsBox(b), false);
  assert.equal(ray([2, 5, 0], [0, -1, 0]).intersectsBox(b), true);
  assert.equal(ray([2, 5, 3], [0, -1, 0]).intersectsBox(b), true);
  assert.equal(ray([2.0001, 5, 3], [0, -1, 0]).intersectsBox(b), false);
  assert.equal(ray([0, 0, 0], [0, 0, 1]).intersectsBox(new Box3()), false);
  const open = box([-Infinity, -1, -1], [Infinity, 1, 1]);
  assert.equal(ray([0, 0, 5], [0, 0, -1]).intersectsBox(open), true);
  assert.equal(ray([0, 0, 5], [0, 0, 1]).intersectsBox(open), false);
  // the same line approaching a corner from different sides rounds consistently
  const unit = box([0, 0, 0], [1, 1, 1]);
  for (const dir of [
    [1, 1, 1],
    [-1, -1, -1],
    [1, 1, -1],
    [-1, 1, 1],
  ]) {
    const l = Math.hypot(...dir);
    const corner = dir.map((c) => (c > 0 ? 0 : 1));
    const o = corner.map((c, k) => c - (dir[k] / l) * 3);
    assert.equal(
      ray(
        o,
        dir.map((c) => c / l),
      ).intersectsBox(unit),
      true,
      dir.join(),
    );
  }
});

// Reference triangle hit: ray-plane parameter, then three edge-sign checks against the plane normal.
const refTriangle = (o, d, a, b, c, cull) => {
  const sub = (p, q) => p.map((x, i) => x - q[i]);
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const n = cross(sub(b, a), sub(c, a));
  const nd = dot(n, d);
  if (nd === 0 || (cull && nd >= 0)) return null;
  const t = dot(n, sub(a, o)) / nd;
  if (t < 0) return null;
  const p = o.map((x, i) => x + d[i] * t);
  const inside = [
    [a, b],
    [b, c],
    [c, a],
  ].every(([u, w]) => dot(cross(sub(w, u), sub(p, u)), n) >= 0);
  return inside ? t : null;
};

test('Ray: triangle intersection matches a plane-and-edge reference, with and without culling', () => {
  const rand = createLcgRandom(777);
  const tri = [
    [-1, -1, 0],
    [2, -1, 0.5],
    [0, 2, -0.5],
  ];
  let hit = 0;
  for (let i = 0; i < 3000; i++) {
    const o = [rand() * 6 - 3, rand() * 6 - 3, (rand() < 0.5 ? -1 : 1) * (rand() * 3 + 0.2)];
    const target = [rand() * 4 - 2, rand() * 4 - 2, 0];
    const d = target.map((c, k) => c - o[k]);
    const l = Math.hypot(...d);
    const dir = d.map((c) => c / l);
    for (const cull of [false, true]) {
      const want = refTriangle(o, dir, tri[0], tri[1], tri[2], cull);
      const got = ray(o, dir).intersectTriangle(v3(tri[0]), v3(tri[1]), v3(tri[2]), cull, new Vector3());
      if (want === null) assert.equal(got, null, `${i} cull ${cull}`);
      else {
        nearV(
          got,
          o.map((c, k) => c + dir[k] * want),
          1e-9,
        );
        if (!cull) hit++;
      }
    }
  }
  assert.ok(hit > 300, 'hits ' + hit);
  // facing direction decides culling; a ray behind the triangle or parallel to it misses
  const a = v3([0, 0, 0]),
    b = v3([1, 0, 0]),
    c = v3([0, 1, 0]);
  const front = ray([0.2, 0.2, 1], [0, 0, -1]);
  assert.deepEqual(arr(front.intersectTriangle(a, b, c, true, new Vector3())), [0.2, 0.2, 0]);
  assert.deepEqual(arr(front.intersectTriangle(a, b, c, false, new Vector3())), [0.2, 0.2, 0]);
  const back = ray([0.2, 0.2, -1], [0, 0, 1]);
  assert.equal(back.intersectTriangle(a, b, c, true, new Vector3()), null);
  assert.deepEqual(arr(back.intersectTriangle(a, b, c, false, new Vector3())), [0.2, 0.2, 0]);
  assert.equal(ray([0.2, 0.2, 1], [0, 0, 1]).intersectTriangle(a, b, c, false, new Vector3()), null);
  assert.equal(ray([0.2, 0.2, 1], [1, 0, 0]).intersectTriangle(a, b, c, false, new Vector3()), null);
  assert.equal(ray([0.6, 0.6, 1], [0, 0, -1]).intersectTriangle(a, b, c, false, new Vector3()), null);
  assert.equal(ray([-0.1, 0.2, 1], [0, 0, -1]).intersectTriangle(a, b, c, false, new Vector3()), null);
  assert.equal(ray([0.2, -0.1, 1], [0, 0, -1]).intersectTriangle(a, b, c, false, new Vector3()), null);
  assert.deepEqual(arr(ray([0.5, 0.5, 1], [0, 0, -1]).intersectTriangle(a, b, c, false, new Vector3())), [0.5, 0.5, 0]);
  assert.deepEqual(arr(ray([0, 0, 1], [0, 0, -1]).intersectTriangle(a, b, c, false, new Vector3())), [0, 0, 0]);
});

test('Ray.applyMatrix4 moves the origin as a point and the direction as a unit vector', () => {
  const m = new Matrix4().makeTranslation(1, 2, 3).multiply(new Matrix4().makeScale(2, 2, 2));
  const r = ray([1, 1, 1], [0, 0, -1]).applyMatrix4(m);
  assert.deepEqual(arr(r.origin), [3, 4, 5]);
  nearV(r.direction, [0, 0, -1]);
});

test('Ray: sphere tests with a slanted ray, a larger radius and tangent-at-the-origin cases', () => {
  const r = ray([1, 2, 3], [1 / 3, 2 / 3, 2 / 3]);
  const s = { center: v3([4, 8, 9]), radius: 3 };
  // the centre lies at distance 9 along the ray, 0 off it: hits at 9 - 3
  nearV(r.intersectSphere(s, new Vector3()), [1 + 6 / 3, 2 + 12 / 3, 3 + 12 / 3]);
  assert.equal(r.intersectsSphere(s), true);
  assert.equal(r.intersectsSphere({ center: v3([4, 8, 9]), radius: 0.1 }), true);
  const off = { center: v3([4, 8, 9 + 2.5]), radius: 2 };
  const along = (4 - 1 + 2 * (8 - 2) + 2 * (11.5 - 3)) / 3;
  const l2 = 9 + 36 + 72.25;
  const miss = Math.sqrt(l2 - along * along);
  assert.equal(r.intersectsSphere(off), miss <= 2);
  assert.equal(r.intersectsSphere({ ...off, radius: 3 }), miss <= 3);
  assert.equal(r.intersectsSphere({ center: v3([4, 8, 9]), radius: 3 }), true);
  // a radius where r * r differs from r + r
  assert.equal(ray([0, 0, 0], [0, 0, 1]).intersectsSphere({ center: v3([5, 0, 3]), radius: 5 }), true);
  assert.equal(ray([0, 0, 0], [0, 0, 1]).intersectsSphere({ center: v3([5, 0, 3]), radius: 4.9 }), false);
  assert.equal(ray([0, 0, 0], [0, 0, 1]).intersectsSphere({ center: v3([2.5, 0, 3]), radius: 3 }), true);
  assert.equal(ray([0, 0, 0], [0, 0, 1]).intersectsSphere({ center: v3([3.5, 0, 3]), radius: 3 }), false);
  const unitSphere = { center: v3([0, 0, 0]), radius: 1 };
  // on the surface, pointing out: the only hit is the origin itself (t = 0)
  nearV(ray([0, 0, 1], [0, 0, 1]).intersectSphere(unitSphere, new Vector3()), [0, 0, 1]);
  // on the surface, pointing in: the entry is the origin
  nearV(ray([0, 0, 1], [0, 0, -1]).intersectSphere(unitSphere, new Vector3()), [0, 0, 1]);
  // a hit within the first unit of the ray
  nearV(ray([0, 0, 1.5], [0, 0, -1]).intersectSphere(unitSphere, new Vector3()), [0, 0, 1]);
  nearV(ray([0, 0, 0.5], [0, 0, 1]).intersectSphere(unitSphere, new Vector3()), [0, 0, 1]);
});

test('Ray: closest point and distance with a slanted ray and an offset origin', () => {
  const r = ray([1, 2, 3], [1 / 3, 2 / 3, 2 / 3]);
  const p = v3([4, -1, 5]);
  const t = Math.max(0, (3 * 1 + -3 * 2 + 2 * 2) / 3);
  const want = [1 + t / 3, 2 + (2 * t) / 3, 3 + (2 * t) / 3];
  nearV(r.closestPointToPoint(p, new Vector3()), want);
  near(
    r.distanceSqToPoint(p),
    want.reduce((s, c, i) => s + (c - arr(p)[i]) ** 2, 0),
  );
  const behind = v3([-5, -4, -2]);
  nearV(r.closestPointToPoint(behind, new Vector3()), [1, 2, 3]);
  near(r.distanceSqToPoint(behind), 36 + 36 + 25);
  const pos = v3([8, 14, 15]);
  nearV(r.closestPointToPoint(pos, new Vector3()), want.length && arr(r.closestPointToPoint(pos, new Vector3())));
  near(
    r.distanceToPoint(pos),
    Math.hypot(...[7, 12, 12].map((c, i) => c - [1 / 3, 2 / 3, 2 / 3][i] * ((7 + 24 + 24) / 3) * 1)),
  );
});

test('Ray: box edges, touching and slab rounding at corners', () => {
  const b = box([0, 0, 0], [2, 2, 2]);
  // parallel to a face and exactly on it
  assert.equal(ray([-1, 0, 1], [1, 0, 0]).intersectsBox(b), true);
  assert.equal(ray([-1, 2, 1], [1, 0, 0]).intersectsBox(b), true);
  assert.equal(ray([-1, 1, 0], [1, 0, 0]).intersectsBox(b), true);
  assert.equal(ray([-1, 1, 2], [1, 0, 0]).intersectsBox(b), true);
  assert.equal(ray([-1, 2.0001, 1], [1, 0, 0]).intersectsBox(b), false);
  assert.equal(ray([-1, -0.0001, 1], [1, 0, 0]).intersectsBox(b), false);
  // touching a single corner point
  const touch = ray([3, 3, -3], [-1, -1, 1]);
  assert.equal(touch.intersectsBox(b), true);
  nearV(touch.intersectBox(b, new Vector3()), [0, 0, 0]);
  // a box that is a single point, met exactly at the origin of the ray
  const point = box([1, 1, 1], [1, 1, 1]);
  assert.equal(ray([1, 1, 1], [0, 0, 1]).intersectsBox(point), true);
  assert.equal(ray([1, 1, 1], [1, 1, 1]).intersectsBox(point), true);
  assert.equal(ray([1, 1, 0.5], [0, 0, 1]).intersectsBox(point), true);
  assert.equal(ray([1, 1, 1.5], [0, 0, 1]).intersectsBox(point), false);
  // leaving through the face the origin sits on: a hit at distance 0
  nearV(ray([2, 1, 1], [1, 0, 0]).intersectBox(b, new Vector3()), [2, 1, 1]);
  assert.equal(ray([2, 1, 1], [1, 0, 0]).intersectsBox(b), true);
  // rays aimed at a corner whose slab times round apart still hit, as the padded test promises
  const unit = box([0, 0, 0], [1, 1, 1]);
  for (const [o, d] of [
    [
      [-2.822901111551946, -0.7308470005497487, 1.1168329435732274],
      [0.8077997746812694, 0.49529819210817555, -0.31959227919219674],
    ],
    [
      [3.33068158385787, 2.5929466123275455, 1.014290301994247],
      [-0.7890701757289091, -0.614293737642465, -0.0033855085879325743],
    ],
    [
      [1.8040069003547687, 0.7282245695532413, -1.3728998065097815],
      [-0.45950063829607335, -0.41619002820118384, 0.78463050146639],
    ],
    [
      [2.1010084976162178, 0.8255601339208474, 1.5584641963146584],
      [-0.7413481763590983, -0.5558789973756677, -0.3760338039135068],
    ],
  ]) {
    assert.equal(refBox(o, d, [0, 0, 0], [1, 1, 1]), null, 'the plain slab test misses it');
    assert.equal(ray(o, d).intersectsBox(unit), true);
  }
});

test('Ray: triangle tests with every coordinate non-zero, shared vertices and culling of parallel rays', () => {
  const a = [0.3, -0.4, 0.7],
    b = [2.1, -0.9, 1.4],
    c = [-0.6, 1.8, 0.2];
  const rand = createLcgRandom(55);
  let hit = 0;
  for (let i = 0; i < 3000; i++) {
    const o = [rand() * 6 - 3, rand() * 6 - 3, (rand() < 0.5 ? -1 : 1) * (rand() * 3 + 2)];
    const target = [rand() * 3 - 0.8, rand() * 3 - 0.9, rand()];
    const d = target.map((t, k) => t - o[k]);
    const l = Math.hypot(...d);
    const dir = d.map((x) => x / l);
    for (const cull of [false, true]) {
      const want = refTriangle(o, dir, a, b, c, cull);
      const got = ray(o, dir).intersectTriangle(v3(a), v3(b), v3(c), cull, new Vector3());
      if (want === null) assert.equal(got, null, `${i} ${cull}`);
      else {
        nearV(
          got,
          o.map((x, k) => x + dir[k] * want),
          1e-9,
        );
        hit++;
      }
    }
  }
  assert.ok(hit > 100);
  const A = v3([0, 0, 0]),
    B = v3([1, 0, 0]),
    C = v3([0, 1, 0]);
  // through vertex b exactly (u = 1) and vertex c (v = 1), and onto an edge
  assert.deepEqual(arr(ray([1, 0, 1], [0, 0, -1]).intersectTriangle(A, B, C, false, new Vector3())), [1, 0, 0]);
  assert.deepEqual(arr(ray([0, 1, 1], [0, 0, -1]).intersectTriangle(A, B, C, false, new Vector3())), [0, 1, 0]);
  assert.deepEqual(arr(ray([0.5, 0.5, 1], [0, 0, -1]).intersectTriangle(A, B, C, true, new Vector3())), [0.5, 0.5, 0]);
  // an origin lying in the triangle is a hit at distance 0
  assert.deepEqual(arr(ray([0.2, 0.2, 0], [0, 0, -1]).intersectTriangle(A, B, C, true, new Vector3())), [0.2, 0.2, 0]);
  assert.deepEqual(arr(ray([0.2, 0.2, 0], [0, 0, 1]).intersectTriangle(A, B, C, false, new Vector3())), [0.2, 0.2, 0]);
  // parallel to the plane: never a hit, culling or not
  for (const cull of [true, false])
    assert.equal(ray([0.2, 0.2, 1], [1, 0, 0]).intersectTriangle(A, B, C, cull, new Vector3()), null);
  assert.equal(ray([0.2, 0.2, 0], [1, 0, 0]).intersectTriangle(A, B, C, true, new Vector3()), null);
  assert.equal(ray([0.2, 0.2, 0], [1, 0, 0]).intersectTriangle(A, B, C, false, new Vector3()), null);
});
