// Real-GPU check (run from the repository root after building packages; MARGO_COMPAT=1 for the WebGL2 layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/terrain/test/wet-ground.browser.mjs
// Wet ground on a clipmap `Terrain` (`@margoengine/terrain/wet-ground`) from a wetting record in `Flood.wetTexture`'s
// layout (rgba32float: green seconds since last wet, blue 1 once wet), each picture against its truth, a terrain drawn
// without the effect whose layer colour or roughness is what the wet ground should be:
// 1. no record, and a record that was never wet, draw the plain terrain exactly;
// 2. darker: fully wet ground with gloss 0 draws as the terrain with its layer colour times `darkening` (0.55);
// 3. shinier: fully wet ground with darkening 1, under the sun's mirror direction, draws as the terrain with roughness
//    0.9 x (1 - gloss) = 0.45, and its highlight is brighter than the dry ground's;
// 4. drying: at `dryTime` seconds since wet the ground draws as the layer times 1 - 0.45 / e, and at 20 x `dryTime` it
//    is dry again (as the plain terrain), and the look is live: `applyWetGroundSettings` moves it with no new pipeline;
// 5. a real dam-break `Flood`'s `wetTexture` binds as the record (format and layout), with no validation error.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { WetGround, applyWetGroundSettings } = await import('/packages/terrain/dist/wet-ground.js'),
        { Water } = await import('/packages/water/dist/index.js'),
        { Flood } = await import('/packages/water/dist/flood.js');
      const size = 128,
        n = 65,
        errors = [],
        toLinear = (v) => ((v / 255 + 0.055) / 1.055) ** 2.4,
        toSrgb = (l) => Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055)),
        dry = [150, 115, 85];
      // One frame: a flat terrain 32 m square of one layer colour `layer` (sRGB bytes), roughness `roughness`, the sun
      // from `sun`, and a WetGround over it with `record` (16 x 16 texels of [since, wasWet]) and `look` unless `look` is null.
      async function frame({ layer = dry, roughness, sun = [0.6, 0.5, 0.2], record, look = {}, live, flood }) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 20, 20], target: [0, 0, 0], near: 0.5, far: 400 },
          }),
          device = engine.gpu;
        device.pushErrorScope('validation');
        engine.lighting.direction.set([...sun, 3]);
        engine.lighting.radiance.set([1, 1, 1, 0.3]);
        const terrain = Terrain.attach(engine, {
          origin: [-16, -16],
          size: [32, 32],
          heightScale: 1,
          cellSize: 0.5,
          resolution: 16,
          levels: 6,
          ...(roughness !== undefined ? { roughness } : {}),
          layers: Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.05 })),
          textures(gpu) {
            const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 15 }),
              layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
            gpu.queue.writeTexture({ texture: heightmap }, new Float32Array(n * n), { bytesPerRow: n * 4 }, [n, n]);
            gpu.queue.writeTexture(
              { texture: layers },
              new Uint8Array(16).map((_, k) => (k % 4 === 3 ? 255 : layer[k % 4])),
              { bytesPerRow: 4, rowsPerImage: 1 },
              [1, 1, 4],
            );
            return { heightmap, layers };
          },
        });
        let texture, wet, water, f;
        if (record !== undefined) {
          if (record) {
            texture = device.createTexture({
              size: [16, 16],
              format: 'rgba32float',
              usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            const data = new Float32Array(16 * 16 * 4);
            for (let k = 0; k < 256; k++) data.set([1, record[0], record[1], 0], k * 4);
            device.queue.writeTexture({ texture }, data, { bytesPerRow: 16 * 16 }, [16, 16]);
          }
          wet = WetGround.attach(engine, terrain, {
            record: () => texture,
            origin: [-16, -16],
            size: [32, 32],
            ...look,
          });
        }
        if (flood) {
          // A dam break of 1 m held west of x = -10 m on the terrain's own heightmap, below the camera's view of the ground.
          water = Water.attach(engine, {
            height: -50,
            size: [64, 64],
            segments: 4,
            terrain: { heightmap: () => terrain.heightmap, origin: [-16, -16], size: [32, 32] },
            fill: (x) => (x < -10 ? 1 : undefined),
          });
          f = Flood.attach(engine, { surface: water, maxDepth: 2, maxSpeed: 6 });
          wet = WetGround.attach(engine, terrain, { record: () => f.wetTexture, origin: [-16, -16], size: [32, 32] });
        }
        for (let k = 0; k < 4; k++) {
          engine.render({ delta: flood ? 0.25 : 0 });
          await device.queue.onSubmittedWorkDone();
        }
        let pipelines = 0;
        if (live) {
          const create = device.createRenderPipeline.bind(device);
          device.createRenderPipeline = (d) => (pipelines++, create(d));
          await live(wet, engine);
        }
        engine.render({ delta: 0 });
        const c = new OffscreenCanvas(size, size).getContext('2d');
        c.drawImage(canvas, 0, 0);
        await device.queue.onSubmittedWorkDone();
        const extra = f
            ? { format: f.wetTexture?.format, wetCells: (await f.read()).depth.filter((d) => d > 0.01).length }
            : {},
          error = await device.popErrorScope();
        if (error) errors.push(error.message);
        wet?.dispose();
        f?.dispose();
        water?.dispose();
        texture?.destroy();
        engine.dispose();
        canvas.remove();
        return { pixels: c.getImageData(0, 0, size, size).data, pipelines, ...extra };
      }
      // Mean and worst channel difference over the ground (the lower half of the picture, inside the terrain).
      const diff = (a, b) => {
        let sum = 0,
          worst = 0,
          k = 0;
        for (let y = size / 2; y < size; y++)
          for (let x = 8; x < size - 8; x++, k++) {
            const p = (y * size + x) * 4,
              d = Math.max(...[0, 1, 2].map((q) => Math.abs(a[p + q] - b[p + q])));
            sum += d;
            worst = Math.max(worst, d);
          }
        return { mean: sum / k, worst };
      };
      const luma = (a) => {
        let s = 0,
          k = 0;
        for (let y = size / 2; y < size; y++) for (let x = 8; x < size - 8; x++, k++) s += a[(y * size + x) * 4 + 1];
        return s / k;
      };
      const out = {};
      const plain = (await frame({})).pixels;
      out.none = diff((await frame({ record: null })).pixels, plain);
      out.never = diff((await frame({ record: [0, 0] })).pixels, plain);
      // 2. darker.
      const darker = dry.map((v) => toSrgb(toLinear(v) * 0.55));
      const wetDark = (await frame({ record: [0, 1], look: { gloss: 0 } })).pixels;
      out.dark = diff(wetDark, (await frame({ layer: darker })).pixels);
      out.darkLuma = [luma(wetDark), luma(plain)];
      // 3. shinier, the sun at the mirror direction of the view over the middle of the ground.
      const mirror = [0, Math.SQRT1_2, -Math.SQRT1_2];
      const shinyDry = (await frame({ sun: mirror })).pixels,
        shinyWet = (await frame({ sun: mirror, record: [0, 1], look: { darkening: 1 } })).pixels;
      out.gloss = diff(shinyWet, (await frame({ sun: mirror, roughness: 0.45 })).pixels);
      out.glossLuma = [luma(shinyWet), luma(shinyDry)];
      // 4. drying: at dryTime and at 20 x dryTime (100 s here), then live.
      const halfDry = dry.map((v) => toSrgb(toLinear(v) * (1 - 0.45 / Math.E)));
      out.drying = diff(
        (await frame({ record: [100, 1], look: { gloss: 0, dryTime: 100 } })).pixels,
        (await frame({ layer: halfDry })).pixels,
      );
      out.dried = diff((await frame({ record: [2000, 1], look: { gloss: 0, dryTime: 100 } })).pixels, plain);
      const live = await frame({
        record: [0, 1],
        look: { gloss: 0, darkening: 1 },
        live: async (wet, engine) => {
          // fixed-wait: 30 deliberate frames, each with a new darkening (no readiness is awaited): the test counts the pipelines they make.
          for (let k = 0; k < 30; k++) {
            applyWetGroundSettings(wet, { 'wet.darkening': 1 - (0.45 * (k + 1)) / 30 });
            engine.render({ delta: 0 });
          }
        },
      });
      out.live = diff(live.pixels, (await frame({ layer: darker })).pixels);
      out.livePipelines = live.pipelines;
      // 5. a real Flood's record.
      const flooded = await frame({ flood: true });
      out.flood = { format: flooded.format, wetCells: flooded.wetCells };
      return { ...out, errors };
    });
    console.log(JSON.stringify(result));
    assert.deepEqual(result.errors, [], 'no validation error');
    assert.equal(result.none.worst, 0, 'no record draws the plain terrain');
    assert.equal(result.never.worst, 0, 'a record never wet draws the plain terrain');
    assert.ok(result.dark.worst <= 2, `fully wet ground is the layer times 0.55: worst ${result.dark.worst} of 255`);
    assert.ok(result.darkLuma[0] < 0.8 * result.darkLuma[1], `wet ground is darker: ${result.darkLuma}`);
    assert.ok(result.gloss.worst <= 2, `fully wet ground shines as roughness 0.45: worst ${result.gloss.worst} of 255`);
    assert.ok(
      result.glossLuma[0] > result.glossLuma[1] + 5,
      `wet ground under the mirror sun is brighter: ${result.glossLuma}`,
    );
    assert.ok(
      result.drying.worst <= 2,
      `at dryTime the ground is the layer times 1 - 0.45 / e: worst ${result.drying.worst}`,
    );
    assert.ok(result.dried.worst <= 1, `at 20 x dryTime it is dry again: worst ${result.dried.worst}`);
    assert.ok(result.live.worst <= 2, `applyWetGroundSettings moves the look live: worst ${result.live.worst}`);
    assert.equal(result.livePipelines, 0, '30 live frames make no pipeline');
    assert.equal(result.flood.format, 'rgba32float', "a Flood's wetTexture is the record");
    assert.ok(result.flood.wetCells > 0, 'the dam break wet the ground');
    console.log(
      `wet ground: darker ${(result.darkLuma[0] / result.darkLuma[1]).toFixed(3)} of dry (green), highlight ${(result.glossLuma[0] / result.glossLuma[1]).toFixed(3)} x dry; against truth worst ${result.dark.worst}, ${result.gloss.worst}, ${result.drying.worst}, ${result.dried.worst}`,
    );
  },
  () => context.close(),
);
watchExit();
