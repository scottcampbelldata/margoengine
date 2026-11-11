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
  geometryBytes,
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

test('a polygon that crosses itself still draws, as in the tool that wrote it', () => {
  const positions = Array.from({ length: 5 }, (_, i) => [
    Math.cos((i * 2 * Math.PI) / 5),
    Math.sin((i * 2 * Math.PI) / 5),
    0,
  ]).flat();
  const star = buildGeometry(mesh(positions, [0, 2, 4, 1, -4]));
  assert.equal(star.primitives[0].geometry.indices.length, 9);
  // A bowtie sums to no area, and its two halves are still there.
  const bowtie = buildGeometry(mesh([0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0, 1, 2, -4]));
  assert.equal(bowtie.primitives[0].geometry.indices.length, 6);
});

test('a UV index of -1 is a corner the set leaves out: it sits at the origin', () => {
  const uv = layer('LayerElementUV', 'ByPolygonVertex', 'IndexToDirect', 'UV', [0.5, 0.25], 'UVIndex', [0, -1, 0]);
  const { uvs } = buildGeometry(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3], [uv])).primitives[0].geometry;
  close(uvs, [0.5, 0.75, 0, 1, 0.5, 0.75]);
});

test('a repeated corner is skipped, and a polygon with no area adds nothing', () => {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0];
  assert.equal(buildGeometry(mesh(positions, [0, 1, 1, -3])).primitives[0].geometry.indices.length, 3);
  assert.equal(buildGeometry(mesh(positions, [0, 1, -3, 0, 1, -5])).primitives[0].geometry.indices.length, 3);
});

test('a zero tangent, or one along the normal, becomes a unit vector across the normal', () => {
  for (const given of [
    [0, 0, 0],
    [0, 0, 1],
  ]) {
    const result = buildGeometry(
      mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, -3], [layer('LayerElementTangent', 'AllSame', 'Direct', 'Tangents', given)]),
    );
    const t = result.primitives[0].geometry.tangents;
    assert.ok(Math.abs(Math.hypot(t[0], t[1], t[2]) - 1) < 1e-6);
    assert.ok(Math.abs(t[2]) < 1e-6);
  }
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
    () => buildGeometry(mesh([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, -3])),
    /contains no triangles/,
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
  // Spherical order is 6: Maya's interpolation choice, with the angles still read as XYZ.
  close(rotationEuler([23, 48, 71], 6), rotationEuler([23, 48, 71], 0));
  assert.throws(() => rotationEuler([0, 0, 0], 7), /RotationOrder/);
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
});

test('one node evaluated at many keys: each result is its own matrix, equal to the chain composed from scratch', () => {
  // Animation evaluates the pivot chain per key and node; its fixed parts are made once per node and the product
  // goes through scratch matrices, so every call must still return a fresh matrix and match a chain built by hand.
  const props = {
      RotationPivot: [0.5, 0, 0],
      ScalingPivot: [0, 0.5, 0],
      PreRotation: [0, 90, 0],
      PostRotation: [5, 0, 0],
      RotationOffset: [0, 1, 0],
      ScalingOffset: [0, 0, 2],
    },
    node = model(props),
    results = [];
  for (let k = 0; k < 4; k++) {
    const overrides = { translation: [k, 2, 3], rotation: [10 * k, 20, 30], scale: [1, 1 + k, 2] };
    results.push([overrides, fbxLocalTransform(node, overrides)]);
  }
  const product = (list) => list.reduce((a, b) => multiply(a, b), identity());
  for (const [o, matrix] of results) {
    const expected = product([
      translation(o.translation),
      translation(props.RotationOffset),
      translation(props.RotationPivot),
      rotationEuler(props.PreRotation),
      rotationEuler(o.rotation),
      inverse(rotationEuler(props.PostRotation)),
      translation(props.RotationPivot.map((v) => -v)),
      translation(props.ScalingOffset),
      translation(props.ScalingPivot),
      scaling(o.scale),
      translation(props.ScalingPivot.map((v) => -v)),
    ]);
    assert.deepEqual([...matrix], [...expected], 'bit for bit, and untouched by later calls');
  }
  assert.notEqual(results[0][1], results[1][1]);
});

test('the geometry build reserves 94 B a corner for a 640,000-corner grid of unique vertices (was about 267 B)', () => {
  // 400 x 400 quads: 160,801 control points, 640,000 corners, 960,000 triangle corners, every corner its own vertex
  // with normals and one UV set (8 floats). Each term is a typed array the build allocates at exactly this size.
  const bytes = geometryBytes(160_801, 640_000, 960_000, 640_000, 8);
  assert.equal(bytes, 160_801 * 24 + 640_000 * 8 + 960_000 * 12 + 320_000 * 4 + 640_000 * (28 + 8 * 4));
  assert.equal(Math.round(bytes / 640_000), 94);
  // The documented cap fits the 128 MiB scene default: 1,000,000 vertices of that layout from 1,000,000 corners.
  assert.ok(geometryBytes(251_001, 1_000_000, 1_500_000, 1_000_000, 12) < 128 * 1024 * 1024);
});
