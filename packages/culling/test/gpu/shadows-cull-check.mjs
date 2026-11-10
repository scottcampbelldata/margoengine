// Real-GPU check for @margoengine/culling/shadows: casters culled per cascade against the same scene drawing every caster in
// every cascade. Frames must match to the byte, and the near cascades must draw fewer casters than there are.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/shadows-cull-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'culling-shadows' });
try {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/shadows-cull.html', port: 5287 }),
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
    for (let i = 0; i < steps; i++) {
      const r = await page.evaluate((n) => window.check.step(n), i),
        [a, b, c, d] = [await shot('a'), await shot('b'), await shot('c'), await shot('d')],
        parts = differing(a, b),
        rows = differing(c, d);
      console.log(`step ${i} ${r.label}: ${parts} and ${rows} differ, parts ${r.parts}, rows ${r.rows} of ${r.count}`);
      assert.equal(parts, 0, `${r.label}: CascadeParts changed the frame`);
      assert.equal(rows, 0, `${r.label}: CascadeInstances changed the frame`);
      if (compat) {
        // The WebGL2 layer builds no cascade lists and draws every caster in every cascade (README, "Shadows per
        // cascade"), so both classes resolve no lists and the frames above equal the plain classes'.
        assert.deepEqual(r.parts, [], `${r.label}: compat: CascadeParts keeps no lists`);
        assert.deepEqual(r.rows, [], `${r.label}: compat: CascadeInstances keeps no lists`);
        continue;
      }
      assert.equal(r.parts.length, 3, `${r.label}: a list per cascade`);
      assert.ok(r.parts[0] < r.count / 2, `${r.label}: the nearest cascade drops parts (${r.parts[0]})`);
      assert.ok(r.rows[0] < r.count / 2, `${r.label}: the nearest cascade drops rows (${r.rows[0]})`);
      assert.deepEqual(r.parts, r.rows, `${r.label}: both classes keep the same casters`);
    }
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('cascade shadow culling pixel check passed');
} finally {
  await release();
}
