import assert from 'node:assert/strict';
import test from 'node:test';

// A missing package has the same visible RED assertion as a missing public export.
const K = await import('../dist/index.js').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const cube = () => ({
  vertices: [
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [0.5, 0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
  ],
  faces: [
    [1, 0, 3, 2],
    [4, 5, 6, 7],
    [0, 4, 7, 3],
    [5, 1, 2, 6],
    [3, 7, 6, 2],
    [0, 1, 5, 4],
  ].map((vertices, i) => ({
    id: `f${i}`,
    vertices,
    uv: [
      [0.1, 0.4],
      [0.4, 0.4],
      [0.4, 0.1],
      [0.1, 0.1],
    ],
  })),
});
const ids = () => {
  let n = 0;
  return { createId: () => `new-${n++}` };
};
const close = (actual, expected, epsilon = 1e-12) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= epsilon, `${value} != ${expected[i]}`));
};
const owned = (before, source, result) => {
  assert.deepEqual(source, before);
  assert.notEqual(result.mesh, source);
  assert.deepEqual(Object.keys(result.mesh).sort(), ['faces', 'vertices']);
  assert.notEqual(result.mesh.vertices, source.vertices);
  result.mesh.faces
    .filter((f) => source.faces.some((old) => old.id === f.id))
    .forEach((face) => {
      const old = source.faces.find((f) => f.id === face.id);
      assert.notEqual(face, old);
      assert.notEqual(face.uv, old.uv);
      assert.notEqual(face.vertices, old.vertices);
    });
};
const manifold = (mesh) => K.polygonMeshEdges(mesh).every((edge) => edge.incidences.length === 2);

test('public optional polygon kernel exposes its contract', () => {
  for (const name of [
    'createPrimitiveMesh',
    'meshTileUV',
    'extrudeMeshFace',
    'insetMeshFace',
    'cutMeshFace',
    'bevelPolygonMesh',
    'polygonGeometryError',
    'polygonMeshEdges',
    'compilePolygonMesh',
  ])
    assert.equal(typeof K[name], 'function', `${name} must be a public engine function`);
});

test('literal primitive coordinates, outward winding and 128-grid corner UVs stay compatible', () => {
  const mesh = K.createPrimitiveMesh('cube', 'cube');
  assert.deepEqual(mesh.vertices, cube().vertices);
  assert.deepEqual(
    mesh.faces.map((f) => f.vertices),
    cube().faces.map((f) => f.vertices),
  );
  assert.deepEqual(
    mesh.faces.map((f) => f.id),
    ['cube-face-0', 'cube-face-1', 'cube-face-2', 'cube-face-3', 'cube-face-4', 'cube-face-5'],
  );
  assert.deepEqual(mesh.faces[0].uv, [
    [1 / 128, 7 / 128],
    [7 / 128, 7 / 128],
    [7 / 128, 1 / 128],
    [1 / 128, 1 / 128],
  ]);
  for (const kind of ['cube', 'cylinder', 'wedge']) {
    const shape = K.createPrimitiveMesh(kind, kind),
      compiled = K.compilePolygonMesh(shape);
    assert.equal(manifold(shape), true);
    for (let i = 0; i < compiled.positions.length; i += 3)
      assert.ok(compiled.positions.slice(i, i + 3).reduce((sum, v, a) => sum + v * compiled.normals[i + a], 0) > 0);
  }
  assert.equal(K.createPrimitiveMesh('cylinder', 'c').vertices.length, 16);
  assert.equal(K.createPrimitiveMesh('cylinder', 'c').faces.length, 10);
  assert.equal(K.createPrimitiveMesh('plane', 'p').faces.length, 1);
  assert.equal(K.createPrimitiveMesh('wedge', 'w').faces.length, 5);
  assert.throws(() => K.createPrimitiveMesh('sphere', 's'), TypeError);
  assert.throws(() => K.createPrimitiveMesh('cube', ''), TypeError);
  assert.throws(() => K.meshTileUV(-1, 4), RangeError);
  assert.throws(() => K.meshTileUV(0, 2), RangeError);
});

