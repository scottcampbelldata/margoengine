// Behaviour of each per-type entry (@margoengine/math/<type>), imported by its public subpath.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector2 } from '@margoengine/math/vector2';
import { Vector3 } from '@margoengine/math/vector3';
import { Vector4 } from '@margoengine/math/vector4';
import { Quaternion } from '@margoengine/math/quaternion';
import { Euler } from '@margoengine/math/euler';
import { Matrix3 } from '@margoengine/math/matrix3';
import { Matrix4 } from '@margoengine/math/matrix4';
import { Box3 } from '@margoengine/math/box3';
import { Sphere } from '@margoengine/math/sphere';
import { Plane } from '@margoengine/math/plane';
import { Ray } from '@margoengine/math/ray';
import { Frustum } from '@margoengine/math/frustum';
import { Spherical } from '@margoengine/math/spherical';
import * as vec3 from '@margoengine/math/vec3';
import { MargoError } from '@margoengine/math/errors';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);

test('vector2: arithmetic, length, rotation and array round trip', () => {
  const v = new Vector2(3, 4);
  assert.equal(v.length(), 5);
  assert.equal(v.clone().normalize().length(), 1);
  assert.equal(new Vector2(1, 2).add(new Vector2(3, 4)).toArray().join(), '4,6');
  assert.equal(new Vector2(1, 0).cross(new Vector2(0, 1)), 1);
  const r = new Vector2(1, 0).rotateAround(new Vector2(0, 0), Math.PI / 2);
  near(r.x, 0);
  near(r.y, 1);
  assert.equal(new Vector2().fromArray([0, 7, 8], 1).y, 8);
});

test('vector3: cross, dot, lerp, projection and angle', () => {
  const x = new Vector3(1, 0, 0),
    y = new Vector3(0, 1, 0);
  assert.deepEqual(x.clone().cross(y).toArray(), [0, 0, 1]);
  assert.equal(x.dot(y), 0);
  near(x.angleTo(y), Math.PI / 2);
  assert.deepEqual(new Vector3().lerpVectors(x, y, 0.5).toArray(), [0.5, 0.5, 0]);
  assert.deepEqual(new Vector3(2, 3, 4).projectOnPlane(y).toArray(), [2, 0, 4]);
  assert.deepEqual(new Vector3(1, -1, 0).reflect(y).toArray(), [1, 1, 0]);
  assert.equal(new Vector3(1, 2, 3).equals({ x: 1, y: 2, z: 3 }), true);
});

test('vector3: applyMatrix4 translates, applyQuaternion rotates', () => {
  const m = new Matrix4().makeTranslation(1, 2, 3);
  assert.deepEqual(new Vector3(1, 1, 1).applyMatrix4(m).toArray(), [2, 3, 4]);
  const q = new Quaternion().setFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2);
  const r = new Vector3(1, 0, 0).applyQuaternion(q);
  near(r.x, 0);
  near(r.y, 1);
});

test('vector4: dot, length, normalize and lerp', () => {
  const v = new Vector4(1, 2, 2, 4);
  assert.equal(v.lengthSq(), 25);
  assert.equal(v.length(), 5);
  near(v.clone().normalize().length(), 1);
  assert.deepEqual(new Vector4(0, 0, 0, 0).lerp(new Vector4(2, 4, 6, 8), 0.5).toArray(), [1, 2, 3, 4]);
  assert.equal(new Vector4(1, 2, 3, 4).dot(new Vector4(4, 3, 2, 1)), 20);
});

