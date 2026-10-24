import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH } from '../dist/index.js';

function grid(axis = 0, size = 32, layers = 1) {
  const axes = [axis, (axis + 1) % 3, (axis + 2) % 3],
    positions = [],
    indices = [];
  for (let layer = 0; layer < layers; layer++) {
    const base = positions.length / 3;
    for (let y = 0; y <= size; y++)
      for (let x = 0; x <= size; x++) {
        const p = [0, 0, 0];
        p[axes[0]] = -1 + (2 * x) / size;
        p[axes[1]] = -1 + (2 * y) / size;
        p[axes[2]] = -layer;
        positions.push(...p);
      }
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const a = base + y * (size + 1) + x;
        indices.push(a, a + 1, a + size + 2, a, a + size + 2, a + size + 1);
      }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), axes };
}
function rayFor(source, x, y, zero = 0) {
  const o = [0, 0, 0],
    d = [zero, zero, zero];
  o[source.axes[0]] = x;
  o[source.axes[1]] = y;
  o[source.axes[2]] = 2;
  d[source.axes[2]] = -1;
  return { origin: o, direction: d };
}
function countReads(bvh) {
  let count = 0;
  const original = bvh.positions;
  Object.defineProperty(bvh, 'positions', {
    value: new Proxy(original, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) count++;
        return Reflect.get(target, key, target);
      },
    }),
  });
  return {
    get count() {
      return count;
    },
    reset() {
      count = 0;
    },
  };
}

// Independent plane/2D barycentric oracle. No production BVH,slab or ray/triangle predicate is reused.
function analytic(source, ray, { near = 0, far = Infinity, side = 'double' } = {}) {
  const hits = [],
    [u, v, n] = source.axes,
    o = ray.origin,
    d = ray.direction,
    length = Math.hypot(...d);
  if (d[n] === 0) return [];
  if ((side === 'front' && d[n] >= 0) || (side === 'back' && d[n] <= 0)) return [];
  for (let f = 0; f < source.indices.length / 3; f++) {
    const ids = Array.from(source.indices.slice(f * 3, f * 3 + 3)),
      p = ids.map((i) => Array.from(source.positions.slice(i * 3, i * 3 + 3))),
      t = (p[0][n] - o[n]) / d[n],
      distance = t * length;
    if (distance < near || distance > far) continue;
    const point = o.map((a, i) => a + t * d[i]),
      du = p[1][u] - p[0][u],
      dv = p[1][v] - p[0][v],
      eu = p[2][u] - p[0][u],
      ev = p[2][v] - p[0][v],
      x = point[u] - p[0][u],
      y = point[v] - p[0][v],
      den = du * ev - dv * eu,
      a = (x * ev - y * eu) / den,
      b = (du * y - dv * x) / den;
    if (a >= 0 && b >= 0 && a + b <= 1) hits.push({ faceIndex: f, distance, point, barycoord: [1 - a - b, a, b] });
  }
  return hits.sort((a, b) => a.distance - b.distance || a.faceIndex - b.faceIndex);
}
function same(actual, expected) {
  assert.deepEqual(
    actual.map((h) => h.faceIndex),
    expected.map((h) => h.faceIndex),
  );
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].distance, expected[i].distance);
    assert.deepEqual(actual[i].point, expected[i].point);
    actual[i].barycoord.forEach((w, j) => assert(Math.abs(w - expected[i].barycoord[j]) < 1e-13));
  }
}

