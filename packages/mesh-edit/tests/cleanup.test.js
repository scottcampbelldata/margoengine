import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, Matrix4, Quaternion, Vector3 } from '@margoengine/math';
import { cleanupPolygonMeshes, createPrimitiveMesh, quantizePolygonMesh } from '../dist/index.js';

const identity = () => new Matrix4().elements;
const cube = (prefix = 'face') => ({
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
  ].map((vertices, index) => ({
    id: `${prefix}-${index}`,
    vertices,
    uv: [
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
  })),
});
const matrix = (position = [0, 0, 0], scale = [1, 1, 1], degrees = [0, 0, 0]) =>
  new Matrix4().compose(
    new Vector3(...position),
    new Quaternion().setFromEuler(new Euler(...degrees.map((value) => (value * Math.PI) / 180), 'ZYX')),
    new Vector3(...scale),
  ).elements;
const input = (mesh, options = {}) => ({
  mesh,
  worldMatrix: identity(),
  canEdit: true,
  canOcclude: true,
  motionGroup: 'static',
  ...options,
});
const worlds = (mesh, transform) =>
  mesh.vertices.map((point) => new Vector3(...point).applyMatrix4(new Matrix4().fromArray(transform)).toArray());
const closePoints = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((point, index) =>
    point.forEach((value, axis) =>
      assert.ok(Math.abs(value - expected[index][axis]) < 1e-12, `${index}:${axis}: ${value}`),
    ),
  );
};
const identityFaces = (mesh) => Object.fromEntries(mesh.faces.map((face) => [face.id, [face.id]]));

test('world quantization preserves mirrored nonuniform transforms, UV corners and component identities', () => {
  const mesh = cube(),
    before = structuredClone(mesh);
  const transform = matrix([0.04, -0.03, 0.02], [-1.3, 0.8, 1.1], [0, 0, 90]);
  const result = quantizePolygonMesh(mesh, transform, 0.125);
  closePoints(worlds(result.mesh, transform), [
    [0.5, 0.625, -0.5],
    [0.5, -0.625, -0.5],
    [-0.375, -0.625, -0.5],
    [-0.375, 0.625, -0.5],
    [0.5, 0.625, 0.625],
    [0.5, -0.625, 0.625],
    [-0.375, -0.625, 0.625],
    [-0.375, 0.625, 0.625],
  ]);
  assert.deepEqual(result.mesh.faces, mesh.faces);
  assert.deepEqual(result.vertexMap, [[0], [1], [2], [3], [4], [5], [6], [7]]);
  assert.deepEqual(result.faceMap, identityFaces(mesh));
  assert.deepEqual(result.createdVertices, []);
  assert.deepEqual(result.removedVertices, []);
  assert.deepEqual(result.createdFaces, []);
  assert.deepEqual(result.removedFaces, []);
  assert.deepEqual(
    result.affectedFaces,
    mesh.faces.map((face) => face.id),
  );
  assert.deepEqual(mesh, before);
});

test('a no-op quantization returns owned data and no affected components', () => {
  const mesh = cube(),
    before = structuredClone(mesh),
    result = quantizePolygonMesh(mesh, identity(), 0.125);
  assert.deepEqual(result.mesh, mesh);
  assert.deepEqual(result.affectedFaces, []);
  result.mesh.vertices[0][0] = 99;
  result.mesh.faces[0].uv[0][0] = 0.25;
  assert.deepEqual(mesh, before);
});

test('quantization rejects overflow in unreferenced positions without returning invalid geometry', () => {
  const mesh = { vertices: [[Number.MAX_VALUE, 0, 0]], faces: [] },
    before = structuredClone(mesh);
  assert.throws(() => quantizePolygonMesh(mesh, identity(), 1 / 1024), /finite|overflow/i);
  assert.deepEqual(mesh, before);
});

