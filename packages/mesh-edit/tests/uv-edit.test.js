import assert from 'node:assert/strict';
import test from 'node:test';
import { meshUVTopology, meshSelectionUVCorners, transformMeshUVs, meshUVHits } from '../dist/index.js';

const sheet = () => ({
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [2, 1, 0],
    [4, 0, 0],
    [5, 0, 0],
    [5, 1, 0],
    [4, 1, 0],
  ],
  faces: [
    {
      id: 'left',
      vertices: [0, 1, 4, 3],
      uv: [
        [0.125, 0.25],
        [0.375, 0.25],
        [0.375, 0.5],
        [0.125, 0.5],
      ],
    },
    {
      id: 'right',
      vertices: [1, 2, 5, 4],
      uv: [
        [0.375, 0.25],
        [0.625, 0.25],
        [0.625, 0.5],
        [0.375, 0.5],
      ],
    },
    {
      id: '__proto__',
      vertices: [6, 7, 8, 9],
      uv: [
        [0.125, 0.25],
        [0.375, 0.25],
        [0.375, 0.5],
        [0.125, 0.5],
      ],
    },
  ],
});

test('UV islands follow shared opposite edges; coincident atlas islands stay separate', () => {
  const mesh = sheet(),
    before = structuredClone(mesh),
    topology = meshUVTopology(mesh);
  assert.deepEqual(
    topology.islands.map((i) => i.faces),
    [['left', 'right'], ['__proto__']],
  );
  assert.equal(topology.islands[0].corners.length, 8);
  assert.deepEqual(
    topology.edges.find((e) => e.edgeId === '1:4'),
    {
      edgeId: '1:4',
      seam: false,
      reason: null,
      corners: [
        { faceId: 'left', corner: 1 },
        { faceId: 'right', corner: 3 },
      ],
    },
  );
  assert(topology.edges.filter((e) => e.edgeId !== '1:4').every((e) => e.reason === 'boundary' && e.seam));
  topology.islands[0].faces[0] = 'changed';
  topology.islands[0].corners[0].corner = 99;
  assert.deepEqual(mesh, before);
});

test('one mismatched endpoint, even below a texel, creates an exact UV seam', () => {
  const mesh = sheet();
  mesh.faces[1].uv[0][1] += 1e-12;
  assert.deepEqual(
    meshUVTopology(mesh).islands.map((i) => i.faces),
    [['left'], ['right'], ['__proto__']],
  );
  assert.equal(meshUVTopology(mesh).edges.find((e) => e.edgeId === '1:4').reason, 'uv');
});

test('point contacts, same winding and nonmanifold incidence do not join islands', () => {
  const point = sheet();
  point.vertices.push([2, 2, 0], [1, 2, 0]);
  point.faces.push({
    id: 'point',
    vertices: [4, 10, 11],
    uv: [
      [0.375, 0.5],
      [0.5, 0.75],
      [0.375, 0.75],
    ],
  });
  assert.deepEqual(
    meshUVTopology(point).islands.map((i) => i.faces),
    [['left', 'right'], ['__proto__'], ['point']],
  );
  const winding = sheet();
  winding.faces[1].vertices.reverse();
  winding.faces[1].uv.reverse();
  assert.equal(meshUVTopology(winding).edges.find((e) => e.edgeId === '1:4').reason, 'winding');
  const nonmanifold = sheet();
  nonmanifold.faces.push({ ...structuredClone(nonmanifold.faces[1]), id: 'duplicate' });
  assert.equal(meshUVTopology(nonmanifold).edges.find((e) => e.edgeId === '1:4').reason, 'nonmanifold');
  assert.equal(meshUVTopology(nonmanifold).islands.length, 4);
});