for (const axis of [0, 1, 2]) {
  test(`all-hit parallel misses on axis${axis} prune before reading any triangle positions`, () => {
    const source = grid(axis),
      bvh = MeshBVH.build(source, { maxLeafTriangles: 4 }),
      reads = countReads(bvh);
    for (const x of [-1.25, 1.25])
      for (const zero of [0, -0])
        for (const far of [Infinity, 10]) {
          reads.reset();
          assert.deepEqual(bvh.raycast(rayFor(source, x, 0, zero), { far }), []);
          assert.equal(reads.count, 0, 'A ray outside a parallel bounding slab must not traverse triangle data');
        }
  });
  test(`nearest parallel misses on axis${axis} prune before reading any triangle positions`, () => {
    const source = grid(axis),
      bvh = MeshBVH.build(source, { maxLeafTriangles: 4 }),
      reads = countReads(bvh);
    for (const x of [-1.25, 1.25])
      for (const zero of [0, -0]) {
        reads.reset();
        assert.equal(bvh.raycastFirst(rayFor(source, x, 0, zero)), null);
        assert.equal(reads.count, 0);
      }
  });
}
test('signed-zero rays on faces,box edges,vertices and internal split planes retain every analytic hit', () => {
  for (const axis of [0, 1, 2]) {
    const source = grid(axis, 8, 2),
      bvh = MeshBVH.build(source, { maxLeafTriangles: 2 });
    for (const [x, y] of [
      [0, 0],
      [-1, -1],
      [1, 1],
      [-1, 0.25],
      [0.25, 1],
      [0.125, 0.125],
      [0.125, 0.2],
    ])
      for (const zero of [0, -0])
        for (const options of [{}, { near: 2, far: 2 }, { near: 2.5, far: 3 }, { side: 'front' }, { side: 'back' }]) {
          const ray = rayFor(source, x, y, zero),
            expected = analytic(source, ray, options);
          same(bvh.raycast(ray, options), expected);
          const first = bvh.raycastFirst(ray, options);
          assert.equal(first?.distance ?? null, expected[0]?.distance ?? null);
        }
  }
});
test('inside orthographic queries prune unrelated leaves while retaining all layers and sorted ties', () => {
  const source = grid(0, 64, 3),
    bvh = MeshBVH.build(source, { maxLeafTriangles: 4 }),
    reads = countReads(bvh),
    ray = rayFor(source, 0.123, 0.237);
  const hits = bvh.raycast(ray);
  same(hits, analytic(source, ray));
  assert.equal(hits.length, 3);
  assert(reads.count < source.indices.length / 8, 'A spatially local query must not read every triangle in the tree');
});
test('finite oblique and near-parallel rays match an independent plane oracle across near/far and side filters', () => {
  const source = grid(0, 8, 2),
    bvh = MeshBVH.build(source),
    cases = [];
  for (let i = 0; i < 120; i++) {
    const x = -1.1 + (i % 17) * 0.137,
      y = -1.1 + (i % 19) * 0.123,
      ray = {
        origin: [x, y, 2],
        direction: [
          i % 3 === 0 ? 1e-12 : ((i % 7) - 3) * 0.031,
          i % 4 === 0 ? -0 : ((i % 5) - 2) * 0.019,
          -1 - (i % 3),
        ],
      };
    for (const options of [{}, { near: 0.5, far: 2.5 }, { near: 0, far: 10, side: 'front' }, { side: 'back' }]) {
      same(bvh.raycast(ray, options), analytic(source, ray, options));
      cases.push(i);
    }
  }
  assert.equal(cases.length, 480);
});
test('a nonzero subnormal component whose reciprocal overflows still retains a finite representable hit', () => {
  const z = Math.fround(1e38),
    source = {
      positions: Float32Array.from([0, 0, z, 1, 0, z, 0, 1, z]),
      axes: [0, 1, 2],
      indices: Uint32Array.from([0, 1, 2]),
    },
    d = 1e-320,
    ray = { origin: [-0.5 * z * d, 0.25, 0], direction: [d, 0, 1] },
    bvh = MeshBVH.build(source),
    expected = analytic(source, ray);
  assert.equal(expected.length, 1);
  same(bvh.raycast(ray), expected);
  const first = bvh.raycastFirst(ray);
  assert(first, 'A tiny nonzero axis is not a zero/parallel direction');
  assert.equal(first.distance, z);
  assert(first.point.every(Number.isFinite));
  assert(first.point[0] > 0);
});
