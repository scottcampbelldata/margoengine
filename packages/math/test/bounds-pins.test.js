// Pins Box3, Sphere and Plane against brute-force references (corner enumeration, signed distances, closed forms).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Frustum, Matrix4, Plane, Quaternion, Sphere, Vector3 } from '../dist/index.js';
import { createLcgRandom } from '../dist/mathutils.js';

const near = (a, b, e = 1e-12, what = '') => assert.ok(Math.abs(a - b) <= e, `${what} ${a} vs ${b}`);
const v3 = (a) => new Vector3(...a);
const arr = (v) => [v.x, v.y, v.z];
const nearV = (v, a, e = 1e-12) => a.forEach((c, i) => near(arr(v)[i], c, e, 'axis ' + i));
const box = (lo, hi) => new Box3(v3(lo), v3(hi));
const corners = (lo, hi) => {
  const out = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) out.push([x, y, z]);
  return out;
};

test('Box3: empty, set, copy, clone, makeEmpty, centre and size', () => {
  const e = new Box3();
  assert.equal(e.isEmpty(), true);
  assert.deepEqual(arr(e.min), [Infinity, Infinity, Infinity]);
  assert.deepEqual(arr(e.max), [-Infinity, -Infinity, -Infinity]);
  assert.deepEqual(arr(e.getCenter(new Vector3(9, 9, 9))), [0, 0, 0]);
  assert.deepEqual(arr(e.getSize(new Vector3(9, 9, 9))), [0, 0, 0]);
  const b = box([-1, 2, 3], [5, 4, 9]);
  assert.equal(b.isEmpty(), false);
  for (const [lo, hi] of [
    [[2, 0, 0], [1, 5, 5]],
    [[0, 2, 0], [5, 1, 5]],
    [[0, 0, 2], [5, 5, 1]],
  ])
    assert.equal(box(lo, hi).isEmpty(), true);
  assert.equal(box([1, 1, 1], [1, 1, 1]).isEmpty(), false);
  assert.deepEqual(arr(b.getCenter(new Vector3())), [2, 3, 6]);
  assert.deepEqual(arr(b.getSize(new Vector3())), [6, 2, 6]);
  assert.equal(new Box3().set(v3([1, 2, 3]), v3([4, 5, 6])).max.z, 6);
  const c = b.clone();
  assert.ok(c instanceof Box3);
  assert.notEqual(c.min, b.min);
  assert.equal(c.equals(b), true);
  assert.equal(new Box3().copy(b).equals(b), true);
  assert.equal(c.makeEmpty().isEmpty(), true);
  assert.equal(b.equals(box([-1, 2, 3], [5, 4, 8])), false);
  assert.equal(b.equals(box([-1, 2, 2], [5, 4, 9])), false);
  const fromCs = new Box3().setFromCenterAndSize(v3([1, 2, 3]), v3([2, 4, 6]));
  assert.deepEqual([arr(fromCs.min), arr(fromCs.max)], [[0, 0, 0], [2, 4, 6]]);
});

