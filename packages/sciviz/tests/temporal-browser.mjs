import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-temporal.html', port: 'free', compat });
  const errors = [];
  browser.page.setDefaultTimeout(90000);
  browser.page.on('pageerror', e => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => /^(Ready\.|Could not)/.test(document.querySelector('#status').textContent));
    assert.match(await browser.page.locator('#status').textContent(), /^Ready\./);
    await browser.page.route('**/era5.nc', route => route.fulfill({ status: 503, body: 'data unavailable' }));
    await browser.page.locator('#dataset').selectOption('era5');
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Could not'));
    await browser.page.unroute('**/era5.nc');
    await browser.page.locator('#dataset').selectOption('noaa');
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-temporal.ts'), { plotTemporalProbe } = await import('/packages/sciviz/dist/temporal.js');
      const pixels = async (f) => {
        f.engine.stop();
        const bitmap = await createImageBitmap(await f.toPNG({ overlays: false })), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0); bitmap.close();
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const diff = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0), modes = [];
      for (const mode of ['noaa', 'era5']) {
        if (mode === 'era5') { document.querySelector('#dataset').value = mode; await demo.show(mode); }
        const field = demo.fieldFigure, chart = demo.figure, a = await pixels(field), line = await pixels(chart), gpuErrors = [];
        for (const figure of [field, chart]) figure.renderer.device.addEventListener('uncapturederror', e => gpuErrors.push(e.error.message));
        document.querySelector('#time').value = '3.5'; await demo.drawField();
        const mid = await pixels(field), reductions = [];
        for (const stat of ['mean', 'minimum', 'maximum', 'standardDeviation']) {
          document.querySelector('#statistic').value = stat; await demo.drawField();
          reductions.push({ stat, difference: diff(a, await pixels(field)) });
        }
        document.querySelector('#statistic').value = 'step'; document.querySelector('#time').value = '0'; await demo.drawField();
        const exact = await pixels(field);
        const controller = new AbortController(), reason = new Error('chart cancelled');
        let cancelled = false;
        try {
          await plotTemporalProbe({ line: async (...args) => { const layer = await chart.line(...args); controller.abort(reason); return layer; }, remove: l => chart.remove(l) }, demo.probe, { signal: controller.signal });
        } catch (e) { if (e !== reason) throw e; cancelled = true; }
        const rolledBack = await pixels(chart);
        const sparse = { times: demo.probe.times, values: demo.probe.values, valid: Uint8Array.from([1, 1, 0, 0, 1, 0, 1, 1]) };
        const added = await plotTemporalProbe(chart, sparse, { color: '#ff4488' });
        const kinds = added.layers.map(l => l.kind), sparsePixels = await pixels(chart);
        added.dispose(); added.dispose();
        const disposed = await pixels(chart);
        await field.engine.rebootDevice(); await field.ready();
        await chart.engine.rebootDevice(); await chart.ready();
        modes.push({ mode, steps: demo.source.times.length, count: demo.statistics.mean.length,
          valid: [...demo.probe.valid], times: [...demo.source.times], mean: demo.statistics.mean[0], std: demo.statistics.standardDeviation[0],
          changed: diff(a, mid), reductions, exact: diff(a, exact), rollback: diff(line, rolledBack), cancelled, kinds,
          sparseChanged: diff(line, sparsePixels), disposed: diff(line, disposed),
          restoreField: diff(exact, await pixels(field)), restoreChart: diff(disposed, await pixels(chart)), gpuErrors });
      }
      return { modes };
    });
    assert.deepEqual(errors, []);
    for (const mode of report.modes) {
      assert.equal(mode.steps, 8); assert.equal(mode.count, mode.mode === 'noaa' ? 25 : 2048);
      assert.deepEqual(mode.valid, new Array(8).fill(1)); assert.ok(Number.isFinite(mode.mean) && mode.std > 0);
      assert.ok(mode.changed > 1000, JSON.stringify(mode));
      for (const stat of mode.reductions) assert.ok(stat.difference > 1000, JSON.stringify(stat));
      assert.equal(mode.exact, 0); assert.equal(mode.rollback, 0); assert.equal(mode.disposed, 0);
      assert.ok(mode.cancelled); assert.deepEqual(mode.kinds, ['line', 'scatter', 'line']); assert.ok(mode.sparseChanged > 1000);
      assert.equal(mode.restoreField, 0); assert.equal(mode.restoreChart, 0); assert.deepEqual(mode.gpuErrors, []);
      assert.equal(mode.times[1] - mode.times[0], mode.mode === 'noaa' ? 1 : 6);
    }
    reports.push({ compat, ...report });
    await browser.page.screenshot({ path: `test-results/sciviz-temporal-${compat ? 'webgl2' : 'webgpu'}.png`, fullPage: true });
    await browser.page.evaluate(async () => { const demo = await import('/examples/sciviz-temporal.ts'); demo.figure.dispose(); demo.fieldFigure.dispose(); });
  } finally { await browser.close(); }
}
await writeFile('test-results/sciviz-temporal.json', JSON.stringify(reports, null, 2));
console.log('temporal: NOAA days and ERA5 hours, interpolation, four reductions, spatial probe charts, gaps, cancellation, disposal and device restore pass both backends');