test('corner, face and seeded island selection deduplicate in source order', () => {
  const mesh = sheet();
  assert.deepEqual(
    meshSelectionUVCorners(mesh, {
      mode: 'corner',
      corners: [
        { faceId: 'right', corner: 3 },
        { faceId: 'left', corner: 1 },
        { faceId: 'left', corner: 1 },
      ],
    }),
    [
      { faceId: 'left', corner: 1 },
      { faceId: 'right', corner: 3 },
    ],
  );
  assert.equal(meshSelectionUVCorners(mesh, { mode: 'island', faces: ['right', 'left'] }).length, 8);
  assert.equal(meshSelectionUVCorners(mesh, { mode: 'face', faces: ['right'] }).length, 4);
  assert.equal(meshSelectionUVCorners(mesh, { mode: 'all' }).length, 12);
  assert.deepEqual(meshSelectionUVCorners(mesh, { mode: 'corner', corners: [] }), []);
  for (const selection of [
    null,
    { mode: 'unknown' },
    { mode: 'corner', corners: [{ faceId: 'left', corner: 4 }] },
    { mode: 'corner', corners: [{ faceId: 'missing', corner: 0 }] },
    { mode: 'corner', corners: new Array(1) },
    { mode: 'face', faces: ['stale'] },
    { mode: 'island', faces: [1] },
  ])
    assert.throws(() => meshSelectionUVCorners(mesh, selection));
});

test('one texel translation changes only selected corners and owns every output array', () => {
  const mesh = sheet(),
    before = structuredClone(mesh),
    result = transformMeshUVs(
      mesh,
      { mode: 'corner', corners: [{ faceId: 'left', corner: 0 }] },
      { translation: [1, -2], atlasDimensions: [128, 64] },
    );
  assert.deepEqual(result.mesh.faces[0].uv[0], [17 / 128, 14 / 64]);
  assert.deepEqual(result.mesh.faces[0].uv.slice(1), before.faces[0].uv.slice(1));
  assert.deepEqual(result.mesh.faces.slice(1), before.faces.slice(1));
  assert.deepEqual(result.mesh.vertices, before.vertices);
  assert.deepEqual(result.affectedFaces, ['left']);
  assert(result.changed);
  assert.deepEqual(mesh, before);
  result.mesh.vertices[0][0] = 999;
  result.mesh.faces[1].uv[0][0] = 0;
  result.mesh.faces[1].vertices[0] = 99;
  result.corners[0].corner = 3;
  assert.deepEqual(mesh, before);
});

test('quarter turns in rectangular texel space preserve exact integer pixel corners', () => {
  const mesh = sheet(),
    result = transformMeshUVs(
      mesh,
      { mode: 'face', faces: ['left'] },
      { atlasDimensions: [128, 64], pivot: [32, 24], rotation: Math.PI / 2 },
    );
  assert.deepEqual(result.mesh.faces[0].uv, [
    [40 / 128, 8 / 64],
    [40 / 128, 40 / 64],
    [24 / 128, 40 / 64],
    [24 / 128, 8 / 64],
  ]);
  assert.deepEqual(result.mesh.faces[1], mesh.faces[1]);
  assert.deepEqual(result.mesh.vertices, mesh.vertices);
  const recovered = transformMeshUVs(
    result.mesh,
    { mode: 'face', faces: ['left'] },
    { atlasDimensions: [128, 64], pivot: [32, 24], rotation: -Math.PI / 2 },
  );
  assert.deepEqual(recovered.mesh, mesh);
  assert.deepEqual(
    transformMeshUVs(
      mesh,
      { mode: 'face', faces: ['left'] },
      { atlasDimensions: [128, 64], pivot: 'selection', rotation: Math.PI / 2 },
    ).mesh,
    result.mesh,
  );
});

