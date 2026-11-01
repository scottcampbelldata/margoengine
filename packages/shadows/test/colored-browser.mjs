// Real-GPU test of coloured shadows (`Shadows` `colored`, `add(mesh, {tint})`). The light comes from the side, so a
// caster's shadow lands on known floor points clear of it. A red pane must leave red light on the floor where a plain
// shadow leaves none, a blocking box stays dark, a riser on the light's side of the pane keeps its colour, and hiding
// or removing the pane brings the white floor back.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/colored-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'shadows-colored' });
const context = await openBrowser({ startPath: '/packages/shadows/test/colored.html', port: 5276 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const timer = setTimeout(() => {
  console.error('colored-browser: over its 3 minute limit');
  process.exit(1);
}, 180_000);
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const shot = async (mode, filter) => {
  assert.deepEqual(await page.evaluate(([m, f]) => window.check.show(m, f), [mode, filter]), []);
  return decodePNG(await page.locator('canvas').screenshot());
};
// Mean linear RGB of a 9 x 9 patch around world point p.
const patch = async (image, p) => {
  const [cx, cy] = await page.evaluate((w) => window.check.pixel(w), p),
    sum = [0, 0, 0];
  for (let y = cy - 4; y <= cy + 4; y++)
    for (let x = cx - 4; x <= cx + 4; x++) {
      const o = (y * image.width + x) * 4;
      for (let k = 0; k < 3; k++) sum[k] += linear(image.data[o + k]) / 81;
    }
  return sum;
};
// Where each caster's shadow lands on the floor. The light travels along (1, -1, 0), so a caster at height 2 moves +2 in x.
const underPane = [0, 0, -0.5],
  underBlocker = [0, 0, 4],
  open = [4, 0, -4],
  riserTop = [-3.2, 3.4, 0.6];
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const report = {};
  for (const filter of ['hard', 'pcf', 'soft']) {
    const tint = await shot('tint', filter),
      plain = await shot('off', filter),
      clear = await patch(tint, open),
      red = await patch(tint, underPane),
      dark = await patch(plain, underPane),
      blocked = await patch(tint, underBlocker);
    report[filter] = { clear, red, dark, blocked };
    // Sunlight through the pane: red holds what the open floor gets, green and blue take the pane's 0.1.
    assert.ok(red[0] > dark[0] + 0.2 * (clear[0] - dark[0]), `${filter}: red light passes: ${red} vs dark ${dark}`);
    const share = (k) => (red[k] - dark[k]) / (clear[k] - dark[k]);
    assert.ok(share(0) > 0.9, `${filter}: the red channel keeps its light: ${share(0)}`);
    for (const k of [1, 2]) assert.ok(share(k) < 0.2, `${filter}: channel ${k} is cut: ${share(k)}`);
    // The blocker is a depth caster as before.
    for (let k = 0; k < 3; k++) assert.ok(blocked[k] < dark[k] * 1.1, `${filter}: a blocker stays dark: ${blocked}`);
  }
  // A surface on the light's side of the pane is not tinted: the same on both, the plain run with the pane blocking.
  const above = await patch(await shot('tint'), riserTop),
    abovePlain = await patch(await shot('off'), riserTop);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(above[k] - abovePlain[k]) < 0.01, `in front stays white: ${above}`);
  // Coloured maps with nothing to tint, a hidden pane and a removed one all leave the open-floor light under the pane.
  for (const mode of ['empty', 'hidden', 'removed']) {
    const image = await shot(mode),
      value = await patch(image, underPane),
      reference = await patch(image, open);
    for (let k = 0; k < 3; k++)
      assert.ok(
        Math.abs(value[k] - reference[k]) < 0.02,
        `${mode}: the floor is clear again: ${value} vs ${reference}`,
      );
  }
  console.log(JSON.stringify(report));
  assert.deepEqual(pageErrors, []);
} finally {
  clearTimeout(timer);
  await context.close?.();
  await release?.();
}
