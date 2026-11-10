import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free', compat: false });
try {
  for (const compat of [false, true]) {
    if (compat) await browser.page.reload();
    const result = await browser.page.evaluate(async (compat) => {
      if (compat) {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        await install({ force: true });
      }
      const { createCompute } = await import('/packages/compute/dist/index.js');
      const { decompCases } = await import('/packages/compute/tests/decomp-cases.js');
      const ctx = await createCompute({ backend: 'webgpu' });
      try {
        return await decompCases(ctx);
      } finally {
        ctx.dispose();
      }
    }, compat);
    assert.equal(result, 67);
    console.log(`decomp: ${result} cases on ${compat ? 'WebGL2' : 'WebGPU'}`);
  }
} finally {
  await browser.close();
}
