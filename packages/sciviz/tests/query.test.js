import test from 'node:test';
import assert from 'node:assert/strict';
import { QuerySelection } from '../dist/query.js';
import { ColumnarTable } from '../dist/table.js';
import { SelectionStore } from '../dist/link.js';

test('calculator query predicates, vector grammar, global reductions and f64 boundaries', () => {
  using q = new QuerySelection(new ColumnarTable({ speed: new Float64Array([0, 9, 9.000000001, 10]), x: new Float64Array([1, 2, 3, 4]) }));
  assert.deepEqual([...q.select('speed > 0.9 * max(speed)')], [2, 3]);
  assert.deepEqual([...q.matching('speed >= 9 && speed < 10 || x == 1')], [0, 1, 2]);
  assert.deepEqual([...q.matching('!(x != 2)')], [1]);
  assert.deepEqual([...q.matching('mag(vec(x,0,0)) >= mean(x) && dot(vec(1,2,3), iHat) == 1')], [2, 3]);
  assert.deepEqual([...q.matching('sum(x) == 10 && min(x) == 1 && max(x, 2) >= 2 && count(x) == 4')], [0, 1, 2, 3]);
  assert.deepEqual([...q.matching('x > 2.0000000001')], [2, 3]);
  const version = q.selection.version;
  for (const source of ['globalThis.alert(1)', 'x.constructor', 'x = 1', 'vec(x,x,x)', 'x;fetch(1)', 'max()', 'x >', '!'.repeat(65) + 'x']) assert.throws(() => q.select(source));
  assert.equal(q.selection.version, version);
});
test('missing/nonfinite values do not compare or enter reductions; int64 is never rounded', () => {
  using q = new QuerySelection(new ColumnarTable({ x: { values: new Float64Array([1, 900, NaN, Infinity, 5]), validity: new Uint8Array([29]) }, id: new BigInt64Array([1n, 2n, 3n, 4n, 9007199254740993n]) }));
  assert.deepEqual([...q.matching('x != 0')], [0, 4]);
  assert.deepEqual([...q.select('x >= mean(x)')], [4]);
  assert.equal(q.extract().value('id', 0), 9007199254740993n);
  assert.throws(() => q.matching('id > 0'));
  using empty = new QuerySelection(new ColumnarTable({ x: new Float64Array() }));
  assert.equal(empty.matching('x > max(x)').length, 0);
});
test('keyed shared selection, undo, copied extraction and sorted series preserve source identity', async () => {
  const table = new ColumnarTable({ time: new Float64Array([3, 1, 2]), value: { values: new Float64Array([30, 10, 20]), unit: 'C' }, label: { values: new Uint32Array([0, 1, 0]), categories: ['a', 'b'] } });
  using selection = new SelectionStore(['c', 'a', 'b']);
  using q = new QuerySelection(table, { selection, rowIds: ['c', 'a', 'b'] });
  q.select('value >= 20'); assert.deepEqual(selection.rowIds, ['c', 'b']);
  const series = q.series('time', 'value'); assert.deepEqual([...series.time], [2, 3]); assert.deepEqual([...series.values], [20, 30]); assert.deepEqual(series.rowIds, ['b', 'c']);
  const copy = q.extract(); assert.equal(copy.column('value').unit, 'C'); assert.equal(copy.value('label', 1), 'a'); copy.column('value').values[0] = 99; assert.equal(table.value('value', 0), 30);
  selection.undo(); assert.equal(q.rows().length, 3); selection.select(['a']); assert.deepEqual([...q.rows()], [1]);
  assert.equal(await q.plot({}, 'time', 'value'), null);
  q.dispose(); assert.throws(() => q.rows()); selection.clear(); assert.equal(selection.rowIds.length, 3);
  assert.throws(() => new QuerySelection(table, { rowIds: [1, 1, 2] }));
});
