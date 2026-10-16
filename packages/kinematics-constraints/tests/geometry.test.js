import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CapsuleVolume,
  SphereVolume,
  closestPointsBetweenSegments,
  measureSegmentClearance,
} from '../dist/index.js';

const EPS = 4e-6;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const near = (actual, expected, tolerance = EPS) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
};
const vecNear = (actual, expected) => expected.forEach((value, i) => near(actual[i], value));
const surface = new Float32Array(3);
const normal = new Float32Array(3);

test('sphere evaluation gives signed distance, closest surface, and a unit outward normal', () => {
  const sphere = new SphereVolume({ center: [1, 2, 3], radius: 2 });
  near(sphere.evaluate([4, 2, 3], surface, normal), 1);
  vecNear(surface, [3, 2, 3]);
  vecNear(normal, [1, 0, 0]);
  near(sphere.evaluate([1, 3, 3], surface, normal), -1);
  vecNear(surface, [1, 4, 3]);
  vecNear(normal, [0, 1, 0]);
});

test('sphere center has a deterministic finite surface and outward normal', () => {
  const sphere = new SphereVolume({ center: [3, -2, 1], radius: 0.75 });
  near(sphere.evaluate([3, -2, 1], surface, normal), -0.75);
  near(Math.hypot(...normal), 1);
  near(distance(surface, [3, -2, 1]), 0.75);
  const firstSurface = [...surface];
  const firstNormal = [...normal];
  sphere.evaluate([3, -2, 1], surface, normal);
  vecNear(surface, firstSurface);
  vecNear(normal, firstNormal);
});

test('capsule evaluation handles its cylindrical side, caps, and centerline', () => {
  const capsule = new CapsuleVolume({ start: [0, -1, 0], end: [0, 1, 0], radius: 0.5 });
  near(capsule.evaluate([2, 0.25, 0], surface, normal), 1.5);
  vecNear(surface, [0.5, 0.25, 0]);
  vecNear(normal, [1, 0, 0]);
  near(capsule.evaluate([0, 2, 0], surface, normal), 0.5);
  vecNear(surface, [0, 1.5, 0]);
  vecNear(normal, [0, 1, 0]);
  near(capsule.evaluate([0, 0, 0], surface, normal), -0.5);
  near(Math.hypot(...normal), 1);
  near(Math.abs(normal[1]), 0);
  near(distance(surface, [0, 0, 0]), 0.5);
});

test('a zero-length capsule agrees with a sphere, including at its center', () => {
  const capsule = new CapsuleVolume({ start: [1, 2, 3], end: [1, 2, 3], radius: 0.7 });
  const sphere = new SphereVolume({ center: [1, 2, 3], radius: 0.7 });
  const sphereSurface = new Float32Array(3);
  const sphereNormal = new Float32Array(3);
  for (const point of [[2, 3, 4], [1, 2, 3], [1, 2, 3.1]]) {
    near(capsule.evaluate(point, surface, normal), sphere.evaluate(point, sphereSurface, sphereNormal));
    near(Math.hypot(...normal), 1);
    near(sphere.evaluate(surface, sphereSurface, sphereNormal), 0);
  }
});

test('volume setters update attached proxies and preserve radius when omitted', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 0.5 });
  sphere.set([1, 0, 0]);
  near(sphere.evaluate([2, 0, 0], surface, normal), 0.5);
  sphere.set([1, 0, 0], 0.25);
  near(sphere.evaluate([2, 0, 0], surface, normal), 0.75);
  const capsule = new CapsuleVolume({ start: [0, 0, 0], end: [0, 1, 0], radius: 0.5 });
  capsule.set([2, 0, 0], [2, 1, 0]);
  near(capsule.evaluate([3, 0.5, 0], surface, normal), 0.5);
  capsule.set([2, 0, 0], [2, 1, 0], 0.25);
  near(capsule.evaluate([3, 0.5, 0], surface, normal), 0.75);
});