test('UV picking keeps overlapping faces and exact corner identities independently selectable', () => {
  const mesh = sheet(),
    before = structuredClone(mesh);
  assert.deepEqual(meshUVHits(mesh, [0.2, 0.3]), { faces: ['left', '__proto__'], corners: [] });
  assert.deepEqual(meshUVHits(mesh, [0.375, 0.25]).corners, [
    { faceId: 'left', corner: 1 },
    { faceId: 'right', corner: 0 },
    { faceId: '__proto__', corner: 1 },
  ]);
  assert.deepEqual(meshUVHits(mesh, [0.375, 0.375]).faces, ['left', 'right', '__proto__']);
  const result = meshUVHits(mesh, [0.125, 0.25]);
  result.faces[0] = 'changed';
  result.corners[0].corner = 99;
  assert.deepEqual(mesh, before);
});

test('UV hit radius is elliptical and includes edge proximity without joining islands', () => {
  const mesh = sheet();
  assert.deepEqual(meshUVHits(mesh, [0.12, 0.25]).faces, []);
  const near = meshUVHits(mesh, [0.12, 0.25], [0.01, 0.02]);
  assert.deepEqual(near.faces, ['left', '__proto__']);
  assert.deepEqual(near.corners, [
    { faceId: 'left', corner: 0 },
    { faceId: '__proto__', corner: 0 },
  ]);
  assert.deepEqual(meshUVHits(mesh, [0.134, 0.269], [0.01, 0.02]).corners, []);
  assert.deepEqual(meshUVHits(mesh, [-0.001, 0.25], [0.01, 0.02]), { faces: [], corners: [] });
  const collapsed = sheet();
  collapsed.faces[0].uv = collapsed.faces[0].uv.map(() => [0.75, 0.75]);
  assert.deepEqual(meshUVHits(collapsed, [0.75, 0.75]).faces, ['left']);
});

test('UV queries reject malformed points and radii without mutation', () => {
  const mesh = sheet(),
    before = structuredClone(mesh);
  for (const [point, radius] of [
    [null, [0, 0]],
    [
      [NaN, 0],
      [0, 0],
    ],
    [[0, 0], null],
    [
      [0, 0],
      [-1, 1],
    ],
    [
      [0, 0],
      [0, 1],
    ],
    [[0, 0], [1]],
    [
      [0, 0],
      [Infinity, 1],
    ],
  ])
    assert.throws(() => meshUVHits(mesh, point, radius));
  assert.deepEqual(mesh, before);
});

test('identity retains full coordinate precision and negative zero; selected snapping is explicit', () => {
  const mesh = sheet();
  mesh.faces[0].uv[0] = [0.12345678901234567, -0];
  const identity = transformMeshUVs(mesh, { mode: 'all' }, { atlasDimensions: [512, 256] });
  assert.deepEqual(identity.mesh, mesh);
  assert.equal(identity.changed, false);
  assert.deepEqual(identity.affectedFaces, []);
  for (const rotation of [Math.PI * 2, -Math.PI * 2]) {
    const fullTurn = transformMeshUVs(mesh, { mode: 'all' }, { rotation, pivot: [1e100, -1e100] });
    assert.deepEqual(fullTurn.mesh, mesh, 'A full turn is an exact identity even around a far pivot');
    assert.equal(fullTurn.changed, false);
  }
  const translated = transformMeshUVs(
    sheet(),
    { mode: 'face', faces: ['left'] },
    { translation: [1, 0], atlasDimensions: [128, 64], pivot: [1e100, -1e100] },
  );
  assert.deepEqual(
    translated.mesh.faces[0].uv[0],
    [17 / 128, 16 / 64],
    'A translation must not lose coordinates through an irrelevant pivot',
  );
  const snapped = sheet();
  snapped.faces[0].uv[0] = [0.128, 0.254];
  const out = transformMeshUVs(
    snapped,
    { mode: 'corner', corners: [{ faceId: 'left', corner: 0 }] },
    { atlasDimensions: [128, 64], snap: [1, 1] },
  );
  assert.deepEqual(out.mesh.faces[0].uv[0], [16 / 128, 16 / 64]);
  assert.deepEqual(out.mesh.faces[1], snapped.faces[1]);
});

