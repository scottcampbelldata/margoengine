// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/scatter/test/imposter.browser.mjs
// @margoengine/scatter/imposter draws the far LOD ring as octahedral imposters:
// 1. Same instances: the imposter scatter's far ring holds as many instances as the plain Scatter's (one distribute
//    pass, unchanged), and the near rings stay empty.
// 2. Same silhouettes: the pixels the imposters cover match the pixels the boxes cover (intersection over union of the
//    two masks against an empty frame), and the imposter frame is not the mesh frame.
// 3. Fallback: once the imposter is disposed, the far ring draws its mesh again, byte for byte the plain frame.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/imposter.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const make = async (kind) => {
  const { commands, errors } = await page.evaluate((kind) => window.check.make(kind), kind);
  assert.deepEqual(errors, [], kind);
  return { commands, image: await decodePNG(await page.locator('canvas').screenshot()) };
};
const differing = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};
// Pixels that differ from the empty frame in any channel.
const mask = (image, empty) => {
  const out = new Uint8Array(image.data.length / 4);
  for (let p = 0; p < out.length; p++)
    for (let k = 0; k < 3; k++) if (image.data[p * 4 + k] !== empty.data[p * 4 + k]) out[p] = 1;
  return out;
};

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const empty = (await make('none')).image;
    const plain = await make('plain');
    const imposter = await make('imposter');
    // Instance counts are word 1 of each ring's five-word indexed command.
    const rings = (c) => [c[1], c[6], c[11]];
    assert.deepEqual(rings(imposter.commands), rings(plain.commands), 'the same rings');
    assert.equal(rings(plain.commands)[0] + rings(plain.commands)[1], 0, 'nothing near');
    assert.ok(rings(plain.commands)[2] > 500, `${rings(plain.commands)[2]} far instances`);
    const a = mask(plain.image, empty),
      b = mask(imposter.image, empty);
    let both = 0,
      either = 0,
      meshPixels = 0;
    for (let p = 0; p < a.length; p++) {
      both += a[p] & b[p];
      either += a[p] | b[p];
      meshPixels += a[p];
    }
    const iou = both / either;
    assert.ok(meshPixels > 5000, `${meshPixels} box pixels`);
    assert.ok(iou > 0.8, `silhouettes overlap ${iou}`);
    assert.ok(differing(imposter.image, plain.image) > 0, 'the far ring is not drawn with its mesh');
    const fallback = await make('disposed');
    assert.equal(differing(fallback.image, plain.image), 0, 'a disposed imposter draws the far mesh again');
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter imposter', JSON.stringify({ far: rings(plain.commands)[2], meshPixels, iou }));
  },
  () => context.close(),
);
watchExit();
