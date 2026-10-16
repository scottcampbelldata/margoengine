import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openBrowser } from './browser.js';
import { transmissionQuads } from '../tests/support/transmission-fixture.js';

/** Hardware-backed regression checks for the Step 3 material extension. */
export async function transmissionBrowserChecks(page) {
  const fixture = transmissionQuads();
  return page.evaluate(
    async ({ doc, buffers }) => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { parseGLTF } = await import('/packages/gltf-pro/dist/index.js');
      const { SceneTarget } = await import('/packages/shared/msaa.js');
      const materials = await import('/packages/materials/dist/index.js');
      const assert = (ok, message) => {
        if (!ok) throw new Error(message);
      };
      const width = 128,
        height = 128,
        canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${width}px;height:${height}px`;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        capacity: 64,
        camera: { position: [0, 0, 3], target: [0, 0, 0] },
      });
      const device = engine.gpu,
        modules = [],
        owned = [],
        createModule = device.createShaderModule.bind(device);
      device.createShaderModule = (descriptor) => {
        const module = createModule(descriptor);
        modules.push(module);
        return module;
      };
      engine.camera.update(1, true);
      engine.lighting.direction.set([0, 0, 1, 1]);
      engine.lighting.radiance.set([1, 1, 1, 0.03]);
      const texture = (data, size = [1, 1]) => {
        const value = device.createTexture({
          size,
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        owned.push(value);
        device.queue.writeTexture({ texture: value }, new Uint8Array(data), { bytesPerRow: size[0] * 4 }, size);
        return {
          view: value.createView(),
          sampler: device.createSampler({
            minFilter: 'nearest',
            magFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
          }),
        };
      };
      const target = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      owned.push(target);
      const depth = device.createTexture({
        size: [width, height],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      owned.push(depth);
      const color = target.createView(),
        depthView = depth.createView();
      const multisampled = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      owned.push(multisampled);
      const multisampledDepth = device.createTexture({
        size: [width, height],
        format: 'depth32float',
        sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      owned.push(multisampledDepth);
      const multisampledView = multisampled.createView(),
        multisampledDepthView = multisampledDepth.createView();
      const hdrTarget = device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      owned.push(hdrTarget);
      const hdrDepth = device.createTexture({
        size: [width, height],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      owned.push(hdrDepth);
      const borrowedHDR = new SceneTarget(device, hdrTarget, hdrDepth, 4);
      const read = async (source = target) => {
        const row = width * (source === hdrTarget ? 8 : 4),
          buffer = device.createBuffer({
            size: row * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
        try {
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow: row }, [width, height]);
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
      const extensions = (factor = 1, ior = 1, volume) => ({
        KHR_materials_transmission: { transmissionFactor: factor },
        KHR_materials_ior: { ior },
        ...(volume ? { KHR_materials_volume: volume } : {}),
      });
      const render = async (
        extension = {},
        configure = () => {},
        install = true,
        samples = 1,
        hdr = false,
        pattern = false,
      ) => {
        captures++;
        const definition = structuredClone(doc);
        definition.materials[1].extensions = extension;
        if (pattern) {
          definition.materials.push({ ...structuredClone(definition.materials[0]), emissiveFactor: [0, 1, 0] });
          definition.meshes.push({
            primitives: [{ ...structuredClone(definition.meshes[0].primitives[0]), material: 2 }],
          });
          definition.nodes.push({ mesh: 2, translation: [0.75, 0, -0.39], scale: [0.75, 1.5, 1] });
          definition.nodes[1].rotation = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
        }
        const model = parseGLTF(
          engine,
          definition,
          buffers.map((buffer) => new Uint8Array(buffer)),
        );
        try {
          configure(model);
          const installation = install ? materials.install(model) : undefined;
          engine.store.tick(false);
          const encoder = device.createCommandEncoder();
          const context = {
            backend: 'webgpu',
            device,
            encoder,
            color: samples === 4 ? multisampledView : color,
            depth: samples === 4 ? multisampledDepthView : depthView,
            format: 'rgba8unorm',
            width,
            height,
            camera: engine.camera,
            descriptor: { multisample: { count: samples }, depthStencil: { format: 'depth32float' } },
            draw() {
              const clear = encoder.beginRenderPass({
                colorAttachments: [
                  { view: context.color, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' },
                ],
                depthStencilAttachment: {
                  view: context.depth,
                  depthClearValue: 0,
                  depthLoadOp: 'clear',
                  depthStoreOp: 'store',
                },
              });
              clear.end();
            },
            delta: 0,
          };
          engine.frameGraph.prepare(context);
          if (hdr) borrowedHDR.begin(context);
          engine.frameGraph.execute(context);
          if (hdr) {
            borrowedHDR.resolve(encoder);
            borrowedHDR.restore(context);
          }
          if (samples === 4)
            encoder
              .beginRenderPass({
                colorAttachments: [
                  { view: multisampledView, resolveTarget: color, loadOp: 'load', storeOp: 'discard' },
                ],
              })
              .end();
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
          const result = await read(hdr ? hdrTarget : target);
          installation?.dispose();
          return result;
        } finally {
          model.destroy();
        }
      };
      const difference = (a, b, center = false, pixelBytes = 4) => {
        let max = 0,
          changed = 0;
        for (let y = center ? 48 : 0; y < (center ? 80 : height); y++)
          for (let x = center ? 48 : 0; x < (center ? 80 : width); x++)
            for (let c = 0; c < pixelBytes; c++) {
              const i = (y * width + x) * pixelBytes + c,
                delta = Math.abs(a[i] - b[i]);
              max = Math.max(max, delta);
              changed += +(delta > 0);
            }
        return { max, changed };
      };
      const red = (image) => image[((height / 2) * width + width / 2) * 4];
      device.pushErrorScope('validation');
      try {
        const opaque = await render({}, () => {}, false),
          zero = await render(extensions(0, 1.5));
        const zeroDifference = difference(opaque, zero);
        assert(
          zeroDifference.changed === 0,
          `Transmission factor zero changed ${zeroDifference.changed} channels (maximum ${zeroDifference.max})`,
        );
        const background = await render(
          {},
          (model) => {
            model.primitives[1].node.visible = false;
          },
          false,
        );
        const straight = await render(extensions(1, 1));
        const iorOneDifference = difference(background, straight, true);
        assert(
          iorOneDifference.max <= 1,
          `IOR 1 transmission differs from the opaque background by ${iorOneDifference.max} color steps`,
        );
        const msaaBackground = await render(
          {},
          (model) => {
            model.primitives[1].node.visible = false;
          },
          false,
          4,
        );
        const msaaStraight = await render(extensions(1, 1), () => {}, true, 4),
          msaaDifference = difference(msaaBackground, msaaStraight, true);
        assert(
          msaaDifference.max <= 1,
          `Four-sample IOR 1 transmission differs from the opaque background by ${msaaDifference.max} color steps`,
        );
        const hdrBackground = await render(
          {},
          (model) => {
            model.primitives[1].node.visible = false;
          },
          false,
          1,
          true,
        );
        const hdrStraight = await render(extensions(1, 1), () => {}, true, 1, true),
          hdrDifference = difference(hdrBackground, hdrStraight, true, 8);
        assert(hdrDifference.changed === 0, `Borrowed HDR/MSAA IOR 1 changed ${hdrDifference.changed} captured bytes`);
        const hdrInfinity = await render(
          extensions(1, 1, { thicknessFactor: 1, attenuationColor: [0.2, 1, 1], attenuationDistance: Infinity }),
          () => {},
          true,
          1,
          true,
        );
        assert(
          difference(hdrStraight, hdrInfinity, true, 8).changed === 0,
          'Infinite distance changed the borrowed HDR transmission image',
        );
        const straightPattern = await render(extensions(1, 1), () => {}, true, 1, false, true);
        const refractedPattern = await render(extensions(1, 1.5), () => {}, true, 1, false, true),
          refractionDifference = difference(straightPattern, refractedPattern, true);
        assert(
          refractionDifference.changed > 0,
          'IOR 1.5 did not refract an opaque red/green boundary through the tilted surface',
        );
        assert(red(straight) > red(opaque), 'Transmission did not reveal the red opaque background');
        const infinite = await render(
          extensions(1, 1, { thicknessFactor: 1, attenuationColor: [0.2, 1, 1], attenuationDistance: Infinity }),
        );
        const missingDistance = await render(extensions(1, 1, { thicknessFactor: 1, attenuationColor: [0.2, 1, 1] }));
        assert(
          difference(straight, infinite).changed === 0,
          'Infinite attenuation distance changed the transmitted image',
        );
        assert(
          difference(straight, missingDistance).changed === 0,
          'Missing attenuation distance changed the transmitted image',
        );
        const volume = await render(
          extensions(1, 1, { thicknessFactor: 1, attenuationColor: [0.2, 1, 1], attenuationDistance: 1 }),
        );
        const shorter = await render(
          extensions(1, 1, { thicknessFactor: 1, attenuationColor: [0.2, 1, 1], attenuationDistance: 0.5 }),
        );
        assert(
          red(volume) < red(straight) && red(shorter) < red(volume),
          `Shorter attenuation distance did not increase absorption: ${red(straight)}, ${red(volume)}, ${red(shorter)}`,
        );
        const thickZero = await render(
          extensions(1, 1, { thicknessFactor: 0, attenuationColor: [0.2, 1, 1], attenuationDistance: 0.5 }),
        );
        assert(difference(straight, thickZero).changed === 0, 'Zero volume thickness changed transmission');

        const redZero = texture([0, 255, 255, 255]),
          redOne = texture([255, 0, 0, 255]);
        const configureTransmission = (map) => (model) => {
          model.primitives[1].material.transmission = { factor: 1, ior: 1, transmissionTexture: map };
        };
        const mapZero = await render({}, configureTransmission(redZero)),
          mapOne = await render({}, configureTransmission(redOne));
        assert(difference(opaque, mapZero).max <= 1, 'Transmission texture must use red for its factor');
        assert(difference(straight, mapOne).max <= 1, 'Transmission texture red=1 differs from scalar factor 1');
        const samplerFree = await render({}, configureTransmission({ view: redOne.view }));
        assert(
          difference(straight, samplerFree).max <= 1,
          'Sampler-free transmission texture differs from its constant sampled value',
        );
        const greenZero = texture([255, 0, 255, 255]),
          greenOne = texture([0, 255, 0, 255]);
        const configureVolume = (map) => (model) => {
          model.primitives[1].material.transmission = { factor: 1, ior: 1 };
          model.primitives[1].material.volume = {
            thicknessFactor: 1,
            thicknessTexture: map,
            attenuationColor: [0.2, 1, 1],
            attenuationDistance: 1,
          };
        };
        const thinMap = await render({}, configureVolume(greenZero)),
          thickMap = await render({}, configureVolume(greenOne));
        assert(
          difference(straight, thinMap).max <= 1,
          'Thickness texture must use green: green 0 must leave color unattenuated',
        );
        assert(difference(volume, thickMap).max <= 1, 'Thickness texture green 1 differs from scalar thickness 1');
        const halves = texture([0, 255, 255, 255, 255, 0, 0, 255], [2, 1]);
        const uv0 = await render({}, configureTransmission({ ...halves, texCoord: 0 })),
          uv1 = await render({}, configureTransmission({ ...halves, texCoord: 1 }));
        assert(difference(uv0, uv1, true).changed > 0, 'Transmission did not select the independent UV1 coordinates');
        const thicknessUV0 = await render({}, configureVolume({ ...halves, texCoord: 0 })),
          thicknessUV1 = await render({}, configureVolume({ ...halves, texCoord: 1 }));
        assert(
          difference(thicknessUV0, thicknessUV1, true).changed > 0,
          'Volume thickness did not select the independent UV1 coordinates',
        );
        const coatedZero = await render({ ...extensions(0, 1), KHR_materials_clearcoat: { clearcoatFactor: 0 } });
        assert(
          difference(opaque, coatedZero).changed === 0,
          'Factor-zero clearcoat and transmission did not preserve the baseline',
        );
        await render({
          ...extensions(0.8, 1.5, { thicknessFactor: 0.1, attenuationColor: [1, 0.5, 0.2], attenuationDistance: 1 }),
          KHR_materials_clearcoat: { clearcoatFactor: 0.5, clearcoatRoughnessFactor: 0.1 },
        });
        const restored = await render({}, () => {}, false);
        assert(difference(opaque, restored).changed === 0, 'Disposal changed subsequent baseline rendering');
        const validation = await device.popErrorScope();
        assert(!validation, validation?.message);
        const compilationErrors = (await Promise.all(modules.map((module) => module.getCompilationInfo()))).flatMap(
          (info) => info.messages.filter((message) => message.type === 'error').map((message) => message.message),
        );
        assert(!compilationErrors.length, compilationErrors.join('\n'));
        return {
          pixelsPerCapture: width * height,
          captures,
          factorZero: zeroDifference,
          iorOne: iorOneDifference,
          msaaIorOne: msaaDifference,
          borrowedHDRIorOne: hdrDifference,
          refraction: refractionDifference,
          redBackground: red(background),
          redTransmission: red(straight),
          redVolume: red(volume),
          redShortDistance: red(shorter),
          infiniteDistanceUnchanged: true,
          missingDistanceUnchanged: true,
          zeroThicknessUnchanged: true,
          textureChannels: ['transmission.red', 'thickness.green'],
          independentUVSets: true,
          samplerFree: true,
          clearcoatCoexistence: true,
          shaderModules: modules.length,
          compilationErrors,
        };
      } finally {
        engine.dispose();
        borrowedHDR.dispose();
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
  const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5199 }),
    errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
      errors.push(message.text());
  });
  try {
    const checks = await transmissionBrowserChecks(browser.page);
    assert.deepEqual(errors, []);
    const report = { hardware: browser.hardware, ...checks, errors };
    await writeFile('test-results/materials-transmission-webgpu.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}
