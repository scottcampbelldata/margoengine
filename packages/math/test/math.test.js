import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera, PbrMaterial } from '@margoengine/core';
import {
  Vector2,
  Vector3,
  Vector4,
  Quaternion,
  Euler,
  Matrix3,
  Matrix4,
  Color,
  SRGBToLinear,
  LinearToSRGB,
  Box3,
  Sphere,
  Plane,
  Ray,
  Frustum,
  Spherical,
  MathUtils,
} from '../dist/index.js';

const near = (actual, expected, epsilon = 1e-9, message = '') =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message} ${actual} != ${expected}`);
const nearArray = (actual, expected, epsilon = 1e-9) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => near(v, expected[i], epsilon, `[${i}]`));
};
const random = MathUtils.createRandom(42);
const randomQuaternion = () =>
  new Quaternion(random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5).normalize();
const sameRotation = (a, b, epsilon = 1e-9) => near(Math.abs(a.dot(b)), 1, epsilon, 'rotation');
const ORDERS = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];

test('vectors: arithmetic, products and transforms', () => {
  const v = new Vector3(1, 2, 3);
  assert.equal(v.dot(new Vector3(4, 5, 6)), 32);
  assert.deepEqual(new Vector3(1, 0, 0).cross(new Vector3(0, 1, 0)).toArray(), [0, 0, 1]);
  near(new Vector3(3, 4, 0).length(), 5);
  assert.deepEqual(new Vector3().normalize().toArray(), [0, 0, 0], 'zero stays zero');
  near(new Vector3(1, 0, 0).angleTo(new Vector3(0, 1, 0)), Math.PI / 2);
  assert.deepEqual(new Vector3(1, 1, 0).reflect(new Vector3(0, 1, 0)).toArray(), [1, -1, 0]);
  assert.deepEqual(new Vector3(2, 3, 4).projectOnPlane(new Vector3(0, 1, 0)).toArray(), [2, 0, 4]);
  const turned = new Vector3(1, 0, 0).applyQuaternion(
    new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2),
  );
  nearArray(turned.toArray(), [0, 1, 0]);
  assert.deepEqual(
    new Vector3(1, 2, 3).applyMatrix4(new Matrix4().makeTranslation(10, 20, 30)).toArray(),
    [11, 22, 33],
  );
  nearArray(new Vector3().setFromSpherical(new Spherical(2, Math.PI / 2, 0)).toArray(), [0, 0, 2]);
  const s = new Spherical().setFromVector3(new Vector3(1, 2, 3));
  nearArray(new Vector3().setFromSpherical(s).toArray(), [1, 2, 3]);
  near(new Vector2(0, 1).angle(), Math.PI / 2);
  nearArray(new Vector2(1, 0).rotateAround(new Vector2(), Math.PI / 2).toArray(), [0, 1]);
  assert.deepEqual(new Vector2(1, 2).applyMatrix3(new Matrix3().makeTranslation(5, 6)).toArray(), [6, 8]);
  assert.deepEqual(new Vector4(1, 2, 3, 1).applyMatrix4(new Matrix4().makeScale(2, 2, 2)).toArray(), [2, 4, 6, 1]);
  const out = new Float32Array(5);
  assert.equal(new Vector3(7, 8, 9).toArray(out, 2), out);
  assert.deepEqual(Array.from(out), [0, 0, 7, 8, 9]);
  assert.deepEqual(new Vector3().fromArray(out, 2).toArray(), [7, 8, 9]);
});

test('Matrix4 inverse, determinant, transpose and multiply identities', () => {
  for (let n = 0; n < 50; n++) {
    const m = new Matrix4().fromArray(Array.from({ length: 16 }, () => random() * 4 - 2));
    const product = m.clone().multiply(m.clone().invert());
    nearArray(Array.from(product.elements), Array.from(new Matrix4().elements), 1e-8);
    near(m.clone().invert().determinant(), 1 / m.determinant(), Math.abs(1e-8 / m.determinant()));
    nearArray(Array.from(m.clone().transpose().transpose().elements), Array.from(m.elements), 0);
  }
  near(new Matrix4().makeScale(2, 3, 4).determinant(), 24);
  assert.ok(
    new Matrix4()
      .makeScale(1, 0, 1)
      .invert()
      .elements.every((v) => v === 0),
    'singular inverts to zeros',
  );
  // Multiply order: (T * R) applies R first.
  const tr = new Matrix4().makeTranslation(5, 0, 0).multiply(new Matrix4().makeRotationZ(Math.PI / 2));
  nearArray(new Vector3(1, 0, 0).applyMatrix4(tr).toArray(), [5, 1, 0]);
  const rt = new Matrix4().makeRotationZ(Math.PI / 2).premultiply(new Matrix4().makeTranslation(5, 0, 0));
  nearArray(Array.from(rt.elements), Array.from(tr.elements));
  const axis = new Vector3(1, 2, 3).normalize();
  nearArray(
    Array.from(new Matrix4().makeRotationAxis(axis, 0.7).elements),
    Array.from(new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromAxisAngle(axis, 0.7)).elements),
  );
});

test('Matrix4 compose and decompose round-trip, including a mirrored scale', () => {
  for (const scale of [new Vector3(1, 2, 3), new Vector3(-2, 0.5, 4)]) {
    for (let n = 0; n < 20; n++) {
      const position = new Vector3(random() * 10, random() * -10, random()),
        quaternion = randomQuaternion();
      const m = new Matrix4().compose(position, quaternion, scale);
      const p = new Vector3(),
        q = new Quaternion(),
        s = new Vector3();
      m.decompose(p, q, s);
      nearArray(p.toArray(), position.toArray());
      nearArray(new Matrix4().compose(p, q, s).toArray(), m.toArray(), 1e-9);
      if (scale.x > 0) {
        nearArray(s.toArray(), scale.toArray(), 1e-9);
        sameRotation(q, quaternion);
      }
    }
  }
});

test('Matrix3 inverse and normal matrix', () => {
  const m = new Matrix3().set(2, 0, 1, 1, 3, 0, 0, 1, 4);
  nearArray(Array.from(m.clone().multiply(m.clone().invert()).elements), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-12);
  near(m.determinant(), 25);
  const normal = new Matrix3().getNormalMatrix(new Matrix4().makeScale(2, 1, 1));
  nearArray(new Vector3(1, 1, 0).applyMatrix3(normal).toArray(), [0.5, 1, 0]);
});

test('Quaternion slerp endpoints, midpoint and shortest arc', () => {
  const a = new Quaternion(),
    b = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  assert.ok(a.clone().slerp(b, 0).equals(a));
  assert.ok(a.clone().slerp(b, 1).equals(b));
  sameRotation(a.clone().slerp(b, 0.5), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4));
  const flipped = new Quaternion(-b.x, -b.y, -b.z, -b.w);
  sameRotation(a.clone().slerp(flipped, 0.5), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4));
  near(a.angleTo(b), Math.PI / 2);
  near(a.clone().rotateTowards(b, 0.1).angleTo(a), 0.1, 1e-9);
  const q = randomQuaternion();
  assert.ok(q.clone().multiply(q.clone().invert()).equals(new Quaternion(), 1e-12));
  for (const [from, to] of [
    [
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 1],
      [0, 0, -1],
    ],
    [
      [1, 0, 0],
      [-1, 0, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 0],
    ],
  ]) {
    const turn = new Quaternion().setFromUnitVectors(new Vector3(...from), new Vector3(...to));
    nearArray(new Vector3(...from).applyQuaternion(turn).toArray(), to, 1e-12);
  }
});

test('Quaternion and rotation matrices agree, including near-180-degree turns', () => {
  const cases = [
    randomQuaternion(),
    randomQuaternion(),
    new Quaternion(1, 0, 0, 0),
    new Quaternion(0, 1, 0, 0),
    new Quaternion(0, 0, 1, 0),
    new Quaternion(0.7, 0.7, 0.1, 0.01).normalize(),
  ];
  for (const q of cases) {
    const m = new Matrix4().makeRotationFromQuaternion(q);
    sameRotation(new Quaternion().setFromRotationMatrix(m), q);
    sameRotation(new Quaternion().setFromRotationMatrix(new Matrix3().setFromMatrix4(m)), q);
  }
});

test('Euler: every order round-trips through quaternions and matrices and matches axis products', () => {
  for (const order of ORDERS) {
    for (let n = 0; n < 30; n++) {
      const e = new Euler((random() - 0.5) * 6, (random() - 0.5) * 3, (random() - 0.5) * 6, order);
      // Keep the middle angle away from ±π/2 (gimbal lock).
      const middle = { X: 'x', Y: 'y', Z: 'z' }[order[1]];
      e[middle] = Math.max(-1.5, Math.min(1.5, e[middle]));
      const q = new Quaternion().setFromEuler(e);
      const expected = new Quaternion();
      for (const axis of order)
        expected.multiply(
          new Quaternion().setFromAxisAngle(
            new Vector3(+(axis === 'X'), +(axis === 'Y'), +(axis === 'Z')),
            e[axis.toLowerCase()],
          ),
        );
      sameRotation(q, expected);
      const back = new Euler(0, 0, 0, order).setFromQuaternion(q);
      sameRotation(new Quaternion().setFromEuler(back), q);
      const fromMatrix = new Euler().setFromRotationMatrix(new Matrix4().makeRotationFromQuaternion(q), order);
      assert.equal(fromMatrix.order, order);
      sameRotation(new Quaternion().setFromEuler(fromMatrix), q);
      // Angles inside the canonical range come back exactly.
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      nearArray(back.toArray(), [wrap(e.x), wrap(e.y), wrap(e.z)], 1e-9);
    }
    // Gimbal lock still yields an equivalent rotation.
    const locked = new Euler(0.3, 0.2, 0.1, order);
    locked[{ X: 'x', Y: 'y', Z: 'z' }[order[1]]] = Math.PI / 2;
    const q = new Quaternion().setFromEuler(locked);
    sameRotation(new Quaternion().setFromEuler(new Euler().setFromQuaternion(q, order)), q, 1e-6);
  }
});

test('Euler XYZ matches core mesh rotation (qX * qY * qZ)', () => {
  // Kernel::sync_rotation (qX * qY * qZ), written out for (0.3, -0.4, 1.1).
  const [x, y, z] = [0.3, -0.4, 1.1],
    sx = Math.sin(x / 2),
    cx = Math.cos(x / 2),
    sy = Math.sin(y / 2),
    cy = Math.cos(y / 2),
    sz = Math.sin(z / 2),
    cz = Math.cos(z / 2);
  const core = [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
  nearArray(new Quaternion().setFromEuler(new Euler(x, y, z)).toArray(), core, 1e-12);
});

test('Color: hex, CSS, HSL and sRGB/linear conversion', () => {
  for (const hex of [0x000000, 0xffffff, 0xff8800, 0x336699, 0x010203]) assert.equal(new Color(hex).getHex(), hex);
  near(new Color(0x808080).r, 0.21586050011389926, 1e-12);
  assert.equal(new Color(0x808080).getHex('srgb-linear'), 0x373737);
  for (let n = 0; n <= 100; n++) near(SRGBToLinear(LinearToSRGB(n / 100)), n / 100, 1e-12);
  near(LinearToSRGB(0.5), 0.7353569830524495, 1e-12);
  assert.equal(new Color('#f80').getHex(), 0xff8800);
  assert.equal(new Color('#FF8800').getHex(), 0xff8800);
  assert.equal(new Color('rgb(255, 136, 0)').getHex(), 0xff8800);
  assert.equal(new Color('rgba(100%, 0%, 0%, 0.5)').getHex(), 0xff0000);
  assert.equal(new Color('rgb(255 136 0 / 50%)').getHex(), 0xff8800);
  assert.equal(new Color('hsl(120, 100%, 50%)').getHex(), 0x00ff00);
  assert.equal(new Color().setHSL(0, 1, 0.5).getHex(), 0xff0000);
  assert.equal(new Color().setHSL(2 / 3, 1, 0.25).getHex(), 0x000080);
  const hsl = new Color(0x00ff00).getHSL({ h: 0, s: 0, l: 0 });
  nearArray([hsl.h, hsl.s, hsl.l], [1 / 3, 1, 0.5], 1e-12);
  const round = new Color().setHSL(0.61, 0.4, 0.3).getHSL({ h: 0, s: 0, l: 0 });
  nearArray([round.h, round.s, round.l], [0.61, 0.4, 0.3], 1e-12);
  assert.throws(() => new Color('red'), TypeError);
  assert.throws(() => new Color('#12345'), TypeError);
  assert.equal(new Color(1, 0.5, 0).g, 0.5, 'three-argument form is linear');
  assert.equal(new Color().setRGB(1, 0.5, 0, 'srgb').getHex(), 0xff8000);
  assert.equal(new Color(0xff0000).lerp(new Color(0x0000ff), 0.5).getHex('srgb-linear'), 0x800080);
});

test('Color plugs into core PbrMaterial as linear RGB', () => {
  const material = new PbrMaterial({ color: '#336699' });
  nearArray(Array.from(material.data.subarray(0, 3)), new Color('#336699').toArray(), 1e-7);
  const tinted = new PbrMaterial({ color: new Color(0xff8800).toArray() });
  assert.equal(new Color().fromArray(tinted.data).getHex(), 0xff8800);
  new Color(0x00ff00).toArray(material.data);
  assert.deepEqual(Array.from(material.data.subarray(0, 3)), [0, 1, 0]);
  assert.equal(
    new PbrMaterial({ color: '#' + new Color(0x0a0b0c).getHexString() }).data[2],
    new Float32Array([new Color(0x0a0b0c).b])[0],
  );
});

test('Box3 and Sphere: bounds, containment, intersection and transforms', () => {
  const box = new Box3().setFromArray(new Float32Array([1, 2, 3, -1, 0, 5, 0, -2, 4]));
  assert.deepEqual(
    [box.min.toArray(), box.max.toArray()],
    [
      [-1, -2, 3],
      [1, 2, 5],
    ],
  );
  assert.deepEqual(box.getCenter(new Vector3()).toArray(), [0, 0, 4]);
  assert.deepEqual(box.getSize(new Vector3()).toArray(), [2, 4, 2]);
  assert.ok(box.containsPoint(new Vector3(0, 0, 4)) && !box.containsPoint(new Vector3(0, 0, 6)));
  assert.ok(new Box3().isEmpty() && new Box3().getSize(new Vector3()).equals(new Vector3()));
  const unit = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  assert.ok(unit.intersectsBox(new Box3(new Vector3(0.5, 0.5, 0.5), new Vector3(3, 3, 3))));
  assert.ok(!unit.intersectsBox(new Box3(new Vector3(1.5, 0, 0), new Vector3(3, 1, 1))));
  assert.ok(
    unit.intersectsSphere(new Sphere(new Vector3(2, 0, 0), 1)) &&
      !unit.intersectsSphere(new Sphere(new Vector3(2, 2, 0), 1)),
  );
  assert.ok(
    unit.intersectsPlane(new Plane(new Vector3(0, 1, 0), -0.5)) &&
      !unit.intersectsPlane(new Plane(new Vector3(0, 1, 0), -1.5)),
  );
  assert.ok(unit.containsBox(new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1))));
  near(unit.distanceToPoint(new Vector3(4, 5, 0)), 5);
  const rotated = unit.clone().applyMatrix4(new Matrix4().makeRotationZ(Math.PI / 4).setPosition(10, 0, 0));
  nearArray(rotated.min.toArray(), [10 - Math.SQRT2, -Math.SQRT2, -1]);
  nearArray(rotated.max.toArray(), [10 + Math.SQRT2, Math.SQRT2, 1]);
  const s = unit.getBoundingSphere(new Sphere());
  near(s.radius, Math.sqrt(3));

  const sphere = new Sphere().setFromPoints([new Vector3(-1, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 0.5, 0)]);
  assert.deepEqual([sphere.center.toArray(), sphere.radius], [[0, 0.25, 0], Math.hypot(1, 0.25)]);
  assert.ok(sphere.intersectsBox(unit) && sphere.intersectsPlane(new Plane(new Vector3(1, 0, 0), 0)));
  const union = new Sphere(new Vector3(0, 0, 0), 1).union(new Sphere(new Vector3(4, 0, 0), 1));
  assert.deepEqual([union.center.toArray(), union.radius], [[2, 0, 0], 3]);
  const grown = new Sphere(new Vector3(), 1).expandByPoint(new Vector3(3, 0, 0));
  assert.deepEqual([grown.center.toArray(), grown.radius], [[1, 0, 0], 2]);
  const moved = new Sphere(new Vector3(1, 0, 0), 1).applyMatrix4(new Matrix4().makeScale(1, 3, 2));
  assert.deepEqual([moved.center.toArray(), moved.radius], [[1, 0, 0], 3]);
});

test('Plane: construction, distances and affine transforms', () => {
  const plane = new Plane().setFromCoplanarPoints(new Vector3(0, 1, 0), new Vector3(0, 1, 1), new Vector3(1, 1, 0));
  assert.deepEqual([plane.normal.toArray(), plane.constant], [[0, 1, 0], -1]);
  assert.equal(plane.distanceToPoint(new Vector3(5, 4, 5)), 3);
  assert.deepEqual(plane.projectPoint(new Vector3(5, 4, 5), new Vector3()).toArray(), [5, 1, 5]);
  assert.deepEqual(new Plane(new Vector3(0, 2, 0), 4).normalize().constant, 2);
  // Point on plane stays on the transformed plane; normal stays perpendicular under non-uniform scale and rotation.
  const tilted = new Plane().setFromNormalAndCoplanarPoint(new Vector3(1, 1, 0).normalize(), new Vector3(1, 0, 0));
  const m = new Matrix4().compose(
    new Vector3(3, -2, 1),
    new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.4),
    new Vector3(2, 0.5, 1),
  );
  const a = new Vector3(1, 0, 0),
    b = new Vector3(0, 1, 0),
    c = new Vector3(0, 1, 5);
  for (const p of [a, b, c]) near(tilted.distanceToPoint(p), 0, 1e-12);
  tilted.applyMatrix4(m);
  for (const p of [a, b, c]) near(tilted.distanceToPoint(p.clone().applyMatrix4(m)), 0, 1e-12);
  near(tilted.normal.length(), 1, 1e-12);
  assert.ok(tilted.distanceToPoint(new Vector3(5, 5, 0).applyMatrix4(m)) > 0, 'front side preserved');
  const mirrored = new Plane(new Vector3(1, 0, 0), -1).applyMatrix4(new Matrix4().makeScale(-1, 1, 1));
  near(mirrored.distanceToPoint(new Vector3(-2, 0, 0)), 1, 1e-12, 'mirror keeps the transformed front side in front');
  assert.equal(new Plane(new Vector3(0, 1, 0), 0).translate(new Vector3(0, 2, 0)).constant, -2);
});

test('Ray intersections with spheres, planes, boxes and triangles', () => {
  const ray = new Ray(new Vector3(0, 0, 10), new Vector3(0, 0, -1)),
    hit = new Vector3();
  assert.deepEqual(ray.intersectSphere(new Sphere(new Vector3(), 2), hit)?.toArray(), [0, 0, 2]);
  assert.equal(ray.intersectSphere(new Sphere(new Vector3(3, 0, 0), 2), hit), null);
  assert.deepEqual(
    new Ray().intersectSphere(new Sphere(new Vector3(), 2), hit)?.toArray(),
    [0, 0, -2],
    'from inside, exit point',
  );
  assert.equal(ray.intersectSphere(new Sphere(new Vector3(0, 0, 20), 2), hit), null, 'behind');
  assert.deepEqual(ray.intersectPlane(new Plane(new Vector3(0, 0, 1), -3), hit)?.toArray(), [0, 0, 3]);
  assert.equal(ray.intersectPlane(new Plane(new Vector3(1, 0, 0), -3), hit), null, 'parallel');
  assert.equal(ray.distanceToPlane(new Plane(new Vector3(0, 0, 1), -12)), null, 'behind');
  const unit = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  assert.deepEqual(ray.intersectBox(unit, hit)?.toArray(), [0, 0, 1]);
  assert.ok(ray.intersectsBox(unit) && !new Ray(new Vector3(0, 5, 10), new Vector3(0, 0, -1)).intersectsBox(unit));
  assert.deepEqual(
    new Ray(new Vector3(0.5, 0, 0), new Vector3(1, 0, 0)).intersectBox(unit, hit)?.toArray(),
    [0.5, 0, 0],
    'inside',
  );
  const angled = new Ray(new Vector3(-5, -5, 0), new Vector3(1, 1, 0).normalize());
  nearArray(angled.intersectBox(unit, hit).toArray(), [-1, -1, 0], 1e-12);
  const [a, b, c] = [new Vector3(-1, -1, 0), new Vector3(1, -1, 0), new Vector3(0, 1, 0)];
  assert.deepEqual(ray.intersectTriangle(a, b, c, true, hit)?.toArray(), [0, 0, 0], 'front face (counter-clockwise)');
  assert.equal(ray.intersectTriangle(a, c, b, true, hit), null, 'back face culled');
  assert.deepEqual(ray.intersectTriangle(a, c, b, false, hit)?.toArray(), [0, 0, 0]);
  assert.equal(new Ray(new Vector3(2, 0, 10), new Vector3(0, 0, -1)).intersectTriangle(a, b, c, false, hit), null);
  near(ray.distanceToPoint(new Vector3(3, 4, 0)), 5);
  near(ray.distanceToPoint(new Vector3(0, 0, 13)), 3, 0, 'behind the origin measures to the origin');
  const local = ray.clone().applyMatrix4(new Matrix4().makeTranslation(0, 0, -10));
  assert.deepEqual(
    [local.origin.toArray(), local.direction.toArray()],
    [
      [0, 0, 0],
      [0, 0, -1],
    ],
  );
});

test('Frustum: containment and agreement with core camera planes', () => {
  const projection = new Matrix4().makePerspective(-0.1, 0.1, 0.1, -0.1, 0.1, 100);
  const frustum = new Frustum().setFromProjectionMatrix(projection);
  assert.ok(frustum.containsPoint(new Vector3(0, 0, -5)));
  assert.ok(
    !frustum.containsPoint(new Vector3(0, 0, 5)) &&
      !frustum.containsPoint(new Vector3(0, 0, -200)) &&
      !frustum.containsPoint(new Vector3(10, 0, -5)),
  );
  assert.ok(
    frustum.intersectsSphere(new Sphere(new Vector3(6, 0, -5), 1.5)) &&
      !frustum.intersectsSphere(new Sphere(new Vector3(10, 0, -5), 1)),
  );
  assert.ok(frustum.intersectsBox(new Box3(new Vector3(-1, -1, -6), new Vector3(1, 1, -4))));
  assert.ok(!frustum.intersectsBox(new Box3(new Vector3(-1, -1, 4), new Vector3(1, 1, 6))));
  const gl = new Frustum().setFromProjectionMatrix(
    new Matrix4().makePerspective(-0.1, 0.1, 0.1, -0.1, 0.1, 100, false),
    false,
  );
  for (let i = 0; i < 6; i++) {
    nearArray(gl.planes[i].normal.toArray(), frustum.planes[i].normal.toArray(), 1e-9);
    near(gl.planes[i].constant, frustum.planes[i].constant, 1e-9 * (1 + Math.abs(frustum.planes[i].constant)));
  }

  const camera = new Camera({
    position: new Vector3(3, 4, 5).toArray(),
    target: new Vector3(0, 1, 0).toArray(),
    fov: 50,
  });
  camera.update(16 / 9, true);
  const fromMatrix = new Frustum().setFromProjectionMatrix(new Matrix4().fromArray(camera.matrix));
  nearArray(fromMatrix.toArray(), Array.from(camera.planes), 1e-4); // camera.planes is Float32
  nearArray(new Frustum().fromArray(camera.planes).toArray(new Float32Array(24)), Array.from(camera.planes), 0);
  assert.ok(fromMatrix.containsPoint(new Vector3(0, 1, 0)) && !fromMatrix.containsPoint(new Vector3(6, 7, 10)));
});

test('MathUtils', () => {
  const {
    clamp,
    lerp,
    inverseLerp,
    mapLinear,
    damp,
    smoothstep,
    smootherstep,
    degToRad,
    radToDeg,
    euclideanModulo,
    isPowerOfTwo,
    ceilPowerOfTwo,
    floorPowerOfTwo,
    seededRandom,
    createRandom,
    randInt,
  } = MathUtils;
  assert.deepEqual(
    [
      clamp(5, 0, 1),
      clamp(-1, 0, 1),
      lerp(2, 4, 0.25),
      inverseLerp(2, 4, 3),
      inverseLerp(1, 1, 3),
      mapLinear(5, 0, 10, 100, 200),
    ],
    [1, 0, 2.5, 0.5, 0, 150],
  );
  near(damp(0, 10, 2, 0.5), 10 * (1 - Math.exp(-1)));
  assert.deepEqual(
    [smoothstep(-1, 0, 1), smoothstep(0.5, 0, 1), smoothstep(2, 0, 1), smootherstep(0.5, 0, 1)],
    [0, 0.5, 1, 0.5],
  );
  near(degToRad(180), Math.PI);
  near(radToDeg(Math.PI / 2), 90);
  assert.deepEqual(
    [
      euclideanModulo(-1, 4),
      isPowerOfTwo(64),
      isPowerOfTwo(65),
      isPowerOfTwo(0),
      ceilPowerOfTwo(65),
      floorPowerOfTwo(65),
    ],
    [3, true, false, false, 128, 64],
  );
  const first = [seededRandom(7), seededRandom(), seededRandom()],
    again = [seededRandom(7), seededRandom(), seededRandom()];
  assert.deepEqual(first, again);
  const a = createRandom(99),
    b = createRandom(99),
    values = Array.from({ length: 1000 }, a);
  assert.deepEqual(values.slice(0, 5), Array.from({ length: 5 }, b));
  assert.ok(values.every((v) => v >= 0 && v < 1) && new Set(values).size === 1000);
  near(values.reduce((sum, v) => sum + v, 0) / values.length, 0.5, 0.05);
  const ints = Array.from({ length: 200 }, () => randInt(1, 3, a));
  assert.deepEqual([...new Set(ints)].sort(), [1, 2, 3]);
});

test('math types plug into core tuples and typed arrays', () => {
  const camera = new Camera({ position: new Vector3(1, 2, 3).toArray() });
  assert.deepEqual(camera.position, [1, 2, 3]);
  camera.position = new Vector3().copy({ x: 4, y: 5, z: 6 }).toArray();
  assert.deepEqual(camera.position, [4, 5, 6]);
  const m = new Matrix4().compose(
    new Vector3(1, 2, 3),
    new Quaternion().setFromEuler(new Euler(0.1, 0.2, 0.3)),
    new Vector3(1, 1, 1),
  );
  const gpu = m.toArray(new Float32Array(16));
  assert.ok(new Matrix4().fromArray(gpu).equals(m, 1e-6));
  assert.deepEqual(new Vector3().setFromMatrixPosition({ elements: gpu }).toArray(), [1, 2, 3]);
  assert.deepEqual(new Euler().fromArray(new Float32Array([0.5, 0.25, 0.125])).toArray(), [0.5, 0.25, 0.125]);
});

test('importing one type yields a small bundle (tree-shaking)', async (t) => {
  const { build } = await import('vite');
  const { gzipSync } = await import('node:zlib');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dist = (name) =>
    JSON.stringify(fileURLToPath(new URL(`../dist/${name}.js`, import.meta.url)).replaceAll('\\', '/'));
  const folder = await mkdtemp(join(tmpdir(), 'margoengine-math-shake-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let n = 0;
  const bundle = async (code) => {
    const file = join(folder, `entry${n++}.js`);
    await writeFile(file, code);
    const out = await build({
      root: folder,
      configFile: false,
      logLevel: 'silent',
      build: { write: false, minify: true, lib: { entry: file, formats: ['es'], fileName: 'entry' } },
    });
    const code_ = (Array.isArray(out) ? out[0] : out).output
      .filter((chunk) => chunk.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n');
    return { code: code_, gzip: gzipSync(code_).length };
  };
  const all = await bundle(`export * from ${dist('index')};`);
  const viaSubpath = await bundle(`export {Vector3} from ${dist('vector3')};`);
  const viaRoot = await bundle(`export {Vector3} from ${dist('index')};`);
  const box = await bundle(`export {Box3} from ${dist('box3')};`);
  assert.ok(viaSubpath.gzip < 1500, `Vector3 gzip ${viaSubpath.gzip}`);
  assert.ok(
    viaRoot.gzip <= viaSubpath.gzip + 50,
    `root import of Vector3 also shakes: ${viaRoot.gzip} vs ${viaSubpath.gzip}`,
  );
  assert.ok(viaSubpath.gzip * 5 < all.gzip, `Vector3 ${viaSubpath.gzip} is a small fraction of all ${all.gzip}`);
  for (const { code } of [viaSubpath, viaRoot, box])
    assert.doesNotMatch(
      code,
      /makePerspective|slerp|setStyle|setFromProjectionMatrix/,
      'Matrix4, Quaternion, Color and Frustum are dropped',
    );
  assert.match(box.code, /setFromArray/);
});
