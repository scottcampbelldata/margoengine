// Real-GPU check for @margoengine/culling/occlusion: behind a wall a box and a core mesh read occluded, a box in front
// reads visible; from the wall's side all three are visible; back again they hide. Run from the repository root after
// building packages, on WebGPU and (with --compat) on the WebGL2 compatibility layer:
//   node packages/culling/test/gpu/occlusion-queries-check.mjs [--compat]
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { compatRun } from '../../../../scripts/support/compat-shim.js';

const compat = compatRun();
const context = await openBrowser({
    startPath: '/packages/culling/test/gpu/occlusion-queries.html',
    port: 'free',
  }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const want = [
    ['behind the wall', { front: false, behind: true, mesh: true }],
    ['from the side', { front: false, behind: false, mesh: false }],
    ['back behind the wall', { front: false, behind: true, mesh: true }],
  ];
  for (const exact of [false, true]) {
    await page.evaluate((x) => window.check.setup(x), exact);
    for (let i = 0; i < want.length; i++) {
      const [label, occluded] = want[i],
        r = await page.evaluate((n) => window.check.step(n), i);
      console.log(`${compat ? 'webgl2-layer' : 'webgpu'} ${exact ? '1x' : 'msaa'} ${label}: ${JSON.stringify(r)}`);
      for (const key of Object.keys(occluded)) {
        assert.ok(r[key].known, `${label}: ${key} has a result`);
        assert.equal(r[key].occluded, occluded[key], `${label}: ${key} occluded`);
        assert.equal(r[key].samples > 0, !occluded[key], `${label}: ${key} samples ${r[key].samples}`);
      }
    }
    await page.evaluate(() => window.check.dispose());
  }
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hang past 15 s
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
console.log(`occlusion queries check passed (${compat ? 'webgl2-layer' : 'webgpu'})`);