test('mirroring is a UV edit and preserves XYZ, polygon winding and disconnected islands', () => {
  const mesh = sheet(),
    out = transformMeshUVs(mesh, { mode: 'island', faces: ['right'] }, { pivot: [0.375, 0.375], scale: [-1, 1] });
  assert.deepEqual(out.mesh.faces[0].uv, [
    [0.625, 0.25],
    [0.375, 0.25],
    [0.375, 0.5],
    [0.625, 0.5],
  ]);
  assert.deepEqual(out.mesh.faces[2], mesh.faces[2]);
  assert.deepEqual(out.mesh.vertices, mesh.vertices);
  out.mesh.faces.forEach((f, i) => assert.deepEqual(f.vertices, mesh.faces[i].vertices));
});

test('translation snapping moves an island rigidly without rounding fractional corners or the other axis', () => {
  const mesh = sheet(),
    before = structuredClone(mesh);
  const result = transformMeshUVs(
    mesh,
    { mode: 'island', faces: ['left'] },
    { translation: [0, 2.6], translationSnap: [1, 1], atlasDimensions: [1, 1024] },
  );
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      result.mesh.faces[i].uv,
      mesh.faces[i].uv.map(([u, v]) => [u, v + 3 / 1024]),
    );
  assert.deepEqual(result.mesh.faces[2], mesh.faces[2]);
  assert.deepEqual(result.mesh.vertices, mesh.vertices);
  assert.deepEqual(mesh, before);
  const normalized = transformMeshUVs(
    mesh,
    { mode: 'face', faces: ['left'] },
    { translation: [0.04, 0.12], translationSnap: [0.125, 0.25] },
  );
  assert.deepEqual(normalized.mesh, mesh);
  assert.equal(normalized.changed, false);
});

test('zero snapped movement preserves authored Number precision and signed zero exactly', () => {
  const mesh = sheet();
  mesh.faces[0].uv[0] = [-0, 0.2549384793729384];
  const result = transformMeshUVs(
    mesh,
    { mode: 'all' },
    { translation: [-0.4, 0.4], translationSnap: [1, 1], atlasDimensions: [127, 255], pivot: [1e100, -1e100] },
  );
  assert.deepEqual(result.mesh, mesh);
  assert.equal(result.changed, false);
  const moved = transformMeshUVs(
    mesh,
    { mode: 'all' },
    { translation: [0, 1], translationSnap: [1, 1], atlasDimensions: [127, 255] },
  );
  for (let i = 0; i < mesh.faces.length; i++)
    for (let j = 0; j < mesh.faces[i].uv.length; j++)
      assert(Object.is(moved.mesh.faces[i].uv[j][0], mesh.faces[i].uv[j][0]));
});

test('invalid and out-of-atlas transforms reject atomically, without clamping or input mutation', () => {
  const mesh = sheet(),
    before = structuredClone(mesh);
  for (const options of [
    null,
    [],
    { translation: null },
    { scale: null },
    { rotation: null },
    { snap: null },
    { translationSnap: null },
    { translationSnap: [0, 1] },
    { translationSnap: [NaN, 1] },
    { translationSnap: [Infinity, 1] },
    { translation: [1e308, 0], translationSnap: [Number.MIN_VALUE, 1] },
    { atlasDimensions: null },
    { translation: [0.5, 0] },
    { scale: [0, 1] },
    { scale: [Infinity, 1] },
    { scale: [1e308, 1e308] },
    { rotation: NaN },
    { pivot: [0] },
    { snap: [0, 1] },
    { snap: [NaN, 1] },
    { atlasDimensions: [0, 128] },
    { atlasDimensions: [1.5, 128] },
  ]) {
    assert.throws(() => transformMeshUVs(mesh, { mode: 'all' }, options));
    assert.deepEqual(mesh, before);
  }
  const noop = transformMeshUVs(mesh, { mode: 'face', faces: [] }, { translation: [0.5, 0] });
  assert.equal(noop.changed, false);
  assert.deepEqual(noop.mesh, mesh);
});
