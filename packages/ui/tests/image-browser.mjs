import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/packages/ui/tests/image.html', port: 'free' }),
  { page } = browser;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(60000);
try {
  for (const preview of [false, true]) {
    if (preview) await page.goto(page.url().split('?')[0] + '?preview');
    await page.waitForFunction(() => window.imageTest);
    // Preview loads its painter lazily. Wait for a submitted UI draw, rather than assuming two frames load it.
    await page.waitForFunction(() => {
      const t = window.imageTest;
      t.engine.render(0);
      return t.renderer.stats.drawCalls > 0;
    });
    const data = await page.evaluate(async () => {
      const t = window.imageTest;
      await t.frame();
      const f = await t.frame();
      return {
        pixels: [
          [12, 12],
          [67, 12],
          [12, 67],
          [67, 67],
          [40, 40],
          [92, 12],
          [148, 68],
          [180, 15],
          [180, 40],
          [30, 130],
        ].map(([x, y]) => f.at(x, y)),
        stats: f.stats,
        width: t.realTexture.width,
        errors: t.errors,
      };
    });
    const expected = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [255, 255, 255],
      [0, 255, 0],
      [0, 255, 0],
      [16, 16, 16],
      [255, 0, 255],
    ];
    expected.forEach((rgb, i) =>
      rgb.forEach((n, c) =>
        assert.ok(
          Math.abs(n - data.pixels[i][c]) <= 3,
          `preview=${preview} pixel ${i}: ${data.pixels[i]} expected ${rgb}`,
        ),
      ),
    );
    assert.equal(data.width, 1024);
    assert.ok(
      data.pixels[9].some((n, i) => i < 3 && n > 30),
      'real image draws',
    );
    assert.equal(data.stats.uploads, 0, 'unchanged frame reuses uploads');
    assert.deepEqual(data.errors, []);
    const snapshot = await page.evaluate(async () => {
      const { ImageTexture } = window.imageTest;
      const canvas = new OffscreenCanvas(8, 4),
        context = canvas.getContext('2d');
      context.fillStyle = '#ff0000';
      context.fillRect(0, 0, 8, 4);
      const video = new VideoFrame(canvas, { timestamp: 0 });
      try {
        const image = ImageTexture.from(video);
        return {
          width: image.width,
          height: image.height,
          pixel: [...image.tiles({ x: 0, y: 0, width: 8, height: 4 })[0].bitmap.data.slice(0, 4)],
        };
      } finally {
        video.close();
      }
    });
    assert.deepEqual(snapshot, { width: 8, height: 4, pixel: [255, 0, 0, 255] });
    const updated = await page.evaluate(async () => {
      window.imageTest.cell.tint = [0, 0, 0, 1];
      return (await window.imageTest.frame()).at(120, 40);
    });
    assert.deepEqual(updated.slice(0, 3), [0, 0, 0]);
    await page.evaluate(() => window.imageTest.close());
  }
  assert.deepEqual(errors, []);
  console.log('Image atlas, nine-slice, fit, photographic texture, tint and cache checks passed on native and preview');
} finally {
  await browser.close();
}
