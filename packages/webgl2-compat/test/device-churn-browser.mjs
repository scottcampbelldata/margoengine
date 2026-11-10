// Real-GPU regression test (run by `npm run test:gpu`): fresh devices, one after another, each drawing a 256x128 sphere
// (65,536 triangles) and showing it on a canvas, must all show their frame. The layer used to present with a y-flipped
// blitFramebuffer and a colour-masked clear. On a Radeon 680M under Edge's ANGLE D3D11 backend (driver 32.0.21030.2001)
// that present, with frames reaching the page as ImageBitmaps of the context and the layer's fence syncs, hung the GPU
// (DXGI_ERROR_DEVICE_HUNG) in about one device of ten: the browser restarted its GPU process, the frame stayed empty,
// and after the third restart WebGL was blocked for the page ("WebGPU adapter unavailable"). The materials features
// test failed 2 of 2 that way at a different step each run. The texel-fetch present (Replayer.presentTexture) never
// hung in 60 devices; see docs/known-bugs.md "Fixed: ANGLE D3D11 on an AMD driver hung the GPU".
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const DEVICES = 30;
const context = await openBrowser({ startPath: '/packages/materials/test/features.html', port: 'free', compat: true });
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
try {
  await page.waitForFunction(() => window.ready === true, null, { timeout: 120_000 });
  for (let device = 0; device < DEVICES; device++) {
    // The eye check makes its own engine and device, draws the sphere twice, reads the middle row and disposes it.
    const got = await page.evaluate((v) => window.check.eyeRun(v), {
      angle: device % 2 ? 0.6 : 0,
      ior: 1.376,
      pupil: 0.3,
    });
    assert.deepEqual(got.errors, [], `device ${device}`);
    // The white sclera fills most of the middle row; an empty frame (lost context) reads 0 everywhere.
    const lit = got.row.filter((v) => v > 64).length;
    assert.ok(lit > 100, `device ${device}: the frame is empty (${lit} lit pixels on the middle row)`);
  }
  assert.deepEqual(pageErrors, []);
  console.log(`ok - compat device churn: ${DEVICES} fresh devices, every frame shown`);
} finally {
  await context.close();
}
