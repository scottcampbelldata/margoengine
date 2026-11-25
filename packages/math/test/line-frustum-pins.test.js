// Pins Line3 against a convex-minimisation reference (ternary search over the first segment) and Frustum against
// clip-space tests of the same view-projection matrix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Frustum, Line3, Matrix4, Plane, Quaternion, Vector3 } from '../dist/index.js';
import { createLcgRandom } from '../dist/mathutils.js';

const near = (a, b, e = 1e-11, what = '') => assert.ok(Math.abs(a - b) <= e, `${what} ${a} vs ${b}`);
const v3 = (a) => new Vector3(...a);
const arr = (v) => [v.x, v.y, v.z];
const nearV = (v, a, e = 1e-11) => a.forEach((c, i) => near(arr(v)[i], c, e, 'axis ' + i));
const line = (a, b) => new Line3(v3(a), v3(b));
const clamp01 = (t) => Math.max(0, Math.min(1, t));

test('Line3: construction, centre, delta, length, at', () => {
  const d = new Line3();
  assert.deepEqual(
    [arr(d.start), arr(d.end)],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
  );
  const l = line([1, 2, 3], [5, 8, 15]);
  assert.deepEqual(arr(l.getCenter(new Vector3())), [3, 5, 9]);
  assert.deepEqual(arr(l.delta(new Vector3())), [4, 6, 12]);
  assert.equal(l.distanceSq(), 16 + 36 + 144);
  near(l.distance(), 14);
  assert.deepEqual(arr(l.at(0.25, new Vector3())), [2, 3.5, 6]);
  assert.deepEqual(arr(l.at(2, new Vector3())), [9, 14, 27]);
  assert.deepEqual(arr(l.at(-1, new Vector3())), [-3, -4, -9]);
  const c = l.clone();
  assert.ok(c instanceof Line3);
  assert.notEqual(c.start, l.start);
  assert.equal(c.equals(l), true);
  assert.equal(new Line3().copy(l).equals(l), true);
  assert.equal(l.equals(line([1, 2, 3], [5, 8, 16])), false);
  assert.equal(l.equals(line([1, 2, 4], [5, 8, 15])), false);
  assert.equal(l.equals(line([1, 2, 3.5], [5, 8, 15.5]), 0.5), true);
  assert.equal(l.equals(line([1, 2, 3.5], [5, 8, 15.5]), 0.4), false);
  assert.equal(new Line3().set(v3([1, 2, 3]), v3([4, 5, 6])).end.z, 6);
  const out = v3([9, 9, 9]);
  l.delta(out);
  assert.deepEqual(arr(out), [4, 6, 12]);
});

test('Line3: closest point and distance to a point', () => {
  const l = line([0, 0, 0], [10, 0, 0]);
  assert.equal(l.closestPointToPointParameter(v3([4, 5, 6])), 0.4);
  assert.equal(l.closestPointToPointParameter(v3([-4, 5, 6])), -0.4);
  assert.equal(l.closestPointToPointParameter(v3([-4, 5, 6]), true), 0);
  assert.equal(l.closestPointToPointParameter(v3([14, 5, 6]), true), 1);
  assert.equal(l.closestPointToPointParameter(v3([14, 5, 6]), false), 1.4);
  assert.deepEqual(arr(l.closestPointToPoint(v3([14, 5, 6]), false, new Vector3())), [14, 0, 0]);
  assert.deepEqual(arr(l.closestPointToPoint(v3([14, 5, 6]), true, new Vector3())), [10, 0, 0]);
  assert.equal(line([1, 1, 1], [1, 1, 1]).closestPointToPointParameter(v3([5, 5, 5])), 0);
  const diag = line([1, 2, 3], [4, 6, 3]);
  near(diag.closestPointToPointParameter(v3([1 + 3, 2 + 4, 3 + 9])), 1);
  near(line([0, 0, 0], [0, 3, 4]).closestPointToPointParameter(v3([0, 0, 5])), 20 / 25);
  near(line([0, 0, 0], [0, 3, 4]).closestPointToPointParameter(v3([7, 3, 0])), 9 / 25);
  assert.equal(l.distanceSqToPoint(v3([4, 3, 4])), 25);
  assert.equal(l.distanceToPoint(v3([4, 3, 4])), 5);
  assert.equal(l.distanceSqToPoint(v3([-3, 4, 0])), 25);
  assert.equal(l.distanceSqToPoint(v3([13, 4, 0])), 25);
  near(line([0, 0, 0], [0, 3, 4]).distanceSqToPoint(v3([7, 3, 0])), 49 + (3 - (9 / 25) * 3) ** 2 + ((9 / 25) * 4) ** 2);
});