test('Box3: building from points and arrays, expanding, combining', () => {
  const pts = [[3, -1, 2], [-4, 5, 0], [1, 1, 7]];
  const fp = new Box3().setFromPoints(pts.map(v3));
  assert.deepEqual([arr(fp.min), arr(fp.max)], [[-4, -1, 0], [3, 5, 7]]);
  assert.equal(new Box3().setFromPoints([]).isEmpty(), true);
  const flat = pts.flat();
  const fa = new Box3().setFromArray(flat);
  assert.deepEqual([arr(fa.min), arr(fa.max)], [[-4, -1, 0], [3, 5, 7]]);
  const strided = new Box3().setFromArray([9, 9, 9, 3, -1, 2, 8, 8, 8, -4, 5, 0, 7, 7, 7, 1, 1, 7], 6, 3);
  assert.deepEqual([arr(strided.min), arr(strided.max)], [[-4, -1, 0], [3, 5, 7]]);
  assert.equal(new Box3().setFromArray([1, 2]).isEmpty(), true);
  const last = new Box3().setFromArray([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(arr(last.max), [4, 5, 6]);
  const ex = box([0, 0, 0], [1, 1, 1]);
  assert.equal(ex.expandByPoint(v3([-1, 2, 0.5])), ex);
  assert.deepEqual([arr(ex.min), arr(ex.max)], [[-1, 0, 0], [1, 2, 1]]);
  ex.expandByPoint(v3([5, -3, 4]));
  assert.deepEqual([arr(ex.min), arr(ex.max)], [[-1, -3, 0], [5, 2, 4]]);
  const ev = box([0, 0, 0], [1, 1, 1]).expandByVector(v3([1, 2, 3]));
  assert.deepEqual([arr(ev.min), arr(ev.max)], [[-1, -2, -3], [2, 3, 4]]);
  const es = box([0, 0, 0], [1, 1, 1]).expandByScalar(2);
  assert.deepEqual([arr(es.min), arr(es.max)], [[-2, -2, -2], [3, 3, 3]]);
  const u = box([0, 0, 0], [2, 2, 2]).union(box([1, -1, 1], [3, 1, 5]));
  assert.deepEqual([arr(u.min), arr(u.max)], [[0, -1, 0], [3, 2, 5]]);
  const i = box([0, 0, 0], [2, 2, 2]).intersect(box([1, -1, 1], [3, 1, 5]));
  assert.deepEqual([arr(i.min), arr(i.max)], [[1, 0, 1], [2, 1, 2]]);
  const none = box([0, 0, 0], [1, 1, 1]).intersect(box([2, 2, 2], [3, 3, 3]));
  assert.equal(none.isEmpty(), true);
  assert.deepEqual(arr(none.min), [Infinity, Infinity, Infinity]);
  for (const axis of [0, 1, 2]) {
    const far = [0, 0, 0];
    far[axis] = 2;
    assert.equal(box([0, 0, 0], [1, 1, 1]).intersect(box(far, [3, 3, 3])).isEmpty(), true, 'axis ' + axis);
  }
  const t = box([0, 0, 0], [1, 1, 1]).translate(v3([1, 2, 3]));
  assert.deepEqual([arr(t.min), arr(t.max)], [[1, 2, 3], [2, 3, 4]]);
});

test('Box3: applyMatrix4 equals the bounds of the transformed corners', () => {
  const q = new Quaternion(0.2, -0.5, 0.3, 0.7).normalize();
  const m = new Matrix4().compose({ x: 1, y: -2, z: 3 }, q, { x: 2, y: -3, z: 0.5 });
  const lo = [-1, 0.5, -2],
    hi = [3, 2, 1];
  const b = box(lo, hi).applyMatrix4(m);
  const ref = new Box3().setFromPoints(corners(lo, hi).map((c) => v3(c).applyMatrix4(m)));
  nearV(b.min, arr(ref.min));
  nearV(b.max, arr(ref.max));
  const empty = new Box3().applyMatrix4(m);
  assert.equal(empty.isEmpty(), true);
  assert.equal(empty.min.x, Infinity);
});

test('Box3: containment, intersection and distance queries', () => {
  const b = box([0, 0, 0], [2, 3, 4]);
  assert.equal(b.containsPoint(v3([1, 1, 1])), true);
  assert.equal(b.containsPoint(v3([0, 0, 0])), true);
  assert.equal(b.containsPoint(v3([2, 3, 4])), true);
  for (const p of [[-0.1, 1, 1], [2.1, 1, 1], [1, -0.1, 1], [1, 3.1, 1], [1, 1, -0.1], [1, 1, 4.1]])
    assert.equal(b.containsPoint(v3(p)), false, p.join());
  assert.equal(b.containsBox(box([0, 0, 0], [2, 3, 4])), true);
  assert.equal(b.containsBox(box([0.5, 0.5, 0.5], [1, 1, 1])), true);
  for (const o of [
    box([-0.1, 0, 0], [2, 3, 4]),
    box([0, -0.1, 0], [2, 3, 4]),
    box([0, 0, -0.1], [2, 3, 4]),
    box([0, 0, 0], [2.1, 3, 4]),
    box([0, 0, 0], [2, 3.1, 4]),
    box([0, 0, 0], [2, 3, 4.1]),
  ])
    assert.equal(b.containsBox(o), false);
  assert.equal(b.intersectsBox(box([2, 3, 4], [5, 5, 5])), true);
  assert.equal(b.intersectsBox(box([-3, -3, -3], [0, 0, 0])), true);
  for (const o of [
    box([2.1, 0, 0], [5, 5, 5]),
    box([0, 3.1, 0], [5, 5, 5]),
    box([0, 0, 4.1], [5, 5, 5]),
    box([-5, -5, -5], [-0.1, 5, 5]),
    box([-5, -5, -5], [5, -0.1, 5]),
    box([-5, -5, -5], [5, 5, -0.1]),
  ])
    assert.equal(b.intersectsBox(o), false);
  const s = (c, r) => ({ center: v3(c), radius: r });
  assert.equal(b.intersectsSphere(s([3, 0, 0], 1)), true);
  assert.equal(b.intersectsSphere(s([3, 0, 0], 0.99)), false);
  assert.equal(b.intersectsSphere(s([-1, 1, 1], 1)), true);
  assert.equal(b.intersectsSphere(s([1, 4, 1], 1)), true);
  assert.equal(b.intersectsSphere(s([1, 1, 5], 0.99)), false);
  assert.equal(b.intersectsSphere(s([1, 1, 1], 0)), true);
  near(b.distanceToPoint(v3([5, 7, 4])), Math.hypot(3, 4, 0));
  near(b.distanceToPoint(v3([-3, 1, 8])), Math.hypot(3, 0, 4));
  near(b.distanceToPoint(v3([1, -4, 1])), 4);
  assert.equal(b.distanceToPoint(v3([1, 1, 1])), 0);
  assert.deepEqual(arr(b.clampPoint(v3([5, -2, 2]), new Vector3())), [2, 0, 2]);
  assert.deepEqual(arr(b.clampPoint(v3([-5, 9, -2]), new Vector3())), [0, 3, 0]);
  assert.deepEqual(arr(b.clampPoint(v3([1, 1, 9]), new Vector3())), [1, 1, 4]);
  const bs = { center: new Vector3(), radius: 0 };
  assert.equal(b.getBoundingSphere(bs), bs);
  nearV(bs.center, [1, 1.5, 2]);
  near(bs.radius, Math.hypot(2, 3, 4) / 2);
  const es = { center: v3([7, 7, 7]), radius: 3 };
  new Box3().getBoundingSphere(es);
  assert.deepEqual([arr(es.center), es.radius], [[0, 0, 0], -1]);
});

test('Box3.intersectsPlane agrees with the signed distances of the eight corners', () => {
  const b = box([-1, 0.5, -2], [3, 2, 1]);
  const cs = corners([-1, 0.5, -2], [3, 2, 1]);
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 2, -3], [-2, 1, 1], [1, -1, 2], [-1, -2, -1]];
  for (const d of dirs)
    for (const constant of [-6, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 4, 6]) {
      const dist = cs.map((c) => d[0] * c[0] + d[1] * c[1] + d[2] * c[2] + constant);
      const want = Math.min(...dist) <= 0 && Math.max(...dist) >= 0;
      assert.equal(b.intersectsPlane({ normal: v3(d), constant }), want, `${d} ${constant}`);
      assert.equal(new Plane(v3(d), constant).intersectsBox(b), want);
    }
});

