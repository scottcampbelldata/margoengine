// Mesh optimisation: the same triangles with fewer cache misses, less overdraw on a software depth buffer, and vertex
// buffers read front to back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boxGeometry,
  mergeGeometries,
  mergeVertices,
  sphereGeometry,
  applyMatrix4,
  torusKnotGeometry,
  computeTangents,
  planeGeometry,
} from '../dist/index.js';
import {
  analyzeVertexCache,
  optimizeMesh,
  optimizeOverdraw,
  optimizeVertexCache,
  optimizeVertexFetch,
  vertexFetchRemap,
} from '../dist/optimize.js';
import { close } from './support/mesh-checks.js';

/** Triangles as a sorted list of position triples, each rotated to a canonical start so winding still counts. */
function triangleSet(data, from = 0, to = data.indices.length) {
  const out = [];
  for (let t = from; t < to; t += 3) {
    const corners = [0, 1, 2].map((k) => {
        const v = data.indices[t + k];
        return [
          ...data.positions.subarray(v * 3, v * 3 + 3),
          ...data.normals.subarray(v * 3, v * 3 + 3),
          ...data.uvs.subarray(v * 2, v * 2 + 2),
        ].join();
      }),
      first = corners.indexOf([...corners].sort()[0]);
    out.push([0, 1, 2].map((k) => corners[(first + k) % 3]).join('|'));
  }
  return out.sort();
}

/** A shuffled copy of a mesh's triangle order: what a mesh looks like after an export that does not care. */
function shuffled(data, seed = 7) {
  const indices = Uint32Array.from(data.indices),
    count = indices.length / 3;
  let state = seed;
  for (let i = count - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    for (let k = 0; k < 3; k++) [indices[i * 3 + k], indices[j * 3 + k]] = [indices[j * 3 + k], indices[i * 3 + k]];
  }
  return { ...data, indices };
}

/**
 * Overdraw of an index order on a software depth buffer, looking along each axis both ways with back faces culled:
 * pixels written over pixels finally covered. 1 means every pixel was shaded once.
 */
function overdraw(data, indices = data.indices, size = 96) {
  const P = data.positions;
  let lo = Infinity,
    hi = -Infinity;
  for (const p of P) {
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  const scale = (size - 1) / (hi - lo);
  let shaded = 0,
    covered = 0;
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [1, -1]) {
      const depth = new Float64Array(size * size).fill(Infinity),
        x = (axis + 1) % 3,
        y = (axis + 2) % 3,
        project = (v) => [(P[v * 3 + x] - lo) * scale, (P[v * 3 + y] - lo) * scale, -sign * P[v * 3 + axis]];
      for (let t = 0; t < indices.length; t += 3) {
        const a = project(indices[t]),
          b = project(indices[t + 1]),
          c = project(indices[t + 2]),
          area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (area * sign <= 0) continue;
        const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))),
          x1 = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0]))),
          y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))),
          y1 = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        for (let py = y0; py <= y1; py++)
          for (let px = x0; px <= x1; px++) {
            const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area,
              w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area,
              w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w0 * a[2] + w1 * b[2] + w2 * c[2],
              at = py * size + px;
            if (z >= depth[at]) continue;
            if (depth[at] === Infinity) covered++;
            depth[at] = z;
            shaded++;
          }
      }
    }
  return shaded / covered;
}

test('analyzeVertexCache counts a first-in first-out cache by hand', () => {
  // A strip of two triangles shares an edge: 4 misses, 6 references.
  assert.deepEqual(analyzeVertexCache([0, 1, 2, 2, 1, 3]), { misses: 4, acmr: 2, atvr: 1 });
  // A cache of 3 holds 0, 1, 2; vertex 3 pushes out 0; asking for 0 again misses, and it does not refresh on a hit.
  assert.equal(analyzeVertexCache([0, 1, 2, 3, 4, 5, 0, 1, 2], undefined, 3).misses, 9);
  assert.equal(analyzeVertexCache([0, 1, 2, 0, 1, 2], undefined, 3).misses, 3);
  assert.deepEqual(analyzeVertexCache([]), { misses: 0, acmr: 0, atvr: 0 });
});

