// Real-GPU check that TAA's history keeps premultiplied alpha under motion (threejs-parity row 6), built packages, on
// WebGPU and (MARGO_COMPAT=1) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/taa/test/alpha-browser.mjs
// A flat plate slides across a TransparentCanvas for 20 frames. The canvas is shot over a black page and over a white
// one, which gives each pixel's alpha and premultiplied colour. Colour and alpha are accumulated with the same weights
// (T. Porter and T. Duff, "Compositing Digital Images", SIGGRAPH 1984), so every pixel must hold the plate's colour
// times its alpha, empty pixels included, and the pixels away from the plate must be empty. TAA runs alone, and before
// Tonemap, where it accumulates linear HDR. Before the fix TAA wrote opaque alpha.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

await postBrowser(
  'taa-alpha',
  5399,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { TransparentCanvas } = await import('/packages/environment/dist/index.js'),
        { TAA } = await import('/packages/taa/dist/index.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js');
      window.t = {
        async draw({ taa, tonemap }) {
          const engine = await Engine.create(document.querySelector('canvas'), {
            backend: 'webgpu',
            camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
          });
          engine.stop();
          TransparentCanvas.attach(engine);
          const plate = engine
            .createMesh()
            .setGeometry(box(1, 1, 0.001))
            .setMaterial(new PbrMaterial({ color: '#e0a050', roughness: 1 }));
          if (taa) TAA.attach(engine, taa);
          if (tonemap) Tonemap.attach(engine);
          for (let i = 0; i < 20; i++) {
            plate.setPosition([-0.5 + i * 0.037, 0, 0]);
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
    const measure = async (options) => {
      await page.evaluate((o) => window.t.draw(o), options);
      await page.evaluate(() => window.t.page('#000'));
      const black = await shot();
      await page.evaluate(() => window.t.page('#fff'));
      const white = await shot();
      await page.evaluate(() => window.t.dispose());
      const { width, height } = black,
        // The plate's colour: the centre of its last place.
        centre = (Math.floor(height / 2) * width + Math.floor(width / 2) + 20) * 4,
        face = [0, 1, 2].map((c) => black.data[centre + c]);
      let empty = 0,
        partial = 0,
        off = 0;
      for (let i = 0; i < black.data.length; i += 4) {
        const a = 1 - (white.data[i + 2] - black.data[i + 2]) / 255;
        if (a < 0.004) empty++;
        else if (a < 0.98) partial++;
        for (let c = 0; c < 3; c++) off = Math.max(off, Math.abs(black.data[i + c] - face[c] * a));
      }
      assert.ok(face[0] > 40, `the plate does not cover the centre: ${face}`);
      return { empty, partial, off };
    };
    for (const tonemap of [false, true]) {
      const base = await measure({ tonemap });
      assert.ok(base.empty > 50000, `no TAA: ${JSON.stringify(base)}`);
      for (const [name, taa] of [
        ['TAA', {}],
        ['TAA variance with locks', { rejection: 'variance', locks: true }],
        ['TAA stochastic', { stochastic: true }],
      ]) {
        const r = await measure({ taa, tonemap }),
          label = `${name}${tonemap ? ' before Tonemap' : ''}`;
        assert.ok(r.empty > 50000 && r.partial > 20, `${label}: ${JSON.stringify(r)}`);
        // The render alone sets the floor (the face's shading across the plate and the multisample resolve).
        assert.ok(
          r.off <= base.off + 2,
          `${label}: a pixel is ${r.off.toFixed(1)} of 255 from the plate times its alpha`,
        );
        console.log(
          `ok ${label}: ${r.partial} partly covered, ${r.empty} empty, within ${r.off.toFixed(1)} of 255 (no TAA ${base.off.toFixed(1)})`,
        );
      }
    }
  },
  { seconds: 240 },
);