test('Sphere: construction, copy, empty, fitting and queries', () => {
  const d = new Sphere();
  assert.deepEqual([arr(d.center), d.radius], [[0, 0, 0], -1]);
  assert.equal(d.isEmpty(), true);
  const s = new Sphere().set(v3([1, 2, 3]), 4);
  assert.equal(s.isEmpty(), false);
  assert.equal(new Sphere(v3([0, 0, 0]), 0).isEmpty(), false);
  const c = s.clone();
  assert.ok(c instanceof Sphere);
  assert.notEqual(c.center, s.center);
  assert.equal(c.equals(s), true);
  assert.equal(new Sphere().copy(s).equals(s), true);
  assert.equal(s.equals(new Sphere(v3([1, 2, 3]), 5)), false);
  assert.equal(s.equals(new Sphere(v3([1, 2, 4]), 4)), false);
  assert.equal(c.makeEmpty().isEmpty(), true);
  const pts = [[3, -1, 2], [-4, 5, 0], [1, 1, 7]].map(v3);
  const f = new Sphere().setFromPoints(pts);
  nearV(f.center, [-0.5, 2, 3.5]);
  near(f.radius, Math.max(...pts.map((p) => p.distanceTo(f.center))));
  const g = new Sphere().setFromPoints(pts, v3([0, 0, 0]));
  nearV(g.center, [0, 0, 0]);
  near(g.radius, Math.max(...pts.map((p) => p.length())));
  assert.equal(new Sphere(v3([1, 1, 1]), 5).setFromPoints([]).isEmpty(), true);
  assert.equal(s.containsPoint(v3([5, 2, 3])), true);
  assert.equal(s.containsPoint(v3([5.1, 2, 3])), false);
  near(s.distanceToPoint(v3([9, 2, 3])), 4);
  near(s.distanceToPoint(v3([1, 2, 3])), -4);
  assert.equal(s.intersectsSphere(new Sphere(v3([9, 2, 3]), 4)), true);
  assert.equal(s.intersectsSphere(new Sphere(v3([9.1, 2, 3]), 4)), false);
  assert.equal(s.intersectsBox(box([5, 0, 0], [8, 8, 8])), true);
  assert.equal(s.intersectsBox(box([5.1, 0, 0], [8, 8, 8])), false);
  assert.equal(s.intersectsBox(box([0, 6.1, 0], [8, 8, 8])), false);
  assert.equal(s.intersectsBox(box([0, 0, 7.1], [8, 8, 8])), false);
  assert.equal(s.intersectsBox(box([-9, -9, -9], [-3.1, 8, 8])), false);
  assert.equal(s.intersectsBox(box([-9, -9, -9], [8, -2.1, 8])), false);
  assert.equal(s.intersectsBox(box([-9, -9, -9], [8, 8, -1.1])), false);
  assert.equal(s.intersectsPlane(new Plane(v3([0, 1, 0]), -6)), true);
  assert.equal(s.intersectsPlane(new Plane(v3([0, 1, 0]), -6.1)), false);
  assert.equal(s.intersectsPlane(new Plane(v3([0, 1, 0]), 2)), true);
  assert.equal(s.intersectsPlane(new Plane(v3([0, 1, 0]), 6.1)), false);
  assert.deepEqual(arr(s.clampPoint(v3([1, 2, 13]), new Vector3())), [1, 2, 7]);
  assert.deepEqual(arr(s.clampPoint(v3([2, 3, 4]), new Vector3())), [2, 3, 4]);
  const bb = new Box3();
  assert.equal(s.getBoundingBox(bb), bb);
  assert.deepEqual([arr(bb.min), arr(bb.max)], [[-3, -2, -1], [5, 6, 7]]);
  assert.equal(new Sphere().getBoundingBox(box([0, 0, 0], [1, 1, 1])).isEmpty(), true);
  assert.equal(new Sphere().getBoundingBox(box([0, 0, 0], [1, 1, 1])).min.y, Infinity);
  assert.equal(new Sphere().getBoundingBox(box([0, 0, 0], [1, 1, 1])).max.z, -Infinity);
});

