import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free', compat: false });
try {
  for (const compat of [false, true]) {
    if (compat) await browser.page.reload();
    const checks = await browser.page.evaluate(async (compat) => {
      if (compat) {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        await install({ force: true });
      }
      const { createCompute } = await import('/packages/compute/dist/index.js');
      const { quantCases } = await import('/packages/compute/tests/quant-cases.js');
      using c = await createCompute({ backend: 'webgpu' });
      return await quantCases(c);
    }, compat);
    assert.ok(checks > 1000);
    console.log(`quant: ${checks} float-reference checks on ${compat ? 'WebGL2' : 'WebGPU'}`);
  }
} finally {
  await browser.close();
}
