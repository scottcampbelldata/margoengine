// Line3, Triangle and Cylindrical (@margoengine/math/line3, /triangle, /cylindrical): every method, and seeded property
// tests against brute-force references (sampled closest points, polygon clipping for triangle against box).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Cylindrical, Line3, Matrix4, Plane, Spherical, Triangle, Vector3 } from '../dist/index.js';
import { Line3 as SubpathLine3 } from '@margoengine/math/line3';
import { Triangle as SubpathTriangle } from '@margoengine/math/triangle';
import { Cylindrical as SubpathCylindrical } from '@margoengine/math/cylindrical';

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

test('the entries work on their own', () => {
  assert.equal(new SubpathLine3(new Vector3(), new Vector3(0, 2, 0)).distance(), 2);
  assert.equal(new SubpathTriangle(new Vector3(), new Vector3(2, 0, 0), new Vector3(0, 2, 0)).getArea(), 2);
  assert.equal(new SubpathCylindrical(2, 0, 1).toVector3(new Vector3()).z, 2);
});

test('Line3: set, copy, clone, center, delta, length, at, equals, applyMatrix4', () => {
  const line = new Line3(new Vector3(1, 0, 0), new Vector3(3, 0, 0));
  assert.deepEqual(line.getCenter(new Vector3()).toArray(), [2, 0, 0]);
  assert.deepEqual(line.delta(new Vector3()).toArray(), [2, 0, 0]);
  assert.equal(line.distance(), 2);
  assert.equal(line.distanceSq(), 4);
  assert.deepEqual(line.at(1.5, new Vector3()).toArray(), [4, 0, 0]);
  const copy = line.clone();
  assert.ok(copy.equals(line));
  assert.notEqual(copy.start, line.start);
  copy.applyMatrix4(new Matrix4().makeTranslation(0, 1, 0));
  assert.deepEqual(copy.end.toArray(), [3, 1, 0]);
  assert.ok(!copy.equals(line));
  assert.ok(copy.equals(line, 1));
  assert.ok(new Line3().set({ x: 1, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }).equals(line));
});

test('Line3: at and delta may write into its own end points', () => {
  const line = new Line3(new Vector3(0, 0, 0), new Vector3(2, 4, 6));
  line.at(0.5, line.start);
  assert.deepEqual(line.start.toArray(), [1, 2, 3]);
  line.delta(line.end);
  assert.deepEqual(line.end.toArray(), [1, 2, 3]);
});

test('Line3: closest point on the line and on the segment', () => {
  const line = new Line3(new Vector3(0, 0, 0), new Vector3(2, 0, 0)),
    p = new Vector3(5, 3, 0);
  near(line.closestPointToPointParameter(p), 2.5);
  assert.equal(line.closestPointToPointParameter(p, true), 1);
  assert.deepEqual(line.closestPointToPoint(p, false, new Vector3()).toArray(), [5, 0, 0]);
  assert.deepEqual(line.closestPointToPoint(p, true, new Vector3()).toArray(), [2, 0, 0]);
  near(line.distanceToPoint(p), Math.hypot(3, 3));
  near(line.distanceSqToPoint(p), 18);
});

test('Line3: a zero-length segment acts as a point, never NaN', () => {
  const point = new Line3(new Vector3(1, 1, 1), new Vector3(1, 1, 1)),
    other = new Line3(new Vector3(0, 0, 0), new Vector3(0, 2, 0));
  assert.equal(point.closestPointToPointParameter(new Vector3(9, 9, 9)), 0);
  near(point.distanceToPoint(new Vector3(1, 1, 3)), 2);
  near(point.distanceToLine3(other), Math.SQRT2);
  near(other.distanceToLine3(point), Math.SQRT2);
  near(point.distanceToLine3(point), 0);
});

test('Line3: crossing, parallel and collinear segments', () => {
  const a = new Line3(new Vector3(-1, 0, 0), new Vector3(1, 0, 0)),
    pa = new Vector3(),
    pb = new Vector3();
  near(a.distanceSqToLine3(new Line3(new Vector3(0, -1, 1), new Vector3(0, 1, 1)), pa, pb), 1);
  nearVector(pa, new Vector3(0, 0, 0));
  nearVector(pb, new Vector3(0, 0, 1));
  near(a.distanceToLine3(new Line3(new Vector3(-5, 2, 0), new Vector3(5, 2, 0))), 2);
  near(a.distanceToLine3(new Line3(new Vector3(3, 0, 0), new Vector3(5, 0, 0))), 2);
  near(a.distanceToLine3(new Line3(new Vector3(5, 0, 0), new Vector3(3, 0, 0))), 2);
  near(a.distanceToLine3(new Line3(new Vector3(0.5, 0, 0), new Vector3(5, 0, 0))), 0);
});