test('quantization rejects invalid steps and singular or nonfinite matrices without mutating the source', () => {
  const mesh = cube(),
    before = structuredClone(mesh);
  for (const step of [0, -1, Infinity, NaN, 2, 1 / 2048])
    assert.throws(() => quantizePolygonMesh(mesh, identity(), step), /step|grid/i);
  for (const transform of [[], [1, 2, 3], matrix([0, 0, 0], [1, 0, 1]), Array(16).fill(NaN)])
    assert.throws(() => quantizePolygonMesh(mesh, transform, 0.125), /matrix|transform|finite|singular/i);
  assert.deepEqual(mesh, before);
});

test('quantization rejects collapsed edges and flattened closed volume atomically', () => {
  const mesh = cube(),
    before = structuredClone(mesh);
  assert.throws(() => quantizePolygonMesh(mesh, matrix([0, 0, 0], [0.03, 0.03, 0.03]), 0.125), /collapse|degenerate/i);
  assert.deepEqual(mesh, before);
  const tetra = {
    vertices: [
      [-0.5, -0.5, 0.03],
      [0.5, -0.5, 0.03],
      [0, 0.5, 0.03],
      [0, 0, 0.05],
    ],
    faces: [
      [0, 2, 1],
      [0, 1, 3],
      [1, 2, 3],
      [2, 0, 3],
    ].map((vertices, index) => ({
      id: `tetra-${index}`,
      vertices,
      uv: [
        [0, 0],
        [1, 0],
        [0.5, 1],
      ],
    })),
  };
  const tetraBefore = structuredClone(tetra);
  assert.throws(() => quantizePolygonMesh(tetra, identity(), 0.125), /volume|collapse|degenerate/i);
  assert.deepEqual(tetra, tetraBefore);
});

test('quantization explicitly rejects a grid that warps a planar face instead of returning an unreadable mesh', () => {
  const mesh = cube(),
    before = structuredClone(mesh);
  assert.throws(
    () => quantizePolygonMesh(mesh, matrix([0.21, -0.13, 0.08], [-1.3, 0.8, 1.1], [13, -27, 38]), 0.0625),
    /planar/i,
  );
  assert.deepEqual(mesh, before);
});

test('mixed XYZ rotation and mirrored nonuniform transforms support a triangulated surface', () => {
  const mesh = cube();
  mesh.faces = mesh.faces.flatMap((face) => [
    { id: `${face.id}-a`, vertices: [face.vertices[0], face.vertices[1], face.vertices[2]], uv: face.uv.slice(0, 3) },
    {
      id: `${face.id}-b`,
      vertices: [face.vertices[0], face.vertices[2], face.vertices[3]],
      uv: [face.uv[0], face.uv[2], face.uv[3]],
    },
  ]);
  const transform = matrix([0.21, -0.13, 0.08], [-1.3, 0.8, 1.1], [13, -27, 38]);
  const before = structuredClone(mesh),
    result = quantizePolygonMesh(mesh, transform, 0.0625);
  for (const point of worlds(result.mesh, transform))
    for (const value of point) assert.ok(Math.abs(value / 0.0625 - Math.round(value / 0.0625)) < 1e-9);
  assert.deepEqual(result.mesh.faces, mesh.faces);
  assert.deepEqual(mesh, before);
});

test('an open polygon remains supported by quantization', () => {
  const mesh = {
    vertices: [
      [-0.48, 0, -0.48],
      [-0.48, 0, 0.48],
      [0.48, 0, 0.48],
      [0.48, 0, -0.48],
    ],
    faces: [
      {
        id: 'open',
        vertices: [0, 1, 2, 3],
        uv: [
          [0, 1],
          [1, 1],
          [1, 0],
          [0, 0],
        ],
      },
    ],
  };
  const result = quantizePolygonMesh(mesh, identity(), 0.125);
  assert.deepEqual(result.mesh.vertices, [
    [-0.5, 0, -0.5],
    [-0.5, 0, 0.5],
    [0.5, 0, 0.5],
    [0.5, 0, -0.5],
  ]);
  assert.deepEqual(result.mesh.faces, mesh.faces);
});

