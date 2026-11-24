// Pins Quaternion against a naive Hamilton-product reference: every Euler order as a product of axis rotations,
// multiply order, inverse, angles, slerp, rotateTowards, setFromUnitVectors in all three opposite-vector branches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from '../dist/index.js';

const near = (a, b, e = 1e-12, what = '') => assert.ok(Math.abs(a - b) <= e, `${what} ${a} vs ${b}`);
const nearQ = (q, r, e = 1e-12) => ['x', 'y', 'z', 'w'].forEach((k, i) => near(q[k], r[i], e, k));
const mul = (a, b) => [
  a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
  a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
  a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axis = (k, angle) => {
  const q = [0, 0, 0, Math.cos(angle / 2)];
  q['xyz'.indexOf(k)] = Math.sin(angle / 2);
  return q;
};
const unit = (q) => {
  const l = Math.hypot(...q);
  return q.map((x) => x / l);
};
const P = unit([0.3, -0.5, 0.7, 0.4]);
const Q = unit([-0.6, 0.2, 0.1, 0.75]);

test('setFromEuler is the product of the axis rotations in every order', () => {
  const angles = { x: 0.7, y: -1.1, z: 0.4 };
  for (const order of ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX']) {
    const [a, b, c] = order.toLowerCase().split('');
    const expected = mul(mul(axis(a, angles[a]), axis(b, angles[b])), axis(c, angles[c]));
    nearQ(new Quaternion().setFromEuler({ ...angles, order }), expected);
  }
  assert.throws(() => new Quaternion().setFromEuler({ x: 0, y: 0, z: 0, order: 'XXZ' }), RangeError);
});

test('setFromAxisAngle, identity, copy, clone and defaults', () => {
  const q = new Quaternion();
  assert.deepEqual(q.toArray(), [0, 0, 0, 1]);
  nearQ(q.setFromAxisAngle({ x: 0, y: 1, z: 0 }, 1.2), axis('y', 1.2));
  assert.equal(q.identity(), q);
  assert.deepEqual(q.toArray(), [0, 0, 0, 1]);
  assert.deepEqual(new Quaternion().copy({ x: 1, y: 2, z: 3, w: 4 }).toArray(), [1, 2, 3, 4]);
  const c = new Quaternion(1, 2, 3, 4).clone();
  assert.ok(c instanceof Quaternion);
  assert.deepEqual(c.toArray(), [1, 2, 3, 4]);
});

test('multiply, premultiply and multiplyQuaternions order', () => {
  const ab = mul(P, Q),
    ba = mul(Q, P);
  nearQ(new Quaternion(...P).multiply(new Quaternion(...Q)), ab);
  nearQ(new Quaternion(...P).premultiply(new Quaternion(...Q)), ba);
  nearQ(new Quaternion().multiplyQuaternions(new Quaternion(...P), new Quaternion(...Q)), ab);
});

test('conjugate, invert, dot, length, normalize', () => {
  assert.deepEqual(new Quaternion(1, 2, 3, 4).conjugate().toArray(), [-1, -2, -3, 4]);
  const inv = new Quaternion(1, 2, 3, 4).invert();
  nearQ(inv, [-1 / 30, -2 / 30, -3 / 30, 4 / 30]);
  assert.deepEqual(new Quaternion(0, 0, 0, 0).invert().toArray(), [-0, -0, -0, 0]);
  nearQ(new Quaternion(...P).multiply(new Quaternion(...P).invert()), [0, 0, 0, 1]);
  assert.equal(new Quaternion(1, 2, 3, 4).dot({ x: 5, y: 6, z: 7, w: 8 }), 70);
  assert.equal(new Quaternion(1, 2, 3, 4).lengthSq(), 30);
  near(new Quaternion(1, 2, 3, 4).length(), Math.sqrt(30));
  nearQ(new Quaternion(2, 0, 0, 0).normalize(), [1, 0, 0, 0]);
  assert.deepEqual(new Quaternion(0, 0, 0, 0).normalize().toArray(), [0, 0, 0, 1]);
  assert.deepEqual(new Quaternion(NaN, 0, 0, 1).normalize().toArray(), [0, 0, 0, 1]);
  nearQ(new Quaternion(1e-200, 0, 0, 0).normalize(), [1, 0, 0, 0]);
  nearQ(new Quaternion(0, 0, 0, 1e-200).normalize(), [0, 0, 0, 1]);
  nearQ(new Quaternion(0, 1e-200, 0, 0).normalize(), [0, 1, 0, 0]);
  nearQ(new Quaternion(0, 0, 1e-200, 0).normalize(), [0, 0, 1, 0]);
});

test('setFromRotationMatrix reads a 4x4 and a 3x3 rotation', () => {
  const q = new Quaternion(...P);
  const [x, y, z, w] = P;
  const e3 = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ];
  const e4 = [e3[0], e3[1], e3[2], 0, e3[3], e3[4], e3[5], 0, e3[6], e3[7], e3[8], 0, 0, 0, 0, 1];
  const sign = Math.sign(q.w);
  for (const e of [e3, e4]) {
    const r = new Quaternion().setFromRotationMatrix({ elements: e });
    nearQ(r, P.map((c) => c * sign));
  }
});

