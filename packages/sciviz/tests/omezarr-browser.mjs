import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const context = await openBrowser({ startPath: '/examples/sciviz-cloud.html', port: 'free', compat });
  const { page } = context,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.setDefaultTimeout(60000);
  try {
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.ready === 'idr-lightsheet');
    const images = {};
    for (const name of ['idr-lightsheet', 'openorganelle', 'hemibrain']) {
      images[name] = await page.evaluate(async (name) => {
        const { showCloud, figure } = await import('/examples/sciviz-cloud.ts');
        await showCloud(name);
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const copy = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = copy.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let lit = 0,
          hash = 2166136261;
        for (let y = (copy.height / 4) | 0; y < (copy.height * 3) / 4; y++)
          for (let x = (copy.width / 4) | 0; x < (copy.width * 3) / 4; x++) {
            const i = (y * copy.width + x) * 4;
            if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 65) lit++;
            hash = Math.imul(hash ^ pixels[i] ^ (pixels[i + 1] << 8) ^ (pixels[i + 2] << 16), 16777619);
          }
        return { lit, hash, status: document.querySelector('#status').textContent, layers: figure.layers.length };
      }, name);
      assert(images[name].lit > 1000, `${name} draws volume pixels`);
      assert.equal(images[name].layers, 1, 'switching source retires the previous layer');
    }
    assert.equal(
      new Set(Object.values(images).map((i) => i.hash)).size,
      3,
      'all three scientific datasets draw different results',
    );
    assert.deepEqual(errors, []);
    reports.push({ compat, images, hardware: context.hardware });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/sciviz-omezarr-gpu.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
