// Browser check (`npm run test:browser`, run by check:merge): probeWebGL2 and webgl2Capabilities from the built
// package in the default test browser. The machine's WebGL2 must reach the `full` tier (every back end measured for
// the roadmap does), the probe must leave no context behind, and an exact-pixel context stays exact-pixel.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { probeScript } from '../scripts/probe-script.mjs';

const browser = await launchBrowser({ needs: 'none', headless: true });
try {
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addScriptTag({ content: probeScript() });
  const result = await page.evaluate(() => {
    const { probeWebGL2, webgl2Capabilities } = globalThis.__compat;
    const probed = probeWebGL2();
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false });
    const read = gl && webgl2Capabilities(gl);
    return {
      probed,
      read: read && { tier: read.tier, supported: read.supported },
      antialias: gl?.getContextAttributes()?.antialias,
    };
  });
  assert.ok(result.probed, 'probeWebGL2() found no WebGL2 in the test browser');
  assert.equal(result.probed.tier, 'full', `tier ${result.probed.tier}; missing ${result.probed.missing.join(', ')}`);
  assert.equal(result.probed.supported, true);
  assert.deepEqual(result.probed.missing, []);
  assert.equal(result.probed.highpFragment, true);
  assert.ok(result.probed.limits.MAX_DRAW_BUFFERS >= 4);
  assert.deepEqual(result.read, { tier: 'full', supported: true });
  assert.equal(result.antialias, false, 'an antialias: false context must stay exact-pixel');
  assert.deepEqual(errors, []);
  console.log(`webgl2-compat browser check: tier ${result.probed.tier} on ${result.probed.renderer}`);
} finally {
  await browser.close();
}
