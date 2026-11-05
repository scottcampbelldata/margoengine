// Tessellation against what it promises: no edge over the limit, the same surface, and no cracks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxGeometry, computeTangents, mergeGeometries, planeGeometry, sphereGeometry, torusGeometry } from '../dist/index.js';
import { tessellateGeometry, tessellateWithParents } from '../dist/tessellate.js';
import { assertValid, close, point, signedVolume, surfaceArea, vertexCount, watertight } from './support/mesh-checks.js';

function longestEdge(data) {
  let longest = 0;
  for (let t = 0; t < data.indices.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = point(data, data.indices[t + k]),
        b = point(data, data.indices[t + ((k + 1) % 3)]);
      longest = Math.max(longest, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  return longest;
}

test('no edge stays over the limit and the surface does not change', () => {
  for (const limit of [0.5, 0.2, 0.05]) {
    const box = boxGeometry(2, 3, 1),
      fine = tessellateGeometry(box, limit);
    assert.ok(longestEdge(fine) <= limit * (1 + 1e-6), `edges under ${limit}`);
    close(surfaceArea(fine), surfaceArea(box), 1e-3, 'area');
    close(signedVolume(fine), signedVolume(box), 1e-3, 'volume');
    assertValid(fine, 'box');
    watertight(fine, 'box');
  }
});

test('a mesh already fine enough comes back the same, in new arrays', () => {
  const plane = planeGeometry(1, 1, 4, 4),
    same = tessellateGeometry(plane, 10);
  assert.deepEqual(same.positions, plane.positions);
  assert.deepEqual(same.indices, plane.indices);
  assert.notEqual(same.positions, plane.positions);
});

test('the input is left alone', () => {
  const box = boxGeometry(1, 1, 1),
    before = box.positions.slice(),
    indices = box.indices.slice();
  tessellateGeometry(box, 0.1);
  assert.deepEqual(box.positions, before);
  assert.deepEqual(box.indices, indices);
});

test('neighbours agree across seams, hard edges and different triangle splits', () => {
  // Every face of a box has its own vertices, so the cube only stays closed if both sides split alike.
  const fine = tessellateGeometry(boxGeometry(1, 1, 1), 0.07);
  watertight(fine, 'split faces');
  // A sphere has a UV seam and poles.
  const sphere = tessellateGeometry(sphereGeometry(1, 12, 8), 0.1);
  assert.ok(longestEdge(sphere) <= 0.1 * (1 + 1e-6));
  watertight(sphere, 'seamed sphere');
  // Two quads sharing an edge, cut along opposite diagonals.
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2, 1, 0];
  const data = {
    positions: Float32Array.from(positions),
    normals: new Float32Array(18).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    uvs: new Float32Array(12),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]),
  };
  const cut = tessellateGeometry(data, 0.3);
  const line = new Set();
  for (let i = 0; i < vertexCount(cut); i++) if (point(cut, i)[0] === 1) line.add(point(cut, i)[1]);
  const steps = [...line].sort((a, b) => a - b);
  assert.deepEqual(steps, [0, 0.25, 0.5, 0.75, 1], 'one set of points along the shared edge');
});

test('displacing the new vertices leaves no cracks', () => {
  const fine = tessellateGeometry(boxGeometry(2, 2, 2), 0.1),
    moved = { ...fine, positions: fine.positions.slice() };
  for (let i = 0; i < vertexCount(fine); i++) {
    const [x, y, z] = point(fine, i),
      length = Math.hypot(x, y, z),
      r = 1 + 0.1 * Math.sin(x * 5) * Math.sin(y * 5) * Math.sin(z * 5);
    moved.positions.set([(x / length) * r, (y / length) * r, (z / length) * r], i * 3);
  }
  watertight(moved, 'displaced');
});

test('normals, UVs and tangents are interpolated', () => {
  const plane = computeTangents(planeGeometry(4, 2, 1, 1)),
    fine = tessellateGeometry(plane, 0.2);
  assert.ok(fine.tangents);
  assert.equal(fine.tangents.length, vertexCount(fine) * 4);
  for (let i = 0; i < vertexCount(fine); i++) {
    const [x, y] = point(fine, i);
    close(fine.uvs[i * 2], x / 4 + 0.5, 1e-5, 'u follows x');
    close(fine.uvs[i * 2 + 1], y / 2 + 0.5, 1e-5, 'v follows y');
    close(fine.normals[i * 3 + 2], 1, 1e-6, 'normal');
    close(Math.hypot(fine.tangents[i * 4], fine.tangents[i * 4 + 1], fine.tangents[i * 4 + 2]), 1, 1e-5, 'tangent');
    assert.equal(fine.tangents[i * 4 + 3], plane.tangents[3]);
  }
  const sphere = tessellateGeometry(sphereGeometry(1, 8, 6), 0.1);
  for (let i = 0; i < vertexCount(sphere); i++)
    close(Math.hypot(sphere.normals[i * 3], sphere.normals[i * 3 + 1], sphere.normals[i * 3 + 2]), 1, 1e-5, 'unit');
});

