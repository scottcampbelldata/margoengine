// OBB (@margoengine/math/obb): every method, the 15 separating axes one at a time, and seeded property tests
// against brute-force references (polygon clipping for box pairs, the AABB for containment, analytic ray hits).
import test from 'node:test';
import assert from 'node:assert/strict';
import { OBB, Box3, Vector3, Matrix3, Matrix4, Quaternion, Sphere, Plane, Ray, MathUtils } from '../dist/index.js';
import { OBB as SubpathOBB } from '@margoengine/math/obb';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const nearVector = (a, b, e = 1e-9) => assert.ok(a.distanceTo(b) <= e, `${a.toArray()} vs ${b.toArray()}`);

const randomQuaternion = (random) => {
  // Uniform rotation from three uniforms (Shoemake's subgroup method).
  const u = random(),
    v = random() * 2 * Math.PI,
    w = random() * 2 * Math.PI;
  const a = Math.sqrt(1 - u),
    b = Math.sqrt(u);
  return new Quaternion(a * Math.sin(v), a * Math.cos(v), b * Math.sin(w), b * Math.cos(w));
};
const rotationOf = (q) => new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q));
const randomRotation = (random) => rotationOf(randomQuaternion(random));
const axis = (obb, k) => new Vector3().fromArray(obb.rotation.elements, 3 * k);
const halfOf = (obb, k) => (k === 0 ? obb.halfSize.x : k === 1 ? obb.halfSize.y : obb.halfSize.z);
const radiusOn = (obb, l) => [0, 1, 2].reduce((sum, k) => sum + halfOf(obb, k) * Math.abs(axis(obb, k).dot(l)), 0);
const pointAt = (obb, u, v, w) =>
  obb.center.clone().addScaledVector(axis(obb, 0), u).addScaledVector(axis(obb, 1), v).addScaledVector(axis(obb, 2), w);

// The 15 candidate axes, unit length (null for a degenerate cross product), labelled as the tests report them.
const candidateAxes = (a, b) => {
  const out = [];
  for (let i = 0; i < 3; i++) out.push({ name: `A${i}`, axis: axis(a, i) });
  for (let j = 0; j < 3; j++) out.push({ name: `B${j}`, axis: axis(b, j) });
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const l = axis(a, i).cross(axis(b, j));
      out.push({ name: `A${i}xB${j}`, axis: l.length() > 1e-12 ? l.normalize() : null });
    }
  return out;
};
// Signed gap of the projections on a unit axis: > 0 separated, < 0 overlapping.
const gapOn = (a, b, l) => Math.abs(b.center.clone().sub(a.center).dot(l)) - radiusOn(a, l) - radiusOn(b, l);

// Brute force: clip every face of `b` against the six half-spaces of `a` (half sizes grown by `grow`); the solids
// meet when some clipped face is left, or when `a` sits inside `b` (its centre is inside).
const corners = (obb, grow = 0) => {
  const out = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1])
        out.push(
          pointAt(obb, sx * (obb.halfSize.x + grow), sy * (obb.halfSize.y + grow), sz * (obb.halfSize.z + grow)),
        );
  return out;
};
const faces = (obb) => {
  const c = corners(obb),
    index = (sx, sy, sz) => ((sx + 1) / 2) * 4 + ((sy + 1) / 2) * 2 + (sz + 1) / 2;
  const out = [];
  for (const s of [-1, 1]) {
    out.push([index(s, -1, -1), index(s, 1, -1), index(s, 1, 1), index(s, -1, 1)].map((i) => c[i]));
    out.push([index(-1, s, -1), index(1, s, -1), index(1, s, 1), index(-1, s, 1)].map((i) => c[i]));
    out.push([index(-1, -1, s), index(1, -1, s), index(1, 1, s), index(-1, 1, s)].map((i) => c[i]));
  }
  return out;
};
const clip = (polygon, normal, limit) => {
  const out = [];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i],
      q = polygon[(i + 1) % polygon.length],
      dp = p.dot(normal) - limit,
      dq = q.dot(normal) - limit;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) out.push(p.clone().lerp(q, dp / (dp - dq)));
  }
  return out;
};
const clippingReference = (a, b, grow) => {
  const planes = [];
  for (let k = 0; k < 3; k++)
    for (const s of [-1, 1]) {
      const n = axis(a, k).multiplyScalar(s);
      planes.push([n, n.dot(a.center) + halfOf(a, k) + grow]);
    }
  for (let polygon of faces(b)) {
    for (const [n, limit] of planes) polygon = clip(polygon, n, limit);
    if (polygon.length) return true;
  }
  return b.containsPoint(a.center);
};