test('Line3: distance between segments matches a sampled reference (1,000 seeded pairs)', () => {
  const random = seeded(7),
    pa = new Vector3(),
    pb = new Vector3(),
    q = new Vector3();
  for (let n = 0; n < 1000; n++) {
    const a = new Line3(randomPoint(random), randomPoint(random)),
      b = new Line3(randomPoint(random), randomPoint(random));
    // A quarter nearly parallel, where the closed form is worst conditioned.
    if (n % 4 === 0)
      b.end
        .copy(b.start)
        .add(a.delta(new Vector3()).multiplyScalar(0.7))
        .addScalar((random() - 0.5) * 1e-7);
    const d2 = a.distanceSqToLine3(b, pa, pb);
    near(pa.distanceToSquared(pb), d2, 1e-9);
    assert.ok(a.distanceToPoint(pa) < 1e-9 && b.distanceToPoint(pb) < 1e-9, 'nearest points lie on the segments');
    // Point-to-segment distance is exact and convex along `a`: a coarse scan, then a golden-section refinement.
    let best = Infinity,
      bestT = 0;
    for (let i = 0; i <= 64; i++) {
      const d = b.distanceSqToPoint(a.at(i / 64, q));
      if (d < best) {
        best = d;
        bestT = i / 64;
      }
    }
    let lo = Math.max(0, bestT - 1 / 64),
      hi = Math.min(1, bestT + 1 / 64);
    for (let i = 0; i < 80; i++) {
      const m1 = lo + (hi - lo) * 0.382,
        m2 = lo + (hi - lo) * 0.618;
      if (b.distanceSqToPoint(a.at(m1, q)) < b.distanceSqToPoint(a.at(m2, q))) hi = m2;
      else lo = m1;
    }
    best = Math.min(best, b.distanceSqToPoint(a.at((lo + hi) / 2, q)));
    near(Math.sqrt(d2), Math.sqrt(best), 1e-6);
  }
});

const right = () => new Triangle(new Vector3(0, 0, 0), new Vector3(2, 0, 0), new Vector3(0, 2, 0));

test('Triangle: area, midpoint, normal, plane, facing', () => {
  const t = right();
  assert.equal(t.getArea(), 2);
  nearVector(t.getMidpoint(new Vector3()), new Vector3(2 / 3, 2 / 3, 0));
  assert.deepEqual(t.getNormal(new Vector3()).toArray(), [0, 0, 1]);
  const plane = t.getPlane(new Plane());
  near(plane.distanceToPoint(new Vector3(5, 5, 3)), 3);
  assert.equal(t.isFrontFacing(new Vector3(0, 0, -1)), true);
  assert.equal(t.isFrontFacing(new Vector3(0, 0, 1)), false);
  assert.equal(t.clone().equals(t), true);
});

test('Triangle: setFromPositions reads vertex numbers', () => {
  const t = new Triangle().setFromPositions(new Float32Array([9, 9, 9, 0, 0, 0, 1, 0, 0, 0, 1, 0]), 1, 2, 3);
  assert.deepEqual(t.c.toArray(), [0, 1, 0]);
  t.applyMatrix4(new Matrix4().makeTranslation(0, 0, 2));
  assert.deepEqual(t.a.toArray(), [0, 0, 2]);
});

test('Triangle: barycentric weights, containment and interpolation', () => {
  const t = right(),
    w = t.getBarycoord(new Vector3(0.5, 1, 7), new Vector3());
  nearVector(w, new Vector3(0.25, 0.25, 0.5));
  assert.equal(t.containsPoint(new Vector3(0.5, 0.5, 0)), true);
  assert.equal(t.containsPoint(new Vector3(0, 0, 0)), true);
  assert.equal(t.containsPoint(new Vector3(1, 1, 0)), true);
  assert.equal(t.containsPoint(new Vector3(1.1, 1, 0)), false);
  assert.equal(t.containsPoint(new Vector3(1.1, 1, 0), 0.1), true);
  const value = t.getInterpolation(
    new Vector3(1, 0, 0),
    new Vector3(0, 0, 0),
    new Vector3(1, 2, 3),
    new Vector3(9, 9, 9),
    new Vector3(),
  );
  nearVector(value, new Vector3(0.5, 1, 1.5));
});

