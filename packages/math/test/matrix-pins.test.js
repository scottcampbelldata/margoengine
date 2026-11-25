// Pins Matrix3, Matrix4 and Euler against naive references: row-major products, Laplace determinants, adjugate
// inverses, hand-written axis rotations, TRS composition, look-at bases, projections and Euler round trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from '../dist/index.js';

const near = (a, b, e = 1e-12, what = '') => assert.ok(Math.abs(a - b) <= e, `${what} ${a} vs ${b}`);
const nearAll = (got, want, e = 1e-12) => {
  assert.equal(got.length, want.length);
  want.forEach((w, i) => near(got[i], w, e, 'element ' + i));
};
// Column-major index helpers over a plain n x n row-major reference (rows[r][c]).
const toColumnMajor = (rows) => rows[0].map((_, c) => rows.map((row) => row[c])).flat();
const fromColumnMajor = (e, n) =>
  Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => e[c * n + r]));
const matMul = (a, b) => a.map((row) => b[0].map((_, c) => row.reduce((s, x, k) => s + x * b[k][c], 0)));
const det = (m) => {
  if (m.length === 1) return m[0][0];
  return m[0].reduce(
    (s, x, c) => s + (c % 2 ? -1 : 1) * x * det(m.slice(1).map((r) => r.filter((_, j) => j !== c))),
    0,
  );
};
const inverse = (m) => {
  const n = m.length,
    d = det(m);
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => {
      const minor = m.filter((_, i) => i !== c).map((row) => row.filter((_, j) => j !== r));
      return (((r + c) % 2 ? -1 : 1) * det(minor)) / d;
    }),
  );
};
const transpose = (m) => m[0].map((_, c) => m.map((row) => row[c]));

const R3A = [
  [2, -1, 3],
  [0.5, 4, -2],
  [1, 7, 5],
];
const R3B = [
  [-3, 2, 1],
  [4, 0, -1],
  [2, 6, 0.5],
];
const R4A = [
  [2, -1, 3, 0.5],
  [0.5, 4, -2, 1],
  [1, 7, 5, -3],
  [3, 0, -4, 2],
];
const R4B = [
  [-3, 2, 1, 4],
  [4, 0, -1, 2],
  [2, 6, 0.5, -1],
  [1, -2, 3, 8],
];
const m3 = (rows) => new Matrix3().fromArray(toColumnMajor(rows));
const m4 = (rows) => new Matrix4().fromArray(toColumnMajor(rows));
const rows3 = (m) => fromColumnMajor(m.elements, 3);
const rows4 = (m) => fromColumnMajor(m.elements, 4);
const flat = (rows) => rows.flat();