test('obb: set, copy, clone and equals', () => {
  const r = rotationOf(new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.7));
  const a = new OBB().set({ x: 1, y: 2, z: 3 }, { x: 0.5, y: 1, z: 2 }, r);
  assert.deepEqual(a.center.toArray(), [1, 2, 3]);
  assert.deepEqual(a.halfSize.toArray(), [0.5, 1, 2]);
  assert.ok(a.rotation.equals(r));
  const b = a.clone();
  assert.notEqual(b.center, a.center);
  assert.ok(b.equals(a));
  b.center.x += 1e-7;
  assert.equal(b.equals(a), false);
  assert.equal(b.equals(a, 1e-6), true);
  assert.ok(new OBB().copy(a).equals(a));
  const defaults = new OBB();
  assert.deepEqual([...defaults.center.toArray(), ...defaults.halfSize.toArray()], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...defaults.rotation.elements], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.ok(new SubpathOBB(new Vector3(1, 0, 0), new Vector3(1, 1, 1)).containsPoint({ x: 1.5, y: 0, z: 0 }));
});

test('obb: fromBox3 then the identity matrix answers containment like the AABB for 1,000 random points', () => {
  const random = MathUtils.createRandom(101);
  const box = new Box3(new Vector3(-1.5, 0.25, -4), new Vector3(2.25, 3, 1.5));
  const obb = new OBB().fromBox3(box).applyMatrix4(new Matrix4());
  assert.deepEqual(obb.center.toArray(), [0.375, 1.625, -1.25]);
  assert.deepEqual(obb.halfSize.toArray(), [1.875, 1.375, 2.75]);
  let inside = 0;
  for (let i = 0; i < 1000; i++) {
    const p = new Vector3(-2 + random() * 5, -0.5 + random() * 4, -5 + random() * 7.5);
    const expected = box.containsPoint(p);
    assert.equal(obb.containsPoint(p), expected, `point ${p.toArray()}`);
    if (expected) inside++;
  }
  assert.ok(inside > 200 && inside < 800, `${inside} of 1000 inside`);
  // Exact corners and face points (all representable) count as inside, one step out does not.
  for (const p of corners(obb)) assert.equal(obb.containsPoint(p), true);
  assert.equal(obb.containsPoint({ x: 2.25, y: 1, z: 0 }), true);
  assert.equal(obb.containsPoint({ x: 2.25 + 1e-12, y: 1, z: 0 }), false);
  assert.throws(
    () => new OBB().fromBox3(new Box3()),
    (e) => e instanceof RangeError && /expand it/.test(e.message),
  );
});

