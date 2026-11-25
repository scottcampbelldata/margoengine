// Real-GPU check, built packages, on WebGPU and the WebGL2 compatibility layer (KB-CREATIVE-POSTVIEW1): two views side
// by side, each of a scene with its own PostProcessing grade, keep their own grade. The left scene grades with contrast 0
// and a lift of -4, which is flat 18% grey in every pixel; the right scene grades with gain [1, 0, 0], which leaves no
// green or blue anywhere. Before the fix the view drawn last graded and presented the whole canvas, so each half carried
// the other half's grade (the first view's grade was erased, and the second view's drew over the first's half).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';
import { pbrNeutral } from '../../shared/display.js';

const shown = pbrNeutral([0.18, 0.18, 0.18])[0],
  grey = Math.round(255 * (1.055 * shown ** (1 / 2.4) - 0.055));
for (const compat of [false, true])
  await postBrowser(
    'creative-post-views',
    5357,
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
        const left = engine.createScene('left'),
          right = engine.createScene('right');
        for (const scene of [left, right])
          scene
            .createMesh()
            .setGeometry(box(1, 1.6, 0.2))
            .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1 }));
        left.use(new PostProcessing({ grain: 0, contrast: 0, lift: [-4, -4, -4] }));
        right.use(new PostProcessing({ grain: 0, gain: [1, 0, 0] }));
        engine.render({
          delta: 1 / 60,
          views: [
            { camera: engine.camera, viewport: [0, 0, 0.5, 1], scene: left },
            { camera: engine.camera, viewport: [0.5, 0, 0.5, 1], scene: right },
          ],
        });
        await engine.gpu.queue.onSubmittedWorkDone();
        window.t = { engine };
      }, compat);
      const image = await shot();
      await page.evaluate(() => window.t.engine.dispose());
      const half = image.width / 2,
        result = { backend: compat ? 'webgl2-compat' : 'webgpu', grey, leftOff: 0, rightGreenBlue: 0, rightRed: 0 };
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          const i = (y * image.width + x) * 4;
          if (x < half) {
            for (let c = 0; c < 3; c++) if (image.data[i + c] !== grey) result.leftOff++;
          } else {
            result.rightGreenBlue += image.data[i + 1] + image.data[i + 2];
            result.rightRed += image.data[i];
          }
        }
      console.log(JSON.stringify(result));
      assert.equal(
        result.leftOff,
        0,
        `${result.backend}: the left view keeps its flat grey grade (${result.leftOff} off)`,
      );
      assert.equal(result.rightGreenBlue, 0, `${result.backend}: the right view keeps its red-only grade`);
      assert.ok(result.rightRed > 0, `${result.backend}: the right view drew its scene`);
    },
  );
