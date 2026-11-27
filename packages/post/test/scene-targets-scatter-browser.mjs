// Real-GPU check that the look masks see plants (KB-LOOK-MASKOCCLUDE1), built packages, on WebGPU and (MARGO_COMPAT=1)
// the WebGL2 layer. A core floor under a high sun, a core box floating over its left half so the floor carries a
// shadow, and two lit Scatter "plants" (1 m boxes, one instance each, in wind): one standing in the shadow, one on lit
// floor. Not added to SceneTargets, the masks draw the floor through the plants (shaded ground where a plant stands:
// the bug). Added with `{ground: false}`, the plants hide the floor and are not ground: lit and shaded ground read 0
// on them, `plants` (1 - t.ground) marks them where the frame shows them, and their world position is the plant's.
// Added as ground (the default), the plant tops count as ground again. SSR captures the plants with no GPU error.
// Run twice: with `Scatter` plants and with `ScatterInstances` plants (fixed batches, one instance each), whose capture
// hook (`ScatterInstances.setCapture`) landed for KB-LOOK-MASKOCCLUDE1.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-scene-targets-scatter',
  5383,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    for (const kind of ['scatter', 'instances']) {
      await page.evaluate(async (kind) => {
        const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
          { SceneTargets } = await import('/packages/post/dist/mrt.js'),
          { SSR } = await import('/packages/post/dist/ssr.js'),
          { Shadows } = await import('/packages/shadows/dist/index.js'),
          { Scatter, ScatterInstances } = await import('/packages/scatter/dist/index.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 8, 9], target: [0, 0, 0] },
          }),
          device = engine.gpu,
          errors = [];
        engine.stop();
        device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        engine.lighting.direction.set([0.25, 1, 0.35]);
        const grey = new PbrMaterial({ color: '#b0b0a8', roughness: 1 }),
          floor = engine
            .createMesh()
            .setGeometry(box(16, 0.2, 12))
            .setPosition([0, -0.1, 0])
            .setMaterial(grey),
          caster = engine
            .createMesh()
            .setGeometry(box(3, 0.3, 3))
            .setPosition([-3.5, 3, 0])
            .setMaterial(grey);
        const shadows = Shadows.attach(engine, { resolution: 2048, bounds: { min: [-8, -1, -6], max: [8, 4, 6] } });
        shadows.add(floor, { static: true });
        shadows.add(caster);
        // The caster's shadow centre on the floor: 3 m down along the sun, (0.25, 0.35) per metre of height.
        // A fixed batch from core's box: position, normal, tangent, UVs and a white vertex colour (20 floats a vertex).
        const batch = (center) => {
          const g = box(1, 2, 1),
            count = g.vertices.length / 6,
            vertices = new Float32Array(count * 20);
          for (let v = 0; v < count; v++) {
            vertices.set(g.vertices.subarray(v * 6, v * 6 + 3), v * 20);
            vertices.set(g.vertices.subarray(v * 6 + 3, v * 6 + 6), v * 20 + 4);
            vertices.set([1, 1, 1, 1], v * 20 + 16);
          }
          return {
            name: 'plant',
            vertices,
            indices: g.indices,
            transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, center[0], center[1], center[2], 1]),
            material: new PbrMaterial({ color: '#3a7a2a', roughness: 0.8 }),
            wind: [1, 0.3, 0.2],
          };
        };
        const plant = (center) =>
          kind === 'instances'
            ? new ScatterInstances(() => [batch(center)])
            : new Scatter(box(1, 2, 1), {
                count: 1,
                area: [0.01, 0.01],
                center,
                wind: [1, 0, 0.3, 3],
                material: new PbrMaterial({ color: '#3a7a2a', roughness: 0.8 }),
              });
        const shaded = plant([-3.5 - 0.75, 0, -1.05]),
          lit = plant([3, 0, 0]);
        const targets = SceneTargets.attach(engine, {
          outputs: {
            lit: 'litGround',
            shade: 'shadedGround',
            plants: { wgsl: 'vec4f(1.0-t.ground,0,0,1)', format: 'r8unorm' },
            height: { wgsl: 'vec4f(t.position.y,0,0,1)', format: 'r16float' },
          },
        });
        const read = async (name) => {
          const texture = targets.texture(name),
            { width, height, format } = texture,
            size = format === 'r16float' ? 2 : 1,
            row = Math.ceil((width * size) / 256) * 256,
            buffer = device.createBuffer({ size: row * height, usage: 1 | 8 }),
            encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(1);
          const bytes = new Uint8Array(buffer.getMappedRange().slice(0)),
            out = new Float32Array(width * height),
            half = (h) => {
              const e = (h >> 10) & 31,
                m = h & 1023;
              return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15) * (h >> 15 ? -1 : 1);
            };
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++)
              out[y * width + x] =
                size === 2
                  ? half(bytes[y * row + x * 2] | (bytes[y * row + x * 2 + 1] << 8))
                  : bytes[y * row + x] / 255;
          buffer.unmap();
          buffer.destroy();
          return Array.from(out);
        };
        let removers = [];
        window.t = {
          frames: async (n) => {
            for (let i = 0; i < n; i++) engine.render({ delta: 0 });
            await device.queue.onSubmittedWorkDone();
            if (errors.length) throw new Error(errors.join('\n'));
          },
          read: async () => ({
            width: targets.texture('lit').width,
            height: targets.texture('lit').height,
            lit: await read('lit'),
            shade: await read('shade'),
            plants: await read('plants'),
            heights: await read('height'),
          }),
          add: (options) => {
            for (const remove of removers) remove();
            removers = options ? [targets.add(shaded, options), targets.add(lit, options)] : [];
          },
          plant: () => {
            engine.use(shaded);
            engine.use(lit);
          },
          ssr: async () => {
            const ssr = SSR.attach(engine);
            ssr.add(shaded);
            ssr.add(lit);
            for (let i = 0; i < 3; i++) engine.render({ delta: 0 });
            await device.queue.onSubmittedWorkDone();
            ssr.dispose();
            if (errors.length) throw new Error(errors.join('\n'));
          },
          dispose: () => {
            targets.dispose();
            shadows.dispose();
            shaded.dispose();
            lit.dispose();
            engine.dispose();
          },
        };
      }, kind);
      const run = async (options) => {
        await page.evaluate((o) => window.t.add(o), options);
        await page.evaluate(() => window.t.frames(4));
        return page.evaluate(() => window.t.read());
      };
      // The frame without the plants, to find the pixels they change.
      await page.evaluate(() => window.t.frames(4));
      const bare = await shot();
      await page.evaluate(() => window.t.plant());
      const before = await run(undefined),
        plants = await run({ ground: false });
      const frame = await shot();
      const asGround = await run({}),
        { width, height } = plants,
        n = width * height;
      await page.evaluate(() => window.t.ssr());
      await page.evaluate(() => window.t.dispose());
      const on = (m, i) => m[i] > 0.5,
        plantPixels = [];
      for (let i = 0; i < n; i++) if (on(plants.plants, i)) plantPixels.push(i);
      const changed = (i) =>
        Math.abs(frame.data[i * 4] - bare.data[i * 4]) +
          Math.abs(frame.data[i * 4 + 1] - bare.data[i * 4 + 1]) +
          Math.abs(frame.data[i * 4 + 2] - bare.data[i * 4 + 2]) >
        12;
      let differ = 0,
        shownOnly = 0;
      for (let i = 0; i < n; i++) {
        const c = changed(i);
        if (c !== on(plants.plants, i)) differ++;
        if (c && !on(plants.plants, i)) shownOnly++;
      }
      const count = (m, pixels) => pixels.filter((i) => on(m, i)).length,
        meanHeight = plantPixels.reduce((s, i) => s + plants.heights[i], 0) / plantPixels.length,
        result = {
          plants: plantPixels.length,
          before: { lit: count(before.lit, plantPixels), shade: count(before.shade, plantPixels) },
          after: {
            lit: count(plants.lit, plantPixels),
            shade: count(plants.shade, plantPixels),
            litTotal: plants.lit.filter((v) => v > 0.5).length,
            shadeTotal: plants.shade.filter((v) => v > 0.5).length,
          },
          asGround: { lit: count(asGround.lit, plantPixels), shade: count(asGround.shade, plantPixels) },
          meanHeight,
          differ,
          shownOnly,
          compat: compatRun(),
          kind,
        };
      console.log(JSON.stringify(result));
      assert.ok(result.plants > 300, `the plants mask covers both plants (${result.plants} px)`);
      assert.ok(
        result.before.shade > 50 && result.before.lit > 50,
        `not added, the masks see the floor through the plants (${result.before.shade} shaded, ${result.before.lit} lit px)`,
      );
      assert.deepEqual([result.after.lit, result.after.shade], [0, 0], 'added with ground: false, no ground on plants');
      assert.ok(result.after.litTotal > 2000 && result.after.shadeTotal > 150, 'the floor keeps its masks around them');
      assert.ok(meanHeight > 0.4, `the targets hold the plants' own surface (mean height ${meanHeight} m)`);
      assert.ok(
        result.asGround.lit + result.asGround.shade > 50,
        `added as ground, the up-facing plant tops are ground (${result.asGround.lit} lit, ${result.asGround.shade} shaded)`,
      );
      // The frame is 4x multisampled and the targets single-sampled: edge pixels may differ, nothing more.
      assert.ok(
        differ < 0.15 * result.plants,
        `the plants mask is where the frame shows the plants (${differ} of ${result.plants} px differ)`,
      );
    }
  },
);
