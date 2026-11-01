// Real-GPU check for CulledParts' picking, hierarchy, shadows and streaming: engine A draws boxes as parts, engine B
// the same boxes as core meshes. Every step's frames must match, with and without shadows, in frustum and occlusion
// culling; picks must name the box engine.pick names; part counts follow adds and removes; shadows must darken the floor.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/parts-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'culling-parts' });
const unlit = new Map();
try {
  for (const shadows of [false, true])
    for (const culling of ['frustum', 'occlusion']) {
      const context = await openBrowser({ startPath: '/packages/culling/test/gpu/parts.html', port: 5281 }),
        { page } = context,
        pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(m.text());
      });
      const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
      try {
        await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
        await page.evaluate(([s, c]) => window.check.setup(s, c), [shadows, culling]);
        const steps = await page.evaluate(() => window.check.steps);
        for (let i = 0; i < steps; i++) {
          const r = await page.evaluate((n) => window.check.step(n), i),
            [a, b] = [await shot('a'), await shot('b')];
          let differing = 0,
            darker = 0,
            lit = 0;
          const key = `${culling} ${i}`,
            before = unlit.get(key);
          for (let k = 0; k < a.data.length; k += 4) {
            if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2])
              differing++;
            if (a.data[k] + a.data[k + 1] + a.data[k + 2] > 120) lit++;
            if (before && before[k] > a.data[k] + 10) darker++;
          }
          if (!shadows) unlit.set(key, a.data);
          console.log(
            `${shadows ? 'shadows' : 'plain'} ${culling} step ${i} ${r.label}: ${differing} differ, ${lit} lit, ${darker} darker than unshadowed, ${r.alive} alive, ${r.drawn} drawn`,
          );
          assert.equal(differing, 0, `${r.label}: parts differ from core meshes`);
          assert.ok(lit > 1500, `${r.label}: scene not visible`);
          assert.equal(r.alive, r.expected, `${r.label}: part count`);
          assert.ok(r.drawn <= r.alive, `${r.label}: drawn count`);
          if (shadows) assert.ok(darker > 500, `${r.label}: parts cast a shadow (${darker} pixels darker)`);
        }
        const picks = await page.evaluate(() => window.check.picks()),
          hits = picks.filter(([p]) => p !== null).length;
        assert.deepEqual(
          picks.map(([p]) => p),
          picks.map(([, q]) => q),
          'the part pick names the box engine.pick names',
        );
        assert.ok(hits > 10, `picks hit parts (${hits})`);
        console.log('picks', hits, 'of', picks.length, 'hit, the same box on both engines');
        assert.deepEqual(await page.evaluate(() => window.check.errors), []);
        assert.deepEqual(pageErrors, []);
      } finally {
        // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
        await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
      }
    }
  console.log('culled parts pixel check passed');
} finally {
  await release();
}
