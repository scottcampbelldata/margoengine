import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/packages/tilemap/test/plane-check.html', port: 'free' }),
  errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  await browser.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const result = await browser.page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/tilemap-plane${process.argv.includes('--compat') ? '-compat' : ''}.json`,
    JSON.stringify({ hardware: browser.hardware, ...result }, null, 2),
  );
  for (const r of result.results) {
    assert.equal(r.wrong, 0, JSON.stringify(r));
    assert.ok(r.covered > 0, r.name);
  }
  assert.ok(result.results.find((r) => r.name === 'core-depth').blocked > 0);
  assert.ok(result.results[0].covered > result.results[1].covered);
  assert.equal(result.validation, null);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  console.log('ok 3D tile planes: perspective texels, moved camera, core depth, cutouts and independent views');
} finally {
  await browser.close();
}