test('Sphere: expandByPoint, union, applyMatrix4 and translate', () => {
  const e = new Sphere().expandByPoint(v3([1, 2, 3]));
  assert.deepEqual([arr(e.center), e.radius], [[1, 2, 3], 0]);
  const s = new Sphere(v3([0, 0, 0]), 1);
  s.expandByPoint(v3([0.5, 0, 0]));
  assert.deepEqual([arr(s.center), s.radius], [[0, 0, 0], 1]);
  s.expandByPoint(v3([3, 0, 0]));
  nearV(s.center, [1, 0, 0]);
  near(s.radius, 2);
  const a = new Sphere(v3([0, 0, 0]), 1);
  assert.equal(a.union(new Sphere()), a);
  assert.equal(a.radius, 1);
  const fromEmpty = new Sphere().union(a);
  assert.equal(fromEmpty.radius, 1);
  const inside = new Sphere(v3([0, 0, 0]), 5).union(new Sphere(v3([1, 0, 0]), 1));
  assert.deepEqual([arr(inside.center), inside.radius], [[0, 0, 0], 5]);
  const outside = new Sphere(v3([0, 0, 0]), 1).union(new Sphere(v3([1, 0, 0]), 5));
  assert.deepEqual([arr(outside.center), outside.radius], [[1, 0, 0], 5]);
  const apart = new Sphere(v3([0, 0, 0]), 1).union(new Sphere(v3([6, 0, 0]), 2));
  nearV(apart.center, [3.5, 0, 0]);
  near(apart.radius, 4.5);
  const m = new Matrix4().compose({ x: 1, y: 2, z: 3 }, new Quaternion(), { x: 2, y: 5, z: 3 });
  const t = new Sphere(v3([1, 1, 1]), 2).applyMatrix4(m);
  nearV(t.center, [3, 7, 6]);
  near(t.radius, 10);
  for (const [sx, sy, sz, r] of [[7, 2, 3, 14], [2, 7, 3, 14], [2, 3, 7, 14]]) {
    const mm = new Matrix4().makeScale(sx, sy, sz);
    near(new Sphere(v3([0, 0, 0]), 2).applyMatrix4(mm).radius, r);
  }
  const tr = new Sphere(v3([1, 1, 1]), 2).translate(v3([1, 2, 3]));
  assert.deepEqual([arr(tr.center), tr.radius], [[2, 3, 4], 2]);
});

