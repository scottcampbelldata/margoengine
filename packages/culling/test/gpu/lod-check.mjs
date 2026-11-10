// Real-GPU check for LodInstances: levels picked on the GPU against the same scene as core meshes with levels worked out
// on the CPU. Frames must match to the byte, and a redraw of an unchanged frame must keep each level's instances in
// instance order, to the byte (batch 132: an atomicAdd slot per instance reordered them from frame to frame on the M6).
// Under MARGO_COMPAT=1 the WebGL2 layer has no compute and draws every shown instance at the first level by design, so
// core's side draws the same and "every level drew" is skipped with a printed note.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/lod-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'culling-lod' });
try {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/lod.html', port: 5288 }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
  // Redraws both engines with nothing changed; A's new frame must equal its last to the byte (an atomicAdd slot per
  // instance changed each level's draw order from frame to frame, and with it MSAA edges on the M6).
  const repeats = async (label) => {
    const before = await shot('a'),
      first = await page.evaluate(() => window.check.order());
    await page.evaluate(() => window.check.redraw());
    const after = await shot('a'),
      second = await page.evaluate(() => window.check.order());
    assert.deepEqual(second, first, `${label}: a redraw changes the order of a level's instances`);
    first.forEach((list, l) =>
      assert.ok(
        list.every((n, k) => n >= 0 && (k === 0 || n > list[k - 1])),
        `${label}: level ${l} is not in instance order (${list.slice(0, 12)})`,
      ),
    );
    assert.ok(
      Buffer.from(after.data).equals(Buffer.from(before.data)),
      `${label}: a redraw differs (${differing(before, after)} pixels)`,
    );
  };
  const differing = (x, y) => {
    let n = 0;
    for (let k = 0; k < x.data.length; k += 4) {
      if (x.data[k] !== y.data[k] || x.data[k + 1] !== y.data[k + 1] || x.data[k + 2] !== y.data[k + 2]) n++;
    }
    return n;
  };
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    await page.evaluate((c) => window.check.setup(c), compat);
    const steps = await page.evaluate(() => window.check.steps);
    const seen = [0, 0, 0];
    for (let i = 0; i < steps; i++) {
      const r = await page.evaluate((n) => window.check.step(n), i),
        [a, b] = [await shot('a'), await shot('b')],
        n = differing(a, b);
      console.log(`step ${i} ${r.label}: ${n} differ, drawn ${r.counts}, of ${r.expected} in front`);
      await repeats(r.label);
      assert.equal(n, 0, `${r.label}: frame differs from core`);
      r.counts.forEach((c, l) => {
        assert.ok(c <= r.expected[l], `${r.label}: level ${l} drew more than the scene holds`);
        seen[l] += c;
      });
    }
    if (compat) console.log('compat draws every shown instance at the first level, "every level drew" skipped');
    else
      assert.ok(
        seen.every((c) => c > 0),
        `every level drew (${seen})`,
      );
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