const segmentDistanceSq = (a, b) => {
  const pointSeg = (p, c, d) => {
    const dx = d.map((x, i) => x - c[i]),
      l2 = dx.reduce((s, x) => s + x * x, 0);
    const t = l2 === 0 ? 0 : clamp01(dx.reduce((s, x, i) => s + x * (p[i] - c[i]), 0) / l2);
    return dx.reduce((s, x, i) => s + (c[i] + x * t - p[i]) ** 2, 0);
  };
  const f = (s) =>
    pointSeg(
      a[0].map((x, i) => x + (a[1][i] - x) * s),
      b[0],
      b[1],
    );
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 200; i++) {
    const m1 = lo + (hi - lo) / 3,
      m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  return Math.min(f((lo + hi) / 2), f(0), f(1));
};

test('Line3: segment to segment distance matches a minimisation reference, with nearest points', () => {
  const rand = createLcgRandom(4242);
  const pt = () => [rand() * 10 - 5, rand() * 10 - 5, rand() * 10 - 5];
  for (let i = 0; i < 1500; i++) {
    const a = [pt(), pt()],
      b = [pt(), pt()];
    if (i % 7 === 0) b[1] = b[0].slice();
    if (i % 11 === 0) a[1] = a[0].slice();
    if (i % 13 === 0) b[1] = b[0].map((x, k) => x + (a[1][k] - a[0][k]) * 0.7);
    const outThis = new Vector3(),
      outOther = new Vector3();
    const d2 = line(...a).distanceSqToLine3(line(...b), outThis, outOther);
    near(d2, segmentDistanceSq(a, b), 1e-9, 'case ' + i);
    near(outThis.distanceToSquared(outOther), d2, 1e-9, 'witness ' + i);
    near(line(...a).distanceToLine3(line(...b)), Math.sqrt(d2), 1e-12);
    assert.ok(line(...a).distanceToPoint(outThis) < 1e-9, 'witness on first');
    assert.ok(line(...b).distanceToPoint(outOther) < 1e-9, 'witness on second');
  }
  // parallel, overlapping, collinear, crossing and end-point cases
  assert.equal(line([0, 0, 0], [10, 0, 0]).distanceSqToLine3(line([2, 3, 0], [8, 3, 0])), 9);
  assert.equal(line([0, 0, 0], [10, 0, 0]).distanceSqToLine3(line([12, 0, 0], [15, 0, 0])), 4);
  assert.equal(line([0, 0, 0], [10, 0, 0]).distanceSqToLine3(line([5, -1, 1], [5, 1, 1])), 1);
  assert.equal(line([0, 0, 0], [1, 0, 0]).distanceSqToLine3(line([3, 0, 0], [3, 0, 0])), 4);
  assert.equal(line([3, 0, 0], [3, 0, 0]).distanceSqToLine3(line([0, 0, 0], [1, 0, 0])), 4);
  assert.equal(line([1, 1, 1], [1, 1, 1]).distanceSqToLine3(line([1, 1, 4], [1, 1, 4])), 9);
  assert.equal(line([0, 0, 0], [1, 0, 0]).distanceSqToLine3(line([0.5, 5, 0], [0.5, 9, 0])), 25);
  assert.equal(line([0, 0, 0], [1, 0, 0]).distanceSqToLine3(line([5, 1, 0], [5, 9, 0])), 17);
  const only = new Vector3();
  line([0, 0, 0], [10, 0, 0]).distanceSqToLine3(line([5, -1, 1], [5, 1, 1]), only);
  assert.deepEqual(arr(only), [5, 0, 0]);
  const other = new Vector3();
  line([0, 0, 0], [10, 0, 0]).distanceSqToLine3(line([5, -1, 1], [5, 1, 1]), undefined, other);
  assert.deepEqual(arr(other), [5, 0, 1]);
  const m = new Matrix4().makeTranslation(1, 2, 3);
  const moved = line([0, 0, 0], [1, 1, 1]).applyMatrix4(m);
  assert.deepEqual(
    [arr(moved.start), arr(moved.end)],
    [
      [1, 2, 3],
      [2, 3, 4],
    ],
  );
});

const perspective = new Matrix4().makePerspective(-0.5, 0.5, 0.4, -0.4, 1, 50, true);
const view = new Matrix4()
  .compose({ x: 2, y: -1, z: 3 }, new Quaternion(0.1, 0.5, -0.2, 0.8).normalize(), { x: 1, y: 1, z: 1 })
  .invert();
const viewProj = new Matrix4().multiplyMatrices(perspective, view);
const clipInside = (m, p, zeroToOne) => {
  const e = m.elements;
  const x = e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12],
    y = e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13],
    z = e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14],
    w = e[3] * p[0] + e[7] * p[1] + e[11] * p[2] + e[15];
  return [x + w, w - x, y + w, w - y, zeroToOne ? z : z + w, w - z];
};