test('a shuffled mesh gets back to a good miss ratio and keeps every triangle', () => {
  for (const [label, mesh, target] of [
    ['grid', planeGeometry(10, 10, 80, 80), 0.75],
    ['sphere', sphereGeometry(1, 64, 48), 0.8],
    ['knot', torusKnotGeometry(1, 0.3, 200, 24), 0.8],
  ]) {
    const scrambled = shuffled(mesh),
      before = analyzeVertexCache(scrambled.indices).acmr,
      indices = optimizeVertexCache(scrambled.indices, mesh.positions.length / 3),
      after = analyzeVertexCache(indices).acmr;
    assert.ok(before > 2, `${label} starts bad (${before})`);
    assert.ok(after < target, `${label} ends at ${after}, wanted under ${target}`);
    assert.deepEqual(triangleSet({ ...mesh, indices }), triangleSet(mesh), `${label} keeps its triangles`);
  }
});

test('it also beats the good order a generator already wrote', () => {
  const grid = planeGeometry(10, 10, 100, 100),
    before = analyzeVertexCache(grid.indices).acmr,
    after = analyzeVertexCache(optimizeVertexCache(grid.indices)).acmr;
  assert.ok(after < before * 0.75, `row-by-row ${before} -> ${after}`);
});

test('degenerate, repeated and lone triangles survive', () => {
  const indices = [0, 0, 1, 2, 3, 4, 2, 3, 4, 7, 7, 7],
    out = optimizeVertexCache(indices);
  const sorted = (list) =>
    Array.from({ length: list.length / 3 }, (_, t) => Array.from(list.slice(t * 3, t * 3 + 3)).join()).sort();
  assert.deepEqual(sorted(out), sorted(indices));
  assert.equal(optimizeVertexCache([]).length, 0);
});

test('overdraw falls on nested shells and the miss ratio stays near the input', () => {
  // Three spheres inside one another, built inner first: the worst order, every outer pixel shaded three times over.
  const shell = (r) => sphereGeometry(r, 48, 32),
    mesh = mergeGeometries([shell(0.6), shell(0.8), shell(1)]),
    cached = optimizeVertexCache(mesh.indices),
    sorted = optimizeOverdraw(cached, mesh.positions),
    before = overdraw(mesh, cached),
    after = overdraw(mesh, sorted),
    missBefore = analyzeVertexCache(cached).acmr,
    missAfter = analyzeVertexCache(sorted).acmr;
  assert.ok(after < before * 0.6, `overdraw ${before} -> ${after}`);
  assert.ok(missAfter <= missBefore * 1.06, `miss ratio ${missBefore} -> ${missAfter}`);
  assert.deepEqual(triangleSet({ ...mesh, indices: sorted }), triangleSet(mesh));
});

test('a looser threshold allows more clusters; threshold 1 still returns every triangle', () => {
  const mesh = torusKnotGeometry(1, 0.3, 120, 16),
    cached = optimizeVertexCache(mesh.indices);
  for (const threshold of [1, 1.05, 2]) {
    const sorted = optimizeOverdraw(cached, mesh.positions, { threshold });
    assert.deepEqual(triangleSet({ ...mesh, indices: sorted }), triangleSet(mesh), `threshold ${threshold}`);
  }
});

test('vertex fetch: buffers are in order of first use, unused vertices go, and attributes follow', () => {
  const tangents = computeTangents(sphereGeometry(1, 16, 12)),
    mesh = shuffled(tangents),
    out = optimizeVertexFetch(mesh);
  let next = 0;
  for (const v of out.indices) {
    assert.ok(v <= next, 'a new vertex is always the next one');
    if (v === next) next++;
  }
  assert.deepEqual(triangleSet(out), triangleSet(mesh));
  for (let t = 0; t < out.indices.length; t++) {
    const a = out.indices[t],
      b = mesh.indices[t];
    assert.deepEqual(out.tangents.subarray(a * 4, a * 4 + 4), mesh.tangents.subarray(b * 4, b * 4 + 4));
  }

  const spare = {
      positions: Float32Array.of(9, 9, 9, 0, 0, 0, 1, 0, 0, 0, 1, 0),
      normals: new Float32Array(12),
      uvs: new Float32Array(8),
      indices: Uint32Array.of(3, 1, 2),
    },
    tight = optimizeVertexFetch(spare);
  assert.equal(tight.positions.length, 9);
  assert.deepEqual(tight.indices, Uint32Array.of(0, 1, 2));
  assert.deepEqual(Array.from(tight.positions.subarray(0, 3)), [0, 1, 0]);
  assert.deepEqual(vertexFetchRemap(spare.indices, 4), Uint32Array.of(0xffffffff, 1, 2, 0));
  assert.equal(spare.positions.length, 12, 'input untouched');
});

