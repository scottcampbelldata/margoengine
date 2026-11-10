import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FigureStats, installFigureStats, sweepLimits } from '../dist/monitor.js';
import { ColumnarTable } from '../dist/table.js';

const metadata = { commit: 'test', gpu: {}, browser: 'node', cpuLoad: 0, machine: 'test', diagnostic: true };
const empty = () => ({
  gpuBytes: 0,
  jsDataBytes: 0,
  jsArrayBytesEstimate: 0,
  layers: [],
  counts: {},
  unreportedLayers: 0,
});

test('inventory counts backing stores once, texture mips and samples, shared totals and unknown layers', () => {
  const data = new Float32Array(100),
    buffer = { size: 64 };
  const texture = { width: 8, height: 4, depthOrArrayLayers: 2, dimension: '3d', mipLevelCount: 3, sampleCount: 1 };
  const resources = {
    cpu: [data, data.subarray(10, 12), [1, 2]],
    gpu: [buffer, buffer, { texture, bytesPerTexel: 2 }, { texture, bytesPerTexel: 2 }],
  };
  const a = { memoryResources: resources },
    b = { memoryResources: resources },
    unknown = {};
  const fig = { layers: [a, b, unknown] };
  const stats = new FigureStats(fig),
    snap = stats.snapshot();
  assert.equal(snap.jsDataBytes, 400);
  assert.equal(snap.jsArrayBytesEstimate, 16);
  assert.equal(snap.gpuBytes, 64 + (64 + 8 + 2) * 2);
  assert.equal(snap.unreportedLayers, 1);
  assert.equal(snap.layers[0].gpuBytes, snap.layers[1].gpuBytes);
  const id = snap.layers[1].id;
  fig.layers.shift();
  assert.equal(stats.snapshot().layers[0].id, id);
  const stop = stats.track(unknown, {
    name: 'table',
    resources: () => ({ cpu: [data], gpu: [] }),
    counts: () => ({ rows: 100 }),
  });
  assert.equal(stats.snapshot().unreportedLayers, 0);
  assert.equal(stats.snapshot().counts.rows, 100);
  stop();
  assert.equal(stats.snapshot().unreportedLayers, 1);
  fig.layers.length = 0;
  assert.equal(stats.snapshot().gpuBytes, 0);
  stats.dispose();
  assert.throws(() => stats.snapshot(), /disposed/);
});

test('figure install is explicit, idempotent and refuses a conflicting property', () => {
  const fig = { layers: [] };
  assert.equal('stats' in fig, false);
  assert.equal(installFigureStats(fig), fig);
  assert.equal(installFigureStats(fig).stats, fig.stats);
  assert.throws(() => installFigureStats({ layers: [], stats: 1 }), /different stats/);
});

test('allocation sweeps draw each size once, omit timing fields and stop at the first failure', async () => {
  let frames = 0,
    disposed = 0;
  const report = await sweepLimits({
    kind: 'points',
    sizes: [10, 100, 1000, 10000],
    metadata,
    prepare: async (size) => {
      if (size === 1000) throw Object.assign(new Error('device storage limit'), { code: 'range' });
      return {
        frame: async () => {
          frames++;
        },
        stats: empty,
        dispose: () => {
          disposed++;
        },
      };
    },
  });
  assert.equal(report.mode, 'allocation');
  assert.equal(report.firstFailure, 1000);
  assert.equal(report.firstOverBudget, null);
  assert.equal(report.rows.length, 3);
  assert.equal(report.rows[2].error.code, 'range');
  assert.equal(frames, 2);
  assert.equal(disposed, 2);
  assert(!('frameMs' in report.rows[0]));
  assert(!('loadMs' in report.rows[0]));
});

