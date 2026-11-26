// Run after building Physics and Weather. Use --compat for the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/weather/tests/snowpack-check.html', port: 5409 });
const { page, hardware } = context;
const uncaught = [];
page.on('pageerror', (error) => uncaught.push(error.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 25000 });
  const sample = async (frame) => {
    const data = await page.evaluate((n) => window.take(n), frame);
    assert.deepEqual(data.errors, []);
    const image = await decodePNG(await page.locator('canvas').screenshot());
    return { ...data, image };
  };
  const frozen = await sample(0),
    melting = await sample(60),
    bare = await sample(180);
  await page.evaluate(() => window.dispose());
  const plain = await sample(180);
  assert.equal(frozen.mass, 40);
  assert.ok(melting.mass > 0 && melting.mass < frozen.mass);
  assert.equal(bare.mass, 0);
  assert.ok(bare.version > frozen.version);
  let changed = 0;
  for (let i = 0; i < bare.image.data.length; i += 4)
    if (
      Math.abs(frozen.image.data[i] - bare.image.data[i]) +
        Math.abs(frozen.image.data[i + 1] - bare.image.data[i + 1]) +
        Math.abs(frozen.image.data[i + 2] - bare.image.data[i + 2]) >
      3
    )
      changed++;
  assert.ok(changed > 0, 'melt changes visible snow cover');
  assert.deepEqual(plain.image.data, bare.image.data, 'melted cover equals the bare rendered terrain');
  assert.deepEqual(uncaught, []);
  console.log(
    `${hardware?.compat ? 'WebGL2 compatibility' : 'WebGPU'}: the melting snowpack changed ${changed} pixels`,
  );
} finally {
  await context.close();
}
