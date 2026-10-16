// exportModel's canvas paths in a real browser (no WebGPU needed): ImageBitmap sources encode through OffscreenCanvas,
// flipY flips rows, maxTextureSize shrinks, raw rows stay unflipped. Each PNG is decoded back by the browser itself.
// Run after building the package: node packages/exporters/tests/png-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: false,
  logLevel: 'error',
  server: { port: 0 },
});
await server.listen();
let browser;
try {
  const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
  browser = await chromium.launch({ headless: true, channel: channel === 'bundled' ? undefined : channel });
  const page = await browser.newPage();
  await page.goto(`${server.resolvedUrls.local[0]}package.json`);
  const result = await page.evaluate(async () => {
    const { png } = await import('/dist/png.js');
    const decode = async (bytes) => {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return {
        width: bitmap.width,
        height: bitmap.height,
        data: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data),
      };
    };
    const pixels = (w, h) =>
      Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 37 + 11) % 256));
    const image = new ImageData(pixels(4, 2), 4, 2),
      bitmap = await createImageBitmap(image);
    const big = await createImageBitmap(new ImageData(pixels(64, 32), 64, 32));
    return {
      source: Array.from(image.data),
      plain: await decode(await png(bitmap, Infinity, false)),
      flipped: await decode(await png(bitmap, Infinity, true)),
      raw: await decode(await png({ width: 4, height: 2, data: new Uint8Array(image.data) }, Infinity, true)),
      shrunk: await decode(await png(big, 16, true)),
      rawShrunk: await decode(await png({ width: 6, height: 3, data: new Uint8Array(pixels(6, 3)) }, 3, false)),
    };
  });
  const row = (data, y) => data.slice(y * 16, y * 16 + 16);
  assert.deepEqual(result.plain, { width: 4, height: 2, data: result.source }, 'bitmap, no flip');
  assert.deepEqual(result.flipped.data, [...row(result.source, 1), ...row(result.source, 0)], 'bitmap, flipped rows');
  assert.deepEqual(result.raw.data, result.source, 'raw rows never flip');
  assert.deepEqual([result.shrunk.width, result.shrunk.height], [16, 8], 'maxTextureSize 16 on 64x32');
  assert.deepEqual([result.rawShrunk.width, result.rawShrunk.height], [3, 2], 'maxTextureSize 3 on raw 6x3');
  console.log(`png-browser: 5 checks passed (${browser.version()})`);
} finally {
  await browser?.close();
  await server.close();
}
