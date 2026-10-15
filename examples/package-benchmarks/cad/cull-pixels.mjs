// Real-GPU check that per-batch back-face culling changes no pixel: core built from a reference commit (default dc0c4ff,
// the last core without it) and today's core render the same mixed scene through the same edits (cull-pixels.js), and
// every step's frames must be identical. Run from the repository root after building packages, holding the GPU lock:
//   node examples/package-benchmarks/cad/cull-pixels.mjs [--ref=<commit>]
// Builds the reference core with tsc into test-results/core-ref/ (ignored).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const ref = process.argv.find((a) => a.startsWith('--ref='))?.slice(6) ?? 'dc0c4ff',
  dir = 'test-results/core-ref';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
execFileSync('git', ['archive', '-o', `${dir}/src.tar`, ref, 'packages/core/src', 'packages/core/tsconfig.json']);
execFileSync('tar', ['-xf', 'src.tar'], { cwd: dir });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `${dir}/packages/core/tsconfig.json`], {
  stdio: 'inherit',
});

const context = await openBrowser({ startPath: '/examples/package-benchmarks/cad/cull-pixels.html', port: 5221 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
try {
  console.log('reference', ref, 'adapter', JSON.stringify(hardware.webgpu), hardware.browserVersion);
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.check.setup());
  let culled = 0;
  for (let i = 0, steps = await page.evaluate(() => window.check.steps); i < steps; i++) {
    const r = await page.evaluate((i) => window.check.step(i), i),
      [x, y] = [await shot('a'), await shot('b')];
    let differing = 0,
      lit = 0;
    for (let p = 0; p < x.data.length; p += 4) {
      if (x.data[p] !== y.data[p] || x.data[p + 1] !== y.data[p + 1] || x.data[p + 2] !== y.data[p + 2]) differing++;
      if (x.data[p] + x.data[p + 1] + x.data[p + 2] > 120) lit++;
    }
    console.log(
      `step ${i}: ${r.label}: ${differing} of ${x.width * x.height} pixels differ, ${lit} lit, visible ${r.visible}, pipelines ${r.pipelines.join(' > ')}`,
    );
    assert.equal(differing, 0, `${r.label}: frames differ`);
    assert.ok(lit > 2000, `${r.label}: scene not visible`);
    assert.equal(r.visible[0], r.visible[1]);
    culled += r.pipelines.includes('back/no-discard');
  }
  assert.ok(culled >= 5, 'the culled pipeline was used');
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
  console.log(`back-face culling pixel check passed (culled pipeline used in ${culled} steps)`);
} finally {
  await context.close();
}
