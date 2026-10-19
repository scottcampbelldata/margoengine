// Real-GPU check of texture atlases (run from the repository root after building packages, one GPU job at a time):
//   node scripts/gpu-lock.mjs run --owner=<id> -- node packages/vfx/test/browser-check.mjs
// 64 particles in a grid draw with a 2 x 2 atlas of solid frames, at 1x and 4x MSAA. 'random': every particle shows the
// frame the CPU predicts from its birth angle, all four frames occur; 'lifetime': the frame of its age quarter, faded by
// its remaining life. Each particle's centre and four points near its corners match within 2/255 (no filtering from a
// neighbouring frame), all 64 are drawn, and WebGPU reports no validation errors.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/vfx/test/browser-check.html', port: 5286 }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  for (const frames of ['random', 'lifetime'])
    for (const samples of [1, 4]) {
      const r = await page.evaluate(([f, s]) => window.check(f, s), [frames, samples]),
        name = `${frames} ${samples}x`;
      report.results[name] = r;
      assert.equal(r.error, null, name);
      assert.deepEqual(r.errors, [], name);
      assert.equal(r.visible, 64, `${name}: every particle is drawn`);
      assert.equal(r.checked, 64 * 5, name);
      assert.deepEqual(r.mismatches, [], name);
      if (frames === 'random')
        assert.ok(
          r.histogram.every((count) => count > 0),
          `${name}: ${r.histogram}`,
        );
      else assert.deepEqual(r.histogram, [16, 16, 16, 16], name);
      console.log(`ok ${name}: ${r.checked} samples, largest difference ${r.largest}/255, frames ${r.histogram}`);
    }
  assert.deepEqual(pageErrors, []);
  await writeFile('test-results/vfx-atlas-browser-check.json', JSON.stringify(report, null, 1));
  console.log('vfx atlas browser check passed');
} finally {
  await context.close();
}