test('groups follow their triangles', () => {
  const box = boxGeometry(1, 1, 1),
    fine = tessellateGeometry(box, 0.2);
  assert.equal(fine.groups.length, box.groups.length);
  let next = 0;
  for (const [i, group] of fine.groups.entries()) {
    assert.equal(group.materialIndex, box.groups[i].materialIndex);
    assert.equal(group.start, next, 'groups stay end to end');
    next += group.count;
    // Each box face is flat, so every triangle of a group lies on one side.
    const faces = new Set();
    for (let t = group.start; t < group.start + group.count; t++) {
      const v = fine.indices[t];
      faces.add([0, 1, 2].map((k) => Math.round(fine.normals[v * 3 + k])).join());
    }
    assert.equal(faces.size, 1, `group ${i} holds one face`);
  }
  assert.equal(next, fine.indices.length);
  const merged = mergeGeometries([boxGeometry(1, 1, 1), torusGeometry(1, 0.3, 8, 12)], true);
  const parts = tessellateGeometry(merged, 0.3);
  assert.equal(parts.groups.at(-1).start + parts.groups.at(-1).count, parts.indices.length);
});

test('winding is kept', () => {
  const box = boxGeometry(1, 1, 1),
    fine = tessellateGeometry(box, 0.05);
  assert.ok(signedVolume(fine) > 0.99, 'still outward');
});

test('angles stay bounded: splitting the longest edge never makes slivers worse than a set limit', () => {
  const fine = tessellateGeometry(planeGeometry(10, 10, 1, 1), 0.1);
  let smallest = Infinity;
  for (let t = 0; t < fine.indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => point(fine, fine.indices[t + k]));
    for (let k = 0; k < 3; k++) {
      const a = p[k],
        b = p[(k + 1) % 3],
        c = p[(k + 2) % 3],
        u = [b[0] - a[0], b[1] - a[1]],
        v = [c[0] - a[0], c[1] - a[1]],
        angle = Math.acos((u[0] * v[0] + u[1] * v[1]) / Math.hypot(...u) / Math.hypot(...v));
      smallest = Math.min(smallest, angle);
    }
  }
  assert.ok(smallest > (20 * Math.PI) / 180, `smallest angle ${(smallest * 180) / Math.PI} degrees`);
});

test('parents let your own attributes follow', () => {
  const plane = planeGeometry(2, 2, 1, 1),
    original = vertexCount(plane),
    height = new Float32Array(original).map((_, i) => point(plane, i)[0] * 3 + point(plane, i)[1]),
    { data, parents } = tessellateWithParents(plane, 0.25),
    all = new Float32Array(vertexCount(data));
  assert.equal(parents.length, (vertexCount(data) - original) * 2);
  all.set(height);
  for (let v = original; v < all.length; v++) {
    const a = parents[(v - original) * 2],
      b = parents[(v - original) * 2 + 1];
    assert.ok(a < v && b < v, 'parents come first');
    all[v] = (all[a] + all[b]) / 2;
    const [x, y] = point(data, v);
    close(all[v], x * 3 + y, 1e-5, 'a linear attribute stays linear');
  }
});

test('rejects bad limits and broken meshes', () => {
  const box = boxGeometry(1, 1, 1);
  for (const limit of [0, -1, NaN, Infinity]) assert.throws(() => tessellateGeometry(box, limit), RangeError);
  assert.throws(() => tessellateGeometry(box, 1e-4), /maxTriangles/);
  assert.throws(() => tessellateGeometry(box, 0.1, { maxTriangles: 10 }), /maxTriangles/);
  assert.throws(() => tessellateGeometry(box, 0.1, { maxTriangles: 0 }), RangeError);
  assert.throws(() => tessellateGeometry({ ...box, indices: Uint32Array.from([0, 1, 999]) }, 1), RangeError);
  assert.throws(() => tessellateGeometry({ ...box, indices: Uint32Array.from([0, 1]) }, 1), RangeError);
  const bad = box.positions.slice();
  bad[0] = NaN;
  assert.throws(() => tessellateGeometry({ ...box, positions: bad }, 1), RangeError);
});