test('Plane: construction, from points, normalize, negate, distances and projection', () => {
  const d = new Plane();
  assert.deepEqual([arr(d.normal), d.constant], [[1, 0, 0], 0]);
  const p = new Plane().set(v3([0, 2, 0]), 4);
  assert.deepEqual([arr(p.normal), p.constant], [[0, 2, 0], 4]);
  assert.deepEqual([arr(new Plane().setComponents(1, 2, 3, 4).normal), new Plane().setComponents(1, 2, 3, 4).constant], [[1, 2, 3], 4]);
  const n = new Plane().setFromNormalAndCoplanarPoint(v3([0, 1, 0]), v3([5, 3, 2]));
  assert.equal(n.constant, -3);
  const ccw = new Plane().setFromCoplanarPoints(v3([0, 0, 1]), v3([1, 0, 1]), v3([1, 1, 1]));
  nearV(ccw.normal, [0, 0, 1]);
  near(ccw.constant, -1);
  const tri = new Plane().setFromCoplanarPoints(v3([1, 0, 0]), v3([0, 1, 0]), v3([0, 0, 1]));
  nearV(tri.normal, [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]);
  near(tri.constant, -1 / Math.sqrt(3));
  const c = p.clone();
  assert.ok(c instanceof Plane);
  assert.notEqual(c.normal, p.normal);
  assert.equal(c.equals(p), true);
  assert.equal(new Plane().copy(p).equals(p), true);
  assert.equal(p.equals(new Plane(v3([0, 2, 0]), 5)), false);
  assert.equal(p.equals(new Plane(v3([0, 3, 0]), 4)), false);
  const nz = new Plane(v3([0, 3, 4]), 10).normalize();
  nearV(nz.normal, [0, 0.6, 0.8]);
  near(nz.constant, 2);
  const zero = new Plane(v3([0, 0, 0]), 3).normalize();
  assert.deepEqual([arr(zero.normal), zero.constant], [[0, 0, 0], 3]);
  const ng = new Plane(v3([0, 1, 0]), 3).negate();
  assert.deepEqual([arr(ng.normal), ng.constant], [[-0, -1, -0], -3]);
  const pl = new Plane(v3([0, 1, 0]), -3);
  assert.equal(pl.distanceToPoint(v3([7, 5, 7])), 2);
  assert.equal(pl.distanceToSphere({ center: v3([7, 5, 7]), radius: 0.5 }), 1.5);
  assert.deepEqual(arr(pl.projectPoint(v3([7, 5, 7]), new Vector3())), [7, 3, 7]);
  assert.deepEqual(arr(new Plane(v3([0, 2, 0]), -6).projectPoint(v3([7, 5, 7]), new Vector3())), [7, 3, 7]);
  assert.deepEqual(arr(new Plane(v3([0, 0, 0]), -6).projectPoint(v3([7, 5, 7]), new Vector3())), [7, 5, 7]);
  assert.deepEqual(arr(pl.coplanarPoint(new Vector3())), [0, 3, 0]);
  assert.deepEqual(arr(new Plane(v3([0, 2, 0]), -6).coplanarPoint(new Vector3())), [0, 3, 0]);
  assert.deepEqual(arr(new Plane(v3([0, 0, 0]), -6).coplanarPoint(new Vector3())).map(Math.abs), [0, 0, 0]);
  assert.equal(pl.intersectsSphere({ center: v3([0, 5, 0]), radius: 2 }), true);
  assert.equal(pl.intersectsSphere({ center: v3([0, 5, 0]), radius: 1.9 }), false);
  assert.equal(pl.intersectsSphere({ center: v3([0, 1, 0]), radius: 2 }), true);
  assert.equal(pl.intersectsSphere({ center: v3([0, 1, 0]), radius: 1.9 }), false);
  const tp = new Plane(v3([0, 1, 0]), -3).translate(v3([5, 2, 5]));
  assert.equal(tp.constant, -5);
});

test('Plane.applyMatrix4 keeps points on the plane and the normal pointing the same way', () => {
  const q = new Quaternion(0.2, -0.5, 0.3, 0.7).normalize();
  for (const s of [{ x: 2, y: 3, z: 0.5 }, { x: -2, y: 3, z: 0.5 }, { x: 1, y: 1, z: 1 }]) {
    const m = new Matrix4().compose({ x: 1, y: -2, z: 3 }, q, s);
    const plane = new Plane(v3([1, 2, -2]).normalize(), 1.5);
    const pts = [[1, 0, 0], [0, 2, 1], [3, -1, 2]].map((c) => {
      const p = v3(c);
      return p.addScaledVector(plane.normal, -plane.distanceToPoint(p));
    });
    const moved = plane.clone().applyMatrix4(m);
    near(moved.normal.length(), 1);
    for (const p of pts) near(moved.distanceToPoint(p.clone().applyMatrix4(m)), 0, 1e-11);
    const front = pts[0].clone().addScaledVector(plane.normal, 1);
    const det = m.determinant();
    // a point on the front side stays on the front side, mirror or not
    assert.ok(moved.distanceToPoint(front.applyMatrix4(m)) > 0, 'front stays front, det ' + det);
  }
});

