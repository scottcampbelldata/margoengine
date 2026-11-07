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