test('closed convex enclosure removes exactly six inner faces and maps removed identities to empty arrays', () => {
  const outer = cube('outer'),
    inner = cube('inner'),
    before = structuredClone([outer, inner]);
  const result = cleanupPolygonMeshes([input(outer, { worldMatrix: matrix([0, 0, 0], [3, 3, 3]) }), input(inner)]);
  assert.equal(result.removed, 6);
  assert.equal(result.welded, 0);
  assert.equal(result.results[0].mesh.faces.length, 6);
  assert.deepEqual(result.results[0].faceMap, identityFaces(outer));
  assert.deepEqual(result.results[1].mesh.faces, []);
  assert.deepEqual(
    result.results[1].removedFaces,
    inner.faces.map((face) => face.id),
  );
  assert.deepEqual(result.results[1].faceMap, Object.fromEntries(inner.faces.map((face) => [face.id, []])));
  assert.deepEqual(result.results[1].vertexMap, [[0], [1], [2], [3], [4], [5], [6], [7]]);
  assert.deepEqual([outer, inner], before);
});

test('whole opposing boundaries remove two faces and retain other corners and object independence', () => {
  const first = cube('first'),
    second = cube('second'),
    before = structuredClone([first, second]);
  const result = cleanupPolygonMeshes([input(first), input(second, { worldMatrix: matrix([1, 0, 0]) })]);
  assert.equal(result.removed, 2);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0].removedFaces, ['first-3']);
  assert.deepEqual(result.results[1].removedFaces, ['second-2']);
  for (const [index, mesh] of [first, second].entries())
    for (const face of result.results[index].mesh.faces)
      assert.deepEqual(
        face,
        mesh.faces.find((original) => original.id === face.id),
      );
  assert.deepEqual([first, second], before);
});

test('geometrically equal solids and partial coplanar overlaps are retained', () => {
  const first = cube('first'),
    second = cube('second');
  assert.equal(cleanupPolygonMeshes([input(first), input(second)]).removed, 0);
  assert.equal(cleanupPolygonMeshes([input(first), input(second, { worldMatrix: matrix([1, 0.2, 0]) })]).removed, 0);
  assert.equal(
    cleanupPolygonMeshes([input(first), input(second, { worldMatrix: matrix([1 + 1e-8, 0, 0]) })]).removed,
    2,
  );
});

test('different caller motion groups cannot occlude one another', () => {
  const first = cube('first'),
    second = cube('second');
  assert.equal(
    cleanupPolygonMeshes([
      input(first, { motionGroup: 'bone-a' }),
      input(second, {
        worldMatrix: matrix([1, 0, 0]),
        motionGroup: 'bone-b',
      }),
    ]).removed,
    0,
  );
  assert.equal(
    cleanupPolygonMeshes([
      input(first, { worldMatrix: matrix([0, 0, 0], [3, 3, 3]), motionGroup: 'animated' }),
      input(second),
    ]).removed,
    0,
  );
});

test('a noneditable solid may occlude an enclosure but cannot remove a shared boundary', () => {
  const first = cube('first'),
    second = cube('second');
  assert.equal(
    cleanupPolygonMeshes([input(first, { canEdit: false }), input(second, { worldMatrix: matrix([1, 0, 0]) })]).removed,
    0,
  );
  const enclosed = cleanupPolygonMeshes([
    input(first, {
      canEdit: false,
      worldMatrix: matrix([0, 0, 0], [3, 3, 3]),
    }),
    input(second),
  ]);
  assert.equal(enclosed.removed, 6);
  assert.deepEqual(enclosed.results[0].mesh, first);
  assert.equal(
    cleanupPolygonMeshes([
      input(first, { worldMatrix: matrix([0, 0, 0], [3, 3, 3]) }),
      input(second, { canEdit: false }),
    ]).removed,
    0,
  );
});

test('transparent and hidden helper policy disables occlusion without inspecting app documents', () => {
  const first = cube('first'),
    second = cube('second');
  for (const policy of [{ canOcclude: false }, { canEdit: false, canOcclude: false }]) {
    assert.equal(
      cleanupPolygonMeshes([
        input(first, {
          ...policy,
          worldMatrix: matrix([0, 0, 0], [3, 3, 3]),
        }),
        input(second),
      ]).removed,
      0,
    );
    assert.equal(
      cleanupPolygonMeshes([input(first, policy), input(second, { worldMatrix: matrix([1, 0, 0]) })]).removed,
      0,
    );
  }
});

