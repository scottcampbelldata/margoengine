import assert from 'node:assert/strict';
import test from 'node:test';

const K = await import('../dist/index.js');
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x, y, z) => [...identity.slice(0, 12), x, y, z, 1];
const ids = () => {
  let n = 0;
  return { createId: () => `child-${n++}` };
};
const close = (a, b, epsilon = 1e-12) => {
  assert.equal(a.length, b.length);
  a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) <= epsilon, `${value} != ${b[i]}`));
};
const api = () => {
  assert.equal(typeof K.meshSelectionVertices, 'function', 'public component selection resolver');
  assert.equal(typeof K.transformMeshComponents, 'function', 'public component transform');
};
const plane = () => ({
  vertices: [
    [0.1, 0.2, 0],
    [1.1, 0.2, 0],
    [1.1, 1.2, 0],
    [0.1, 1.2, 0],
  ],
  faces: [
    {
      id: 'paint',
      vertices: [0, 1, 2, 3],
      uv: [
        [0.1, 0.9],
        [0.3, 0.9],
        [0.3, 0.6],
        [0.1, 0.6],
      ],
    },
  ],
});

test('selection resolves and deduplicates object, vertex, edge and face identities', () => {
  api();
  const mesh = plane();
  assert.deepEqual(K.meshSelectionVertices(mesh, { mode: 'object' }), [0, 1, 2, 3]);
  assert.deepEqual(K.meshSelectionVertices(mesh, { mode: 'vertex', vertices: [3, 0, 3] }), [0, 3]);
  assert.deepEqual(K.meshSelectionVertices(mesh, { mode: 'edge', edges: ['0:1', '1:2', '0:1'] }), [0, 1, 2]);
  assert.deepEqual(K.meshSelectionVertices(mesh, { mode: 'face', faces: ['paint', 'paint'] }), [0, 1, 2, 3]);
  assert.deepEqual(K.meshSelectionVertices(mesh, { mode: 'vertex', vertices: [] }), []);
  for (const selection of [
    null,
    { mode: 'bogus' },
    { mode: 'vertex', vertices: [4] },
    { mode: 'vertex', vertices: [-1] },
    { mode: 'vertex', vertices: [0.5] },
    { mode: 'edge', edges: ['1:0'] },
    { mode: 'edge', edges: ['0:2'] },
    { mode: 'face', faces: ['missing'] },
    { mode: 'face', faces: [0] },
  ]) {
    assert.throws(() => K.meshSelectionVertices(mesh, selection), /select|indices|identit|mode/i);
  }
});

test('single cube vertex warp persists valid deterministic triangles with unchanged corner UVs', () => {
  api();
  const mesh = K.createPrimitiveMesh('cube', 'cube'),
    before = structuredClone(mesh);
  const result = K.transformMeshComponents(
    mesh,
    { mode: 'vertex', vertices: [0] },
    translation(-0.1, -0.2, -0.15),
    ids(),
  );
  assert.deepEqual(mesh, before);
  assert.equal(result.mesh.faces.length, 9);
  assert.deepEqual(result.mesh.vertices[0], [-0.6, -0.7, -0.65]);
  assert.deepEqual(result.mesh.vertices.slice(1), before.vertices.slice(1));
  assert.equal(result.createdFaces.length, 3);
  assert.equal(result.diagnostics.length, 3);
  assert.ok(result.diagnostics.every((message) => /triangulat/i.test(message)));
  assert.equal(result.createdEdges.length, 3);
  assert.deepEqual(result.removedEdges, []);
  for (const old of before.faces) {
    const descendants = result.faceMap[old.id].map((id) => result.mesh.faces.find((face) => face.id === id));
    assert.equal(descendants[0].id, old.id);
    assert.equal(descendants.length, old.vertices.includes(0) ? 2 : 1);
    for (const child of descendants)
      for (let i = 0; i < child.vertices.length; i++) {
        assert.deepEqual(child.uv[i], old.uv[old.vertices.indexOf(child.vertices[i])]);
      }
  }
  assert.doesNotThrow(() => K.compilePolygonMesh(result.mesh));
  assert.ok(K.polygonMeshEdges(result.mesh).every((edge) => edge.incidences.length === 2));
  assert.deepEqual(
    result.vertexMap,
    before.vertices.map((_, i) => [i]),
  );
});

