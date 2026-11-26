import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const isolated = {
  name: 'pbf-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, hardware, close } = await openBrowser({
  startPath: '/packages/physics/tests/pbf.html',
  port: 'free',
  plugins: [isolated],
});
const errors = [];
const fetched = new Set();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const { pathname } = new URL(response.url());
  if (pathname.includes('/pbf-kernel') && response.ok()) fetched.add(pathname.split('/').at(-1));
});
try {
  await page.waitForFunction(() => typeof window.pbfFrame === 'function', null, { timeout: 20000 });
  const first = await page.evaluate(() => window.pbfFrame(1));
  const before = await decodePNG(await page.locator('canvas').screenshot());
  const last = await page.evaluate(() => window.pbfFrame(32));
  const screenshot = await page.locator('canvas').screenshot();
  const after = await decodePNG(screenshot);
  assert.ok(first.shared && last.shared);
  assert.deepEqual([...fetched], ['pbf-kernel-shared.wasm']);
  assert.equal(last.points, 1800);
  assert.equal(last.stats.particles, last.points);
  assert.equal(last.mass, first.mass);
  assert.ok(
    last.front - first.front > 0.32,
    `Expected more than one column width of travel, got ${last.front - first.front}`,
  );
  assert.deepEqual([...errors, ...first.errors, ...last.errors], []);
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (delta > 25) changed++;
  }
  assert.ok(changed > 750, `The rendered liquid changed only ${changed} pixels`);
  const backend = hardware?.compat ? 'webgl2' : 'webgpu';
  await mkdir('test-results/fluid02-browser', { recursive: true });
  await writeFile(`test-results/fluid02-browser/${backend}.png`, screenshot);
  console.log(JSON.stringify({ backend, changed, ...last }));
  await page.evaluate(() => window.closePbf());
} finally {
  await close();
}
