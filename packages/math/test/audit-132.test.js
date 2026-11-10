// Batch 132 audit regressions: each case failed before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Vector3,
  Vector4,
  Quaternion,
  Euler,
  degreesToQuaternion,
  quaternionToDegrees,
  Plane,
  Matrix4,
  Color,
  SRGBToLinear,
  LinearToSRGB,
  Spherical,
  Triangle,
  convertColor,
} from '../dist/index.js';
import { isPowerOfTwo, ceilPowerOfTwo, floorPowerOfTwo } from '../dist/mathutils.js';
import { billboardRotation } from '../dist/billboard.js';
import { Box3 } from '../dist/compat.js';

const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('Plane with a non-unit normal: coplanarPoint, projectPoint and applyMatrix4 stay on the plane', () => {
  // 2z - 2 = 0 is the plane z = 1.
  const plane = new Plane().setComponents(0, 0, 2, -2);
  assert.deepEqual(plane.coplanarPoint(new Vector3()).toArray(), [0, 0, 1]);
  assert.deepEqual(plane.projectPoint(new Vector3(3, 4, 5), new Vector3()).toArray(), [3, 4, 1]);
  plane.applyMatrix4(new Matrix4());
  close(plane.distanceToPoint(new Vector3(7, -2, 1)), 0);
  plane.setComponents(0, 0, 2, -2).applyMatrix4(new Matrix4().makeTranslation(0, 0, 3));
  close(plane.distanceToPoint(new Vector3(0, 0, 4)), 0);
});

test('Vector3 and Vector4 length and normalize survive overflow and underflow of the squares', () => {
  assert.deepEqual(new Vector3(1e200, 0, 0).normalize().toArray(), [1, 0, 0]);
  assert.deepEqual(new Vector3(1e-200, 0, 0).normalize().toArray(), [1, 0, 0]);
  assert.equal(new Vector3(1e200, 0, 0).length(), 1e200);
  assert.deepEqual(new Vector4(0, 0, 0, 1e200).normalize().toArray(), [0, 0, 0, 1]);
  assert.deepEqual(new Vector3().normalize().toArray(), [0, 0, 0]);
  assert.equal(new Vector3(3, 4, 0).length(), 5);
});

test('power-of-two helpers are exact above 2^50, where Math.log2 rounds', () => {
  assert.equal(isPowerOfTwo(2 ** 50 + 1), false);
  assert.equal(isPowerOfTwo(2 ** 53 - 1), false);
  assert.equal(isPowerOfTwo(2 ** 60 + 2 ** 10), false);
  assert.equal(isPowerOfTwo(2 ** 52), true);
  assert.equal(ceilPowerOfTwo(2 ** 50 + 1), 2 ** 51);
  assert.equal(floorPowerOfTwo(2 ** 51 - 1), 2 ** 50);
  assert.equal(ceilPowerOfTwo(5), 8);
  assert.equal(floorPowerOfTwo(5), 4);
  assert.equal(ceilPowerOfTwo(4), 4);
});

test('an unknown Euler order throws RangeError instead of returning NaN', () => {
  assert.throws(() => degreesToQuaternion([10, 20, 30], 'xyz'), RangeError);
  assert.throws(() => quaternionToDegrees([0, 0, 0, 1], 'xyz'), RangeError);
  assert.throws(() => new Euler().setFromQuaternion(new Quaternion(), 'ABC'), RangeError);
  assert.throws(() => new Euler().setFromRotationMatrix(new Matrix4(), 'XXY'), RangeError);
  assert.throws(() => new Euler().setFromRotationMatrix(new Matrix4(), 'toString'), RangeError);
  assert.deepEqual(quaternionToDegrees(degreesToQuaternion([10, 20, 30], 'ZYX'), 'ZYX').map(Math.round), [10, 20, 30]);
});