test('world snapping touches selected vertices only and preserves all UV values and result ownership', () => {
  api();
  const mesh = plane(),
    before = structuredClone(mesh);
  const result = K.transformMeshComponents(mesh, { mode: 'edge', edges: ['0:1'] }, translation(0, -0.11, 0), {
    snapStep: 0.25,
  });
  assert.deepEqual(result.mesh.vertices, [
    [0, 0, 0],
    [1, 0, 0],
    [1.1, 1.2, 0],
    [0.1, 1.2, 0],
  ]);
  assert.deepEqual(result.mesh.faces[0].uv, before.faces[0].uv);
  assert.deepEqual(result.edgeMap, { '0:1': ['0:1'], '1:2': ['1:2'], '2:3': ['2:3'], '0:3': ['0:3'] });
  assert.deepEqual(result.createdEdges, []);
  result.mesh.vertices[2][0] = 99;
  result.mesh.faces[0].uv[0][0] = 0.99;
  result.edgeMap['0:1'].push('bogus');
  assert.deepEqual(mesh, before);
  assert.notEqual(result.faceMap.paint, result.affectedFaces);
});

test('world deltas respect translated mirrored nonuniform object matrices and snap in world space', () => {
  api();
  const mesh = plane();
  const worldMatrix = [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 10, -7, 5, 1];
  const result = K.transformMeshComponents(mesh, { mode: 'object' }, translation(1, 3, -2), { worldMatrix });
  mesh.vertices.forEach((point, i) => close(result.mesh.vertices[i], [point[0] - 0.5, point[1] + 1, point[2] - 0.5]));
  const snapped = K.transformMeshComponents(mesh, { mode: 'object' }, identity, { worldMatrix, snapStep: 1 });
  close(snapped.mesh.vertices[0], [0, 1 / 3, 0]);
  assert.deepEqual(result.mesh.faces[0].uv, mesh.faces[0].uv);
  const rotatedWorld = [0, -2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 10, -7, 5, 1];
  const rotated = K.transformMeshComponents(mesh, { mode: 'object' }, translation(1, 3, -2), {
    worldMatrix: rotatedWorld,
  });
  mesh.vertices.forEach((point, i) =>
    close(rotated.mesh.vertices[i], [point[0] - 1.5, point[1] - 1 / 3, point[2] - 0.5]),
  );
});

test('a 180 degree object rotation is valid even when every normal reverses', () => {
  api();
  const mesh = plane();
  const result = K.transformMeshComponents(
    mesh,
    { mode: 'object' },
    [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
  );
  mesh.vertices.forEach((point, i) => close(result.mesh.vertices[i], [point[0], -point[1], -point[2]]));
  assert.equal(result.mesh.faces.length, 1);
  assert.doesNotThrow(() => K.compilePolygonMesh(result.mesh));
});

test('invalid transforms, collapsed or crossed geometry and requested nonplanarity rejection are atomic', () => {
  api();
  const mesh = plane(),
    before = structuredClone(mesh);
  const run = (selection, delta, options) => {
    assert.throws(() => K.transformMeshComponents(mesh, selection, delta, options));
    assert.deepEqual(mesh, before);
  };
  run({ mode: 'object' }, identity, { snapStep: 0 });
  run({ mode: 'object' }, identity, { snapStep: Number.NaN });
  run({ mode: 'object' }, identity, { nonPlanarFaces: 'silently-ignore' });
  run({ mode: 'object' }, identity.slice(1));
  run(
    { mode: 'object' },
    identity.map((v, i) => (i === 0 ? -1 : v)),
  );
  run(
    { mode: 'object' },
    identity.map((v, i) => (i === 0 ? 0 : v)),
  );
  run({ mode: 'object' }, identity, { worldMatrix: identity.map((v, i) => (i === 0 ? 0 : v)) });
  run({ mode: 'vertex', vertices: [0] }, translation(1, 1, 0));
  run({ mode: 'vertex', vertices: [0] }, translation(2, 0.5, 0));
  run({ mode: 'vertex', vertices: [0] }, translation(2, 0.5, 0.2));
  run({ mode: 'vertex', vertices: [0] }, translation(0, 0, 0.2), { nonPlanarFaces: 'reject' });
  run({ mode: 'vertex', vertices: [0] }, translation(0, 0, 0.2), { createId: () => 'paint' });
});
