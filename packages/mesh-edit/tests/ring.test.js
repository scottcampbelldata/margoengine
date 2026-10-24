import assert from 'node:assert/strict';
import test from 'node:test';

const K = await import('../dist/index.js');
const api = () => {
  assert.equal(typeof K.traceMeshQuadRing, 'function', 'public ring tracer');
  assert.equal(typeof K.cutMeshQuadRing, 'function', 'public ring cut');
};
const ids = (prefix = 'cut') => {
  let n = 0;
  return { createId: () => `${prefix}-${n++}` };
};
const edgeId = (a, b) => `${Math.min(a, b)}:${Math.max(a, b)}`;
const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-12, `${a} != ${b}`));
const strip = () => ({
  vertices: [
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [1, 1, 0],
    [2, 0, 0],
    [2, 1, 0],
    [3, 0, 0],
    [3, 1, 0],
  ],
  faces: [
    [0, 2, 3, 1],
    [2, 4, 5, 3],
    [4, 6, 7, 5],
  ].map((vertices, i) => ({
    id: `f${i}`,
    vertices,
    uv: [
      [0, 0],
      [0.8, 0.1],
      [0.9, 1],
      [0.1, 0.9],
    ],
  })),
});

test('painted eight-sided cylinder traces a closed oriented ring and cuts at 25 percent without seams or T junctions', () => {
  api();
  const mesh = K.createPrimitiveMesh('cylinder', 'c'),
    before = structuredClone(mesh);
  const trace = K.traceMeshQuadRing(mesh, { faceId: 'c-face-2', corner: 1 });
  assert.equal(trace.closed, true);
  assert.equal(trace.edges.length, 8);
  assert.equal(trace.faces.length, 8);
  assert.equal(new Set(trace.edges.map((e) => e.id)).size, 8);
  assert.ok(trace.edges.every(({ from, to }) => from < 8 && to === from + 8));
  const result = K.cutMeshQuadRing(mesh, { faceId: 'c-face-2', corner: 1 }, 0.25, ids());
  assert.deepEqual(mesh, before);
  assert.equal(result.mesh.vertices.length, 24);
  assert.equal(result.mesh.faces.length, 18);
  assert.deepEqual(result.mesh.faces.slice(0, 2), mesh.faces.slice(0, 2));
  assert.equal(result.ring.closed, true);
  assert.equal(result.ring.vertices.length, 8);
  assert.equal(result.ring.edges.length, 8);
  result.ring.vertices.forEach((vi) => assert.equal(result.mesh.vertices[vi][1], -0.25));
  const edges = K.polygonMeshEdges(result.mesh);
  assert.ok(edges.every((edge) => edge.incidences.length === 2));
  assert.equal(result.removedEdges.length, 8);
  assert.equal(result.createdEdges.length, 24);
  for (const old of K.polygonMeshEdges(mesh)) {
    const split = trace.edges.find((edge) => edge.id === old.id);
    if (!split) assert.deepEqual(result.edgeMap[old.id], [old.id]);
    else {
      const midpoint = result.mesh.vertices.findIndex(
        (point, i) =>
          i >= 16 &&
          Math.hypot(point[0] - mesh.vertices[old.vertices[0]][0], point[2] - mesh.vertices[old.vertices[0]][2]) <
            1e-12,
      );
      assert.deepEqual(result.edgeMap[old.id], [edgeId(old.vertices[0], midpoint), edgeId(midpoint, old.vertices[1])]);
    }
  }
  for (const old of mesh.faces.slice(2)) {
    assert.equal(result.faceMap[old.id].length, 2);
    const children = result.faceMap[old.id].map((id) => result.mesh.faces.find((face) => face.id === id));
    for (const child of children)
      for (let c = 0; c < 4; c++) {
        const vi = child.vertices[c],
          sourceCorner = old.vertices.indexOf(vi);
        if (sourceCorner >= 0) assert.deepEqual(child.uv[c], old.uv[sourceCorner]);
        else {
          // Vertical source edges are corners 1->2 (bottom->top) and 3->0 (top->bottom).
          const topCorner =
            Math.abs(result.mesh.vertices[vi][0] - mesh.vertices[old.vertices[1]][0]) < 1e-12 &&
            Math.abs(result.mesh.vertices[vi][2] - mesh.vertices[old.vertices[1]][2]) < 1e-12
              ? 2
              : 3;
          const bottomCorner = topCorner === 2 ? 1 : 0;
          close(
            child.uv[c],
            old.uv[bottomCorner].map((value, axis) => value * 0.75 + old.uv[topCorner][axis] * 0.25),
          );
        }
      }
  }
});