test('Triangle: a degenerate triangle has no weights but still answers distance queries', () => {
  const line = new Triangle(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(3, 0, 0)),
    point = new Triangle(new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(1, 1, 1)),
    out = new Vector3(5, 5, 5);
  assert.equal(line.getArea(), 0);
  assert.deepEqual(line.getNormal(new Vector3()).toArray(), [0, 0, 0]);
  assert.equal(line.getBarycoord(new Vector3(1, 0, 0), out), null);
  assert.deepEqual(out.toArray(), [5, 5, 5]);
  assert.equal(line.containsPoint(new Vector3(1, 0, 0)), false);
  assert.equal(line.getInterpolation(new Vector3(), new Vector3(), new Vector3(), new Vector3(), out), null);
  assert.equal(line.isFrontFacing(new Vector3(0, 0, -1)), false);
  nearVector(line.closestPointToPoint(new Vector3(2, 1, 0), new Vector3()), new Vector3(2, 0, 0));
  nearVector(point.closestPointToPoint(new Vector3(0, 0, 0), new Vector3()), new Vector3(1, 1, 1));
  near(point.distanceToPoint(new Vector3(1, 1, 3)), 2);
});

test('Triangle: closest point in every region', () => {
  const t = right(),
    closest = (x, y, z) => t.closestPointToPoint(new Vector3(x, y, z), new Vector3());
  nearVector(closest(0.5, 0.5, 4), new Vector3(0.5, 0.5, 0)); // face
  nearVector(closest(-1, -1, 0), new Vector3(0, 0, 0)); // corner a
  nearVector(closest(5, -1, 0), new Vector3(2, 0, 0)); // corner b
  nearVector(closest(-1, 5, 0), new Vector3(0, 2, 0)); // corner c
  nearVector(closest(1, -3, 0), new Vector3(1, 0, 0)); // edge ab
  nearVector(closest(-3, 1, 0), new Vector3(0, 1, 0)); // edge ac
  nearVector(closest(3, 3, 0), new Vector3(1, 1, 0)); // edge bc
  near(t.distanceToPoint(new Vector3(0.5, 0.5, 4)), 4);
});

test('Triangle: an out aliasing an input reads every coordinate before writing', () => {
  const t = right(),
    p = new Vector3(3, 3, 1);
  t.closestPointToPoint(p, p);
  nearVector(p, new Vector3(1, 1, 0));
  const u = right();
  u.getMidpoint(u.a);
  nearVector(u.a, new Vector3(2 / 3, 2 / 3, 0));
  const v = right();
  v.closestPointToPoint(new Vector3(0.5, 0.5, 1), v.b);
  nearVector(v.b, new Vector3(0.5, 0.5, 0));
});

test('Triangle: closest point matches a barycentric grid search (500 seeded triangles)', () => {
  const random = seeded(11),
    q = new Vector3(),
    out = new Vector3();
  for (let n = 0; n < 500; n++) {
    const t = new Triangle(randomPoint(random), randomPoint(random), randomPoint(random)),
      p = randomPoint(random, 6);
    t.closestPointToPoint(p, out);
    assert.ok(t.containsPoint(out, 1e-9), 'the answer lies on the triangle');
    near(t.getPlane(new Plane()).distanceToPoint(out), 0, 1e-9);
    const answer = p.distanceTo(out);
    let best = Infinity;
    const steps = 40;
    for (let i = 0; i <= steps; i++)
      for (let j = 0; j <= steps - i; j++) {
        const u = i / steps,
          v = j / steps;
        q.copy(t.a)
          .multiplyScalar(1 - u - v)
          .addScaledVector(t.b, u)
          .addScaledVector(t.c, v);
        best = Math.min(best, p.distanceTo(q));
      }
    assert.ok(answer <= best + 1e-9, `no grid point may beat it: ${answer} vs ${best}`);
    // One grid cell is at most the longest edge over `steps`; the search cannot land further above the true minimum.
    const cell = Math.max(t.a.distanceTo(t.b), t.b.distanceTo(t.c), t.a.distanceTo(t.c)) / steps;
    assert.ok(best - answer <= cell, `grid search within its resolution: ${answer} vs ${best}`);
  }
});