test('size ceilings are censored observations and abort reasons propagate with disposal', async () => {
  const ceiling = await sweepLimits({
    kind: 'rows',
    sizes: [2],
    metadata,
    prepare: async () => ({ frame: async () => {}, stats: empty, dispose() {} }),
  });
  assert.equal(ceiling.stop, 'size-ceiling');
  assert.equal(ceiling.firstFailure, null);
  const abort = new AbortController();
  let disposed = 0;
  await assert.rejects(
    sweepLimits({
      kind: 'cells',
      sizes: [2],
      metadata,
      signal: abort.signal,
      prepare: async () => ({
        frame: async () => {
          abort.abort(new Error('user cancelled'));
        },
        stats: empty,
        dispose() {
          disposed++;
        },
      }),
    }),
    /user cancelled/,
  );
  assert.equal(disposed, 1);
});

test('hard deadline records a timeout and releases a late prepare result', async () => {
  let release,
    disposed = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const report = await sweepLimits({ kind: 'load', sizes: [1, 2], metadata, timeoutMs: 20, prepare: () => pending });
  assert.equal(report.firstFailure, 1);
  assert.equal(report.rows[0].error.name, 'TimeoutError');
  release({
    frame: async () => {},
    stats: empty,
    dispose() {
      disposed++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, 1);
});

test('reject invalid plans, metadata and counts before reporting misleading results', async () => {
  for (const sizes of [[], [2, 2], [0], [10, 1], [1.5]])
    await assert.rejects(sweepLimits({ kind: 'edges', sizes, metadata, prepare: async () => {} }), /sizes/);
  await assert.rejects(sweepLimits({ kind: 'edges', sizes: [1], metadata: { ...metadata, cpuLoad: NaN } }), /CPU load/);
  const stats = new FigureStats({ layers: [] });
  stats.track({}, { resources: () => ({ cpu: [], gpu: [] }), counts: () => ({ rows: -1 }) });
  assert.throws(() => stats.snapshot(), /Invalid rows/);
});

test('timed sweep crosses the frame budget then continues to failure using a deterministic clock', async (t) => {
  let clock = 0,
    frames = 0,
    disposed = 0;
  t.mock.method(performance, 'now', () => clock);
  const report = await sweepLimits({
    kind: 'edges',
    sizes: [1, 2, 3, 4],
    metadata,
    timing: true,
    warmupFrames: 1,
    sampleFrames: 3,
    prepare: async (size) => {
      if (size === 3) throw new Error('allocation failure');
      clock += 5;
      return {
        frame: async () => {
          clock += size * 10;
          frames++;
        },
        stats: empty,
        dispose() {
          disposed++;
        },
      };
    },
  });
  assert.equal(report.firstOverBudget, 2);
  assert.equal(report.firstFailure, 3);
  assert.equal(report.rows[0].loadMs, 15);
  assert.equal(report.rows[1].medianFrameMs, 20);
  assert.deepEqual(report.rows[0].frameMs, [10, 10, 10]);
  assert.equal(frames, 10);
  assert.equal(disposed, 2);
});

test('owned child layers are discovered once and vanish with their parent', () => {
  const child = { memoryResources: { cpu: [], gpu: [{ size: 128 }] } };
  const parent = { memoryResources: { children: [child, child], cpu: [], gpu: [{ size: 320 }] } };
  const fig = { layers: [parent] },
    stats = new FigureStats(fig);
  assert.equal(stats.snapshot().gpuBytes, 448);
  assert.equal(stats.snapshot().layers.length, 2);
  fig.layers.length = 0;
  assert.equal(stats.snapshot().layers.length, 0);
});

test('typed table adapters count int64 backing stores, shared columns and null bitmaps exactly', () => {
  const ids = new BigInt64Array([9007199254740993n, 4n]),
    validity = new Uint8Array([1]);
  const table = new ColumnarTable({ first: { values: ids, validity }, second: { values: ids, validity } });
  const stats = new FigureStats({ layers: [] }),
    stop = stats.trackTable(table, 'precise IDs');
  assert.equal(stats.snapshot().jsDataBytes, 17);
  assert.equal(stats.snapshot().counts.rows, 2);
  assert.equal(stats.snapshot().layers[0].name, 'precise IDs');
  stop();
  assert.equal(stats.snapshot().layers.length, 0);
});
