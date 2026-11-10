// Real-GPU regression test (run by `npm run test:gpu`): the canvas present must not disturb the next frame's uniforms.
// The layer used to present with a y-flipped blitFramebuffer and a colour-masked clear. Chrome's ANGLE D3D11 backend
// makes both with shaders of its own, and after them the fragment uniform blocks of a later draw that changed no
// binding sometimes read zero: in 25 to 70 of every 100 page loads the 50,000-box frame of the materials vertex-input
// page drew every box black with its coverage intact (batch 166 job 2 hunt, RTX A6000; ANGLE Vulkan never did it).
// The present is now the layer's own texel-fetch draw (Replayer.presentTexture). Each load must show the same lit
// frame. Chrome's program cache is off, so every load compiles its programs as a first visit does (the cold-cache
// case failed most often).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const LOADS = 12;
const context = await openBrowser({
  startPath: '/packages/materials/test/vertex-inputs.html?bench',
  port: 'free',
  compat: true,
  args: ['--disable-gpu-program-cache', '--disable-gpu-shader-disk-cache'],
});
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
try {
  let first = null;
  for (let load = 0; load < LOADS; load++) {
    if (load) await page.reload();
    await page.waitForFunction(() => window.ready === true, null, { timeout: 60_000 });
    assert.deepEqual(await page.evaluate(() => window.errors), []);
    const image = await decodePNG(await page.locator('canvas').screenshot()),
      { data, width, height } = image,
      mid = ((height >> 1) * width + (width >> 1)) * 4;
    assert.ok(data[mid] + data[mid + 1] + data[mid + 2] > 0, `load ${load}: the boxes drew black`);
    if (!first) {
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] !== data[0] || data[i + 1] !== data[1]) lit++;
      assert.ok(lit > 5000, `the frame is nearly empty (${lit} lit pixels)`);
      first = data;
      continue;
    }
    let differing = 0;
    for (let i = 0; i < data.length; i++) if (data[i] !== first[i]) differing++;
    assert.equal(differing, 0, `load ${load}: ${differing} channels differ from the first load`);
  }
  assert.deepEqual(pageErrors, []);
  console.log(`ok - compat present: ${LOADS} loads of the 50,000-box frame, all lit and identical`);
} finally {
  await context.close();
}
