import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ port: 'free', startPath: '/packages/toon/test/hatch-models.html' }),
  errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
const shot = async (kind, options, pose) => {
  const result = await context.page.evaluate((a) => window.check.run(...a), [kind, options, pose]);
  assert.equal(result.error, undefined);
  return decodePNG(await context.page.locator('canvas').screenshot());
};
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const plain = await shot('mesh');
  for (const style of ['hatch', 'halftone']) {
    const image = await shot('mesh', { style, spacing: 16, width: 4, layers: 3, angle: 10 });
    let ink = 0,
      paper = 0;
    for (let y = 128; y < 384; y++)
      for (let x = 128; x < 384; x++) {
        const i = (y * image.width + x) * 4;
        let distance = Infinity;
        if (style === 'hatch') {
          // At n.l=0.4, layers 0 and 1 are active, with independently calculated signed stripe distances.
          for (const angle of [10, 70]) {
            const a = (angle * Math.PI) / 180,
              t = ((x + 0.5) * Math.cos(a) + (y + 0.5) * Math.sin(a)) / 16;
            distance = Math.min(distance, Math.abs(t - Math.floor(t) - 0.5) * 16 - 2);
          }
        } else {
          const a = (10 * Math.PI) / 180,
            u = ((x + 0.5) * Math.cos(a) - (y + 0.5) * Math.sin(a)) / 16,
            v = ((x + 0.5) * Math.sin(a) + (y + 0.5) * Math.cos(a)) / 16;
          distance = Math.hypot(u - Math.floor(u) - 0.5, v - Math.floor(v) - 0.5) * 16 - 16 * Math.sqrt(0.6 / Math.PI);
        }
        if (distance < -1) {
          ink++;
          assert.ok(
            image.data[i] < plain.data[i] * 0.2,
            `stroke interior is ink at ${x},${y}: ${image.data[i]} vs ${plain.data[i]}, distance ${distance}`,
          );
        }
        if (distance > 1) {
          paper++;
          for (let k = 0; k < 3; k++)
            assert.ok(Math.abs(image.data[i + k] - plain.data[i + k]) <= 1, 'paper retains lit material');
        }
      }
    console.log({ style, ink, paper });
    assert.ok(ink > 5000 && paper > 5000);
  }
  const restored = await shot('mesh');
  assert.deepEqual(restored.data, plain.data, 'disposing restores exact image');
  const basicPlain = await shot('basic'),
    basicInk = await shot('basic', { spacing: 8, width: 3 });
  let basicChanged = 0;
  for (let i = 0; i < basicInk.data.length; i += 4) if (basicPlain.data[i] > basicInk.data[i] + 20) basicChanged++;
  assert.ok(basicChanged > 5000, 'basic material early returns are hatched in linear light');
  for (const pose of [0.1, 0.6]) {
    const before = await shot('fox', undefined, pose),
      after = await shot('fox', { spacing: 8, width: 2 }, pose);
    let darkened = 0;
    for (let i = 0; i < after.data.length; i += 4) if (before.data[i] > after.data[i] + 20) darkened++;
    assert.ok(darkened > 1000, 'real animated glTF is hatched');
    console.log({ pose, darkened });
    assert.deepEqual((await shot('fox', undefined, pose)).data, before.data);
  }
  assert.deepEqual(errors, []);
} finally {
  await context.close();
}
