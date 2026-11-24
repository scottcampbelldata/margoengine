// Capsule (@margoengine/math/capsule): every method, and seeded property tests against references built from the exact
// point distance of each other shape, minimised along the capsule's axis (those distances are convex along a segment).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Box3,
  Capsule,
  Line3,
  Matrix3,
  Matrix4,
  OBB,
  Plane,
  Quaternion,
  Ray,
  Sphere,
  Triangle,
  Vector3,
} from '../dist/index.js';
import { Capsule as EntryCapsule } from '@margoengine/math/capsule';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const nearVector = (a, b, e = 1e-9) => assert.ok(a.distanceTo(b) <= e, `${a.toArray()} vs ${b.toArray()}`);
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randomPoint = (random, scale = 4) =>
  new Vector3((random() * 2 - 1) * scale, (random() * 2 - 1) * scale, (random() * 2 - 1) * scale);
const randomCapsule = (random) => new Capsule(randomPoint(random), randomPoint(random), 0.1 + random() * 1.5);

// Minimum of a convex distance along the segment: a coarse scan, then a golden-section refinement.
const minimumAlong = (line, distance) => {
  const q = new Vector3(),
    at = (t) => distance(line.at(t, q));
  let best = Infinity,
    bestT = 0;
  for (let i = 0; i <= 64; i++) {
    const d = at(i / 64);
    if (d < best) {
      best = d;
      bestT = i / 64;
    }
  }
  let lo = Math.max(0, bestT - 1 / 64),
    hi = Math.min(1, bestT + 1 / 64);
  for (let i = 0; i < 70; i++) {
    const m1 = lo + (hi - lo) * 0.382,
      m2 = lo + (hi - lo) * 0.618;
    if (at(m1) < at(m2)) hi = m2;
    else lo = m1;
  }
  return Math.min(best, at((lo + hi) / 2));
};
// Shapes within this of touching are left out of the yes/no comparison; the sampled reference cannot call them.
const CLOSE_CALL = 1e-7;

test('the entry works on its own', () => {
  assert.equal(new EntryCapsule().containsPoint(new Vector3(0, 1, 0)), true);
});

test('defaults: 2 tall, 0.5 radius, standing on the origin', () => {
  const box = new Capsule().getBoundingBox(new Box3());
  assert.deepEqual(box.min.toArray(), [-0.5, 0, -0.5]);
  assert.deepEqual(box.max.toArray(), [0.5, 2, 0.5]);
});

test('set, copy, clone, equals, center, translate; the constructor copies its inputs', () => {
  const start = new Vector3(0, 0, 0),
    c = new Capsule(start, new Vector3(0, 4, 0), 1);
  start.x = 9;
  assert.equal(c.start.x, 0);
  assert.ok(c.clone().equals(c));
  assert.ok(!new Capsule().copy(c).translate(new Vector3(1, 0, 0)).equals(c));
  assert.ok(new Capsule().copy(c).translate(new Vector3(1, 0, 0)).equals(c, 1));
  assert.deepEqual(c.getCenter(new Vector3()).toArray(), [0, 2, 0]);
  assert.equal(c.axis.distance(), 4);
  assert.deepEqual(c.clone().translate(new Vector3(1, 2, 3)).end.toArray(), [1, 6, 3]);
});

test('a negative or non-finite radius throws with the fix', () => {
  assert.throws(() => new Capsule(new Vector3(), new Vector3(), -1), RangeError);
  assert.throws(() => new Capsule().set(new Vector3(), new Vector3(), NaN), /must be finite and >= 0/);
  assert.throws(() => new Capsule().set(new Vector3(), new Vector3(), Infinity), RangeError);
});

