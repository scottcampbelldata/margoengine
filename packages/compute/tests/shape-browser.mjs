import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free', compat: false });
try {
  for (const compat of [false, true]) {
    if (compat) await context.page.reload();
    const result = await context.page.evaluate(async (compat) => {
      if (compat) {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        await install({ force: true });
      }
      const { createCompute } = await import('/packages/compute/dist/index.js');
      const { shapeCases } = await import('/packages/compute/tests/shape-cases.js');
      const gpu = await createCompute({ backend: 'webgpu' });
      try {
        return await shapeCases(gpu);
      } finally {
        gpu.dispose();
      }
    }, compat);
    assert.equal(result, 30);
    console.log(`shape: ${result} exact cases on ${compat ? 'WebGL2 compatibility' : 'WebGPU'}`);
  }
} finally {
  await context.close();
}