test('open geometry cannot become a solid occluder', () => {
  const open = cube('open');
  open.faces.pop();
  assert.equal(
    cleanupPolygonMeshes([input(open, { worldMatrix: matrix([0, 0, 0], [3, 3, 3]) }), input(cube('inner'))]).removed,
    0,
  );
  assert.deepEqual(
    cleanupPolygonMeshes([input(open, { worldMatrix: matrix([0, 0, 0], [1, 0, 1]) })]).results[0].mesh,
    open,
  );
});

for (const reversed of [false, true])
  test(`disconnected duplicate caps with ${reversed ? 'opposite' : 'identical'} winding cannot occlude through open sides`, () => {
    const caps = {
      vertices: [
        [-2, -2, -2],
        [2, -2, -2],
        [0, 2, -2],
        [-2, -2, 2],
        [2, -2, 2],
        [0, 2, 2],
      ],
      faces: [[0, 1, 2], reversed ? [2, 1, 0] : [0, 1, 2], [3, 4, 5], reversed ? [5, 4, 3] : [3, 4, 5]].map(
        (vertices, index) => ({
          id: `cap-${index}`,
          vertices,
          uv: [
            [0, 0],
            [1, 0],
            [0.5, 1],
          ],
        }),
      ),
    };
    const inner = cube('inner'),
      before = structuredClone([caps, inner]);
    const result = cleanupPolygonMeshes([input(caps), input(inner)]);
    assert.equal(result.removed, 0, 'duplicate edge counts cannot prove the space between open sheets enclosed');
    assert.deepEqual(result.results[1].mesh, inner);
    assert.deepEqual(result.results[1].faceMap, identityFaces(inner));
    assert.deepEqual([caps, inner], before);
  });

test('disconnected coincident closed sheets do not qualify as one connected solid occluder', () => {
  const first = cube('first'),
    second = cube('second');
  const sheets = {
    vertices: [...first.vertices, ...second.vertices],
    faces: [
      ...first.faces,
      ...second.faces.map((face) => ({ ...face, vertices: face.vertices.map((vertex) => vertex + 8) })),
    ],
  };
  const inner = cube('inner'),
    before = structuredClone([sheets, inner]);
  const result = cleanupPolygonMeshes([input(sheets, { worldMatrix: matrix([0, 0, 0], [3, 3, 3]) }), input(inner)]);
  assert.equal(result.removed, 0);
  assert.deepEqual(result.results[1].mesh, inner);
  assert.deepEqual([sheets, inner], before);
});

test('closed solids retain enclosure proof with reversed winding and mirrored nonuniform transforms', () => {
  for (const kind of ['cube', 'cylinder'])
    for (const reversed of [false, true]) {
      const outer = createPrimitiveMesh(kind, `${kind}-${reversed}`);
      if (reversed)
        for (const face of outer.faces) {
          face.vertices.reverse();
          face.uv.reverse();
        }
      const result = cleanupPolygonMeshes([
        input(outer, {
          worldMatrix: matrix([0, 0, 0], [-6, 5, 4], [13, -27, 38]),
        }),
        input(cube('inner')),
      ]);
      assert.equal(result.removed, 6, `${kind}, reversed=${reversed}`);
      assert.equal(result.results[0].mesh.faces.length, outer.faces.length);
      assert.equal(result.results[1].mesh.faces.length, 0);
    }
});

