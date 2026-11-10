import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGeoJSON, parseGPX, parseKML, parseShapefile, parseMVT } from '@margoengine/loaders/geo';
const enc = (s) => new TextEncoder().encode(s);
const outer = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ],
  hole = [
    [2, 2],
    [2, 8],
    [8, 8],
    [8, 2],
    [2, 2],
  ];
const feature = (geometry, properties = {}, id = 7) => ({ type: 'Feature', geometry, properties, id });
const polygon = () => ({ type: 'Polygon', coordinates: [outer, hole] });
const area = (result) => {
  let sum = 0;
  const p = result.positions,
    i = result.mesh.indices ?? [];
  for (let t = 0; t < i.length; t += 3) {
    const [a, b, c] = [i[t] * 3, i[t + 1] * 3, i[t + 2] * 3];
    sum += Math.abs((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2;
  }
  return sum;
};
test('GeoJSON mixed primitives, holes, null geometry, nested collections and owned double precision', () => {
  const source = {
    type: 'FeatureCollection',
    features: [
      feature({ type: 'Point', coordinates: [1.123456789012345, 2, 3] }),
      feature({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
      }),
      feature(polygon(), { name: 'land' }),
      feature(null),
    ],
  };
  const result = parseGeoJSON(source);
  assert.equal(result.features.length, 4);
  assert.equal(result.points.length, 1);
  assert.equal(result.positions[0], 1.123456789012345);
  assert.equal(result.lines.length / 2, 10);
  assert.equal(result.polygons.length, 1);
  assert.equal(result.polygons[0].rings.length, 2);
  assert.equal(area(result), 64);
  assert.ok(result.triangleFeatures.every((f) => f === 2));
  assert.equal(result.mesh.groups[0].name, 'land');
  source.features[0].geometry.coordinates[0] = 99;
  source.features[2].properties.name = 'changed';
  assert.equal(result.positions[0], 1.123456789012345);
  assert.equal(result.features[2].properties.name, 'land');
  const nested = parseGeoJSON({
    type: 'GeometryCollection',
    geometries: [
      {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      { type: 'MultiPolygon', coordinates: [[outer]] },
    ],
  });
  assert.equal(nested.points.length, 2);
  assert.equal(area(nested), 100);
});
test('GeoJSON validates types, closures, finite positions, bounds, cancellation and safe names', () => {
  const result = parseGeoJSON(
    '{"type":"Feature","properties":{"__proto__":3,"constructor":"safe"},"geometry":{"type":"Point","coordinates":[1,2]}}',
  );
  assert.equal(Object.getPrototypeOf(result.features[0].properties), null);
  assert.equal(result.features[0].properties.__proto__, 3);
  for (const source of [
    'null',
    '{',
    '{"type":"FeatureCollection"}',
    feature({ type: 'Point', coordinates: [NaN, 0] }),
    feature({ type: 'Polygon', coordinates: [outer.slice(0, -1)] }),
  ])
    assert.throws(
      () => parseGeoJSON(source),
      (e) => e.name === 'LoaderError',
    );
  assert.throws(() => parseGeoJSON(polygon(), { maxTriangles: 1 }), { code: 'limit' });
  assert.throws(() => parseGeoJSON(polygon(), { maxVertices: 3 }), { code: 'limit' });
  assert.throws(() => parseGeoJSON('{}', { maxBytes: 1 }), { code: 'limit' });
  const abort = new AbortController();
  abort.abort();
  assert.throws(() => parseGeoJSON('{}', { signal: abort.signal }), { code: 'aborted' });
});
test('real public-domain Natural Earth land polygons retain every feature and feature-addressed triangles', () => {
  const bytes = readFileSync(new URL('../../procedural/test/fixtures/caves/ne_110m_land.geojson', import.meta.url));
  const source = JSON.parse(bytes),
    result = parseGeoJSON(bytes);
  assert.equal(source.features.length, 127);
  assert.equal(result.features.length, 127);
  assert.ok(result.mesh.indices.length > 1000);
  assert.ok(result.polygons.length >= 127);
  assert.equal(result.triangleFeatures.length, result.mesh.indices.length / 3);
  assert.ok(result.mesh.indices.every((i) => i < result.positions.length / 3));
});
test('GPX waypoints, routes and separated track segments keep elevation, names and timestamps', () => {
  const result = parseGPX(
    `<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"><g:wpt lon="1" lat="2"><g:ele>3</g:ele><g:name>A &amp; B</g:name></g:wpt><g:rte><g:rtept lon="0" lat="0"/><g:rtept lon="1" lat="1"/></g:rte><g:trk><g:name>track</g:name><g:trkseg><g:trkpt lon="0" lat="0"><g:time>2020-01-01T00:00:00Z</g:time></g:trkpt><g:trkpt lon="1" lat="1"/></g:trkseg><g:trkseg><g:trkpt lon="3" lat="3"/><g:trkpt lon="4" lat="4"/></g:trkseg></g:trk></g:gpx>`,
  );
  assert.deepEqual([...result.positions.slice(0, 3)], [1, 2, 3]);
  assert.equal(result.features[0].properties.name, 'A & B');
  assert.equal(result.lines.length / 2, 3);
  assert.deepEqual([...result.lineFeatures], [1, 2, 2]);
  assert.equal(result.features[2].properties.times[0][0], '2020-01-01T00:00:00Z');
  assert.throws(() => parseGPX('<gpx><wpt lat="91" lon="0"/></gpx>'), { code: 'range' });
});
test('KML placemarks preserve MultiGeometry, holes, extended attributes and gx tracks', () => {
  const ring = (r) => r.map((p) => p.join(',')).join(' ');
  const result = parseKML(
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark id="land"><name>parcel</name><ExtendedData><Data name="__proto__"><value>safe</value></Data></ExtendedData><MultiGeometry><Point><coordinates>1,2,3</coordinates></Point><LineString><coordinates>0,0 1,1</coordinates></LineString><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(outer)}</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>${ring(hole)}</coordinates></LinearRing></innerBoundaryIs></Polygon></MultiGeometry></Placemark><Placemark><gx:Track xmlns:gx="http://www.google.com/kml/ext/2.2"><when>a</when><when>b</when><gx:coord>1 2 3</gx:coord><gx:coord>4 5 6</gx:coord></gx:Track></Placemark></Document></kml>`,
  );
  assert.equal(result.features[0].id, 'land');
  assert.equal(result.features[0].properties.__proto__, 'safe');
  assert.equal(result.points.length, 1);
  assert.equal(area(result), 64);
  assert.deepEqual(result.features[1].properties.times, ['a', 'b']);
  assert.equal(result.lines.length / 2, 10);
});
function shp(type, records) {
  const length = 100 + records.reduce((n, b) => n + 8 + b.length, 0),
    bytes = new Uint8Array(length),
    view = new DataView(bytes.buffer);
  view.setInt32(0, 9994);
  view.setInt32(24, length / 2);
  view.setInt32(28, 1000, true);
  view.setInt32(32, type, true);
  let at = 100;
  for (let r = 0; r < records.length; r++) {
    const b = records[r];
    view.setInt32(at, r + 1);
    view.setInt32(at + 4, b.length / 2);
    bytes.set(b, at + 8);
    at += 8 + b.length;
  }
  return bytes;
}
function pointRecord(type, x, y, z, m) {
  const bytes = new Uint8Array(type === 0 ? 4 : type === 1 ? 20 : type === 11 ? 36 : 28),
    v = new DataView(bytes.buffer);
  v.setInt32(0, type, true);
  if (type) {
    v.setFloat64(4, x, true);
    v.setFloat64(12, y, true);
    if (type === 11) {
      v.setFloat64(20, z, true);
      v.setFloat64(28, m, true);
    } else if (type === 21) v.setFloat64(20, m, true);
  }
  return bytes;
}
function partsRecord(type, rings, patchTypes) {
  const points = rings.flat(),
    z = [13, 15, 31].includes(type),
    m = [13, 15, 23, 25, 31].includes(type),
    length =
      44 +
      rings.length * 4 +
      (type === 31 ? rings.length * 4 : 0) +
      points.length * 16 +
      (z ? 16 + points.length * 8 : 0) +
      (m ? 16 + points.length * 8 : 0),
    bytes = new Uint8Array(length),
    v = new DataView(bytes.buffer);
  v.setInt32(0, type, true);
  v.setUint32(36, rings.length, true);
  v.setUint32(40, points.length, true);
  let at = 44,
    start = 0;
  for (const ring of rings) {
    v.setUint32(at, start, true);
    at += 4;
    start += ring.length;
  }
  if (type === 31)
    for (const p of patchTypes) {
      v.setUint32(at, p, true);
      at += 4;
    }
  for (const p of points) {
    v.setFloat64(at, p[0], true);
    v.setFloat64(at + 8, p[1], true);
    at += 16;
  }
  if (z) {
    at += 16;
    for (const p of points) {
      v.setFloat64(at, p[2] ?? 0, true);
      at += 8;
    }
  }
  if (m) {
    at += 16;
    for (const p of points) {
      v.setFloat64(at, p[3] ?? 9, true);
      at += 8;
    }
  }
  return bytes;
}
function dbf(rows) {
  const header = 97,
    stride = 16,
    bytes = new Uint8Array(header + stride * rows.length + 1),
    v = new DataView(bytes.buffer);
  bytes[0] = 3;
  v.setUint32(4, rows.length, true);
  v.setUint16(8, header, true);
  v.setUint16(10, stride, true);
  bytes.set(enc('name'), 32);
  bytes[43] = 67;
  bytes[48] = 10;
  bytes.set(enc('value'), 64);
  bytes[75] = 78;
  bytes[80] = 5;
  bytes[96] = 13;
  rows.forEach((r, i) => {
    const at = header + i * stride;
    bytes[at] = r.deleted ? 42 : 32;
    bytes.set(enc(r.name.padEnd(10).slice(0, 10)), at + 1);
    bytes.set(enc(String(r.value).padStart(5)), at + 11);
  });
  bytes[bytes.length - 1] = 26;
  return bytes;
}
test('Shapefile PointZ and dBASE alignment preserve null and deleted records and CRS text', () => {
  const source = shp(11, [pointRecord(11, 1, 2, 3, 4), pointRecord(0), pointRecord(11, 5, 6, 7, 8)]),
    table = dbf([
      { name: 'a', value: 1 },
      { name: 'null', value: 2 },
      { name: 'deleted', value: 3, deleted: true },
    ]);
  const result = parseShapefile(source, { dbf: table, prj: 'source WKT' });
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features[0].geometry.coordinates, [1, 2, 3, 4]);
  assert.equal(result.features[1].geometry, null);
  assert.equal(result.features[1].properties.value, 2);
  assert.equal(result.crs, 'source WKT');
  const all = parseShapefile(source, { dbf: table, includeDeleted: true });
  assert.equal(all.features[2].properties.deleted, true);
  assert.equal(all.features[2].id, 3);
});
test('Shapefile multipart polygons classify reordered holes and islands and preserve Z/M', () => {
  const source = shp(15, [
    partsRecord(15, [
      hole,
      outer,
      [
        [20, 0],
        [21, 0],
        [21, 1],
        [20, 1],
        [20, 0],
      ],
    ]),
  ]);
  const result = parseShapefile(source);
  assert.equal(result.polygons.length, 2);
  assert.equal(area(result), 65);
  assert.equal(result.features[0].geometry.coordinates[0][0][0][3], 9);
  const line = parseShapefile(
    shp(23, [
      partsRecord(23, [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [5, 5],
          [6, 6],
        ],
      ]),
    ]),
  );
  assert.equal(line.lines.length / 2, 2);
  assert.deepEqual(line.features[0].geometry.coordinates[0][0], [0, 0, 0, 9]);
  const patch = parseShapefile(
    shp(31, [
      partsRecord(
        31,
        [
          [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ],
        ],
        [0],
      ),
    ]),
  );
  assert.equal(patch.mesh.indices.length, 6);
  assert.equal(area(patch), 1);
});
test('Shapefile bounds, record lengths and sidecar counts reject before unsafe reads', () => {
  const source = shp(1, [pointRecord(1, 1, 2)]);
  assert.throws(() => parseShapefile(source.subarray(0, -1)), { code: 'truncated' });
  assert.throws(() => parseShapefile(source, { dbf: dbf([]) }), { code: 'range' });
  const hostile = shp(5, [partsRecord(5, [outer])]);
  new DataView(hostile.buffer).setUint32(148, 0xffffffff, true);
  assert.throws(
    () => parseShapefile(hostile),
    (e) => e.name === 'LoaderError',
  );
});
const varint = (n) => {
  n = BigInt(n);
  const bytes = [];
  do {
    let b = Number(n & 127n);
    n >>= 7n;
    if (n) b |= 128;
    bytes.push(b);
  } while (n);
  return bytes;
};
const field = (n, wire, data) => [...varint(n * 8 + wire), ...(wire === 2 ? [...varint(data.length), ...data] : data)];
const packed = (n, values) => field(n, 2, values.flatMap(varint));
const zig = (n) => (n < 0 ? -n * 2 - 1 : n * 2);
function geometry(paths, type) {
  let x = 0,
    y = 0;
  const commands = [];
  for (const path of paths) {
    commands.push(9, zig(path[0][0] - x), zig(path[0][1] - y));
    [x, y] = path[0];
    if (type !== 1 && path.length > 1) {
      commands.push(((path.length - 1) << 3) | 2);
      for (const p of path.slice(1)) {
        commands.push(zig(p[0] - x), zig(p[1] - y));
        [x, y] = p;
      }
    }
    if (type === 3) commands.push(15);
  }
  return commands;
}
const mvtFeature = (type, commands, tags = [0, 0], id = 9007199254740993n) => [
  ...field(1, 0, varint(id)),
  ...packed(2, tags),
  ...field(3, 0, varint(type)),
  ...packed(4, commands),
];
function tile(features, name = 'land', extent = 10) {
  const layer = [
    ...field(15, 0, varint(2)),
    ...field(1, 2, enc(name)),
    ...features.flatMap((f) => field(2, 2, f)),
    ...field(3, 2, enc('__proto__')),
    ...field(4, 2, field(1, 2, enc('safe'))),
    ...field(5, 0, varint(extent)),
  ];
  return new Uint8Array(field(3, 2, layer));
}
test('MVT holes, IDs, attributes, layers and geometry command deltas survive exactly', () => {
  const commands = geometry([outer.slice(0, -1), hole.slice(0, -1)], 3),
    result = parseMVT(tile([mvtFeature(3, commands)]));
  assert.equal(result.features[0].id, '9007199254740993');
  assert.equal(result.features[0].properties.__proto__, 'safe');
  assert.equal(result.features[0].layer, 'land');
  assert.equal(result.features[0].extent, 10);
  assert.equal(result.crs, 'tile-local');
  assert.equal(area(result), 64);
  assert.equal(result.polygons[0].rings.length, 2);
  const wgs = parseMVT(tile([mvtFeature(1, geometry([[[0, 0]]], 1))]), { tile: { x: 0, y: 0, z: 0 } });
  assert.equal(wgs.positions[0], -180);
  assert.ok(Math.abs(wgs.positions[1] - 85.0511287798066) < 1e-12);
  assert.equal(parseMVT(tile([mvtFeature(3, commands)]), { layers: ['other'] }).features.length, 0);
});
test('MVT multipart lines and repeated point MoveTo commands remain separate', () => {
  const lines = geometry(
      [
        [
          [0, 0],
          [2, 0],
          [2, 2],
        ],
        [
          [8, 8],
          [9, 9],
        ],
      ],
      2,
    ),
    points = [25, zig(1), zig(2), zig(2), zig(2), zig(-3), zig(1)];
  const result = parseMVT(tile([mvtFeature(2, lines), mvtFeature(1, points)]));
  assert.equal(result.lines.length / 2, 3);
  assert.equal(result.points.length, 3);
  assert.deepEqual([...result.lineFeatures], [0, 0, 0]);
  assert.deepEqual([...result.pointFeatures], [1, 1, 1]);
});
test('MVT truncated varints, illegal commands, tags and limits are coded failures', () => {
  for (const bytes of [
    new Uint8Array([0x80]),
    new Uint8Array([0x1b]),
    tile([mvtFeature(3, [9, 0, 0, 15])]),
    tile([mvtFeature(2, [10, 0, 0])]),
    tile([mvtFeature(1, [9, 0, 0], [2, 0])]),
  ])
    assert.throws(
      () => parseMVT(bytes),
      (e) => e.name === 'LoaderError',
    );
  assert.throws(() => parseMVT(tile([mvtFeature(1, [9, 0, 0]), mvtFeature(1, [9, 0, 0])]), { maxFeatures: 1 }), {
    code: 'limit',
  });
  assert.throws(() => parseMVT(tile([]), { tile: { x: 1, y: 0, z: 0 } }), { code: 'range' });
});

test('empty and singleton GPX paths remain valid source features without invented segments', () => {
  const result = parseGPX(
    '<gpx><rte/><rte><rtept lon="1" lat="2"/></rte><trk><trkseg/><trkseg><trkpt lon="3" lat="4"/></trkseg></trk></gpx>',
  );
  assert.equal(result.features.length, 3);
  assert.equal(result.features[0].geometry, null);
  assert.equal(result.points.length, 2);
  assert.equal(result.lines.length, 0);
  assert.throws(
    () => parseGPX('<gpx><wpt lon="" lat="0"/></gpx>'),
    (e) => e.name === 'LoaderError',
  );
  assert.throws(() => parseKML('<kml><Placemark><Point><coordinates>1,,3</coordinates></Point></Placemark></kml>'), {
    code: 'syntax',
  });
  assert.throws(() => parseGeoJSON({ type: 'Feature', properties: {}, geometry: false }), { code: 'syntax' });
  assert.equal(parseGeoJSON({ type: 'LineString', coordinates: [] }).lines.length, 0);
});

test('Shapefile multipoints and PointM retain explicit points and measures', () => {
  const bytes = new Uint8Array(40 + 2 * 16),
    v = new DataView(bytes.buffer);
  v.setInt32(0, 8, true);
  v.setInt32(36, 2, true);
  [1, 2, 3, 4].forEach((n, i) => v.setFloat64(40 + i * 8, n, true));
  const multi = parseShapefile(shp(8, [bytes]));
  assert.equal(multi.points.length, 2);
  assert.deepEqual([...multi.positions], [1, 2, 0, 3, 4, 0]);
  const measured = parseShapefile(shp(21, [pointRecord(21, 1, 2, 0, 3)]));
  assert.deepEqual(measured.features[0].geometry.coordinates, [1, 2, 0, 3]);
});
