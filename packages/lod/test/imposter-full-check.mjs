// Real-GPU check of the fuller imposters: per-instance colour and emissive, a baked emissive atlas through export and
// fromData, animation frames, and shadows cast onto a floor and received from a roof.
// Run from the repository root after `npm run build:packages`: node packages/lod/test/imposter-full-check.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'lod-imposter-full' });
const context = await openBrowser({ startPath: '/packages/lod/test/imposter-full-check.html', port: 5280 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const timer = setTimeout(() => {
  console.error('lod imposter-full-check: over its 2 minute limit');
  process.exit(1);
}, 120_000);
const reddest = ([r, g, b]) => r > g + 40 && r > b + 40,
  greenest = ([r, g, b]) => g > r + 40 && g > b + 40;
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.ok(reddest(r.tinted.left) && greenest(r.tinted.right), `a colour per instance: ${JSON.stringify(r.tinted)}`);
  assert.ok(r.live.right[2] > r.tinted.right[2] + 40, `a live emissive adds light: ${JSON.stringify(r.live)}`);
  assert.ok(greenest(r.glow), `a baked emissive glows without light: ${r.glow}`);
  assert.deepEqual(r.again, r.glow, 'export and fromData keep it');
  assert.equal(r.exported, true);
  assert.ok(r.plain[1] < 20, `without the option no glow is baked: ${r.plain}`);
  assert.ok(reddest(r.frames.left) && greenest(r.frames.right), `a frame per instance: ${JSON.stringify(r.frames)}`);
  assert.ok(greenest(r.played.left) && reddest(r.played.right), `frames play: ${JSON.stringify(r.played)}`);
  assert.ok(r.cast.under[0] < r.cast.beside[0] * 0.75, `an imposter casts: ${JSON.stringify(r.cast)}`);
  assert.ok(r.received.covered[0] < r.received.open[0] * 0.75, `an imposter receives: ${JSON.stringify(r.received)}`);
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
} finally {
  clearTimeout(timer);
  await context.close?.();
  await release?.();
}