test('Box3.setFromArray ignores a trailing partial point and compares strictly', () => {
  for (const length of [4, 5]) {
    const b = new Box3().setFromArray([0, 0, 0, 5, 6].slice(0, length));
    assert.deepEqual([arr(b.min), arr(b.max)], [[0, 0, 0], [0, 0, 0]], 'length ' + length);
  }
  assert.deepEqual(arr(new Box3().setFromArray([1, 2, 3, 4, 5, 6]).max), [4, 5, 6]);
  assert.equal(new Box3().setFromArray([1, 2, 3, 4, 5, 6, 7]).max.z, 6);
  // a point equal to a bound leaves it untouched, signed zero included
  const lowBox = new Box3(v3([0, 0, 0]), v3([5, 5, 5]));
  lowBox.expandByPoint(v3([-0, -0, -0]));
  assert.deepEqual(arr(lowBox.min).map((x) => Object.is(x, -0)), [false, false, false]);
  const highBox = new Box3(v3([-5, -5, -5]), v3([-0, -0, -0]));
  highBox.expandByPoint(v3([0, 0, 0]));
  assert.deepEqual(arr(highBox.max).map((x) => Object.is(x, -0)), [true, true, true]);
});

test('Box3.applyMatrix4 reads only the affine part of the matrix', () => {
  const e = [1, 0, 0, 0.5, 0, 1, 0, 0.25, 0, 0, 1, 0.125, 0, 0, 0, 1];
  const b = box([0, 0, 0], [1, 2, 3]).applyMatrix4({ elements: e });
  assert.deepEqual([arr(b.min), arr(b.max)], [[0, 0, 0], [1, 2, 3]]);
});

test('Sphere: empty state, single points, box and plane overlap, partial union and matrix scale', () => {
  const e = new Sphere(v3([4, 5, 6]), 3).makeEmpty();
  assert.deepEqual([arr(e.center), e.radius], [[0, 0, 0], -1]);
  const single = new Sphere().setFromPoints([v3([2, 3, 4])]);
  assert.deepEqual([arr(single.center), single.radius], [[2, 3, 4], 0]);
  assert.equal(new Sphere().setFromPoints([v3([2, 3, 4])], v3([2, 3, 4])).radius, 0);
  assert.equal(new Sphere(v3([1, 1, 1]), 0.5).intersectsBox(box([0, 0, 0], [2, 2, 2])), true);
  assert.equal(new Sphere(v3([3, 1, 1]), 0.5).intersectsBox(box([0, 0, 0], [2, 2, 2])), false);
  const s = new Sphere(v3([0, 3, 4]), 5);
  assert.equal(s.intersectsPlane(new Plane(v3([0, 1, 1]), -2)), true);
  assert.equal(s.intersectsPlane(new Plane(v3([0, 0.6, 0.8]), -2)), true);
  assert.equal(s.intersectsPlane(new Plane(v3([0, 0.6, 0.8]), 0.1)), false);
  assert.equal(s.intersectsPlane(new Plane(v3([0, 0.6, 0.8]), -10.1)), false);
  assert.equal(s.intersectsPlane(new Plane(v3([0, 0.6, -0.8]), -10.1)), false);
  assert.equal(new Sphere(v3([1, 2, 3]), 1).intersectsPlane(new Plane(v3([1, 2, 3]).normalize(), -v3([1, 2, 3]).dot(v3([1, 2, 3]).normalize()))), true);
  const a = new Sphere(v3([0, 0, 0]), 1).union(new Sphere(v3([2, 0, 0]), 2));
  nearV(a.center, [1.5, 0, 0]);
  near(a.radius, 2.5);
  const b = new Sphere(v3([0, 0, 0]), 5).union(new Sphere(v3([0, 0, 0]), 5));
  assert.deepEqual([arr(b.center), b.radius], [[0, 0, 0], 5]);
  const cols = (x, y, z) => ({ elements: [...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1] });
  const c1 = [1, 2, 2],
    c2 = [0, 3, 4],
    c3 = [2, 3, 6];
  for (const [x, y, z] of [[c3, c1, c2], [c1, c3, c2], [c1, c2, c3]])
    near(new Sphere(v3([0, 0, 0]), 2).applyMatrix4(cols(x, y, z)).radius, 14);
});

