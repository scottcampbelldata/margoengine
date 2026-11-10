import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/bindings-browser.html' });
const { page } = browser,
  errors = [],
  rows = [];
page.setDefaultTimeout(30_000);
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.waitForFunction(() => window.bindingProof);
  await mkdir('test-results', { recursive: true });
  for (const mode of ['lines', 'points', 'splats', 'parent', 'cameras', 'lod', 'outline', 'viewcube', 'url']) {
    await page.evaluate((mode) => window.bindingProof.mount(mode), mode);
    await page.waitForFunction(() => window.bindingProof.state.frames.every((n) => n >= 15));
    if (['lines', 'points', 'splats'].includes(mode))
      await page.waitForFunction(
        (mode) => window.bindingProof.refs[{ lines: 'line', points: 'points', splats: 'splat' }[mode]].current,
        mode,
      );
    if (mode === 'lod') await page.waitForFunction(() => window.bindingProof.refs.lod.current?.level === 1);
    if (mode === 'viewcube') {
      await page.waitForFunction(() => window.bindingProof.refs.cube.current);
      await page.evaluate(() => window.bindingProof.refs.cube.current.view('right', 0));
    }
    const images = [];
    for (const side of [0, 1])
      images.push(
        await decodePNG(
          await page
            .locator(`section[data-side="${side}"] canvas`)
            .screenshot({ path: `test-results/react-binding-${mode}-${side}${compatRun() ? '-compat' : ''}.png` }),
        ),
      );
    const a = images[0],
      b = images[1];
    let changed = 0,
      different = 0,
      green = 0;
    const bg = [...b.data.slice((255 * 256 + 255) * 4, (255 * 256 + 255) * 4 + 3)];
    for (let i = 0; i < b.data.length; i += 4) {
      if ([0, 1, 2].some((k) => Math.abs(b.data[i + k] - bg[k]) > 20)) changed++;
      if (b.data[i + 1] > 1.4 * Math.max(b.data[i], b.data[i + 2]) && b.data[i + 1] > 50) green++;
      if ([0, 1, 2].some((k) => a.data[i + k] !== b.data[i + k])) different++;
    }
    assert.ok(changed > 20, `${mode}: nonempty rendering (${changed})`);
    if (['lines', 'points', 'splats', 'parent', 'cameras'].includes(mode))
      assert.equal(different, 0, `${mode}: same pixels as the native package`);
    if (['lod', 'outline'].includes(mode)) assert.ok(green > 20, `${mode}: green distant level or outline (${green})`);
    assert.deepEqual(await page.evaluate(() => window.bindingProof.state.errors), [], mode);
    rows.push({ mode, changed, different, green });
  }
  await page.evaluate(() => window.bindingProof.unmount());
  await page.waitForFunction(() => window.bindingProof.state.engines.every((e) => e.disposed));
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/react-bindings${compatRun() ? '-compat' : ''}.json`,
    JSON.stringify({ hardware: browser.hardware, rows }, null, 2) + '\n',
  );
  console.log(JSON.stringify(rows));
} finally {
  await browser.close();
}