test('applyMatrix4: rotation, translation and uniform scale; anything else throws', () => {
  const c = new Capsule(new Vector3(0, 0, 0), new Vector3(0, 2, 0), 1),
    m = new Matrix4().compose(
      new Vector3(1, 0, 0),
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2),
      new Vector3(2, 2, 2),
    );
  c.applyMatrix4(m);
  nearVector(c.start, new Vector3(1, 0, 0));
  nearVector(c.end, new Vector3(5, 0, 0));
  near(c.radius, 2);
  const squash = new Matrix4().makeScale(1, 2, 1);
  assert.throws(() => new Capsule().applyMatrix4(squash), /uniform scale/);
  assert.throws(() => new Capsule().applyMatrix4(new Matrix4().makeScale(0, 0, 0)), RangeError);
  const shear = new Matrix4();
  shear.elements[4] = 1;
  assert.throws(() => new Capsule().applyMatrix4(shear), RangeError);
  const projective = new Matrix4();
  projective.elements[11] = -1;
  assert.throws(() => new Capsule().applyMatrix4(projective), RangeError);
});

test('points: containment, distance and clamping on the wall and on the caps', () => {
  const c = new Capsule(new Vector3(0, 0, 0), new Vector3(0, 2, 0), 1);
  assert.equal(c.containsPoint(new Vector3(1, 1, 0)), true, 'on the wall');
  assert.equal(c.containsPoint(new Vector3(0, 3, 0)), true, 'on the cap');
  assert.equal(c.containsPoint(new Vector3(0.8, 2.8, 0)), false, 'beyond the rounded corner');
  near(c.distanceToPoint(new Vector3(3, 1, 0)), 2);
  near(c.distanceToPoint(new Vector3(0, 1, 0)), 0);
  near(c.distanceToPoint(new Vector3(0, 5, 0)), 2);
  nearVector(c.clampPoint(new Vector3(3, 1, 0), new Vector3()), new Vector3(1, 1, 0));
  nearVector(c.clampPoint(new Vector3(0, -3, 0), new Vector3()), new Vector3(0, -1, 0));
  nearVector(c.clampPoint(new Vector3(0.2, 1, 0), new Vector3()), new Vector3(0.2, 1, 0));
  const p = new Vector3(3, 1, 0);
  nearVector(c.clampPoint(p, p), new Vector3(1, 1, 0));
});

test('bounds hold every point of the surface', () => {
  const random = seeded(3);
  for (let n = 0; n < 200; n++) {
    const c = randomCapsule(random),
      box = c.getBoundingBox(new Box3()),
      sphere = c.getBoundingSphere(new Sphere()),
      p = c.clampPoint(randomPoint(random, 30), new Vector3());
    assert.ok(box.expandByScalar(1e-9).containsPoint(p));
    assert.ok(sphere.distanceToPoint(p) <= 1e-9);
  }
});

test('a capsule with start and end equal is a sphere, and a zero radius is a segment', () => {
  const ball = new Capsule(new Vector3(1, 1, 1), new Vector3(1, 1, 1), 2);
  near(ball.distanceToPoint(new Vector3(1, 1, 5)), 2);
  assert.equal(ball.intersectsSphere(new Sphere(new Vector3(1, 1, 5), 2)), true);
  assert.equal(ball.intersectsBox(new Box3(new Vector3(3, 0, 0), new Vector3(4, 2, 2))), true, 'touching');
  assert.equal(ball.intersectsBox(new Box3(new Vector3(3.1, 0, 0), new Vector3(4, 2, 2))), false);
  nearVector(
    ball.intersectRay(new Ray(new Vector3(1, 1, 9), new Vector3(0, 0, -1)), new Vector3()),
    new Vector3(1, 1, 3),
  );
  const stick = new Capsule(new Vector3(0, 0, 0), new Vector3(0, 2, 0), 0);
  assert.equal(stick.containsPoint(new Vector3(0, 1, 0)), true);
  assert.equal(stick.containsPoint(new Vector3(0.1, 1, 0)), false);
});

