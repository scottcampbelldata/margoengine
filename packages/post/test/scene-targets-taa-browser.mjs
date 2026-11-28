// Real-GPU check that SceneTargets draws with the unjittered camera under TAA (KB-POST-MRTJITTER1), built packages, on
// WebGPU and (MARGO_COMPAT=1) the WebGL2 layer. TAA draws each frame from a camera moved by a sub-pixel Halton offset
// and averages the phases back onto the unjittered camera, so masks and AOVs read after the frame must come from that
// camera: before the fix the targets were drawn with TAA's jittered camera, a fifth of a pixel off the resolved frame
// (the timber-valley shot's look masks). One scene per capture path, each alone in the targets: core meshes (core's lit
// shader with TAA's clip patch), a terrain (its prepared ring uniforms carry the jittered matrix), a lit Scatter and
// ScatterInstances (their capture stages took TAA's clip patch), a gltf/pbr model and a Water (its capture bound the
// uniform of its colour draw, TAA's jittered camera). Each is read without TAA, then
// after frames with TAA at several jitter phases: coverage, height and camera distance must not move (offset 0).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-scene-targets-taa',
  5391,
  () => launchBrowser({ headless: true }),
  async (page) => {
    const results = [];
    for (const kind of ['core', 'terrain', 'scatter', 'instances', 'gltf', 'water']) {
      await page.evaluate(async (kind) => {
        const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
          { SceneTargets } = await import('/packages/post/dist/mrt.js'),
          { TAA } = await import('/packages/taa/dist/index.js'),
          { Terrain } = await import('/packages/terrain/dist/index.js'),
          { Scatter, ScatterInstances } = await import('/packages/scatter/dist/index.js'),
          { loadGLTF } = await import('/packages/gltf/dist/pbr.js'),
          { Water } = await import('/packages/water/dist/index.js');
        const canvas = document.querySelector('canvas'),
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0.3, 5, 7], target: [0, 0.5, 0] },
          }),
          device = engine.gpu,
          errors = [];
        engine.stop();
        device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
        engine.lighting.direction.set([0.25, 1, 0.35]);
        const green = new PbrMaterial({ color: '#3a7a2a', roughness: 0.8 }),
          owned = [];
        let model;
        if (kind === 'core')
          owned.push(
            engine
              .createMesh()
              .setGeometry(box(2.3, 1.7, 1.9))
              .setPosition([0.1, 0.4, 0])
              .setRotation([0, 0.26, 0])
              .setMaterial(green),
          );
        else if (kind === 'terrain') {
          // A ridge across a 9 m square: its edges against the empty background move with any camera offset.
          const n = 16,
            heights = new Float32Array(n * n);
          for (let y = 0; y < n; y++)
            for (let x = 0; x < n; x++) heights[y * n + x] = Math.max(0, 1 - Math.abs(x - 7.3) / 3) * 0.8;
          model = Terrain.attach(engine, {
            resolution: 32,
            levels: 3,
            cellSize: 0.25,
            origin: [-4.5, -4.5],
            size: [9, 9],
            heightScale: 2,
            layers: [0, 1, 2, 3].map(() => ({ height: [-10, 10], slope: [0, 1], scale: 0.5 })),
            textures: (gpu) => {
              const heightmap = gpu.createTexture({ size: [n, n], format: 'r32float', usage: 6 });
              gpu.queue.writeTexture({ texture: heightmap }, heights, { bytesPerRow: n * 4 }, [n, n]);
              const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
              gpu.queue.writeTexture(
                { texture: layers },
                new Uint8Array(16).fill(170),
                { bytesPerRow: 4, rowsPerImage: 1 },
                [1, 1, 4],
              );
              return { heightmap, layers };
            },
          });
        } else if (kind === 'scatter') {
          model = new Scatter(box(1.3, 2, 1.1), { count: 1, area: [0.01, 0.01], center: [0, 0, 0], material: green });
          engine.use(model);
        } else if (kind === 'instances') {
          const g = box(1.3, 2, 1.1),
            count = g.vertices.length / 6,
            vertices = new Float32Array(count * 20);
          for (let v = 0; v < count; v++) {
            vertices.set(g.vertices.subarray(v * 6, v * 6 + 3), v * 20);
            vertices.set(g.vertices.subarray(v * 6 + 3, v * 6 + 6), v * 20 + 4);
            vertices.set([1, 1, 1, 1], v * 20 + 16);
          }
          model = new ScatterInstances(() => [
            {
              name: 'plant',
              vertices,
              indices: g.indices,
              transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.2, 0, 1]),
              material: green,
            },
          ]);
          engine.use(model);
        } else if (kind === 'water') {
          // A flat 4 m square of water (one train of zero height, so time moves nothing): its edges against the empty
          // background move with any camera offset.
          model = Water.attach(engine, {
            size: [4, 4],
            segments: 16,
            height: 0.5,
            waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }],
          });
        } else if (kind === 'gltf') {
          model = await loadGLTF(engine, '/packages/exporters/tests/fixtures/Box.glb');
          model.root.setPosition([0.1, 0.5, 0]);
          model.root.setScale([1.7, 1.3, 1.9]);
        }
        const targets = SceneTargets.attach(engine, {
          outputs: {
            cover: { wgsl: 'vec4f(1,0,0,1)', format: 'r8unorm' },
            height: { wgsl: 'vec4f(t.position.y,0,0,1)', format: 'r16float' },
            distance: 'distance',
          },
        });
        if (model) targets.add(model, kind === 'gltf' ? { subject: true } : { ground: false });
        const read = async (name) => {
          const texture = targets.texture(name),
            { width, height, format } = texture,
            size = format === 'r8unorm' ? 1 : format === 'r16float' ? 2 : 4,
            row = Math.ceil((width * size) / 256) * 256,
            buffer = device.createBuffer({ size: row * height, usage: 1 | 8 }),
            encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(1);
          const bytes = new Uint8Array(buffer.getMappedRange().slice(0)),
            view = new DataView(bytes.buffer),
            out = new Float32Array(width * height),
            half = (h) => {
              const e = (h >> 10) & 31,
                m = h & 1023;
              return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15) * (h >> 15 ? -1 : 1);
            };
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) {
              const at = y * row + x * size;
              out[y * width + x] =
                size === 1 ? bytes[at] / 255 : size === 2 ? half(view.getUint16(at, true)) : view.getFloat32(at, true);
            }
          buffer.unmap();
          buffer.destroy();
          return Array.from(out);
        };
        let taa;
        window.t = {
          frames: async (n) => {
            for (let i = 0; i < n; i++) engine.render({ delta: 1 / 60 });
            await device.queue.onSubmittedWorkDone();
            if (errors.length) throw new Error(errors.join('\n'));
          },
          read: async () => ({
            width: targets.texture('cover').width,
            cover: await read('cover'),
            height: await read('height'),
            distance: await read('distance'),
          }),
          taa: () => {
            taa = TAA.attach(engine);
          },
          dispose: () => {
            taa?.dispose();
            targets.dispose();
            model?.dispose?.();
            for (const mesh of owned) mesh.dispose?.();
            engine.dispose();
          },
        };
      }, kind);
      await page.evaluate(() => window.t.frames(3));
      const still = await page.evaluate(() => window.t.read());
      await page.evaluate(() => window.t.taa());
      // Several frames, so several jitter phases: the last read is the phase the frame drew with.
      const phases = [];
      // fixed-wait: the subject: each frame is another jitter phase, read one by one
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.t.frames(1));
        phases.push(await page.evaluate(() => window.t.read()));
      }
      await page.evaluate(() => window.t.dispose());
      const covered = still.cover.filter((v) => v > 0.5).length,
        moved = phases.map((p) => {
          let cover = 0,
            height = 0,
            distance = 0;
          for (let i = 0; i < p.cover.length; i++) {
            if (p.cover[i] !== still.cover[i]) cover++;
            height = Math.max(height, Math.abs(p.height[i] - still.height[i]));
            distance = Math.max(distance, Math.abs(p.distance[i] - still.distance[i]));
          }
          return { cover, height, distance };
        });
      results.push({ kind, covered, moved });
    }
    console.log(JSON.stringify({ compat: compatRun(), results }));
    for (const { kind, covered, moved } of results) {
      assert.ok(covered > 1000, `${kind}: the targets cover the part (${covered} px)`);
      for (const m of moved) {
        assert.equal(m.cover, 0, `${kind}: TAA's jitter moved ${m.cover} coverage pixels of the targets`);
        assert.ok(m.height < 1e-3, `${kind}: TAA's jitter changed a height by ${m.height} m`);
        assert.ok(m.distance < 1e-3, `${kind}: TAA's jitter changed a distance by ${m.distance} m`);
      }
    }
  },
);