test('closest segment points handle crossing, parallel, collinear, and degenerate segments', () => {
  const cases = [
    [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], 0],
    [[0, 0, 0], [2, 0, 0], [0, 1, 0], [2, 1, 0], 1],
    [[0, 0, 0], [2, 0, 0], [1, 0, 0], [3, 0, 0], 0],
    [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], 1],
    [[0, 0, 0], [0, 0, 0], [-1, 1, 0], [1, 1, 0], 1],
    [[0, 0, 0], [0, 0, 0], [1, 2, 2], [1, 2, 2], 3],
    [[0, 0, 0], [2, 0, 0], [1, 1, 0], [1, 1, 0], 1],
  ];
  for (const [a, b, c, d, expected] of cases) {
    const result = closestPointsBetweenSegments(a, b, c, d);
    near(result.distance, expected);
    near(distance(result.pointA, result.pointB), expected);
    assert.ok(result.parameterA >= 0 && result.parameterA <= 1);
    assert.ok(result.parameterB >= 0 && result.parameterB <= 1);
  }
});

test('closest segment output can be reused without replacing nested vectors', () => {
  const out = {
    pointA: new Float32Array(3), pointB: new Float32Array(3),
    distance: 0, parameterA: 0, parameterB: 0,
  };
  const pointA = out.pointA;
  const pointB = out.pointB;
  assert.equal(closestPointsBetweenSegments([0, 0, 0], [2, 0, 0], [1, 1, 0], [1, 2, 0], out), out);
  assert.equal(out.pointA, pointA);
  assert.equal(out.pointB, pointB);
  vecNear(pointA, [1, 0, 0]);
  vecNear(pointB, [1, 1, 0]);
});

// Endpoint projections plus the unconstrained interior pair form an independent
// reference for the bounded convex minimum. No production helper is used here.
function referenceSegmentDistance(a, b, c, d) {
  const u = b.map((x, i) => x - a[i]);
  const v = d.map((x, i) => x - c[i]);
  const w = a.map((x, i) => x - c[i]);
  const dot = (x, y) => x.reduce((sum, value, i) => sum + value * y[i], 0);
  const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), uw = dot(u, w), vw = dot(v, w);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const candidates = [
    [0, vv ? clamp(vw / vv) : 0],
    [1, vv ? clamp((vw + uv) / vv) : 0],
    [uu ? clamp(-uw / uu) : 0, 0],
    [uu ? clamp((uv - uw) / uu) : 0, 1],
  ];
  const denominator = uu * vv - uv * uv;
  if (denominator > 1e-14) {
    const s = (uv * vw - vv * uw) / denominator;
    const t = (uu * vw - uv * uw) / denominator;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) candidates.push([s, t]);
  }
  return Math.min(...candidates.map(([s, t]) => Math.hypot(...w.map((x, i) => x + s * u[i] - t * v[i]))));
}

test('random segment distances match an independent reference and remain symmetric', () => {
  let seed = 0x5f3759df;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const vec = () => [random() * 8 - 4, random() * 8 - 4, random() * 8 - 4];
  for (let i = 0; i < 400; i++) {
    const a = vec(), b = vec(), c = vec(), d = vec();
    const result = closestPointsBetweenSegments(a, b, c, d);
    const reverse = closestPointsBetweenSegments(c, d, a, b);
    near(result.distance, referenceSegmentDistance(a, b, c, d));
    near(result.distance, reverse.distance);
    near(distance(result.pointA, result.pointB), result.distance);
    vecNear(result.pointA, a.map((x, k) => x + (b[k] - x) * result.parameterA));
    vecNear(result.pointB, c.map((x, k) => x + (d[k] - x) * result.parameterB));
  }
});

