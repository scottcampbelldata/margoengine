// Real-GPU check of selection outlines on imposters: selected by anchor or level, the object shown as an imposter outlines;
// behind a wall only x-ray shows it; unselected and hidden objects stay out of it.
// Run from the repository root after `npm run build:packages`: node packages/lod/test/imposter-outline-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'lod-outline' });
const context = await openBrowser({ startPath: '/packages/lod/test/imposter-outline-check.html', port: 5282 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const timer = setTimeout(() => {
  console.error('lod imposter-outline-check: over its 2 minute limit');
  process.exit(1);
}, 120_000);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.equal(r.level, 1, 'the object shows its imposter');
  assert.equal(r.none, 0);
  assert.ok(r.anchor > 100, `selecting the anchor outlines the imposter: ${r.anchor}`);
  assert.equal(r.levelSelected, r.anchor, 'and so does selecting a level');
  assert.ok(r.other > 100, `an anchor of its own: ${r.other}`);
  assert.equal(r.nearLevel, 0);
  assert.ok(r.nearOutline > 100, 'the outline stays through the switch');
  assert.equal(r.hidden, 0, 'a wall hides it, and no empty imposter pixel lands in front of the wall');
  assert.ok(r.xray > 100, `x-ray shows it: ${r.xray}`);
  assert.equal(r.anchorHidden, 0, 'a hidden object has no outline');
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  clearTimeout(timer);
  await context.close?.();
  await release?.();
}
