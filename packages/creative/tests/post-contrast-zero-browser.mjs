// Real-GPU check, built packages, on WebGPU and the WebGL2 compatibility layer: PostProcessing's contrast 0 gives flat
// 18% grey through the PBR Neutral display transform in every pixel, black included. The documented form
// 0.18 * (c / 0.18) ** contrast is flat at 0.18 for contrast 0 (JavaScript's 0 ** 0 is 1, as IEEE 754 pow(x, 0) is for
// every x), but the shader's pow(0, 0) is left undefined by WGSL (pow is exp2(y log2 x), and log2 0 has no finite
// value) and by GLSL ES 3.00 (8.2: undefined when x = 0 and y <= 0); the 680M returned 0 there. A lift of -4 sends
// every scene channel to exactly 0 before the contrast, so the whole frame is that case.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';
import { pbrNeutral } from '../../shared/display.js';

const shown = pbrNeutral([0.18, 0.18, 0.18])[0],
  grey = Math.round(255 * (1.055 * shown ** (1 / 2.4) - 0.055));
for (const compat of [false, true])
  await postBrowser(
    'creative-post-contrast-zero',
    5354,
    () => launchBrowser({ headless: true }),
    async (page, shot) => {
      await page.evaluate(async (compat) => {
        if (compat) await (await import('/packages/webgl2-compat/dist/index.js')).install({ force: true });
        const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
          { PostProcessing } = await import('/packages/creative/dist/post.js');
        const engine = await Engine.create(document.querySelector('canvas'), {
          backend: 'webgpu',
          camera: { position: [0, 0, 5], target: [0, 0, 0] },
        });
        engine.stop();
        engine
          .createMesh()
          .setGeometry(box(1, 1.6, 0.2))
          .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1 }));
        engine.use(new PostProcessing({ grain: 0, contrast: 0, lift: [-4, -4, -4] }));
        engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
        window.t = { engine };
      }, compat);
      const image = await shot();
      await page.evaluate(() => window.t.engine.dispose());
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
