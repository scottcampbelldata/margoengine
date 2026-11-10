import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-pipeline.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  try {
    browser.page.setDefaultTimeout(90000);
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.includes('Executions:'));
    const report = await browser.page.evaluate(async () => {
      const { figure, pipeline, counts, show } = await import('/examples/sciviz-pipeline.ts');
      const before = { ...counts };
      const first = await pipeline.run('minimum');
      const pixels = async () => {
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let cyan = 0;
        for (let i = 0; i < data.length; i += 4)
          if (data[i + 1] > 100 && data[i + 2] > 120 && data[i + 2] > data[i] * 1.4) cyan++;
        return cyan;
      };
      const beforePixels = await pixels();
      await show(1);
      const second = await pipeline.run('minimum');
      const afterPixels = await pixels();
      const result = {
        before,
        after: { ...counts },
        first: first.length,
        second: second.length,
        beforePixels,
        afterPixels,
        nodes: pipeline.toJSON().nodes.length,
        layers: figure.layers.length,
      };
      pipeline.dispose();
      result.disposedLayers = figure.layers.length;
      figure.dispose();
      return result;
    });
    assert.deepEqual(report.before, { source: 1, subset: 1, chart: 1 });
    assert.deepEqual(report.after, { source: 1, subset: 2, chart: 2 });
    assert.equal(report.first, 447);
    assert.ok(report.second > 0 && report.second < report.first);
    assert.ok(report.beforePixels > 100 && report.afterPixels > 100, JSON.stringify(report));
    assert.equal(report.nodes, 3);
    assert.equal(report.layers, 1);
    assert.equal(report.disposedLayers, 0);
    assert.deepEqual(errors, []);
    console.log(`pipeline ${compat ? 'WebGL2 compatibility' : 'WebGPU'}: ${JSON.stringify(report)}`);
  } finally {
    await browser.close();
  }
}
