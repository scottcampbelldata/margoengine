// A frame on the page survives device.destroy() in the task that drew it (run by `npm run test:gpu`). The layer loses
// its WebGL2 context on destroy, and an image of that context on a bitmaprenderer canvas is no longer valid: Chrome 157
// on macOS crashed the tab at its next commit ("Target crashed", null ClientSharedImage in ImageLayerBridge). WebGPU
// keeps showing the last frame, so the layer must too; the churn below forces the commits, the read proves the frame.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/features.html', port: 'free' });
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  for (const size of [32, 300]) {
    const pixel = await page.evaluate(async (size) => {
      const { CompatCanvasContext, createCompatGPU } = await import('/packages/webgl2-compat/dist/device.js');
      const adapter = await createCompatGPU().requestAdapter(),
        device = await adapter.requestDevice(),
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      document.body.append(canvas);
      const gpuContext = new CompatCanvasContext(canvas, HTMLCanvasElement.prototype.getContext);
      gpuContext.configure({ device, format: 'rgba8unorm' });
      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view: gpuContext.getCurrentTexture().createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0.2, 0.4, 0.8, 1],
            },
          ],
        })
        .end();
      device.queue.submit([encoder.finish()]);
      device.destroy();
      // fixed-wait: the crash comes at a page commit after destroy, and nothing signals that one has happened
      for (let i = 0; i < 12; i++) {
        canvas.style.marginLeft = `${i % 3}px`;
        document.body.append(document.createElement('div'));
        await new Promise(requestAnimationFrame);
      }
      const read = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      read.canvas.width = read.canvas.height = size;
      read.drawImage(canvas, 0, 0);
      const data = [...read.getImageData(size >> 1, size >> 1, 1, 1).data];
      canvas.remove();
      return data;
    }, size);
    assert.deepEqual(pixel, [51, 102, 204, 255], `the ${size} px canvas lost its last frame`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('webgl2-compat: the last frame stays on the page after device.destroy() in the same task');
} finally {
  await context.close();
}