test('0.25 extrusion retains the cap UV and reports old vertices and cap descendants explicitly', () => {
  const source = { ...cube(), name: 'unrelated metadata' },
    before = structuredClone(source);
  const result = K.extrudeMeshFace(source, 'f0', 0.25, ids());
  owned(before, source, result);
  assert.equal(result.mesh.vertices.length, 12);
  assert.equal(result.mesh.faces.length, 10);
  assert.deepEqual(result.mesh.vertices.slice(8), [
    [0.5, -0.5, -0.75],
    [-0.5, -0.5, -0.75],
    [-0.5, 0.5, -0.75],
    [0.5, 0.5, -0.75],
  ]);
  assert.deepEqual(result.mesh.faces[0], { ...source.faces[0], vertices: [8, 9, 10, 11] });
  assert.deepEqual(result.vertexMap, [[0, 9], [1, 8], [2, 11], [3, 10], [4], [5], [6], [7]]);
  assert.deepEqual(result.faceMap.f0, ['f0', 'new-0', 'new-1', 'new-2', 'new-3']);
  assert.deepEqual(result.createdVertices, [8, 9, 10, 11]);
  assert.deepEqual(result.removedVertices, []);
  assert.deepEqual(result.createdFaces, ['new-0', 'new-1', 'new-2', 'new-3']);
  assert.deepEqual(result.removedFaces, []);
  assert.equal(manifold(result.mesh), true);
});

test('.25 centroid inset retains every original face UV with inner vertex descendants', () => {
  const source = cube(),
    before = structuredClone(source),
    result = K.insetMeshFace(source, 'f0', 0.25, ids());
  owned(before, source, result);
  assert.deepEqual(result.mesh.vertices.slice(8), [
    [0.375, -0.375, -0.5],
    [-0.375, -0.375, -0.5],
    [-0.375, 0.375, -0.5],
    [0.375, 0.375, -0.5],
  ]);
  source.faces.forEach((face) => assert.deepEqual(result.mesh.faces.find((f) => f.id === face.id).uv, face.uv));
  assert.deepEqual(result.vertexMap[1], [1, 8]);
  assert.deepEqual(result.faceMap.f0, ['f0', 'new-0', 'new-1', 'new-2', 'new-3']);
  assert.equal(manifold(result.mesh), true);
});

test('midpoint cut shares geometric vertices while interpolating seam corners independently', () => {
  const source = cube();
  source.faces[5].uv = [
    [0.6, 0.9],
    [0.9, 0.9],
    [0.9, 0.6],
    [0.6, 0.6],
  ];
  const before = structuredClone(source),
    result = K.cutMeshFace(source, 'f0', ids());
  owned(before, source, result);
  assert.deepEqual(result.mesh.vertices.slice(8), [
    [0, -0.5, -0.5],
    [0, 0.5, -0.5],
  ]);
  assert.deepEqual(result.mesh.faces[0].vertices, [1, 8, 9, 2]);
  assert.deepEqual(result.mesh.faces[0].uv, [
    [0.1, 0.4],
    [0.25, 0.4],
    [0.25, 0.1],
    [0.1, 0.1],
  ]);
  assert.deepEqual(result.mesh.faces[5].vertices, [0, 8, 1, 5, 4]);
  close(result.mesh.faces[5].uv[1], [0.75, 0.9]);
  assert.deepEqual(result.faceMap.f0, ['f0', 'new-0']);
  assert.deepEqual(
    result.vertexMap,
    source.vertices.map((_, i) => [i]),
  );
  assert.deepEqual(result.createdVertices, [8, 9]);
  assert.deepEqual(result.affectedFaces, ['f0', 'f4', 'f5', 'new-0']);
  assert.equal(manifold(result.mesh), true);
});

test('closed bevel reports one-to-many replacement vertices; open bevel is an owned identity result', () => {
  const source = cube(),
    before = structuredClone(source),
    result = K.bevelPolygonMesh(source, 0.12, ids());
  owned(before, source, result);
  assert.equal(result.mesh.vertices.length, 24);
  assert.equal(result.mesh.faces.length, 26);
  assert.deepEqual(result.vertexMap[0], [1, 8, 20]);
  assert.deepEqual(
    result.createdVertices,
    Array.from({ length: 24 }, (_, i) => i),
  );
  assert.deepEqual(
    result.removedVertices,
    Array.from({ length: 8 }, (_, i) => i),
  );
  assert.equal(manifold(result.mesh), true);
  source.faces.forEach((face) => assert.deepEqual(result.mesh.faces.find((f) => f.id === face.id).uv, face.uv));
  assert.ok(result.faceMap.f0.length > 1, 'edge and corner descendants must be mapped');
  const plane = K.createPrimitiveMesh('plane', 'p'),
    open = K.bevelPolygonMesh(plane, 0.12, ids());
  owned(structuredClone(plane), plane, open);
  assert.deepEqual(open.mesh, plane);
  assert.deepEqual(open.vertexMap, [[0], [1], [2], [3]]);
  assert.deepEqual(open.createdFaces, []);
  assert.ok(open.diagnostics.length > 0);
});

