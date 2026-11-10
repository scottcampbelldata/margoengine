import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  parseGeoVectors,
  parseTopoJSON,
  prepareGeoVectors,
  joinGeoData,
  greatCircleArc,
  geoBins,
} from '../dist/geo-vector.js';
import { project } from '../dist/geo.js';
const f = (geometry, properties = {}, id = 1) => ({ type: 'Feature', geometry, properties, id });
const fc = (...features) => ({ type: 'FeatureCollection', features });
const outer = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
test('pinned public-domain vector assets match their byte counts and SHA-256 source record', () => {
  const root = new URL('../../../examples/assets/sciviz/geo-vector/', import.meta.url);
  const record = JSON.parse(readFileSync(new URL('source.json', root), 'utf8'));
  for (const item of [...record.sources, ...record.derived]) {
    const bytes = readFileSync(new URL(item.file, root));
    assert.equal(bytes.length, item.bytes, item.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.file);
  }
});
const hole = [
  [2, 2],
  [2, 8],
  [8, 8],
  [8, 2],
  [2, 2],
];
const area = (positions) => {
  let sum = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const [ax, ay, , bx, by, , cx, cy] = positions.slice(i, i + 9);
    sum += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return sum;
};
test('map polygon holes retain exact area, feature identities and interior label anchors', async () => {
  const source = await parseGeoVectors(fc(f({ type: 'Polygon', coordinates: [outer, hole] }, { name: 'land' })));
  const data = await prepareGeoVectors(source, { projection: 'plate', maxDegrees: 2 });
  assert.ok(Math.abs(area(data.triangles) * 180 ** 2 - 64) < 1e-10);
  assert.ok(data.triangleFeatures.every((v) => v === 0));
  assert.equal(data.labels.length, 1);
  const [x, y] = data.labels[0].position.map((v) => v * 180);
  assert.ok(x >= 0 && x <= 10 && y >= 0 && y <= 10);
  assert.ok(!(x > 2 && x < 8 && y > 2 && y < 8));
  assert.deepEqual(source.features[0].geometry.coordinates, [outer, hole]);
});
test('dateline polygons and lines clip into map edges without spanning the map or losing area', async () => {
  const source = await parseGeoVectors(
    fc(
      f({
        type: 'Polygon',
        coordinates: [
          [
            [170, 0],
            [-170, 0],
            [-170, 10],
            [170, 10],
            [170, 0],
          ],
        ],
      }),
      f({
        type: 'LineString',
        coordinates: [
          [170, 20],
          [-170, 20],
        ],
      }),
    ),
  );
  const data = await prepareGeoVectors(source, { projection: 'plate' });
  assert.ok(Math.abs(area(data.triangles) * 180 ** 2 - 200) < 1e-9);
  for (let i = 0; i < data.lines.length; i += 6)
    assert.ok(Math.abs(data.lines[i] - data.lines[i + 3]) <= 5 / 180 + 1e-12);
  for (let i = 0; i < data.triangles.length; i += 3) assert.ok(Math.abs(data.triangles[i]) >= 170 / 180 - 1e-12);
  assert.ok(data.lineFeatures.includes(1));
});
test('ellipsoid subdivision follows WGS84 surface and keeps all primitive feature identities', async () => {
  const source = await parseGeoVectors(
    fc(
      f({ type: 'Polygon', coordinates: [outer, hole] }),
      f({ type: 'Point', coordinates: [80, 30, 1000] }),
      f({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [80, 50],
        ],
      }),
    ),
  );
  const data = await prepareGeoVectors(source, { projection: 'globe', maxDegrees: 3 });
  assert.ok(data.triangles.length > source.mesh.indices.length * 3);
  assert.deepEqual([...data.pointFeatures], [1]);
  assert.deepEqual([...data.points], project(80, 30, 1000, 'globe'));
  assert.ok(data.lineFeatures.includes(2));
  for (let i = 0; i < data.triangles.length; i += 3) {
    const [x, y, z] = data.triangles.slice(i, i + 3);
    assert.ok(Math.abs(x * x + y * y + (z * z) / (1 - 1 / 298.257223563) ** 2 - 1) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...data.triangleNormals.slice(i, i + 3)) - 1) < 1e-7);
  }
});
test('TopoJSON transforms delta arcs, reversals, shared boundaries, IDs, object selection and nested collections', async () => {
  const topology = {
    type: 'Topology',
    transform: { scale: [0.5, 2], translate: [10, 20] },
    arcs: [
      [
        [0, 0],
        [2, 0],
        [0, 2],
      ],
      [
        [2, 2],
        [-2, 0],
        [0, -2],
      ],
    ],
    objects: {
      land: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', arcs: [[0, 1]], id: 'A', properties: { name: 'land' } },
          { type: 'LineString', arcs: [-1], id: 'B' },
          {
            type: 'MultiPoint',
            coordinates: [
              [2, 2],
              [4, 4],
            ],
          },
        ],
      },
      other: { type: 'Point', coordinates: [0, 0] },
    },
  };
  const result = await parseTopoJSON(topology, { objects: ['land'] });
  assert.equal(result.features.length, 3);
  assert.equal(result.features[0].id, 'A');
  assert.deepEqual(result.features[0].geometry.coordinates[0], [
    [10, 20],
    [11, 20],
    [11, 24],
    [10, 24],
    [10, 20],
  ]);
  assert.deepEqual(result.features[1].geometry.coordinates, [
    [11, 24],
    [11, 20],
    [10, 20],
  ]);
  assert.deepEqual(result.features[2].geometry.coordinates, [
    [11, 24],
    [12, 28],
  ]);
  await assert.rejects(parseTopoJSON(topology, { objects: ['missing'] }), /missing/);
  await assert.rejects(parseTopoJSON(topology, { maxVertices: 2 }), /maxVertices/);
  await assert.rejects(parseTopoJSON(topology, { maxFeatures: 1 }), /maxFeatures/);
  await assert.rejects(parseTopoJSON(topology, { maxDepth: 0 }), /positive/);
  await assert.rejects(
    parseTopoJSON({
      ...topology,
      arcs: [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [99, 0],
          [0, 1],
        ],
      ],
    }),
    /endpoints/,
  );
});
test('choropleth joins preserve typed keys, missing values, zero values and reject duplicate keys', () => {
  const features = [f(null, { code: '1' }), f(null, { code: 1 }), f(null, { code: 'none' })];
  const values = joinGeoData(
    features,
    [
      { key: '1', value: 0 },
      { key: 1, value: 20 },
    ],
    { featureKey: 'code', rowKey: (r) => r.key, value: (r) => r.value },
  );
  assert.deepEqual([...values], [0, 20, NaN]);
  assert.throws(
    () => joinGeoData(features, [1, 1], { featureKey: 'code', rowKey: (r) => r, value: (r) => r }),
    /Duplicate/,
  );
});
test('MVT published protobuf commands and layer selection pass through the clean-room owning reader', async () => {
  const integer = (value) => {
    const bytes = [];
    do {
      const low = value % 128;
      value = Math.floor(value / 128);
      bytes.push(low + (value ? 128 : 0));
    } while (value);
    return bytes;
  };
  const bytesField = (id, bytes) => [id * 8 + 2, ...integer(bytes.length), ...bytes];
  const packed = (id, numbers) => bytesField(id, numbers.flatMap(integer));
  const text = (value) => [...new TextEncoder().encode(value)];
  // One 0..10 square with clockwise screen winding and a counterclockwise 2..8 hole.
  const commands = [9, 0, 0, 26, 20, 0, 0, 20, 19, 0, 15, 9, 4, 15, 26, 0, 12, 12, 0, 0, 11, 15];
  const feature = [8, 7, ...packed(2, [0, 0]), 24, 3, ...packed(4, commands)];
  const layer = [
    ...bytesField(1, text('land')),
    ...bytesField(2, feature),
    ...bytesField(3, text('name')),
    ...bytesField(4, bytesField(1, text('region'))),
    40,
    10,
    120,
    2,
  ];
  const tile = new Uint8Array(bytesField(3, layer));
  const parsed = await parseGeoVectors(tile, { tile: { x: 0, y: 0, z: 0 } });
  assert.equal(parsed.features[0].id, 7);
  assert.equal(parsed.features[0].layer, 'land');
  assert.equal(parsed.features[0].properties.name, 'region');
  assert.equal(parsed.polygons[0].rings.length, 2);
  assert.equal(parsed.crs, 'OGC:CRS84');
  assert.equal((await parseGeoVectors(tile, { tile: { x: 0, y: 0, z: 0 }, layers: ['water'] })).features.length, 0);
  await assert.rejects(parseGeoVectors(tile.subarray(0, -1), { tile: { x: 0, y: 0, z: 0 } }));
});
test('untransformed TopoJSON preserves absolute arcs and text auto-detection', async () => {
  const topology = {
    type: 'Topology',
    arcs: [
      [
        [0, 0],
        [5, 0],
      ],
      [
        [5, 0],
        [5, 5],
      ],
    ],
    objects: {
      line: { type: 'LineString', arcs: [0, 1] },
      points: {
        type: 'MultiPoint',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
    },
  };
  const parsed = await parseGeoVectors(JSON.stringify(topology));
  assert.deepEqual(parsed.features[0].geometry.coordinates, [
    [0, 0],
    [5, 0],
    [5, 5],
  ]);
  await assert.rejects(parseGeoVectors('null'));
  await assert.rejects(parseGeoVectors('{'));
});
test('polar rings close exactly after unwrapping, without modifying the source', async () => {
  const source = await parseGeoVectors(
    f({
      type: 'Polygon',
      coordinates: [
        [
          [0, 80],
          [120, 80],
          [-120, 80],
          [0, 80],
        ],
      ],
    }),
  );
  const data = await prepareGeoVectors(source, { projection: 'globe' });
  assert.ok(data.triangles.length > 100);
  for (let i = 0; i < data.triangles.length; i += 3) assert.ok(data.triangles[i + 2] > 0.98);
  assert.deepEqual(source.features[0].geometry.coordinates[0].at(-1), [0, 80]);
});
test('great circles use shortest spherical paths, preserve endpoints and handle antipodes and coincident points', () => {
  for (const [a, b] of [
    [
      [0, 0],
      [90, 0],
    ],
    [
      [170, 10],
      [-170, 10],
    ],
    [
      [0, 0],
      [180, 0],
    ],
    [
      [40, 80],
      [40, 80],
    ],
  ]) {
    const data = greatCircleArc(a, b, { segments: 20, arch: 1000 });
    assert.equal(data.length, 63);
    assert.ok(data.every(Number.isFinite));
    assert.deepEqual([...data.slice(0, 3)], [...a, 0]);
    assert.deepEqual([...data.slice(-3)], [...b, 0]);
    assert.equal(data[32], 1000);
  }
  const a = greatCircleArc([0, 0], [90, 0], { segments: 2 });
  assert.ok(Math.abs(a[3] - 45) < 1e-12);
  assert.throws(() => greatCircleArc([0, 91], [0, 0]), /latitude/);
});
test('square and hexagonal bins partition exact memberships and retain sums and means after projection', () => {
  assert.equal(project(0, 0)[1], 0, 'Mercator equator has exact zero northing, with no negative-cell cancellation');
  assert.ok(project(0, 1e-14)[1] > 0);
  assert.ok(project(0, -1e-14)[1] < 0);
  for (const shape of ['square', 'hexagon']) {
    const bins = geoBins([0, 0, 0.01, 0.01, 50, 50, -50, -50], { shape, size: 0.1, values: [1, 3, 9, 7] });
    assert.equal(
      bins.reduce((s, b) => s + b.count, 0),
      4,
    );
    assert.equal(
      bins.reduce((s, b) => s + b.sum, 0),
      20,
    );
    assert.deepEqual(bins.flatMap((b) => [...b.indices]).sort(), [0, 1, 2, 3]);
    const first = bins.find((b) => b.indices.includes(0));
    assert.equal(first.mean, 2);
    assert.equal(first.polygon.length, shape === 'square' ? 4 : 6);
  }
  assert.throws(() => geoBins([0, 0], { size: 0 }), /positive/);
  assert.throws(() => geoBins([0, 0], { size: 1, values: [Infinity] }), /finite/);
});
test('vector cancellation, malformed input, empty geometry, depth and output budgets fail before publication', async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(parseGeoVectors('{}', { signal }), { name: 'AbortError' });
  await assert.rejects(parseGeoVectors(new Uint8Array([0])), /XYZ/);
  const source = await parseGeoVectors(fc(f({ type: 'Polygon', coordinates: [outer] })));
  await assert.rejects(prepareGeoVectors(source, { signal }), { name: 'AbortError' });
  await assert.rejects(prepareGeoVectors(source, { maxOutputVertices: 2 }), /maxOutputVertices/);
  await assert.rejects(prepareGeoVectors(source, { maxDegrees: 0 }), /maxDegrees/);
  const empty = await prepareGeoVectors(await parseGeoVectors(fc(f(null))));
  assert.equal(empty.triangles.length, 0);
  assert.ok(empty.bounds.every(Number.isFinite));
  const cyclic = { type: 'GeometryCollection', geometries: [] };
  cyclic.geometries.push(cyclic);
  await assert.rejects(prepareGeoVectors({ ...source, features: [f(cyclic)] }), /maxDepth/);
  await assert.rejects(
    parseTopoJSON({
      type: 'Topology',
      objects: { a: { type: 'LineString', arcs: [0] } },
      arcs: [
        [
          [Number.MAX_SAFE_INTEGER, 0],
          [1, 0],
        ],
      ],
      transform: { scale: [1, 1], translate: [0, 0] },
    }),
    /accumulation/,
  );
  assert.throws(() => greatCircleArc([0, 0, 1e308], [10, 10, 1e308], { arch: 1e308 }), /overflows/);
  assert.throws(() => geoBins([0, 0, 0, 0], { size: 1, values: [1e308, 1e308] }), /overflows/);
});
test('real public-domain Natural Earth and Census geography prepares on both planes and the globe', async () => {
  for (const name of ['countries', 'states']) {
    const source = await parseGeoVectors(
      readFileSync(new URL(`../../../examples/assets/sciviz/geo-vector/${name}.geojson`, import.meta.url), 'utf8'),
    );
    assert.ok(source.features.length > 50);
    for (const projection of ['plate', 'mercator', 'globe']) {
      const data = await prepareGeoVectors(source, { projection });
      assert.ok(data.triangles.length > 1000);
      assert.ok(data.triangles.every(Number.isFinite));
      assert.equal(data.labels.length, source.features.length);
    }
  }
});
