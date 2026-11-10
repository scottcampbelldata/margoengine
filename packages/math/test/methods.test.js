import { Matrix4, Vector3, Quaternion, Ray, Plane, Box3, Color } from '@margoengine/math/compat';
import test from 'node:test';
import assert from 'node:assert/strict';

const near = (a, b, e = 1e-12) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);
const vector = (a, b) => ['x', 'y', 'z'].forEach((k) => near(a[k], b[k]));
const v = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);

test('matrix bases, scale extraction, copyPosition and six shear coefficients', () => {
  const m = new Matrix4().makeBasis(v(1, 2, 3), v(4, 5, 6), v(7, 8, 9));
  const x = v(),
    y = v(),
    z = v();
  assert.equal(m.extractBasis(x, y, z), m);
  vector(x, v(1, 2, 3));
  vector(y, v(4, 5, 6));
  vector(z, v(7, 8, 9));
  const before = [...m.elements];
  m.copyPosition(new Matrix4().makeTranslation(2, 3, 4));
  assert.deepEqual([...m.elements].slice(0, 12), before.slice(0, 12));
  vector(v().setFromMatrixPosition(m), v(2, 3, 4));
  const r = new Matrix4().makeRotationY(0.6),
    scaled = r
      .clone()
      .multiply(new Matrix4().makeScale(2, 3, 4))
      .setPosition(9, 8, 7);
  assert.ok(new Matrix4().extractRotation(scaled).equals(r, 1e-12));
  assert.ok(scaled.extractRotation(scaled).equals(r, 1e-12), 'self alias');
  assert.ok([...new Matrix4().extractRotation(new Matrix4().makeScale(0, 2, 3)).elements].every(Number.isFinite));
  const shear = new Matrix4().makeShear(1, 2, 3, 4, 5, 6);
  vector(v(1, 0, 0).applyMatrix4(shear), v(1, 1, 2));
  vector(v(0, 1, 0).applyMatrix4(shear), v(3, 1, 4));
  vector(v(0, 0, 1).applyMatrix4(shear), v(5, 6, 1));
});

test('all six Euler orders match independently composed axis rotations', () => {
  for (const order of ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX']) {
    const e = { x: 0.4, y: -0.7, z: 1.1, order };
    const expected = new Matrix4();
    for (const axis of order) expected.multiply(new Matrix4()[`makeRotation${axis}`](e[axis.toLowerCase()]));
    assert.ok(new Matrix4().makeRotationFromEuler(e).equals(expected, 1e-12));
    vector(v(2, 3, 4).applyEuler(e), v(2, 3, 4).applyMatrix4(expected));
  }
  vector(v(2, 0, 0).applyAxisAngle(v(0, 0, 1), Math.PI / 2), v(0, 2, 0));
  assert.throws(() => new Matrix4().makeRotationFromEuler({ x: 0, y: 0, z: 0, order: 'bad' }), RangeError);
});

test('project/unproject: separate and native cameras, both depth ranges and behind camera', () => {
  for (const depth of [true, false]) {
    const projectionMatrix = new Matrix4().makePerspective(-1, 1, 1, -1, 1, 10, depth);
    const matrixWorld = new Matrix4().makeTranslation(2, 3, 4),
      matrixWorldInverse = matrixWorld.clone().invert();
    const camera = {
      projectionMatrix,
      projectionMatrixInverse: projectionMatrix.clone().invert(),
      matrixWorld,
      matrixWorldInverse,
    };
    const native = { matrix: projectionMatrix.clone().multiply(matrixWorldInverse).elements };
    for (const p of [v(2, 3, 3), v(3, 4, -1), v(2, 3, 5)]) {
      const projected = p.clone().project(camera);
      vector(p.clone().project(native), projected);
      vector(projected.clone().unproject(camera), p);
      vector(projected.clone().unproject(native), p);
    }
  }
  assert.throws(() => v().unproject({ matrix: new Float64Array(16) }), RangeError);
});

test('axis-angle extraction: identity, zero, negative identity, tiny and scaled rotations', () => {
  for (const angle of [1e-14, 0.7, Math.PI, 5.5]) {
    const axis = v(1, 2, 3).normalize(),
      q = new Quaternion().setFromAxisAngle(axis, angle);
    const out = v();
    near(q.toAxisAngle(out), angle);
    vector(out, axis);
    q.set(q.x * 3, q.y * 3, q.z * 3, q.w * 3);
    near(q.toAxisAngle(out), angle);
    vector(out, axis);
  }
  for (const q of [new Quaternion(), new Quaternion(0, 0, 0, 0), new Quaternion(0, 0, 0, -1)]) {
    const axis = v();
    near(q.toAxisAngle(axis), q.w < 0 ? 2 * Math.PI : 0);
    vector(axis, v(1, 0, 0));
  }
});

