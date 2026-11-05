// Real-GPU regression test: gltf-pro's vertex input trimming (src/vertex-inputs.ts) draws the same pixels. The page is
// taken twice, as built and with the trimming switched off in the served gltf-pro build. The two must match bit for
// bit, and the frame must not be empty.
// Run from the repository root after `npm run build:packages`: node packages/materials/test/vertex-inputs-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'materials-vertex-inputs' });
const context = await openBrowser({ startPath: '/packages/materials/test/vertex-inputs.html', port: 5281 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
let off = false,
  patched = 0;
await page.route('**/packages/gltf-pro/dist/src-*.js*', async (route) => {
  const response = await route.fetch();
  let body = await response.text();
  if (off) {
    const next = body.replace(String.raw`/\bstruct Input \{/`, String.raw`/\bno such text \{/`);
    assert.notEqual(next, body, 'the trimming switch must match the build');
    body = next;
    patched++;
  }
  await route.fulfill({ response, body });
});
const frame = async () => {
  await page.reload();
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60_000 });
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  return { image: await decodePNG(await page.locator('canvas').screenshot()), fetched: await page.evaluate(() => window.fetched) };
};
try {
  const { image: trimmed, fetched } = await frame();
  off = true;
  const { image: whole, fetched: all } = await frame();
  assert.ok(fetched.includes(2) && fetched.includes(3) && fetched.includes(5), `inputs fetched: ${fetched}`);
  assert.ok(all.length && all.every((n) => n === 5), `inputs fetched with the trimming off: ${all}`);
  assert.ok(patched > 0, 'the served build was not switched');
  assert.deepEqual(pageErrors, []);
  let differing = 0,
    lit = 0;
  for (let i = 0; i < trimmed.data.length; i += 4) {
    if (trimmed.data[i] !== trimmed.data[0] || trimmed.data[i + 1] !== trimmed.data[1]) lit++;
    for (let k = 0; k < 4; k++)
      if (trimmed.data[i + k] !== whole.data[i + k]) {
        differing++;
        break;
      }
  }
  assert.ok(lit > 5000, `the frame is nearly empty (${lit} lit pixels)`);
  assert.equal(differing, 0, `${differing} pixels differ with the trimming off`);
  console.log(`ok - ${lit} lit pixels, none differ with the vertex inputs trimmed`);
} finally {
  await context.close();
  release();
}
