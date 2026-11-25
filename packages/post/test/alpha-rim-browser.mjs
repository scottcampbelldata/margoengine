// Real-GPU check that post effects used alone on a transparent canvas leave no light rim (KB-POST-ALPHARIM1), built
// packages, on WebGPU and (MARGO_COMPAT=1) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/post/test/alpha-rim-browser.mjs
// A box turned about the view axis is drawn on a TransparentCanvas (@margoengine/environment) with each effect alone.
// The canvas is shot over a black page and over a white one, which gives each pixel's alpha (1 - (white - black) / 255)
// and premultiplied colour (the black shot). A partly covered silhouette pixel must hold the colour of the face beside
// it times its alpha. Before the fix the effects encoded the premultiplied colour of those pixels for display, so the
// rim was about 36 of 255 brighter than its alpha allows (37 with Bloom).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

const effects = [
  'SSAO',
  'GTAO',
  'SSGI',
  'SSR',
  'Bloom',
  'Afterimage',
  'LensFlare',
  'Blur',
  'Lens',
  'Anamorphic',
  'HeatHaze',
  'SelectiveBloom',
];

await postBrowser(
  'post-alpha-rim',
  5391,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { TransparentCanvas } = await import('/packages/environment/dist/index.js'),
        post = await import('/packages/post/dist/index.js'),
        { Blur } = await import('/packages/post/dist/blur.js'),
        { Lens } = await import('/packages/post/dist/lens.js'),
        { Anamorphic } = await import('/packages/post/dist/anamorphic.js'),
        { HeatHaze } = await import('/packages/post/dist/heat-haze.js'),
        { SelectiveBloom } = await import('/packages/post/dist/selective-bloom.js');
      const make = {
        ...post,
        Blur: { attach: (engine) => Blur.attach(engine, { kind: 'box', radius: 0 }) },
        Lens: { attach: (engine) => Lens.attach(engine) },
        Anamorphic: { attach: (engine) => Anamorphic.attach(engine) },
        HeatHaze: { attach: (engine) => HeatHaze.attach(engine) },
        SelectiveBloom: { attach: (engine) => SelectiveBloom.attach(engine, { mask: () => undefined }) },
      };
      window.t = {
        // Draws one frame with `name` alone (or no effect) and keeps the engine for the shots.
        async draw(name) {
          const engine = await Engine.create(document.querySelector('canvas'), {
            backend: 'webgpu',
            camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
          });
          engine.stop();
          TransparentCanvas.attach(engine);
          engine
            .createMesh()
            .setGeometry(box(1.2, 1.2, 1.2))
            .setMaterial(new PbrMaterial({ color: '#e0a050', roughness: 1 }))
            .setQuaternion([0, 0, Math.sin(Math.PI / 10), Math.cos(Math.PI / 10)]);
          if (name !== 'none') make[name].attach(engine);
          engine.render({ delta: 1 / 60 });
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
    const measure = async (name) => {
      await page.evaluate((n) => window.t.draw(n), name);
      await page.evaluate(() => window.t.page('#000'));
      const black = await shot();
      await page.evaluate(() => window.t.page('#fff'));
      const white = await shot();
      await page.evaluate(() => window.t.dispose());
      const { width, height } = black,
        at = (x, y) => (y * width + x) * 4,
        alpha = (i) => 1 - (white.data[i] - black.data[i]) / 255;
      let empty = 0,
        full = 0,
        edge = 0,
        rim = 0;
      for (let y = 2; y < height - 2; y++)
        for (let x = 2; x < width - 2; x++) {
          const i = at(x, y),
            a = alpha(i);
          if (a < 0.02) {
            empty++;
            continue;
          }
          if (a > 0.98) {
            full++;
            continue;
          }
          // The colour of the nearest fully covered pixel within 2, at this pixel's alpha.
          let nearest = Infinity;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
              const j = at(x + dx, y + dy);
              if (alpha(j) <= 0.98) continue;
              let d = 0;
              for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(black.data[i + c] - black.data[j + c] * a));
              nearest = Math.min(nearest, d);
            }
          if (nearest === Infinity) continue;
          edge++;
          rim = Math.max(rim, nearest);
        }
      return { empty, full, edge, rim };
    };
    const base = await measure('none');
    assert.ok(base.empty > 20000 && base.full > 5000 && base.edge > 60, `no effect: ${JSON.stringify(base)}`);
    for (const name of effects) {
      const r = await measure(name);
      assert.ok(r.empty > 20000 && r.full > 5000 && r.edge > 60, `${name}: ${JSON.stringify(r)}`);
      // The core render alone sets the floor (its multisample resolve in display space). Alpha and colour each come from
      // 8-bit shots, so an effect that adds no rim is within one 8-bit step of that floor.
      assert.ok(r.rim <= base.rim + 1, `${name}: an edge pixel is ${r.rim.toFixed(1)} of 255 from the face`);
      console.log(
        `ok ${name}: ${r.edge} edge pixels within ${r.rim.toFixed(1)} of 255 (no effect ${base.rim.toFixed(1)})`,
      );
    }
  },
  { seconds: 240 },
);
