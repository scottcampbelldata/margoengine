import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
await postBrowser(
  'post-effect-mask',
  5382,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { EffectMask } = await import('/packages/post/dist/mask.js');
      const { Blur } = await import('/packages/post/dist/blur.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      engine.stop();
      for (const [x, color] of [
        [-1, '#d0d0d0'],
        [1, '#303030'],
      ])
        engine
          .createMesh()
          .setGeometry(box(2, 2, 0.2))
          .setPosition([x, 0, 0])
          .setMaterial(new PbrMaterial({ color }));
      const mask = engine.gpu.createTexture({ size: [1, 2], format: 'rgba8unorm', usage: 6 });
      engine.gpu.queue.writeTexture(
        { texture: mask },
        new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255]),
        { bytesPerRow: 4 },
        [1, 2],
      );
      const effect = EffectMask.attach(engine, new Blur({ kind: 'box', radius: 6 }), { mask: () => mask });
      window.t = { engine, effect, mask };
    });
    const frame = async (enabled, inverted = false, opacity = 1) => {
      await page.evaluate(
        async ([enabled, inverted, opacity]) => {
          const t = window.t;
          Object.assign(t.effect.options, { enabled, inverted, opacity });
          t.engine.render({ delta: 1 / 60 });
          await t.engine.gpu.queue.onSubmittedWorkDone();
        },
        [enabled, inverted, opacity],
      );
      return shot();
    };
    const off = await frame(false),
      top = await frame(true),
      bottom = await frame(true, true),
      zero = await frame(true, false, 0);
    const changed = (a, y0, y1) => {
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < 320; x++) if (a.data[4 * (y * 320 + x)] !== off.data[4 * (y * 320 + x)]) n++;
      return n;
    };
    const result = {
      top: [changed(top, 0, 120), changed(top, 120, 240)],
      bottom: [changed(bottom, 0, 120), changed(bottom, 120, 240)],
      zero: changed(zero, 0, 240),
    };
    console.log(result);
    assert.ok(result.top[0] > 500);
    assert.equal(result.top[1], 0);
    assert.equal(result.bottom[0], 0);
    assert.ok(result.bottom[1] > 500);
    assert.equal(result.zero, 0);
    await page.evaluate(() => {
      window.t.effect.dispose();
      window.t.mask.destroy();
      window.t.engine.dispose();
    });
  },
);