test('ray segment closest points cover interior, boundaries, parallel, degenerate and nearly parallel', () => {
  const ray = new Ray(v(), v(1, 0, 0)),
    r = v(),
    s = v();
  const cases = [
    [v(2, -1, 3), v(2, 1, 3), 9, v(2, 0, 0), v(2, 0, 3)],
    [v(-2, -1, 0), v(-2, 1, 0), 4, v(), v(-2, 0, 0)],
    [v(2, 2, 0), v(3, 3, 0), 4, v(2, 0, 0), v(2, 2, 0)],
    [v(2, 1, 0), v(4, 1, 0), 1, v(2, 0, 0), v(2, 1, 0)],
    [v(2, 3, 4), v(2, 3, 4), 25, v(2, 0, 0), v(2, 3, 4)],
  ];
  for (const [a, b, d, er, es] of cases) {
    near(ray.distanceSqToSegment(a, b, r, s), d);
    vector(r, er);
    vector(s, es);
    near(ray.distanceSqToSegment(b, a), d);
  }
  near(new Ray(v(0, 1, 0), v(0, 0, 0)).distanceSqToSegment(v(-1, 0, 0), v(1, 0, 0)), 1);
  const almost = new Ray(v(), v(1, 1e-10, 0).normalize());
  near(almost.distanceSqToSegment(v(0, 1e-10, 0), v(2, 1e-10, 0), r, s), 0);
  vector(r, v(1, 1e-10, 0));
  vector(r, s);
  // Deterministic grid oracle bounds the analytic minimizer and checks its returned points.
  for (let i = 0; i < 80; i++) {
    const a = v(Math.sin(i) * 3, Math.cos(i) * 2, Math.sin(i * 7)),
      b = v(Math.cos(i * 2) * 3, Math.sin(i * 3) * 2, Math.cos(i * 5));
    const distance = ray.distanceSqToSegment(a, b, r, s);
    near(r.distanceToSquared(s), distance);
    assert.ok(r.x >= 0);
    near(r.y, 0);
    near(r.z, 0);
    for (let j = 0; j <= 40; j++) {
      const p = a.clone().lerp(b, j / 40);
      assert.ok(distance <= ray.distanceSqToPoint(p) + 1e-12);
    }
  }
});

test('plane intersectLine uses the closed segment and preserves output on misses', () => {
  const plane = new Plane(v(0, 1, 0), -2),
    out = v(9, 9, 9);
  assert.equal(plane.intersectLine({ start: v(0, 0, 0), end: v(4, 4, 0) }, out), out);
  vector(out, v(2, 2, 0));
  for (const line of [
    { start: v(0, 2, 0), end: v(1, 2, 0) },
    { start: v(0, 2, 0), end: v(0, 2, 0) },
    { start: v(), end: v(0, 2, 0) },
  ])
    assert.ok(plane.intersectLine(line, out));
  out.set(9, 9, 9);
  for (const line of [
    { start: v(), end: v(1, 0, 0) },
    { start: v(), end: v(0, 1, 0) },
    { start: v(), end: v() },
  ]) {
    assert.equal(plane.intersectLine(line, out), null);
    vector(out, v(9, 9, 9));
  }
});

test('box triangle SAT rejects corner misses, accepts touching and degeneracies', () => {
  const box = new Box3(v(-1, -1, -1), v(1, 1, 1));
  const cases = [
    [[v(0, 0, 0), v(1, 0, 0), v(0, 1, 0)], true],
    [[v(-4, -4, 0), v(4, -4, 0), v(0, 4, 0)], true],
    [[v(2, 0, 0), v(0, 2, 0), v(2, 2, 0)], true],
    [[v(2.1, 0, 0), v(0, 2.1, 0), v(2.1, 2.1, 0)], false],
    [[v(1, 1, 1), v(2, 1, 1), v(1, 2, 1)], true],
    [[v(0, 0, 2), v(0, 0, 2), v(0, 0, 2)], false],
    [[v(), v(), v()], true],
    [[v(-2, 0, 0), v(2, 0, 0), v(2, 0, 0)], true],
    [[v(2, 2, 2), v(3, 3, 3), v(4, 4, 4)], false],
  ];
  for (const [vertices, expected] of cases)
    for (let i = 0; i < 3; i++) {
      const [a, b, c] = [vertices[i], vertices[(i + 1) % 3], vertices[(i + 2) % 3]];
      assert.equal(box.intersectsTriangle({ a, b, c }), expected);
      assert.equal(box.intersectsTriangle({ a: c, b, c: a }), expected);
    }
  assert.equal(new Box3().intersectsTriangle({ a: v(), b: v(), c: v() }), false);
});

test('CSS styles and HSL offsets/interpolation respect color spaces and direct hue path', () => {
  assert.equal(new Color('#ff8000').getStyle(), 'rgb(255,128,0)');
  assert.equal(new Color(2, -1, 0.5).getStyle(), 'rgb(255,0,188)');
  assert.equal(new Color(0.1, 0.2, 0.3).getStyle('srgb-linear'), 'color(srgb-linear 0.100 0.200 0.300)');
  const original = new Color().setHSL(0.9, 0.3, 0.4, 'srgb-linear');
  const shifted = original.clone().offsetHSL(0.2, 0.1, 0.2).getHSL({ h: 0, s: 0, l: 0 }, 'srgb-linear');
  near(shifted.h, 0.1);
  near(shifted.s, 0.4);
  near(shifted.l, 0.6);
  const target = new Color().setHSL(0.1, 0.7, 0.8, 'srgb-linear');
  const middle = original.clone().lerpHSL(target, 0.5).getHSL({ h: 0, s: 0, l: 0 }, 'srgb-linear');
  near(middle.h, 0.5);
  near(middle.s, 0.5);
  near(middle.l, 0.6);
  assert.ok(original.clone().lerpHSL(target, 0).equals(original, 1e-12));
  assert.ok(original.clone().lerpHSL(target, 1).equals(target, 1e-12));
  assert.ok(
    original
      .clone()
      .offsetHSL(0, 0, 4)
      .equals(new Color(1, 1, 1), 1e-12),
  );
  const p3 = new Color().setRGB(0.8, 0.2, 0.1, 'display-p3');
  assert.ok(new Color(p3.getStyle('display-p3')).equals(p3, 1e-12));
});