test('spheres, capsules and planes, touching counts', () => {
  const c = new Capsule(new Vector3(0, 0, 0), new Vector3(0, 2, 0), 1);
  assert.equal(c.intersectsSphere(new Sphere(new Vector3(3, 1, 0), 2)), true);
  assert.equal(c.intersectsSphere(new Sphere(new Vector3(3.1, 1, 0), 2)), false);
  assert.equal(c.intersectsCapsule(new Capsule(new Vector3(2, 5, 0), new Vector3(2, -5, 0), 1)), true);
  assert.equal(c.intersectsCapsule(new Capsule(new Vector3(2.1, 5, 0), new Vector3(2.1, -5, 0), 1)), false);
  const plane = (y) => new Plane(new Vector3(0, 1, 0), -y);
  assert.equal(c.intersectsPlane(plane(1)), true, 'through the axis');
  assert.equal(c.intersectsPlane(plane(3)), true, 'touching the top');
  assert.equal(c.intersectsPlane(plane(-1)), true, 'touching the bottom');
  assert.equal(c.intersectsPlane(plane(3.01)), false);
  assert.equal(c.intersectsPlane(plane(-1.01)), false);
});

test('capsule against capsule matches the axis distance (500 seeded pairs)', () => {
  const random = seeded(5);
  for (let n = 0; n < 500; n++) {
    const a = randomCapsule(random),
      b = randomCapsule(random),
      gap = minimumAlong(a.axis, (p) => b.axis.distanceToPoint(p)) - a.radius - b.radius;
    if (Math.abs(gap) > CLOSE_CALL) assert.equal(a.intersectsCapsule(b), gap < 0, `pair ${n}`);
  }
});

test('intersectsBox: the cases by hand', () => {
  const box = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  assert.equal(new Capsule(new Vector3(0, 0, 0), new Vector3(0, 0, 0), 0).intersectsBox(box), true, 'inside');
  assert.equal(new Capsule(new Vector3(-9, 0, 0), new Vector3(9, 0, 0), 0).intersectsBox(box), true, 'through');
  assert.equal(new Capsule(new Vector3(3, 0, 0), new Vector3(3, 5, 0), 2).intersectsBox(box), true, 'touches a face');
  assert.equal(new Capsule(new Vector3(3.1, 0, 0), new Vector3(3.1, 5, 0), 2).intersectsBox(box), false);
  // The axis passes a box corner diagonally: its ends are both far, the middle comes within 0.1 * sqrt(2) of it.
  const pass = (r) => new Capsule(new Vector3(-4, 6.2, 0), new Vector3(6.2, -4, 0), r);
  assert.equal(pass(0.15).intersectsBox(box), true);
  assert.equal(pass(0.14).intersectsBox(box), false);
  assert.equal(new Capsule().intersectsBox(new Box3()), false, 'an empty box meets nothing');
});

test('intersectsBox matches the point distance along the axis (2,000 seeded pairs)', () => {
  const random = seeded(7);
  let hits = 0;
  for (let n = 0; n < 2000; n++) {
    const c = randomCapsule(random),
      box = new Box3().setFromCenterAndSize(
        randomPoint(random),
        new Vector3(random() * 3, random() * 3, random() * 3),
      ),
      gap = minimumAlong(c.axis, (p) => box.distanceToPoint(p)) - c.radius;
    if (Math.abs(gap) <= CLOSE_CALL) continue;
    assert.equal(c.intersectsBox(box), gap < 0, `pair ${n}`);
    if (gap < 0) hits++;
  }
  assert.ok(hits > 200 && hits < 1800, `both outcomes covered: ${hits}`);
});

test('intersectsOBB matches the point distance along the axis (2,000 seeded pairs)', () => {
  const random = seeded(9);
  let hits = 0;
  for (let n = 0; n < 2000; n++) {
    const c = randomCapsule(random),
      q = new Quaternion(random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5).normalize(),
      obb = new OBB(
        randomPoint(random),
        new Vector3(random() * 2, random() * 2, random() * 2),
        new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q)),
      ),
      gap = minimumAlong(c.axis, (p) => obb.distanceToPoint(p)) - c.radius;
    if (Math.abs(gap) <= CLOSE_CALL) continue;
    assert.equal(c.intersectsOBB(obb), gap < 0, `pair ${n}`);
    if (gap < 0) hits++;
  }
  assert.ok(hits > 200 && hits < 1800, `both outcomes covered: ${hits}`);
});

