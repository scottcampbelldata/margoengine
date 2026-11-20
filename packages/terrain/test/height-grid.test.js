// A stored height grid as a height function (GAP-FILM-GRIDHEIGHT): bilinear between texels, the grid's real ground size,
// the edge held outside the box, no-data (NaN or a GDAL value) filled, point and area registration, and the result
// feeding `heightfieldGeometry` as its height function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridHeightField } from '@margoengine/terrain/height-grid';
import { heightfieldGeometry } from '@margoengine/terrain';

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);
const pyramid = { width: 3, height: 3, heights: [0, 1, 0, 1, 2, 1, 0, 1, 0], size: [200, 100] };

test('texels sit at their own corners and the box is the grid size', () => {
  const g = gridHeightField(pyramid);
  near(g(0, 0), 2);
  near(g(-100, -50), 0);
  near(g(100, 50), 0);
  near(g(0, -50), 1);
  near(g(-100, 0), 1);
  assert.deepEqual([...g.origin], [-100, -50]);
  assert.deepEqual([...g.size], [200, 100]);
  assert.equal(g.min, 0);
  assert.equal(g.max, 2);
});

test('heights are bilinear between texels over the real ground size', () => {
  const g = gridHeightField({ width: 2, height: 2, heights: [0, 4, 8, 12], size: [10, 20], origin: [100, 200] });
  near(g(100, 200), 0);
  near(g(110, 200), 4);
  near(g(100, 220), 8);
  near(g(110, 220), 12);
  near(g(105, 210), 6);
  near(g(102.5, 200), 1);
  near(g(100, 205), 2);
});

test('row 0 is the minimum z, and flipRows reads it at the maximum z', () => {
  const rows = { width: 2, height: 2, heights: [1, 1, 9, 9], size: [2, 2] };
  near(gridHeightField(rows)(0, -1), 1);
  near(gridHeightField(rows)(0, 1), 9);
  near(gridHeightField({ ...rows, flipRows: true })(0, -1), 9);
  near(gridHeightField({ ...rows, flipRows: true })(0, 1), 1);
});

test('outside the box the edge heights hold', () => {
  const g = gridHeightField(pyramid);
  near(g(-5000, -5000), 0);
  near(g(5000, 0), 1);
  near(g(0, -9999), 1);
  near(g(1e9, 1e9), 0);
});

test('exaggeration scales the samples and base lifts them', () => {
  const g = gridHeightField({ ...pyramid, exaggeration: 3, base: 10 });
  near(g(0, 0), 16);
  near(g(-100, -50), 10);
  assert.equal(g.min, 10);
  assert.equal(g.max, 16);
});

test('area registration puts samples at cell centres and holds the edge half a cell out', () => {
  const g = gridHeightField({ width: 2, height: 2, heights: [0, 10, 0, 10], size: [10, 10], registration: 'area' });
  near(g(-5, 0), 0);
  near(g(-2.5, 0), 0);
  near(g(2.5, 0), 10);
  near(g(0, 0), 5);
  near(g(5, 0), 10);
  const point = gridHeightField({ width: 2, height: 2, heights: [0, 10, 0, 10], size: [10, 10] });
  near(point(-2.5, 0), 2.5);
});

test('NaN and the GDAL no-data value are filled from the nearest valid texel', () => {
  const heights = new Float32Array([5, -32768, 7, -32768, -32768, -32768, 9, -32768, 11]);
  const g = gridHeightField({ width: 3, height: 3, heights, size: [2, 2], noData: -32768 });
  assert.equal(g.filled, 5);
  near(g(-1, -1), 5);
  near(g(0, -1), 5); // the tie between 5 (left) and 7 (right) goes to the one met first
  near(g(-1, 0), 5);
  near(g(0, 0), 5);
  near(g(1, 0), 7);
  near(g(0, 1), 9);
  near(g(1, 1), 11);
  const withNaN = gridHeightField({ width: 2, height: 2, heights: [NaN, 2, 3, 4], size: [1, 1] });
  assert.equal(withNaN.filled, 1);
  near(withNaN(-0.5, -0.5), 2);
});

test('a no-data value equal to a float32 value is matched in float32', () => {
  const g = gridHeightField({ width: 2, height: 2, heights: [Math.fround(-999999.9), 1, 2, 3], size: [1, 1], noData: -999999.9 });
  assert.equal(g.filled, 1);
  assert.ok(g.min >= 1);
});

test('fill takes a number, the minimum or the mean of the valid heights', () => {
  const heights = [2, NaN, 4, 6];
  const make = (fill) => gridHeightField({ width: 2, height: 2, heights, size: [1, 1], fill });
  near(make(-50)(0.5, -0.5), -50);
  near(make('min')(0.5, -0.5), 2);
  near(make('mean')(0.5, -0.5), 4);
  assert.equal(make('mean').min, 2);
  near(gridHeightField({ width: 2, height: 2, heights: [NaN, NaN, NaN, NaN], size: [1, 1], fill: 7 })(0, 0), 7);
});

test('a grid with no valid sample needs a numeric fill', () => {
  assert.throws(() => gridHeightField({ width: 2, height: 2, heights: [NaN, NaN, NaN, NaN], size: [1, 1] }), RangeError);
  assert.throws(
    () => gridHeightField({ width: 2, height: 2, heights: [1, 1, 1, 1], size: [1, 1], noData: 1, fill: 'mean' }),
    RangeError,
  );
});

test('the grid is copied: changing the source array afterwards changes nothing', () => {
  const heights = new Float32Array([0, 1, 2, 3]),
    g = gridHeightField({ width: 2, height: 2, heights, size: [1, 1] });
  heights.fill(99);
  near(g(0, 0), 1.5);
});

test('invalid options throw RangeError', () => {
  const ok = { width: 2, height: 2, heights: [0, 0, 0, 0], size: [1, 1] };
  for (const bad of [
    { width: 1 },
    { width: 2.5 },
    { height: 70000 },
    { heights: [0, 0, 0] },
    { size: [0, 1] },
    { size: [1, 200000] },
    { size: [1] },
    { origin: [NaN, 0] },
    { base: Infinity },
    { exaggeration: NaN },
    { registration: 'edge' },
    { fill: 'median' },
    { fill: NaN },
    { heights: [0, Infinity, 0, 0] },
    { noData: 'x' },
  ])
    assert.throws(() => gridHeightField({ ...ok, ...bad }), RangeError, JSON.stringify(bad));
});

test('the result is a height function for heightfieldGeometry, at the grid size', () => {
  const g = gridHeightField({ width: 2, height: 2, heights: [0, 0, 10, 10], size: [100, 100] }),
    mesh = heightfieldGeometry(g, { size: [100, 100], resolution: 4 });
  const ys = [];
  for (let i = 0; i < mesh.positions.length; i += 3) ys.push([mesh.positions[i + 2], mesh.positions[i + 1]]);
  for (const [z, y] of ys) near(y, ((z + 50) / 100) * 10);
});
