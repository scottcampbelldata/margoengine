import assert from 'node:assert/strict';
import test from 'node:test';
import { convexHullTriangles } from '@margoengine/geometry/hull';

test('indices preserve original double positions and outward closed cube topology at large offsets', () => {
  const points = [];
  for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) points.push([1e9 + x, -1e9 + y, z]);
  points.push([1e9 + 0.5, -1e9 + 0.5, 0.5], [...points[0]]);
  const before = structuredClone(points),
    indices = convexHullTriangles(points),
    edges = new Map();
  assert.equal(indices.length, 36);
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [...indices.slice(i, i + 3)];
    for (let k = 0; k < 3; k++) edges.set(`${tri[k]}>${tri[(k + 1) % 3]}`, 1);
    const [a, b, c] = tri.map((j) => points[j].map((x, k) => x - points[0][k]));
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  for (const edge of edges.keys()) {
    const [a, b] = edge.split('>');
    assert.ok(edges.has(`${b}>${a}`));
  }
  assert.ok(Math.abs(volume - 1) < 1e-12);
  assert.deepEqual(points, before);
});

test('lower dimensional sets are empty, malformed input and cancellation reject', () => {
  for (const points of [
    [],
    [[0, 0, 0]],
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
  ])
    assert.equal(convexHullTriangles(points).length, 0);
  assert.throws(() => convexHullTriangles([[NaN, 0, 0]]), /finite/);
  assert.throws(() => convexHullTriangles([], { signal: {} }), /AbortSignal/);
  const controller = new AbortController();
  controller.abort(new Error('cancel'));
  assert.throws(() => convexHullTriangles([], { signal: controller.signal }), /cancel/);
});
