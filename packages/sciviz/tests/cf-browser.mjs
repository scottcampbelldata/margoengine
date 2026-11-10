import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-climate.html', port: 'free', compat }),
    errors = [];
  browser.page.setDefaultTimeout(90000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    if (!compat) await browser.page.screenshot({ path: 'test-results/sciviz-climate.png' });
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-climate.ts'),
        { cfMapLayer, regridCF } = await import('/packages/sciviz/dist/cf.js');
      const image = async () => {
        const bitmap = await createImageBitmap(await demo.currentFigure().toPNG({ overlays: false })),
          c = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = c.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const diff = (a, b) => a.reduce((n, v, i) => n + Math.abs(v - b[i]), 0),
        lit = (a) => {
          let n = 0;
          for (let i = 0; i < a.length; i += 4) if (Math.max(a[i], a[i + 1], a[i + 2]) > 85) n++;
          return n;
        };
      const modes = [];
      for (const dataset of ['era5', 'cmip6'])
        for (const projection of [
          'mollweide',
          'robinson',
          'lambert-conformal-conic',
          'albers',
          'polar-stereographic',
        ]) {
          if (dataset !== 'era5' || projection !== 'mollweide') {
            document.querySelector('#dataset').value = dataset;
            document.querySelector('#projection').value = projection;
            await demo.start();
          }
          const figure = demo.currentFigure(),
            layer = demo.currentLayer();
          figure.engine.stop();
          const before = await image(),
            mapped = regridCF(demo.currentGrid(), demo.currentTarget());
          await figure.engine.rebootDevice();
          await figure.ready();
          figure.engine.stop();
          const restored = await image();
          layer.visible = false;
          const hidden = await image();
          layer.visible = true;
          modes.push({
            dataset,
            projection,
            lit: lit(before),
            restore: diff(before, restored),
            hidden: diff(before, hidden),
            triangles: layer.triangles,
            finite: mapped.values.filter(Number.isFinite).length,
            masked: mapped.values.filter(Number.isNaN).length,
          });
        }
      document.querySelector('#projection').value = 'mollweide';
      document.querySelector('#dataset').value = 'era5';
      await demo.start();
      demo.currentFigure().engine.stop();
      const first = await image();
      document.querySelector('#step').value = '1';
      await demo.start();
      demo.currentFigure().engine.stop();
      const next = await image();
      document.querySelector('#mask').value = 'land';
      await demo.start();
      demo.currentFigure().engine.stop();
      const land = await image(),
        landTriangles = demo.currentLayer().triangles;
      document.querySelector('#mask').value = 'ocean';
      await demo.start();
      demo.currentFigure().engine.stop();
      const ocean = await image(),
        oceanTriangles = demo.currentLayer().triangles;
      const figure = demo.currentFigure(),
        before = await image(),
        abort = new AbortController();
      abort.abort();
      let cancelled = false;
      try {
        await cfMapLayer(figure, demo.currentGrid(), demo.currentTarget(), { signal: abort.signal });
      } catch (e) {
        cancelled = e.name === 'AbortError';
      }
      const abortDifference = diff(before, await image());
      demo.currentLayer().dispose();
      const disposed = await image();
      figure.dispose();
      return {
        modes,
        stepDifference: diff(first, next),
        landOceanDifference: diff(land, ocean),
        landTriangles,
        oceanTriangles,
        cancelled,
        abortDifference,
        disposeDifference: diff(before, disposed),
      };
    });
    assert.deepEqual(errors, []);
    for (const m of report.modes) {
      assert.ok(m.lit > 500, JSON.stringify(m));
      assert.equal(m.restore, 0, JSON.stringify(m));
      assert.ok(m.hidden > 10000, JSON.stringify(m));
      assert.ok(m.finite > 2000, JSON.stringify(m));
      assert.equal(m.triangles, m.finite * 2);
    }
    assert.ok(report.stepDifference > 1000);
    assert.ok(report.landOceanDifference > 10000);
    assert.ok(report.landTriangles > 1000);
    assert.ok(report.oceanTriangles > 1000);
    assert.equal(report.cancelled, true);
    assert.equal(report.abortDifference, 0);
    assert.ok(report.disposeDifference > 10000);
    reports.push({ backend: compat ? 'webgl2' : 'webgpu', ...report });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-cf-browser.json', JSON.stringify(reports, null, 2) + '\n');
console.log(JSON.stringify(reports, null, 2));
