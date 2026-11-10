import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-geo-lod.html', port: 'free', compat }),
    errors = [];
  browser.page.setDefaultTimeout(60000);
  browser.page.on('pageerror', (error) => errors.push(error.message));
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const report = await browser.page.evaluate(async () => {
      const { currentFigure } = await import('/examples/sciviz-geo-lod.ts');
      currentFigure().dispose();
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { geoLodLayer, decodeTerrarium } = await import('/packages/sciviz/dist/geo-lod.js');
      const figure = await Figure.create(document.querySelector('#map'), {
        axes: false,
        controls: false,
        limits: [-1, 1, -1, 1, -1, 1],
        aspect: [1, 1, 1],
      });
      figure.engine.camera.position = [8, 3, 8];
      const source = async (z, x, y, signal) => {
        const r = await fetch(`/examples/assets/sciviz/geo-lod/${z}-${x}-${y}.png`, { signal });
        if (!r.ok) throw new Error(`real tile ${r.status}`);
        const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none' }),
          c = new OffscreenCanvas(bmp.width, bmp.height),
          g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        bmp.close();
        return g.getImageData(0, 0, c.width, c.height);
      };
      const layer = geoLodLayer(figure, {
        tiles: source,
        elevation: async (t, s) => decodeTerrarium(await source(t.z, t.x, t.y, s)),
        projection: 'globe',
        maxZoom: 2,
        tileBudget: 40,
        cacheTiles: 80,
        fadeSeconds: 0,
      });
      await figure.ready();
      figure.engine.render();
      await layer.ready({ signal: AbortSignal.timeout(20000) });
      figure.engine.stop();
      const gpuErrors = [];
      figure.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const image = async () => {
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false })),
          c = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = c.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const before = await image();
      const a = layer.selected.map((t) => `${t.z}/${t.x}/${t.y}`);
      figure.engine.camera.position = [0.2, 0.1, 1.8];
      figure.engine.camera.target = [0, 0, 0];
      await image();
      await layer.ready({ signal: AbortSignal.timeout(20000) });
      const after = await image(),
        b = layer.selected.map((t) => `${t.z}/${t.x}/${t.y}`);
      layer.restore();
      const restored = await image();
      let changed = 0,
        lit = 0,
        restoreError = 0;
      for (let i = 0; i < before.length; i += 4) {
        if (Math.max(before[i], before[i + 1], before[i + 2]) > 45) lit++;
        if (before[i] !== after[i]) changed++;
        restoreError = Math.max(restoreError, Math.abs(after[i] - restored[i]));
      }
      const stats = layer.stats;
      figure.dispose();
      return { a, b, changed, lit, restoreError, stats, gpuErrors };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(report.gpuErrors, []);
    assert.ok(report.lit > 1000, `real terrain drew ${report.lit} pixels`);
    assert.ok(report.changed > 1000, 'camera motion changes the rendered terrain');
    assert.notDeepEqual(report.a, report.b, 'camera motion changes view selection');
    assert.ok(report.stats.resident <= 80);
    assert.equal(report.restoreError, 0, 'retained data restores identical pixels');
    reports.push({ compat, hardware: browser.hardware, ...report });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-geo-lod.json', JSON.stringify(reports, null, 2));
console.log('geo-lod: real AWS terrain, camera refinement, cache budget and restore passed on both backends');
