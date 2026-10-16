import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const bundle = await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    write: false,
    target: 'es2022',
    minify: false,
    lib: { entry: fileURLToPath(new URL('./geometry-helper.js', import.meta.url)), formats: ['es'] },
  },
});
const api = await import(
  `data:text/javascript;base64,${Buffer.from((Array.isArray(bundle) ? bundle[0] : bundle).output[0].code).toString('base64')}`
);
const {
  buildGeometry,
  identity,
  multiply,
  inverse,
  rotationEuler,
  translation,
  scaling,
  composeTRS,
  decomposeTRS,
  transformPoint,
  transformNormal,
  fbxLocalTransform,
  fbxGeometricTransform,
} = api;
const node = (name, properties = [], children = []) => ({ name, properties, children });
const values = (name, values) => node(name, [values]);
const layer = (type, mapping, reference, name, data, indexName, indices = []) =>
  node(
    type,
    [],
    [
      node('MappingInformationType', [mapping]),
      node('ReferenceInformationType', [reference]),
      values(name, data),
      ...(reference === 'Direct' ? [] : [values(indexName, indices)]),
    ],
  );
const mesh = (positions, polygons, layers = []) =>
  node(
    'Geometry',
    [1n, 'Geometry::Fixture', 'Mesh'],
    [values('Vertices', positions), values('PolygonVertexIndex', polygons), ...layers],
  );
const model = (props) =>
  node(
    'Model',
    [2n, 'Model::Fixture', 'Null'],
    [
      node(
        'Properties70',
        [],
        Object.entries(props).map(([key, val]) => node('P', [key, '', '', '', ...(Array.isArray(val) ? val : [val])])),
      ),
    ],
  );
const close = (actual, expected, tolerance = 1e-7) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `index ${i}: ${actual[i]} != ${expected[i]}`);
};

test('FBX geometry generates area-weighted normals and a control-point map', () => {
  const result = buildGeometry(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3]));
  assert.equal(result.vertexCount, 3);
  assert.equal(result.primitives[0].materialIndex, 0);
  close(result.primitives[0].geometry.normals, [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual([...result.controlPoints[0]], [0, 1, 2]);
});

test('concave triangulation preserves original corner UVs and area', () => {
  const positions = [0, 0, 0, 2, 0, 0, 2, 2, 0, 1, 1, 0, 0, 2, 0],
    uv = [0, 0.1, 0.2, 0.2, 0.4, 0.3, 0.6, 0.4, 0.8, 0.5];
  const result = buildGeometry(
    mesh(positions, [0, 1, 2, 3, -5], [layer('LayerElementUV', 'ByPolygonVertex', 'Direct', 'UV', uv)]),
  );
  const geometry = result.primitives[0].geometry;
  assert.equal(geometry.indices.length, 9);
  let area = 0;
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const a = geometry.indices[i] * 3,
      b = geometry.indices[i + 1] * 3,
      c = geometry.indices[i + 2] * 3,
      p = geometry.positions;
    const triangle = ((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2;
    assert.ok(triangle > 0);
    area += triangle;
  }
  assert.equal(area, 3);
  for (let i = 0; i < result.controlPoints[0].length; i++) {
    const cp = result.controlPoints[0][i];
    close([...geometry.uvs.slice(i * 2, i * 2 + 2)], [uv[cp * 2], 1 - uv[cp * 2 + 1]]);
  }
});

test('UV seams duplicate vertices without losing their original control point', () => {
  const result = buildGeometry(
    mesh(
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      [0, 1, -3, 0, 2, -4],
      [layer('LayerElementUV', 'ByPolygonVertex', 'Direct', 'UV', [0, 0, 1, 0, 1, 1, 0.5, 0.5, 1, 1, 0, 1])],
    ),
  );
  assert.equal(result.vertexCount, 6);
  assert.deepEqual([...result.controlPoints[0]], [0, 1, 2, 0, 2, 3]);
  close(result.primitives[0].geometry.uvs.slice(0, 2), [0, 1]);
  close(result.primitives[0].geometry.uvs.slice(6, 8), [0.5, 0.5]);
});

test('material groups and control-point indexed layers produce independent primitives', () => {
  const result = buildGeometry(
    mesh(
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      [0, 1, -3, 0, 2, -4],
      [
        layer(
          'LayerElementNormal',
          'ByControlPoint',
          'IndexToDirect',
          'Normals',
          [0, 0, 1],
          'NormalsIndex',
          [0, 0, 0, 0],
        ),
        layer('LayerElementColor', 'AllSame', 'Direct', 'Colors', [0.2, 0.3, 0.4, 1]),
        layer('LayerElementMaterial', 'ByPolygon', 'Direct', 'Materials', [1, 0]),
      ],
    ),
  );
  assert.deepEqual(
    result.primitives.map((p) => p.materialIndex),
    [1, 0],
  );
  assert.deepEqual(
    result.controlPoints.map((p) => [...p]),
    [
      [0, 1, 2],
      [0, 2, 3],
    ],
  );
  close(result.primitives[0].geometry.colors, [0.2, 0.3, 0.4, 1, 0.2, 0.3, 0.4, 1, 0.2, 0.3, 0.4, 1]);
});

test('unassigned polygon materials and missing mapping preserve the default material', () => {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    polygons = [0, 1, -3, 0, 2, -4];
  const result = buildGeometry(
    mesh(positions, polygons, [
      layer('LayerElementMaterial', 'ByPolygon', 'IndexToDirect', 'Materials', [-1, 0], 'unused'),
    ]),
  );
  assert.deepEqual(
    result.primitives.map((p) => p.materialIndex),
    [-1, 0],
  );
  const unmapped = node('LayerElementMaterial', [], [node('MappingInformationType', ['NoMappingInformation'])]);
  assert.equal(buildGeometry(mesh(positions, polygons, [unmapped])).primitives[0].materialIndex, -1);
  assert.throws(
    () =>
      buildGeometry(mesh(positions, polygons, [layer('LayerElementMaterial', 'AllSame', 'Direct', 'Materials', [-2])])),
    /material index/,
  );
});

test('per-polygon normals split shared control points on hard edges', () => {
  const result = buildGeometry(
    mesh(
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      [0, 1, -3, 0, 2, -4],
      [layer('LayerElementNormal', 'ByPolygon', 'Direct', 'Normals', [0, 0, 1, 0, 1, 0])],
    ),
  );
  assert.equal(result.vertexCount, 6);
  close(result.primitives[0].geometry.normals, [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
});

test('self-intersecting same-sign-turn star polygons are rejected', () => {
  const positions = Array.from({ length: 5 }, (_, i) => [
    Math.cos((i * 2 * Math.PI) / 5),
    Math.sin((i * 2 * Math.PI) / 5),
    0,
  ]).flat();
  assert.throws(() => buildGeometry(mesh(positions, [0, 2, 4, 1, -4])), /crosses itself/);
});

test('FBX tangent frame reverses handedness when V is flipped', () => {
  const result = buildGeometry(
    mesh(
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 1, -3],
      [
        layer('LayerElementTangent', 'AllSame', 'Direct', 'Tangents', [1, 0, 0]),
        layer('LayerElementBinormal', 'AllSame', 'Direct', 'Binormals', [0, 1, 0]),
      ],
    ),
  );
  close(result.primitives[0].geometry.tangents, [1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1]);
});

test('malformed geometry and unbounded expansion reject predictably', () => {
  assert.throws(() => buildGeometry(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2])), /terminator/);
  assert.throws(() => buildGeometry(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -4])), /control point/);
  assert.throws(
    () => buildGeometry(mesh([0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0, 1, 2, -4])),
    /zero area|crosses itself/,
  );
  assert.throws(() => buildGeometry(mesh({ length: 3_000_003 }, [0, 1, -3])), /geometry budget exceeded/);
  assert.throws(
    () =>
      buildGeometry(
        mesh(
          [0, 0, 0, 1, 0, 0, 0, 1, 0],
          [0, 1, -3],
          [layer('LayerElementUV', 'ByPolygonVertex', 'IndexToDirect', 'UV', [0, 0], 'UVIndex', [0, 0, 5])],
        ),
      ),
    /direct index/,
  );
});

