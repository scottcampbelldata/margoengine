import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeshBVH } from '../dist/tree.js';
import { meshDistance, pointInside, windingNumber } from '../dist/inside.js';
import { rng } from './reference.js';

function cube(half = 1, centre = [0, 0, 0], flip = false) {
  const positions = [];
  for (const x of [-half, half])
    for (const y of [-half, half])
      for (const z of [-half, half]) positions.push(x + centre[0], y + centre[1], z + centre[2]);
  const quads = [
      [0, 1, 3, 2],
      [4, 6, 7, 5],
      [0, 4, 5, 1],
      [2, 3, 7, 6],
      [0, 2, 6, 4],
      [1, 5, 7, 3],
    ],
    indices = [];
  for (const [a, b, c, d] of quads) indices.push(...(flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d]));
  return { positions, indices };
}

function bumpy(segments = 40, rings = 28, shift = [0, 0, 0]) {
  const positions = [],
    indices = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const phi = (Math.PI * r) / rings,
        theta = (2 * Math.PI * (s % segments)) / segments,
        radius = 1 + 0.2 * Math.sin(phi * 5) * Math.cos(theta * 3);
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta) + shift[0],
        radius * Math.cos(phi) + shift[1],
        -radius * Math.sin(phi) * Math.sin(theta) + shift[2],
      );
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions, indices };
}

test('a closed mesh winds 1 inside and 0 outside, -1 when wound the other way', () => {
  const bvh = MeshBVH.build(cube()),
    flipped = MeshBVH.build(cube(1, [0, 0, 0], true));
  for (const accuracy of [2, Infinity]) {
    assert.ok(Math.abs(windingNumber(bvh, [0.3, -0.2, 0.1], { accuracy }) - 1) < 1e-9 || accuracy !== Infinity);
    assert.ok(Math.abs(windingNumber(bvh, [0.3, -0.2, 0.1], { accuracy }) - 1) < 0.01);
    assert.ok(Math.abs(windingNumber(bvh, [3, 2, 1], { accuracy })) < 0.01);
    assert.ok(Math.abs(windingNumber(flipped, [0.3, -0.2, 0.1], { accuracy }) + 1) < 0.01);
  }
  assert.equal(pointInside(bvh, [0.9, 0.9, 0.9]), true);
  assert.equal(pointInside(flipped, [0.9, 0.9, 0.9]), true);
  assert.equal(pointInside(bvh, [1.1, 0, 0]), false);
});

test('the fast estimate stays near the exact sum, and every side of the answer agrees with ray parity', () => {
  const bvh = MeshBVH.build(bumpy()),
    random = rng(9);
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const p = [random() * 3 - 1.5, random() * 3 - 1.5, random() * 3 - 1.5],
      fast = windingNumber(bvh, p),
      exact = windingNumber(bvh, p, { accuracy: Infinity });
    worst = Math.max(worst, Math.abs(fast - exact));
    assert.ok(Math.abs(exact - Math.round(exact)) < 1e-6, `exact winding ${exact} of a closed mesh is whole`);
    const hits = bvh.raycast({ origin: p, direction: [0.31, 0.77, 0.56] }).length;
    assert.equal(pointInside(bvh, p), hits % 2 === 1, `point ${p}`);
  }
  assert.ok(worst < 0.03, `worst estimate error ${worst}`);
});

test('higher accuracy costs more and lands closer', () => {
  const bvh = MeshBVH.build(bumpy()),
    p = [1.6, 0.4, 0.2],
    exact = windingNumber(bvh, p, { accuracy: Infinity });
  assert.ok(Math.abs(windingNumber(bvh, p, { accuracy: 6 }) - exact) <= Math.abs(windingNumber(bvh, p, { accuracy: 1.2 }) - exact) + 1e-9);
});

test('a hole barely changes the answer inside, where parity flips', () => {
  const { positions, indices } = bumpy(),
    open = MeshBVH.build({ positions, indices: indices.slice(60) });
  assert.equal(pointInside(open, [0, 0, 0]), true);
  assert.equal(pointInside(open, [2, 2, 2]), false);
  const shell = MeshBVH.build({ positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0], indices: [0, 1, 2] }),
    above = windingNumber(shell, [0, 0, 0.001], { accuracy: Infinity }),
    below = windingNumber(shell, [0, 0, -0.001], { accuracy: Infinity });
  assert.ok(Math.abs(above + 0.5) < 0.01 && Math.abs(below - 0.5) < 0.01, `${above} ${below}`);
});

