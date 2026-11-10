import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { TimeSeries, downsampleSeries, openSeriesSource, readSeries, seriesSpectrum, seriesSpectrogram } from '../dist/series.js';
import { readArrow, readParquet } from '../dist/table.js';
import { createCompute } from '../../compute/dist/index.js';
const fixture = async (path) => new Uint8Array(await readFile(new URL(`fixtures/${path}`, import.meta.url)));
const memory = (bytes) => ({ size: bytes.length, read: async (at, n, signal) => { signal?.throwIfAborted(); return bytes.slice(at, at + n); } });
const values = (chunks, name) => chunks.flatMap(({ table }) => Array.from({ length: table.length }, (_, i) => table.value(name, i)));
const collect = async (iterator) => { const out = []; for await (const part of iterator) out.push(part); return out; };

test('Range requests validate bounds, immutable version, truncation, status and cancellation', async (t) => {
  const bytes = new TextEncoder().encode('time,value\n0,2\n1,3\n2,5\n'), requests = []; let mode = 'good';
  const server = createServer((req, res) => {
    requests.push({ range: req.headers.range, validator: req.headers['if-range'] });
    const [a, b] = req.headers.range.match(/\d+/g).map(Number), body = bytes.subarray(a, b + 1);
    res.writeHead(mode === 'ignored' ? 200 : 206, { 'Content-Range': `bytes ${mode === 'bounds' ? a + 1 : a}-${b}/${bytes.length}`, ETag: mode === 'changed' ? '"v2"' : '"v1"' });
    res.end(mode === 'short' ? body.subarray(0, -1) : body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/file.csv`, source = await openSeriesSource(url);
  assert.equal(source.size, bytes.length); assert.deepEqual(await source.read(1, 4), bytes.slice(1, 5)); assert.equal(requests[1].validator, '"v1"');
  assert.deepEqual(await source.read(0, 0), new Uint8Array());
  await assert.rejects(source.read(-1, 2)); await assert.rejects(source.read(1, bytes.length));
  await assert.rejects(source.read(0, 2, AbortSignal.abort()));
  for (mode of ['bounds', 'ignored', 'short', 'changed']) await assert.rejects(source.read(0, 4), undefined, mode);
});

test('CSV complete records survive every byte boundary, embedded CRLF/quotes, UTF-8, and early return', async () => {
  const text = 'time,value,label\r\n0,1,"a\r\nb""c"\r\n1,,?\r\n2,-3,last';
  const bytes = new TextEncoder().encode(text);
  for (let chunkBytes = 1; chunkBytes <= bytes.length; chunkBytes++) {
    const chunks = await collect(readSeries(memory(bytes), { chunkBytes, types: { time: 'number', value: 'number', label: 'string' } }));
    assert.deepEqual(values(chunks, 'time'), [0, 1, 2]); assert.deepEqual(values(chunks, 'value'), [1, null, -3]);
    assert.deepEqual(values(chunks, 'label'), ['a\r\nb"c', '?', 'last']);
    let rows = 0; for (const chunk of chunks) { assert.equal(chunk.rowOffset, rows); rows += chunk.table.length; }
  }
  let requests = 0; const early = new TextEncoder().encode(text + '\n3,4,a'.repeat(100)), source = memory(early), read = source.read;
  source.read = (...args) => { requests++; return read(...args); };
  const iterator = readSeries(source, { chunkBytes: 30 }); await iterator.next(); const before = requests; await iterator.return(); assert.equal(requests, before); assert.ok(requests*30 < early.length);
  await assert.rejects(collect(readSeries(memory(bytes), { maxRows: 1, chunkBytes: 30 })));
  await assert.rejects(collect(readSeries(memory(new TextEncoder().encode('x\n"bad')), { chunkBytes: 1 })));
  await assert.rejects(collect(readSeries(memory(bytes), { signal: AbortSignal.abort() })));
});

test('Range Arrow batches and Parquet groups match owner-writer scalars, nulls, units and compression', async () => {
  for (const format of ['arrow', 'parquet']) {
    const names = (await readdir(new URL('fixtures/table/', import.meta.url))).filter((n) => n.endsWith(`.${format}`) && !n.startsWith('tlc'));
    for (const name of names) {
      const bytes = await fixture(`table/${name}`), whole = await (format === 'arrow' ? readArrow : readParquet)(bytes), chunks = await collect(readSeries(memory(bytes), { format, chunkBytes: 37 }));
      for (const key of Object.keys(whole.columns)) {
        assert.deepEqual(values(chunks, key), Array.from({ length: whole.length }, (_, i) => whole.value(key, i)), `${name}:${key}`);
        for (const chunk of chunks) assert.equal(chunk.table.column(key).unit, whole.column(key).unit);
      }
    }
  }
});

test('real GW150914 CSV, Arrow and Parquet yield before whole input, retain hashes and original binary64 samples', async () => {
  const meta = JSON.parse(new TextDecoder().decode(await fixture('series/source.json')));
  assert.equal(createHash('sha256').update(await fixture('series/gw150914.csv')).digest('hex'), meta.csvSHA256);
  const tables = [];
  for (const format of ['csv', 'arrow', 'parquet']) {
    const bytes = await fixture(`series/gw150914.${format}`), calls = [], source = memory(bytes), read = source.read;
    source.read = (at, n, signal) => { calls.push([at, n]); return read(at, n, signal); };
    const iterator = readSeries(source, { format, chunkBytes: 4096 }), first = await iterator.next();
    assert.ok(!first.done && first.value.table.length < meta.rows); assert.ok(calls.reduce((n, c) => n + c[1], 0) < bytes.length);
    const chunks = [first.value]; for await (const chunk of iterator) chunks.push(chunk);
    tables.push({ x: values(chunks, 'time'), y: values(chunks, 'strain') }); assert.equal(tables.at(-1).x.length, meta.rows);
    assert.ok(calls.every(([, n]) => n <= 4096));
  }
  assert.deepEqual(tables[0], tables[1]); assert.deepEqual(tables[1], tables[2]);
  const series = new TimeSeries(tables[0]), sampled = downsampleSeries(series, { width: 320 });
  assert.ok(sampled.length <= 1282 && sampled.length < series.length / 10);
  const selected = series.select((x) => x >= -0.05 && x <= 0.05);
  assert.equal(selected.length, tables[0].x.filter((x) => x >= -0.05 && x <= 0.05).length);
});

test('M4 and min-max preserve ordered pixel extrema, edge neighbours, duplicate times and discontinuities', () => {
  const x = Float64Array.from({ length: 10003 }, (_, i) => i / 10), y = Float64Array.from(x, (t, i) => Math.sin(t) + (i % 19 === 0 ? 20 : -i % 7));
  const series = new TimeSeries({ x, y });
  for (const method of ['m4', 'min-max', 'lttb']) {
    const rows = downsampleSeries(series, { width: 100, method }), set = new Set(rows);
    assert.equal(rows[0], 0); assert.equal(rows.at(-1), x.length - 1);
    for (let col = 0; col < 100; col++) {
      const ids = Array.from(x.keys()).filter((i) => Math.min(99, Math.floor(x[i] / x.at(-1) * 100)) === col);
      const min = ids.reduce((a, b) => y[b] < y[a] ? b : a), max = ids.reduce((a, b) => y[b] > y[a] ? b : a);
      assert.ok(set.has(min) && set.has(max), `${method} extrema ${col}`);
      if (method === 'm4') assert.ok(set.has(ids[0]) && set.has(ids.at(-1)));
    }
  }
  assert.deepEqual([...downsampleSeries(new TimeSeries({ x: [0,1,2,3,4,5,6,7,8,9], y: [0,7,1,-2,5,0,8,1,-4,0] }), { width: 5, method: 'lttb', preserveExtremes: false })], [0,1,3,6,9]);
  const gap = new TimeSeries({ x: [0, 1, 1, 2, 3, 4], y: [1, 5, NaN, -5, 2, 1] });
  const rows = downsampleSeries(gap, { width: 1, domain: [1, 3] }); assert.ok(rows.includes(2) && rows.includes(0) && rows.includes(5));
  const before = gap.length; assert.throws(() => gap.append({ x: [5, 3], y: [1, 2] })); assert.equal(gap.length, before);
  assert.throws(() => downsampleSeries(gap, { width: 0 })); assert.throws(() => downsampleSeries(gap, { width: 3, signal: AbortSignal.abort() }));
  const block = { x: [1, 2], y: [5, 6] }, owned = new TimeSeries(block); block.y[0] = 99; assert.equal(owned.y(0), 5);
});

// Independent aliased raster: quantize x into display columns, then enumerate each integer y along the segment.
const raster = (x, y, ids) => {
  const pixels = new Set();
  for (let j = 1; j < ids.length; j++) {
    const a = ids[j-1], b = ids[j], x0 = Math.floor(x[a]), x1 = Math.floor(x[b]), y0 = Math.round(y[a]), y1 = Math.round(y[b]);
    const steps = Math.max(Math.abs(x1-x0), Math.abs(y1-y0), 1);
    for (let k=0; k<=steps; k++) pixels.add(`${Math.round(x0+(x1-x0)*k/steps)},${Math.round(y0+(y1-y0)*k/steps)}`);
  }
  return [...pixels].sort();
};
test('M4 matches the complete aliased pixel-column raster on dense and sparse integer-column lines', () => {
  for (const stride of [0.02, 0.1, 1, 3]) {
    const x = Array.from({ length: 2000 }, (_, i) => i*stride), y = x.map((v,i) => Math.round(30*Math.sin(v/3)+(i*37%23)));
    const series = new TimeSeries({ x, y }), ids = downsampleSeries(series, { width: Math.floor(x.at(-1))+1, domain: [0, Math.floor(x.at(-1))+1] });
    assert.deepEqual(raster(x, y, ids), raster(x, y, [...x.keys()]));
  }
});

test('viewport neighbours keep their own columns, preserving the entering line pixel coverage', () => {
  const x = [-10,0.01,0.1,0.2,1,2,10], y = [0,1,2,3,1,2,3], series = new TimeSeries({x,y});
  const ids = downsampleSeries(series,{width:2,domain:[0,2]});
  const clip = (pixels) => pixels.filter((p)=>Number(p.split(',')[0])>=0 && Number(p.split(',')[0])<2);
  assert.deepEqual(clip(raster(x,y,ids)),clip(raster(x,y,[...x.keys()])));
});

test('pixel mapping handles subnormal spans and overflowing finite endpoint differences', () => {
  for (const x of [[0,Number.MIN_VALUE,2*Number.MIN_VALUE],[-1e308,0,1e308]]) {
    const s = new TimeSeries({x,y:[0,10,0]});
    for (const method of ['m4','min-max','lttb']) assert.deepEqual([...downsampleSeries(s,{width:3,method})],[0,1,2]);
  }
});

test('spectra preserve tiny physical units, one-sided PSD, Nyquist, odd lengths and STFT orientation', async () => {
  using gpu = await createCompute({ backend: 'cpu' });
  for (const n of [63, 64]) {
    const amplitude = 1e-21, signal = Float64Array.from({ length: n }, (_, i) => amplitude*Math.cos(2*Math.PI*5*i/n)), spectrum = await seriesSpectrum(gpu, signal, n, { window: 'rectangular', detrend: false });
    assert.equal(spectrum.frequency[5], 5); assert.ok(Math.abs(spectrum.real[5]/(n*amplitude/2)-1) < 2e-5);
    assert.ok(Math.abs(spectrum.power.reduce((a,b)=>a+b,0)/(amplitude*amplitude/2)-1) < 3e-5);
    assert.ok(spectrum.power[5] > 0);
  }
  const input = Float64Array.from({ length: 128 }, (_, i) => Math.cos(2*Math.PI*8*i/64));
  const stft = await seriesSpectrogram(gpu, input, 64, { windowSize: 64, hopSize: 32, window: 'rectangular', startTime: 10 });
  assert.deepEqual([...stft.times], [10.5, 11, 11.5]); assert.equal(stft.power.length, 3*33);
  for (let frame=0; frame<3; frame++) assert.ok(stft.power[8*3+frame] > 0.49);
  await assert.rejects(seriesSpectrum(gpu, [1,NaN], 64)); await assert.rejects(seriesSpectrum(gpu, [1,2], 0));
  await assert.rejects(seriesSpectrogram(gpu, input, 64, { maxBytes: 1 }));
  await assert.rejects(seriesSpectrum(gpu, input, 64, { signal: AbortSignal.abort() }));
});