test('setFromUnitVectors: general, parallel and the three opposite branches', () => {
  const rot = (q, v) => {
    const r = mul(mul(q, [...v, 0]), [-q[0], -q[1], -q[2], q[3]]);
    return r.slice(0, 3);
  };
  const cases = [
    [[1, 0, 0], [0, 1, 0]],
    [[0, 0, 1], [1, 0, 0]],
    [[1, 0, 0], [1, 0, 0]],
    [[1, 0, 0], [-1, 0, 0]],
    [[0, 1, 0], [0, -1, 0]],
    [[0, 0, 1], [0, 0, -1]],
    [[0.6, 0.8, 0], [-0.6, -0.8, 0]],
    [[0.3, 0.5, Math.sqrt(1 - 0.34)], [-0.3, -0.5, -Math.sqrt(1 - 0.34)]],
    [[0.8, 0.1, Math.sqrt(1 - 0.65)], [-0.8, -0.1, -Math.sqrt(1 - 0.65)]],
    [[0.1, 0.8, Math.sqrt(1 - 0.65)], [-0.1, -0.8, -Math.sqrt(1 - 0.65)]],
  ];
  for (const [f, t] of cases) {
    const q = new Quaternion().setFromUnitVectors({ x: f[0], y: f[1], z: f[2] }, { x: t[0], y: t[1], z: t[2] });
    near(q.length(), 1, 1e-12, 'unit');
    const r = rot(q.toArray(), f);
    r.forEach((c, i) => near(c, t[i], 1e-12, 'maps'));
  }
  const half = new Quaternion().setFromUnitVectors({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 });
  assert.equal(half.w, 0);
  near(Math.hypot(half.x, half.y, half.z), 1);
  near(half.x, 0);
});

test('angleTo, slerp, slerpQuaternions and rotateTowards', () => {
  const a = new Quaternion(...axis('z', 0.2)),
    b = new Quaternion(...axis('z', 1.4));
  near(a.angleTo(b), 1.2);
  near(a.angleTo(new Quaternion(...axis('z', 0.2).map((c) => -c))), 0);
  near(new Quaternion().angleTo(new Quaternion(...axis('x', 3))), 3);
  near(a.angleTo(a), 0);
  nearQ(a.clone().slerp(b, 0.5), axis('z', 0.8));
  nearQ(a.clone().slerp(b, 0.25), axis('z', 0.5));
  nearQ(a.clone().slerp(b, 2), axis('z', 2.6));
  nearQ(a.clone().slerp(b, 0), axis('z', 0.2));
  nearQ(a.clone().slerp(b, 1), axis('z', 1.4));
  const same = a.clone();
  assert.equal(same.slerp(a, 0.5), same);
  nearQ(same, axis('z', 0.2));
  // the other hemisphere runs toward -q
  const neg = new Quaternion(...axis('z', 1.4).map((c) => -c));
  nearQ(a.clone().slerp(neg, 0.5), axis('z', 0.8));
  nearQ(a.clone().slerp(neg, 1), axis('z', 1.4).map((c) => -c));
  // nearly identical quaternions take the straight-line branch
  const tiny = new Quaternion(...axis('z', 0.2 + 1e-9));
  nearQ(a.clone().slerp(tiny, 0.5), axis('z', 0.2 + 5e-10), 1e-9);
  nearQ(new Quaternion().slerpQuaternions(a, b, 0.5), axis('z', 0.8));
  nearQ(a.clone().rotateTowards(b, 0.5), axis('z', 0.7));
  nearQ(a.clone().rotateTowards(b, 5), axis('z', 1.4));
  nearQ(a.clone().rotateTowards(a, 0.1), axis('z', 0.2));
  nearQ(a.clone().rotateTowards(b, 1.2), axis('z', 1.4));
});

