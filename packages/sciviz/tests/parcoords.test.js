import assert from 'node:assert/strict';
import test from 'node:test';
import { ColumnarTable } from '../dist/table.js';
import { SelectionStore } from '../dist/link.js';
import { MultivariateData, parallelDensity } from '../dist/parcoords.js';

test('multivariate columns share domains and preserve missing, logarithmic and categorical values', () => {
  const table = new ColumnarTable({ x: Float64Array.of(1, 10, 100), y: { values: Uint32Array.of(1, 0, 1), categories: ['a', 'b'] }, z: { values: Float64Array.of(7, 9, 11), validity: Uint8Array.of(5) } });
  const data = new MultivariateData(table, { axes: [{ column: 'x', scale: 'log' }, 'y', 'z'] });
  assert.deepEqual(data.domains, [[1, 100], [0, 1], [7, 11]]); assert.equal(data.at(0, 1), 0.5); assert.equal(data.at(1, 0), 1); assert.ok(Number.isNaN(data.at(2, 1)));
  data.order[1] = 1; assert.equal(data.at(0, 0), 1); assert.equal(data.at(0, 2), 0); assert.ok(Math.abs(data.physical(0, 0.5) - 10) < 1e-12);
  const cropped = new MultivariateData(table, { axes: [{ column: 'x', domain: [10, 100] }, 'y'] }); assert.ok(Number.isNaN(cropped.at(0, 0))); assert.equal(cropped.at(0, 1), 0);
});
test('constant and empty numeric/log axes have finite increasing defaults', () => {
  for (const value of [0, 7, Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE]) {
    const table = new ColumnarTable({ x: Float64Array.of(value), y: Float64Array.of(value) });
    const data = new MultivariateData(table, { axes: ['x', 'y'] });
    assert.ok(data.domains.every(([lo, hi]) => Number.isFinite(lo) && Number.isFinite(hi) && hi > lo));
    assert.ok(data.values.every(Number.isFinite));
    if (value > 0) assert.ok(new MultivariateData(table, { axes: [{ column: 'x', scale: 'log' }, 'y'] }).values.every(Number.isFinite));
  }
  const empty = new MultivariateData(new ColumnarTable({ x: new Float32Array(), y: new Float32Array() }), { axes: [{ column: 'x', scale: 'log' }, 'y'] }); assert.deepEqual(empty.domains, [[1, 10], [0, 1]]);
  const extreme = new MultivariateData(new ColumnarTable({ x: Float64Array.of(-Number.MAX_VALUE, 0, Number.MAX_VALUE), y: Float64Array.of(0, 1, 2) }), { axes: ['x', 'y'] });
  assert.deepEqual([...extreme.values.subarray(0, 3)], [0, 0.5, 1]); assert.equal(extreme.physical(0, 0.5), 0); assert.equal(extreme.physical(0, 1), Number.MAX_VALUE);
});
test('axis/domain/row-key validation rejects malformed input before a GPU allocation', () => {
  const table = new ColumnarTable({ x: Float32Array.of(1, 2), y: Float32Array.of(3, 4) });
  for (const axes of [['x'], ['x', 'x'], ['x', 'no'], [{ column: 'x', domain: [1, 1] }, 'y'], [{ column: 'x', scale: 'log', domain: [0, 1] }, 'y']]) assert.throws(() => new MultivariateData(table, { axes }));
  assert.throws(() => new MultivariateData(table, { axes: ['x', 'y'], rowIds: ['a'] }));
  assert.throws(() => new MultivariateData(table, { axes: ['x', 'y'], signal: AbortSignal.abort() }));
});
test('pixel density counts every row once per column, exact crossings, flips, null segments and keyed selection', async () => {
  const table = new ColumnarTable({ a: Float32Array.of(0, 1), b: Float32Array.of(1, 0), c: Float32Array.of(0, 1) });
  const data = new MultivariateData(table, { axes: ['a', 'b', 'c'], rowIds: ['one', 'two'] }); using store = new SelectionStore(data.rowIds);
  const counts = await parallelDensity(data, store, { width: 5, height: 5 });
  for (let x = 0; x < 5; x++) assert.equal(Array.from({ length: 5 }, (_, y) => counts[y * 5 + x]).reduce((a, b) => a + b, 0), 2);
  assert.equal(counts[2 * 5 + 1], 2); assert.equal(counts[2 * 5 + 3], 2);
  store.select(['one']); const selected = await parallelDensity(data, store, { width: 5, height: 5 }); assert.equal(selected.reduce((a, b) => a + b, 0), 5);
  data.order[3] = 1; const flipped = await parallelDensity(data, store, { width: 5, height: 5 }); assert.deepEqual([...flipped.subarray(0, 5)], [1, 1, 1, 1, 1]);
  const missing = new MultivariateData(new ColumnarTable({ a: Float32Array.of(NaN), b: Float32Array.of(1), c: Float32Array.of(1) }), { axes: ['a', 'b', 'c'] }); using one = new SelectionStore(missing.rowIds);
  const partial = await parallelDensity(missing, one, { width: 5, height: 5 }); assert.equal(partial.reduce((a, b) => a + b, 0), 3);
  await assert.rejects(parallelDensity(data, store, { width: 2, height: 5 })); await assert.rejects(parallelDensity(data, store, { signal: AbortSignal.abort() }));
});
