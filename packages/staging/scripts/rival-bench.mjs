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
// --ambient measures AmbientShadows (all-sky, 1024 cosine directions) on the same scene and reference.
const ambient = process.argv.includes('--ambient');
const context = await openBrowser({
  startPath: '/packages/staging/scripts/contact-reference.html' + (ambient ? '?ambient' : ''),
  port: 'free',
});
try {
  await context.page.waitForFunction(() => window.contactReference, null, { timeout: 60_000 });
  const picture = await context.page.evaluate(() => window.contactReference);
  if (picture.error) throw new Error(picture.stack ?? picture.error);
  assert.equal(picture.pixels[(64 * 128 + 64) * 4], 0, 'black sphere is visible');
  // All-sky visibility darkens even the corner a little (traced 0.0054 there), so only the footprint is pure white.
  if (!ambient) assert.equal(picture.pixels[0], 255, 'unoccluded white background is visible');
  const result = contactError(picture.pixels);
  assert.ok(result.margoMax > 0, 'contact shadow is present on exposed floor');
  writeFileSync(`test-results/staging-ray-reference${ambient ? '-ambient' : ''}.png`, await context.page.locator('canvas').screenshot());
  console.log(`RESULT ${JSON.stringify({ ...result, scene: CONTACT_SCENE, options: ambient ? 'AmbientShadows ambient 1, frames 1024, opacity 1' : 'ContactShadows defaults' })}`);
} finally {
  await context.close();
}
