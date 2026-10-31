// Real-GPU checks of @margoengine/sciviz/bricks (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sciviz/tests/bricks-browser.mjs
// The page draws the same volume whole and from bricks and compares the pixels; results go to
// test-results/bricks-browser.json. With --measure it times frames at a volume larger than one texture instead (take
// the GPU exclusively for that), to test-results/bricks-measure.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const context = await openBrowser({ startPath: '/packages/sciviz/tests/bricks.html', port: 5245 });
const { page, hardware } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.setDefaultTimeout(600_000);
try {
  await page.waitForFunction(() => typeof window.runBrickTests === 'function');
  await mkdir('test-results', { recursive: true });
  if (process.argv.includes('--measure')) {
    const runs = [];
    for (const options of [{ dims: [4096, 1024, 1024] }, { dims: [4096, 1024, 1024], memoryBudget: 2 ** 31 }])
      runs.push(await page.evaluate((o) => window.measureBricks(o), options));
    await writeFile('test-results/bricks-measure.json', JSON.stringify({ hardware, runs }, null, 2));
    console.log(JSON.stringify(runs, null, 1));
  } else {
    const report = await page.evaluate(() => window.runBrickTests());
    assert.deepEqual(errors, []);
    await writeFile('test-results/bricks-browser.json', JSON.stringify({ hardware, ...report }, null, 2));
    for (const name of report.checks) console.log(`ok - ${name}`);
    console.log(JSON.stringify(report.numbers));
    console.log(`${report.checks.length} bricks browser checks passed`);
  }
  assert.deepEqual(errors, []);
} finally {
  await context.close();
}
