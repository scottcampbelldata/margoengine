import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  temporalStatistics, interpolateTemporal, probeTemporal, plotTemporalProbe,
  groupFileSeries, parseFileSeries, fileSeriesSource, parseTimeUnits, convertTimeUnits, formatTemporalTime,
} from '../dist/temporal.js';
import { openNetCDF } from '../dist/netcdf.js';
const source = (frames, times = frames.map((_, i) => i)) => ({ times, read: (i) => frames[i] });
const near = (a, b, e = 1e-12) => assert.ok(Math.abs(a - b) <= e, `${a} versus ${b}`);

test('per-element temporal reductions use selected steps, population/sample deviation and one read per step', async () => {
  const reads = [], frames = [[1, 12], [3, 6], [5, -6], [7, 0]], times = [0, 1, 3, 20];
  const s = { times, read: (i) => { reads.push(i); return frames[i]; } };
  const result = await temporalStatistics(s);
  assert.deepEqual(reads, [0, 1, 2, 3]);
  assert.deepEqual([...result.mean], [4, 3]);
  assert.deepEqual([...result.minimum], [1, -6]);
  assert.deepEqual([...result.maximum], [7, 12]);
  assert.deepEqual([...result.count], [4, 4]);
  near(result.standardDeviation[0], Math.sqrt(5)); near(result.standardDeviation[1], Math.sqrt(45));
  const selected = await temporalStatistics(s, { start: 1, stop: 3, ddof: 1 });
  assert.deepEqual([...selected.mean], [4, 0]); near(selected.standardDeviation[0], Math.sqrt(2));
  assert.equal(selected.steps, 2); assert.deepEqual(frames[0], [1, 12]);
});
test('shifted accumulation preserves small variance on large offsets, constant fields and reusable reader buffers', async () => {
  const reuse = new Float64Array(2), s = { times: [0, 1, 2, 3], read(i) { reuse.set([1e15 + i, 7]); return reuse; } };
  const result = await temporalStatistics(s);
  assert.equal(result.mean[0], 1e15 + 1.5); near(result.standardDeviation[0], Math.sqrt(1.25));
  assert.equal(result.standardDeviation[1], 0);
  const single = await temporalStatistics(source([[5]]), { ddof: 1 }); assert.ok(Number.isNaN(single.standardDeviation[0]));
});
test('missing values are per element, with explicit omit, propagate and error policies', async () => {
  const s = source([[1, NaN, 4], [NaN, NaN, 8], [3, NaN, 12]]);
  const omitted = await temporalStatistics(s);
  assert.deepEqual([...omitted.mean], [2, NaN, 8]); assert.deepEqual([...omitted.count], [2, 0, 3]);
  assert.deepEqual([...omitted.minimum], [1, NaN, 4]);
  assert.deepEqual([...(await temporalStatistics(s, { missing: 'propagate' })).mean], [NaN, NaN, 8]);
  await assert.rejects(temporalStatistics(s, { missing: 'error' }), /missing value/);
});
test('statistics reject invalid steps, field changes, infinities and overflow without partial results', async () => {
  for (const times of [[], [1, 1], [2, 1], [0, Infinity]]) await assert.rejects(temporalStatistics(source([[1], [2]], times)));
  for (const options of [{ start: -1 }, { start: 1, stop: 1 }, { stop: 3 }, { ddof: 2 }, { missing: 'zero' }])
    await assert.rejects(temporalStatistics(source([[1], [2]]), options));
  for (const frames of [[[1], [1, 2]], [[Infinity]], [['1']], [[], []], [[1e308], [-1e308]]])
    await assert.rejects(temporalStatistics(source(frames)));
});
test('interpolation supports exact keys, irregular times, step, nearest ties, singleton and clamped limits', async () => {
  const reads = [], frames = [[0, 2], [4, 6], [10, 12]], s = { times: [0, 2, 5], read(i) { reads.push(i); return frames[i]; } };
  assert.deepEqual([...await interpolateTemporal(s, 1)], [2, 4]);
  reads.length = 0; assert.deepEqual([...await interpolateTemporal(s, 2)], [4, 6]); assert.deepEqual(reads, [1]);
  assert.deepEqual([...await interpolateTemporal(s, 3.5, { method: 'nearest' })], [4, 6]);
  assert.deepEqual([...await interpolateTemporal(s, 4.9, { method: 'step' })], [4, 6]);
  assert.deepEqual([...await interpolateTemporal(s, 50, { outside: 'clamp' })], [10, 12]);
  assert.deepEqual([...await interpolateTemporal(source([[7]]), -1, { outside: 'clamp' })], [7]);
  assert.deepEqual([...await interpolateTemporal(source([[-1e308], [1e308]]), 0.5)], [0]);
  assert.deepEqual([...await interpolateTemporal(source([[0], [4]], [-1e308, 1e308]), 0)], [2]);
  assert.ok(Number.isNaN((await interpolateTemporal(source([[NaN], [1]]), 0.5))[0]));
  for (const t of [-1, 6, NaN]) await assert.rejects(interpolateTemporal(s, t));
  await assert.rejects(interpolateTemporal(s, 1, { method: 'cubic' }));
  await assert.rejects(interpolateTemporal(source([[1], [2, 3]]), 0.5));
});
test('reads and long CPU work honor exact abort reasons and propagate reader failure', async () => {
  const reason = new Error('cancel temporal'), aborted = AbortSignal.abort(reason);
  await assert.rejects(temporalStatistics(source([[1]]), { signal: aborted }), e => e === reason);
  await assert.rejects(interpolateTemporal(source([[1]]), 0, { signal: aborted }), e => e === reason);
  const controller = new AbortController();
  await assert.rejects(temporalStatistics({ times: [0], read() { controller.abort(reason); return [1]; } }, { signal: controller.signal }), e => e === reason);
  const during = new AbortController();
  setTimeout(() => during.abort(reason), 0);
  await assert.rejects(temporalStatistics(source([new Float64Array(262144)]), { signal: during.signal }), e => e === reason);
  await assert.rejects(temporalStatistics({ times: [0], read() { throw reason; } }), e => e === reason);
});
test('spatial probes follow fixed physical positions through changing meshes, fields and vector components', async () => {
  const grid = (shift, time) => ({ dims: [2, 2, 1], bounds: [shift, shift + 1, 0, 1, 0, 0],
    pointData: [time, time + 1, time + 2, time + 3], pointArrays: { velocity: [1, time, 1, time, 1, time, 1, time] }, cellData: [time + 20] });
  const s = source([grid(0, 0), grid(0, 10), grid(2, 20)], [0, 2, 7]);
  const probe = await probeTemporal(s, [0.25, 0.5, 0]);
  assert.deepEqual([...probe.values], [1.25, 11.25, NaN]); assert.deepEqual([...probe.valid], [1, 1, 0]);
  assert.deepEqual([...(await probeTemporal(s, [0.25, 0.5, 0], { field: 'velocity', component: 1 })).values], [0, 10, NaN]);
  assert.deepEqual([...(await probeTemporal(s, [0.25, 0.5, 0], { association: 'cell' })).values], [20, 30, NaN]);
  await assert.rejects(probeTemporal(s, [0, 0, 0], { field: 'absent' }));
  await assert.rejects(probeTemporal(s, [NaN, 0, 0]));
  await assert.rejects(probeTemporal(s, [0, 0, 0], { component: -1 }));
});
test('probe chart separates gaps, rebases epoch times and rolls back only its own layers on cancellation', async () => {
  const drawn = [], removed = [], figure = { line: async (data) => { const layer = { data, kind: 'line' }; drawn.push(layer); return layer; },
    scatter: async (data) => { const layer = { data, kind: 'scatter' }; drawn.push(layer); return layer; }, remove: (l) => removed.push(l) };
  const probe = { times: [1e12, 1e12 + 1, 1e12 + 2, 1e12 + 3], values: [2, 4, NaN, 8], valid: [1, 1, 0, 1] };
  const chart = await plotTemporalProbe(figure, probe);
  assert.equal(chart.origin, 1e12); assert.equal(chart.layers.length, 2);
  assert.deepEqual([...drawn[0].data.x], [0, 1]); assert.equal(drawn[1].kind, 'scatter');
  chart[Symbol.dispose](); chart.dispose(); assert.equal(removed.length, 2);
  const controller = new AbortController(), reason = new Error('cancel chart');
  figure.line = async () => { controller.abort(reason); return { kind: 'line' }; };
  await assert.rejects(plotTemporalProbe(figure, probe, { signal: controller.signal }), e => e === reason);
  assert.equal(removed.length, 3);
});
test('numbered grouping covers leading/trailing numbers, suffixes, directories, gaps and ambiguity rejection', () => {
  const names = ['a/f010.vtu', 'a/f002.vtu', 'a/f001.vtu', 'a/f001.vti', 'b/f001.vtu', 'plain.vtk', '2foo.vtk', '1foo.vtk', 'foo.vtk.2', 'foo.vtk.1'];
  const groups = groupFileSeries(names, { start: 5, step: 0.5 });
  const f = groups.find(g => g.pattern === 'a/f*.vtu');
  assert.deepEqual(f.files.map(f => f.time), [5, 5.5, 9.5]);
  assert.equal(groups.length, 6); assert.equal(names[0], 'a/f010.vtu');
  for (const n of [['f1.vtk', 'f01.vtk'], ['a.vtk', 'a.vtk'], ['f999999999999999999999.vtk']]) assert.throws(() => groupFileSeries(n));
  assert.throws(() => groupFileSeries(['f1'], { step: 0 }));
});
test('.series JSON preserves irregular physical times, resolves relative names and feeds a cancellable reader', async () => {
  const series = parseFileSeries(JSON.stringify({ 'file-series-version': '1.0', files: [{ name: 'f2.vtu', time: 8 }, { name: 'f1.vtu', time: -2 }] }),
    { units: 'hours', baseURL: 'https://data.test/path/wind.vtu.series' });
  assert.deepEqual(series.files, [{ name: 'https://data.test/path/f1.vtu', time: -2 }, { name: 'https://data.test/path/f2.vtu', time: 8 }]);
  assert.ok(Object.isFrozen(series.files));
  const s = fileSeriesSource(series, (file) => [file.time]);
  assert.deepEqual([...await interpolateTemporal(s, 3)], [3]);
  await assert.rejects(s.read(2, {}));
  const reason = new Error('no load'); await assert.rejects(s.read(0, { signal: AbortSignal.abort(reason) }), e => e === reason);
  for (const json of ['{', {}, { 'file-series-version': '2.0', files: [] }, { 'file-series-version': '1.0', files: [] },
    { 'file-series-version': '1.0', files: [{ name: 'a', time: 0 }, { name: 'b', time: 0 }] },
    { 'file-series-version': '1.0', files: [{ name: 'a', time: '0' }] }]) assert.throws(() => parseFileSeries(json));
});
test('time units handle duration scales, origin offsets, years below 100 and strict invalid-date rejection', () => {
  assert.deepEqual([...convertTimeUnits([0, 1, 24, NaN], 'hours', 'days')], [0, 1 / 24, 1, NaN]);
  assert.deepEqual([...convertTimeUnits([0, 1], 'days since 2024-01-01', 'hours since 2023-12-31')], [24, 48]);
  assert.equal(parseTimeUnits('seconds since 2024-01-01 1:0:0 +1:00').epoch, Date.UTC(2024, 0, 1));
  assert.equal(formatTemporalTime(24, 'hours since 2024-02-28'), '2024-02-29T00:00:00.000Z');
  assert.equal(formatTemporalTime(0, 'seconds since 0099-01-01'), '0099-01-01T00:00:00.000Z');
  assert.equal(formatTemporalTime(1500, 'ms'), '1500 milliseconds');
  for (const unit of ['months', 'years', 'hours since 2023-02-29', 's since 2024-01-01 24:00:00', 's since 2024-01-01T00:00:60Z', 's since 2024-01-01 0:0:0 +24:00'])
    assert.throws(() => parseTimeUnits(unit));
  assert.throws(() => convertTimeUnits([1], 'hours', 'days since 2024-01-01'));
  assert.throws(() => convertTimeUnits([Infinity], 'hours', 'days'));
});
test('real NOAA daily file series and ERA5 six-hour samples retain pinned hashes and independent reductions', async () => {
  const base = new URL('../../../examples/assets/sciviz/temporal/', import.meta.url), manifest = JSON.parse(readFileSync(new URL('source.json', base)));
  for (const [name, hash] of Object.entries(manifest.sha256)) assert.equal(createHash('sha256').update(readFileSync(new URL(name, base))).digest('hex'), hash);
  const series = parseFileSeries(readFileSync(new URL('wind.json.series', base), 'utf8'), { units: 'days since 2024-01-01' });
  const wind = fileSeriesSource(series, f => JSON.parse(readFileSync(new URL(f.name, base))).values);
  using era = await openNetCDF(new Uint8Array(readFileSync(new URL('era5.nc', base))));
  const times = await era.variables.time.read(), field = era.variables['2m_temperature'];
  const eraSource = { times, read: i => field.read({ start: [i, 0, 0], count: [1, 64, 32] }) };
  for (const s of [wind, eraSource]) {
    const frames = await Promise.all(Array.from({ length: s.times.length }, (_, i) => s.read(i, {})));
    const result = await temporalStatistics(s);
    for (const j of [0, 12, frames[0].length - 1]) {
      const column = frames.map(f => f[j]), mean = column.reduce((a, b) => a + b) / column.length;
      near(result.mean[j], mean, 1e-10);
      near(result.standardDeviation[j], Math.sqrt(column.reduce((a, b) => a + (b - mean) ** 2, 0) / column.length), 1e-10);
    }
    const mid = await interpolateTemporal(s, (s.times[0] + s.times[1]) / 2);
    near(mid[0], (frames[0][0] + frames[1][0]) / 2);
  }
});
