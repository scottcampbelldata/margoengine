// Real-GPU check of LevelStream over HTTP: a file fetched when the camera comes near, drawing in place of the coarse level;
// a bad URL fails and leaves the coarse level on show; a move away aborts a fetch in flight.
// Run from the repository root after `npm run build:packages`: node packages/lod/test/stream-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'lod-stream' });
const context = await openBrowser({ startPath: '/packages/lod/test/stream-check.html', port: 5281 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  // The bad URL's 404 is this check's own doing.
  if (m.type() === 'error' && !/404/.test(m.text())) pageErrors.push(m.text());
});
const timer = setTimeout(() => {
  console.error('lod stream-check: over its 2 minute limit');
  process.exit(1);
}, 120_000);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.equal(r.far.requests, 0, 'far away nothing is fetched');
  assert.equal(r.far.level, 1);
  assert.ok(r.far.red >= 30, `the coarse level draws: ${JSON.stringify(r.far)}`);
  assert.equal(r.near.level, 0, 'near, the fetched level shows');
  assert.equal(r.near.requests, 1);
  assert.ok(r.near.red < r.near.pixels * 0.01 && r.near.pixels > 1000, `and the coarse level goes: ${JSON.stringify(r.near)}`);
  assert.ok(r.near.bytes > 100_000, `it counts what it holds: ${r.near.bytes}`);
  assert.equal(r.bad.state, 'failed');
  assert.equal(r.bad.level, 1, 'a failed level leaves the coarse one on show');
  assert.equal(r.aborted.state, 'idle');
  assert.equal(r.aborted.active, 0);
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  clearTimeout(timer);
  await context.close?.();
  await release?.();
}
