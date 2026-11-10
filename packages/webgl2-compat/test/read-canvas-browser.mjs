// The canvas reads back the right way up through toDataURL and toBlob (run by `npm run test:gpu`). The layer shows a
// frame on a bitmaprenderer canvas as an ImageBitmap of its WebGL2 context; Chrome on macOS shows and draws that image
// upright but encoded it upside down in toDataURL and toBlob, so a screenshot of a compat page came out flipped
// (found by the splats GPU check under --compat). The top half is red and the bottom half blue.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/features.html', port: 'free' });
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const urls = await page.evaluate(async () => {
    const { installCompat, uninstallCompat } = await import('/packages/webgl2-compat/dist/device.js');
    const installed = await installCompat({ force: true });
    try {
      const device = await (await navigator.gpu.requestAdapter()).requestDevice(),
        canvas = document.body.appendChild(document.createElement('canvas'));
      canvas.width = canvas.height = 8;
      const gpuContext = canvas.getContext('webgpu');
      gpuContext.configure({
        device,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      });
      const pixels = new Uint8Array(8 * 8 * 4);
      for (let i = 0; i < 64; i++) pixels.set(i < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
      device.queue.writeTexture({ texture: gpuContext.getCurrentTexture() }, pixels, { bytesPerRow: 32 }, [8, 8]);
      // A render pass that keeps the written texels marks the canvas for showing, as a frame's passes do.
      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [{ view: gpuContext.getCurrentTexture().createView(), loadOp: 'load', storeOp: 'store' }],
        })
        .end();
      device.queue.submit([encoder.finish()]);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png')),
        bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const b of bytes) binary += String.fromCharCode(b);
      const result = [canvas.toDataURL(), `data:image/png;base64,${btoa(binary)}`];
      canvas.remove();
      device.destroy();
      return result;
    } finally {
      uninstallCompat();
    }
  });
  for (const [label, url] of [
    ['toDataURL', urls[0]],
    ['toBlob', urls[1]],
  ]) {
    const img = await decodePNG(Buffer.from(url.split(',')[1], 'base64')),
      at = (y) => [...img.data.subarray(y * img.width * 4, y * img.width * 4 + 3)];
    assert.deepEqual(
      [at(0), at(7)],
      [
        [255, 0, 0],
        [0, 0, 255],
      ],
      `${label} reads the canvas upside down`,
    );
  }
  assert.deepEqual(pageErrors, []);
  console.log('webgl2-compat: toDataURL and toBlob read the canvas the right way up');
} finally {
  await context.close();
}
