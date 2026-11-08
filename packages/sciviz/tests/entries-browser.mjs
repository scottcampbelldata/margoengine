// Real-GPU checks of the sciviz entries that draw (grids, graph, geo), natively and on the WebGL2 compatibility layer
// (one GPU job; from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/sciviz/tests/entries-browser.mjs
// Each case must draw (enough lit pixels), and the layer's pixels must match native WebGPU by the layer's parity
// measure: at most 0.1% of pixels with a channel difference d > 2, and mean d at most 0.25. Results go to
// test-results/sciviz-entries.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const MAX_SHARE = 0.001,
  MAX_MEAN = 0.25;

async function run(compat) {
  const context = await openBrowser({ startPath: `/packages/sciviz/tests/entries.html${compat ? '?compat=1' : ''}`, port: compat ? 5246 : 5245 });
  const { page, hardware } = context;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.setDefaultTimeout(300_000);
  try {
    await page.waitForFunction(() => window.entriesReady === true);
    const report = await page.evaluate(() => window.runEntryChecks());
    assert.deepEqual(errors, []);
    return { hardware, report };
  } finally {
    await context.close();
  }
}

const native = await run(false),
  layer = await run(true);
const results = [];
for (const name of Object.keys(native.report.images)) {
  const a = Buffer.from(native.report.images[name].data, 'base64'),
    b = Buffer.from(layer.report.images[name].data, 'base64');
  assert.equal(a.length, b.length, name);
  let over = 0,
    sum = 0;
  for (let p = 0; p < a.length; p += 4) {
    const d = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]));
    sum += d;
    if (d > 2) over++;
  }
  const count = a.length / 4,
    share = over / count,
    mean = sum / count;
  results.push({ name, lit: native.report.images[name].lit, share, mean });
  assert.ok(native.report.images[name].lit > 500, `${name}: only ${native.report.images[name].lit} lit pixels natively`);
  assert.ok(share <= MAX_SHARE && mean <= MAX_MEAN, `${name}: the WebGL2 layer differs from native (share ${share}, mean ${mean})`);
}
await mkdir('test-results', { recursive: true });
await writeFile(
  'test-results/sciviz-entries.json',
  JSON.stringify({ hardware: native.hardware, checks: native.report.checks, compatChecks: layer.report.checks, results }, null, 2),
);
console.log(JSON.stringify(results));
console.log(`sciviz entries: ${results.length} cases drew natively and on the WebGL2 layer with the same pixels`);