// Reference: clip the triangle's polygon by the box's six planes; anything left means they meet.
const clipByBox = (triangle, box) => {
  let polygon = [triangle.a, triangle.b, triangle.c];
  for (const [axis, limit, sign] of [
    ['x', box.max.x, 1],
    ['x', box.min.x, -1],
    ['y', box.max.y, 1],
    ['y', box.min.y, -1],
    ['z', box.max.z, 1],
    ['z', box.min.z, -1],
  ]) {
    const next = [];
    polygon.forEach((p, i) => {
      const q = polygon[(i + 1) % polygon.length],
        dp = sign * (p[axis] - limit),
        dq = sign * (q[axis] - limit);
      if (dp <= 0) next.push(p);
      if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) next.push(p.clone().lerp(q, dp / (dp - dq)));
    });
    polygon = next;
    if (!polygon.length) return false;
  }
  return true;
};

test('Triangle.intersectsBox: the cases by hand', () => {
  const box = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  assert.equal(right().intersectsBox(box), true); // a corner inside
  assert.equal(
    new Triangle(new Vector3(-9, -9, 0), new Vector3(9, -9, 0), new Vector3(0, 9, 0)).intersectsBox(box),
    true,
    'the box sits inside the triangle',
  );
  assert.equal(
    new Triangle(new Vector3(1, 0, 0), new Vector3(2, 0, 0), new Vector3(2, 1, 0)).intersectsBox(box),
    true,
    'touching counts',
  );
  assert.equal(
    new Triangle(new Vector3(2, 0, 0), new Vector3(3, 0, 0), new Vector3(3, 1, 0)).intersectsBox(box),
    false,
  );
  // Only an edge-pair axis separates this one: every box face and the triangle's plane overlap.
  assert.equal(
    new Triangle(new Vector3(3, 0.5, 0), new Vector3(3, 3, 0), new Vector3(0.5, 3, 0)).intersectsBox(box),
    false,
  );
  assert.equal(right().intersectsBox(new Box3()), false, 'an empty box meets nothing');
});

test('Triangle.intersectsBox matches polygon clipping (5,000 seeded pairs)', () => {
  const random = seeded(19);
  let hits = 0;
  for (let n = 0; n < 5000; n++) {
    const t = new Triangle(randomPoint(random), randomPoint(random), randomPoint(random)),
      c = randomPoint(random, 2),
      size = new Vector3(random() * 4, random() * 4, random() * 4),
      box = new Box3().setFromCenterAndSize(c, size);
    const expected = clipByBox(t, box);
    assert.equal(t.intersectsBox(box), expected, `pair ${n}`);
    if (expected) hits++;
  }
  assert.ok(hits > 500 && hits < 4500, `both outcomes covered: ${hits}`);
});

test('Cylindrical: set, copy, clone, equals', () => {
  const c = new Cylindrical(2, 1, 3);
  assert.deepEqual([c.radius, c.theta, c.y], [2, 1, 3]);
  assert.ok(c.clone().equals(c));
  assert.ok(new Cylindrical().copy(c).equals(c));
  assert.ok(!c.equals(new Cylindrical(2, 1, 3.5)));
  assert.ok(c.equals(new Cylindrical(2, 1, 3.5), 0.5));
  assert.deepEqual([new Cylindrical().radius, new Cylindrical().theta, new Cylindrical().y], [1, 0, 0]);
});

test('Cylindrical: theta shares the Spherical convention, azimuth from +z around +y', () => {
  nearVector(new Cylindrical(2, 0, 1).toVector3(new Vector3()), new Vector3(0, 1, 2));
  nearVector(new Cylindrical(2, Math.PI / 2, 1).toVector3(new Vector3()), new Vector3(2, 1, 0));
  const p = new Vector3(1, 5, -2);
  near(new Cylindrical().setFromVector3(p).theta, new Spherical().setFromVector3(p).theta);
});

test('Cylindrical: a point on the axis has theta 0', () => {
  const c = new Cylindrical().setFromCartesianCoords(0, 4, 0);
  assert.deepEqual([c.radius, c.theta, c.y], [0, 0, 4]);
  assert.deepEqual(c.toVector3(new Vector3()).toArray(), [0, 4, 0]);
});

test('Cylindrical: round trip through a point (1,000 seeded points)', () => {
  const random = seeded(23),
    c = new Cylindrical(),
    out = new Vector3();
  for (let n = 0; n < 1000; n++) {
    const p = randomPoint(random, 100);
    nearVector(c.setFromVector3(p).toVector3(out), p, 1e-11);
    assert.ok(c.radius >= 0 && Math.abs(c.theta) <= Math.PI);
  }
});
