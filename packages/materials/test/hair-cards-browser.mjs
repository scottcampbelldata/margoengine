// Real-GPU check of hairCards() (WebGPU, or the WebGL2 compatibility layer with MARGO_COMPAT=1): a BLEND card of alpha
// 0.2 turned from the view darkens a white background by 1 - 0.8^(1/|cos|) with the feature (capped at |cos| 0.1) and
// by 0.2 without it, at every angle. Run from the repository root after building packages:
//   node packages/materials/test/hair-cards-browser.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const browser = await openBrowser({ startPath: '/packages/materials/test/hair-cards.html', port: 'free' }),
  page = browser.page,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  // The centre pixel's red, green and blue, 0 to 255 (the card and background are grey, so one value).
  const centre = async (cos, cards, mode) => {
    assert.equal(await page.evaluate(([c, k, m]) => window.cards.draw(c, k, m), [cos, cards, mode]), 0, 'no GPU error');
    const image = await decodePNG(await page.locator('canvas').screenshot()),
      at = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    return [0, 1, 2].map((k) => image.data[at + k]);
  };
  const white = await centre(0, false);
  assert.ok(white.every((v) => v > 250), `the background is white: ${white}`);
  // Display-encoded blending (gltf/pbr's default blendSpace): the black card leaves the background times 1 - alpha.
  const alpha = (rgb) => 1 - rgb[0] / white[0];
  for (const cos of [1, 0.5, 0.25, 0.05]) {
    const plain = alpha(await centre(cos, false)),
      card = alpha(await centre(cos, true)),
      expected = 1 - 0.8 ** (1 / Math.max(cos, 0.1));
    assert.ok(Math.abs(plain - 0.2) < 0.012, `without hairCards a card keeps alpha 0.2 at cos ${cos}: ${plain}`);
    assert.ok(Math.abs(card - expected) < 0.012, `hairCards at cos ${cos}: alpha ${card}, expected ${expected}`);
  }
  // An opaque card is untouched: it covers the pixel either way.
  assert.deepEqual(await centre(0.25, true, 'opaque'), await centre(0.25, false, 'opaque'), 'opaque output unchanged');
  assert.deepEqual(pageErrors, []);
  console.log('hair cards: ok');
} finally {
  await browser.close();
}