const floor = () => new Triangle(new Vector3(-5, 0, 5), new Vector3(5, 0, 5), new Vector3(0, 0, -5));

test('intersectsTriangle: above, touching, through, on an edge, and degenerate', () => {
  const standing = (y) => new Capsule(new Vector3(0, y + 0.5, 0), new Vector3(0, y + 1.5, 0), 0.5);
  assert.equal(standing(0).intersectsTriangle(floor()), true, 'touching');
  assert.equal(standing(0.01).intersectsTriangle(floor()), false);
  assert.equal(standing(-1).intersectsTriangle(floor()), true, 'through');
  assert.equal(new Capsule(new Vector3(-9, 1, 6), new Vector3(9, 1, 6), 1.5).intersectsTriangle(floor()), true);
  assert.equal(new Capsule(new Vector3(-9, 1, 7), new Vector3(9, 1, 7), 1).intersectsTriangle(floor()), false);
  const flat = new Capsule(new Vector3(-1, 0, 0), new Vector3(1, 0, 0), 0);
  assert.equal(flat.intersectsTriangle(floor()), true, 'axis lying in the plane');
  const line = new Triangle(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(3, 0, 0));
  assert.equal(new Capsule(new Vector3(2, 0.2, 0), new Vector3(2, 3, 0), 0.5).intersectsTriangle(line), true);
  assert.equal(new Capsule(new Vector3(2, 0.7, 0), new Vector3(2, 3, 0), 0.5).intersectsTriangle(line), false);
});

test('intersectsTriangle matches the point distance along the axis (2,000 seeded pairs)', () => {
  const random = seeded(13);
  let hits = 0;
  for (let n = 0; n < 2000; n++) {
    const c = randomCapsule(random);
    c.radius *= 0.3;
    const t = new Triangle(randomPoint(random), randomPoint(random), randomPoint(random)),
      gap = minimumAlong(c.axis, (p) => t.distanceToPoint(p)) - c.radius;
    if (Math.abs(gap) <= CLOSE_CALL) continue;
    assert.equal(c.intersectsTriangle(t), gap < 0, `pair ${n}`);
    if (gap < 0) hits++;
  }
  assert.ok(hits > 200 && hits < 1800, `both outcomes covered: ${hits}`);
});

test('pushOutOfTriangle: a character sinking into a floor rises by the overlap', () => {
  const c = new Capsule(new Vector3(0, 0.3, 0), new Vector3(0, 1.3, 0), 0.5),
    push = c.pushOutOfTriangle(floor(), new Vector3());
  nearVector(push, new Vector3(0, 0.2, 0));
  c.translate(push);
  assert.equal(c.pushOutOfTriangle(floor(), new Vector3()), null);
});

test('pushOutOfTriangle: no overlap or touching leaves out alone', () => {
  const out = new Vector3(7, 8, 9);
  assert.equal(new Capsule().translate(new Vector3(0, 1, 0)).pushOutOfTriangle(floor(), out), null);
  assert.equal(new Capsule().pushOutOfTriangle(floor(), out), null, 'touching');
  assert.deepEqual(out.toArray(), [7, 8, 9]);
});

test('pushOutOfTriangle: an axis through the triangle leaves by the nearer side', () => {
  const up = new Capsule(new Vector3(0, -0.2, 0), new Vector3(0, 1, 0), 0.5).pushOutOfTriangle(floor(), new Vector3());
  nearVector(up, new Vector3(0, 0.7, 0));
  const down = new Capsule(new Vector3(0, -1, 0), new Vector3(0, 0.2, 0), 0.5).pushOutOfTriangle(
    floor(),
    new Vector3(),
  );
  nearVector(down, new Vector3(0, -0.7, 0));
  const lying = new Capsule(new Vector3(-1, 0, 0), new Vector3(1, 0, 0), 0.5).pushOutOfTriangle(floor(), new Vector3());
  nearVector(lying, new Vector3(0, 0.5, 0));
});

