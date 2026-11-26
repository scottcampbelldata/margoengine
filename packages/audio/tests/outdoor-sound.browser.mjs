import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const { page, close } = await openBrowser({ startPath: '/packages/audio/tests/outdoor-sound.html', port: 5418 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => window.measureOutdoorSound, null, { timeout: 20000 });
  const control = await page.evaluate(() => window.measureOutdoorSound(false));
  const result = await page.evaluate(() => window.measureOutdoorSound(true));
  assert.ok(result.installed && result.restored && result.stable, JSON.stringify(result));
  assert.ok(control.first >= 0 && result.first > control.first, JSON.stringify({ control, result }));
  // Subtract the identical panner and spectral filter chain's onset from the delayed render.
  const elapsed = result.first - control.first;
  assert.ok(Math.abs(elapsed - result.expected) <= 2, JSON.stringify({ control, result }));
  assert.deepEqual(errors, []);
  console.log(`Web Audio: ${(elapsed / result.rate).toFixed(5)} seconds added for a source 3 km away`);
} finally {
  await close();
}
