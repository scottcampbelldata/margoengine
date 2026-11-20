// Real-GPU check, built packages, on WebGPU and the WebGL2 compatibility layer: Tonemap's contrast 0 gives flat 18%
// grey, sRGB code 118, in every pixel, black included. The documented form 0.18 * (x / 0.18) ** contrast is flat at
// 0.18 for contrast 0 (JavaScript's 0 ** 0 is 1, as IEEE 754 pow(x, 0) is for every x), but the shader's pow(0, 0) is
// left undefined by WGSL (pow is exp2(y log2 x), and log2 0 has no finite value) and by GLSL ES 3.00 (8.2: undefined
// when x = 0 and y <= 0); the 680M returned 0 there, so black stayed black. The source is a 320 x 240 ramp whose left
// half is exactly 0, which the default neutral curve keeps at 0 into the contrast.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

const W = 320,
  H = 240,
  grey = Math.round(255 * (1.055 * 0.18 ** (1 / 2.4) - 0.055));
for (const compat of [false, true])
  await postBrowser(
    'tonemap-contrast-zero',
    5353,
    () => launchBrowser({ headless: true }),
    async (page, shot) => {
      await page.evaluate(
        async ([W, H, compat]) => {
          if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
          const { Engine } = await import('/packages/core/dist/index.js'),
            { Tonemap } = await import('/packages/tonemap/dist/index.js');
          const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' }),
            device = engine.gpu;
          engine.stop();
          const data = new Float32Array(W * H * 4);
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              const v = x < W / 2 ? 0 : ((x - W / 2) / (W / 2)) * 4;
              data.set([v, v * 0.5, v * 0.25, 1], 4 * (y * W + x));
            }
          const source = device.createTexture({
            size: [W, H],
            format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          device.queue.writeTexture({ texture: source }, data, { bytesPerRow: W * 16 }, [W, H]);
          const tonemap = Tonemap.attach(engine, { source: () => source, contrast: 0 });
          engine.render({ delta: 1 / 60 });
          await device.queue.onSubmittedWorkDone();
          window.t = { engine, tonemap, source };
        },
        [W, H, compat],
      );
      const image = await shot();
      await page.evaluate(() => (window.t.source.destroy(), window.t.engine.dispose()));
      let off = 0,
        black = 0;
      for (let i = 0; i < image.data.length; i += 4)
        for (let c = 0; c < 3; c++) {
          if (image.data[i + c] !== grey) off++;
          if (image.data[i + c] === 0) black++;
        }
      console.log(JSON.stringify({ backend: compat ? 'webgl2-compat' : 'webgpu', grey, off, black }));
      assert.equal(
        off,
        0,
        `${compat ? 'compat' : 'webgpu'}: contrast 0 is flat grey ${grey} (${off} channels off, ${black} black)`,
      );
    },
  );