test('Color and convertColor mirror the sRGB curve below 0 (CSS Color 4 lin_sRGB / gam_sRGB)', () => {
  // The exported scalar curves stay linear below 0, bit for bit as the copies they replaced.
  close(SRGBToLinear(-0.5), -0.5 / 12.92);
  close(LinearToSRGB(-0.5), -0.5 * 12.92);
  // Display P3 green in sRGB: CSS Color 4 gives r = -0.5116, b = -0.3107 (the linear extension gave -2.906, -1.016).
  const srgb = new Color().setStyle('color(display-p3 0 1 0)').getRGB([0, 0, 0], 'srgb');
  close(srgb[0], -0.5116, 1e-4);
  close(srgb[2], -0.3107, 1e-4);
  const out = convertColor([-0.5, 0.2, 1], 'srgb', 'srgb-linear', [0, 0, 0]);
  close(out[0], -SRGBToLinear(0.5));
  close(new Color(-0.2, 0, 0).convertLinearToSRGB().convertSRGBToLinear().r, -0.2);
  close(new Color(-0.2, 0, 0).convertLinearToSRGB().r, -LinearToSRGB(0.2));
});

test('hsl() reads hue units: deg, grad, rad and turn', () => {
  assert.equal(new Color().setStyle('hsl(0.5turn, 100%, 50%)').getHexString(), '00ffff');
  assert.equal(new Color().setStyle('hsl(200grad 100% 50%)').getHexString(), '00ffff');
  assert.equal(new Color().setStyle(`hsl(${Math.PI}rad, 100%, 50%)`).getHexString(), '00ffff');
  assert.equal(new Color().setStyle('hsl(180deg, 100%, 50%)').getHexString(), '00ffff');
  assert.equal(new Color().setStyle('hsl(180, 100%, 50%)').getHexString(), '00ffff');
  assert.throws(() => new Color().setStyle('hsl(180foo, 100%, 50%)'), TypeError);
});

test('Quaternion.angleTo keeps small angles, so rotateTowards lands on the target', () => {
  const a = new Quaternion();
  const b = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1e-9);
  close(a.angleTo(b), 1e-9, 1e-20);
  const c = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI - 1e-9);
  close(a.angleTo(c), Math.PI - 1e-9, 1e-15);
  close(a.angleTo(new Quaternion(-0, -0, -0, -1)), 0);
  a.rotateTowards(b, 1);
  assert.deepEqual(a.toArray(), b.toArray());
});

test('billboardRotation refuses a mirrored parent or camera instead of returning a non-unit quaternion', () => {
  const camera = Array.from(new Matrix4().makeTranslation(0, 0, 5).elements);
  const mirror = Array.from(new Matrix4().makeScale(-1, 1, 1).elements);
  assert.throws(() => billboardRotation(camera, [0, 0, 0], { parent: mirror }), RangeError);
  const mirroredCamera = Array.from(new Matrix4().makeScale(1, -1, 1).setPosition(0, 0, 5).elements);
  assert.throws(() => billboardRotation(mirroredCamera, [0, 0, 0]), RangeError);
  const q = billboardRotation(camera, [0, 0, 0], {
    parent: Array.from(new Matrix4().makeScale(2, 2, 2).elements),
  });
  close(Math.hypot(...q), 1);
});

test('Spherical phi keeps precision next to the poles', () => {
  const s = new Spherical().setFromCartesianCoords(1e-9, 1, 0);
  close(s.phi, 1e-9, 1e-24);
  close(new Spherical().setFromCartesianCoords(1e-9, -1, 0).phi, Math.PI - 1e-9, 1e-15);
  close(new Spherical().setFromCartesianCoords(1, 0, 0).phi, Math.PI / 2);
});

test('compat Box3.intersectsTriangle agrees with Triangle.intersectsBox', () => {
  const box = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  const hit = new Triangle(new Vector3(0, 0, 0), new Vector3(3, 0, 0), new Vector3(0, 3, 0));
  const miss = new Triangle(new Vector3(2, 2, 2), new Vector3(3, 2, 2), new Vector3(2, 3, 2));
  const edge = new Triangle(new Vector3(1, -3, 0), new Vector3(1, 3, 0), new Vector3(1, 3, 0));
  for (const t of [hit, miss, edge]) assert.equal(box.intersectsTriangle(t), t.intersectsBox(box));
  assert.equal(box.intersectsTriangle(hit), true);
  assert.equal(box.intersectsTriangle(miss), false);
  assert.equal(new Box3().intersectsTriangle(hit), false);
});
