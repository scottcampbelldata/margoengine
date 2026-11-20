// GeoTIFF reading (GAP-FILM-GEOTIFF): a float GeoTIFF built by hand, like a USGS 3DEP exportImage or an SRTM tile, gives
// its ASCII tags through openTIFF and its georeference, coordinate system and no-data value through readGeoTIFF.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openTIFF } from '../dist/tiff.js';
import { readGeoTIFF } from '../dist/geotiff.js';

const TYPE = { ascii: 2, short: 3, long: 4, double: 12 };
/** A little-endian classic TIFF of one float32 (or int16) page, 3 by 2 pixels, with the given extra tags (id, type, values). */
function build({ extra = [], int16 = false, big = false } = {}) {
  const pixels = int16 ? Int16Array.of(1, 2, 3, 4, 5, 6) : Float32Array.of(1, 2, 3, 4, 5, 6),
    entries = [
      [256, TYPE.short, [3]],
      [257, TYPE.short, [2]],
      [258, TYPE.short, [int16 ? 16 : 32]],
      [259, TYPE.short, [1]],
      [262, TYPE.short, [1]],
      [273, TYPE.long, [0]], // strip offset, patched below
      [277, TYPE.short, [1]],
      [278, TYPE.short, [2]],
      [279, TYPE.long, [pixels.byteLength]],
      [339, TYPE.short, [int16 ? 2 : 3]],
      ...extra,
    ].sort((a, b) => a[0] - b[0]);
  const sizeOf = (t) => ({ 2: 1, 3: 2, 4: 4, 12: 8 })[t];
  const bytesOf = ([, type, values]) => {
    if (type === TYPE.ascii) return Buffer.from(values + '\0', 'latin1');
    const b = Buffer.alloc(values.length * sizeOf(type));
    values.forEach((v, i) =>
      type === TYPE.short ? b.writeUInt16LE(v, i * 2) : type === TYPE.long ? b.writeUInt32LE(v, i * 4) : b.writeDoubleLE(v, i * 8),
    );
    return b;
  };
  const ifdSize = 2 + entries.length * 12 + 4;
  let heap = 8 + ifdSize;
  const heapParts = [],
    table = Buffer.alloc(ifdSize);
  table.writeUInt16LE(entries.length, 0);
  let stripAt = 0;
  entries.forEach((entry, n) => {
    const [id, type] = entry,
      data = bytesOf(entry),
      count = type === TYPE.ascii ? data.length : data.length / sizeOf(type),
      at = 2 + n * 12;
    table.writeUInt16LE(id, at);
    table.writeUInt16LE(type, at + 2);
    table.writeUInt32LE(count, at + 4);
    if (data.length <= 4) data.copy(table, at + 8);
    else {
      table.writeUInt32LE(heap, at + 8);
      heapParts.push(data);
      heap += data.length + (data.length % 2);
      if (data.length % 2) heapParts.push(Buffer.alloc(1));
    }
    if (id === 273) stripAt = at + 8;
  });
  table.writeUInt32LE(heap, stripAt);
  const header = Buffer.alloc(8);
  header.write('II', 0);
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  return new Uint8Array(Buffer.concat([header, table, ...heapParts, Buffer.from(pixels.buffer)]));
}

// GeoKeyDirectory: version 1.1.0, then [key, location, count, value]: GTModelType, GTRasterType, ProjectedCSType, and a
// citation read from the ASCII parameters; VerticalUnits.
const keys = (model, raster, epsg, extra = []) => [1, 1, 0, 4 + extra.length / 4, 1024, 0, 1, model, 1025, 0, 1, raster, model === 2 ? 2048 : 3072, 0, 1, epsg, 4099, 0, 1, 9001, ...extra];

test('the ASCII tags GDAL writes are kept on the page', () => {
  const bytes = build({
    extra: [
      [270, TYPE.ascii, 'a tile'],
      [34737, TYPE.ascii, 'NAD83 / UTM zone 10N|'],
      [42113, TYPE.ascii, '-999999'],
    ],
  });
  const page = openTIFF(bytes).read(0);
  assert.equal(page.description, 'a tile');
  assert.equal(page.ascii.get(270), 'a tile');
  assert.equal(page.ascii.get(34737), 'NAD83 / UTM zone 10N|');
  assert.equal(page.ascii.get(42113), '-999999');
  assert.equal(openTIFF(build()).read(0).ascii.size, 0);
});

test('a projected north-up GeoTIFF gives its box, pixel size, EPSG code, units and no-data value', () => {
  const info = readGeoTIFF(
    openTIFF(
      build({
        extra: [
          [33550, TYPE.double, [30, 30, 0]],
          [33922, TYPE.double, [0, 0, 0, 500000, 4100000, 0]],
          [34735, TYPE.short, keys(1, 1, 26910, [1026, 34737, 21, 0])],
          [34737, TYPE.ascii, 'NAD83 / UTM zone 10N|'],
          [42113, TYPE.ascii, '-999999'],
        ],
      }),
    ).read(0),
  );
  assert.equal(info.raster, 'area');
  assert.deepEqual(info.crs, { model: 'projected', epsg: 26910, citation: 'NAD83 / UTM zone 10N' });
  assert.equal(info.verticalUnits, 'metre');
  assert.deepEqual(info.transform, [30, 0, 500000, 0, -30, 4100000]);
  assert.deepEqual(info.pixel, [30, 30]);
  assert.equal(info.rotated, false);
  assert.deepEqual(info.box, [500000, 4100000 - 60, 500000 + 90, 4100000]);
  assert.deepEqual(info.sampleBox, [500015, 4100000 - 45, 500000 + 75, 4100000 - 15]);
  assert.equal(info.noData, -999999);
  assert.deepEqual(info.tiepoints, []);
});

