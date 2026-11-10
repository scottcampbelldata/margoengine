import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';
import { postBrowser } from './post-browser.mjs';
await postBrowser(
  'post-selective-bloom',
  5381,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    if (compatRun()) await page.evaluate(compatShim);
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { SelectiveBloom } = await import('/packages/post/dist/selective-bloom.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      engine.stop();
      for (const x of [-1, 1])
        engine
          .createMesh()
          .setGeometry(box(0.15, 2, 0.1))
          .setPosition([x, 0, 0])
          .setMaterial(new PbrMaterial({ color: '#ffffff' }));
      const mask = engine.gpu.createTexture({ size: [2, 1], format: 'rgba8unorm', usage: 6 });
      engine.gpu.queue.writeTexture(
        { texture: mask },
        new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255]),
        { bytesPerRow: 8 },
        [2, 1],
      );
      const effect = SelectiveBloom.attach(engine, { mask: () => mask, threshold: 0, strength: 4, radius: 0 });
      window.t = { engine, effect, mask };
    });
    const frame = async (enabled, inverted = false) => {
      await page.evaluate(
        async ([enabled, inverted]) => {
          const t = window.t;
          t.effect.options.enabled = enabled;
          t.effect.options.inverted = inverted;
          t.engine.render({ delta: 1 / 60 });
          await t.engine.gpu.queue.onSubmittedWorkDone();
        },
        [enabled, inverted],
      );
      return shot();
    };
    const off = await frame(false),
      left = await frame(true),
      right = await frame(true, true);
    const gain = (image, side) => {
      let total = 0;
      for (let y = 30; y < 210; y++)
        for (let x = side ? 170 : 10; x < (side ? 310 : 150); x++) {
          const i = 4 * (y * 320 + x);
          if (off.data[i] < 80) total += Math.max(0, image.data[i] - off.data[i]);
        }
      return total;
    };
    const result = { left: [gain(left, 0), gain(left, 1)], right: [gain(right, 0), gain(right, 1)] };
    console.log(result);
    assert.ok(result.left[0] > 10000 && result.left[0] > result.left[1] * 4, 'only selected left light seeds glow');
    assert.ok(result.right[1] > 10000 && result.right[1] > result.right[0] * 4, 'inversion selects right light');
    await page.evaluate(() => {
      window.t.effect.dispose();
      window.t.mask.destroy();
      window.t.engine.dispose();
    });
  },
);
