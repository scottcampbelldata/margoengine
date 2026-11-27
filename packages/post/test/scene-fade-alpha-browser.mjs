// Real-GPU check that SceneFade dissolves a transparent canvas (threejs-parity row 6), built packages, on WebGPU and
// (MARGO_COMPAT=1) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/post/test/scene-fade-alpha-browser.mjs
// A captured frame with a box on the left fades into one with the box on the right. Half way through, every pixel's
// premultiplied colour and alpha (from shots over a black and a white page) must be the mean of the two frames': the
// lerp operator of T. Porter and T. Duff, "Compositing Digital Images", SIGGRAPH 1984. Before the fix empty pixels
// turned half opaque black.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-scene-fade-alpha',
  5398,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { TransparentCanvas } = await import('/packages/environment/dist/index.js'),
        { SceneFade } = await import('/packages/post/dist/scene-fade.js');
      window.t = {
        // `from` and `to` are box positions; with `fade` the frame is half way from the first to the second.
        async draw(from, to, fade) {
          const engine = await Engine.create(document.querySelector('canvas'), {
            backend: 'webgpu',
            camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
          });
          engine.stop();
          TransparentCanvas.attach(engine);
          let now = 0;
          const effect = fade ? SceneFade.attach(engine, 1000, () => now) : undefined;
          const mesh = engine
            .createMesh()
            .setGeometry(box(1, 1, 1))
            .setMaterial(new PbrMaterial({ color: '#e0a050', roughness: 1 }))
            .setPosition([from, 0, 0]);
          engine.render({ delta: 1 / 60 });
          if (effect) {
            effect.capture();
            await effect.warm();
            effect.start();
            now = 500;
            mesh.setPosition([to, 0, 0]);
            engine.render({ delta: 1 / 60 });
          }
          await engine.gpu.queue.onSubmittedWorkDone();
          this.engine = engine;
        },
        page(color) {
          document.body.style.background = color;
        },
        dispose() {
          this.engine.dispose();
        },
      };
    });
    const measure = async (from, to, fade) => {
      await page.evaluate((a) => window.t.draw(...a), [from, to, fade]);
      await page.evaluate(() => window.t.page('#000'));
      const black = await shot();
      await page.evaluate(() => window.t.page('#fff'));
      const white = await shot();
      await page.evaluate(() => window.t.dispose());
      return { black: black.data, white: white.data };
    };
    const old = await measure(-0.7, -0.7, false),
      next = await measure(0.7, 0.7, false),
      half = await measure(-0.7, 0.7, true);
    let worst = 0,
      moved = 0;
    for (let i = 0; i < half.black.length; i += 4) {
      if (Math.abs(old.white[i + 2] - next.white[i + 2]) > 40) moved++;
      for (let c = 0; c < 3; c++)
        for (const key of ['black', 'white'])
          worst = Math.max(worst, Math.abs(half[key][i + c] - (old[key][i + c] + next[key][i + c]) / 2));
    }
    assert.ok(moved > 5000, `the two frames differ at only ${moved} pixels`);
    assert.ok(worst <= 1.5, `a half faded pixel is ${worst} of 255 from the mean of the two frames`);
    console.log(`ok SceneFade: ${moved} changing pixels within ${worst} of 255 of the mean of the two frames`);
  },
  { seconds: 120 },
);