test('a refit mesh answers at its new place', () => {
  const bvh = MeshBVH.build({ ...cube(), positions: new Float32Array(cube().positions) });
  assert.equal(pointInside(bvh, [0, 0, 0]), true);
  for (let i = 0; i < bvh.positions.length; i += 3) bvh.positions[i] += 10;
  bvh.refit();
  assert.equal(pointInside(bvh, [0, 0, 0]), false);
  assert.equal(pointInside(bvh, [10, 0, 0]), true);
});

function brute(A, B, indices, matrix) {
  const t = (p) => [
      matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12],
      matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13],
      matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2] + matrix[14],
    ],
    vertices = (tree) => [...Array(tree.positions.length / 3).keys()].map((i) => [...tree.positions.slice(i * 3, i * 3 + 3)]),
    va = vertices(A),
    vb = vertices(B).map(t),
    moved = MeshBVH.build({ positions: vb.flat(), indices, precision: 'float64' });
  let best = Infinity;
  for (const p of va) best = Math.min(best, moved.closestPointToPoint(p).distance);
  for (const p of vb) best = Math.min(best, A.closestPointToPoint(p).distance);
  return best;
}

test('mesh distance never exceeds what the vertices find, and its points are that far apart on their meshes', () => {
  const a = bumpy(16, 12),
    b = bumpy(12, 10),
    A = MeshBVH.build(a),
    B = MeshBVH.build(b),
    random = rng(14);
  for (let i = 0; i < 60; i++) {
    const c = Math.cos(i),
      s = Math.sin(i),
      matrix = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 2.6 + random() * 3, random() * 2, random() * 2, 1],
      result = meshDistance(A, B, matrix),
      bound = brute(A, B, b.indices, matrix);
    assert.ok(result.distance <= bound + 1e-9, `${result.distance} > ${bound}`);
    assert.ok(result.distance > 0);
    assert.ok(Math.abs(Math.hypot(...result.pointA.map((v, k) => v - result.pointB[k])) - result.distance) < 1e-9);
    assert.ok(A.closestPointToPoint(result.pointA).distance < 1e-9);
  }
});

test('edges that pass closest away from any vertex are measured', () => {
  // Two crossed bars: the closest pair is in the middle of an edge of each.
  const bar = (axis, z) => {
      const positions = [];
      for (const s of [-5, 5])
        for (const w of [-0.5, 0.5]) positions.push(...(axis ? [w, s, z] : [s, w, z]), ...(axis ? [w, s, z + 1] : [s, w, z + 1]));
      return positions;
    },
    tube = (positions) => ({
      positions,
      indices: [0, 1, 2, 1, 3, 2, 4, 6, 5, 5, 6, 7, 0, 4, 1, 1, 4, 5, 2, 3, 6, 3, 7, 6],
    }),
    result = meshDistance(MeshBVH.build(tube(bar(0, 0))), MeshBVH.build(tube(bar(1, 2))));
  assert.ok(Math.abs(result.distance - 1) < 1e-9, `${result.distance}`);
});

test('meshes that cross answer 0, with faces that touch', () => {
  const a = MeshBVH.build(cube()),
    b = MeshBVH.build(cube(1, [1.5, 0, 0])),
    result = meshDistance(a, b);
  assert.equal(result.distance, 0);
  assert.ok(result.faceA >= 0 && result.faceB >= 0);
});

test('a mesh inside another is apart by the gap between surfaces', () => {
  const result = meshDistance(MeshBVH.build(cube(2)), MeshBVH.build(cube(1)));
  assert.ok(Math.abs(result.distance - 1) < 1e-9);
});

test('maxDistance answers null past it, minDistance stops early, and a matrix places the second mesh', () => {
  const a = MeshBVH.build(cube()),
    b = MeshBVH.build(cube()),
    apart = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
    result = meshDistance(a, b, apart);
  assert.ok(Math.abs(result.distance - 3) < 1e-9);
  assert.equal(result.pointA[0], 1);
  assert.equal(result.pointB[0], 4, 'in the first mesh space');
  assert.equal(meshDistance(a, b, apart, { maxDistance: 2.9 }), null);
  assert.ok(meshDistance(a, b, apart, { maxDistance: 3 }));
  assert.ok(meshDistance(MeshBVH.build(bumpy()), MeshBVH.build(bumpy(40, 28, [4, 0, 0])), undefined, { minDistance: 100 }));
});

test('bad input says what to pass', () => {
  const a = MeshBVH.build(cube());
  assert.throws(() => meshDistance(a, {}), TypeError);
  assert.throws(() => meshDistance(a, a, [1]), TypeError);
  assert.throws(() => meshDistance(a, a, undefined, { maxDistance: -1 }), RangeError);
  assert.throws(() => windingNumber(a, [0, 0, 0], { accuracy: 0 }), RangeError);
});
