import assert from 'node:assert/strict';
import test from 'node:test';
import { polygonGeometryError, compilePolygonMesh, insetMeshRegion, MeshRegionInsetPreview } from '../dist/index.js';
const rectangle = () => [
  [0, 0, 0],
  [4, 0, 0],
  [4, 2, 0],
  [0, 2, 0],
];
const mesh = (points) => ({
  vertices: points,
  faces: [{ id: 'face', vertices: points.map((_, i) => i), uv: points.map((_, i) => [i % 2, (i >> 1) % 2]) }],
});
const freeze = (value) => {
  for (const v of Object.values(value)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(value);
};

test('convex validation retains both windings and all planar axes over representable scales', () => {
  for (const scale of [1e-100, 1e-6, 1, 1e6])
    for (const axes of [
      [0, 1, 2],
      [1, 2, 0],
      [2, 0, 1],
    ])
      for (const reverse of [false, true]) {
        const points = rectangle().map((p) => axes.map((axis) => p[axis] * scale));
        if (reverse) points.reverse();
        assert.equal(polygonGeometryError(points), null);
        assert.equal(compilePolygonMesh(mesh(points)).indices.length, 6);
      }
});
test('analytic regular convex polygons through64corners retain fan counts and flat normals', () => {
  for (const n of [3, 4, 5, 8, 32, 64])
    for (const reverse of [false, true]) {
      const points = Array.from({ length: n }, (_, i) => [
        Math.cos((i * 2 * Math.PI) / n),
        Math.sin((i * 2 * Math.PI) / n),
        0,
      ]);
      if (reverse) points.reverse();
      assert.equal(polygonGeometryError(points), null);
      const out = compilePolygonMesh(mesh(points));
      assert.equal(out.indices.length, (n - 2) * 3);
      assert.equal(out.positions.length, n * 3);
      for (let i = 0; i < n; i++) {
        assert.equal(out.normals[i * 3], 0);
        assert.equal(out.normals[i * 3 + 1], 0);
        assert.equal(out.normals[i * 3 + 2], reverse ? -1 : 1);
      }
    }
});
test('crossings,concavity,backtracking and duplicate corners still reject independently', () => {
  const cases = [
    [
      [0, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [1, 0, 0],
    ],
    [
      [0, 0, 0],
      [2, 0, 0],
      [0.5, 0.5, 0],
      [0, 2, 0],
    ],
    [
      [0, 0, 0],
      [2, 0, 0],
      [1, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ],
    [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 0],
      [0, 2, 0],
    ],
  ];
  for (const points of cases) {
    assert(polygonGeometryError(points));
    assert.throws(() => compilePolygonMesh(mesh(points)), /repair|geometry|simple|convex|distinct/);
  }
});
test('distinct-corner and planarity tolerance boundaries remain checked', () => {
  const near = [
      [0, 0, 0],
      [1e-10, 0, 0],
      [4, 2, 0],
      [0, 2, 0],
    ],
    resolved = [
      [0, 0, 0],
      [1e-7, 0, 0],
      [4, 2, 0],
      [0, 2, 0],
    ];
  assert.match(polygonGeometryError(near), /distinct/);
  assert.equal(polygonGeometryError(resolved), null);
  const planar = rectangle(),
    warped = rectangle();
  planar[3][2] = 1e-12;
  warped[3][2] = 1e-3;
  assert.equal(polygonGeometryError(planar), null);
  assert.match(polygonGeometryError(warped), /planar/);
});
test('malformed,sparse,nonfinite and numerically unresolved polygons never become accepted', () => {
  for (const points of [
    null,
    [],
    new Array(3),
    [[0, 0, 0], new Array(3), [1, 1, 0]],
    [
      [0, 0, 0],
      [NaN, 0, 0],
      [1, 1, 0],
    ],
    [
      [0, 0, 0],
      [Infinity, 0, 0],
      [1, 1, 0],
    ],
    [
      [0, 0, 0],
      [new Number(1), 0, 0],
      [1, 1, 0],
    ],
    Array.from({ length: 65 }, () => [0, 0, 0]),
  ])
    assert(polygonGeometryError(points));
  assert(
    polygonGeometryError([
      [-1e308, 0, 0],
      [1e308, 0, 0],
      [1e308, 1, 0],
      [-1e308, 1, 0],
    ]),
  );
});
test('collinear subdivisions and far translated representable geometry remain valid', () => {
  const points = [
    [0, 0, 0],
    [2, 0, 0],
    [4, 0, 0],
    [4, 2, 0],
    [2, 2, 0],
    [0, 2, 0],
  ];
  assert.equal(polygonGeometryError(points), null);
  const shifted = points.map((p) => p.map((v, i) => v + [1e7, -1e7, 3e7][i]));
  assert.equal(polygonGeometryError(shifted), null);
  const out = compilePolygonMesh(mesh(shifted));
  assert.deepEqual(out.positions, shifted.flat());
  assert.deepEqual(out.cornerVertices, [0, 1, 2, 3, 4, 5]);
});
test('frozen source positions and UVs remain unchanged by validation,compilation and inset rejection', () => {
  const source = freeze(mesh(rectangle())),
    before = structuredClone(source);
  assert.equal(polygonGeometryError(source.vertices), null);
  const out = compilePolygonMesh(source);
  assert.deepEqual(out.uvs, source.faces[0].uv.flat());
  assert.deepEqual(out.triangleFaces, ['face', 'face']);
  assert.throws(() => insetMeshRegion(source, ['face'], 2), /width|cross|collapse|fold/);
  assert.deepEqual(source, before);
  out.positions[0] = 999;
  assert.deepEqual(source, before);
});
test('inset candidate checks still reject crossed and collapsed widths after successful prepared frames', () => {
  const source = mesh(rectangle()),
    scene = {
      objects: [
        {
          ...source,
          id: 'body',
          worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          canPaint: true,
          canProject: true,
          canMirror: true,
        },
      ],
      texture: {
        width: 128,
        height: 128,
        pixels: Array.from({ length: 128 * 128 * 4 }, (_, i) => (i % 4 === 3 ? 255 : 17)),
      },
    };
  source.faces[0].uv = [
    [0.2, 0.2],
    [0.4, 0.2],
    [0.4, 0.4],
    [0.2, 0.4],
  ];
  const p = new MeshRegionInsetPreview(scene, 'body', ['face']);
  const good = p.inset(0.1, { pixelsPerUnit: 4, color: '#9483db' });
  for (const width of [1, 1.1, 2, 10]) assert.throws(() => p.inset(width, { pixelsPerUnit: 4, color: '#9483db' }));
  assert.deepEqual(p.inset(0.1, { pixelsPerUnit: 4, color: '#9483db' }), good);
  p.dispose();
});
