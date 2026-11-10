import test from 'node:test';
import assert from 'node:assert/strict';
import { ColumnarTable, CrossFilter } from '../dist/table.js';
import { aggregateRaster, shadeAggregate } from '../dist/aggregate.js';
import { createCompute } from '@margoengine/compute';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const options = { columns: { x: 'x', y: 'y' }, bounds: [0, 2, 0, 2], width: 2, height: 2, value: 'v' };
const table = (values, xy = 0.5) =>
  new ColumnarTable({
    x: new Float64Array(values.length).fill(xy),
    y: new Float64Array(values.length).fill(xy),
    v: Float64Array.from(values),
  });
test('density spreading stops at the first occupied-neighbour footprint instead of the maximum radius', async () => {
  const result = await aggregateRaster(table([1], 4.5), {
    ...options, bounds: [0, 9, 0, 9], width: 9, height: 9,
  });
  const counts = result.count.slice();
  const footprint = (pixels) => [...pixels.keys()].filter((i) => pixels[i]);
  assert.deepEqual(footprint(shadeAggregate(result, { spread: 4, density: 0.5 })), [31, 39, 40, 41, 49]);
  assert.equal(footprint(shadeAggregate(result, { spread: 4 })).length, 49);
  assert.deepEqual(footprint(shadeAggregate(result, { spread: 0, density: 0.5 })), [40]);
  assert.deepEqual(result.count, counts);
});

test('density spreading retains dense and empty images and clips growth to raster edges', async () => {
  const result = await aggregateRaster(table([1], 0.5), { ...options, bounds: [0, 9, 0, 9], width: 9, height: 9 });
  const pixels = shadeAggregate(result, { spread: 4, density: 0.5 });
  assert.deepEqual([...pixels.keys()].filter((i) => pixels[i]), [0, 1, 9]);
  const empty = await aggregateRaster(table([], 0.5), options);
  assert.deepEqual([...shadeAggregate(empty, { spread: 4, density: 0.5 })], [0, 0, 0, 0]);
  const denseTable = new ColumnarTable({
    x: Float64Array.from({ length: 9 }, (_, i) => i % 3 + 3.5),
    y: Float64Array.from({ length: 9 }, (_, i) => Math.floor(i / 3) + 3.5),
  });
  const dense = await aggregateRaster(denseTable, { ...options, value: undefined, bounds: [0, 9, 0, 9], width: 9, height: 9 });
  assert.deepEqual(shadeAggregate(dense, { spread: 4, density: 0.5 }), shadeAggregate(dense));
  const single = await aggregateRaster(table([1]), { ...options, width: 1, height: 1 });
  assert.deepEqual(shadeAggregate(single, { spread: 4, density: 1 }), shadeAggregate(single));
});
test('binary64 sums and means are exact across cancellation, overflow, subnormals, ties and chunk boundaries', async () => {
  const cases = [
    [[1e16, 1, -1e16], 1, 1 / 3],
    [[Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE], Number.MAX_VALUE, Number.MAX_VALUE / 3],
    [[Number.MAX_VALUE, Number.MAX_VALUE], Infinity, Number.MAX_VALUE],
    [[Number.MIN_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE], Number.MIN_VALUE, 0],
    [[1, 2 ** -53], 1, 0.5],
    [[1, 3 * 2 ** -53], 1 + 2 ** -51, (1 + 2 ** -51) / 2],
  ];
  for (const [values, sum, mean] of cases)
    for (const chunkRows of [1, 2, 3, 65536]) {
      const result = await aggregateRaster(table(values), { ...options, chunkRows });
      assert.equal(result.sum[0], sum);
      assert.equal(result.mean[0], mean);
      assert.equal(result.count[0], values.length);
    }
});
test('every reduction preserves missing values, ordered rows, category counts and physical hover', async () => {
  const t = new ColumnarTable({
    x: Float64Array.of(0, 2, 1.999999999999, NaN, 0.5, 0.5),
    y: Float64Array.of(0, 2, 1.999999999999, 1, 0.5, 0.5),
    v: { values: Float64Array.of(4, 8, -2, 10, Infinity, 100), validity: Uint8Array.of(0b011111) },
    c: { values: Uint32Array.of(0, 1, 0, 1, 1, 0), categories: ['a', '__proto__'] },
  });
  const r = await aggregateRaster(t, { ...options, category: 'c', chunkRows: 2 });
  assert.deepEqual([...r.count], [3, 0, 0, 2]);
  assert.deepEqual([...r.valid], [1, 0, 0, 2]);
  assert.deepEqual(r.at(2, 2), {
    count: 2,
    valid: 2,
    sum: 6,
    mean: 3,
    min: -2,
    max: 8,
    first: 8,
    last: -2,
    firstRow: 1,
    lastRow: 2,
    categories: { a: 1, ['__proto__']: 1 },
  });
  assert.equal(r.at(-1, 0), undefined);
  assert.equal(r.at(NaN, 0), undefined);
  assert.equal(r.bin(0.2, 1), undefined);
});
test('line, area, triangle and quad rasterisation counts each primitive once per covered bin', async () => {
  const t = new ColumnarTable({
    x: Float64Array.of(0.1),
    y: Float64Array.of(0.1),
    x1: Float64Array.of(1.9),
    y1: Float64Array.of(0.1),
    x2: Float64Array.of(1.9),
    y2: Float64Array.of(1.9),
    x3: Float64Array.of(0.1),
    y3: Float64Array.of(1.9),
    v: Float64Array.of(7),
  });
  const columns = { x: 'x', y: 'y', x1: 'x1', y1: 'y1', x2: 'x2', y2: 'y2', x3: 'x3', y3: 'y3' };
  const line = await aggregateRaster(t, { ...options, columns, glyph: 'lines' });
  assert.deepEqual([...line.count], [1, 1, 0, 0]);
  const quad = await aggregateRaster(t, { ...options, columns, glyph: 'quads' });
  assert.deepEqual([...quad.count], [1, 1, 1, 1]);
  assert.deepEqual([...quad.sum], [7, 7, 7, 7]);
  const triangle = await aggregateRaster(t, { ...options, columns, glyph: 'triangles' });
  assert.ok(triangle.count.reduce((a, b) => a + b, 0) > 0);
  assert.ok(triangle.count.every((v) => v <= 1));
  const areaTable = new ColumnarTable({
    x: Float64Array.of(0.1),
    y: Float64Array.of(1.9),
    x1: Float64Array.of(1.9),
    y1: Float64Array.of(1.9),
    v: Float64Array.of(7),
  });
  const area = await aggregateRaster(areaTable, {
    ...options,
    columns: { x: 'x', y: 'y', x1: 'x1', y1: 'y1' },
    glyph: 'areas',
  });
  assert.deepEqual([...area.count], [1, 1, 1, 1]);
});

