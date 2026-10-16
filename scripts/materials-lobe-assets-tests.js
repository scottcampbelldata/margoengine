import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';
import {
  cachedLobeAssets,
  lobeProductionAssets,
  sampleAssetBase,
  sampleAssetCommit,
} from './support/materials-lobe-assets.js';

const files = await cachedLobeAssets(),
  browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5204 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
    errors.push(message.text());
});
const difference = (a, b) => {
  let max = 0,
    changed = 0;
  assert.equal(a.data.length, b.data.length);
  for (let i = 0; i < a.data.length; i++) {
    const delta = Math.abs(a.data[i] - b.data[i]);
    max = Math.max(max, delta);
    changed += +(delta > 0);
  }
  return { max, changed };
};
const visible = (image) => {
  const background = image.data.subarray(0, 3);
  let foreground = 0,
    colored = 0,
    peak = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const rgb = image.data.subarray(i, i + 3),
      min = Math.min(...rgb),
      max = Math.max(...rgb);
    foreground += +rgb.some((value, k) => Math.abs(value - background[k]) > 8);
    colored += +(max - min > 15);
    peak = Math.max(peak, max);
  }
  return { foreground, colored, peak };
};
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
  const reports = [];
  for (const fixture of lobeProductionAssets) {
    const report = await page.evaluate(
      async (fixture) => {
        const { Engine } = await import('/packages/core/dist/index.js'),
          { loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
          materials = await import('/packages/materials/dist/index.js');
        const assert = (condition, message) => {
          if (!condition) throw new Error(message);
        };
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:640px;height:640px';
        document.body.replaceChildren(canvas);
        const NativeWorker = window.Worker,
          workers = [],
          resources = [],
          originals = {};
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
          originals[method] = GPUDevice.prototype[method];
          GPUDevice.prototype[method] = function (descriptor) {
            const resource = originals[method].call(this, descriptor),
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
        let engine, model, installation;
        const cleanup = () => {
          model?.dispose();
          engine?.dispose();
          window.Worker = NativeWorker;
          for (const method of Object.keys(originals)) GPUDevice.prototype[method] = originals[method];
        };
        try {
          engine = await Engine.create(canvas, {
            backend: 'webgpu',
            capacity: 512,
            camera: { position: fixture.camera, target: [0, 0, 0], near: 0.001, far: 1000 },
          });
          const device = engine.gpu;
          device.pushErrorScope('validation');
          model = await loadGLTF(engine, fixture.url);
          const originalDocument = JSON.stringify(model.asset.doc),
            doc = model.asset.doc;
          assert(
            model.primitives.length > 0 && model.primitives.every((p) => p.vertices.every(Number.isFinite)),
            'Missing complete finite production geometry',
          );
          installation = materials.install(model);
          const names = {
              sheen: 'KHR_materials_sheen',
              specular: 'KHR_materials_specular',
              anisotropy: 'KHR_materials_anisotropy',
              iridescence: 'KHR_materials_iridescence',
            },
            metadata = { sheen: 0, specular: 0, anisotropy: 0, iridescence: 0 },
            factorChecks = [];
          for (const material of new Set(model.primitives.map((p) => p.material)))
            for (const [kind, name] of Object.entries(names)) {
              const authored = material.extensions?.[name];
              if (!authored) continue;
              metadata[kind]++;
              const extension = material.extension;
              assert(extension?.factors?.every(Number.isFinite), 'Installed lobe is missing finite packed uniforms');
              const identifier = {
                sheen: 'materialSheen',
                specular: 'materialSpecular',
                anisotropy: 'materialAnisotropy',
                iridescence: 'materialFilm',
              }[kind];
              const match = new RegExp('let ' + identifier + '=materialFactors\\[(\\d+)\\]').exec(
                extension.declarations ?? '',
              );
              assert(match, 'Missing ' + kind + ' WGSL on ' + material.name);
              const values = Array.from(extension.factors.slice(Number(match[1]) * 4, Number(match[1]) * 4 + 4));
              const expected =
                kind === 'sheen'
                  ? [...(authored.sheenColorFactor ?? [0, 0, 0]), authored.sheenRoughnessFactor ?? 0]
                  : kind === 'specular'
                    ? [...(authored.specularColorFactor ?? [1, 1, 1]), authored.specularFactor ?? 1]
                    : kind === 'anisotropy'
                      ? [authored.anisotropyStrength ?? 0, authored.anisotropyRotation ?? 0, 0, 0]
                      : [
                          authored.iridescenceFactor ?? 0,
                          authored.iridescenceIor ?? 1.3,
                          authored.iridescenceThicknessMinimum ?? 100,
                          authored.iridescenceThicknessMaximum ?? 400,
                        ];
              assert(
                values.every((value, index) => value === Math.fround(expected[index])),
                'Authored ' + kind + ' factors differ from their installed uniform: ' + material.name,
              );
              factorChecks.push({ material: material.name ?? '', kind, values });
            }
          assert(metadata[fixture.lobe] > 0, 'Fixture does not exercise ' + fixture.lobe);
          assert(
            workers.every((worker) => worker.terminated),
            'loadGLTF retained a Basis decoder worker',
          );
          const bounds = model.bounds;
          engine.camera.fitToBoundingBox([bounds[0], bounds[1], bounds[2]], [bounds[3], bounds[4], bounds[5]], {
            duration: 0,
          });
          engine.lighting.direction.set([1, 1, 2, 1]);
          engine.lighting.radiance.set([2, 2, 2, fixture.ambient ?? 0.25]);
          for (let i = 0; i < 2; i++) {
            engine.render({ culling: false });
            await device.queue.onSubmittedWorkDone();
          }
          assert(
            JSON.stringify(model.asset.doc) === originalDocument,
            'Installation mutated the original asset document',
          );
          const validation = await device.popErrorScope();
          assert(!validation, validation?.message);
          const authoredReferences = [];
          if (fixture.name === 'SpecularTest')
            for (const name of [
              'M1.1_specFac',
              'M1.2_specFac',
              'M1.3_specFac',
              'M1.4_specFac',
              'M1.5_specFac',
              'M5.5_yellowFac',
            ]) {
              const primitive = model.primitives.find((p) => p.material.name === name);
              assert(primitive, 'Missing authored specular reference ' + name);
              let left = Infinity,
                right = -Infinity,
                top = Infinity,
                bottom = -Infinity;
              const matrix = primitive.node.matrix,
                camera = engine.camera.matrix;
              for (let at = 0; at < primitive.vertices.length; at += 20) {
                const p = primitive.vertices,
                  x = matrix[0] * p[at] + matrix[4] * p[at + 1] + matrix[8] * p[at + 2] + matrix[12],
                  y = matrix[1] * p[at] + matrix[5] * p[at + 1] + matrix[9] * p[at + 2] + matrix[13],
                  z = matrix[2] * p[at] + matrix[6] * p[at + 1] + matrix[10] * p[at + 2] + matrix[14],
                  w = camera[3] * x + camera[7] * y + camera[11] * z + camera[15],
                  u = (((camera[0] * x + camera[4] * y + camera[8] * z + camera[12]) / w) * 0.5 + 0.5) * canvas.width,
                  v = (0.5 - ((camera[1] * x + camera[5] * y + camera[9] * z + camera[13]) / w) * 0.5) * canvas.height;
                left = Math.min(left, u);
                right = Math.max(right, u);
                top = Math.min(top, v);
                bottom = Math.max(bottom, v);
              }
              authoredReferences.push({ name, left, right, top, bottom });
            }
          window.lobeAssetScene = {
            engine,
            model,
            installation,
            fixture,
            NativeWorker,
            workers,
            resources,
            originals,
            originalDocument,
            loadGLTF,
            materials,
            cleanup,
          };
          return {
            name: fixture.name,
            lobe: fixture.lobe,
            primitives: model.primitives.length,
            vertices: model.primitives.reduce((sum, p) => sum + p.vertices.length / 20, 0),
            metadata,
            factorChecks,
            authoredReferences,
            extensionsRequired: doc.extensionsRequired ?? [],
            extensionsUsed: doc.extensionsUsed ?? [],
            workers: workers.length,
          };
        } catch (error) {
          cleanup();
          throw error;
        }
      },
      { ...fixture, url: sampleAssetBase + fixture.path },
    );
    const screenshot = 'test-results/materials-lobe-assets/' + fixture.name + '.png',
      active = await decodePNG(await page.locator('canvas').screenshot({ path: screenshot })),
      pixels = visible(active);
    assert.ok(
      pixels.foreground > 500 && pixels.peak > 40,
      'Complete production asset is not visible: ' + JSON.stringify({ name: fixture.name, ...pixels }),
    );
    for (const reference of report.authoredReferences) {
      const rgb = [0, 0, 0];
      for (let sample = 0; sample < 16 * 16; sample++) {
        const x = Math.floor(
            reference.left + (0.35 + (((sample % 16) + 0.5) / 16) * 0.3) * (reference.right - reference.left),
          ),
          y = Math.floor(
            reference.top + (0.35 + ((Math.floor(sample / 16) + 0.5) / 16) * 0.3) * (reference.bottom - reference.top),
          ),
          at = (y * active.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) rgb[channel] += active.data[at + channel] / 256;
      }
      reference.meanRGB = rgb;
    }
    if (report.authoredReferences.length) {
      const series = report.authoredReferences
          .slice(0, 5)
          .map((reference) => reference.meanRGB.reduce((a, b) => a + b) / 3),
        yellow = report.authoredReferences[5].meanRGB;
      assert.ok(
        series.at(-1) > series[0] + 10 && series.every((value, index) => index === 0 || value >= series[index - 1] - 1),
        'Authored specular factor ramp is not monotonic: ' + JSON.stringify(series),
      );
      assert.ok(
        yellow[0] > yellow[2] + 10 && yellow[1] > yellow[2] + 10,
        'Authored yellow F0 sample lacks its expected tint: ' + JSON.stringify(yellow),
      );
    }
    const restored = await page.evaluate(async () => {
      const state = window.lobeAssetScene,
        count = state.workers.length;
      await state.engine.rebootDevice();
      const device = state.engine.gpu;
      device.pushErrorScope('validation');
      for (let i = 0; i < 2; i++) {
        state.engine.render({ culling: false });
        await device.queue.onSubmittedWorkDone();
      }
      const validation = await device.popErrorScope();
      if (validation) throw new Error(validation.message);
      if (state.workers.length !== count) throw new Error('Device restoration retranscoded retained KTX2 images');
      return { workers: state.workers.length };
    });
    const afterRestore = await decodePNG(
        await page.locator('canvas').screenshot({ path: screenshot.replace('.png', '-restored.png') }),
      ),
      restoredDifference = difference(active, afterRestore);
    assert.ok(
      restoredDifference.max <= 1,
      'Restoration changed the material-lobe image: ' + JSON.stringify({ name: fixture.name, ...restoredDifference }),
    );
    const neutral = await page.evaluate(async () => {
      const state = window.lobeAssetScene;
      state.model.dispose();
      if (!state.installation.disposed) throw new Error('Model did not dispose its material installation');
      const model = await state.loadGLTF(state.engine, state.fixture.url),
        original = JSON.stringify(model.asset.doc);
      for (const material of new Set(model.primitives.map((p) => p.material))) {
        material.extensions = structuredClone(material.extensions ?? {});
        for (const name of [
          'KHR_materials_sheen',
          'KHR_materials_specular',
          'KHR_materials_anisotropy',
          'KHR_materials_iridescence',
        ])
          delete material.extensions[name];
      }
      state.model = model;
      state.installation = state.materials.install(model);
      const device = state.engine.gpu;
      device.pushErrorScope('validation');
      for (let i = 0; i < 2; i++) {
        state.engine.render({ culling: false });
        await device.queue.onSubmittedWorkDone();
      }
      if (JSON.stringify(model.asset.doc) !== original)
        throw new Error('Neutral control mutated the pinned source document');
      const validation = await device.popErrorScope();
      if (validation) throw new Error(validation.message);
      return { primitives: model.primitives.length, workers: state.workers.length };
    });
    const neutralPixels = await decodePNG(
        await page.locator('canvas').screenshot({ path: screenshot.replace('.png', '-neutral.png') }),
      ),
      lobeDifference = difference(active, neutralPixels);
    assert.ok(
      lobeDifference.changed > 30 && lobeDifference.max > 1,
      'Authored ' +
        fixture.lobe +
        ' did not visibly differ from its neutral material control: ' +
        JSON.stringify(lobeDifference),
    );
    const disposed = await page.evaluate(() => {
      const state = window.lobeAssetScene;
      state.model.dispose();
      const pluginDisposed = state.installation.disposed,
        meshes = state.engine.meshes.size;
      state.cleanup();
      return {
        pluginDisposed,
        meshes,
        workers: state.workers.map((worker) => ({ ...worker })),
        resources: state.resources.length,
        leaked: state.resources.filter((resource) => !resource.destroyed),
      };
    });
    assert.equal(disposed.pluginDisposed, true);
    assert.equal(disposed.meshes, 0);
    assert.deepEqual(disposed.leaked, []);
    assert.ok(disposed.workers.every((worker) => worker.terminated));
    reports.push({
      ...report,
      pixels,
      screenshot,
      restored: { ...restored, ...restoredDifference },
      neutral: { ...neutral, ...lobeDifference },
      disposed,
    });
  }
  assert.deepEqual(errors, []);
  const report = { hardware, commit: sampleAssetCommit, models: reports };
  await writeFile('test-results/materials-lobe-assets/report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await page.evaluate(() => window.lobeAssetScene?.cleanup()).catch(() => {});
  await browser.close();
}
