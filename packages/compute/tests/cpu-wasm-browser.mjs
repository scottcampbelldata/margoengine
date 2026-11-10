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
      const { createCpuWasm } = await import('/packages/compute/dist/cpu-wasm.js');
      await import('/packages/compute/tests/compute-cpu-browser.js');
      return await window.runCpuParityTests(createCpuWasm);
    }, compat);
    assert.ok(result.checks.length > 20);
    console.log(`cpu-wasm: ${result.checks.length} parity checks on ${compat ? 'WebGL2' : 'WebGPU'}`);
  }
} finally {
  await browser.close();
}