test('equals and arrays', () => {
  const q = new Quaternion(1, 2, 3, 4);
  assert.equal(q.equals({ x: 1, y: 2, z: 3, w: 4 }), true);
  for (const k of ['x', 'y', 'z', 'w']) {
    const o = { x: 1, y: 2, z: 3, w: 4 };
    o[k] += 0.5;
    assert.equal(q.equals(o), false, k);
    assert.equal(q.equals(o, 0.5), true, k);
    assert.equal(q.equals(o, 0.25), false, k);
  }
  assert.deepEqual(new Quaternion().fromArray([9, 9, 1, 2, 3, 4], 2).toArray(), [1, 2, 3, 4]);
  assert.deepEqual(new Quaternion().fromArray([1, 2, 3, 4]).toArray(), [1, 2, 3, 4]);
  const out = [0, 0, 0, 0, 0, 0, 0];
  assert.equal(q.toArray(out, 2), out);
  assert.deepEqual(out, [0, 0, 1, 2, 3, 4, 0]);
});

test('setFromUnitVectors picks the half-turn axis from the least aligned world axis, ties included', () => {
  const opposite = (f) => {
    const l = Math.hypot(...f);
    const u = f.map((c) => c / l);
    return new Quaternion().setFromUnitVectors({ x: u[0], y: u[1], z: u[2] }, { x: -u[0], y: -u[1], z: -u[2] }).toArray();
  };
  const unitOf = (v) => {
    const l = Math.hypot(...v);
    return v.map((c) => c / l);
  };
  const l6 = Math.sqrt(6);
  // x is the smallest (and ties y): from x e_x with e the x axis -> (0, az, -ay, 0)
  nearQ(new Quaternion(...opposite([1, 1, 2])), unitOf([0, 2 / l6, -1 / l6, 0]));
  // x ties z and is below y: still the x axis
  nearQ(new Quaternion(...opposite([1, 2, 1])), unitOf([0, 1 / l6, -2 / l6, 0]));
  // x is above z but below y: the first test must not pass on x <= y alone
  nearQ(new Quaternion(...opposite([2, 3, 1])), unitOf([3, -2, 0, 0]));
  // y ties z, both below x: y axis
  nearQ(new Quaternion(...opposite([2, 1, 1])), unitOf([-1 / l6, 0, 2 / l6, 0]));
  // z smallest overall
  nearQ(new Quaternion(...opposite([3, 2, 1])), unitOf([2, -3, 0, 0]));
  // z ties neither: y above z, x above y
  nearQ(new Quaternion(...opposite([1, 3, 2])), unitOf([0, 2, -3, 0]));
});

test('slerp from a quarter turn apart, straight-line branch and rotateTowards at exactly one radian', () => {
  const half = new Quaternion().slerp(new Quaternion(1, 0, 0, 0), 0.5);
  nearQ(half, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  const a = new Quaternion(...axis('z', 0.2));
  const tiny = new Quaternion(...axis('z', 0.2 + 2e-8));
  nearQ(a.clone().slerp(tiny, 0.5), axis('z', 0.2 + 1e-8), 1e-13);
  nearQ(a.clone().slerp(tiny, 0.25), axis('z', 0.2 + 5e-9), 1e-13);
  nearQ(new Quaternion().rotateTowards(new Quaternion(...axis('z', 1)), 0.5), axis('z', 0.5));
});

test('slerp of two nearly equal general rotations takes the straight-line branch on every component', () => {
  const a = [0.10050378152592121, -0.30151134457776363, 0.502518907629606, 0.8040302522073697];
  const b = [0.1005037824725121, -0.30151134631503634, 0.5025189101575606, 0.8040302498575969];
  for (const t of [0.5, 0.25, 2]) {
    const lin = a.map((c, i) => c + (b[i] - c) * t);
    const l = Math.hypot(...lin);
    nearQ(new Quaternion(...a).slerp(new Quaternion(...b), t), lin.map((c) => c / l), 1e-13);
  }
});