test('all six FBX fixed-axis Euler orders produce known quarter-turn results', () => {
  const expected = [
    [0, 0, -1],
    [0, 1, 0],
    [0, 1, 0],
    [-1, 0, 0],
    [1, 0, 0],
    [0, 0, 1],
  ];
  for (let order = 0; order < 6; order++)
    close(transformPoint(rotationEuler([90, 90, 90], order), 1, 0, 0), expected[order]);
  assert.throws(() => rotationEuler([0, 0, 0], 6), /RotationOrder/);
});

test('matrix inverse and mirrored TRS decomposition preserve the affine transform', () => {
  const matrix = multiply(translation([2, 3, 4]), multiply(rotationEuler([23, 48, 71], 2), scaling([-2, 3, 4])));
  close(multiply(matrix, inverse(matrix)), identity());
  const trs = decomposeTRS(matrix);
  close(composeTRS(trs.translation, trs.rotation, trs.scale), matrix);
  const shear = identity();
  shear[4] = 0.5;
  assert.throws(() => decomposeTRS(shear), /shear/);
  assert.throws(() => inverse(new Float64Array(16)), /singular/);
});

test('normal transform uses the inverse transpose with nonuniform scale and rotation', () => {
  const matrix = multiply(rotationEuler([31, 17, 43]), scaling([2, 3, 4]));
  const normal = transformNormal(matrix, 1, 1, 0),
    tangent = transformPoint(matrix, 1, -1, 0);
  assert.ok(Math.abs(normal[0] * tangent[0] + normal[1] * tangent[1] + normal[2] * tangent[2]) < 1e-10);
  close(transformNormal(rotationEuler([0, 0, 90]), 1, 0, 0), [0, 1, 0]);
});

test('FBX pivots, pre-rotation and inverse post-rotation bake into local TRS', () => {
  close(
    fbxLocalTransform(model({ PreRotation: [90, 0, 0] })),
    fbxLocalTransform(model({ 'Lcl Rotation': [90, 0, 0] })),
  );
  close(fbxLocalTransform(model({ 'Lcl Rotation': [90, 0, 0], PostRotation: [90, 0, 0] })), identity());
  close(
    fbxLocalTransform(
      model({
        RotationActive: 0,
        RotationOrder: 6,
        PreRotation: [90, 0, 0],
        PostRotation: [0, 90, 0],
        'Lcl Rotation': [0, 0, 90],
      }),
    ),
    rotationEuler([0, 0, 90]),
  );
  close(
    transformPoint(fbxLocalTransform(model({ RotationPivot: [1, 0, 0], 'Lcl Rotation': [0, 0, 90] })), 1, 0, 0),
    [1, 0, 0],
  );
  const source = model({ GeometricTranslation: [5, 0, 0] });
  close(fbxLocalTransform(source), identity());
  close(transformPoint(fbxGeometricTransform(source), 0, 0, 0), [5, 0, 0]);
  assert.throws(() => fbxLocalTransform(model({ InheritType: 2 })), /InheritType 2 on Fixture/);
});