test('physical point bounds are classified before f32 projection rounds outside values onto the boundary', async () => {
  const t = new ColumnarTable({
    x: Float64Array.of(-Number.MIN_VALUE, 0, 2, 2 + 2 ** -51, 1 - 2 ** -53, 1, 1 + 2 ** -52),
    y: new Float64Array(7).fill(0.5),
    v: Float64Array.of(1, 2, 3, 4, 5, 6, 7),
  });
  const result = await aggregateRaster(t, options);
  assert.deepEqual([...result.count], [2, 3, 0, 0]);
  assert.deepEqual([...result.sum], [7, 16, 0, 0]);
});

test('finite extreme domains and shade ranges avoid overflowing their normalization spans', async () => {
  const t = new ColumnarTable({
    x: Float64Array.of(-Number.MAX_VALUE, Number.MAX_VALUE),
    y: Float64Array.of(0, 0),
    v: Float64Array.of(-Number.MAX_VALUE, Number.MAX_VALUE),
  });
  const result = await aggregateRaster(t, {
    ...options,
    bounds: [-Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE],
  });
  assert.equal(result.at(Number.MAX_VALUE, 0).count, 1);
  const pixels = shadeAggregate(result, {
    reduction: 'min',
    transform: 'linear',
    range: [-Number.MAX_VALUE, Number.MAX_VALUE],
  });
  assert.notEqual(pixels[2], pixels[3]);
  assert.ok(pixels[2] && pixels[3]);
});
test('crossfilter mask, zoom and pan recompute from original rows; colour/spread leave statistics unchanged', async () => {
  const t = table([1, 2, 3]);
  using filter = new CrossFilter(t);
  using dimension = filter.dimension('v');
  dimension.filterRange(2, 4);
  const r = await aggregateRaster(filter, options);
  assert.equal(r.count[0], 2);
  assert.equal(r.firstRow[0], 1);
  const absent = await aggregateRaster(filter, { ...options, bounds: [1, 3, 1, 3] });
  assert.equal(
    absent.count.reduce((a, b) => a + b, 0),
    0,
  );
  for (const transform of ['linear', 'log', 'cbrt', 'eq-hist']) {
    const pixels = shadeAggregate(r, { transform, spread: 1 });
    assert.ok(pixels.filter(Boolean).length > 1);
    assert.equal(r.count[0], 2);
    assert.equal(r.sum[0], 5);
  }
});
test('invalid inputs and cancellation reject with coded errors and the exact abort reason', async () => {
  for (const extra of [{ width: 0 }, { chunkRows: 65537 }, { glyph: 'invalid' }, { bounds: [0, 0, 0, 1] }])
    await assert.rejects(aggregateRaster(table([1]), { ...options, ...extra }), (error) => !!error.code);
  const controller = new AbortController(),
    reason = new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(
    aggregateRaster(table([1]), { ...options, signal: controller.signal }),
    (error) => error === reason,
  );
  const r = await aggregateRaster(table([1]), options);
  assert.throws(() => shadeAggregate(r, { spread: -1 }));
  assert.throws(() => shadeAggregate(r, { category: 'missing' }));
});

test('a CPU compute context selects the exact reference without compiling WGSL', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  const actual = await aggregateRaster(table([1e16, 1, -1e16]), { ...options, gpu });
  assert.equal(actual.sum[0], 1);
  assert.equal(actual.work.dispatches, 0);
});

test('original TLC and GBIF observations retain source hashes, coordinates, licences and attribution keys', () => {
  const folder = new URL('fixtures/aggregate/', import.meta.url),
    manifest = JSON.parse(readFileSync(new URL('manifest.json', folder)));
  for (const source of manifest.sources) {
    const bytes = readFileSync(new URL(source.file, folder));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
    const rows = JSON.parse(bytes);
    assert.equal(rows.length, source.rows);
    if (source.file.startsWith('gbif'))
      for (const row of rows) {
        assert.ok(Number.isFinite(row.decimalLatitude) && Number.isFinite(row.decimalLongitude));
        assert.ok(row.datasetKey && row.publishingOrgKey);
        assert.match(row.license, source.file.includes('CC0') ? /publicdomain\/zero\/1\.0/ : /licenses\/by\/4\.0/);
      }
  }
});
