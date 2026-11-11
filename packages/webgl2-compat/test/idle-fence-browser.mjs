// onSubmittedWorkDone() after work drawn only into a texture resolves within a few fence polls (run by `npm run
// test:gpu`). Regression (2026-11-11, Chrome 157 on ANGLE Direct3D 11, RTX A6000): with only gl.flush() after the
// device's fence, a context that shows no frame saw the fence signal after about 17 polls (about 270 ms), and the
// materials owner/lifetime check, which waits after every render into its own target, ran past its 180 s limit on the
// layer. The count is of fence checks, a work count; no time is asserted.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const limit = setTimeout(() => {
  console.error('webgl2-compat idle-fence check exceeded its 120 second limit');
  process.exit(1);
}, 120000);
const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/features.html', port: 'free' });
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const polls = await page.evaluate(async () => {
    const { createCompatGPU } = await import('/packages/webgl2-compat/dist/device.js');
    const device = await (await createCompatGPU().requestAdapter()).requestDevice();
    const gl = device.gl,
      wait = gl.clientWaitSync;
    let checks = 0;
    gl.clientWaitSync = function (...args) {
      checks++;
      return wait.apply(this, args);
    };
    const target = device.createTexture({ size: [64, 32], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const counts = [];
    for (let i = 0; i < 7; i++) {
      const encoder = device.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [i / 7, 0, 0, 1] }],
        })
        .end();
      device.queue.submit([encoder.finish()]);
      checks = 0;
      await device.queue.onSubmittedWorkDone();
      counts.push(checks);
    }
    device.destroy();
    return counts.sort((a, b) => a - b);
  });
  const median = polls[polls.length >> 1];
  assert.ok(median <= 4, `onSubmittedWorkDone after a texture-only submit took ${median} fence checks (all: ${polls})`);
  assert.deepEqual(pageErrors, []);
  console.log(`webgl2-compat: onSubmittedWorkDone after a texture-only submit: ${polls.join(', ')} fence checks`);
} finally {
  clearTimeout(limit);
  await context.close();
}