test('quaternion: axis angle, composition, slerp and invert', () => {
  const z = { x: 0, y: 0, z: 1 };
  const a = new Quaternion().setFromAxisAngle(z, Math.PI / 2);
  const twice = a.clone().multiply(a);
  near(twice.angleTo(new Quaternion().setFromAxisAngle(z, Math.PI)), 0, 1e-7);
  assert.ok(a.clone().multiply(a.clone().invert()).equals({ x: 0, y: 0, z: 0, w: 1 }, 1e-12));
  const half = new Quaternion().slerpQuaternions(new Quaternion(), a, 0.5);
  near(half.angleTo(new Quaternion().setFromAxisAngle(z, Math.PI / 4)), 0, 1e-7);
  const q = new Quaternion().setFromUnitVectors({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const v = new Vector3(1, 0, 0).applyQuaternion(q);
  near(v.y, 1);
});

test('euler: round trip through a quaternion and through a rotation matrix', () => {
  const e = new Euler(0.3, -0.5, 0.2, 'XYZ');
  const q = new Quaternion().setFromEuler(e);
  const back = new Euler().setFromQuaternion(q, 'XYZ');
  assert.ok(back.equals(e, 1e-9));
  const m = new Matrix4().makeRotationFromQuaternion(q);
  assert.ok(new Euler().setFromRotationMatrix(m, 'XYZ').equals(e, 1e-9));
  assert.deepEqual(e.toArray().slice(0, 3), [0.3, -0.5, 0.2]);
});

test('matrix3: set is row-major, elements column-major, invert and transpose', () => {
  const m = new Matrix3().set(1, 2, 3, 4, 5, 6, 7, 8, 10);
  assert.deepEqual([...m.elements.slice(0, 3)], [1, 4, 7]);
  assert.equal(m.determinant(), -3);
  const inv = m.clone().invert();
  const id = m.clone().multiply(inv);
  assert.ok(id.equals(new Matrix3(), 1e-12));
  assert.equal(m.clone().transpose().elements[1], 2);
  const s = new Matrix3().makeScale(2, 3);
  assert.equal(s.determinant(), 6);
});

test('matrix4: compose and decompose round trip, lookAt and invert', () => {
  const position = new Vector3(1, 2, 3),
    quaternion = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.7),
    scale = new Vector3(2, 3, 4);
  const m = new Matrix4().compose(position, quaternion, scale);
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  assert.ok(p.equals(position, 1e-9));
  assert.ok(s.equals(scale, 1e-9));
  near(q.angleTo(quaternion), 0, 1e-7);
  assert.ok(m.clone().multiply(m.clone().invert()).equals(new Matrix4(), 1e-9));
  const look = new Matrix4().lookAt({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  assert.ok(look.equals(new Matrix4(), 1e-12), 'looking down -Z is the identity rotation');
});

test('box3: set from points, contains, intersects, union and empty', () => {
  const box = new Box3();
  assert.equal(box.isEmpty(), true);
  box.setFromPoints([new Vector3(-1, 0, 2), new Vector3(3, 4, 5), new Vector3(0, 1, 3)]);
  assert.deepEqual(box.min.toArray(), [-1, 0, 2]);
  assert.deepEqual(box.max.toArray(), [3, 4, 5]);
  assert.equal(box.containsPoint(new Vector3(0, 1, 3)), true);
  assert.equal(box.containsPoint(new Vector3(9, 1, 3)), false);
  assert.equal(box.distanceToPoint(new Vector3(6, 0, 2)), 3);
  const other = new Box3(new Vector3(2, 3, 4), new Vector3(8, 8, 8));
  assert.equal(box.intersectsBox(other), true);
  assert.deepEqual(box.clone().union(other).max.toArray(), [8, 8, 8]);
  assert.deepEqual(box.clone().intersect(other).min.toArray(), [2, 3, 4]);
  assert.deepEqual(new Box3().setFromArray([0, 0, 0, 1, 2, 3]).max.toArray(), [1, 2, 3]);
  assert.equal(box.intersectsSphere(new Sphere(new Vector3(5, 0, 2), 2)), true);
});

test('sphere: bounds of points, contains, signed distance and intersections', () => {
  const s = new Sphere().setFromPoints([new Vector3(-1, 0, 0), new Vector3(1, 0, 0)]);
  assert.deepEqual(s.center.toArray(), [0, 0, 0]);
  assert.equal(s.radius, 1);
  assert.equal(s.containsPoint(new Vector3(0, 1, 0)), true);
  assert.equal(s.distanceToPoint(new Vector3(0, 3, 0)), 2);
  assert.equal(s.distanceToPoint(new Vector3(0, 0.5, 0)), -0.5);
  assert.equal(s.intersectsSphere(new Sphere(new Vector3(2, 0, 0), 1)), true, 'touching counts');
  assert.equal(s.intersectsSphere(new Sphere(new Vector3(2.1, 0, 0), 1)), false);
  assert.equal(s.intersectsPlane(new Plane(new Vector3(0, 1, 0), -0.5)), true);
  assert.equal(new Sphere().makeEmpty().isEmpty(), true);
});

test('plane: from points, signed distance, negate and normalize', () => {
  const p = new Plane().setFromCoplanarPoints(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 0, -1));
  assert.deepEqual(p.normal.toArray(), [0, 1, 0]);
  assert.equal(p.distanceToPoint(new Vector3(5, 2, 5)), 2);
  assert.equal(
    p
      .clone()
      .negate()
      .distanceToPoint(new Vector3(0, 2, 0)),
    -2,
  );
  const loose = new Plane(new Vector3(0, 2, 0), 4).normalize();
  assert.deepEqual([loose.normal.y, loose.constant], [1, 2]);
  assert.equal(new Plane().setFromNormalAndCoplanarPoint(new Vector3(0, 1, 0), new Vector3(0, 3, 0)).constant, -3);
  assert.equal(p.intersectsBox(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))), true);
});