test('swept link clearance detects a collision between clear segment endpoints', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 0.2 });
  const start = [-1, 0, 0], end = [1, 0, 0];
  assert.ok(sphere.evaluate(start, surface, normal) > 0);
  assert.ok(sphere.evaluate(end, surface, normal) > 0);
  near(sphere.segmentClearance(start, end, 0.1), -0.3);
  near(measureSegmentClearance(start, end, 0.1, sphere), -0.3);
  const capsule = new CapsuleVolume({ start: [0, -1, 0], end: [0, 1, 0], radius: 0.2 });
  near(capsule.segmentClearance(start, end, 0.1), -0.3);
  near(measureSegmentClearance(start, end, 0.1, capsule), -0.3);
  near(capsule.segmentClearance([-1, 0, 1], [1, 0, 1], 0.1), 0.7);
});

test('random sphere and capsule surface witnesses agree with their signed distances', () => {
  let seed = 48271;
  const random = () => { seed = Math.imul(seed, 48271) >>> 0; return seed / 2 ** 32; };
  const scratchSurface = new Float32Array(3);
  const scratchNormal = new Float32Array(3);
  const volumes = [
    new SphereVolume({ center: [-0.2, 0.6, 0.3], radius: 0.7 }),
    new CapsuleVolume({ start: [-0.5, -0.2, 0.4], end: [0.7, 1.2, -0.3], radius: 0.4 }),
  ];
  for (let i = 0; i < 200; i++) {
    const point = [random() * 4 - 2, random() * 4 - 2, random() * 4 - 2];
    for (const volume of volumes) {
      const signed = volume.evaluate(point, surface, normal);
      near(Math.hypot(...normal), 1);
      near(volume.evaluate(surface, scratchSurface, scratchNormal), 0);
      vecNear(point, [...surface].map((value, k) => value + signed * normal[k]));
    }
  }
});

test('segment geometry retains crossing accuracy at small and large scales', () => {
  for (const scale of [1e-9, 1, 1e9]) {
    const result = closestPointsBetweenSegments(
      [-scale, 0, 0], [scale, 0, 0], [0, -scale, scale * 0.2], [0, scale, scale * 0.2],
      { pointA: new Float64Array(3), pointB: new Float64Array(3), distance: 0, parameterA: 0, parameterB: 0 },
    );
    near(result.distance / scale, 0.2, 1e-10);
    near(result.parameterA, 0.5, 1e-10);
    near(result.parameterB, 0.5, 1e-10);
  }
});

test('segment geometry finds an interior crossing for nearly parallel directions', () => {
  const result = closestPointsBetweenSegments([0, 0, 0], [1, 0, 0], [0, -1e-9, 0], [1, 1e-9, 0]);
  near(result.distance, 0, 1e-12);
  near(result.parameterA, 0.5, 1e-6);
  near(result.parameterB, 0.5, 1e-6);
});

test('query inputs may alias output storage while simultaneous outputs must remain distinct', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 1 });
  const point = new Float32Array([2, 0, 0]);
  near(sphere.evaluate(point, point, normal), 1);
  assert.deepEqual([...point], [1, 0, 0]);
  assert.throws(() => sphere.evaluate([2, 0, 0], point, point));
  const storage = new Float32Array(4);
  assert.throws(() => sphere.evaluate([2, 0, 0], storage.subarray(0, 3), storage.subarray(1, 4)));
  const a = new Float64Array([0, 0, 0]), b = new Float64Array([2, 0, 0]);
  const out = { pointA: a, pointB: b, distance: 0, parameterA: 0, parameterB: 0 };
  closestPointsBetweenSegments(a, b, [1, 1, 0], [1, 2, 0], out);
  vecNear(a, [1, 0, 0]);
  vecNear(b, [1, 1, 0]);
});

