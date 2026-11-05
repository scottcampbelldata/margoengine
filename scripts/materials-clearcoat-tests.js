import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openBrowser } from './browser.js';
import { materialQuad } from '../tests/support/materials-fixture.js';

export async function clearcoatBrowserChecks(page) {
  const fixture = materialQuad();
  return page.evaluate(
    async ({ doc, buffers }) => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { parseGLTF } = await import('/packages/gltf-pro/dist/index.js');
      const materials = await import('/packages/materials/dist/index.js');
      const assert = (value, message) => {
        if (!value) throw new Error(message);
      };
      const width = 128,
        height = 128,
        canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${width}px;height:${height}px`;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 0, 3], target: [0, 0, 0] },
      });
      const device = engine.gpu,
        modules = [],
        owned = [];
      const createModule = device.createShaderModule.bind(device);
      device.createShaderModule = (descriptor) => {
        const module = createModule(descriptor);
        modules.push(module);
        return module;
      };
      const model = parseGLTF(
        engine,
        doc,
        buffers.map((buffer) => new Uint8Array(buffer)),
      );
      engine.camera.update(1, true);
      engine.store.tick(false);
      engine.lighting.direction.set([0, 0, 1, 1]);
      engine.lighting.radiance.set([1, 1, 1, 0.03]);
      const texture = (data, size = [1, 1]) => {
        const image = device.createTexture({
          size,
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        owned.push(image);
        device.queue.writeTexture({ texture: image }, new Uint8Array(data), { bytesPerRow: size[0] * 4 }, size);
        return {
          view: image.createView(),
          sampler: device.createSampler({
            minFilter: 'nearest',
            magFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        };
      };
      const depth = device.createTexture({
        size: [width, height],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      owned.push(depth);
      const beauty = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      owned.push(beauty);
      const gbuffer = device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      owned.push(gbuffer);
      const ambient = device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      owned.push(ambient);
      const linear = device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      owned.push(linear);
      const beautyView = beauty.createView(),
        depthView = depth.createView(),
        gbufferView = gbuffer.createView(),
        ambientView = ambient.createView(),
        linearView = linear.createView();
      const read = async (source) => {
        const bytesPerPixel = source === beauty ? 4 : 8,
          bytesPerRow = width * bytesPerPixel;
        const buffer = device.createBuffer({
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        try {
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow }, [width, height]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const bytes = new Uint8Array(buffer.getMappedRange()).slice();
          buffer.unmap();
          return bytes;
        } finally {
          buffer.destroy();
        }
      };
      let captures = 0;
      const render = async (extension, target = model) => {
        captures++;
        if (extension === undefined) delete target.primitives[0].extension;
        else target.primitives[0].extension = extension;
        const encoder = device.createCommandEncoder();
        const clear = encoder.beginRenderPass({
          colorAttachments: [{ view: beautyView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
          depthStencilAttachment: { view: depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
        clear.end();
        const context = {
          backend: 'webgpu',
          device,
          encoder,
          color: beautyView,
          depth: depthView,
          format: 'rgba8unorm',
          width,
          height,
          camera: engine.camera,
          descriptor: { multisample: { count: 1 }, depthStencil: { format: 'depth32float' } },
        };
        target.draw(context, 'beauty', beautyView, depthView);
        const clearGbuffer = encoder.beginRenderPass({
          colorAttachments: [{ view: gbufferView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
        });
        clearGbuffer.end();
        target.draw(context, 'gbuffer', gbufferView, depthView);
        const clearAmbient = encoder.beginRenderPass({
          colorAttachments: [{ view: ambientView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
        });
        clearAmbient.end();
        target.draw(context, 'ambient', ambientView, depthView);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        const captured = { beauty: await read(beauty), gbuffer: await read(gbuffer), ambient: await read(ambient) };
        // A format change rewrites the shared frame buffer. Submit earlier draws before writing HDR settings.
        const linearEncoder = device.createCommandEncoder();
        const clearLinear = linearEncoder.beginRenderPass({
          colorAttachments: [{ view: linearView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
        });
        clearLinear.end();
        target.draw({ ...context, encoder: linearEncoder, format: 'rgba16float' }, 'beauty', linearView, depthView);
        device.queue.submit([linearEncoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        return { ...captured, linear: await read(linear) };
      };
      const difference = (a, b) => {
        let max = 0,
          changed = 0;
        for (let i = 0; i < a.length; i++) {
          const delta = Math.abs(a[i] - b[i]);
          max = Math.max(max, delta);
          changed += +(delta > 0);
        }
        return { max, changed };
      };
      const peak = (image) => {
        let max = 0;
        for (let y = height / 2 - 4; y < height / 2 + 4; y++)
          for (let x = width / 2 - 4; x < width / 2 + 4; x++) max = Math.max(max, image[(y * width + x) * 4]);
        return max;
      };
      device.pushErrorScope('validation');
      try {
        const baseline = await render();
        // Exercise the extension shader even when every coat contribution is zero.
        const zero = await render(materials.clearcoat({ factor: 0, roughnessFactor: 0.05 }));
        const zeroDifference = difference(baseline.beauty, zero.beauty);
        assert(zeroDifference.max <= 1, `Factor zero differs from baseline by ${zeroDifference.max} color steps`);
        const coat = await render(materials.clearcoat({ factor: 1, roughnessFactor: 0.05 }));
        assert(
          peak(coat.beauty) > peak(zero.beauty),
          `Coat peak did not brighten: ${peak(coat.beauty)} <= ${peak(zero.beauty)}`,
        );
        assert(
          difference(baseline.gbuffer, coat.gbuffer).changed === 0,
          'Clearcoat changed the base g-buffer normal/depth',
        );
        assert(difference(baseline.ambient, zero.ambient).changed === 0, 'Factor zero changed the ambient replay');

        const redZero = texture([0, 255, 255, 255]),
          redOne = texture([255, 0, 0, 255]);
        const factorZero = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.05, clearcoatTexture: redZero }),
        );
        const factorOne = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.05, clearcoatTexture: redOne }),
        );
        assert(difference(factorZero.beauty, baseline.beauty).max <= 1, 'Clearcoat factor texture must use red');
        assert(difference(factorOne.beauty, coat.beauty).max <= 1, 'Clearcoat red=1 must retain full factor');
        const loaded = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.05, clearcoatTexture: { view: redOne.view } }),
        );
        assert(
          difference(loaded.beauty, coat.beauty).max <= 1,
          'Sampler-free texture loads differ from a constant sampled texture',
        );

        const greenLow = texture([255, 13, 255, 255]),
          greenHigh = texture([0, 255, 0, 255]);
        const lowRoughness = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 1, clearcoatRoughnessTexture: greenLow }),
        );
        const highRoughness = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 1, clearcoatRoughnessTexture: greenHigh }),
        );
        assert(peak(lowRoughness.beauty) > peak(highRoughness.beauty), 'Clearcoat roughness texture must use green');
        const lowScalar = await render(materials.clearcoat({ factor: 1, roughnessFactor: 13 / 255 }));
        assert(
          difference(lowRoughness.beauty, lowScalar.beauty).max <= 1,
          'Roughness green channel does not match its scalar',
        );

        const tilted = texture([218, 128, 218, 255]);
        const normal = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.05, clearcoatNormalTexture: tilted }),
        );
        assert(difference(normal.beauty, coat.beauty).changed > 0, 'Coat normal texture has no effect on the coat');
        assert(difference(normal.gbuffer, baseline.gbuffer).changed === 0, 'Coat normal leaked into the base g-buffer');
        const scaleZero = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.05, clearcoatNormalTexture: { ...tilted, scale: 0 } }),
        );
        assert(
          difference(scaleZero.beauty, coat.beauty).max <= 1,
          'Normal scale zero must recover the geometric coat normal',
        );
        const normalUV1 = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.05, clearcoatNormalTexture: { ...tilted, texCoord: 1 } }),
        );
        assert(
          difference(normalUV1.gbuffer, baseline.gbuffer).changed === 0,
          'A derivative coat normal changed the base g-buffer',
        );
        const extreme = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.05, clearcoatNormalTexture: { ...tilted, scale: 1e38 } }),
        );
        const half = new Uint16Array(extreme.linear.buffer, extreme.linear.byteOffset, extreme.linear.byteLength / 2);
        assert(
          [...half].every((value) => (value & 0x7c00) !== 0x7c00),
          'Extreme finite normal scale produced HDR NaN or infinity',
        );
        const normalZero = await render(
          materials.clearcoat({ factor: 0, roughnessFactor: 0.05, clearcoatNormalTexture: tilted }),
        );
        assert(
          difference(normalZero.beauty, baseline.beauty).max <= 1,
          'Factor zero with a normal texture changed the base lobe',
        );
        // KHR_materials_clearcoat: everything under the coat keeps 1 - clearcoat x F(n.v), and the coat's own light adds
        // on top. A `direct` hook of zero stands for full shadow, so the coat's lobe must go with the base's.
        const removeLighting = model.addLighting({
          pbr: () => ({ declarations: '', direct: (light) => `${light}*0.0` }),
          bindings() {
            return [];
          },
        });
        const float16 = (bytes, offset) => {
          const value = new DataView(bytes.buffer).getUint16(offset, true),
            exponent = (value >> 10) & 31,
            fraction = value & 1023;
          return exponent ? 2 ** (exponent - 15) * (1 + fraction / 1024) : 2 ** -14 * (fraction / 1024);
        };
        // The two pixels either side of the centre: their views lean opposite ways, so a tilted coat normal reads n.v.
        const centre = (bytes) =>
          (float16(bytes, ((height / 2) * width + width / 2) * 8) +
            float16(bytes, ((height / 2) * width + width / 2 - 1) * 8)) /
          2;
        const near = (actual, expected, label) =>
          assert(Math.abs(actual - expected) <= expected * 0.01, `${label}: ${actual}, expected ${expected}`);
        // Hemisphere ambient at n.y = 0 in red: 0.675 x strength; the coat's default ambient is half of that.
        const strength = 1,
          sky = 0.675 * strength,
          oblique = texture([251, 128, 159, 255]),
          // The texel below is n.v 0.25, to its 8 bits.
          grazing = 1 - 0.04 - 0.96 * (1 - ((159 / 255) * 2 - 1)) ** 5;
        engine.lighting.radiance.set([1, 1, 1, strength]);
        const shadowZero = await render(materials.clearcoat({ factor: 0, roughnessFactor: 0.05 }));
        const shadowCoat = await render(materials.clearcoat({ factor: 1, roughnessFactor: 0.05 }));
        const shadowOblique = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.05, clearcoatNormalTexture: oblique }),
        );
        const under = centre(shadowZero.linear);
        near(centre(shadowCoat.linear), under * 0.96 + 0.04 * 0.5 * sky, 'Coat at normal incidence');
        near(centre(shadowCoat.ambient), under * 0.96 + 0.04 * 0.5 * sky, 'Ambient replay under the coat');
        near(centre(shadowOblique.linear), under * grazing + (1 - grazing) * 0.5 * sky, 'Coat at n.v 0.25');
        // Emission lies under the coat as well: with no ambient light it keeps exactly the coat's share.
        engine.lighting.radiance.set([1, 1, 1, 0]);
        const glowing = structuredClone(doc);
        glowing.materials[0].emissiveFactor = [0.5, 0.5, 0.5];
        const glow = parseGLTF(
          engine,
          glowing,
          buffers.map((buffer) => new Uint8Array(buffer)),
        );
        glow.addLighting({
          pbr: () => ({ declarations: '', direct: (light) => `${light}*0.0` }),
          bindings() {
            return [];
          },
        });
        const glowZero = await render(materials.clearcoat({ factor: 0, roughnessFactor: 0.05 }), glow);
        const glowCoat = await render(materials.clearcoat({ factor: 1, roughnessFactor: 0.05 }), glow);
        const glowOblique = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.05, clearcoatNormalTexture: oblique }),
          glow,
        );
        near(centre(glowZero.linear), 0.5, 'Uncoated emission');
        near(centre(glowCoat.linear), 0.5 * 0.96, 'Emission under the coat');
        near(centre(glowOblique.linear), 0.5 * grazing, 'Emission under the coat at n.v 0.25');
        glow.destroy();
        engine.lighting.radiance.set([1, 1, 1, 0.03]);
        removeLighting();

        const halves = texture([0, 255, 255, 255, 255, 0, 0, 255], [2, 1]);
        const uv0 = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.2, clearcoatTexture: { ...halves, texCoord: 0 } }),
        );
        const uv1 = await render(
          materials.clearcoat({ factor: 1, roughnessFactor: 0.2, clearcoatTexture: { ...halves, texCoord: 1 } }),
        );
        assert(
          difference(uv0.beauty, uv1.beauty).changed > 0,
          'Clearcoat texCoord=1 did not select the independent UV set',
        );
        const removed = await render();
        assert(
          difference(removed.beauty, baseline.beauty).changed === 0,
          'Removing clearcoat failed to restore the baseline',
        );

        // The glTF install path consumes already decoded images and honors the glTF sampler/normal scale.
        const source = document.createElement('canvas');
        source.width = source.height = 2;
        const imageContext = source.getContext('2d');
        imageContext.fillStyle = 'rgb(128,128,255)';
        imageContext.fillRect(0, 0, 2, 2);
        const image = await createImageBitmap(source),
          installedDoc = structuredClone(doc);
        installedDoc.images = [{ uri: source.toDataURL() }];
        installedDoc.textures = [{ source: 0, sampler: 0 }];
        installedDoc.samplers = [{ magFilter: 9728, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
        installedDoc.materials[0].extensions = {
          KHR_materials_clearcoat: {
            clearcoatFactor: 0.75,
            clearcoatRoughnessFactor: 0.5,
            clearcoatTexture: { index: 0 },
            clearcoatRoughnessTexture: { index: 0 },
            clearcoatNormalTexture: { index: 0, scale: 0.5 },
          },
        };
        const installedModel = parseGLTF(
          engine,
          installedDoc,
          buffers.map((buffer) => new Uint8Array(buffer)),
          [image],
        );
        engine.store.tick(false);
        const installation = materials.install(installedModel);
        const installed = await render(undefined, installedModel),
          sample = texture([128, 128, 255, 255]);
        const configured = await render(
          materials.clearcoat({
            factor: 0.75,
            roughnessFactor: 0.5,
            clearcoatTexture: sample,
            clearcoatRoughnessTexture: sample,
            clearcoatNormalTexture: { ...sample, scale: 0.5 },
          }),
        );
        assert(
          difference(installed.beauty, configured.beauty).max <= 1,
          'Installed glTF clearcoat textures differ from caller-configured textures',
        );
        installation.dispose();
        const uninstalled = await render(undefined, installedModel);
        assert(
          difference(uninstalled.beauty, baseline.beauty).max <= 1,
          'Uninstalling glTF clearcoat failed to restore the base material',
        );
        installedModel.destroy();
        const validation = await device.popErrorScope();
        assert(!validation, validation?.message);
        const compilationErrors = (await Promise.all(modules.map((module) => module.getCompilationInfo()))).flatMap(
          (info) => info.messages.filter((message) => message.type === 'error').map((message) => message.message),
        );
        assert(!compilationErrors.length, compilationErrors.join('\n'));
        return {
          pixelsPerCapture: width * height,
          captures,
          fragmentModes: ['beauty', 'gbuffer', 'ambient'],
          factorZero: zeroDifference,
          baselinePeak: peak(zero.beauty),
          clearcoatPeak: peak(coat.beauty),
          textureChannels: ['factor.red', 'roughness.green'],
          independentUVSets: true,
          coatNormal: true,
          unchangedGbuffer: true,
          extensionRemoval: true,
          unchangedAmbient: true,
          derivativeNormalUV1: true,
          extremeNormalScaleFiniteHDR: true,
          directLightVisibility: true,
          installedGLTFTextures: true,
          installedMipLevels: 2,
          shaderModules: modules.length,
          compilationErrors,
        };
      } finally {
        engine.dispose();
        for (const resource of owned) resource.destroy();
        canvas.remove();
      }
    },
    {
      doc: fixture.doc,
      buffers: fixture.buffers.map((buffer) => [
        ...new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      ]),
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5198 }),
    errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
      errors.push(message.text());
  });
  try {
    const checks = await clearcoatBrowserChecks(browser.page);
    assert.deepEqual(errors, []);
    const report = { hardware: browser.hardware, ...checks, errors };
    await writeFile('test-results/materials-clearcoat-webgpu.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}
