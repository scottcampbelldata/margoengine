import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const isolated = {
  name: 'terramechanics-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, hardware, close } = await openBrowser({
  startPath: '/packages/physics/tests/terramechanics.html',
  port: 'free',
  plugins: [isolated],
});
const errors = [];
const assets = new Set();
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const { pathname } = new URL(response.url());
  if (pathname.includes('terramechanics-kernel') && response.ok()) assets.add(pathname.split('/').at(-1));
});
try {
  await page.waitForFunction(() => typeof window.runTerramechanics === 'function', null, { timeout: 20_000 });
  assert.deepEqual([...assets], []);
  const results = await page.evaluate(() => window.runTerramechanics());
  for (const [tier, [plain, shared]] of Object.entries(results)) {
    assert.ok(plain.min < 0 && plain.max > 0 && plain.mass > 0);
    assert.deepEqual(plain, shared);
    console.log(`Browser EARTH-05 ${tier} replay ${plain.hash}, rut ${plain.min} m, lofted ${plain.mass} kg.`);
  }
  assert.notEqual(results.mean[0].min, results.resolved[0].min);
  assert.deepEqual([...assets].sort(), ['terramechanics-kernel-shared.wasm', 'terramechanics-kernel.wasm']);
  await page.evaluate(() => window.prepareTerramechanicsRender());
  const flat = await page.evaluate(() => window.terramechanicsFrame(0));
  const canvas = page.locator('#soil');
  const before = await decodePNG(await canvas.screenshot());
  const rut = await page.evaluate(() => window.terramechanicsFrame(30));
  const after = await canvas.screenshot();
  const rendered = await decodePNG(after);
  assert.equal(flat.elevation, 0);
  assert.ok(rut.elevation < -0.05);
  assert.ok(flat.drawCalls > 0 && rut.drawCalls > 0);
  assert.deepEqual([...flat.errors, ...rut.errors], []);
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta =
      Math.abs(before.data[i] - rendered.data[i]) +
      Math.abs(before.data[i + 1] - rendered.data[i + 1]) +
      Math.abs(before.data[i + 2] - rendered.data[i + 2]);
    if (delta > 25) changed++;
  }
  assert.ok(changed > 500, `Physical soil relief changed only ${changed} rendered pixels`);
  const backend = hardware?.compat ? 'webgl2' : 'webgpu';
  const output = 'test-results/ear05-render';
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/${backend}.png`, after);
  await page.evaluate(() => window.closeTerramechanicsRender());
  console.log(`EARTH-05 physical bed render on ${backend}: ${changed} changed pixels, ${rut.elevation} m centre.`);
  assert.deepEqual(errors, []);
} finally {
  await close();
}
