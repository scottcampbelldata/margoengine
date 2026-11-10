import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
await mkdir('test-results/stats', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-stats.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(60000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('13 charts;'));
    assert.equal(await browser.page.locator('svg').count(), 13);
    const reports = await browser.page.evaluate(async () => {
      const reports = [];
      for (const svg of document.querySelectorAll('svg')) {
        const image = new Image(),
          url = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' }));
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 480;
        const c = canvas.getContext('2d');
        c.drawImage(image, 0, 0);
        URL.revokeObjectURL(url);
        const b = c.getImageData(58, 58, 684, 364).data;
        let ink = 0;
        for (let i = 0; i < b.length; i += 4) if (Math.min(b[i], b[i + 1], b[i + 2]) < 220) ink++;
        reports.push({
          title: svg.querySelector('title').textContent,
          ink,
          paths: svg.querySelectorAll('path').length,
          raster: svg.querySelectorAll('image').length,
        });
      }
      return reports;
    });
    for (const r of reports) {
      assert.ok(r.ink > 100, r.title);
      assert.ok(r.paths > 1);
      assert.equal(r.raster, 0);
    }
    if (!compat) {
      await browser.page.screenshot({ path: 'test-results/stats/desktop.png', fullPage: true });
      await browser.page.setViewportSize({ width: 390, height: 800 });
      assert.ok(await browser.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await browser.page.screenshot({ path: 'test-results/stats/phone.png', fullPage: true });
    }
    const download = browser.page.waitForEvent('download');
    await browser.page.locator('button').first().click();
    assert.match((await download).suggestedFilename(), /\.svg$/);
    assert.deepEqual(errors, []);
    console.log(`stats ${compat ? 'WebGL2' : 'WebGPU'}: ${JSON.stringify(reports)}`);
  } finally {
    await browser.close();
  }
}
