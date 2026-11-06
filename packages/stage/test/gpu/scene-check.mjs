// Real-GPU check for addScene: a saved document with a sun, a point light, a spot light, a camera and four copies of one real
// glTF file, against the same scene built by hand. Frames must match to the byte and the file must be fetched once.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/stage/test/gpu/scene-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'stage-scene' });
try {
  const context = await openBrowser({ startPath: '/packages/stage/test/gpu/scene.html', port: 5331 }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    const r = await page.evaluate(() => window.check.run()),
      [a, b] = [await shot('a'), await shot('b')];
    let differ = 0,
      lit = 0;
    for (let k = 0; k < a.data.length; k += 4) {
      if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) differ++;
      if (a.data[k] > 40) lit++;
    }
    console.log(
      `${differ} differ, ${lit} lit pixels, fetched ${r.fetched} (by hand ${r.fetchedByHand}), ${r.models} models on ${r.assets} asset, draws ${r.draws}`,
    );
    assert.equal(differ, 0, 'the document matches the scene built by hand');
    assert.ok(lit > 10000, 'the scene is lit');
    assert.equal(r.fetched, 1, 'one fetch for four entities');
    assert.equal(r.fetchedByHand, 4);
    assert.deepEqual([r.models, r.assets], [4, 1]);
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('saved scene pixel check passed');
} finally {
  await release();
}
