// Real-GPU check of `@margoengine/shadows/vsm`: a straight shadow edge, its width against the blur, its noise against PCSS,
// the map following a moving caster, a device restore, and every receiver path compiling under the filter.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/vsm-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'shadows-vsm' });
const context = await openBrowser({ startPath: '/packages/shadows/test/vsm.html', port: 5276 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const shot = async () => decodePNG(await page.locator('canvas').screenshot());
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const light = (v) => {
  const y = linear(v);
  return y >= 0.04 ? y + 0.04 : 0.4 * Math.sqrt(y);
};
const run = async (name, ...args) => assert.deepEqual(await page.evaluate(([n, a]) => window.check[n](...a), [name, args]), []);
const frame = async (setting, open) => {
  await run('edge', setting);
  return ratio(await shot(), open);
};
// Rows run along the box's long side and across its edge, near the frame's middle: visibility per pixel.
const ratio = (image, open) => {
  const out = new Float64Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) out[i] = light(image.data[i * 4 + 1]) / light(open.data[i * 4 + 1]);
  return { data: out, width: image.width };
};
const rows = [];
for (let y = 196; y < 316; y += 2) rows.push(y);
// Pixels from 10 to 90 percent of the light across the edge, the mean of the rows.
const edgeWidth = ({ data, width }) => {
  let sum = 0;
  for (const y of rows) {
    let low = -1,
      high = -1;
    for (let x = 80; x < 432; x++) {
      const v = data[y * width + x];
      if (v <= 0.1) low = x;
      if (v >= 0.9 && high < 0 && low >= 0) high = x;
    }
    sum += high - low;
  }
  return sum / rows.length;
};
// Grain along the edge: the straight edge is the same in every row, so what differs from row to row is noise.
const grain = ({ data, width }) => {
  let sum = 0,
    count = 0;
  for (let i = 1; i < rows.length; i++)
    for (let x = 80; x < 432; x++) {
      sum += Math.abs(data[rows[i] * width + x] - data[rows[i - 1] * width + x]);
      count++;
    }
  return sum / count;
};
const edgeAt = ({ data, width }) => {
  const y = rows[rows.length >> 1];
  for (let x = 432; x >= 0; x--) if (data[y * width + x] < 0.5) return x;
  return -1;
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  await run('edge', null);
  const open = await shot(),
    narrow = await frame({ variance: { size: 1024, blur: 2, bleed: 0 } }, open),
    wide = await frame({ variance: { size: 1024, blur: 16, bleed: 0 } }, open),
    soft = await frame({ filter: 'soft', lightSize: 0.2 }, open),
    variance = await frame({ variance: { size: 1024, blur: 8 } }, open);
  const widths = { narrow: edgeWidth(narrow), wide: edgeWidth(wide) },
    noise = { variance: grain(variance), soft: grain(soft) };
  console.log(JSON.stringify({ widths, noise }));
  // 16 texels of 1 / 64 world unit on a 512-pixel frame of about 7.5 units: the tent's 10 to 90 percent span is near its radius.
  assert.ok(widths.wide > widths.narrow * 3, `a blur of 16 gave ${widths.wide} pixels, a blur of 2 gave ${widths.narrow}`);
  assert.ok(noise.variance * 4 < noise.soft, `grain ${noise.variance} against PCSS ${noise.soft}`);
  // Live settings and a moved caster reach the blurred map with no new shader.
  const before = edgeAt(variance);
  await run('move', -1);
  const moved = edgeAt(ratio(await shot(), open));
  assert.ok(moved > before + 20, `the edge stayed at ${moved} after the caster moved from ${before}`);
  await run('set', { blur: 24 });
  const live = ratio(await shot(), open),
    wider = edgeWidth(live);
  assert.ok(wider > widths.wide, `a live blur of 24 gave ${wider} pixels`);
  await run('restore');
  const restored = edgeAt(ratio(await shot(), open));
  assert.equal(restored, edgeAt(live), 'a restored device draws the same edge');
  await page.evaluate(() => window.check.end());
  for (const name of ['gltf', 'terrain', 'voxels'])
    assert.deepEqual(await page.evaluate((n) => window.check.receiver(n), name), [], name);
  assert.deepEqual(pageErrors, []);
  console.log('variance filter: ok');
} finally {
  await context.close?.();
  await release();
}
