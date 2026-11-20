import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { ColumnarTable, CrossFilter, readCSV, readArrow, readParquet, aggregateTable } from '../dist/table.js';

import { allNullParquet, annotatedParquet, defaultUnitStream } from './table-writers.js';
const fixture = async (name) => new Uint8Array(await readFile(new URL(`fixtures/table/${name}`, import.meta.url)));
const expected = {
  i: [1, null, -3, 2147483647, 0], wide: [9007199254740993n, -7n, null, 2n ** 62n, 0n], u: [2n ** 64n - 1n, 0n, 3n, null, 7n],
  f: [1.25, -2.5, 0, null, 8.75], s: ['alpha', 'alpha', null, 'beta\n"x', 'λ'], b: [1, 0, null, 1, 0], time: [0n, 1n, 1000000n, null, -1n],
};
const check = (table, reference = expected) => {
  for (const name of Object.keys(table.columns)) assert.deepEqual(Array.from({ length: table.length }, (_, i) => table.value(name, i)), reference[name], name);
};
test('Arrow reference-writer files/streams, compression, dictionaries, multi-batch and nulls', async () => {
  for (const name of await readdir(new URL('fixtures/table/', import.meta.url))) if (name.endsWith('.arrow') && !name.startsWith('tlc')) {
    const table = await readArrow(await fixture(name)); check(table); assert.equal(table.column('time').unit, 'timestamp:us:UTC');
  }
});
test('Parquet reference-writer v1/v2, six codecs, checksums and all modern scalar encodings', async () => {
  for (const name of await readdir(new URL('fixtures/table/', import.meta.url))) if (name.endsWith('.parquet') && !name.startsWith('tlc')) check(await readParquet(await fixture(name)));
});
test('real TLC data match the independent PyArrow reference in both formats', async () => {
  const reference = JSON.parse(new TextDecoder().decode(await fixture('tlc-reference.json')));
  for (const [name, reader] of [['tlc-trips.arrow', readArrow], ['tlc-trips.parquet', readParquet]]) {
    const table = await reader(await fixture(name)); assert.equal(table.length, 4096); check(table, { ...reference, payment_type: reference.payment_type.map((v) => v === null ? null : BigInt(v)) });
    const projected = await reader(await fixture(name), { columns: ['fare_amount'] }); assert.deepEqual(Object.keys(projected.columns), ['fare_amount']);
  }
});
test('CSV quoted newlines/quotes, UTF-8, nulls, strict schema, int64 and projection', () => {
  const t = readCSV('\uFEFFid,label,fare\r\n9007199254740993,"a\r\nb""c",1.5\r\n2,λ,\r\n');
  assert.equal(t.value('id', 0), 9007199254740993n); assert.equal(t.value('label', 0), 'a\r\nb"c'); assert.equal(t.value('fare', 1), null);
  assert.deepEqual(Object.keys(readCSV('x,y\n1,2', { columns: ['x'] }).columns), ['x']);
  assert.equal(readCSV('x\ntrue', { types: { x: 'boolean' } }).value('x', 0), 1);
  for (const source of ['x,x\n1,2', 'x\n"a', 'x\n"a"z', 'x,y\n1', 'x\na"b']) assert.throws(() => readCSV(source));
  assert.throws(() => readCSV('x\na', { types: { x: 'number' } }));
  assert.throws(() => readCSV('x\n1', { columns: ['missing'] }));
});
test('CSV skips blank lines and reads nan/inf cells as numbers, like pandas read_csv defaults', () => {
  // pandas skip_blank_lines=True: empty and whitespace-only lines are not rows, before or after the header.
  const blank = readCSV('\n  \r\nx,y\n1,2\n\n \t\n3,4\n\n');
  assert.equal(blank.length, 2); assert.equal(blank.value('x', 1), 3); assert.equal(blank.value('y', 1), 4);
  // A quoted empty field is data, not a blank line.
  assert.equal(readCSV('x\n""\n1').length, 2);
  // numpy.savetxt and pandas.to_csv write nan and inf; pandas reads them as float NaN and +-Infinity.
  const special = readCSV('x,y\n1,a\nnan,b\nNaN,c\n-nan,d\ninf,e\n-inf,f\nInfinity,g\n+Infinity,h\n-INF,i\n2,j');
  const x = [...Array(special.length).keys()].map((i) => special.value('x', i));
  assert.deepEqual(x, [1, NaN, NaN, NaN, Infinity, -Infinity, Infinity, Infinity, -Infinity, 2]);
  assert.equal(readCSV('x\nnan', { types: { x: 'number' } }).value('x', 0), NaN);
  assert.equal(readCSV('x\nNan\n1').value('x', 0), 'Nan');
  assert.throws(() => readCSV('x\ninfinite', { types: { x: 'number' } }));
});
test('Arrow Time and Duration columns read the schema default unit (milliseconds) when the writer omits it', async () => {
  const t = await readArrow(defaultUnitStream());
  assert.equal(t.column('t').unit, 'time:ms'); assert.equal(t.value('t', 0), 1500);
  assert.equal(t.column('d').unit, 'duration:ms'); assert.equal(t.value('d', 0), 2500n);
});
test('Parquet all-null pages read whether the writer leaves the payload empty or writes the encoding header', async () => {
  const t = await readParquet(allNullParquet());
  assert.equal(t.length, 3); for (const name of ['a', 'b']) for (let i = 0; i < 3; i++) assert.equal(t.value(name, i), null);
  // An RLE run longer than the page's values is malformed, not extra rows.
  await assert.rejects(readParquet(allNullParquet(4)), /RLE run exceeds/);
});
test('Parquet FLOAT16 reads as half floats, JSON and ENUM as UTF-8 text and UUID as its 8-4-4-4-12 form', async () => {
  const t = await readParquet(annotatedParquet()), column = (name) => Array.from({ length: t.length }, (_, i) => t.value(name, i));
  assert.deepEqual(column('h'), [1, -2, 65504, 2 ** -24, -0, Infinity, NaN]);
  assert.ok(Object.is(column('h')[4], -0));
  assert.equal(t.column('h').unit, undefined);
  assert.deepEqual(column('j'), ['{"a":1}', '[1,2]', 'null', '"λ"', '{}', '0', 'true']);
  assert.deepEqual(column('e'), ['red', 'green', 'red', 'blue', 'red', 'green', 'red']);
  assert.deepEqual(column('jc'), ['{"b":2}', '[]', '1', '2', '3', '4', '5']);
  assert.deepEqual(column('ec'), ['x', 'y', 'x', 'y', 'x', 'y', 'x']);
  for (const name of ['j', 'e', 'jc', 'ec']) assert.equal(t.column(name).unit, undefined, name);
  assert.deepEqual(column('u'), Array.from({ length: 7 }, (_, i) => `00112233-4455-6677-8899-aabbccddee0${i}`));
  assert.equal(t.column('u').unit, 'uuid');
  await assert.rejects(readParquet(annotatedParquet(15)), /UUID column must be a FIXED_LEN_BYTE_ARRAY\(16\)/);
});
test('aggregation bins follow the drawn edges lo + i w, also on rounded edges and ranges past the largest double', async () => {
  const edge = await aggregateTable(new ColumnarTable({ x: Float64Array.of(0.175, 0.325, 0.1, 0.7) }), { x: { column: 'x', bins: 8, range: [0.1, 0.7] } });
  assert.deepEqual([...edge.count], [1, 1, 0, 1, 0, 0, 0, 1]);
  const wide = await aggregateTable(new ColumnarTable({ x: Float64Array.of(-1e308, -5e307, 1, 9e307, 1e308) }), { x: { column: 'x', bins: 4, range: [-1e308, 1e308] } });
  assert.deepEqual([...wide.count], [1, 1, 1, 2]);
});
test('the GPU aggregation kernel keeps no per-bin arrays, so 4096 bins stay inside WGSL function-variable limits', async () => {
  const sources = [];
  const gpu = {
    kernel: (src) => { sources.push(src); return { run() {}, dispose() {} }; },
    array: () => ({ [Symbol.dispose]() {} }),
    zeros: (n) => ({ read: async () => new Float32Array(n), [Symbol.dispose]() {} }),
  };
  const table = new ColumnarTable({ x: Float64Array.of(0.5, 1.5) });
  for (const bins of [1, 4096]) await aggregateTable(table, { x: { column: 'x', bins, range: [0, 4096] }, gpu });
  assert.equal(sources.length, 2); assert.equal(sources[0], sources[1]);
  // WGSL 2.4 Limits: function and private variables of a shader may total only 8192 bytes.
  assert.doesNotMatch(sources[0], /var\s+\w+\s*:\s*array</);
});
test('readers reject malformed lengths, checksums, allocation limits and aborted work', async () => {
  for (const [name, reader] of [['file-none-plain.arrow', readArrow], ['scalars-snappy-1.0.parquet', readParquet]]) {
    const bytes = await fixture(name);
    await assert.rejects(reader(bytes, { maxRows: 1 })); await assert.rejects(reader(bytes, { maxBytes: 1 }));
    await assert.rejects(reader(bytes, { signal: AbortSignal.abort() }));
    for (const length of [0, 3, 17, Math.floor(bytes.length / 2)]) await assert.rejects(reader(bytes.subarray(0, length)));
    await assert.rejects(reader(bytes, { columns: ['missing'] }));
  }
  const corrupted = await fixture('scalars-snappy-1.0.parquet'); corrupted[12] ^= 8; await assert.rejects(readParquet(corrupted));
});
test('typed table subsets preserve nulls, dictionaries and 64-bit precision', () => {
  const t = readCSV('x,y\n9007199254740993,a\n,b\n2,a'); const subset = t.take([2, 0, 1]);
  assert.equal(subset.value('x', 1), 9007199254740993n); assert.equal(subset.value('x', 2), null); assert.equal(subset.value('y', 0), 'a');
  assert.throws(() => t.take([3])); assert.throws(() => new ColumnarTable({ x: new Float32Array(1), y: new Float32Array(2) }));
  const special = readCSV('__proto__,constructor,toString\n1,2,3');
  assert.equal(special.value('__proto__', 0), 1); assert.equal(special.take([0]).value('constructor', 0), 2); assert.equal(special.value('toString', 0), 3);
});
test('indexed range/set cross-filter agrees with exhaustive predicates through disjoint and overlapping moves', () => {
  const table = readCSV('x,c\n0,a\n1,b\n2,a\n3,c\n4,b\n,a\n6,c'); using filter = new CrossFilter(table);
  using x = filter.dimension('x'); using c = filter.dimension('c'); let changes = 0; filter.addEventListener('change', () => changes++);
  for (const [lo, hi] of [[0, 2], [1, 4], [4, 8], [0, 1], [2, 2]]) {
    x.filterRange(lo, hi); c.filterSet(['a', 'b']);
    assert.deepEqual([...filter.rows()], Array.from({ length: table.length }, (_, i) => i).filter((i) => table.value('x', i) !== null && table.value('x', i) >= lo && table.value('x', i) < hi && ['a', 'b'].includes(table.value('c', i))));
    assert.equal(filter.count, [...filter.rows()].length);
  }
  x.clear(); c.filterSet([null]); assert.equal(filter.count, 0); c.clear(); assert.equal(filter.count, table.length); assert.ok(changes > 0);
  assert.throws(() => x.filterRange(3, 1)); assert.throws(() => c.filterRange(0, 1));
});
test('a dimension disposed before or after its filter frees its rows and never throws', () => {
  const table = new ColumnarTable({ x: Float64Array.of(0, 1, 2, 3) }), filter = new CrossFilter(table), kept = filter.dimension('x'), late = filter.dimension('x');
  kept.filterRange(0, 2); late.filterRange(1, 4); assert.deepEqual([...filter.rows()], [1]);
  let changes = 0; filter.addEventListener('change', () => changes++);
  kept.dispose(); assert.deepEqual([...filter.rows()], [1, 2, 3]); assert.equal(filter.count, 3); assert.equal(changes, 1);
  kept.dispose(); assert.equal(changes, 1);
  filter.dispose(); late.dispose(); late[Symbol.dispose](); assert.equal(changes, 1);
  assert.throws(() => late.filterRange(0, 1)); assert.throws(() => filter.dimension('x'));
});
test('range and set updates visit only their changed index spans, retaining tail mask bits', () => {
  const table = new ColumnarTable({ x: Int32Array.from({ length: 100003 }, (_, i) => i) }); using f = new CrossFilter(table); using d = f.dimension('x');
  d.filterRange(100, 200); d.filterRange(101, 201); assert.equal(d.work.rowsVisited, 2); assert.ok(d.work.wordsCombined <= 2); assert.equal(f.count, 100);
  d.filterSet([4, 20]); d.filterSet([4, 30]); assert.equal(d.work.rowsVisited, 2); assert.deepEqual([...f.rows()], [4, 30]); d.clear(); assert.equal(f.count, 100003);
});
test('1D/2D aggregation includes final edge, omits invalid coordinates and separates null value counts', async () => {
  const t = readCSV('x,y,v\n0,0,1\n1,0,2\n2,1,-4\n3,1,\n4,2,8\n,1,4'); using f = new CrossFilter(t); using d = f.dimension('x');
  const options = { x: { column: 'x', bins: 2, range: [0, 4] }, value: 'v' };
  const a = await aggregateTable(f, options); assert.deepEqual([...a.count], [2, 3]); assert.deepEqual([...a.valid], [2, 2]); assert.deepEqual([...a.sum], [3, 4]); assert.deepEqual([...a.mean], [1.5, 2]); assert.deepEqual([...a.min], [1, -4]); assert.deepEqual([...a.max], [2, 8]);
  d.filterRange(1, 4); const b = await aggregateTable(f, { ...options, y: { column: 'y', bins: 2, range: [0, 2] } }); assert.deepEqual([...b.count], [1, 0, 0, 2]);
  await assert.rejects(aggregateTable(t, { ...options, signal: AbortSignal.abort() }));
});
test('CSV inference keeps an integer column past 64 bits as numbers instead of refusing it', () => {
  const t = readCSV('id,big\n9007199254740993,99999999999999999999\n2,-18446744073709551616\n');
  assert.equal(t.value('id', 0), 9007199254740993n);
  assert.equal(t.value('big', 0), 1e20);
  assert.equal(t.value('big', 1), -18446744073709551616);
});
