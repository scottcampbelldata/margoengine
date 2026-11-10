import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-engineering.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(
      () => document.querySelector('canvas')?.dataset.ready || document.querySelector('canvas')?.dataset.error,
    );
    assert.equal(await browser.page.locator('canvas').getAttribute('data-error'), null);
    const result = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-engineering.ts'),
        reports = {};
      for (const format of ['cgns', 'exodus']) {
        await demo.show(format);
        const bitmap = await createImageBitmap(await demo.figure.toPNG({ overlays: false })),
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
        reports[format] = { lit, hash, cells: demo.dataset.types.length };
      }
      demo.figure.dispose();
      return reports;
    });
    for (const r of Object.values(result)) assert.ok(r.lit > 500, JSON.stringify(result));
    assert.equal(result.cgns.cells, 816);
    assert.equal(result.exodus.cells, 7152);
    assert.notEqual(result.cgns.hash, result.exodus.hash);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ backend: compat ? 'WebGL2 compatibility' : 'WebGPU', ...result }));
    await browser.page.screenshot({ path: `test-results/batch176/engineering/${compat ? 'compat' : 'native'}.png` });
  } finally {
    await browser.close();
  }
}
