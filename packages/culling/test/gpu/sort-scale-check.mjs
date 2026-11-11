// Real-GPU check that FrontToBack orders 1,200,000 instances of one geometry, past the size where core's instance
// buffer outgrows one 128 MiB storage binding: frames match core's own to the byte and WebGPU reports no validation
// error. Wall time per frame is printed for the speed phase (diagnostic only).
// Takes a GPU slot itself. Run from the repository root after building packages, natively and with MARGO_COMPAT=1:
//   node packages/culling/test/gpu/sort-scale-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'culling-sort-scale' });
try {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/sort-scale.html', port: 5284 }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    const setup = await page.evaluate(() => window.check.setup());
    console.log(`filled 2 x 1,200,000 meshes in ${Math.round(setup.fillMs)} ms, binding ${setup.binding} B`);
    const views = [
      ['whole field', [0, 300, 900], [0, 0, 0]],
      ['facing out over a corner', [-500, 6, -500], [-560, 0, -560]],
    ];
    for (const [label, position, target] of views) {
      const r = await page.evaluate(([p, t]) => window.check.step(p, t), [position, target]),
        [a, b] = [await shot('a'), await shot('b')];
      let differing = 0;
      for (let k = 0; k < a.data.length; k += 4)
        if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) differing++;
      console.log(`${label}${compat ? ' (compat)' : ''}: ${differing} differ of ${r.total} sorted, wall ${r.wallMs.toFixed(1)} ms`);
      assert.equal(differing, 0, `${label}: sorted frame differs from core`);
    }
    assert.ok(setup.binding <= 128 * 1024 * 1024, `binding held to 128 MiB (${setup.binding})`);
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('front-to-back sort scale check passed');
} finally {
  await release();
}
