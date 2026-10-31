// Real-GPU test of page-edge continuity for the 'pcf' and 'soft' virtual shadow filters (row 21.6 stage 5). For floor
// pixels side by side that land on different pages of one level, the visibility difference stays under 0.02 RMS, and
// inside a penumbra it is no larger (by 0.02 RMS) than between neighbours on one page: a tap across a page edge reads the
// neighbour, so an edge adds no step of its own. The lit-faces checks run on the same filters through
// `lit-faces-browser.mjs --page=virtual`. Run from the repository root after `npm run build:packages`.
// Writes test-results/virtual-edges.json.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const RMS = 0.02;
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'shadows-virtual-edges' });
const context = await openBrowser({ startPath: '/packages/shadows/test/virtual-edges.html', port: 5274 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const shot = async (state) => {
  const out = await page.evaluate((s) => window.check.show(s), state);
  assert.deepEqual(out.errors, [], state);
  const img = await decodePNG(
      await page.locator('canvas').screenshot({ path: `test-results/virtual-edges-${state}.png` }),
    ),
    L = new Float32Array(img.width * img.height);
  for (let p = 0; p < L.length; p++)
    L[p] =
      0.2126 * linear(img.data[p * 4]) + 0.7152 * linear(img.data[p * 4 + 1]) + 0.0722 * linear(img.data[p * 4 + 2]);
  return { L, W: img.width, H: img.height, stats: out.stats };
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const { L: open } = await shot('open'),
    { L: dark } = await shot('dark'),
    result = { pageErrors };
  for (const filter of ['pcf', 'soft']) {
    const { L, W, H, stats } = await shot(filter),
      ids = await page.evaluate(() => window.check.pageIds()),
      V = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++)
      V[p] = open[p] - dark[p] > 0.02 ? (L[p] - dark[p]) / (open[p] - dark[p]) : Number.NaN;
    const levelOf = (id) => Math.floor(id / 1e8);
    let edgePairs = 0,
      edgeSum = 0,
      edgePenumbra = 0,
      edgePenumbraSum = 0,
      plainPenumbra = 0,
      plainPenumbraSum = 0;
    for (let y = 0; y < H - 1; y++)
      for (let x = 0; x < W - 1; x++) {
        const p = y * W + x;
        for (const q of [p + 1, p + W]) {
          if (!ids[p] || !ids[q] || Number.isNaN(V[p]) || Number.isNaN(V[q]) || levelOf(ids[p]) !== levelOf(ids[q]))
            continue;
          const d = (V[p] - V[q]) ** 2,
            penumbra = Math.min(V[p], V[q]) < 0.95 && Math.max(V[p], V[q]) > 0.05;
          if (ids[p] !== ids[q]) {
            edgePairs++;
            edgeSum += d;
            if (penumbra) {
              edgePenumbra++;
              edgePenumbraSum += d;
            }
          } else if (penumbra) {
            plainPenumbra++;
            plainPenumbraSum += d;
          }
        }
      }
    const edgeRms = Math.sqrt(edgeSum / Math.max(1, edgePairs)),
      penumbraRms = Math.sqrt(edgePenumbraSum / Math.max(1, edgePenumbra)),
      plainRms = Math.sqrt(plainPenumbraSum / Math.max(1, plainPenumbra));
    result[filter] = {
      edgePairs,
      edgeRms: +edgeRms.toFixed(4),
      edgePenumbra,
      penumbraRms: +penumbraRms.toFixed(4),
      plainPenumbra,
      plainRms: +plainRms.toFixed(4),
      stats,
    };
    assert.ok(
      edgePairs > 2000 && edgePenumbra > 20 && plainPenumbra > 500,
      `${filter}: ${JSON.stringify(result[filter])}`,
    );
  }
  console.log(JSON.stringify(result));
  await writeFile('test-results/virtual-edges.json', JSON.stringify(result, null, 2));
  assert.deepEqual(pageErrors, []);
  for (const filter of ['pcf', 'soft']) {
    const r = result[filter];
    assert.ok(r.edgeRms < RMS, `${filter}: across page edges RMS ${r.edgeRms}`);
    assert.ok(
      r.penumbraRms < r.plainRms + RMS,
      `${filter}: page edges step in a penumbra ${r.penumbraRms} vs ${r.plainRms}`,
    );
  }
  console.log('shadows virtual edges: ok');
} finally {
  await context.close?.();
  await release?.();
}