test('Plane: asymmetric triangle, oblique projection and the sign of a mirrored transform', () => {
  const a = [1, 2, 3],
    b = [4, -1, 2],
    c = [-2, 5, 7];
  const n = [0, 1, 2].map((i) => 0);
  const ux = c[0] - b[0],
    uy = c[1] - b[1],
    uz = c[2] - b[2],
    vx = a[0] - b[0],
    vy = a[1] - b[1],
    vz = a[2] - b[2];
  const cr = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(...cr);
  const p = new Plane().setFromCoplanarPoints(v3(a), v3(b), v3(c));
  nearV(p.normal, cr.map((x) => x / l));
  near(p.constant, -(cr[0] * a[0] + cr[1] * a[1] + cr[2] * a[2]) / l);
  for (const pt of [a, b, c]) near(p.distanceToPoint(v3(pt)), 0);
  void n;
  const slanted = new Plane(v3([1, 2, 2]).multiplyScalar(1 / 3), -2);
  const q = v3([4, -3, 5]);
  const out = slanted.projectPoint(q, new Vector3());
  near(slanted.distanceToPoint(out), 0);
  nearV(out.clone().sub(q).cross(slanted.normal), [0, 0, 0]);
  const cop = slanted.coplanarPoint(new Vector3());
  near(slanted.distanceToPoint(cop), 0);
  nearV(cop.clone().cross(slanted.normal), [0, 0, 0]);
});

test('Plane.applyMatrix4 with generic sheared matrices keeps points on the plane and the front in front', () => {
  const matrices = [
    [1.5, 0.2, -0.3, 0, 0.7, 2, 0.4, 0, -0.6, 0.9, 1.2, 0, 2, -3, 4, 1],
    [1.5, 0.2, -0.3, 0, 0.7, -2, 0.4, 0, -0.6, 0.9, 1.2, 0, 2, -3, 4, 1],
    [-1.1, 0.5, 0.8, 0, 0.3, 1.7, -0.9, 0, 0.6, -0.4, 2.2, 0, -1, 5, 0.5, 1],
    [2.5, 0.1, 0.3, 0, -0.4, 1.1, 0.7, 0, 0.2, -0.8, 0.6, 0, 0.5, 0.25, -2, 1],
  ];
  for (const elements of matrices) {
    const m = new Matrix4().fromArray(elements);
    for (const [nrm, c] of [[[1, 2, -2], 1.5], [[-2, 1, 3], -2.5], [[0.3, -0.5, 0.9], 0.7]]) {
      const plane = new Plane(v3(nrm).normalize(), c);
      const moved = plane.clone().applyMatrix4(m);
      near(moved.normal.length(), 1);
      for (const pt of [[1, 0, 0], [0, 2, 1], [3, -1, 2]]) {
        const p = v3(pt);
        p.addScaledVector(plane.normal, -plane.distanceToPoint(p));
        near(moved.distanceToPoint(p.clone().applyMatrix4(m)), 0, 1e-11);
      }
      const front = v3([1, 0, 0]).addScaledVector(plane.normal, 1 - plane.distanceToPoint(v3([1, 0, 0])) + 1 - 1);
      assert.ok(plane.distanceToPoint(front) > 0);
      assert.ok(moved.distanceToPoint(front.clone().applyMatrix4(m)) > 0, 'front stays front, det ' + m.determinant());
    }
  }
});

test('Box3.intersectsPlane is exact at the touching boundary on both sides, per axis', () => {
  const b = box([-1, 0.5, -2], [3, 2, 1]);
  const cs = corners([-1, 0.5, -2], [3, 2, 1]);
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [2, 3, 5], [-3, 2, -7], [4, -5, 6], [-1, -2, -3], [0.5, -0.25, 3]]) {
    const dist = cs.map((c) => d[0] * c[0] + d[1] * c[1] + d[2] * c[2]);
    const low = Math.min(...dist),
      high = Math.max(...dist);
    for (const [target, inside] of [[low, true], [high, true], [low - 1e-9, false], [high + 1e-9, false], [(low + high) / 2, true]]) {
      assert.equal(b.intersectsPlane({ normal: v3(d), constant: -target }), inside, `${d} ${target}`);
    }
  }
});