test('Matrix3: set is row-major, products, determinant, inverse, transpose, scalar', () => {
  const m = new Matrix3().set(...flat(R3A));
  assert.deepEqual(rows3(m), R3A);
  assert.deepEqual(Array.from(new Matrix3().elements), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(Array.from(new Matrix3().set(...flat(R3A)).identity().elements), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  nearAll(flat(rows3(m3(R3A).multiply(m3(R3B)))), flat(matMul(R3A, R3B)));
  nearAll(flat(rows3(m3(R3A).premultiply(m3(R3B)))), flat(matMul(R3B, R3A)));
  nearAll(flat(rows3(new Matrix3().multiplyMatrices(m3(R3A), m3(R3B)))), flat(matMul(R3A, R3B)));
  near(m3(R3A).determinant(), det(R3A));
  nearAll(flat(rows3(m3(R3A).invert())), flat(inverse(R3A)));
  assert.deepEqual(
    Array.from(
      m3([
        [1, 2, 3],
        [2, 4, 6],
        [0, 1, 1],
      ]).invert().elements,
    ),
    Array(9).fill(0),
  );
  assert.deepEqual(rows3(m3(R3A).transpose()), transpose(R3A));
  assert.deepEqual(
    rows3(m3(R3A).multiplyScalar(3)),
    R3A.map((r) => r.map((x) => x * 3)),
  );
  const copy = new Matrix3().copy(m3(R3A));
  assert.deepEqual(rows3(copy), R3A);
  assert.deepEqual(rows3(copy.clone()), R3A);
  assert.notEqual(copy.clone().elements, copy.elements);
});

test('Matrix3: 2D transforms, normal matrix, equals and arrays', () => {
  assert.deepEqual(rows3(new Matrix3().makeTranslation(3, 4)), [
    [1, 0, 3],
    [0, 1, 4],
    [0, 0, 1],
  ]);
  assert.deepEqual(rows3(new Matrix3().makeScale(3, 4)), [
    [3, 0, 0],
    [0, 4, 0],
    [0, 0, 1],
  ]);
  const t = 0.6;
  nearAll(flat(rows3(new Matrix3().makeRotation(t))), [
    Math.cos(t),
    -Math.sin(t),
    0,
    Math.sin(t),
    Math.cos(t),
    0,
    0,
    0,
    1,
  ]);
  const model = new Matrix4().compose({ x: 1, y: 2, z: 3 }, new Quaternion(0.1, 0.2, 0.3, 0.9).normalize(), {
    x: 2,
    y: 3,
    z: 4,
  });
  const upper = [0, 1, 2].map((r) => [0, 1, 2].map((c) => model.elements[c * 4 + r]));
  nearAll(flat(rows3(new Matrix3().getNormalMatrix(model))), flat(transpose(inverse(upper))));
  assert.deepEqual(rows3(new Matrix3().setFromMatrix4(model)), upper);
  assert.equal(m3(R3A).equals(m3(R3A)), true);
  for (let i = 0; i < 9; i++) {
    const o = new Matrix3().copy(m3(R3A));
    o.elements[i] += 0.5;
    assert.equal(m3(R3A).equals(o), false, 'element ' + i);
    assert.equal(m3(R3A).equals(o, 0.5), true);
    assert.equal(m3(R3A).equals(o, 0.25), false);
  }
  assert.equal(m3(R3A).equals({ elements: [NaN, 0, 0, 0, 0, 0, 0, 0, 0] }, 1), false);
  assert.deepEqual(new Matrix3().fromArray([0, ...toColumnMajor(R3A)], 1).elements, m3(R3A).elements);
  const out = new Array(11).fill(-1);
  assert.equal(m3(R3A).toArray(out, 2), out);
  assert.deepEqual(out.slice(2), toColumnMajor(R3A));
  assert.deepEqual(out.slice(0, 2), [-1, -1]);
  assert.deepEqual(m3(R3A).toArray(), toColumnMajor(R3A));
});

test('Matrix4: products, determinant, inverse, transpose, scalar', () => {
  const m = new Matrix4().set(...flat(R4A));
  assert.deepEqual(rows4(m), R4A);
  assert.deepEqual(Array.from(new Matrix4().elements), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  nearAll(flat(rows4(m4(R4A).multiply(m4(R4B)))), flat(matMul(R4A, R4B)));
  nearAll(flat(rows4(m4(R4A).premultiply(m4(R4B)))), flat(matMul(R4B, R4A)));
  nearAll(flat(rows4(new Matrix4().multiplyMatrices(m4(R4A), m4(R4B)))), flat(matMul(R4A, R4B)));
  const aliased = m4(R4A);
  aliased.multiply(aliased);
  nearAll(flat(rows4(aliased)), flat(matMul(R4A, R4A)));
  near(m4(R4A).determinant(), det(R4A), 1e-9);
  nearAll(flat(rows4(m4(R4A).invert())), flat(inverse(R4A)), 1e-12);
  const singular = m4([
    [1, 2, 3, 4],
    [2, 4, 6, 8],
    [0, 1, 1, 0],
    [1, 0, 0, 1],
  ]);
  assert.equal(singular.determinant(), 0);
  assert.deepEqual(Array.from(singular.invert().elements), Array(16).fill(0));
  assert.deepEqual(rows4(m4(R4A).transpose()), transpose(R4A));
  assert.deepEqual(
    rows4(m4(R4A).multiplyScalar(3)),
    R4A.map((r) => r.map((x) => x * 3)),
  );
  assert.deepEqual(rows4(new Matrix4().copy(m4(R4A))), R4A);
  assert.deepEqual(rows4(m4(R4A).clone()), R4A);
  assert.notEqual(m4(R4A).clone().elements, m4(R4A).elements);
  assert.deepEqual(Array.from(m4(R4A).identity().elements), Array.from(new Matrix4().elements));
});

test('Matrix4: translation, scale, axis rotations and position', () => {
  assert.deepEqual(rows4(new Matrix4().makeTranslation(3, 4, 5)), [
    [1, 0, 0, 3],
    [0, 1, 0, 4],
    [0, 0, 1, 5],
    [0, 0, 0, 1],
  ]);
  assert.deepEqual(rows4(new Matrix4().makeScale(3, 4, 5)), [
    [3, 0, 0, 0],
    [0, 4, 0, 0],
    [0, 0, 5, 0],
    [0, 0, 0, 1],
  ]);
  const t = 0.6,
    c = Math.cos(t),
    s = Math.sin(t);
  nearAll(flat(rows4(new Matrix4().makeRotationX(t))), [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]);
  nearAll(flat(rows4(new Matrix4().makeRotationY(t))), [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]);
  nearAll(flat(rows4(new Matrix4().makeRotationZ(t))), [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const [axis, ref] of [
    [{ x: 1, y: 0, z: 0 }, new Matrix4().makeRotationX(t)],
    [{ x: 0, y: 1, z: 0 }, new Matrix4().makeRotationY(t)],
    [{ x: 0, y: 0, z: 1 }, new Matrix4().makeRotationZ(t)],
  ])
    nearAll(Array.from(new Matrix4().makeRotationAxis(axis, t).elements), Array.from(ref.elements));
  // a general axis: rotates the axis onto itself and a perpendicular vector by the angle
  const ax = new Vector3(1, 2, 2).normalize();
  const ra = new Matrix4().makeRotationAxis(ax, t);
  const same = ax.clone().applyMatrix4(ra);
  near(same.x, ax.x);
  near(same.y, ax.y);
  near(same.z, ax.z);
  const perp = new Vector3(2, 1, -2).normalize();
  const turned = perp.clone().applyMatrix4(ra);
  near(perp.dot(turned), Math.cos(t));
  near(new Vector3().crossVectors(perp, turned).dot(ax), Math.sin(t));
  const p = new Matrix4().setPosition(3, 4, 5);
  assert.deepEqual(Array.from(p.elements.slice(12, 15)), [3, 4, 5]);
  assert.deepEqual(Array.from(new Matrix4().setPosition({ x: 6, y: 7, z: 8 }).elements.slice(12, 15)), [6, 7, 8]);
  assert.deepEqual(Array.from(new Matrix4().setPosition(6).elements.slice(12, 15)), [6, 0, 0]);
  assert.equal(p.elements[15], 1);
});

test('Matrix4: compose, makeRotationFromQuaternion and decompose are inverse', () => {
  const q = new Quaternion(0.1, -0.4, 0.3, 0.8).normalize();
  const pos = { x: 1, y: -2, z: 3 },
    scl = { x: 2, y: 3, z: 0.5 };
  const rot = new Matrix4().makeRotationFromQuaternion(q);
  const [x, y, z, w] = q.toArray();
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  nearAll(flat(rows4(rot)), [...R[0], 0, ...R[1], 0, ...R[2], 0, 0, 0, 0, 1]);
  const composed = new Matrix4().compose(pos, q, scl);
  const expected = [
    [R[0][0] * scl.x, R[0][1] * scl.y, R[0][2] * scl.z, pos.x],
    [R[1][0] * scl.x, R[1][1] * scl.y, R[1][2] * scl.z, pos.y],
    [R[2][0] * scl.x, R[2][1] * scl.y, R[2][2] * scl.z, pos.z],
    [0, 0, 0, 1],
  ];
  nearAll(flat(rows4(composed)), flat(expected));
  for (const s of [scl, { x: -2, y: 3, z: 0.5 }]) {
    const m = new Matrix4().compose(pos, q, s);
    const p = new Vector3(),
      qq = new Quaternion(),
      ss = new Vector3();
    assert.equal(m.decompose(p, qq, ss), m);
    nearAll(p.toArray(), [pos.x, pos.y, pos.z]);
    nearAll([ss.x, ss.y, ss.z].map(Math.abs), [Math.abs(s.x), s.y, s.z]);
    assert.equal(Math.sign(ss.x * ss.y * ss.z), Math.sign(s.x * s.y * s.z));
    nearAll(Array.from(new Matrix4().compose(p, qq, ss).elements), Array.from(m.elements));
  }
  const flatScale = new Matrix4().makeScale(0, 2, 3);
  const dq = new Quaternion(),
    dp = new Vector3(),
    ds = new Vector3();
  flatScale.decompose(dp, dq, ds);
  assert.deepEqual(ds.toArray(), [0, 2, 3]);
  assert.ok(dq.toArray().every(Number.isFinite));
  assert.equal(new Matrix4().makeScale(2, 3, 4).getMaxScaleOnAxis(), 4);
  assert.equal(new Matrix4().makeScale(5, 3, 4).getMaxScaleOnAxis(), 5);
  assert.equal(new Matrix4().makeScale(2, 6, 4).getMaxScaleOnAxis(), 6);
  near(new Matrix4().makeScale(3, 4, 0).getMaxScaleOnAxis(), 4);
});

test('Matrix4: lookAt builds an orthonormal right-handed basis with +Z back toward the eye', () => {
  const cases = [
    [
      [0, 0, 5],
      [0, 0, 0],
      [0, 1, 0],
    ],
    [
      [3, 4, 5],
      [1, -1, 2],
      [0, 1, 0],
    ],
    [
      [3, 4, 5],
      [1, -1, 2],
      [1, 0, 0],
    ],
    [
      [0, 5, 0],
      [0, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, -5, 0],
      [0, 0, 0],
      [0, 1, 0],
    ],
    [
      [5, 0, 0],
      [0, 0, 0],
      [5, 0, 0],
    ],
    [
      [0, 0, 5],
      [0, 0, 0],
      [0, 0, 1],
    ],
    [
      [1, 2, 3],
      [1, 2, 3],
      [0, 1, 0],
    ],
    [
      [0, 3, 4],
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [3, 0, 4],
      [0, 0, 0],
      [0, 0, 0],
    ],
    [
      [3, 4, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
  ];
  for (const [eye, target, up] of cases) {
    const e = new Matrix4().lookAt(
      { x: eye[0], y: eye[1], z: eye[2] },
      { x: target[0], y: target[1], z: target[2] },
      { x: up[0], y: up[1], z: up[2] },
    ).elements;
    const X = [e[0], e[1], e[2]],
      Y = [e[4], e[5], e[6]],
      Z = [e[8], e[9], e[10]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    near(dot(X, X), 1);
    near(dot(Y, Y), 1);
    near(dot(Z, Z), 1);
    near(dot(X, Y), 0);
    near(dot(X, Z), 0);
    near(dot(Y, Z), 0);
    const cross = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];
    nearAll(cross, Z);
    const back = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
    const bl = Math.hypot(...back);
    nearAll(Z, bl === 0 ? [0, 0, 1] : back.map((c) => c / bl));
    if (
      up.some((c) => c !== 0) &&
      Math.hypot(
        ...cross.map(
          (_, i) => [up[1] * Z[2] - up[2] * Z[1], up[2] * Z[0] - up[0] * Z[2], up[0] * Z[1] - up[1] * Z[0]][i],
        ),
      ) > 0
    ) {
      const wantX = [up[1] * Z[2] - up[2] * Z[1], up[2] * Z[0] - up[0] * Z[2], up[0] * Z[1] - up[1] * Z[0]];
      const wl = Math.hypot(...wantX);
      nearAll(
        X,
        wantX.map((c) => c / wl),
      );
    }
    assert.equal(e[3], 0);
    assert.equal(e[12], 0);
    assert.equal(e[15], 1);
  }
});

test('Matrix4: perspective and orthographic projections map the frustum to clip space', () => {
  const l = -2,
    r = 3,
    t = 1.5,
    b = -0.5,
    n = 0.5,
    f = 20;
  const clip = (m, x, y, z) => {
    const e = m.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    return [
      (e[0] * x + e[4] * y + e[8] * z + e[12]) / w,
      (e[1] * x + e[5] * y + e[9] * z + e[13]) / w,
      (e[2] * x + e[6] * y + e[10] * z + e[14]) / w,
    ];
  };
  for (const zeroToOne of [true, false]) {
    const lo = zeroToOne ? 0 : -1;
    const persp = new Matrix4().makePerspective(l, r, t, b, n, f, zeroToOne);
    nearAll(clip(persp, l, b, -n), [-1, -1, lo]);
    nearAll(clip(persp, r, t, -n), [1, 1, lo]);
    const farScale = f / n;
    nearAll(clip(persp, l * farScale, b * farScale, -f), [-1, -1, 1], 1e-9);
    nearAll(clip(persp, r * farScale, t * farScale, -f), [1, 1, 1], 1e-9);
    const ortho = new Matrix4().makeOrthographic(l, r, t, b, n, f, zeroToOne);
    nearAll(clip(ortho, l, b, -n), [-1, -1, lo]);
    nearAll(clip(ortho, r, t, -f), [1, 1, 1]);
    nearAll(clip(ortho, (l + r) / 2, (t + b) / 2, -(n + f) / 2), [0, 0, zeroToOne ? 0.5 : 0]);
  }
  const defaults = new Matrix4().makePerspective(l, r, t, b, n, f);
  assert.deepEqual(
    Array.from(defaults.elements),
    Array.from(new Matrix4().makePerspective(l, r, t, b, n, f, true).elements),
  );
  const od = new Matrix4().makeOrthographic(l, r, t, b, n, f);
  assert.deepEqual(
    Array.from(od.elements),
    Array.from(new Matrix4().makeOrthographic(l, r, t, b, n, f, true).elements),
  );
});

test('Matrix4: equals and arrays', () => {
  assert.equal(m4(R4A).equals(m4(R4A)), true);
  for (let i = 0; i < 16; i++) {
    const o = m4(R4A);
    o.elements[i] += 0.5;
    assert.equal(m4(R4A).equals(o), false, 'element ' + i);
    assert.equal(m4(R4A).equals(o, 0.5), true);
    assert.equal(m4(R4A).equals(o, 0.25), false);
  }
  assert.deepEqual(new Matrix4().fromArray([7, ...toColumnMajor(R4A)], 1).elements, m4(R4A).elements);
  const out = new Array(20).fill(-1);
  assert.equal(m4(R4A).toArray(out, 3), out);
  assert.deepEqual(out.slice(3, 19), toColumnMajor(R4A));
  assert.equal(out[2], -1);
  assert.equal(out[19], -1);
  assert.deepEqual(m4(R4A).toArray(), toColumnMajor(R4A));
});

const ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
const axisRot = (k, a) =>
  k === 'X'
    ? new Matrix4().makeRotationX(a)
    : k === 'Y'
      ? new Matrix4().makeRotationY(a)
      : new Matrix4().makeRotationZ(a);

test('Euler: construction, set, copy, clone, vector and array forms', () => {
  const d = new Euler();
  assert.deepEqual([d.x, d.y, d.z, d.order], [0, 0, 0, 'XYZ']);
  assert.equal(d.set(1, 2, 3, 'ZYX'), d);
  assert.deepEqual([d.x, d.y, d.z, d.order], [1, 2, 3, 'ZYX']);
  d.set(4, 5, 6);
  assert.deepEqual([d.x, d.y, d.z, d.order], [4, 5, 6, 'ZYX']);
  assert.deepEqual(new Euler().copy({ x: 1, y: 2, z: 3, order: 'YXZ' }).toArray(), [1, 2, 3]);
  assert.equal(new Euler().copy({ x: 1, y: 2, z: 3, order: 'YXZ' }).order, 'YXZ');
  const c = new Euler(1, 2, 3, 'YZX').clone();
  assert.ok(c instanceof Euler);
  assert.deepEqual([c.x, c.y, c.z, c.order], [1, 2, 3, 'YZX']);
  const v = new Euler().setFromVector3({ x: 1, y: 2, z: 3 }, 'XZY');
  assert.deepEqual([v.x, v.y, v.z, v.order], [1, 2, 3, 'XZY']);
  assert.equal(new Euler(0, 0, 0, 'YXZ').setFromVector3({ x: 1, y: 2, z: 3 }).order, 'YXZ');
  assert.equal(new Euler().equals({ x: 0, y: 0, z: 0, order: 'XYZ' }), true);
  assert.equal(new Euler().equals({ x: 0, y: 0, z: 0, order: 'ZYX' }), false);
  for (const k of ['x', 'y', 'z']) {
    const o = { x: 1, y: 2, z: 3, order: 'XYZ' };
    o[k] += 0.5;
    assert.equal(new Euler(1, 2, 3).equals(o), false, k);
    assert.equal(new Euler(1, 2, 3).equals(o, 0.5), true, k);
    assert.equal(new Euler(1, 2, 3).equals(o, 0.25), false, k);
  }
  const f = new Euler(0, 0, 0, 'ZXY').fromArray([9, 1, 2, 3], 1);
  assert.deepEqual([f.x, f.y, f.z, f.order], [1, 2, 3, 'ZXY']);
  assert.deepEqual(new Euler().fromArray([1, 2, 3]).toArray(), [1, 2, 3]);
  const out = [0, 0, 0, 0, 0, 0];
  assert.equal(new Euler(1, 2, 3).toArray(out, 2), out);
  assert.deepEqual(out, [0, 0, 1, 2, 3, 0]);
});

test('Euler: setFromRotationMatrix and setFromQuaternion read back the angles of every order', () => {
  const angles = [
    [0.4, -0.7, 1.1],
    [-2.5, 0.3, 0.9],
    [3, -1.2, -2],
    [0.1, 1.5, -0.2],
    [-0.9, -1.4, 2.6],
  ];
  for (const order of ORDERS) {
    for (const [x, y, z] of angles) {
      const [a, b, c] = order.split('');
      const val = { X: x, Y: y, Z: z };
      const M = new Matrix4().multiply(axisRot(a, val[a])).multiply(axisRot(b, val[b])).multiply(axisRot(c, val[c]));
      const e = new Euler().setFromRotationMatrix(M, order);
      assert.equal(e.order, order);
      const back = new Matrix4()
        .multiply(axisRot(a, e[a.toLowerCase()]))
        .multiply(axisRot(b, e[b.toLowerCase()]))
        .multiply(axisRot(c, e[c.toLowerCase()]));
      nearAll(Array.from(back.elements), Array.from(M.elements));
      assert.ok(Math.abs(e[b.toLowerCase()]) <= Math.PI / 2 + 1e-12);
      // the 3x3 form and the quaternion form read the same angles
      const m3e = new Matrix3().setFromMatrix4(M);
      const e3 = new Euler().setFromRotationMatrix(m3e, order);
      nearAll(e3.toArray(), e.toArray());
      const q = new Quaternion().setFromEuler({ x, y, z, order });
      const eq = new Euler().setFromQuaternion(q, order);
      assert.equal(eq.order, order);
      nearAll(eq.toArray(), e.toArray(), 1e-9);
      nearAll(new Euler().setFromQuaternion(new Quaternion(-q.x, -q.y, -q.z, -q.w), order).toArray(), eq.toArray());
    }
    // the receiver's order is the default
    const keep = new Euler(0, 0, 0, order).setFromRotationMatrix(new Matrix4());
    assert.equal(keep.order, order);
    assert.equal(new Euler(0, 0, 0, order).setFromQuaternion(new Quaternion()).order, order);
  }
  // gimbal poles: the triple still rebuilds the matrix, and the last angle is 0
  for (const order of ORDERS) {
    const [a, b, c] = order.split('');
    for (const sign of [1, -1]) {
      const M = new Matrix4()
        .multiply(axisRot(a, 0.8))
        .multiply(axisRot(b, (sign * Math.PI) / 2))
        .multiply(axisRot(c, 0.5));
      const e = new Euler().setFromRotationMatrix(M, order);
      const back = new Matrix4()
        .multiply(axisRot(a, e[a.toLowerCase()]))
        .multiply(axisRot(b, e[b.toLowerCase()]))
        .multiply(axisRot(c, e[c.toLowerCase()]));
      nearAll(Array.from(back.elements), Array.from(M.elements), 1e-9);
    }
  }
  assert.throws(() => new Euler().setFromRotationMatrix(new Matrix4(), 'XXY'));
});

test('Matrix4.decompose reads a zero scale column as a zero axis', () => {
  for (const scale of [
    [0, 2, 3],
    [2, 0, 3],
    [2, 3, 0],
  ]) {
    const q = new Quaternion(),
      p = new Vector3(),
      s = new Vector3();
    new Matrix4().makeScale(...scale).decompose(p, q, s);
    assert.deepEqual(s.toArray(), scale);
    // the rotation matrix keeps the two unit axes and a zero third column: trace 2, so w = sqrt(3) / 2
    near(q.w, Math.sqrt(3) / 2);
    near(q.x, 0);
    near(q.y, 0);
    near(q.z, 0);
  }
});

test('Matrix4.lookAt picks the perpendicular +X for a parallel up from the axis least aligned with the back direction', () => {
  const sqrt = Math.sqrt;
  const unit = (v) => {
    const l = Math.hypot(...v);
    return v.map((c) => c / l);
  };
  // [back vector, expected +X direction] (target at the origin, eye = back, up = back)
  const cases = [
    [
      [1, 1, 2],
      [0, -2, 1],
    ],
    [
      [1, 2, 1],
      [0, -1, 2],
    ],
    [
      [2, 1, 1],
      [1, 0, -2],
    ],
    [
      [2, 3, 1],
      [-3, 2, 0],
    ],
    [
      [3, 2, 1],
      [-2, 3, 0],
    ],
    [
      [1, 3, 2],
      [0, -2, 3],
    ],
    [
      [2, 1, 3],
      [3, 0, -2],
    ],
  ];
  for (const [back, x] of cases) {
    const u = unit(back);
    // the same floats as the back direction, so the cross product is exactly zero
    const e = new Matrix4().lookAt(
      { x: back[0], y: back[1], z: back[2] },
      { x: 0, y: 0, z: 0 },
      { x: u[0], y: u[1], z: u[2] },
    ).elements;
    nearAll([e[0], e[1], e[2]], unit(x));
    nearAll([e[8], e[9], e[10]], unit(back));
  }
});

test('Matrix4.getMaxScaleOnAxis uses the longest column of a rotated, sheared matrix', () => {
  const cols = (a, b, c) => new Matrix4().fromArray([...a, 0, ...b, 0, ...c, 0, 0, 0, 0, 1]);
  near(cols([1, 2, 2], [0, 3, 4], [2, 3, 6]).getMaxScaleOnAxis(), 7);
  near(cols([2, 3, 6], [1, 2, 2], [0, 3, 4]).getMaxScaleOnAxis(), 7);
  near(cols([0, 3, 4], [2, 3, 6], [1, 2, 2]).getMaxScaleOnAxis(), 7);
  near(cols([6, 2, 3], [1, 2, 2], [0, 3, 4]).getMaxScaleOnAxis(), 7);
  near(cols([1, 2, 2], [3, 6, 2], [0, 3, 4]).getMaxScaleOnAxis(), 7);
  near(cols([1, 2, 2], [0, 3, 4], [2, 6, 3]).getMaxScaleOnAxis(), 7);
});

test('Matrix4.makeOrthographic centres an off-centre box on the origin', () => {
  const m = new Matrix4().makeOrthographic(-1, 4, 2, -0.5, 1, 6, true);
  const c = (x, y, z) => {
    const e = m.elements;
    return [e[0] * x + e[12], e[5] * y + e[13], e[10] * z + e[14]];
  };
  nearAll(c(1.5, 0.75, -3.5), [0, 0, 0.5]);
  nearAll(c(-1, -0.5, -1), [-1, -1, 0]);
  nearAll(c(4, 2, -6), [1, 1, 1]);
  const gl = new Matrix4().makeOrthographic(-1, 4, 2, -0.5, 1, 6, false).elements;
  near(gl[10], -2 / 5);
  near(gl[14], -7 / 5);
});

test('Euler.setFromRotationMatrix clamps the middle sine of an unnormalised matrix to [-1, 1]', () => {
  const idx = { X: 0, Y: 1, Z: 2 };
  for (const order of ORDERS) {
    const [a, b, c] = order.split('').map((k) => idx[k]);
    const sign = (b - a + 3) % 3 === 1 ? 1 : -1;
    for (const big of [2, -2]) {
      const m = new Matrix4();
      // row a, column c of the matrix holds sign * sin(B): push it past 1 in magnitude
      m.elements[c * 4 + a] = sign * big;
      const e = new Euler().setFromRotationMatrix(m, order);
      const middle = [e.x, e.y, e.z][b];
      near(middle, (Math.sign(big) * Math.PI) / 4, 1e-12, order + ' ' + big);
    }
  }
});
