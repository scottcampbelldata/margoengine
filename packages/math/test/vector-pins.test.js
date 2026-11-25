// Pins every Vector2, Vector3 and Vector4 method against a plain per-component reference with distinct, exactly
// representable values, so a swapped operator, a wrong component or a wrong constant in any of them changes a result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector2, Vector3, Vector4 } from '../dist/index.js';

const A = [3, -5, 7, 2];
const B = [-2, 4, 1, 6];
const C = [0.5, 8, -3, 9];
const near = (a, b, e = 1e-12) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const arr = (v, n) => [v.x, v.y, v.z, v.w].slice(0, n);

for (const [Ctor, n] of [
  [Vector2, 2],
  [Vector3, 3],
  [Vector4, 4],
]) {
  const a = A.slice(0, n),
    b = B.slice(0, n),
    c = C.slice(0, n);
  const mk = (v) => new Ctor(...v);
  const map2 = (f) => a.map((x, i) => f(x, b[i], i));
  test(`Vector${n}: construction, set, copy, clone and defaults`, () => {
    assert.deepEqual(arr(new Ctor(), n), n === 4 ? [0, 0, 0, 1] : Array(n).fill(0));
    assert.deepEqual(arr(mk(a), n), a);
    const v = new Ctor();
    assert.equal(v.set(...a), v);
    assert.deepEqual(arr(v, n), a);
    assert.equal(v.setScalar(9), v);
    assert.deepEqual(arr(v, n), Array(n).fill(9));
    assert.deepEqual(arr(new Ctor().copy(mk(b)), n), b);
    const k = mk(a).clone();
    assert.ok(k instanceof Ctor);
    assert.deepEqual(arr(k, n), a);
  });
  test(`Vector${n}: arithmetic matches the per-component reference`, () => {
    assert.deepEqual(
      arr(mk(a).add(mk(b)), n),
      map2((x, y) => x + y),
    );
    assert.deepEqual(
      arr(mk(a).sub(mk(b)), n),
      map2((x, y) => x - y),
    );
    assert.deepEqual(
      arr(mk(a).multiply(mk(b)), n),
      map2((x, y) => x * y),
    );
    assert.deepEqual(
      arr(mk(a).addScaledVector(mk(b), 3), n),
      map2((x, y) => x + y * 3),
    );
    assert.deepEqual(
      arr(mk(a).multiplyScalar(4), n),
      a.map((x) => x * 4),
    );
    assert.deepEqual(
      arr(mk(a).divideScalar(4), n),
      a.map((x) => x / 4),
    );
    assert.deepEqual(
      arr(mk(a).negate(), n),
      a.map((x) => -x),
    );
    assert.deepEqual(arr(mk(a).min(mk(b)), n), map2(Math.min));
    assert.deepEqual(arr(mk(a).max(mk(b)), n), map2(Math.max));
    assert.deepEqual(
      arr(mk(a).lerp(mk(b), 0.25), n),
      map2((x, y) => x + (y - x) * 0.25),
    );
    assert.equal(
      mk(a).dot(mk(b)),
      a.reduce((s, x, i) => s + x * b[i], 0),
    );
    assert.equal(
      mk(a).lengthSq(),
      a.reduce((s, x) => s + x * x, 0),
    );
    near(mk(a).length(), Math.sqrt(a.reduce((s, x) => s + x * x, 0)));
    const unit = mk(a).normalize();
    near(unit.length(), 1);
    near(unit.x, a[0] / Math.sqrt(a.reduce((s, x) => s + x * x, 0)));
    assert.deepEqual(arr(mk(Array(n).fill(0)).normalize(), n), Array(n).fill(0));
  });
  test(`Vector${n}: equals, arrays and chaining`, () => {
    assert.equal(mk(a).equals(mk(a)), true);
    assert.equal(mk(a).equals(mk(b)), false);
    for (let i = 0; i < n; i++) {
      const off = a.slice();
      off[i] += 0.5;
      assert.equal(mk(a).equals(mk(off)), false, 'component ' + i);
      assert.equal(mk(a).equals(mk(off), 0.5), true);
      assert.equal(mk(a).equals(mk(off), 0.25), false);
    }
    assert.deepEqual(mk(a).toArray(), a);
    const out = [9, 9, 9, 9, 9, 9, 9, 9];
    assert.equal(mk(a).toArray(out, 2), out);
    assert.deepEqual(out, [9, 9, ...a, ...Array(8 - 2 - n).fill(9)]);
    assert.deepEqual(arr(new Ctor().fromArray([0, 0, ...b, 0, 0], 2), n), b);
    assert.deepEqual(arr(new Ctor().fromArray(b), n), b);
    const v = mk(a);
    assert.equal(v.add(mk(c)), v);
    assert.equal(v.normalize(), v);
  });
}

