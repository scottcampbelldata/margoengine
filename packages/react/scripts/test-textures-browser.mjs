import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { writeFile } from 'node:fs/promises';
import { compatRun } from '../../../scripts/support/compat-shim.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/textures-browser.html' });
const { page } = browser, errors = [], rows = [];
page.setDefaultTimeout(30000);
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => window.texturesProof);
  const selected = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
  const modes = selected ? [selected] : Array.from({ length: 10 }, (_, i) => [`image:${i}`, `image:${i}:scene`]).flat().concat(['ktx:0:scene', 'video:0:scene', 'rough:1:scene', 'transmission:0:scene']);
  for (const mode of modes) {
    await page.evaluate((mode) => window.texturesProof.mount(mode), mode);
    await page.waitForFunction(() => window.texturesProof.state.ready.every(Boolean) && window.texturesProof.state.frames.every((n) => n > 15));
    assert.deepEqual(await page.evaluate(() => window.texturesProof.state.errors), [], mode);
    const images = [];
    for (const side of [0, 1]) images.push(await decodePNG(await page.locator(`section[data-side="${side}"] canvas`).screenshot()));
    assert.deepEqual(images[0].data, images[1].data, `${mode}: exact native pixels`);
    assert.ok(images[1].data.some((v, i) => i % 4 !== 3 && v > 80), `${mode}: visible material`);
    rows.push({ mode, pixelsExact: true });
  }
  await page.evaluate(() => window.texturesProof.unmount());
  await page.waitForFunction(() => window.texturesProof.state.engines.every((engine) => engine.disposed));
  assert.deepEqual(errors, []);
  await writeFile(`test-results/react-textures${compatRun() ? '-compat' : ''}.json`, JSON.stringify({ hardware: browser.hardware, rows }, null, 2));
  console.log(JSON.stringify(rows));
} finally { await browser.close(); }
