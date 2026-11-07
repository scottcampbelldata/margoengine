// Real-GPU check of SSS, built packages. A light box and a dark box meet in a vertical edge facing the camera, both
// fully masked. With SSS the edge softens, red over the widest span, then green, then blue (the default skin profile);
// away from the edge the flat faces keep their colour (the kernel is normalised); the background (no depth) is
// untouched; no mask and disabled both equal the frame without the effect.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-sss',
  5361,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { SSS } = await import('/packages/post/dist/sss.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 5], target: [0, 0, 0] } });
      engine.stop();
      for (const [x, color] of [
        [-1, '#d0d0d0'],
        [1, '#303030'],
      ])
        engine
          .createMesh()
          .setGeometry(box(2, 2, 0.2))
          .setPosition([x, 0, 0])
          .setMaterial(new PbrMaterial({ color, roughness: 1 }));
      const mask = engine.gpu.createTexture({
        size: [320, 240],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      engine.gpu.queue.writeTexture(
        { texture: mask },
        new Uint8Array(320 * 240).fill(255),
        { bytesPerRow: 320 },
        [320, 240],
      );
      const options = { mask: () => mask, radius: 0.12, taps: 16 },
        effect = new SSS(options);
      PostStack.attach(engine, [effect]);
      window.t = {
        engine,
        effect,
        mask,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    const frame = async (set) => {
      await page.evaluate(`(${set})(window.t.effect.options, window.t.mask); window.t.frame()`);
      await page.evaluate(() => window.t.engine.gpu.queue.onSubmittedWorkDone());
      return shot();
    };
    const on = await frame('() => {}');
    const off = await frame('(o) => { o.enabled = false; }');
    const none = await frame('(o, m) => { o.enabled = true; o.mask = () => undefined; }');
    const at = (img, x, y, c) => img.data[4 * (y * img.width + x) + c];
    // Width of the edge per channel on the middle rows: pixels between 10% and 90% of the way from dark to light.
    const widths = (img) =>
      [0, 1, 2].map((c) => {
        let n = 0;
        for (const y of [110, 120, 130]) {
          const light = at(img, 100, y, c),
            dark = at(img, 220, y, c);
          for (let x = 100; x <= 220; x++) {
            const s = (at(img, x, y, c) - dark) / (light - dark);
            if (s > 0.1 && s < 0.9) n++;
          }
        }
        return n / 3;
      });
    let flat = 0,
      background = 0,
      noneDiff = 0;
    for (let y = 95; y <= 145; y++)
      for (const x of [...Array(30).keys()].map((i) => 95 + i).concat([...Array(30).keys()].map((i) => 196 + i)))
        for (let c = 0; c < 3; c++) flat = Math.max(flat, Math.abs(at(on, x, y, c) - at(off, x, y, c)));
    for (let y = 0; y < 240; y++)
      for (const x of [0, 1, 2, 317, 318, 319])
        for (let c = 0; c < 3; c++) background = Math.max(background, Math.abs(at(on, x, y, c) - at(off, x, y, c)));
    for (let i = 0; i < on.data.length; i++) noneDiff = Math.max(noneDiff, Math.abs(none.data[i] - off.data[i]));
    const [r, g, b] = widths(on),
      sharp = Math.max(...widths(off));
    console.log(JSON.stringify({ widths: [r, g, b], sharp, flat, background, noneDiff }));
    await page.evaluate(() => window.t.engine.dispose());
    assert.ok(sharp <= 1, `without SSS the edge is sharp: ${sharp}`);
    assert.ok(r > g && g > b && b >= 1, `red spreads farthest, then green, then blue: ${[r, g, b]}`);
    assert.ok(flat <= 2, `flat faces keep their colour within 2/255: ${flat}`);
    assert.equal(background, 0, 'pixels with no depth are untouched');
    assert.equal(noneDiff, 0, 'no mask equals no effect');
  },
);
