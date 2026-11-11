// AmbientShadows with all-sky visibility against cosine-weighted ray tracing (KB3193): the progressive projections
// integrate the hemispherical visibility that the default footprint ContactShadows does not model by design.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { contactError } from '../scripts/contact-reference.mjs';
const context = await openBrowser({ startPath: '/packages/staging/scripts/contact-reference.html?ambient', port: 'free' });
try {
  await context.page.waitForFunction(() => window.contactReference, null, { timeout: 120_000 });
  const picture = await context.page.evaluate(() => window.contactReference);
  if (picture.error) throw new Error(picture.stack ?? picture.error);
  const r = contactError(picture.pixels),
    step = 1 / 255;
  // One 8-bit display step: the reference is quantized the same way, so no finer bound is meaningful.
  assert.ok(r.mae < step, `MAE ${r.mae} below one 8-bit step`);
  assert.ok(Math.abs(r.margoMean - r.referenceMean) < step / 4, `mean ${r.margoMean} vs traced ${r.referenceMean}`);
  assert.ok(r.max < 3 * step, `max ${r.max} within three 8-bit steps`);
  console.log(`staging sky occlusion: MAE ${r.mae.toFixed(6)}, mean ${r.margoMean.toFixed(6)} vs ${r.referenceMean.toFixed(6)}, max ${r.max.toFixed(6)}, ${r.pixels} pixels`);
} finally {
  await context.close();
}