test('generated empty, duplicate and colliding face IDs reject atomically', () => {
  for (const createId of [() => '', () => 'f1', () => 'duplicate']) {
    const source = cube(),
      before = structuredClone(source);
    assert.throws(() => K.extrudeMeshFace(source, 'f0', 0.25, { createId }), /ID|id/);
    assert.deepEqual(source, before);
  }
  assert.throws(() => K.insetMeshFace(cube(), 'missing', 0.25, ids()), /face/i);
  assert.throws(() => K.extrudeMeshFace(cube(), 'f0', NaN, ids()), RangeError);
  assert.throws(() => K.insetMeshFace(cube(), 'f0', 0, ids()), RangeError);
  assert.throws(() => K.bevelPolygonMesh(cube(), 0.9, ids()), RangeError);
});

test('canonical adjacency retains oriented incidence and reports nonmanifold edges', () => {
  const edges = K.polygonMeshEdges(cube());
  assert.equal(edges.length, 12);
  assert.deepEqual(
    edges.find((e) => e.id === '0:1'),
    {
      id: '0:1',
      vertices: [0, 1],
      incidences: [
        { faceId: 'f0', corner: 0, from: 1, to: 0 },
        { faceId: 'f5', corner: 0, from: 0, to: 1 },
      ],
    },
  );
  const open = K.createPrimitiveMesh('plane', 'p');
  assert.ok(K.polygonMeshEdges(open).every((e) => e.incidences.length === 1));
  open.faces.push(
    { ...structuredClone(open.faces[0]), id: 'second' },
    { ...structuredClone(open.faces[0]), id: 'third' },
  );
  assert.ok(K.polygonMeshEdges(open).every((e) => e.incidences.length === 3));
});