test('transported fractions interpolate both sides of a reversed shared UV seam independently', () => {
  api();
  const mesh = strip();
  mesh.faces[1].uv = [
    [0.2, 0.2],
    [0.6, 0.1],
    [0.7, 0.7],
    [0.3, 0.8],
  ];
  const result = K.cutMeshQuadRing(mesh, { faceId: 'f1', corner: 3 }, 0.25, ids());
  const midpoint = result.mesh.vertices.findIndex((v, i) => i >= 8 && v[0] === 1);
  assert.deepEqual(result.mesh.vertices[midpoint], [1, 0.75, 0]);
  const uvAt = (oldId) =>
    result.faceMap[oldId].flatMap((id) => {
      const face = result.mesh.faces.find((face) => face.id === id);
      return face.vertices.flatMap((v, c) => (v === midpoint ? [face.uv[c]] : []));
    });
  uvAt('f0').forEach((uv) => close(uv, [0.875, 0.775]));
  uvAt('f1').forEach((uv) => close(uv, [0.275, 0.65]));
});

test('open strips trace in both directions to geometric boundaries, retain quads, and support repeated cuts', () => {
  api();
  const mesh = strip();
  const trace = K.traceMeshQuadRing(mesh, { faceId: 'f1', corner: 1 });
  assert.equal(trace.closed, false);
  assert.deepEqual(new Set(trace.faces), new Set(['f0', 'f1', 'f2']));
  assert.equal(trace.edges.length, 4);
  const first = K.cutMeshQuadRing(mesh, { faceId: 'f1', corner: 1 }, 0.25, ids());
  assert.equal(first.ring.vertices.length, 4);
  assert.equal(first.ring.edges.length, 3);
  assert.equal(first.mesh.faces.length, 6);
  assert.ok(first.mesh.faces.every((face) => face.vertices.length === 4));
  const boundary = K.polygonMeshEdges(first.mesh).find(
    (edge) => edge.incidences.length === 1 && edge.vertices.includes(0) && edge.vertices.some((v) => v >= 8),
  );
  const incidence = boundary.incidences[0];
  const second = K.cutMeshQuadRing(
    first.mesh,
    { faceId: incidence.faceId, corner: incidence.corner },
    0.5,
    ids('second'),
  );
  assert.equal(second.mesh.vertices.length, 16);
  assert.equal(second.mesh.faces.length, 9);
  assert.equal(second.ring.vertices.length, 4);
  assert.doesNotThrow(() => K.compilePolygonMesh(second.mesh));
});

test('ring results own arrays and preserve source IDs, positions, UVs and complete edge maps', () => {
  api();
  const mesh = strip(),
    before = structuredClone(mesh);
  const result = K.cutMeshQuadRing(mesh, { faceId: 'f1', corner: 1 }, 0.25, ids());
  assert.deepEqual(result.mesh.vertices.slice(0, 8), before.vertices);
  assert.deepEqual(
    result.vertexMap,
    before.vertices.map((_, i) => [i]),
  );
  assert.deepEqual(result.removedVertices, []);
  assert.deepEqual(result.removedFaces, []);
  assert.equal(Object.keys(result.edgeMap).length, 10);
  assert.equal(result.createdVertices.length, 4);
  assert.equal(result.createdFaces.length, 3);
  result.mesh.vertices[0][0] = 99;
  result.mesh.faces[0].uv[0][0] = 0.9;
  result.edgeMap['0:1'].push('bogus');
  result.ring.vertices.length = 0;
  assert.equal(result.createdVertices.length, 4);
  assert.deepEqual(mesh, before);
});

test('invalid ring seeds, nonquad continuations, winding, nonmanifold topology and fractions reject atomically', () => {
  api();
  const mesh = strip(),
    before = structuredClone(mesh);
  for (const seed of [
    null,
    { faceId: 'missing', corner: 0 },
    { faceId: 'f0', corner: -1 },
    { faceId: 'f0', corner: 4 },
    { faceId: 'f0', corner: 0.5 },
  ]) {
    assert.throws(() => K.traceMeshQuadRing(mesh, seed));
  }
  for (const fraction of [0, 1, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => K.cutMeshQuadRing(mesh, { faceId: 'f1', corner: 1 }, fraction), /fraction/i);
    assert.deepEqual(mesh, before);
  }
  assert.throws(() => K.cutMeshQuadRing(mesh, { faceId: 'f1', corner: 1 }, 0.25, { createId: () => 'f0' }));
  const nonquad = strip();
  nonquad.faces[0].vertices.splice(0, 1);
  nonquad.faces[0].uv.splice(0, 1);
  assert.throws(() => K.traceMeshQuadRing(nonquad, { faceId: 'f1', corner: 1 }), /quad/i);
  const winding = strip();
  winding.faces[0].vertices.reverse();
  winding.faces[0].uv.reverse();
  assert.throws(() => K.traceMeshQuadRing(winding, { faceId: 'f1', corner: 1 }), /winding/i);
  const nonmanifold = strip();
  nonmanifold.faces.push({ ...structuredClone(nonmanifold.faces[0]), id: 'extra' });
  assert.throws(() => K.traceMeshQuadRing(nonmanifold, { faceId: 'f1', corner: 1 }), /manifold/i);
  assert.deepEqual(mesh, before);
});
