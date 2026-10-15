// Real-adapter check for section caps on open shells (HANDOFF 5l.d), from the repository root after building packages, holding
// the GPU lock: node packages/machinery/test/section-open-check.mjs [--base=/test-results/machinery-old]
// The closed box must be capped; the open sheet must not be (a stray cap there is the bug this guards).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7);
const context = await openBrowser({
    startPath: '/packages/machinery/test/section-open-check.html' + (base ? '?base=' + base : ''),
    port: 5214,
  }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const result = await page.evaluate(() => window.check.run()),
    image = await decodePNG(await page.locator('canvas').screenshot());
  // The camera looks along +z, so world +x (the sheet) is on the left of the screen and the box (x = -0.8) on the right.
  let sheet = 0,
    box = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const o = (y * image.width + x) * 4,
        [r, g, b] = image.data.subarray(o, o + 3);
      if (g > 100 && r < 70 && b < 70) x < image.width / 2 ? sheet++ : box++;
    }
  await page.locator('canvas').screenshot({ path: `test-results/section-open-${base ? 'base' : 'current'}.png` });
  console.log(JSON.stringify({ base: base ?? 'current', capPixels: { box, sheet } }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  if (!base) {
    assert.ok(box > 500, 'the closed box is capped');
    assert.equal(sheet, 0, 'the open sheet is not capped');
    console.log('section open-shell check passed');
  }
} finally {
  await context.close();
}