test('welding compacts exact position duplicates and unused vertices while retaining independent UV corners', () => {
  const original = cube(),
    mesh = { vertices: [], faces: [] };
  mesh.faces = original.faces.map((face, index) => ({
    ...structuredClone(face),
    uv: face.uv.map(([u, v]) => [u * 0.1 + index * 0.1, v * 0.1]),
    vertices: face.vertices.map((vertex) => {
      mesh.vertices.push([...original.vertices[vertex]]);
      return mesh.vertices.length - 1;
    }),
  }));
  mesh.vertices.push([99, 99, 99]);
  const before = structuredClone(mesh),
    result = cleanupPolygonMeshes([input(mesh)], { weld: true });
  const edit = result.results[0];
  assert.equal(result.removed, 0);
  assert.equal(result.welded, 16, 'unused vertices are compacted but are not counted as welds');
  assert.equal(edit.mesh.vertices.length, 8);
  assert.deepEqual(edit.vertexMap, [
    [0],
    [1],
    [2],
    [3],
    [4],
    [5],
    [6],
    [7],
    [1],
    [4],
    [7],
    [2],
    [5],
    [0],
    [3],
    [6],
    [2],
    [7],
    [6],
    [3],
    [1],
    [0],
    [5],
    [4],
    [],
  ]);
  assert.deepEqual(
    edit.removedVertices,
    Array.from({ length: 17 }, (_, index) => index + 8),
  );
  assert.deepEqual(edit.createdVertices, []);
  assert.deepEqual(edit.faceMap, identityFaces(mesh));
  assert.deepEqual(
    edit.mesh.faces.map((face) => [face.id, face.uv]),
    mesh.faces.map((face) => [face.id, face.uv]),
  );
  edit.mesh.vertices[0][0] = 99;
  edit.mesh.faces[0].uv[0][0] = 0.9;
  assert.deepEqual(mesh, before);
});

test('welding is optional, exact, local to each editable mesh and normalizes signed zero', () => {
  const mesh = {
    vertices: [
      [0, 0, 0],
      [-0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [99, 99, 99],
    ],
    faces: [
      {
        id: 'first',
        vertices: [0, 2, 3],
        uv: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
      {
        id: 'second',
        vertices: [1, 3, 4],
        uv: [
          [0.2, 0],
          [1, 1],
          [0, 1],
        ],
      },
    ],
  };
  assert.equal(cleanupPolygonMeshes([input(mesh)]).results[0].mesh.vertices.length, 6);
  const held = cleanupPolygonMeshes([input(mesh, { canEdit: false })], { weld: true });
  assert.equal(held.results[0].mesh.vertices.length, 6);
  assert.equal(held.welded, 0);
  const welded = cleanupPolygonMeshes([input(mesh), input(mesh)], { weld: true });
  assert.equal(welded.welded, 2);
  assert.equal(welded.results.length, 2);
  for (const result of welded.results) {
    assert.equal(result.mesh.vertices.length, 4);
    assert.deepEqual(result.vertexMap, [[0], [0], [1], [2], [3], []]);
    assert.deepEqual(result.removedVertices, [1, 5]);
  }
  const nearly = structuredClone(mesh);
  nearly.vertices[1][0] = 1e-12;
  assert.equal(cleanupPolygonMeshes([input(nearly)], { weld: true }).welded, 0);
});

test('cleanup rejects malformed policy atomically', () => {
  const mesh = cube(),
    before = structuredClone(mesh);
  for (const policy of [{ canEdit: 1 }, { canOcclude: null }, { motionGroup: null }, { worldMatrix: [] }])
    assert.throws(() => cleanupPolygonMeshes([input(mesh, policy)]), /edit|occlu|motion|matrix|boolean|string/i);
  assert.deepEqual(mesh, before);
});

test('cleanup rejects sparse candidate arrays instead of returning sparse result identities', () => {
  assert.throws(() => cleanupPolygonMeshes(Array(1)), /dense|missing|mesh|input/i);
});

test('an unsafe weld preserves repeated face corners and returns independent source geometry', () => {
  const repeated = cube();
  repeated.faces[0].vertices[1] = repeated.faces[0].vertices[0];
  const repeatedBefore = structuredClone(repeated);
  const result = cleanupPolygonMeshes([input(repeated)], { weld: true });
  assert.equal(result.welded, 0);
  assert.deepEqual(result.results[0].mesh, repeated);
  assert.deepEqual(result.results[0].vertexMap, [[0], [1], [2], [3], [4], [5], [6], [7]]);
  result.results[0].mesh.vertices[0][0] = 99;
  assert.deepEqual(repeated, repeatedBefore);
});