test('obb: applyMatrix4 rotates, scales along the box axes and translates', () => {
  const random = MathUtils.createRandom(7);
  const box = new Box3(new Vector3(-1, -2, -0.5), new Vector3(3, 1, 0.5));
  for (let trial = 0; trial < 50; trial++) {
    const q = randomQuaternion(random),
      scale = new Vector3(0.2 + random() * 3, 0.2 + random() * 3, -(0.2 + random() * 3)),
      position = new Vector3(random() * 10 - 5, random() * 10 - 5, random() * 10 - 5);
    const m = new Matrix4().compose(position, q, scale);
    const obb = new OBB().fromBox3(box).applyMatrix4(m);
    // The rotation stays proper (a mirror flips an axis instead) and the transformed AABB matches point for point.
    near(obb.rotation.determinant(), 1, 1e-12);
    for (let i = 0; i < 40; i++) {
      const p = new Vector3(-1 + random() * 4, -2 + random() * 3, -0.5 + random());
      const inside = p.clone().applyMatrix4(m);
      assert.ok(obb.distanceToPoint(inside) < 1e-9, 'transformed inside point');
      const outside = new Vector3(3.01 + random(), -2 + random() * 3, -0.5 + random()).applyMatrix4(m);
      assert.equal(obb.containsPoint(outside), false, 'transformed outside point');
    }
    for (const c of corners(new OBB().fromBox3(box))) {
      const world = c.clone().applyMatrix4(m);
      assert.ok(obb.distanceToPoint(world) < 1e-9);
      near(obb.clampPoint(world, new Vector3()).distanceTo(world), 0, 1e-9);
    }
  }
  // A rotated box takes a uniform scale and any rotation, and keeps its half sizes along its own axes.
  const rotated = new OBB(new Vector3(), new Vector3(1, 2, 3), rotationOf(randomQuaternion(random)));
  rotated.applyMatrix4(new Matrix4().compose(new Vector3(1, 2, 3), randomQuaternion(random), new Vector3(2, 2, 2)));
  nearVector(rotated.halfSize, new Vector3(2, 4, 6), 1e-12);
  nearVector(rotated.center, new Vector3(1, 2, 3), 1e-12);
});

test('obb: containsPoint, clampPoint and distanceToPoint on a rotated box', () => {
  const r = rotationOf(new Quaternion().setFromAxisAngle(new Vector3(1, 1, 0).normalize(), 1.1));
  const obb = new OBB(new Vector3(2, -1, 0.5), new Vector3(1, 0.5, 2), r);
  const faceX = pointAt(obb, 1, 0.2, -0.3);
  assert.equal(obb.containsPoint(pointAt(obb, 0.99, 0.49, 1.99)), true);
  assert.equal(obb.containsPoint(pointAt(obb, 1.01, 0, 0)), false);
  const outside = pointAt(obb, 3, 0.2, -0.3);
  near(obb.distanceToPoint(outside), 2);
  nearVector(obb.clampPoint(outside, new Vector3()), faceX);
  const inner = pointAt(obb, 0.3, -0.2, 1);
  near(obb.distanceToPoint(inner), 0);
  nearVector(obb.clampPoint(inner, new Vector3()), inner);
  const corner = pointAt(obb, 1 + 3, 0.5 + 4, 0);
  near(obb.distanceToPoint(corner), 5);
  nearVector(obb.clampPoint(corner, new Vector3()), pointAt(obb, 1, 0.5, 0));
});

test('obb: intersectsSphere, intersectsPlane and intersectsBox3', () => {
  const r = rotationOf(new Quaternion().setFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 4));
  const obb = new OBB(new Vector3(), new Vector3(1, 1, 1), r);
  // Along the box's own x axis the surface is 1 away; along world x the corner reaches sqrt(2).
  const ax = axis(obb, 0);
  assert.equal(obb.intersectsSphere(new Sphere(ax.clone().multiplyScalar(1.5), 0.5)), true);
  assert.equal(obb.intersectsSphere(new Sphere(ax.clone().multiplyScalar(1.5), 0.499)), false);
  assert.equal(obb.intersectsSphere(new Sphere(new Vector3(), -1)), false);
  assert.equal(obb.intersectsPlane(new Plane(new Vector3(1, 0, 0), -Math.SQRT2 + 1e-9)), true);
  assert.equal(obb.intersectsPlane(new Plane(new Vector3(1, 0, 0), -Math.SQRT2 - 1e-9)), false);
  assert.equal(obb.intersectsPlane(new Plane(ax, -1)), true);
  assert.equal(obb.intersectsPlane(new Plane(ax, -1.001)), false);
  assert.equal(obb.intersectsPlane(new Plane(ax, 1.001)), false);
  // Box3: the rotated corner reaches world x = sqrt(2), which an axis-aligned box near x = 1.3 still hits.
  const box = (minX) => new Box3(new Vector3(minX, -0.05, -1), new Vector3(minX + 1, 0.05, 1));
  assert.equal(obb.intersectsBox3(box(1.3)), true);
  assert.equal(obb.intersectsBox3(box(1.42)), false);
  assert.equal(obb.intersectsBox3(new Box3()), false);
  // Without rotation it agrees with Box3.intersectsBox on random pairs.
  const random = MathUtils.createRandom(3);
  for (let i = 0; i < 500; i++) {
    const a = new Box3().setFromCenterAndSize(
      new Vector3(random() * 4, random() * 4, random() * 4),
      new Vector3(random() * 2, random() * 2, random() * 2),
    );
    const b = new Box3().setFromCenterAndSize(
      new Vector3(random() * 4, random() * 4, random() * 4),
      new Vector3(random() * 2, random() * 2, random() * 2),
    );
    assert.equal(new OBB().fromBox3(a).intersectsBox3(b, 0), a.intersectsBox(b));
  }
});

