import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ startPath: '/packages/tilemap/test/objects-check.html', port: 'free' });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  await browser.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const result = await browser.page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/tilemap-objects${process.argv.includes('--compat') ? '-compat' : ''}.json`,
    JSON.stringify({ hardware: browser.hardware, ...result }, null, 2),
  );
  for (const r of result.results) {
    if ('wrong' in r) assert.equal(r.wrong, 0, JSON.stringify(r));
    else assert.equal(r.emptyDraws, 0);
  }
  assert.equal(result.validation, null);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  console.log(
    'ok ordered tile maps: collection images, object flips, rotation, layers, animation, repeat and empty maps',
  );
} finally {
  await browser.close();
}
