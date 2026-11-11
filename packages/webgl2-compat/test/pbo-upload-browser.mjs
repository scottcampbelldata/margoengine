// Exact texSubImage uploads from a pixel unpack buffer (KBL3c): the upstream repro page
// (docs/upstream-reports/KBL3c/pbo-upload.html) uploads RGBA8 4 x 4 and RGBA32UI 2,048 x 12 textures from exact buffers
// and from arrays at UNPACK_ALIGNMENT 1, 4 and 8 and reads every texel back. Every case must land with no GL error, and
// the only console warning a case may print is Firefox's final-row advisory (scripts/support/browser-advisories.mjs),
// which the layer's checks accept on the Firefox versions it was seen in. Run from the repository root, under the GPU
// lock: node packages/webgl2-compat/test/pbo-upload-browser.mjs (MARGO_BROWSER=firefox for Firefox).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { acceptedAdvisory, firefoxContextLost } from '../../../scripts/support/browser-advisories.mjs';

const context = await openBrowser({ startPath: '/docs/upstream-reports/KBL3c/pbo-upload.html?wait', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [],
  lines = new Map();
let current,
  lost = 0;
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  const text = message.text();
  if (text.startsWith('begin: ')) return void lines.set((current = text.slice(7)), []);
  if (text.startsWith('end: ')) return void (current = undefined);
  if (message.type() !== 'warning' && message.type() !== 'error') return;
  // Each case ends with the page's own loseContext(), which Firefox reports, at times after the next case began.
  if (firefoxContextLost(text, hardware)) lost++;
  else (current ? lines.get(current) : pageErrors).push(text);
});
try {
  await page.waitForFunction(() => typeof window.run === 'function', null, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    await window.run();
    return window.result;
  });
  const names = Object.keys(result.cases);
  assert.equal(names.length, 9, 'three cases at each of three alignments');
  for (const align of [1, 4, 8])
    assert.equal(names.filter((name) => name.endsWith(`UNPACK_ALIGNMENT ${align}`)).length, 3, `alignment ${align}`);
  let accepted = 0;
  for (const [name, row] of Object.entries(result.cases)) {
    assert.equal(row.glError, 0, `${name}: GL error`);
    assert.equal(row.landed, true, `${name}: every texel reads back as uploaded`);
    const seen = lines.get(name) ?? [];
    assert.deepEqual(
      seen.filter((text) => !acceptedAdvisory(text, hardware)),
      [],
      `${name}: console warnings`,
    );
    accepted += seen.length;
  }
  // The last case's loss may be reported after run() returns: bounded wait for the nine (Firefox) or none.
  const losses = hardware.browserName === 'firefox' ? names.length : 0;
  for (let i = 0; i < 100 && lost < losses; i++) await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(lost, losses, 'one context loss a case, each by the page itself');
  assert.deepEqual(pageErrors, []);
  console.log(
    `pbo uploads exact: ${names.length} cases on ${hardware.browserName} ${hardware.browserVersion}, ${accepted} accepted advisory lines`,
  );
} finally {
  await context.close();
}
