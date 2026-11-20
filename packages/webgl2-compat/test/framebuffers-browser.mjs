// A steady frame of the post scene builds no framebuffer (KB-COMPAT-FRAMEALLOC1; run by `npm run test:gpu`). The page
// (framebuffers.html) draws a PostStack of SSAO, Bloom, tone mapping and FXAA on the layer and counts, over 60 frames after
// 30 warm-up frames, the device's framebuffer() builds and the createFramebuffer, deleteFramebuffer and createTexture calls.
// Before the fix the sampled multisampled depth texture made a new resolved-copy subresource every frame, so every frame
// built one framebuffer again (1,033 B a frame) and made no GL object: no leak, a rebuild.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/framebuffers.html', port: 'free', compat: false });
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  assert.deepEqual(await page.evaluate(() => window.check.errors()), [], 'page errors');
  const made = await page.evaluate(() => window.check.steady());
  console.log(`post scene, 60 steady frames on the layer: ${JSON.stringify(made)}`);
  assert.deepEqual(made, { builds: 0, createFramebuffer: 0, deleteFramebuffer: 0, createTexture: 0 });
  assert.deepEqual(pageErrors, []);
  console.log('webgl2-compat: a steady post frame creates and deletes no framebuffer or texture');
} finally {
  await context.close();
}