test('optimizeMesh keeps groups, winding and attributes, and leaves the input alone', () => {
  const box = mergeVertices(boxGeometry(1, 1, 1, 8, 8, 8)),
    mesh = shuffled(box),
    frozen = Uint32Array.from(mesh.indices),
    out = optimizeMesh(mesh);
  assert.deepEqual(mesh.indices, frozen);
  assert.equal(out.groups.length, mesh.groups.length);
  // Shuffling mixed the faces, so groups here are arbitrary triangle stretches: each must keep its own.
  for (let g = 0; g < out.groups.length; g++) {
    const { start, count, materialIndex } = out.groups[g];
    assert.deepEqual(mesh.groups[g], { start, count, materialIndex });
    assert.deepEqual(triangleSet(out, start, start + count), triangleSet(mesh, start, start + count));
  }
  // The shuffle spread each face over every group, so a group's triangles are scattered and less can be reused.
  assert.ok(analyzeVertexCache(out.indices).acmr < analyzeVertexCache(mesh.indices).acmr * 0.8);

  const plain = optimizeMesh(shuffled(sphereGeometry(1, 32, 24)), { overdraw: false });
  assert.deepEqual(plain.groups, undefined);
  assert.ok(analyzeVertexCache(plain.indices).acmr < 0.85);
});

test('groups that overlap or leave gaps still keep every triangle in its index range', () => {
  const sphere = sphereGeometry(1, 16, 12),
    third = Math.floor(sphere.indices.length / 9) * 3,
    mesh = {
      ...sphere,
      groups: [
        { start: 0, count: third * 2, materialIndex: 0 },
        { start: third, count: third * 2, materialIndex: 1 },
      ],
    },
    out = optimizeMesh(mesh);
  for (const [from, to] of [
    [0, third],
    [third, third * 2],
    [third * 2, third * 3],
    [third * 3, sphere.indices.length],
  ])
    assert.deepEqual(triangleSet(out, from, to), triangleSet(mesh, from, to));
});

test('a transform of the mesh does not change the order chosen', () => {
  const mesh = sphereGeometry(1, 24, 16),
    moved = applyMatrix4(mesh, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, -3, 1, 1]),
    a = optimizeMesh(mesh),
    b = optimizeMesh(moved);
  assert.deepEqual(a.indices, b.indices);
  close(b.positions[0], a.positions[0] * 2 + 5, 1e-5, 'moved with the buffers');
});

test('invalid input is refused with the fix in the message', () => {
  assert.throws(() => optimizeVertexCache([0, 1]), /whole triangles/);
  assert.throws(() => optimizeVertexCache([0, 1, -2]), /integers/);
  assert.throws(() => optimizeVertexCache([0, 1, 2.5]), /integers/);
  assert.throws(() => optimizeVertexCache([0, 1, 5], 3), /past 3 vertices/);
  assert.throws(() => optimizeVertexCache([0, 1, 2], -1), /vertex count/);
  assert.throws(() => analyzeVertexCache([0, 1, 2], undefined, 1), /cache size/);
  assert.throws(() => optimizeOverdraw([0, 1, 2], [0, 0]), /positions/);
  assert.throws(() => optimizeOverdraw([0, 1, 2], new Array(9).fill(0), { threshold: 0.5 }), /threshold/);
  assert.throws(() => optimizeOverdraw([0, 1, 2], new Array(9).fill(0), { cacheSize: 0 }), /cache size/);
  const sphere = sphereGeometry(1, 4, 4);
  assert.throws(
    () => optimizeMesh({ ...sphere, groups: [{ start: 1, count: 3, materialIndex: 0 }] }),
    /whole triangles/,
  );
  assert.throws(
    () => optimizeMesh({ ...sphere, groups: [{ start: 0, count: 1e6, materialIndex: 0 }] }),
    /whole triangles/,
  );
  assert.throws(() => optimizeVertexFetch({ ...sphere, indices: Uint32Array.of(0, 1, 9999) }), /past/);
});
