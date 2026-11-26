// Real-GPU check of MeshBlend on capture-hook surfaces, built packages, on WebGPU and (--compat) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/post/test/mesh-blend-models-browser.mjs [--compat]
// A gltf/pbr box (Box.glb) sits sunk into a flat terrain, seen from below its top so its upper edge stands against a
// magenta sky. Tagging the model softens its seam with the terrain (pixels change, and only near the box), the sky
// keeps every pixel, and untagging restores the frame. Tagging the terrain instead softens the same seam from the
// terrain's side.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';

await postBrowser(
  'post-mesh-blend-models' + (compatRun() ? '-compat' : ''),
  compatRun() ? 5449 : 5448,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { MeshBlend } = await import('/packages/post/dist/mesh-blend.js'),
        { Terrain } = await import('/packages/terrain/dist/index.js'),
        { loadGLTF } = await import('/packages/gltf/dist/pbr.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
          backend: 'webgpu',
          camera: { position: [0, 0.35, 2.4], target: [0, 0.3, 0] },
        }),
        errors = [];
      engine.stop();
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      engine.scene.background = '#ff00ff';
      engine.lighting.direction.set([0.3, 1, 0.6, 3]);
      const terrain = Terrain.attach(engine, {
        resolution: 32,
        levels: 3,
        cellSize: 0.5,
        origin: [-8, -8],
        size: [16, 16],
        heightScale: 1,
        layers: [0, 1, 2, 3].map(() => ({ height: [-10, 10], slope: [0, 1], scale: 0.5 })),
        textures: (gpu) => {
          const heightmap = gpu.createTexture({ size: [4, 4], format: 'r32float', usage: 6 });
          gpu.queue.writeTexture({ texture: heightmap }, new Float32Array(16), { bytesPerRow: 16 }, [4, 4]);
          const layers = gpu.createTexture({ size: [1, 1, 4], format: 'rgba8unorm-srgb', usage: 6 });
          gpu.queue.writeTexture(
            { texture: layers },
            new Uint8Array(16).fill(60),
            { bytesPerRow: 4, rowsPerImage: 1 },
            [1, 1, 4],
          );
          return { heightmap, layers };
        },
      });
      const rock = await loadGLTF(engine, '/packages/exporters/tests/fixtures/Box.glb');
      rock.root.setPosition([0, 0.4, 0]);
      const blend = MeshBlend.attach(engine);
      window.t = {
        blend,
        rock,
        terrain,
        frame: async () => {
          engine.render({ delta: 1 / 60 });
          await engine.gpu.queue.onSubmittedWorkDone();
          if (errors.length) throw new Error(errors.join('\n'));
        },
        dispose: () => {
          blend.dispose();
          rock.dispose();
          engine.dispose();
        },
      };
    });
    await page.evaluate(() => window.t.frame());
    const base = await shot();
    const compare = (image) => {
      const { width, height } = base,
        sky = (i) => base.data[i] > 200 && base.data[i + 1] < 60 && base.data[i + 2] > 200;
      let changed = 0,
        skyChanged = 0,
        far = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = 4 * (y * width + x);
          if (Math.max(...[0, 1, 2].map((c) => Math.abs(base.data[i + c] - image.data[i + c]))) <= 3) continue;
          changed++;
          if (sky(i)) skyChanged++;
          if (Math.abs(x - width / 2) > width * 0.3) far++;
        }
      return { changed, skyChanged, far };
    };
    await page.evaluate(() => {
      window.t.blend.tag(window.t.rock, 0.15);
      return window.t.frame();
    });
    const model = compare(await shot());
    await page.evaluate(() => {
      window.t.blend.untag(window.t.rock);
      return window.t.frame();
    });
    const restored = compare(await shot());
    await page.evaluate(() => {
      window.t.blend.tag(window.t.terrain, 0.15);
      return window.t.frame();
    });
    const ground = compare(await shot());
    console.log(JSON.stringify({ compat: compatRun(), model, restored, ground }));
    assert.ok(model.changed >= 40, `the tagged model's seam with the terrain softens: ${model.changed} pixels`);
    assert.equal(model.skyChanged, 0, 'the sky keeps every pixel');
    assert.equal(model.far, 0, 'nothing away from the model changes');
    assert.equal(restored.changed, 0, 'untagging restores the frame');
    assert.ok(ground.changed >= 40, `the tagged terrain's seam with the model softens: ${ground.changed} pixels`);
    assert.equal(ground.skyChanged, 0, 'the sky keeps every pixel with the terrain tagged');
    await page.evaluate(() => window.t.dispose());
  },
  { seconds: 150 },
);
console.log('post mesh-blend models: ok' + (compatRun() ? ' (WebGL2 layer)' : ''));