test('obb: intersectsOBB touches and separates on each of the 15 axes alone', () => {
  const random = MathUtils.createRandom(15);
  const gap = 1e-3;
  for (let index = 0; index < 15; index++) {
    let found = false;
    for (let attempt = 0; attempt < 20000 && !found; attempt++) {
      const a = new OBB(
        new Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1),
        new Vector3(0.3 + random(), 0.3 + random(), 0.3 + random()),
        randomRotation(random),
      );
      const b = new OBB(
        new Vector3(),
        new Vector3(0.3 + random(), 0.3 + random(), 0.3 + random()),
        randomRotation(random),
      );
      const l = candidateAxes(a, b)[index].axis;
      if (
        !l ||
        (index >= 6 &&
          axis(a, Math.floor((index - 6) / 3))
            .cross(axis(b, (index - 6) % 3))
            .length() < 0.3)
      )
        continue;
      const contact = radiusOn(a, l) + radiusOn(b, l);
      const place = (g) => b.center.copy(a.center).addScaledVector(l, contact + g);
      place(gap);
      const others = candidateAxes(a, b).filter((c, i) => i !== index && c.axis);
      if (!others.every((c) => gapOn(a, b, c.axis) < -10 * gap)) continue;
      found = true;
      const name = candidateAxes(a, b)[index].name;
      near(gapOn(a, b, l), gap, 1e-12);
      assert.equal(a.intersectsOBB(b), false, `${name} separated`);
      assert.equal(b.intersectsOBB(a), false, `${name} separated, swapped`);
      assert.equal(clippingReference(a, b, 0), false, `${name} reference separated`);
      place(0);
      assert.equal(a.intersectsOBB(b), true, `${name} touching`);
      assert.equal(b.intersectsOBB(a), true, `${name} touching, swapped`);
      place(-gap);
      assert.equal(a.intersectsOBB(b), true, `${name} overlapping`);
      assert.equal(clippingReference(a, b, 0), true, `${name} reference overlapping`);
    }
    assert.ok(found, `no case found where axis ${index} alone separates`);
  }
  // Exactly touching faces of axis-aligned boxes.
  const unit = new Vector3(1, 1, 1);
  assert.equal(new OBB(new Vector3(), unit).intersectsOBB(new OBB(new Vector3(2, 0, 0), unit), 0), true);
  assert.equal(new OBB(new Vector3(), unit).intersectsOBB(new OBB(new Vector3(2 + 1e-12, 0, 0), unit), 0), false);
});

