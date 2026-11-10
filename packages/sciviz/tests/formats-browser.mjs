// One real GPU leaf, two backends, all six writer-produced format variants.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const context = await openBrowser({ startPath: '/examples/sciviz-formats.html', port: 'free', compat });
  const { page } = context,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('canvas')?.dataset.ready === 'classic' ||
        document.querySelector('canvas')?.dataset.error,
      { timeout: 30_000 },
    );
    assert.equal(await page.locator('canvas').getAttribute('data-error'), null);
    const images = {};
    for (const format of ['classic', 'offset', 'vti', 'vts', 'vtu', 'legacy']) {
      images[format] = await page.evaluate(async (format) => {
        const { show, figure } = await import('/examples/sciviz-formats.ts');
        await show(format);
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0,
          hash = 2166136261;
        for (let y = (canvas.height * 0.2) | 0; y < canvas.height * 0.8; y++)
          for (let x = (canvas.width * 0.2) | 0; x < canvas.width * 0.8; x++) {
            const i = (y * canvas.width + x) * 4;
            if (Math.max(data[i], data[i + 1], data[i + 2]) > 65) lit++;
            hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619);
          }
        return { lit, hash, layers: figure.layers.length };
      }, format);
      assert(images[format].lit > 500, `${format} draws data pixels`);
      assert.equal(images[format].layers, 1, 'format switching retires the old layer');
    }
    assert.equal(images.classic.hash, images.offset.hash);
    assert.equal(images.classic.hash, images.vti.hash);
    assert.equal(images.vts.hash, images.vtu.hash);
    assert.equal(images.vtu.hash, images.legacy.hash);
    assert.deepEqual(errors, []);
    reports.push({ compat, images, hardware: context.hardware });
  } catch (error) {
    console.error(JSON.stringify({ errors, status: await page.locator('#status').textContent() }));
    throw error;
  } finally {
    await context.close();
  }
}
await writeFile('test-results/sciviz-fixes/formats-gpu.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
