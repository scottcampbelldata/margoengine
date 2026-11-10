import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
await mkdir('test-results/contour2d', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-contour2d.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(60000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.includes('isolines,'));
    for (const name of ['oisst', 'era5'])
      for (const scattered of [false, true]) {
        await browser.page.selectOption('#field', name);
        await browser.page.locator('#scattered').setChecked(scattered);
        await browser.page.waitForFunction(
          ({ name, scattered }) => {
            const title = document.querySelector('svg title')?.textContent ?? '';
            return title.startsWith(name) && title.includes(scattered ? 'Delaunay' : 'rectilinear');
          },
          { name, scattered },
        );
        const report = await browser.page.evaluate(async () => {
          const svg = document.querySelector('svg'),
            image = new Image();
          image.src = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' }));
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = 800;
          canvas.height = 500;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          URL.revokeObjectURL(image.src);
          const bytes = context.getImageData(0, 0, 800, 500).data;
          let ink = 0;
          for (let i = 3; i < bytes.length; i += 4) if (bytes[i] > 0) ink++;
          return {
            ink,
            paths: svg.querySelectorAll('path').length,
            labels: svg.querySelectorAll('text').length,
            raster: svg.querySelectorAll('image').length,
          };
        });
        assert.ok(report.ink > 5000);
        assert.ok(report.paths > 5);
        assert.ok(report.labels > 0);
        assert.equal(report.raster, 0);
        if (!compat)
          await browser.page.screenshot({
            path: `test-results/contour2d/${name}-${scattered ? 'sites' : 'grid'}.png`,
            fullPage: true,
          });
        console.log(
          `contour2d ${compat ? 'WebGL2' : 'WebGPU'} ${name} scattered=${scattered}: ${JSON.stringify(report)}`,
        );
      }
    const download = browser.page.waitForEvent('download');
    await browser.page.click('#download');
    assert.equal((await download).suggestedFilename(), 'era5-contours.svg');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