test('obb: intersectsOBB matches polygon clipping on 1,000 seeded random pairs', () => {
  const random = MathUtils.createRandom(2026);
  const grow = 1e-4;
  let checked = 0,
    hits = 0,
    nearParallel = 0;
  while (checked < 1000) {
    const a = new OBB(
      new Vector3(),
      new Vector3(0.1 + random() * 1.4, 0.1 + random() * 1.4, 0.1 + random() * 1.4),
      randomRotation(random),
    );
    // A quarter of the pairs share a rotation up to a tiny turn, so edges are almost parallel.
    const parallel = random() < 0.25;
    const rotation = parallel
      ? new Matrix3().multiplyMatrices(
          a.rotation,
          rotationOf(new Quaternion().setFromAxisAngle(new Vector3(random(), random(), random()).normalize(), 1e-9)),
        )
      : randomRotation(random);
    const b = new OBB(
      new Vector3(random() * 5 - 2.5, random() * 5 - 2.5, random() * 5 - 2.5),
      new Vector3(0.1 + random() * 1.4, 0.1 + random() * 1.4, 0.1 + random() * 1.4),
      rotation,
    );
    const outer = clippingReference(a, b, grow),
      inner = clippingReference(a, b, -grow);
    if (outer !== inner) continue; // Within 1e-4 of touching: either answer is right.
    checked++;
    if (outer) hits++;
    if (parallel) nearParallel++;
    assert.equal(a.intersectsOBB(b), outer, `pair ${checked}`);
    assert.equal(b.intersectsOBB(a), outer, `pair ${checked}, swapped`);
  }
  assert.ok(hits > 200 && hits < 800, `${hits} of 1000 intersect`);
  assert.ok(nearParallel > 150, `${nearParallel} near-parallel pairs`);
});

test('obb: intersectRay returns the nearest entry point within 1e-9 relative error', () => {
  const random = MathUtils.createRandom(9);
  for (let i = 0; i < 1000; i++) {
    const obb = new OBB(
      new Vector3(random() * 20 - 10, random() * 20 - 10, random() * 20 - 10),
      new Vector3(0.2 + random() * 3, 0.2 + random() * 3, 0.2 + random() * 3),
      randomRotation(random),
    );
    const k = Math.floor(random() * 3),
      sign = random() < 0.5 ? -1 : 1,
      uvw = [0, 1, 2].map((j) => (j === k ? sign * halfOf(obb, j) : (random() * 1.8 - 0.9) * halfOf(obb, j)));
    const entry = pointAt(obb, ...uvw),
      normal = axis(obb, k).multiplyScalar(sign);
    let direction;
    do direction = randomQuaternion(random).toArray().slice(0, 3);
    while (new Vector3(...direction).normalize().dot(normal) > -0.2);
    const d = new Vector3(...direction).normalize();
    const ray = new Ray(entry.clone().addScaledVector(d, -(0.5 + random() * 5)), d);
    const hit = obb.intersectRay(ray, new Vector3());
    assert.ok(hit, `ray ${i} hits`);
    assert.ok(hit.distanceTo(entry) <= 1e-9 * Math.max(1, entry.length()), `ray ${i}: ${hit.distanceTo(entry)}`);
    assert.equal(obb.intersectsRay(ray), true);
    // Leaving the same face along its outward normal never comes back.
    const away = new Ray(entry.clone().addScaledVector(normal, 0.5), normal);
    assert.equal(obb.intersectRay(away, new Vector3()), null);
    assert.equal(obb.intersectsRay(away), false);
  }
});

