import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import {
  cachedProductionAssets,
  productionAssets,
  sampleAssetBase,
  sampleAssetCommit,
} from './support/gltf-production-assets.js';

const files = await cachedProductionAssets(),
  browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5198 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
try {
  for (const file of files)
    await page.route(file.url, (route) =>
      route.fulfill({
        body: file.data,
        contentType: file.path.endsWith('.gltf')
          ? 'model/gltf+json'
          : file.path.endsWith('.glb')
            ? 'model/gltf-binary'
            : file.path.endsWith('.ktx2')
              ? 'image/ktx2'
              : 'application/octet-stream',
      }),
    );
  const models = [];
  for (const fixture of productionAssets) {
    const report = await page.evaluate(
      async (fixture) => {
        const { Engine } = await import('/packages/core/dist/index.js'),
          { loadGLTF, textureCoordinates } = await import('/packages/gltf-pro/dist/index.js'),
          materials = await import('/packages/materials/dist/index.js');
        const assert = (ok, message) => {
          if (!ok) throw new Error(message);
        };
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:640px;height:640px';
        document.body.replaceChildren(canvas);
        const engine = await Engine.create(canvas, {
            backend: 'webgpu',
            capacity: 256,
            camera: {
              position: fixture.kind === 'transform' ? [0, 0, 5] : [2, 1.2, 3],
              target: [0, 0, 0],
              near: 0.001,
              far: 1000,
            },
          }),
          device = engine.gpu;
        const NativeWorker = window.Worker,
          workers = [],
          resources = [];
        window.Worker = class extends NativeWorker {
          constructor(url, options) {
            super(url, options);
            if (options?.name === 'margoengine-decoder') {
              this.record = { url: String(url), terminated: false };
              workers.push(this.record);
            }
          }
          terminate() {
            if (this.record) this.record.terminated = true;
            return super.terminate();
          }
        };
        for (const method of ['createBuffer', 'createTexture']) {
          const original = device[method].bind(device);
          device[method] = (descriptor) => {
            const resource = original(descriptor),
              entry = { kind: method, label: descriptor.label ?? '', destroyed: false },
              destroy = resource.destroy.bind(resource);
            resources.push(entry);
            resource.destroy = () => {
              entry.destroyed = true;
              destroy();
            };
            return resource;
          };
        }
        device.pushErrorScope('validation');
        let model, installation;
        try {
          model = await loadGLTF(engine, fixture.url);
          const doc = model.asset.doc;
          assert(
            model.primitives.length > 0 && model.primitives.every((p) => p.vertices.every(Number.isFinite)),
            'Complete production geometry is missing or non-finite',
          );
          const images = (doc.images ?? []).map((_, index) => {
            const image = model.image(index);
            return {
              width: image.width,
              height: image.height,
              ...('ktx2' in image
                ? { format: image.ktx2.format, mips: image.ktx2.mipmaps.length, target: image.ktx2.target }
                : { bitmap: true }),
            };
          });
          const uv1Primitives = model.primitives.filter((p) => p.definition.attributes.TEXCOORD_1 !== undefined).length;
          let transforms = 0;
          const inspect = (value) => {
            if (value && typeof value === 'object')
              for (const [key, child] of Object.entries(value)) {
                if (key === 'KHR_texture_transform') transforms++;
                inspect(child);
              }
          };
          inspect(doc.materials);
          if (fixture.kind === 'transform') {
            assert(
              doc.extensionsRequired.includes('KHR_texture_transform') && uv1Primitives > 0 && transforms > 0,
              'Transform asset no longer exercises its required transform and UV1',
            );
            assert(workers.length === 0, 'Ordinary GLB unexpectedly started a transcoder worker');
          } else {
            assert(
              doc.extensionsRequired.includes('KHR_texture_basisu') &&
                images.length === 4 &&
                images.every((image) => image.mips > 0),
              'KTX2 asset failed to retain all four complete mip chains',
            );
            assert(
              workers.length > 0 && workers.every((worker) => worker.terminated),
              'Automatic Basis workers were not released by loadGLTF',
            );
          }
          installation = materials.install(model);
          const bounds = model.bounds;
          engine.camera.fitToBoundingBox([bounds[0], bounds[1], bounds[2]], [bounds[3], bounds[4], bounds[5]], {
            duration: 0,
          });
          engine.lighting.direction.set([1, 1, 2, 1]);
          engine.lighting.radiance.set([2, 2, 2, 0.25]);
          for (let frame = 0; frame < 2; frame++) {
            engine.render({ culling: false });
            await device.queue.onSubmittedWorkDone();
          }
          const authoredReferences = [];
          if (fixture.kind === 'transform')
            for (const [name, channel, names] of [
              ['BaseColor', 0, ['BaseColorTest0Mat', 'BaseColorTest1Mat', 'BaseColorSampleMat']],
              ['Emission', 4, ['EmissionTest0Mat', 'EmissionTest1Mat', 'EmissionSampleMat']],
            ]) {
              const tiles = names.map((name) => model.primitives.find((p) => p.material.name === name));
              assert(tiles.every(Boolean), 'Missing authored transform reference tiles');
              let maxUVError = 0;
              for (const tile of tiles.slice(0, 2)) {
                const { transform, texCoord } = textureCoordinates(tile.material.maps[channel]);
                assert(transform, 'Authored transform missing');
                for (let vertex = 0; vertex < 4; vertex++) {
                  const u = tile.vertices[vertex * 20 + 12 + texCoord * 2],
                    v = tile.vertices[vertex * 20 + 13 + texCoord * 2],
                    sample = tiles[2].vertices;
                  maxUVError = Math.max(
                    maxUVError,
                    Math.abs(transform[0] * u + transform[1] * v + transform[2] - sample[vertex * 20 + 12]),
                    Math.abs(transform[4] * u + transform[5] * v + transform[6] - sample[vertex * 20 + 13]),
                  );
                }
              }
              // The source's baked control has a 0.006 V offset relative to its
              // transformed tiles. The opposite rotation sign misses it by >0.5.
              assert(
                maxUVError < 0.01,
                'Texture transform differs from independently authored ' + name + ' sample UVs: ' + maxUVError,
              );
              const rectangles = tiles.map((tile) => {
                let left = Infinity,
                  right = -Infinity,
                  top = Infinity,
                  bottom = -Infinity;
                const m = tile.node.matrix,
                  c = engine.camera.matrix;
                for (let vertex = 0; vertex < tile.vertices.length; vertex += 20) {
                  const p = tile.vertices,
                    x = m[0] * p[vertex] + m[4] * p[vertex + 1] + m[8] * p[vertex + 2] + m[12],
                    y = m[1] * p[vertex] + m[5] * p[vertex + 1] + m[9] * p[vertex + 2] + m[13],
                    z = m[2] * p[vertex] + m[6] * p[vertex + 1] + m[10] * p[vertex + 2] + m[14],
                    w = c[3] * x + c[7] * y + c[11] * z + c[15],
                    sx = (((c[0] * x + c[4] * y + c[8] * z + c[12]) / w) * 0.5 + 0.5) * canvas.width,
                    sy = (0.5 - ((c[1] * x + c[5] * y + c[9] * z + c[13]) / w) * 0.5) * canvas.height;
                  left = Math.min(left, sx);
                  right = Math.max(right, sx);
                  top = Math.min(top, sy);
                  bottom = Math.max(bottom, sy);
                }
                return { left, right, top, bottom };
              });
              authoredReferences.push({ name, maxUVError, rectangles });
            }
          const validation = await device.popErrorScope();
          assert(!validation, validation?.message);
          window.productionAssetScene = { engine, model, installation, NativeWorker, workers, resources };
          return {
            name: fixture.name,
            primitives: model.primitives.length,
            vertices: model.primitives.reduce((count, p) => count + p.vertices.length / 20, 0),
            uv1Primitives,
            transforms,
            images,
            extensionsRequired: doc.extensionsRequired ?? [],
            extensionsUsed: doc.extensionsUsed ?? [],
            workers,
            installedMaterials: model.primitives.filter((p) => p.extension || p.material.extension).length,
            authoredReferences,
          };
        } catch (error) {
          installation?.dispose();
          model?.dispose();
          engine.dispose();
          window.Worker = NativeWorker;
          throw error;
        }
      },
      { ...fixture, url: sampleAssetBase + fixture.path },
    );
    const screenshot = 'test-results/gltf-production-assets/' + fixture.name + '.png',
      pixels = await decodePNG(await page.locator('canvas').screenshot({ path: screenshot })),
      background = pixels.data.subarray(0, 3);
    let foreground = 0,
      colored = 0,
      peak = 0;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      const r = pixels.data[offset],
        g = pixels.data[offset + 1],
        b = pixels.data[offset + 2];
      if (Math.max(Math.abs(r - background[0]), Math.abs(g - background[1]), Math.abs(b - background[2])) > 8)
        foreground++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 15) colored++;
      peak = Math.max(peak, r, g, b);
    }
    assert.ok(
      foreground > 1000 && colored > 100 && peak > 40,
      'Production asset did not visibly render: ' + JSON.stringify({ name: fixture.name, foreground, colored, peak }),
    );
    for (const reference of report.authoredReferences) {
      const samples = reference.rectangles.map((rect) =>
        Array.from({ length: 24 * 24 }, (_, index) => {
          const x = Math.min(
              pixels.width - 1,
              Math.max(
                0,
                Math.floor(rect.left + (0.05 + (((index % 24) + 0.5) / 24) * 0.9) * (rect.right - rect.left)),
              ),
            ),
            y = Math.min(
              pixels.height - 1,
              Math.max(
                0,
                Math.floor(rect.top + (0.05 + ((Math.floor(index / 24) + 0.5) / 24) * 0.9) * (rect.bottom - rect.top)),
              ),
            ),
            at = (y * pixels.width + x) * 4;
          return pixels.data[at] + pixels.data[at + 1] + pixels.data[at + 2];
        }),
      );
      const control = samples[2],
        threshold = (Math.min(...control) + Math.max(...control)) / 2;
      reference.pixelMismatches = samples
        .slice(0, 2)
        .map((sample) =>
          sample.reduce((count, value, index) => count + (value < threshold !== control[index] < threshold ? 1 : 0), 0),
        );
      assert.ok(
        reference.pixelMismatches.every((count) => count < 24 * 24 * 0.1),
        'Transformed ' +
          reference.name +
          ' UV0/UV1 images do not match the independently authored checkmark: ' +
          JSON.stringify(reference.pixelMismatches),
      );
    }
    const restored = await page.evaluate(async () => {
      const { engine, workers } = window.productionAssetScene,
        count = workers.length;
      await engine.rebootDevice();
      engine.gpu.pushErrorScope('validation');
      for (let frame = 0; frame < 2; frame++) {
        engine.render({ culling: false });
        await engine.gpu.queue.onSubmittedWorkDone();
      }
      const validation = await engine.gpu.popErrorScope();
      if (validation) throw new Error(validation.message);
      if (workers.length !== count) throw new Error('Device restoration restarted a completed Basis transcoder');
      return { workers: workers.length };
    });
    const restoredPixels = await decodePNG(
      await page.locator('canvas').screenshot({ path: screenshot.replace('.png', '-restored.png') }),
    );
    let restoredDifference = 0;
    for (let index = 0; index < pixels.data.length; index++)
      restoredDifference = Math.max(restoredDifference, Math.abs(pixels.data[index] - restoredPixels.data[index]));
    assert.ok(restoredDifference <= 1, 'Production image changed after device restore: ' + restoredDifference);
    const disposed = await page.evaluate(() => {
      const { engine, model, installation, NativeWorker, workers, resources } = window.productionAssetScene;
      model.dispose();
      const pluginDisposed = installation.disposed,
        meshes = engine.meshes.size;
      engine.dispose();
      window.Worker = NativeWorker;
      return {
        pluginDisposed,
        meshes,
        workers: workers.map((worker) => ({ ...worker })),
        resources: resources.length,
        leaked: resources.filter((resource) => !resource.destroyed),
      };
    });
    assert.equal(disposed.pluginDisposed, true);
    assert.equal(disposed.meshes, 0);
    assert.deepEqual(disposed.leaked, []);
    assert.ok(disposed.workers.every((worker) => worker.terminated));
    models.push({
      ...report,
      pixels: { width: pixels.width, height: pixels.height, foreground, colored, peak },
      screenshot,
      restored: { ...restored, maxPixelDifference: restoredDifference },
      disposed,
    });
  }
  assert.deepEqual(errors, []);
  const report = { hardware, commit: sampleAssetCommit, models };
  await writeFile('test-results/gltf-production-assets/report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await page
    .evaluate(() => {
      const scene = window.productionAssetScene;
      scene?.model.dispose();
      scene?.engine.dispose();
      if (scene?.NativeWorker) window.Worker = scene.NativeWorker;
    })
    .catch(() => {});
  await browser.close();
}