test('Frustum: planes from a projection match clip-space inequalities, in both depth ranges', () => {
  const rand = createLcgRandom(99);
  for (const zeroToOne of [true, false]) {
    const proj = new Matrix4().makePerspective(-0.5, 0.5, 0.4, -0.4, 1, 50, zeroToOne);
    const vp = new Matrix4().multiplyMatrices(proj, view);
    const f = new Frustum().setFromProjectionMatrix(vp, zeroToOne);
    let inside = 0,
      outside = 0;
    for (let i = 0; i < 4000; i++) {
      const p = [rand() * 40 - 20, rand() * 40 - 20, rand() * 40 - 20];
      const clip = clipInside(vp, p, zeroToOne);
      const want = clip.every((c) => c >= 0);
      assert.equal(f.containsPoint(v3(p)), want, `point ${i}`);
      f.planes.forEach((pl, k) => {
        near(pl.normal.length(), 1, 1e-12, 'unit normal');
        const raw = clip[k];
        const dist = pl.distanceToPoint(v3(p));
        assert.equal(Math.sign(dist) === Math.sign(raw) || Math.abs(raw) < 1e-9, true, `plane ${k} side`);
      });
      if (want) inside++;
      else outside++;
      const s = { center: v3(p), radius: rand() * 3 };
      const sphereWant = f.planes.every((pl) => pl.distanceToPoint(s.center) >= -s.radius);
      assert.equal(f.intersectsSphere(s), sphereWant);
    }
    assert.ok(inside > 50 && outside > 1000, `${inside} in, ${outside} out`);
  }
});

test('Frustum: array layout, defaults, copy and box queries', () => {
  const f = new Frustum().setFromProjectionMatrix(viewProj);
  const flat = f.toArray();
  assert.equal(flat.length, 24);
  f.planes.forEach((p, i) =>
    assert.deepEqual(flat.slice(i * 4, i * 4 + 4), [p.normal.x, p.normal.y, p.normal.z, p.constant]),
  );
  const g = new Frustum().fromArray([0, 0, 0, 0, ...flat], 4);
  g.planes.forEach((p, i) =>
    assert.deepEqual([p.normal.x, p.normal.y, p.normal.z, p.constant], flat.slice(i * 4, i * 4 + 4)),
  );
  const out = new Array(30).fill(-1);
  assert.equal(f.toArray(out, 3), out);
  assert.deepEqual(out.slice(3, 27), flat);
  assert.equal(out[2], -1);
  assert.equal(out[27], -1);
  assert.equal(f.clone().planes.length, 6);
  assert.deepEqual(f.clone().toArray(), flat);
  assert.deepEqual(new Frustum().copy(f).toArray(), flat);
  assert.notEqual(f.clone().planes[0], f.planes[0]);
  const ps = f.planes.map((p) => new Plane(p.normal.clone(), p.constant));
  assert.deepEqual(new Frustum().set(...ps).toArray(), flat);
  assert.equal(new Frustum().planes.length, 6);
  // boxes far inside, far outside and straddling one plane
  const centre = new Vector3(0, 0, -10).applyMatrix4(view.clone().invert());
  const b = (c, h) => new Box3(v3(c.map((x) => x - h)), v3(c.map((x) => x + h)));
  assert.equal(f.intersectsBox(b(arr(centre), 0.5)), true);
  assert.equal(f.intersectsBox(b([500, 500, 500], 1)), false);
  assert.equal(f.intersectsBox(b(arr(centre), 400)), true);
  for (let i = 0; i < 6; i++) {
    const p = f.planes[i];
    const far = p.normal.clone().multiplyScalar(-200).add(centre);
    assert.equal(f.intersectsBox(b(arr(far), 1)), false, 'behind plane ' + i);
  }
  // the box is tested against the corner furthest along each normal, in every sign combination
  const planeOnly = new Frustum();
  for (const n of [
    [1, 1, 1],
    [-1, 1, 1],
    [1, -1, 1],
    [1, 1, -1],
    [-1, -1, -1],
  ]) {
    planeOnly.planes.forEach((p) => p.set(v3(n), 0));
    const lo = [-2, -2, -2],
      hi = [-1, -1, -1];
    const corners = [];
    for (const x of [lo[0], hi[0]])
      for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z]);
    const want = corners.some((c) => c[0] * n[0] + c[1] * n[1] + c[2] * n[2] >= 0);
    assert.equal(planeOnly.intersectsBox(new Box3(v3(lo), v3(hi))), want, n.join());
  }
});