test('Vector2 and Vector3 per-component helpers and geometry', () => {
  for (const [Ctor, n] of [
    [Vector2, 2],
    [Vector3, 3],
  ]) {
    const a = A.slice(0, n),
      b = B.slice(0, n),
      c = C.slice(0, n);
    const mk = (v) => new Ctor(...v);
    assert.deepEqual(
      arr(mk(a).addScalar(5), n),
      a.map((x) => x + 5),
    );
    assert.deepEqual(
      arr(new Ctor().addVectors(mk(a), mk(b)), n),
      a.map((x, i) => x + b[i]),
    );
    assert.deepEqual(
      arr(new Ctor().subVectors(mk(a), mk(b)), n),
      a.map((x, i) => x - b[i]),
    );
    assert.deepEqual(
      arr(mk(a).divide(mk(c)), n),
      a.map((x, i) => x / c[i]),
    );
    assert.deepEqual(
      arr(new Ctor().lerpVectors(mk(a), mk(b), 0.25), n),
      a.map((x, i) => x + (b[i] - x) * 0.25),
    );
    assert.deepEqual(
      arr(mk(a).clamp(mk([-1, -1, -1]), mk([2, 2, 2])), n),
      a.map((x) => Math.min(2, Math.max(-1, x))),
    );
    assert.equal(
      mk(a).manhattanLength(),
      a.reduce((s, x) => s + Math.abs(x), 0),
    );
    near(mk(a).distanceTo(mk(b)), Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0)));
    assert.equal(
      mk(a).distanceToSquared(mk(b)),
      a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0),
    );
    const v = mk(a).setLength(10);
    near(v.length(), 10);
    near(v.x / v.y, a[0] / a[1]);
  }
});

