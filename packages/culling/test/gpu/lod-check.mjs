// Real-GPU check for LodInstances: levels picked on the GPU against the same scene as core meshes with levels worked out
// on the CPU. Frames must match to the byte.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/lod-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'culling-lod' });
try {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/lod.html', port: 5288 }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
  const differing = (x, y) => {
    let n = 0;
    for (let k = 0; k < x.data.length; k += 4) {
      if (x.data[k] !== y.data[k] || x.data[k + 1] !== y.data[k + 1] || x.data[k + 2] !== y.data[k + 2]) n++;
    }
    return n;
  };
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    await page.evaluate(() => window.check.setup());
    const steps = await page.evaluate(() => window.check.steps);
    let seen = [0, 0, 0];
    for (let i = 0; i < steps; i++) {
      const r = await page.evaluate((n) => window.check.step(n), i),
        [a, b] = [await shot('a'), await shot('b')],
        n = differing(a, b);
      console.log(`step ${i} ${r.label}: ${n} differ, drawn ${r.counts}, of ${r.expected} in front`);
      assert.equal(n, 0, `${r.label}: frame differs from core`);
      r.counts.forEach((c, l) => {
        assert.ok(c <= r.expected[l], `${r.label}: level ${l} drew more than the scene holds`);
        seen[l] += c;
      });
    }
    assert.ok(seen.every((c) => c > 0), `every level drew (${seen})`);
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('LOD pixel check passed');
} finally {
  await release();
}
