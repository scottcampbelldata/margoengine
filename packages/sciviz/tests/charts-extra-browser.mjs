import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
await mkdir('test-results/charts-extra', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-charts-extra.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(60000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('13 charts;'));
    assert.equal(await browser.page.locator('svg').count(), 13);
    const reports = await browser.page.evaluate(async () => {
      const result = [];
      for (const svg of document.querySelectorAll('svg')) {
        const url = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' })),
          img = new Image();
        img.src = url;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 1000;
        canvas.height = 600;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const pixels = ctx.getImageData(0, 50, 1000, 550).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 4) if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 220) ink++;
        result.push({
          title: svg.querySelector('title').textContent,
          ink,
          paths: svg.querySelectorAll('path').length,
          raster: svg.querySelectorAll('image').length,
        });
      }
      return result;
    });
    for (const r of reports) {
      assert.ok(r.ink > 100, r.title);
      assert.ok(r.paths > 0, r.title);
      assert.equal(r.raster, 0);
    }
    await browser.page.screenshot({
      path: `test-results/charts-extra/${compat ? 'webgl2' : 'webgpu'}.png`,
      fullPage: true,
    });
    await browser.page.setViewportSize({ width: 390, height: 800 });
    assert.ok(await browser.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const download = browser.page.waitForEvent('download');
    await browser.page.locator('button').first().click();
    assert.match((await download).suggestedFilename(), /\.svg$/);
    assert.deepEqual(errors, []);
    console.log(`charts-extra ${compat ? 'WebGL2' : 'WebGPU'} ${JSON.stringify(reports)}`);
  } finally {
    await browser.close();
  }
}