test('ray: point at distance, plane, sphere and box hits', () => {
  const ray = new Ray(new Vector3(0, 0, 5), new Vector3(0, 0, -1));
  assert.deepEqual(ray.at(2, new Vector3()).toArray(), [0, 0, 3]);
  const plane = new Plane(new Vector3(0, 0, 1), 0);
  assert.equal(ray.distanceToPlane(plane), 5);
  assert.equal(new Ray(new Vector3(0, 0, -5), new Vector3(0, 0, -1)).distanceToPlane(plane), null, 'plane is behind');
  assert.equal(ray.intersectsSphere(new Sphere(new Vector3(0, 0, 0), 1)), true);
  assert.equal(ray.intersectsSphere(new Sphere(new Vector3(3, 0, 0), 1)), false);
  const hit = ray.intersectBox(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)), new Vector3());
  assert.deepEqual(hit.toArray(), [0, 0, 1]);
  assert.equal(ray.intersectBox(new Box3(new Vector3(5, 5, 5), new Vector3(6, 6, 6)), new Vector3()), null);
  assert.equal(ray.distanceToPoint(new Vector3(3, 0, 0)), 3);
});

test('frustum: planes from a projection matrix classify points, spheres and boxes', () => {
  const projection = new Matrix4().makePerspective(-1, 1, 1, -1, 1, 10);
  const frustum = new Frustum().setFromProjectionMatrix(projection);
  assert.equal(frustum.containsPoint(new Vector3(0, 0, -5)), true);
  assert.equal(frustum.containsPoint(new Vector3(0, 0, 1)), false, 'behind the camera');
  assert.equal(frustum.containsPoint(new Vector3(0, 0, -11)), false, 'past the far plane');
  assert.equal(frustum.containsPoint(new Vector3(20, 0, -5)), false, 'far to the side');
  assert.equal(frustum.intersectsSphere(new Sphere(new Vector3(0, 0, -5), 0.5)), true);
  assert.equal(frustum.intersectsSphere(new Sphere(new Vector3(0, 0, 20), 0.5)), false);
  assert.equal(frustum.intersectsBox(new Box3(new Vector3(-1, -1, -6), new Vector3(1, 1, -4))), true);
  assert.equal(frustum.intersectsBox(new Box3(new Vector3(50, 50, -6), new Vector3(51, 51, -4))), false);
});

test('spherical: Cartesian round trip and makeSafe', () => {
  const s = new Spherical().setFromVector3(new Vector3(0, 0, 2));
  assert.deepEqual([s.radius, s.phi, s.theta], [2, Math.PI / 2, 0]);
  const up = new Spherical().setFromCartesianCoords(0, 3, 0);
  assert.equal(up.phi, 0);
  assert.equal(up.makeSafe().phi, 1e-6);
  const v = new Vector3().setFromSpherical(new Spherical(2, Math.PI / 3, 0.4));
  const back = new Spherical().setFromVector3(v);
  near(back.radius, 2);
  near(back.phi, Math.PI / 3);
  near(back.theta, 0.4);
});

test('vec3: plain-array helpers return new arrays', () => {
  const a = [1, 2, 3],
    b = [4, 5, 6];
  assert.deepEqual(vec3.add(a, b), [5, 7, 9]);
  assert.deepEqual(vec3.sub(b, a), [3, 3, 3]);
  assert.deepEqual(vec3.scale(a, 2), [2, 4, 6]);
  assert.equal(vec3.dot(a, b), 32);
  assert.deepEqual(vec3.cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  assert.equal(vec3.length([2, 3, 6]), 7);
  assert.deepEqual(vec3.normalize([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(a, [1, 2, 3], 'inputs are not modified');
});

test('errors: MargoError carries a code and matches across bundled copies', () => {
  const error = new MargoError('disposed', 'Thing is disposed; create a new Thing.');
  assert.equal(error.code, 'disposed');
  assert.equal(error.name, 'MargoError');
  assert.ok(error instanceof Error);
  assert.ok(error instanceof MargoError);
  const foreign = Object.assign(new Error('x'), { name: 'MargoError' });
  assert.ok(foreign instanceof MargoError, 'instanceof matches by name');
  assert.ok(!(new Error('x') instanceof MargoError));
});
