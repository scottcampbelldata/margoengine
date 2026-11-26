import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '@margoengine/core';
import { booleanMeshesExact } from '@margoengine/mesh-edit/boolean-exact';
import { fromPolygonMesh, toPolygonMesh } from '@margoengine/mesh-edit/geometry';

const volume = (geometry) => {
  let sum = 0;
  const v = geometry.vertices;
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => geometry.indices[i + k] * 6);
    sum +=
      v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) +
      v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) +
      v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return sum / 6;
};
const prefixed = (mesh, prefix, [x, y, z]) => ({
  vertices: mesh.vertices.map((p) => [p[0] + x, p[1] + y, p[2] + z]),
  faces: mesh.faces.map((f) => ({ ...f, id: prefix + f.id })),
});

test('a core box goes into mesh-edit as six quads and back as the same volume', () => {
  const { mesh } = toPolygonMesh(box(2, 2, 2));
  assert.equal(mesh.vertices.length, 8);
  assert.equal(mesh.faces.length, 6);
  const back = fromPolygonMesh(mesh);
  assert.ok(Math.abs(volume(back) - 8) < 1e-9);
  assert.equal(back.indices.length, 36);
});

test('cube minus an overlapping cube leaves the expected volume', () => {
  const a = toPolygonMesh(box(2, 2, 2)).mesh,
    b = prefixed(toPolygonMesh(box(2, 2, 2)).mesh, 'b-', [1, 1, 1]);
  const result = booleanMeshesExact(a, b, 'difference');
  assert.ok(Math.abs(volume(fromPolygonMesh(result.mesh)) - 7) < 1e-9, 'a unit corner is cut away');
});

test('conversion rejects what is not a geometry or a mesh, and an empty mesh gives an empty geometry', () => {
  assert.throws(() => toPolygonMesh({}), TypeError);
  assert.throws(() => fromPolygonMesh({}), TypeError);
  assert.equal(fromPolygonMesh({ vertices: [], faces: [] }).indices.length, 0);
  assert.throws(
    () =>
      fromPolygonMesh({
        vertices: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
        faces: [{ id: 'f', vertices: [0, 1, 2], uv: [[0, 0], [1, 0], [1, 1]] }],
      }),
    TypeError,
  );
});