test('pushOutOfTriangle: a push resolves the overlap, and is no larger than it must be (2,000 seeded pairs)', () => {
  const random = seeded(17),
    push = new Vector3();
  let pushes = 0;
  for (let n = 0; n < 2000; n++) {
    const c = randomCapsule(random),
      t = new Triangle(randomPoint(random), randomPoint(random), randomPoint(random)),
      gap = minimumAlong(c.axis, (p) => t.distanceToPoint(p)) - c.radius;
    if (!c.pushOutOfTriangle(t, push)) {
      assert.ok(gap >= -CLOSE_CALL, `pair ${n} overlaps by ${-gap} and got no push`);
      continue;
    }
    pushes++;
    const moved = c.clone().translate(push),
      after = minimumAlong(moved.axis, (p) => t.distanceToPoint(p)) - c.radius;
    assert.ok(after >= -1e-7, `pair ${n} still overlaps by ${-after}`);
    // Clear of the axis, the push is the overlap exactly; through it, the sampled minimum only reaches about 0.
    if (gap > -c.radius + 1e-6) near(push.length(), -gap, 1e-6);
  }
  assert.ok(pushes > 200, `pushes covered: ${pushes}`);
});

test('intersectRay: wall, cap, inside, miss, away, along the axis', () => {
  const c = new Capsule(new Vector3(0, 0, 0), new Vector3(0, 2, 0), 1),
    out = new Vector3(7, 8, 9),
    x = new Vector3(1, 0, 0);
  nearVector(c.intersectRay(new Ray(new Vector3(-5, 1, 0), x), new Vector3()), new Vector3(-1, 1, 0));
  nearVector(
    c.intersectRay(new Ray(new Vector3(0, 9, 0), new Vector3(0, -1, 0)), new Vector3()),
    new Vector3(0, 3, 0),
  );
  nearVector(c.intersectRay(new Ray(new Vector3(0, 1, 0), x), new Vector3()), new Vector3(0, 1, 0));
  nearVector(c.intersectRay(new Ray(new Vector3(-5, 2.5, 0), x), new Vector3()), new Vector3(-Math.sqrt(0.75), 2.5, 0));
  assert.equal(c.intersectRay(new Ray(new Vector3(-5, 3.5, 0), x), out), null);
  assert.equal(c.intersectRay(new Ray(new Vector3(5, 1, 0), x), out), null, 'pointing away');
  assert.deepEqual(out.toArray(), [7, 8, 9]);
  assert.equal(c.intersectsRay(new Ray(new Vector3(-5, 1, 0), x)), true);
  assert.equal(c.intersectsRay(new Ray(new Vector3(-5, 3.5, 0), x)), false);
});

test('intersectRay agrees with marching the ray (2,000 seeded rays)', () => {
  const random = seeded(19),
    out = new Vector3(),
    q = new Vector3();
  let hits = 0;
  for (let n = 0; n < 2000; n++) {
    const c = randomCapsule(random),
      origin = randomPoint(random, 8),
      aim = c.getCenter(new Vector3()).add(randomPoint(random, 3)),
      ray = new Ray(origin, aim.sub(origin).normalize());
    // Distance along the ray is 1-Lipschitz, so stepping by it (sphere tracing) cannot jump through the capsule.
    let t = 0,
      reached = false;
    for (let i = 0; i < 2000 && t < 40; i++) {
      const d = c.axis.distanceToPoint(ray.at(t, q)) - c.radius;
      if (d <= 1e-10) {
        reached = true;
        break;
      }
      t += d;
    }
    const answer = c.intersectRay(ray, out);
    // Grazing rays converge slowly; a marcher that ran out of steps close to the surface settles nothing.
    const grazing = minimumAlong(new Line3(ray.origin.clone(), ray.at(40, new Vector3())), (p) => c.axis.distanceToPoint(p));
    if (Math.abs(grazing - c.radius) < 1e-6) continue;
    assert.equal(answer !== null, reached, `ray ${n}`);
    if (answer) {
      hits++;
      nearVector(answer, ray.at(t, q), 1e-6);
    }
  }
  assert.ok(hits > 200, `hits covered: ${hits}`);
});
