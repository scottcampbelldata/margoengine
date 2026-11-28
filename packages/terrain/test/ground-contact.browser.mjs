// Real-GPU check (run from the repository root after building packages; --compat for the WebGL2 layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/terrain/test/ground-contact.browser.mjs
// Ground contact on a flat clipmap `Terrain` (`@margoengine/terrain/ground-contact`) seen from above:
// 1. under the sky's light alone, one 2 m stone footprint takes 0.354, 0.089 and 0.032 of it at 1, 2 and 3 radii (the
//    form factor of a resting sphere), and the ground past 4 radii draws the same bytes as without the effect;
// 2. under the sun alone, with no soil, the effect changes nothing;
// 3. a red soil colour shows around the foot and nowhere past it;
// 4. footprints set and removed after the first frame rebake the mask, with no new pipeline.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { TerrainGroundContact } = await import('/packages/terrain/dist/ground-contact.js'),
        { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const size = 256,
        n = 65,
        errors = [],
        canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.style.width = canvas.style.height = size + 'px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 48, 0.001], target: [0, 0, 0], near: 1, far: 200 },
        }),
        device = engine.gpu;
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const terrain = Terrain.attach(engine, {
        origin: [-16, -16],
        size: [32, 32],
        heightScale: 1,
        cellSize: 0.5,
        resolution: 64,
        levels: 3,
        layers: Array.from({ length: 4 }, () => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.05 })),
        textures(gpu) {
          const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 15 }),
            layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture({ texture: heightmap }, new Float32Array(n * n), { bytesPerRow: n * 4 }, [n, n]);
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array(16).map((_, k) => (k % 4 === 3 ? 255 : 200)),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return { heightmap, layers };
        },
      });
      const read = document.createElement('canvas');
      read.width = read.height = size;
      const pen = read.getContext('2d', { willReadFrequently: true });
      const shot = async (light) => {
        engine.lighting.direction.set([0.3, 1, 0.2, light === 'sun' ? 2 : 0]);
        engine.lighting.radiance.set([1, 1, 1, light === 'sun' ? 0 : 0.9]);
        await waitForPipelines(async () => {
          engine.render({ delta: 0 });
          pen.drawImage(canvas, 0, 0);
          await device.queue.onSubmittedWorkDone();
        });
        engine.render({ delta: 0 });
        pen.clearRect(0, 0, size, size);
        pen.drawImage(canvas, 0, 0);
        return pen.getImageData(0, 0, size, size).data;
      };
      const plain = await shot('sky'),
        plainSun = await shot('sun');
      const contact = TerrainGroundContact.attach(engine, terrain, { texel: 0.1, resolution: 512, soil: 0 });
      const bare = await shot('sky');
      contact.set('stone', [0, 0, 2, 1]);
      let pipelines = 0;
      const create = device.createRenderPipeline.bind(device);
      device.createRenderPipeline = (d) => (pipelines++, create(d));
      const shaded = await shot('sky'),
        shadedSun = await shot('sun');
      contact.setLook({ soil: 1, color: [0.5, 0.02, 0.02], occlusion: 0 });
      const red = await shot('sky');
      contact.remove('stone');
      const gone = await shot('sky');
      device.createRenderPipeline = create;
      // The terrain's width on the middle row gives pixels per metre.
      const row = size >> 1,
        background = [plain[0], plain[1], plain[2]],
        on = [];
      for (let x = 0; x < size; x++)
        if ([0, 1, 2].some((c) => Math.abs(plain[(row * size + x) * 4 + c] - background[c]) > 3)) on.push(x);
      const scale = (on.at(-1) + 1 - on[0]) / 32,
        centre = (on.at(-1) + 1 + on[0]) / 2;
      const linear = (data, x) => {
        const v = data[(row * size + x) * 4 + 1] / 255;
        return (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) + 0.04;
      };
      const at = [1, 2, 3].map((radii) => {
        const x = Math.floor(centre + radii * 2 * scale),
          d = (x + 0.5 - centre) / scale / 2; // float division: view only
        return { radii: d, lost: 1 - linear(shaded, x) / linear(plain, x) };
      });
      const differs = (a, b, from, to) => {
        let count = 0;
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const d = Math.hypot(x + 0.5 - centre, y + 0.5 - centre) / scale;
            if (d >= from && d < to && [0, 1, 2].some((c) => a[(y * size + x) * 4 + c] !== b[(y * size + x) * 4 + c]))
              count++;
          }
        return count;
      };
      const k = (row * size + Math.floor(centre + 2.2 * scale)) * 4;
      return {
        errors,
        scale,
        at,
        pipelines,
        bare: differs(bare, plain, 0, 100),
        past: differs(shaded, plain, 8.6, 100),
        inside: differs(shaded, plain, 0, 4),
        sun: differs(shadedSun, plainSun, 0, 100),
        red: [red[k], red[k + 1], red[k + 2]],
        redPast: differs(red, plain, 7.5, 100),
        gone: differs(gone, plain, 0, 100),
      };
    });
    console.log(hardware.compat ? 'WebGL2 layer' : 'WebGPU', JSON.stringify(result));
    assert.deepEqual(result.errors, []);
    assert.equal(result.bare, 0, 'no footprints draw the plain terrain');
    for (const [i, want] of [
      [0, (d) => (1 + d * d) ** -1.5],
      [1, (d) => (1 + d * d) ** -1.5],
      [2, (d) => (1 + d * d) ** -1.5],
    ]) {
      const { radii, lost } = result.at[i];
      assert.ok(Math.abs(lost - want(radii)) < 0.02, `${radii.toFixed(2)} radii lose ${lost.toFixed(3)}`);
    }
    assert.ok(result.inside > 500, 'the foot is shaded');
    assert.equal(result.past, 0, 'past 4 radii nothing changes');
    assert.equal(result.sun, 0, "the sun's beam is untouched");
    assert.ok(result.red[0] > 1.6 * result.red[1], `soil colour at the foot: ${result.red}`);
    assert.equal(result.redPast, 0, 'no soil past the foot');
    assert.equal(result.gone, 0, 'a removed footprint leaves the plain terrain');
    assert.equal(result.pipelines, 0, 'footprints and looks are live');
    console.log('ok terrain ground contact');
  },
  () => context.close(),
);
watchExit();
