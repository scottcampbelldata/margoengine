// Real-GPU check: sources with `drawShadow` cast into VirtualShadows with no change on their side. Each source's shadow is
// compared with its shadow in Shadows, the path those sources have always cast through and a different one: cascade
// matrices and one map there, page matrices, four pages per submit and a page table here.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/virtual-custom-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'shadows-virtual-custom' });
const context = await openBrowser({ startPath: '/packages/shadows/test/virtual-custom.html', port: 5274 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const shot = async () => decodePNG(await page.locator('canvas').screenshot());
const show = async (name, kind, still) => {
  const r = await page.evaluate(([n, k, s]) => window.check.show(n, k, s), [name, kind, still]);
  assert.deepEqual(r.errors, []);
  return { image: await shot(), stats: r.stats };
};
// Pixels the shadow darkens under half their light; pixels with no floor light (the casters' own faces) do not count.
const shadowMask = (open, shaded) => {
  const out = new Uint8Array(open.width * open.height);
  for (let i = 0; i < out.length; i++) out[i] = open.data[i * 4 + 1] > 40 && shaded.data[i * 4 + 1] < open.data[i * 4 + 1] * 0.73 ? 1 : 0;
  return out;
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const [name, still] of [
    ['parts', true],
    ['parts', false],
    ['scatter', false],
    ['voxels', true],
  ]) {
    const open = (await show(name, 'none')).image,
      reference = shadowMask(open, (await show(name, 'shadows', still)).image),
      virtual = await show(name, 'virtual', still),
      pages = shadowMask(open, virtual.image);
    let both = 0,
      either = 0,
      count = 0;
    for (let i = 0; i < pages.length; i++) {
      both += pages[i] & reference[i];
      either += pages[i] | reference[i];
      count += reference[i];
    }
    const overlap = both / either;
    console.log(JSON.stringify({ name, still, shadowPixels: count, overlap: +overlap.toFixed(4), stats: virtual.stats }));
    assert.ok(count > 1500, `${name}: only ${count} shadow pixels, so nothing is measured`);
    // At 384 pixels over 60 units a page texel is finer than a pixel at the levels this view asks for: the two shadows may
    // differ by a pixel along their edge, several hundred pixels around these casters.
    assert.ok(overlap > 0.85, `${name}: the shadows overlap only ${overlap}`);
    if (still) {
      const counts = await page.evaluate(() => window.check.stillFrames(4));
      assert.deepEqual(counts, [0, 0, 0, 0], `${name}: a still source drew pages in a still view`);
    }
  }
  assert.deepEqual(pageErrors, []);
  console.log('virtual shadows drawShadow casters: ok');
} finally {
  await context.close?.();
  await release?.();
}