test('invalid primitive configuration and queries fail explicitly', () => {
  for (const radius of [-1, NaN, Infinity]) {
    assert.throws(() => new SphereVolume({ center: [0, 0, 0], radius }));
    assert.throws(() => new CapsuleVolume({ start: [0, 0, 0], end: [0, 1, 0], radius }));
  }
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 1 });
  for (const point of [[NaN, 0, 0], [0, Infinity, 0], [0, 0], [0, 0, 0, 0]]) {
    assert.throws(() => sphere.evaluate(point, surface, normal));
  }
  assert.throws(() => sphere.segmentClearance([0, 0, 0], [1, 0, 0], -0.1));
});

test('subnormal sphere offsets retain unit normals and actual surface witnesses', () => {
  const sphere = new SphereVolume({ center: [0, 0, 0], radius: 1 });
  const outSurface = new Float64Array(3), outNormal = new Float64Array(3);
  sphere.evaluate([Number.MIN_VALUE, Number.MIN_VALUE, 0], outSurface, outNormal);
  near(Math.hypot(...outNormal), 1, 1e-15);
  near(outNormal[0], Math.SQRT1_2, 1e-15);
  near(outNormal[1], Math.SQRT1_2, 1e-15);
  near(sphere.evaluate(outSurface, new Float64Array(3), new Float64Array(3)), 0, 1e-15);
});

test('subnormal segment dimensions preserve fractional closest-point parameters', () => {
  const tiny = Number.MIN_VALUE;
  const result = closestPointsBetweenSegments([0, 0, 0], [tiny, tiny, 0], [tiny, 0, 0], [tiny, 0, 0]);
  near(result.parameterA, 0.5, 1e-15);
  assert.equal(result.parameterB, 0);
  assert.equal(result.distance, tiny);
  const crossing = closestPointsBetweenSegments([-tiny, 0, 0], [tiny, 0, 0], [0, -tiny, 0], [0, tiny, 0]);
  near(crossing.parameterA, 0.5, 1e-15);
  near(crossing.parameterB, 0.5, 1e-15);
  assert.equal(crossing.distance, 0);
  const nearParallel = closestPointsBetweenSegments([0, 0, 0], [1, 2 * tiny, 0], [0, tiny, -tiny], [1, tiny, tiny]);
  near(nearParallel.parameterA, 0.5, 1e-15);
  near(nearParallel.parameterB, 0.5, 1e-15);
  assert.equal(nearParallel.distance, 0);
});

test('subnormal capsule axes retain unit radial and deterministic axial normals', () => {
  const tiny = Number.MIN_VALUE;
  const capsule = new CapsuleVolume({ start: [0, 0, 0], end: [tiny, tiny, 0], radius: 1 });
  const outSurface = new Float64Array(3), outNormal = new Float64Array(3);
  capsule.evaluate([tiny, 0, 0], outSurface, outNormal);
  near(outNormal[0], Math.SQRT1_2, 1e-15);
  near(outNormal[1], -Math.SQRT1_2, 1e-15);
  near(Math.hypot(...outNormal), 1, 1e-15);
  near(capsule.evaluate(outSurface, new Float64Array(3), new Float64Array(3)), 0, 1e-15);
  capsule.evaluate([tiny, tiny, 0], outSurface, outNormal);
  near(Math.hypot(...outNormal), 1, 1e-15);
  near(outNormal[0] + outNormal[1], 0, 1e-15);
});

test('segment Float32 overflow rejects both outputs atomically', () => {
  const out = {pointA: new Float64Array([7, 8, 9]), pointB: new Float32Array([4, 5, 6]),
    distance: 123, parameterA: 0.25, parameterB: 0.75};
  assert.throws(() => closestPointsBetweenSegments([0, 0, 0], [1, 0, 0], [1e100, 0, 0], [1e100, 1, 0], out), /output precision/);
  assert.deepEqual([...out.pointA], [7, 8, 9]);
  assert.deepEqual([...out.pointB], [4, 5, 6]);
  assert.equal(out.distance, 123);
  assert.equal(out.parameterA, 0.25);
  assert.equal(out.parameterB, 0.75);
});
