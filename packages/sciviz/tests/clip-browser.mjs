import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-clip.html', port: 'free', compat }), errors = [];
  browser.page.on('pageerror', e => errors.push(e.message)); browser.page.setDefaultTimeout(120000);
  try {
    await Promise.race([
      browser.page.waitForFunction(() => document.querySelector('#status').textContent.includes('retained cells')),
      new Promise((_, reject) => browser.page.once('pageerror', reject)),
    ]);
    await browser.page.screenshot({ path: `test-results/batch172-clip-${compat ? 'compat' : 'native'}.png` });
    const result = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-clip.ts');
      const pixels = async figure => {
        const image = await createImageBitmap(await figure.toPNG({ overlays: false })), canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
        context.drawImage(image, 0, 0); image.close(); const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0, hash = 2166136261;
        for (let i = 0; i < data.length; i += 4) { if (Math.max(...[0,1,2].map(k => Math.abs(data[i+k] - data[k]))) > 30) lit++; hash = Math.imul(hash ^ data[i] ^ data[i+1] << 8 ^ data[i+2] << 16, 16777619); }
        return { lit, hash };
      };
      const before = { count: demo.selected.types.length, pixels: await pixels(demo.ct) }, nasa = await pixels(demo.nasa);
      await demo.setThreshold(1000);
      const after = { count: demo.selected.types.length, pixels: await pixels(demo.ct) };
      const clippedCells = demo.clipped.types.length;
      demo.ct.dispose(); demo.nasa.dispose(); return { before, after, nasa, clippedCells };
    });
    assert.ok(result.before.count > result.after.count && result.after.count > 100, JSON.stringify(result));
    assert.ok(result.before.pixels.lit > 500 && result.after.pixels.lit > 500 && result.nasa.lit > 100, JSON.stringify(result));
    assert.notEqual(result.before.pixels.hash, result.after.pixels.hash); assert.ok(result.clippedCells > 100); assert.deepEqual(errors, []);
    console.log(`clip ${compat ? 'WebGL2' : 'WebGPU'} ${JSON.stringify(result)}`);
  } finally { await browser.close(); }
}
