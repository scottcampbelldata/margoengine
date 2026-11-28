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
  'DOF',
  'TAA',
  'TAA variance with locks',
  'TAA reactive',
  'TAA with Sharpen',
  'TAA without settling',
  // Composites outside post's own effects that write the canvas from a linear capture (KB-WATER-ALPHARIM1). The water
  // surface lies far under the view and the liquid's one particle too, so each passes the box through.
  'Underwater',
  'ParticleLiquid',
  'Water Caustics',
  'SurfaceCaustics',
  'LensDrops',
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
        { SelectiveBloom } = await import('/packages/post/dist/selective-bloom.js'),
        { DOF } = await import('/packages/dof/dist/index.js'),
        { TAA } = await import('/packages/taa/dist/index.js'),
        { Sharpen } = await import('/packages/taa/dist/sharpen.js'),
        { Water } = await import('/packages/water/dist/index.js'),
        { Underwater } = await import('/packages/water/dist/underwater.js'),
        { ParticleLiquid } = await import('/packages/water/dist/liquid.js'),
        { Caustics } = await import('/packages/water/dist/caustics.js'),
        { SurfaceCaustics } = await import('/packages/post/dist/caustics.js'),
        { LensDrops } = await import('/packages/weather/dist/lens.js');
      const sea = (engine) =>
        Water.attach(engine, {
          size: [2, 2],
          segments: 4,
          height: -60,
          waves: [{ direction: [1, 0], amplitude: 0.01, wavelength: 1 }],
        });
      const taa = (options) => ({ attach: (engine) => TAA.attach(engine, options(engine)) });
      const make = {
        ...post,
        Blur: { attach: (engine) => Blur.attach(engine, { kind: 'box', radius: 0 }) },
        Lens: { attach: (engine) => Lens.attach(engine) },
        Anamorphic: { attach: (engine) => Anamorphic.attach(engine) },
        HeatHaze: { attach: (engine) => HeatHaze.attach(engine) },
        SelectiveBloom: { attach: (engine) => SelectiveBloom.attach(engine, { mask: () => undefined }) },
        // In focus on the front face, so the silhouette stays sharp.
        DOF: { attach: (engine) => DOF.attach(engine, { focalDistance: 2.6 }) },
        TAA: taa(() => ({})),
        'TAA variance with locks': taa(() => ({ rejection: 'variance', locks: true })),
        'TAA reactive': taa((engine) => {
          const mask = engine.gpu.createTexture({
            size: [1, 1],
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING,
          });
          return { reactive: () => mask };
        }),
        'TAA with Sharpen': taa(() => ({ present: new Sharpen() })),
        'TAA without settling': taa(() => ({ settle: false })),
        Underwater: { attach: (engine) => Underwater.attach(engine, { surface: sea(engine) }) },
        ParticleLiquid: {
          attach: (engine) =>
            ParticleLiquid.attach(engine, { particles: { positions: new Float32Array([0, -60, 0]) }, radius: 0.05 }),
        },
        'Water Caustics': { attach: (engine) => Caustics.attach(engine, { surface: sea(engine), enabled: false }) },
        SurfaceCaustics: {
          attach: (engine) =>
            SurfaceCaustics.attach(engine, {
              geometry: {
                positions: new Float32Array([-1, -60, -1, 1, -60, -1, 0, -60, 1]),
                indices: new Uint32Array([0, 2, 1]),
              },
              enabled: false,
            }),
        },
        LensDrops: { attach: (engine) => LensDrops.attach(engine, { enabled: false }) },
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
          if (name !== 'none') await make[name].attach(engine);
          // TAA accumulates and settles over its jitter cycle; the others draw the same picture every frame.
          for (let i = 0; i < (name.startsWith('TAA') ? 24 : 1); i++) engine.render({ delta: 1 / 60 });
          await engine.gpu.queue.onSubmittedWorkDone();
          this.engine = engine;
        },
        page(color) {
          document.body.style.background = color;
        },
        dispose() {
          this.engine.dispose();
        },
        // The camera 3 m under a sea with only the box in the water (KB-WATER-LIQUIDALPHA1): every pixel looks through water.
        async under() {
          const engine = await Engine.create(document.querySelector('canvas'), {
            backend: 'webgpu',
            camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
          });
          engine.stop();
          TransparentCanvas.attach(engine);
          engine
            .createMesh()
            .setGeometry(box(1.2, 1.2, 1.2))
            .setMaterial(new PbrMaterial({ color: '#e0a050' }));
          const surface = Water.attach(engine, {
            size: [20, 20],
            segments: 4,
            height: 3,
            waves: [{ direction: [1, 0], amplitude: 0.01, wavelength: 1 }],
          });
          Underwater.attach(engine, { surface });
          for (let i = 0; i < 3; i++) {
            engine.render({ delta: 1 / 60 });
            await engine.gpu.queue.onSubmittedWorkDone();
          }
          this.engine = engine;
        },
        // Raindrops on the lens over an empty canvas (KB-WEATHER-LENSGLINT1): the glint is all the frame holds.
        async drops() {
          const engine = await Engine.create(document.querySelector('canvas'), {
            backend: 'webgpu',
            camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
          });
          engine.stop();
          TransparentCanvas.attach(engine);
          await LensDrops.attach(engine, { wetness: 1, radius: 0.06, speed: 0, streaks: 1, time: 0 });
          engine.render({ delta: 1 / 60 });
          await engine.gpu.queue.onSubmittedWorkDone();
          this.engine = engine;
        },
        // A liquid over nothing (KB-WATER-LIQUIDALPHA1): one ball of liquid before the empty canvas, or two blobs of
        // particles meeting head on so that whitewater flies clear of them.
        async liquid(absorption, spray) {
          const engine = await Engine.create(document.querySelector('canvas'), {
            backend: 'webgpu',
            camera: { position: [0, 0, 3.2], target: [0, 0, 0] },
          });
          engine.stop();
          TransparentCanvas.attach(engine);
          const positions = [],
            velocities = [];
          if (spray)
            for (const side of [-1, 1])
              for (let i = 0; i < 6; i++)
                for (let j = 0; j < 6; j++)
                  for (let k = 0; k < 6; k++) {
                    positions.push(side * 0.3 + (i - 2.5) * 0.1, (j - 2.5) * 0.1, (k - 2.5) * 0.1);
                    velocities.push(-side * 4, 0, 0);
                  }
          else positions.push(0, 0, 0);
          const liquid = ParticleLiquid.attach(engine, {
            particles: {
              positions: new Float32Array(positions),
              velocities: spray ? new Float32Array(velocities) : undefined,
            },
            radius: spray ? 0.05 : 0.4,
            absorption,
            whitewater: spray ? { maxParticles: 65536, trappedAirRate: 3000, waveCrestRate: 3000 } : undefined,
          });
          engine.render({ delta: 0 });
          let foam = 0;
          if (spray) {
            await liquid.readWhitewater().catch(() => undefined);
            for (let step = 0; step < 30; step++) {
              liquid.update();
              engine.render({ delta: 0 });
              const counts = await liquid.readWhitewater();
              foam = counts.spray + counts.foam + counts.bubbles;
            }
          }
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
          this.engine = engine;
          return foam;
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
    // The liquid itself over empty pixels covers them by what it reflects and absorbs (it kept the scene's alpha of 0,
    // so the page showed through it whole), and no pixel adds light where it covers nothing.
    const read = async () => {
      await page.evaluate(() => window.t.page('#000'));
      const black = await shot();
      // Coverage from a grey page: over a white one, light added without coverage clips at white and reads as covered.
      await page.evaluate(() => window.t.page('#808080'));
      const grey = await shot();
      await page.evaluate(() => window.t.dispose());
      const alpha = (i) => 1 - (grey.data[i] - black.data[i]) / 128;
      let covered = 0,
        bare = 0;
      for (let i = 0; i < black.data.length; i += 4) {
        if (alpha(i) > 0.02) covered++;
        else if (Math.max(black.data[i], black.data[i + 1], black.data[i + 2]) > 8) bare++;
      }
      const centre = (black.height / 2) * black.width + black.width / 2;
      return { covered, bare, pixels: black.data.length / 4, alpha: alpha(centre * 4) };
    };
    const over = async (absorption, spray) => {
      const foam = await page.evaluate(([a, s]) => window.t.liquid(a, s), [absorption, spray]);
      return { foam, ...(await read()) };
    };
    const dense = await over([3, 3, 3], false),
      clear = await over([0, 0, 0], false),
      spray = await over([0.38, 0.1, 0.045], true);
    console.log(`liquid over nothing: ${JSON.stringify({ dense, clear, spray })}`);
    // Through the middle of the 0.8 m ball: 1 - 0.98 exp(-3 t) covered, 0.9 for any chord t of 0.75 m or more.
    assert.ok(dense.alpha > 0.75 && dense.covered > 500, `dense liquid: ${JSON.stringify(dense)}`);
    // Clear liquid seen face on covers only by its 2 percent reflection.
    assert.ok(clear.alpha < 0.1, `clear liquid: ${JSON.stringify(clear)}`);
    assert.ok(spray.foam > 50 && spray.covered > 500, `whitewater: ${JSON.stringify(spray)}`);
    for (const [name, result] of Object.entries({ dense, clear, spray }))
      assert.equal(result.bare, 0, `${name}: ${result.bare} pixels add light and cover nothing`);
    console.log('ok ParticleLiquid over empty pixels covers by what it reflects and absorbs');
    await page.evaluate(() => window.t.drops());
    const drops = await read();
    console.log(`lens drops over nothing: ${JSON.stringify(drops)}`);
    assert.ok(drops.covered > 100, `lens drops: ${JSON.stringify(drops)}`);
    assert.equal(drops.bare, 0, `lens drops: ${drops.bare} pixels add light and cover nothing`);
    console.log('ok LensDrops over empty pixels covers by its glint');
    // Under water the view ends in the water itself, so the water covers the canvas where the scene holds nothing.
    await page.evaluate(() => window.t.under());
    const under = await read();
    console.log(`under water: ${JSON.stringify(under)}`);
    assert.equal(under.covered, under.pixels, `under water: ${JSON.stringify(under)}`);
    assert.equal(under.bare, 0, `under water: ${under.bare} pixels add light and cover nothing`);
    console.log('ok Underwater covers the empty canvas by what the water absorbs and scatters');
  },
  { seconds: 240 },
);
