// Real-GPU proof (run from the repository root after building packages, one GPU job at a time):
//   node packages/sky/test/browser-check.mjs
// Every demo sky configuration rendered with the full Sky and with `@margoengine/sky/base` plus only the features it
// uses must produce bit-identical HDR scene pixels (and reflection maps) on every frame, at 4x and at 1x MSAA.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { configs } from './configs.js';
const context = await openBrowser({ startPath: '/packages/sky/test/browser-check.html', port: 5211 }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  for (const samples of [4, 1]) {
    await page.goto(`http://127.0.0.1:5211/packages/sky/test/browser-check.html${samples === 1 ? '?samples=1' : ''}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    for (const name of Object.keys(configs)) {
      // `control` repeats the full Sky: it shows the comparison is deterministic, so a match with `narrow` means something.
      for (const variant of ['full', 'control', 'narrow']) {
        const r = await page.evaluate(([n, v]) => window.check.run(n, v), [name, variant]);
        assert.equal(r.error, null, `${name} ${variant}`);
        assert.deepEqual(r.errors, [], `${name} ${variant}`);
      }
      assert.equal(await page.evaluate(() => window.check.samples()), samples);
      for (const against of ['control', 'narrow']) {
        const frames = await page.evaluate((y) => window.check.compare('full', y), against);
        report.results[`${name} ${samples}x full vs ${against}`] = frames;
        for (const [i, frame] of frames.entries())
          for (const [image, result] of Object.entries(frame)) {
            assert.ok(
              result.lit > result.pixels / 2,
              `${name} ${samples}x frame ${i} ${image} rendered too little: ${JSON.stringify(result)}`,
            );
            assert.equal(
              result.differing,
              0,
              `${name} ${samples}x frame ${i} ${image} vs ${against}: ${JSON.stringify(result)}`,
            );
          }
      }
      const frames = report.results[`${name} ${samples}x full vs narrow`];
      console.log(`ok ${name} ${samples}x: ${frames.length} frames identical`);
    }
  }
  assert.deepEqual(pageErrors, []);
  await writeFile('test-results/sky-entries-browser-check.json', JSON.stringify(report, null, 1));
  console.log('sky entries browser check passed');
} finally {
  await context.close();
}
