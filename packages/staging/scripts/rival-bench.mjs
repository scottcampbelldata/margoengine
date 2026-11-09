import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/staging/scripts/rival-bench.mjs')
)
  process.exit(0);
// Default contact shadow against deterministic cosine-weighted ray tracing, no timing claim.
import { openBrowser } from '../../../scripts/browser.js';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { contactError, CONTACT_SCENE } from './contact-reference.mjs';
const context = await openBrowser({ startPath: '/packages/staging/scripts/contact-reference.html', port: 'free' });
try {
  await context.page.waitForFunction(() => window.contactReference, null, { timeout: 60_000 });
  const picture = await context.page.evaluate(() => window.contactReference);
  if (picture.error) throw new Error(picture.stack ?? picture.error);
  assert.equal(picture.pixels[(64 * 128 + 64) * 4], 0, 'black sphere is visible');
  assert.equal(picture.pixels[0], 255, 'unoccluded white background is visible');
  const result = contactError(picture.pixels);
  assert.ok(result.margoMax > 0, 'contact shadow is present on exposed floor');
  writeFileSync('test-results/staging-ray-reference.png', await context.page.locator('canvas').screenshot());
  console.log(`RESULT ${JSON.stringify({ ...result, scene: CONTACT_SCENE, options: 'ContactShadows defaults' })}`);
} finally {
  await context.close();
}