test('obb: rays that start inside, run parallel or point away', () => {
  const r = rotationOf(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 1).normalize(), 0.8));
  const obb = new OBB(new Vector3(1, 1, 1), new Vector3(1, 2, 0.5), r);
  // Inside: the hit is the origin (t = 0), as Ray.intersectBox reports.
  const inside = pointAt(obb, 0.5, -1, 0.2);
  nearVector(obb.intersectRay(new Ray(inside, axis(obb, 0)), new Vector3()), inside, 0);
  // Parallel to the x slab: outside it misses, inside it hits the y face.
  const parallelOut = new Ray(pointAt(obb, 1.5, -5, 0), axis(obb, 1));
  assert.equal(obb.intersectRay(parallelOut, new Vector3()), null);
  const parallelIn = new Ray(pointAt(obb, 0.5, -5, 0), axis(obb, 1));
  nearVector(obb.intersectRay(parallelIn, new Vector3()), pointAt(obb, 0.5, -2, 0));
  // Grazing along a face counts (boundaries are inside).
  const cube = new OBB(new Vector3(), new Vector3(1, 1, 1));
  nearVector(
    cube.intersectRay(new Ray(new Vector3(1, -5, 0), new Vector3(0, 1, 0)), new Vector3()),
    new Vector3(1, -1, 0),
    0,
  );
  assert.equal(cube.intersectsRay(new Ray(new Vector3(1 + 1e-12, -5, 0), new Vector3(0, 1, 0))), false);
  // Pointing away from the box behind the origin.
  const behind = pointAt(obb, 0, 0, 3);
  assert.equal(obb.intersectsRay(new Ray(behind, axis(obb, 2))), false);
  assert.ok(obb.intersectsRay(new Ray(behind, axis(obb, 2).negate())));
  // An axis-aligned box agrees with Ray.intersectBox.
  const box = new Box3(new Vector3(-1, -1, -1), new Vector3(2, 1, 3));
  const ray = new Ray(new Vector3(-4, 0.3, 0.2), new Vector3(1, 0.1, 0.05).normalize());
  nearVector(new OBB().fromBox3(box).intersectRay(ray, new Vector3()), ray.intersectBox(box, new Vector3()));
});

test('obb: invalid inputs throw TypeError or RangeError that say how to fix them', () => {
  const fix = (type, pattern) => (e) => e instanceof type && pattern.test(e.message);
  const unit = new Vector3(1, 1, 1),
    rotation = new Matrix3();
  assert.throws(() => new OBB(new Vector3(NaN, 0, 0)), fix(RangeError, /OBB center .*replace NaN/));
  assert.throws(() => new OBB().set(new Vector3(), { x: 1, y: Infinity, z: 1 }, rotation), fix(RangeError, /finite/));
  assert.throws(() => new OBB().set(new Vector3(), new Vector3(1, -1, 1), rotation), fix(RangeError, /half the box/));
  assert.throws(() => new OBB().set(new Vector3(), null, rotation), fix(TypeError, /such as a Vector3/));
  assert.throws(() => new OBB().set(new Vector3(), unit, new Matrix4()), fix(TypeError, /9 column-major/));
  assert.throws(
    () => new OBB().set(new Vector3(), unit, new Matrix3().set(2, 0, 0, 0, 1, 0, 0, 0, 1)),
    fix(RangeError, /pure rotation.*makeRotationFromQuaternion/),
  );
  assert.throws(
    () => new OBB().set(new Vector3(), unit, new Matrix3().set(1, 0.5, 0, 0, 1, 0, 0, 0, 1)),
    fix(RangeError, /pure rotation/),
  );
  assert.throws(
    () => new OBB().fromBox3(new Box3(new Vector3(), new Vector3(Infinity, 1, 1))),
    fix(RangeError, /finite/),
  );
  const obb = new OBB(new Vector3(), unit);
  assert.throws(() => obb.applyMatrix4(new Matrix3()), fix(TypeError, /16 column-major/));
  assert.throws(
    () => obb.applyMatrix4(new Matrix4().makePerspective(-1, 1, 1, -1, 0.1, 10)),
    fix(RangeError, /affine/),
  );
  assert.throws(() => obb.applyMatrix4(new Matrix4().makeScale(1, 0, 1)), fix(RangeError, /non-zero scale/));
  const turned = new OBB(new Vector3(), unit, rotationOf(new Quaternion().setFromAxisAngle({ x: 0, y: 0, z: 1 }, 0.5)));
  assert.throws(
    () => turned.applyMatrix4(new Matrix4().makeScale(2, 1, 1)),
    fix(RangeError, /shear.*scale before rotating/),
  );
  assert.throws(() => obb.intersectsOBB(obb, -1), fix(RangeError, /epsilon.*>= 0/));
  assert.throws(() => obb.intersectsOBB(obb, NaN), fix(RangeError, /epsilon/));
  // A failed call leaves the box as it was.
  assert.ok(obb.equals(new OBB(new Vector3(), unit)));
});
