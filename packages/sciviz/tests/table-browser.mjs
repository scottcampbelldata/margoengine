import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-tlc.html', port: 'free', compat });
  const errors = []; browser.page.on('pageerror', (e) => errors.push(e.message)); browser.page.setDefaultTimeout(180000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').dataset.ready === 'true');
    const proof = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-tlc.ts');
      const { ColumnarTable, CrossFilter, aggregateTable, readArrow } = await import('/packages/sciviz/dist/table.js');
      const check = (value, message) => { if (!value) throw new Error(message); };
      const png = async (fig) => { const blob = await fig.toPNG(); const bytes = new Uint8Array(await blob.arrayBuffer()); let hash = 0; for (const b of bytes) hash = Math.imul(hash, 31) + b | 0; return hash; };
      demo.histogram.engine.stop(); demo.heatmap.engine.stop();
      const initial = await Promise.all([png(demo.histogram), png(demo.heatmap)]);
      await demo.update(2); const selected = demo.filter.count;
      const filtered = await Promise.all([png(demo.histogram), png(demo.heatmap)]);
      check(initial.every((v, i) => v !== filtered[i]), 'both chart pixels change');
      check(demo.bars.result.count.reduce((a, b) => a + b, 0) === selected, 'histogram counts equal selected real rows');
      const arrow = await readArrow(new Uint8Array(await (await fetch('/packages/sciviz/tests/fixtures/table/tlc-trips.arrow')).arrayBuffer()));
      check(arrow.length === demo.table.length, 'Arrow and Parquet real observations agree');
      const missing = new ColumnarTable({ x: Float32Array.of(0, 1, 2, 3, NaN, 5), v: { values: Float32Array.of(2, -4, Infinity, 9, 5, 1), validity: Uint8Array.of(0b110111) } });
      const missingOptions = { x: { column: 'x', bins: 3, range: [0, 5] }, value: 'v' };
      const cpuMissing = await aggregateTable(missing, missingOptions), gpuMissing = await aggregateTable(missing, { ...missingOptions, gpu: demo.gpu });
      for (const key of ['count', 'valid', 'sum', 'mean', 'min', 'max']) check([...cpuMissing[key]].every((v, i) => Object.is(v, gpuMissing[key][i])), `null/nonfinite GPU ${key}`);
      // Ten million physical rows, repeating real observations; this is a scale proof, not ten million unique trips.
      const rows = 10000000, x = new Float32Array(rows), v = new Float32Array(rows), reference = { count: new Uint32Array(32), sum: new Float64Array(32), min: new Float32Array(32).fill(Infinity), max: new Float32Array(32).fill(-Infinity), valid: new Uint32Array(32) };
      for (let i = 0; i < rows; i++) { x[i] = Number(demo.table.value('trip_distance', i % demo.table.length)); v[i] = Number(demo.table.value('fare_amount', i % demo.table.length)); }
      const table = new ColumnarTable({ x, v }); using filter = new CrossFilter(table); using dimension = filter.dimension('x');
      dimension.filterRange(0, 10); dimension.filterRange(0, 9.5);
      const work = dimension.work;
      const options = { x: { column: 'x', bins: 32, range: [0, 16] }, value: 'v', gpu: demo.gpu };
      const routesBefore = demo.gpu.device.dispatches ? { ...demo.gpu.device.dispatches } : undefined;
      const actual = await aggregateTable(filter, options);
      const routes = routesBefore ? Object.fromEntries(Object.entries(demo.gpu.device.dispatches).map(([key, value]) => [key, value - routesBefore[key]])) : undefined;
      if (routes) check(routes.cpu === 0 && routes.fragment + routes.scatter === actual.work.passes, 'every compatibility reduction dispatch runs on the GPU');
      // Independent exhaustive row predicate and tile-ordered f32 sum reference.
      for (let start = 0; start < rows; start += 256) {
        const tile = new Float32Array(32);
        for (let i = start; i < Math.min(rows, start + 256); i++) if (x[i] >= 0 && x[i] < 9.5) {
          const b = Math.floor(x[i] * 2); reference.count[b]++;
          if (Number.isFinite(v[i])) { reference.valid[b]++; tile[b] += v[i]; reference.min[b] = Math.min(reference.min[b], v[i]); reference.max[b] = Math.max(reference.max[b], v[i]); }
        }
        for (let b = 0; b < 32; b++) reference.sum[b] += tile[b];
      }
      for (let b = 0; b < 32; b++) {
        check(actual.count[b] === reference.count[b] && actual.valid[b] === reference.valid[b], 'exact 10M GPU bin counts');
        check(actual.sum[b] === reference.sum[b], 'exact 10M tile-ordered GPU sums');
        if (reference.valid[b]) check(actual.min[b] === reference.min[b] && actual.max[b] === reference.max[b] && actual.mean[b] === reference.sum[b] / reference.valid[b], '10M GPU mean/min/max');
        else check(Number.isNaN(actual.mean[b]) && Number.isNaN(actual.min[b]) && Number.isNaN(actual.max[b]), 'empty bin statistics');
      }
      check(actual.work.rows === rows && actual.work.passes > 0, 'GPU processes ten million physical rows');
      check(work.rowsVisited < rows, 'incremental range update does not rescan the table');
      const result = { rows, selected: filter.count, demoSelected: selected, work, aggregation: actual.work, sums: [...actual.sum], backend: demo.gpu.backend, routes };
      demo.bars.dispose(); demo.cells.dispose(); demo.distance.dispose(); demo.filter.dispose(); demo.gpu.dispose(); demo.histogram.dispose(); demo.heatmap.dispose();
      return result;
    });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ compat, ...proof }));
  } finally { await browser.close(); }
}