test('a geographic PixelIsPoint SRTM tile with GDAL_NODATA -32768 has its box half a pixel out', () => {
  const step = 1 / 1200,
    info = readGeoTIFF(
      openTIFF(
        build({
          int16: true,
          extra: [
            [33550, TYPE.double, [step, step, 0]],
            [33922, TYPE.double, [0, 0, 0, -122, 38, 0]],
            [34735, TYPE.short, keys(2, 2, 4326)],
            [42113, TYPE.ascii, '-32768'],
          ],
        }),
      ).read(0),
    );
  assert.equal(info.raster, 'point');
  assert.deepEqual(info.crs, { model: 'geographic', epsg: 4326, citation: null });
  assert.equal(info.noData, -32768);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} is not ${b}`);
  // Samples sit on the tie point: the first centre is -122, 38; the last is 2 pixels east and 1 south.
  [-122, 38 - step, -122 + 2 * step, 38].forEach((v, i) => close(info.sampleBox[i], v));
  [-122 - step / 2, 38 - 1.5 * step, -122 + 2.5 * step, 38 + step / 2].forEach((v, i) => close(info.box[i], v));
});

test('a nan no-data text reads as NaN, an absent one as null, a garbage one throws', () => {
  const georef = [
    [33550, TYPE.double, [1, 1, 0]],
    [33922, TYPE.double, [0, 0, 0, 0, 0, 0]],
  ];
  assert.ok(Number.isNaN(readGeoTIFF(openTIFF(build({ extra: [...georef, [42113, TYPE.ascii, 'nan']] })).read(0)).noData));
  assert.ok(Number.isNaN(readGeoTIFF(openTIFF(build({ extra: [[42113, TYPE.ascii, ' NaN ']] })).read(0)).noData));
  assert.equal(readGeoTIFF(openTIFF(build({ extra: georef })).read(0)).noData, null);
  assert.equal(readGeoTIFF(openTIFF(build({ extra: [[42113, TYPE.ascii, '-3.4028234663852886e+38']] })).read(0)).noData, -3.4028234663852886e38);
  assert.throws(() => readGeoTIFF(openTIFF(build({ extra: [[42113, TYPE.ascii, 'none']] })).read(0)), { code: 'failed' });
});

test('a page with no georeference tags gives null georeference fields and still its no-data value', () => {
  const info = readGeoTIFF(openTIFF(build({ extra: [[42113, TYPE.ascii, '0']] })).read(0));
  assert.equal(info.transform, null);
  assert.equal(info.pixel, null);
  assert.equal(info.box, null);
  assert.equal(info.sampleBox, null);
  assert.equal(info.noData, 0);
  assert.deepEqual(info.crs, { model: 'unknown', epsg: null, citation: null });
  assert.equal(info.raster, 'area');
});

test('ModelTransformation gives a rotated raster its bounding box and flags it', () => {
  // x = 10 i + 5 j + 100, y = 5 i - 10 j + 200 (a 2 by 3 sheared raster)
  const m = [10, 5, 0, 100, 5, -10, 0, 200, 0, 0, 1, 0, 0, 0, 0, 1],
    info = readGeoTIFF(openTIFF(build({ extra: [[34264, TYPE.double, m]] })).read(0));
  assert.equal(info.rotated, true);
  assert.deepEqual(info.transform, [10, 5, 100, 5, -10, 200]);
  assert.deepEqual(info.box, [100, 200 - 20 + 0, 100 + 30 + 10, 200 + 15]);
  assert.ok(Math.abs(info.pixel[0] - Math.hypot(10, 5)) < 1e-12);
});

test('several tie points with no scale are reported, not interpolated', () => {
  const ties = [0, 0, 0, 10, 20, 0, 2, 1, 0, 14, 18, 0],
    info = readGeoTIFF(openTIFF(build({ extra: [[33922, TYPE.double, ties]] })).read(0));
  assert.equal(info.transform, null);
  assert.equal(info.box, null);
  assert.deepEqual(info.tiepoints, [
    [0, 0, 0, 10, 20, 0],
    [2, 1, 0, 14, 18, 0],
  ]);
});

test('malformed GeoTIFF tags throw a coded failure', () => {
  const read = (extra) => () => readGeoTIFF(openTIFF(build({ extra })).read(0));
  assert.throws(read([[33550, TYPE.double, [1, 1]], [33922, TYPE.double, [0, 0, 0, 0, 0, 0]]]), { code: 'failed' });
  assert.throws(read([[33550, TYPE.double, [1, 1, 0]], [33922, TYPE.double, [0, 0, 0, 0, 0]]]), { code: 'failed' });
  assert.throws(read([[34264, TYPE.double, [1, 2, 3]]]), { code: 'failed' });
  assert.throws(read([[34735, TYPE.short, [1, 1, 0, 9, 1024, 0, 1, 1]]]), { code: 'failed' });
  assert.throws(read([[34735, TYPE.short, [2, 1, 0, 0]]]), { code: 'failed' });
  assert.throws(read([[34735, TYPE.short, [1, 1, 0, 1, 1026, 34737, 40, 0]], [34737, TYPE.ascii, 'short|']]), { code: 'failed' });
});
