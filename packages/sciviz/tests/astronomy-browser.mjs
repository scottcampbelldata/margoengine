import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
await mkdir('test-results/batch176/astronomy', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-astronomy.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(
      () => document.querySelector('#sdss')?.dataset.ready || document.querySelector('#sdss')?.dataset.error,
    );
    assert.equal(await browser.page.locator('#sdss').getAttribute('data-error'), null);
    const result = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-astronomy.ts'),
        reports = {};
      for (const [name, figure] of Object.entries(demo.figures)) {
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false })),
          canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0,
          hash = 2166136261;
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.max(...[0, 1, 2].map((k) => Math.abs(pixels[i + k] - pixels[k]))) > 30) lit++;
          hash = Math.imul(hash ^ pixels[i] ^ (pixels[i + 1] << 8) ^ (pixels[i + 2] << 16), 16777619);
        }
        reports[name] = { lit, hash, samples: demo.samples[name] };
      }
      return reports;
    });
    for (const report of Object.values(result)) assert.ok(report.lit > 500, JSON.stringify(result));
    assert.equal(result.sdss.samples, 2048 * 1489);
    assert.equal(result.emdb.samples, 125 ** 3);
    assert.equal(result.idr.samples, 256 ** 2);
    assert.equal(new Set(Object.values(result).map((r) => r.hash)).size, 3);
    const directed = await browser.page.evaluate(async () => {
      const { figures } = await import('/examples/sciviz-astronomy.ts'),
        { fitsWCS, volumeFromFITS } = await import('/packages/sciviz/src/fits.ts'),
        layers = [];
      try {
        for (const step of [1, -1]) {
          const wcs = fitsWCS({ CRPIX1: 1, CRVAL1: step === 1 ? 8 : 10, CDELT1: step }, 3);
          layers.push(
            volumeFromFITS(figures.emdb, {
              data: Float32Array.from({ length: 12 }, (_, i) => i),
              dims: [3, 2, 2],
              world: (p) => wcs.world(p),
            }),
          );
        }
        await figures.emdb.ready();
        figures.emdb.engine.render();
        return layers.map((layer) => ({ bounds: [...layer.bounds], model: [...layer.model] }));
      } finally {
        for (const layer of layers) layer.dispose();
      }
    });
    assert.deepEqual(
      directed.map((l) => l.bounds.slice(0, 2)),
      [
        [8, 10],
        [10, 8],
      ],
    );
    assert.ok(directed[0].model[0] > 0 && directed[1].model[0] < 0);
    assert.ok(Math.abs(directed[1].model[12] - directed[0].model[12] - directed[0].model[0]) < 1e-6);
    assert.ok(Math.abs(directed[1].model[0] + directed[0].model[0]) < 1e-6);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ backend: compat ? 'WebGL2 compatibility' : 'WebGPU', ...result }));
    for (const name of ['sdss', 'emdb', 'idr'])
      await browser.page
        .locator('#' + name)
        .screenshot({ path: `test-results/batch176/astronomy/${compat ? 'compat' : 'native'}-${name}.png` });
  } finally {
    await browser.close();
  }
}
