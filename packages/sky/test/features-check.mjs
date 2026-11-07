// Real-GPU proof of the newer optional sky entries (run from the repository root after building packages, one GPU job
// at a time): node packages/sky/test/features-check.mjs [name...]
// Each page compiles its entry's shaders on the browser's WebGPU and reads back Bloom's HDR scene capture; the bounds
// below are what each feature must do, not a picture match.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const checks = {
  async volumetric(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    for (const name of ['ground', 'inside', 'above']) {
      const v = r[name];
      // Coverage 0 draws nothing at all.
      assert.equal(v.zero, 0, `${name}: coverage 0 changed ${v.zero} pixels`);
      // The default coverage (0.5) fills a good part of the view with cloud; from inside or above the layer, nearly all of it.
      const least = name === 'ground' ? 0.2 : 0.6;
      assert.ok(v.shown.changed > v.shown.total * least, `${name}: clouds drew ${JSON.stringify(v.shown)}`);
      // A minute of wind and evolution moves and changes the clouds.
      assert.ok(v.evolved.changed > v.shown.changed * 0.05, `${name}: a minute later ${JSON.stringify(v.evolved)}`);
    }
    // The pillar 30 m away is in front of every cloud (the base is 1,500 m up): not one of its pixels changes.
    assert.ok(r.pillar.total > 50, `pillar mask ${JSON.stringify(r.pillar)}`);
    assert.equal(r.pillar.changed, 0, `clouds drew over the near pillar: ${JSON.stringify(r.pillar)}`);
    // The block 160 m ahead of a camera inside dense cloud is veiled by the cloud in between.
    assert.ok(r.block.changed > r.block.total * 0.9, `cloud in front of the block: ${JSON.stringify(r.block)}`);
    assert.equal(r.noDepth.pillar.changed, 0, `without depth the clouds covered geometry: ${JSON.stringify(r.noDepth)}`);
    assert.ok(r.noDepth.sky.changed > r.noDepth.sky.total * 0.2, `without depth: ${JSON.stringify(r.noDepth)}`);
    console.log(
      `ok volumetric ${samples}x: ground ${r.ground.shown.changed}/${r.ground.shown.total}, inside ${r.inside.shown.changed}, above ${r.above.shown.changed}; frame ${r.ground.ms.toFixed(1)} / ${r.inside.ms.toFixed(1)} / ${r.above.ms.toFixed(1)} ms (diagnostic)`,
    );
    return r;
  },
  async 'cloud-shadows'(page, samples) {
    const points = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 8; j++) points.push([i * 310 - 800, j * 290 - 1000]);
    // The view toward the sun weighs cloud at distance t by exp(-t / 40 km) (the haze); along this sun (y = 0.960) the
    // layer from 1,500 to 2,500 m lies 1,562 to 2,604 m away, so the seen opacity is the shadow's times 0.937 to 0.962.
    const low = Math.exp(-2604 / 40000),
      high = Math.exp(-1562 / 40000),
      error = (shadows, views) =>
        views.reduce((sum, v, i) => sum + Math.abs(v.opacity - (1 - shadows[i].shadow) * (low + high) / 2), 0) / views.length;
    const first = await page.evaluate((p) => window.check.read(p), points);
    assert.equal(first.error, null);
    assert.deepEqual(first.errors, []);
    const shaded = first.points.filter((p) => p.shadow < 0.5).length,
      open = first.points.filter((p) => p.shadow > 0.9).length;
    assert.ok(shaded >= 5 && open >= 5, `shadow and light both on the ground: ${shaded} shaded, ${open} open`);
    for (const [i, p] of first.points.entries()) {
      assert.ok(p.open > 0.1 && p.background < 0.5, `point ${i} reads: ${JSON.stringify(p)}`);
      // Beyond the haze, the two marches differ only in sampling (24 midpoint samples toward the sun against 64 jittered
      // view steps): 0.05 allows that on a cloud edge, some eight times the largest difference measured (0.006).
      assert.ok(
        p.opacity >= (1 - p.shadow) * low - 0.05 && p.opacity <= (1 - p.shadow) * high + 0.05,
        `point ${i}: seen opacity ${p.opacity.toFixed(3)}, shadow ${p.shadow.toFixed(3)}`,
      );
    }
    const matched = error(first.points, first.points);
    assert.ok(matched < 0.01, `mean difference ${matched}`);
    // Move the clouds 1,500 m: the old shadows no longer match the clouds now seen, the new shadows do.
    await page.evaluate(() => window.check.advance(1500));
    const second = await page.evaluate((p) => window.check.read(p), points),
      stale = error(first.points, second.points),
      moved = error(second.points, second.points);
    assert.ok(moved < 0.01 && stale > matched * 10, `matched ${matched}, moved ${moved}, stale ${stale}`);
    console.log(
      `ok cloud-shadows ${samples}x: ${shaded} shaded and ${open} open of ${points.length}; mean difference ${matched.toFixed(4)}, after 1,500 m ${moved.toFixed(4)}, stale shadows ${stale.toFixed(4)}`,
    );
    return { first, second, matched, moved, stale };
  },
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks);
const context = await openBrowser({ startPath: '/packages/sky/test/volumetric-check.html', port: 5213 }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  for (const name of names) {
    for (const samples of [4, 1]) {
      await page.goto(`http://127.0.0.1:5213/packages/sky/test/${name}-check.html${samples === 1 ? '?samples=1' : ''}`);
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      assert.equal(await page.evaluate(() => window.check.samples()), samples);
      report.results[`${name} ${samples}x`] = await checks[name](page, samples);
    }
  }
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sky-features-check.json', JSON.stringify(report, null, 1));
  console.log('sky features check passed');
} finally {
  await context.close();
}