test('Vector2: cross, angle, rotateAround and applyMatrix3', () => {
  assert.equal(new Vector2(3, -5).cross(new Vector2(-2, 4)), 3 * 4 - -5 * -2);
  near(new Vector2(0, 1).angle(), Math.PI / 2);
  near(new Vector2(-1, 0).angle(), Math.PI);
  near(new Vector2(0, -1).angle(), (3 * Math.PI) / 2);
  assert.equal(new Vector2(0, 0).angle(), 0);
  assert.equal(new Vector2(-1, -0).angle(), Math.PI);
  assert.equal(Object.is(new Vector2(1, -0).angle(), 0), true);
  assert.equal(new Vector2(1, -1e-300).angle(), 0);
  assert.ok(Number.isNaN(new Vector2(NaN, 1).angle()));
  const r = new Vector2(3, 2).rotateAround(new Vector2(1, 1), Math.PI / 2);
  near(r.x, 0);
  near(r.y, 3);
  const q = new Vector2(2, 3).applyMatrix3({ elements: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  assert.deepEqual([q.x, q.y], [1 * 2 + 4 * 3 + 7, 2 * 2 + 5 * 3 + 8]);
});

test('Vector3: cross, angleTo, projections, matrices, quaternion and spherical', () => {
  const a = new Vector3(3, -5, 7),
    b = new Vector3(-2, 4, 1);
  assert.deepEqual(a.clone().cross(b).toArray(), [-5 * 1 - 7 * 4, 7 * -2 - 3 * 1, 3 * 4 - -5 * -2]);
  assert.deepEqual(new Vector3().crossVectors(a, b).toArray(), [-33, -17, 2]);
  near(new Vector3(1, 0, 0).angleTo(new Vector3(0, 2, 0)), Math.PI / 2);
  near(new Vector3(1, 0, 0).angleTo(new Vector3(1, 1, 0)), Math.PI / 4);
  near(new Vector3(1, 0, 0).angleTo(new Vector3(-3, 0, 0)), Math.PI);
  assert.equal(new Vector3(1, 0, 0).angleTo(new Vector3(2, 0, 0)), 0);
  assert.equal(new Vector3(0, 0, 0).angleTo(new Vector3(1, 0, 0)), Math.PI / 2);
  assert.equal(new Vector3(0, 1, 0).angleTo(new Vector3(0, 0, 0)), Math.PI / 2);
  assert.equal(new Vector3(0, 0, 1).angleTo(new Vector3(0, 0, 0)), Math.PI / 2);
  assert.equal(new Vector3(1, 0, 0).angleTo(new Vector3(0, 0, 0)), Math.PI / 2);
  assert.equal(new Vector3(0, 0, 0).angleTo(new Vector3(0, 1, 0)), Math.PI / 2);
  assert.equal(new Vector3(0, 0, 0).angleTo(new Vector3(0, 0, 1)), Math.PI / 2);
  near(new Vector3(0, 0, 1).angleTo(new Vector3(0, 1, 0)), Math.PI / 2);
  const p = new Vector3(3, 4, 5).projectOnVector(new Vector3(0, 2, 0));
  assert.deepEqual(p.toArray(), [0, 4, 0]);
  assert.deepEqual(new Vector3(3, 4, 5).projectOnVector(new Vector3(0, 0, 0)).toArray(), [0, 0, 0]);
  assert.deepEqual(new Vector3(3, 4, 5).projectOnPlane(new Vector3(0, 2, 0)).toArray(), [3, 0, 5]);
  assert.deepEqual(new Vector3(3, 4, 5).projectOnPlane(new Vector3(0, 0, 0)).toArray(), [3, 4, 5]);
  assert.deepEqual(new Vector3(3, 4, 5).reflect(new Vector3(0, 1, 0)).toArray(), [3, -4, 5]);
  const e = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(new Vector3(1, 10, 100).applyMatrix3({ elements: e }).toArray(), [
    1 + 40 + 700,
    2 + 50 + 800,
    3 + 60 + 900,
  ]);
  const m = [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 1];
  assert.deepEqual(new Vector3(1, 10, 100).applyMatrix4({ elements: m }).toArray(), [
    1 + 40 + 700 + 10,
    2 + 50 + 800 + 11,
    3 + 60 + 900 + 12,
  ]);
  const persp = m.slice();
  persp[15] = 2;
  persp[3] = 0.5;
  persp[7] = 0.25;
  persp[11] = 0.125;
  const w = 1 / (0.5 * 1 + 0.25 * 10 + 0.125 * 100 + 2);
  const r = new Vector3(1, 10, 100).applyMatrix4({ elements: persp });
  near(r.x, (1 + 40 + 700 + 10) * w);
  near(r.y, (2 + 50 + 800 + 11) * w);
  near(r.z, (3 + 60 + 900 + 12) * w);
  const d = new Vector3(1, 10, 100).transformDirection({ elements: m });
  const raw = [1 + 40 + 700, 2 + 50 + 800, 3 + 60 + 900];
  const len = Math.hypot(...raw);
  raw.forEach((x, i) => near(d.toArray()[i], x / len));
  const s = Math.SQRT1_2;
  const rot = new Vector3(1, 0, 0).applyQuaternion({ x: 0, y: 0, z: s, w: s });
  near(rot.x, 0);
  near(rot.y, 1);
  near(rot.z, 0);
  assert.deepEqual(new Vector3().setFromMatrixPosition({ elements: m }).toArray(), [10, 11, 12]);
  assert.deepEqual(new Vector3().setFromMatrixColumn({ elements: m }, 1).toArray(), [4, 5, 6]);
  assert.deepEqual(
    new Vector3().setFromMatrixColumn({ elements: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, 2).toArray(),
    [7, 8, 9],
  );
  const sc = new Vector3().setFromMatrixScale({ elements: m });
  near(sc.x, Math.hypot(1, 2, 3));
  near(sc.y, Math.hypot(4, 5, 6));
  near(sc.z, Math.hypot(7, 8, 9));
  const sp = new Vector3().setFromSpherical({ radius: 2, phi: Math.PI / 3, theta: Math.PI / 6 });
  near(sp.x, 2 * Math.sin(Math.PI / 3) * Math.sin(Math.PI / 6));
  near(sp.y, 2 * Math.cos(Math.PI / 3));
  near(sp.z, 2 * Math.sin(Math.PI / 3) * Math.cos(Math.PI / 6));
});

test('Vector3 and Vector4 length use hypot at the overflow and underflow edges', () => {
  near(new Vector3(1e200, 1e200, 0).length() / 1e200, Math.SQRT2, 1e-12);
  near(new Vector3(1e-200, 1e-200, 0).length() / 1e-200, Math.SQRT2, 1e-12);
  near(new Vector4(1e200, 1e200, 1e200, 1e200).length() / 1e200, 2, 1e-12);
  near(new Vector4(1e-200, 1e-200, 1e-200, 1e-200).length() / 1e-200, 2, 1e-12);
  assert.equal(new Vector3(3, 4, 0).length(), 5);
  assert.equal(new Vector4(2, 2, 2, 2).length(), 4);
});

test('Vector4: applyMatrix4 multiplies the full 4x4', () => {
  const m = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const v = new Vector4(1, 10, 100, 1000).applyMatrix4({ elements: m });
  assert.deepEqual(v.toArray(), [
    1 + 50 + 900 + 13000,
    2 + 60 + 1000 + 14000,
    3 + 70 + 1100 + 15000,
    4 + 80 + 1200 + 16000,
  ]);
});

test('Vector3 projections with a slanted axis and non-unit lengths', () => {
  const a = new Vector3(3, 4, 5);
  const onto = new Vector3(1, 3, 4);
  const s = (3 + 12 + 20) / (1 + 9 + 16);
  const p = a.clone().projectOnVector(onto);
  near(p.x, s);
  near(p.y, 3 * s);
  near(p.z, 4 * s);
  const q = a.clone().projectOnPlane(onto);
  near(q.x, 3 - s);
  near(q.y, 4 - 3 * s);
  near(q.z, 5 - 4 * s);
  near(q.dot(onto), 0, 1e-12);
  assert.deepEqual(
    a
      .clone()
      .projectOnVector(new Vector3(0, 0, 2))
      .toArray(),
    [0, 0, 5],
  );
  assert.deepEqual(
    a
      .clone()
      .projectOnPlane(new Vector3(2, 0, 0))
      .toArray(),
    [0, 4, 5],
  );
  assert.deepEqual(
    a
      .clone()
      .projectOnPlane(new Vector3(0, 0, 3))
      .toArray(),
    [3, 4, 0],
  );
  assert.deepEqual(
    a
      .clone()
      .projectOnVector(new Vector3(3, 0, 0))
      .toArray(),
    [3, 0, 0],
  );
  assert.deepEqual(
    a
      .clone()
      .projectOnVector(new Vector3(0, 0, 0))
      .toArray(),
    [0, 0, 0],
  );
});

test('Vector2.rotateAround with a generic angle and centre', () => {
  const v = new Vector2(3, 2).rotateAround(new Vector2(1, -1), 0.7);
  const c = Math.cos(0.7),
    s = Math.sin(0.7);
  near(v.x, 2 * c - 3 * s + 1);
  near(v.y, 2 * s + 3 * c - 1);
});