test('Frustum: points, spheres and boxes exactly on a plane are inside', () => {
  const f = new Frustum();
  // the cube [-1, 1]^3 as six inward planes
  f.fromArray([1, 0, 0, 1, -1, 0, 0, 1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 1, 0, 0, -1, 1]);
  for (const p of [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [1, 1, 1], [-1, -1, -1]])
    assert.equal(f.containsPoint(v3(p)), true, p.join());
  for (const p of [[-1.0001, 0, 0], [1.0001, 0, 0], [0, -1.0001, 0], [0, 1.0001, 0], [0, 0, -1.0001], [0, 0, 1.0001]])
    assert.equal(f.containsPoint(v3(p)), false, p.join());
  for (const [c, r, want] of [[[2, 0, 0], 1, true], [[2.0001, 0, 0], 1, false], [[-3, 0, 0], 2, true], [[0, 0, 3.5], 2, false], [[0, -3, 0], 2, true], [[0, 3, 0], 1.9, false]])
    assert.equal(f.intersectsSphere({ center: v3(c), radius: r }), want, c.join() + ' ' + r);
  const bx = (lo, hi) => new Box3(v3(lo), v3(hi));
  assert.equal(f.intersectsBox(bx([1, -0.5, -0.5], [3, 0.5, 0.5])), true);
  assert.equal(f.intersectsBox(bx([1.0001, -0.5, -0.5], [3, 0.5, 0.5])), false);
  assert.equal(f.intersectsBox(bx([-3, -0.5, -0.5], [-1, 0.5, 0.5])), true);
  assert.equal(f.intersectsBox(bx([-3, -0.5, -0.5], [-1.0001, 0.5, 0.5])), false);
  assert.equal(f.intersectsBox(bx([-0.5, 1, -0.5], [0.5, 3, 0.5])), true);
  assert.equal(f.intersectsBox(bx([-0.5, 1.0001, -0.5], [0.5, 3, 0.5])), false);
  assert.equal(f.intersectsBox(bx([-0.5, -3, -0.5], [0.5, -1, 0.5])), true);
  assert.equal(f.intersectsBox(bx([-0.5, -3, -0.5], [0.5, -1.0001, 0.5])), false);
  assert.equal(f.intersectsBox(bx([-0.5, -0.5, 1], [0.5, 0.5, 3])), true);
  assert.equal(f.intersectsBox(bx([-0.5, -0.5, 1.0001], [0.5, 0.5, 3])), false);
  assert.equal(f.intersectsBox(bx([-0.5, -0.5, -3], [0.5, 0.5, -1])), true);
  assert.equal(f.intersectsBox(bx([-0.5, -0.5, -3], [0.5, 0.5, -1.0001])), false);
});

test('Sphere.applyMatrix4 scales the radius by the longest column of a generic matrix', () => {
  const cols = (x, y, z) => ({ elements: [...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1] });
  const big = [3, 4, 12],
    mid = [1, 2, 2],
    small = [2, 3, 6];
  for (const [x, y, z] of [[big, mid, small], [mid, big, small], [mid, small, big]])
    near(new Sphere(v3([0, 0, 0]), 2).applyMatrix4(cols(x, y, z)).radius, 26);
  const m = new Matrix4().fromArray([1, 2, 2, 0, 4, 5, 6, 0, 3, 3, 3, 0, 0, 0, 0, 1]);
  near(m.getMaxScaleOnAxis(), Math.hypot(4, 5, 6));
  for (const [x, y, z] of [[big, mid, small], [mid, big, small], [mid, small, big]])
    near(new Matrix4().fromArray([...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1]).getMaxScaleOnAxis(), 13);
});

test('Plane.applyMatrix4 keeps the front in front for 400 random sheared matrices of either handedness', () => {
  const rand = createLcgRandom(8080);
  let mirrored = 0;
  for (let i = 0; i < 400; i++) {
    const e = Array.from({ length: 16 }, () => rand() * 4 - 2);
    e[3] = e[7] = e[11] = 0;
    e[15] = 1;
    const m = new Matrix4().fromArray(e);
    const det = m.determinant();
    if (Math.abs(det) < 0.05) continue;
    if (det < 0) mirrored++;
    const plane = new Plane(v3([rand() - 0.5, rand() - 0.5, rand() - 0.5]).normalize(), rand() * 4 - 2);
    const onPlane = v3([rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2]);
    onPlane.addScaledVector(plane.normal, -plane.distanceToPoint(onPlane));
    const front = onPlane.clone().addScaledVector(plane.normal, 1.5);
    const moved = plane.clone().applyMatrix4(m);
    near(moved.distanceToPoint(onPlane.clone().applyMatrix4(m)), 0, 1e-9, 'on plane ' + i);
    assert.ok(moved.distanceToPoint(front.applyMatrix4(m)) > 0, `front stays front, matrix ${i}, det ${det}`);
  }
  assert.ok(mirrored > 50, 'mirrored ' + mirrored);
});
