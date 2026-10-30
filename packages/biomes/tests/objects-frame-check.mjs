// Frame time of the stored objects at the biome shots' cameras 01 and 02 (biome look round 2, landing D), run from the
// repository root after building packages:
//   node packages/biomes/tests/objects-frame-check.mjs
// Before landing D every tree, shrub and rock part drew its full mesh in all three LOD rings (150, 400 and 1,000 m);
// now each part draws @margoengine/procedural's detail 2, 1 and 0 meshes in them, switched hard (a dithered fade cost
// 1.2 ms at 01 and 5.6 ms at 02 with shadows, over the 0.5 ms allowed for one). Median ms of 150 frames, 1440x900, RTX
// A6000, two runs each, alternating, on a quiet machine (Edge; before = origin/main 0882df47 with biome-sea, biome-l6
// and landings A and B, the same page):
//   camera, shadows   before        after
//   01, off           20.1, 19.8    4.1, 4.0
//   01, on            53.2, 53.4    9.0, 8.9
//   02, off           23.4, 23.5    7.0, 7.0
//   02, on            63.4, 63.4    15.8, 15.5
// Limits on that machine: 01 at least 30 percent under before (at most 0.7 times its faster run), 02 under before.
// Other GPUs print their times: the before figures are this machine's.
// A timing test: it holds the GPU exclusively (scripts/gpu-lock.mjs), so no other suite draws while it measures.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const BEFORE = { '01 off': 19.8, '01 on': 53.2, '02 off': 23.4, '02 on': 63.4 };
const release = await acquire({ owner: 'biomes-objects-frame', mode: 'exclusive', max: 10 });
const context = await openBrowser({ startPath: '/packages/biomes/tests/objects-frame-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu), hardware.webglRenderer);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const times = {};
    for (const name of ['01', '02'])
      for (const shadows of [false, true]) {
        const r = await page.evaluate(([n, s]) => window.check.frame(n, s), [name, shadows]),
          key = `${name} ${shadows ? 'on' : 'off'}`;
        assert.deepEqual(r.errors, []);
        times[key] = r;
        console.log(
          `camera ${name}, shadows ${shadows ? 'on' : 'off'}: median ${r.median.toFixed(2)} ms, mean ${r.mean.toFixed(2)} ms (before ${BEFORE[key]} ms on the RTX A6000)`,
        );
      }
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/biomes-objects-frame.json', JSON.stringify({ hardware, times }, null, 1));
    assert.deepEqual(pageErrors, []);
    if (!/RTX A6000/.test(hardware.webglRenderer ?? '')) {
      console.log("ok biomes objects frame: times printed (the before figures are the RTX A6000 machine's)");
      return;
    }
    for (const shadows of ['off', 'on']) {
      const at01 = times[`01 ${shadows}`].median,
        at02 = times[`02 ${shadows}`].median;
      assert.ok(
        at01 <= 0.7 * BEFORE[`01 ${shadows}`],
        `camera 01, shadows ${shadows}: ${at01.toFixed(2)} ms, before ${BEFORE[`01 ${shadows}`]} ms`,
      );
      assert.ok(
        at02 < BEFORE[`02 ${shadows}`],
        `camera 02, shadows ${shadows}: ${at02.toFixed(2)} ms, before ${BEFORE[`02 ${shadows}`]} ms`,
      );
    }
    console.log('ok biomes objects frame: cameras 01 and 02 within their limits');
  },
  async () => {
    try {
      await context.close();
    } finally {
      release();
    }
  },
);
watchExit();