test('compile owns flat normals, retained corner seams, fan face identities and exporter face sizes', () => {
  const source = cube(),
    before = structuredClone(source),
    compiled = K.compilePolygonMesh(source);
  assert.deepEqual(source, before);
  assert.deepEqual(
    compiled.positions.slice(0, 12),
    [0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5],
  );
  close(compiled.normals.slice(0, 12), [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
  assert.deepEqual(compiled.uvs.slice(0, 8), [0.1, 0.4, 0.4, 0.4, 0.4, 0.1, 0.1, 0.1]);
  assert.deepEqual(compiled.indices.slice(0, 6), [0, 1, 2, 0, 2, 3]);
  assert.deepEqual(compiled.faceSizes, [4, 4, 4, 4, 4, 4]);
  assert.deepEqual(compiled.triangleFaces, ['f0', 'f0', 'f1', 'f1', 'f2', 'f2', 'f3', 'f3', 'f4', 'f4', 'f5', 'f5']);
  assert.deepEqual(compiled.cornerVertices.slice(0, 8), [1, 0, 3, 2, 4, 5, 6, 7]);
  const cut = K.cutMeshFace(source, 'f0', ids()).mesh,
    packed = K.compilePolygonMesh(cut);
  assert.equal(packed.triangleFaces.length, packed.indices.length / 3);
  assert.deepEqual(packed.faceSizes, [4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 4]);
  assert.deepEqual(K.compilePolygonMesh({ vertices: [], faces: [] }), {
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    faceSizes: [],
    triangleFaces: [],
    cornerVertices: [],
  });
});

test('convex planar polygon validation supports tiny/far-offset and collinear corners', () => {
  assert.equal(
    K.polygonGeometryError([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [2, 1, 0],
      [0, 1, 0],
    ]),
    null,
  );
  assert.equal(
    K.polygonGeometryError([
      [1e6, 1e6, 0],
      [1e6 + 0.001, 1e6, 0],
      [1e6 + 0.001, 1e6 + 0.001, 0],
      [1e6, 1e6 + 0.001, 0],
    ]),
    null,
  );
  assert.equal(
    K.polygonGeometryError([
      [0, 0, 0],
      [1e-10, 0, 0],
      [1e-10, 1e-10, 0],
      [0, 1e-10, 0],
    ]),
    null,
  );
  assert.match(
    K.polygonGeometryError([
      [0, 0, 0],
      [2, 0, 0],
      [1, 1, 0],
      [2, 2, 0],
      [0, 2, 0],
    ]),
    /convex/,
  );
  assert.match(
    K.polygonGeometryError([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0.1],
      [0, 1, 0],
    ]),
    /planar/,
  );
  assert.match(
    K.polygonGeometryError([
      [0, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [1, 0, 0],
    ]),
    /simple/,
  );
  assert.match(
    K.polygonGeometryError([
      [0, 0, 0],
      [0, 0, 0],
      [1, 1, 0],
    ]),
    /distinct|degenerate/,
  );
});

test('malformed inputs reject before compilation and topology mutation', () => {
  const invalids = [
    null,
    {
      vertices: [],
      faces: [
        {
          id: 'bad',
          vertices: [0, 1, 2],
          uv: [
            [0, 0],
            [0, 0],
            [0, 0],
          ],
        },
      ],
    },
    cube(),
  ];
  invalids[2].faces[0].uv.pop();
  for (const source of invalids) {
    assert.throws(() => K.compilePolygonMesh(source), TypeError);
    assert.throws(() => K.polygonMeshEdges(source), TypeError);
  }
  const repeated = cube();
  repeated.faces[1].id = 'f0';
  assert.throws(() => K.compilePolygonMesh(repeated), TypeError);
});

test('zero-distance extrusion rejects degenerate output without modifying its source', () => {
  const source = cube(),
    before = structuredClone(source);
  assert.throws(() => K.extrudeMeshFace(source, 'f0', 0, ids()), /degenerate|distinct/);
  assert.deepEqual(source, before);
});

test('sparse vertex and UV arrays reject as malformed public data', () => {
  assert.throws(() => K.compilePolygonMesh({ vertices: new Array(2), faces: [] }), TypeError);
  const source = cube();
  delete source.faces[0].uv[1];
  assert.throws(() => K.compilePolygonMesh(source), TypeError);
});

test('repeated collinear cuts and far-offset compile retain valid identities and flat normals', () => {
  let count = 0,
    mesh = K.bevelPolygonMesh(K.createPrimitiveMesh('cylinder', 'c'), 0.12, {
      createId: () => `bevel-${count++}`,
    }).mesh;
  const faceId = mesh.faces[0].id;
  for (let i = 0; i < 23; i++) mesh = K.cutMeshFace(mesh, faceId, { createId: () => `cut-${i}` }).mesh;
  const compiled = K.compilePolygonMesh(mesh);
  assert.equal(compiled.triangleFaces.length, compiled.indices.length / 3);
  assert.equal(manifold(mesh), true);
  const plane = {
    vertices: [
      [1e6, 1e6, 0],
      [1e6 + 0.001, 1e6, 0],
      [1e6 + 0.001, 1e6 + 0.001, 0],
      [1e6, 1e6 + 0.001, 0],
    ],
    faces: [
      {
        id: 'plane',
        vertices: [0, 1, 2, 3],
        uv: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
    ],
  };
  close(K.compilePolygonMesh(plane).normals, [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test('special face IDs and nested result arrays remain owned and safe', () => {
  const source = cube();
  source.faces[0].id = '__proto__';
  const result = K.extrudeMeshFace(source, '__proto__', 0.25, ids());
  assert.deepEqual(result.faceMap.__proto__, ['__proto__', 'new-0', 'new-1', 'new-2', 'new-3']);
  result.mesh.faces[0].uv[0][0] = 0.9;
  result.vertexMap[0].push(99);
  assert.equal(source.faces[0].uv[0][0], 0.1);
  assert.equal(source.vertices.length, 8);
});

test('edit results share no corner UV array between faces', () => {
  const distinct = (mesh) => {
    const seen = new Set();
    for (const face of mesh.faces)
      for (const uv of face.uv) {
        assert.ok(!seen.has(uv), `face ${face.id} shares a UV array`);
        seen.add(uv);
      }
  };
  distinct(K.cutMeshFace(cube(), 'f0', ids()).mesh);
  distinct(K.extrudeMeshFace(cube(), 'f0', 0.25, ids()).mesh);
  distinct(K.insetMeshFace(cube(), 'f0', 0.25, ids()).mesh);
  distinct(K.cutMeshQuadRing(cube(), { faceId: 'f0', corner: 0 }, 0.5, ids()).mesh);
  const warp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.2, 1];
  distinct(K.transformMeshComponents(cube(), { mode: 'vertex', vertices: [0] }, warp, ids()).mesh);
});
