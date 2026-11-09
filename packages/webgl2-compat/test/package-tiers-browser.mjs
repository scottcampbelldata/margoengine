// Real preview refusals, /auto escalation, glTF + selection pixels and procedural compute on both complete tiers.
// node scripts/gpu-lock.mjs run --owner=<you> --max=15 -- node packages/webgl2-compat/test/package-tiers-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const browser = await openBrowser({
  port: 'free',
  startPath: '/packages/webgl2-compat/test/preview-browser-check.html',
});
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  // Native WebGPU renders the same fixture; --compat runs this part through the full layer as well.
  const scene = async (page) =>
    page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
      const { Selection } = await import('/packages/selection/dist/index.js');
      const { createTextureBaker } = await import('/packages/procedural/dist/textures.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const engine = await Engine.create(document.getElementById('gl'), {
        backend: 'webgpu',
        exactSize: [96, 64],
        camera: { position: [0, 0, 4], target: [0, 0, 0] },
      });
      try {
        const model = await loadGLTF(engine, '/packages/webgl2-compat/test/fixtures/preview-triangle.gltf');
        const selection = Selection.attach(engine, { algorithm: 'morphological', color: [1, 0, 1], width: 3 });
        selection.set([model]);
        await waitForPipelines(async () => {
          engine.render();
          await engine.gpu.queue.onSubmittedWorkDone();
        });
        const context = new OffscreenCanvas(96, 64).getContext('2d', { willReadFrequently: true });
        // Copy in the same task as the final draw, before the browser presents/clears the canvas drawing buffer.
        engine.render();
        context.drawImage(engine.canvas, 0, 0);
        const pixels = context.getImageData(0, 0, 96, 64).data;
        let red = 0,
          magenta = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 100 && pixels[i + 1] < 80 && pixels[i + 2] < 80) red++;
          if (pixels[i] > 150 && pixels[i + 1] < 90 && pixels[i + 2] > 150) magenta++;
        }
        const baker = await createTextureBaker(engine);
        const output = await baker.bake({ width: 16, height: 16, pattern: 'bricks' });
        const buffer = engine.gpu.createBuffer({
          size: 4096,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = engine.gpu.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: output.texture }, { buffer, bytesPerRow: 256 }, [16, 16]);
        engine.gpu.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const baked = [...new Uint8Array(buffer.getMappedRange()).slice(0, 64)];
        buffer.unmap();
        buffer.destroy();
        output.dispose();
        baker.dispose();
        return {
          backend: engine.backend,
          red,
          magenta,
          centre: [...pixels.slice((32 * 96 + 48) * 4, (32 * 96 + 48) * 4 + 4)],
          baked,
        };
      } finally {
        engine.dispose();
      }
    });
  const native = await scene(browser.page);
  assert.ok(native.red > 50, `glTF triangle draws: ${JSON.stringify(native)}`);
  assert.ok(native.magenta > 20, `selection draws: ${JSON.stringify(native)}`);
  assert.ok(
    native.baked.some((value, i) => i % 4 !== 3 && value > 0),
    'native procedural bake writes colors',
  );

  const context = await browser.page.context().browser().newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined }));
  await page.goto(browser.page.url());
  const tiers = await page.evaluate(async () => {
    const { Engine, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { webglRenderer } = await import('/packages/webgl2-compat/dist/preview.js');
    const { autoEngine } = await import('/packages/webgl2-compat/dist/auto.js');
    const { Selection } = await import('/packages/selection/dist/index.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { VATCrowd } = await import('/packages/animation/dist/vat.js');
    const { MorphWeightPlayer } = await import('/packages/animation/dist/morph-gpu.js');
    const { Lines } = await import('/packages/lines/dist/index.js');
    const { LineBatches } = await import('/packages/lines/dist/batch.js');
    const { PointsPlugin } = await import('/packages/points/dist/index.js');
    const { SurfelPlugin } = await import('/packages/points/dist/surfels.js');
    const { TextRenderer } = await import('/packages/text/dist/index.js');
    const { WorldPanels } = await import('/packages/ui/dist/world.js');
    const { LODSystem } = await import('/packages/lod/dist/index.js');
    const { LODFade } = await import('/packages/lod/dist/fade.js');
    const { TerrainColors } = await import('/packages/terrain/dist/index.js');
    const { createTextureBaker } = await import('/packages/procedural/dist/textures.js');
    const { PostStack, Bloom } = await import('/packages/post/dist/index.js');
    const { Shadows } = await import('/packages/shadows/dist/index.js');
    const { Video } = await import('/packages/video/dist/index.js');
    const { VFX } = await import('/packages/vfx/dist/index.js');
    const { Splats } = await import('/packages/splats/dist/index.js');
    const { LayerCompositor } = await import('/packages/pixel/dist/index.js');
    const { Lighting2D } = await import('/packages/lighting2d/dist/index.js');
    const { CulledInstances } = await import('/packages/culling/dist/index.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const make = () => {
      const c = document.createElement('canvas');
      c.style.cssText = 'width:96px;height:64px';
      document.body.append(c);
      return c;
    };
    const options = { backend: 'webgl2', exactSize: [96, 64], camera: { position: [0, 0, 4], target: [0, 0, 0] } };
    const vat = {
      vertexCount: 3,
      rows: 2,
      width: 6,
      texels: new Float32Array(48),
      uvs: new Float32Array(6),
      indices: new Uint32Array([0, 1, 2]),
      clips: [{ name: 'still', start: 0, frames: 1, duration: 1, loop: true }],
    };
    for (let row = 0; row < 2; row++)
      for (let v = 0; v < 3; v++) {
        vat.texels.set(
          [
            [-1, -1, 0, 1],
            [1, -1, 0, 1],
            [0, 1, 0, 1],
          ][v],
          (row * 6 + v * 2) * 4,
        );
        vat.texels.set([0, 0, 1, 0], (row * 6 + v * 2 + 1) * 4);
      }
    const attaches = [
      ['selection', (e) => Selection.attach(e, { algorithm: 'morphological' })],
      ['gltf-pro', (e) => loadGLTF(e, '/packages/webgl2-compat/test/fixtures/preview-triangle.gltf')],
      [
        'VATCrowd',
        (e) => {
          const c = VATCrowd.attach(e, vat);
          c.add();
          return c;
        },
      ],
      ['MorphWeightPlayer', (e) => MorphWeightPlayer.attach(e)],
      ['Lines', (e) => Lines.attach(e)],
      ['LineBatches', (e) => LineBatches.attach(e)],
      ['PointsPlugin', (e) => PointsPlugin.attach(e)],
      ['SurfelPlugin', (e) => SurfelPlugin.attach(e)],
      ['TextRenderer', (e) => TextRenderer.attach(e)],
      ['WorldPanels', (e) => WorldPanels.attach(e, { input: false })],
      ['LODFade', (e) => LODFade.attach(e, LODSystem.attach(e))],
      [
        'TerrainColors',
        (e) =>
          TerrainColors.attach(e, e.createMesh().setGeometry(box()), {
            sand: [0, 0, 0],
            meadow: [
              [0, 0, 0],
              [0, 0, 0],
            ],
            stone: [0, 0, 0],
            shore: [0, 1],
            meadowHeight: [1, 2],
            stoneHeight: [2, 3],
            stoneNormal: [0.5, 1],
            wetHeight: [0, 1],
            wetDarkening: 0.5,
          }),
      ],
      ['PostStack', (e) => PostStack.attach(e, [new Bloom({ strength: 0.5 })])],
      ['Shadows', (e) => Shadows.attach(e, { cascades: 3, resolution: 128 })],
      ['Video', (e) => Video.attach(e, document.createElement('video'))],
      ['VFX', (e) => VFX.attach(e, { capacity: 16, rate: 1 })],
      [
        'Splats',
        (e) =>
          Splats.attach(e, {
            positions: new Float32Array([0, 0, 0]),
            covariances: new Float32Array([0.1, 0, 0, 0.1, 0, 0.1]),
            colors: new Float32Array([1, 0, 0, 1]),
          }),
      ],
      ['LayerCompositor', (e) => LayerCompositor.attach(e, { camera: { width: 16, height: 16 } })],
      [
        'Lighting2D',
        (e) => {
          const layer = e.gpu ? LayerCompositor.attach(e, { camera: { width: 16, height: 16 } }).addLayer() : null;
          return Lighting2D.attach(e, {
            target: () => layer.texture,
            ambient: '#ffffff',
          });
        },
      ],
      [
        'CulledInstances',
        (e) =>
          CulledInstances.attach(
            e,
            [
              {
                geometry: box(),
                material: new PbrMaterial(),
                transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
              },
            ],
            { culling: 'frustum' },
          ),
      ],
    ];
    let noFallback;
    try {
      await Engine.create(make(), options);
    } catch (error) {
      noFallback = { name: error.name, code: error.code, message: error.message };
    }
    if (noFallback?.code !== 'unsupported' || !noFallback.message.includes('fallback'))
      throw new Error('backend webgl2 without a preview renderer must explain its coded refusal');
    // The native fragment baker was added on main while this change was being checked.
    // It is a real preview route and must not trigger automatic escalation.
    const bakedPreview = await autoEngine(
      make(),
      async (e) => {
        const baker = await createTextureBaker(e);
        try {
          const output = await baker.bake({ width: 16, height: 16 });
          if (output.backend !== 'webgl2') throw new Error('Expected native preview texture');
          output.dispose();
        } finally {
          baker.dispose();
        }
      },
      {
        ...options,
        loadCompat: async () => {
          throw new Error('Real preview baker must not escalate');
        },
      },
    );
    if (bakedPreview.backend !== 'webgl2') throw new Error('Baker left its real preview route');
    bakedPreview.dispose();
    const results = [];
    for (const [name, attach] of attaches) {
      const direct = await Engine.create(make(), { ...options, fallback: webglRenderer });
      let refusal;
      try {
        await attach(direct);
        refusal = { code: 'accepted' };
      } catch (error) {
        refusal = { name: error.name, code: error.code, message: error.message };
      } finally {
        direct.dispose();
      }
      if (refusal.code !== 'unsupported' || !refusal.message.includes('https://margoengine.com/errors#'))
        throw new Error(name + ' did not provide its linked preview refusal: ' + JSON.stringify(refusal));
      const seen = [];
      let loads = 0;
      const live = await autoEngine(
        make(),
        async (e) => {
          seen.push(e.backend);
          const value = await attach(e);
          if (name === 'procedural') value.dispose();
        },
        {
          ...options,
          loadCompat: async () => {
            loads++;
            return import('/packages/webgl2-compat/dist/index.js');
          },
        },
      );
      await waitForPipelines(async () => {
        live.render();
        await live.gpu.queue.onSubmittedWorkDone();
      });
      results.push({ name, refusal, seen, loads, backend: live.backend, vendor: live.gpu.adapterInfo.vendor });
      live.dispose();
    }
    return results;
  });
  for (const result of tiers) {
    assert.equal(result.refusal.name, 'MargoError', result.name);
    assert.equal(result.refusal.code, 'unsupported', result.name);
    assert.match(result.refusal.message, /https:\/\/margoengine.com\/errors#/, result.name);
    assert.deepEqual(result.seen, ['webgl2', 'webgpu'], result.name);
    assert.equal(result.loads, 1, result.name);
    assert.equal(result.backend, 'webgpu', result.name);
    assert.equal(result.vendor, 'margo-webgl2', result.name);
  }
  // loadGLTF, Selection and procedural compute share the actual compatibility device and draw real pixels.
  const compat = await scene(page);
  assert.ok(compat.red > 50, `compat glTF draws: ${JSON.stringify(compat)}`);
  assert.ok(compat.magenta > 20, `compat selection draws: ${JSON.stringify(compat)}`);
  assert.deepEqual(
    compat.baked,
    native.baked,
    'the procedural texture baker runs on the full layer with the same pixels',
  );
  assert.deepEqual(errors, []);
  await context.close();
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/preview-package-tiers.json', JSON.stringify({ native, tiers, compat }, null, 2) + '\n');
  console.log('Package preview refusals, automatic escalation, glTF + selection pixels and procedural baking passed');
} finally {
  await browser.close();
}
