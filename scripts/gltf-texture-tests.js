import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openBrowser } from './browser.js';
import { textureQuad, texturePixels, basisTextureQuad } from '../tests/support/texture-fixture.js';

/** Real WebGPU texture coordinates and the automatic glTF BasisU loading path. */
export async function textureBrowserChecks(page) {
  const transforms = [
    { offset: [0.13, 0.21] },
    { offset: [0.13, 0.21], scale: [0.59, 0.73] },
    { offset: [0.61, 0.17], rotation: 0.37, scale: [0.59, 0.73] },
    { offset: [0.61, 0.17], rotation: 0.37, scale: [0.59, 0.73], texCoord: 1 },
  ];
  const cases = [];
  for (const channel of ['base', 'metalRough', 'normal', 'occlusion', 'emissive'])
    for (let index = 0; index < transforms.length; index++) {
      const transform = transforms[index];
      cases.push({
        name: channel + ':' + index,
        channel,
        actual: textureQuad(channel, transform, { required: true }),
        reference: textureQuad(channel, transform, { bake: true }),
        baseline: textureQuad(channel),
      });
    }
  for (const transform of transforms.slice(1, 3))
    cases.push({
      name: 'normal:missing-tangent:' + transform.rotation,
      channel: 'normal',
      actual: textureQuad('normal', transform, { required: true, tangents: false }),
      reference: textureQuad('normal', transform, { bake: true, tangents: false }),
      baseline: textureQuad('normal', undefined, { tangents: false }),
    });
  const serialize = (fixture, continuous = false) => {
    const doc = structuredClone(fixture.doc);
    // Affine interpolation and fragment transforms can straddle a nearest-texel boundary.
    // Use a continuous marker for strict UV parity; identity and alpha-caster probes retain nearest sampling.
    if (continuous) for (const sampler of doc.samplers ?? []) Object.assign(sampler, { magFilter: 9729, minFilter: 9729 });
    return {
      doc,
      buffers: fixture.buffers.map((buffer) => [...new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)]),
    };
  };
  const ordinary = textureQuad(),
    identity = textureQuad('base', { offset: [0, 0], rotation: 0, scale: [1, 1] });
  const normalCases = [];
  for (const extended of [false, true])
    for (const tangent of [
      [0, 0, 0, 1],
      [0, 0, 1, 1],
      [0, 0, -1, -1],
    ]) {
      const actual = textureQuad('normal'),
        reference = textureQuad('normal');
      for (const [fixture, frame] of [
        [actual, tangent],
        [reference, [0, 1, 0, tangent[3]]],
      ]) {
        const index = fixture.doc.meshes[0].primitives[0].attributes.TANGENT;
        for (let i = 0; i < 4; i++) fixture.buffers[index].set(frame, i * 4);
      }
      normalCases.push({
        name: `${extended ? 'extended' : 'compact'}:${tangent.join(',')}`,
        actual: { ...serialize(actual), extended },
        reference: { ...serialize(reference), extended },
      });
    }
  const materialCases = [];
  for (const name of ['coatFactor', 'coatRoughness', 'coatNormal', 'transmissionFactor', 'volumeThickness']) {
    const channel = name === 'coatNormal' ? 'normal' : 'base',
      actual = textureQuad(channel, transforms[3]),
      reference = textureQuad(channel, transforms[3], { bake: true });
    for (const fixture of [actual, reference]) {
      delete fixture.doc.materials[0].pbrMetallicRoughness.baseColorTexture;
      delete fixture.doc.materials[0].normalTexture;
    }
    materialCases.push({ name, transform: transforms[3], actual: serialize(actual), reference: serialize(reference) });
  }
  const shadowActual = textureQuad('base', transforms[3], { required: true }),
    shadowReference = textureQuad('base', transforms[3], { bake: true });
  for (const fixture of [shadowActual, shadowReference]) {
    fixture.doc.materials[0].alphaMode = 'MASK';
    fixture.doc.materials[0].alphaCutoff = 0.5;
  }
  await mkdir('test-results/gltf-textures', { recursive: true });
  const ktxDoc = basisTextureQuad({
    colorURI: '/packages/decoders/tests/fixtures/Dot_C.ktx2',
    normalURI: '/packages/decoders/tests/fixtures/Rib_N.ktx2',
    // A malformed fallback is deliberate: KHR_texture_basisu must select its own source.
    fallbackURI: 'data:image/png;base64,AA==',
  }).doc;
  await writeFile('test-results/gltf-textures/basis-quad.gltf', JSON.stringify(ktxDoc));
  return page.evaluate(
    async (payload) => {
      const { Engine, TransformStore } = await import('/packages/core/dist/extension.js');
      const { parseGLTF, loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
      const { Shadows } = await import('/packages/shadows/dist/index.js');
      const materials = await import('/packages/materials/dist/index.js');
      const assert = (value, message) => {
        if (!value) throw new Error(message);
      };
      const width = 128,
        height = 128,
        canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${width}px;height:${height}px`;
      document.body.append(canvas);
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      const compression = ['texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2']
        .filter((feature) => adapter.features.has(feature))
        .slice(0, 1);
      const gpu = await adapter.requestDevice({ requiredFeatures: compression }),
        store = await TransformStore.create(64);
      const engine = new Engine(
        canvas,
        store,
        {
          backend: 'webgpu',
          gpu,
          add() {},
          remove() {},
          render() {},
          dispose() {
            gpu.destroy();
          },
        },
        { position: [0, 0, 3], target: [0, 0, 0] },
        null,
      );
      const device = engine.gpu,
        owned = [],
        modules = new Map(),
        pipelines = [],
        textures = [],
        workers = [];
      const createModule = device.createShaderModule.bind(device),
        createPipeline = device.createRenderPipeline.bind(device),
        createTexture = device.createTexture.bind(device);
      device.createShaderModule = (descriptor) => {
        const value = createModule(descriptor);
        modules.set(value, descriptor.code);
        return value;
      };
      device.createRenderPipeline = (descriptor) => {
        const value = createPipeline(descriptor);
        pipelines.push({ value, descriptor, code: modules.get(descriptor.vertex.module) });
        return value;
      };
      device.createTexture = (descriptor) => {
        const value = createTexture(descriptor),
          record = { value, descriptor, destroyed: false },
          destroy = value.destroy.bind(value);
        textures.push(record);
        value.destroy = () => {
          record.destroyed = true;
          destroy();
        };
        return value;
      };
      const NativeWorker = window.Worker;
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
      engine.camera.update(1, true);
      engine.lighting.direction.set([0.2, 0.3, 1, 1]);
      engine.lighting.radiance.set([1, 1, 1, 0.5]);
      const imageCanvas = document.createElement('canvas');
      imageCanvas.width = imageCanvas.height = 4;
      imageCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(payload.pixels), 4, 4), 0, 0);
      const target = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      owned.push(target);
      const normalTarget = device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      owned.push(normalTarget);
      const depth = device.createTexture({
        size: [width, height],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      owned.push(depth);
      const color = target.createView(),
        normalView = normalTarget.createView(),
        depthView = depth.createView();
      const read = async (source = target) => {
        const row = width * (source === normalTarget ? 8 : 4),
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
      const renderModel = async (model) => {
        captures++;
        engine.store.tick(false);
        const before = pipelines.length,
          encoder = device.createCommandEncoder();
        const context = {
          backend: 'webgpu',
          device,
          encoder,
          color,
          depth: depthView,
          format: 'rgba8unorm',
          width,
          height,
          camera: engine.camera,
          descriptor: { multisample: { count: 1 }, depthStencil: { format: 'depth32float' } },
        };
        encoder
          .beginRenderPass({
            colorAttachments: [{ view: color, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
            depthStencilAttachment: {
              view: depthView,
              depthClearValue: 0,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
            },
          })
          .end();
        model.draw(context, 'beauty', color, depthView);
        encoder
          .beginRenderPass({
            colorAttachments: [{ view: normalView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
          })
          .end();
        model.draw(context, 'gbuffer', normalView, depthView);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        const pipeline = pipelines
          .slice(before)
          .find((item) => item.descriptor.vertex.entryPoint === 'vertex' && item.code?.includes('fn surface('));
        return { beauty: await read(), normals: await read(normalTarget), pipeline };
      };
      const render = async (fixture, coat = false) => {
        const image = await createImageBitmap(imageCanvas, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const model = parseGLTF(
          engine,
          structuredClone(fixture.doc),
          fixture.buffers.map((buffer) => new Uint8Array(buffer)),
          [image],
        );
        try {
          if (fixture.extended) model.primitives[0].material.extendedFrame = true;
          assert(model.primitives[0].vertices.length === 80, 'PBR vertices widened beyond 20 floats');
          if (coat === true) model.primitives[0].extension = materials.clearcoat({ factor: 0.6, roughnessFactor: 0.2 });
          else if (typeof coat === 'function') model.primitives[0].extension = coat(model.primitives[0]);
          return await renderModel(model);
        } finally {
          model.destroy();
        }
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
      const half = (value) => {
        const sign = value & 0x8000 ? -1 : 1,
          exponent = (value >> 10) & 31,
          mantissa = value & 1023;
        return (
          sign *
          (exponent === 0
            ? mantissa * 2 ** -24
            : exponent === 31
              ? Infinity
              : (1 + mantissa / 1024) * 2 ** (exponent - 15))
        );
      };
      const normalDifference = (a, b) => {
        const left = new Uint16Array(a.buffer, a.byteOffset, a.byteLength / 2),
          right = new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
        let max = 0;
        for (let i = 0; i < left.length; i++) max = Math.max(max, Math.abs(half(left[i]) - half(right[i])));
        return max;
      };
      device.pushErrorScope('validation');
      try {
        const ordinary = await render(payload.ordinary),
          identity = await render(payload.identity);
        const baselineDifference = difference(ordinary.beauty, identity.beauty);
        assert(baselineDifference.changed === 0, 'Identity transform changed ordinary PBR pixels');
        const hash = async (value) =>
          [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
        assert(
          (await hash(ordinary.pipeline.code)) === '45df766b2c73181edc3cbd8109a848f17851f03b7cc947dec8d987ff60c2dee5',
          'Ordinary PBR shader changed',
        );
        assert(ordinary.pipeline.code === identity.pipeline.code, 'Identity transform changed the PBR shader');
        const results = [];
        for (const item of payload.normalCases) {
          const actual = await render(item.actual),
            reference = await render(item.reference);
          const beauty = difference(actual.beauty, reference.beauty),
            normals = normalDifference(actual.normals, reference.normals);
          assert(beauty.max <= 1, `${item.name} degenerate tangent changed lighting: ${JSON.stringify(beauty)}`);
          assert(
            Number.isFinite(normals) && normals <= 0.002,
            `${item.name} produced nonfinite or incorrect normals: ${normals}`,
          );
          assert(
            actual.beauty.some((byte, index) => index % 4 < 3 && byte > 0),
            `${item.name} rendered no visible surface`,
          );
          results.push({ name: 'degenerate-normal:' + item.name, beauty, normals });
        }
        for (const item of payload.cases) {
          const actual = await render(item.actual),
            reference = await render(item.reference),
            baseline = await render(item.baseline);
          const beauty = difference(actual.beauty, reference.beauty),
            normals = normalDifference(actual.normals, reference.normals);
          assert(beauty.max <= 1, `${item.name} differs from independently baked UVs: ${JSON.stringify(beauty)}`);
          assert(normals <= 0.002, `${item.name} normal differs from independently baked UVs by ${normals}`);
          assert(difference(actual.beauty, baseline.beauty).changed > 0, `${item.name} ignored its texture transform`);
          assert(
            actual.pipeline.descriptor.vertex.buffers[0].arrayStride === 80,
            'The fixed PBR vertex stride changed',
          );
          results.push({ name: item.name, beauty, normals });
        }
        const composedActual = await render(payload.cases[2].actual, true),
          composedReference = await render(payload.cases[2].reference, true);
        const composedDifference = difference(composedActual.beauty, composedReference.beauty);
        assert(composedDifference.max <= 1, 'Texture transform factors displaced the caller clearcoat factors');

        const marker = device.createTexture({
          size: [4, 4],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        owned.push(marker);
        device.queue.writeTexture({ texture: marker }, new Uint8Array(payload.pixels), { bytesPerRow: 16 }, [4, 4]);
        const opaque = device.createTexture({
          size: [1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        owned.push(opaque);
        device.queue.writeTexture({ texture: opaque }, new Uint8Array([160, 80, 40, 255]), { bytesPerRow: 4 }, [1, 1]);
        const markerView = marker.createView(),
          opaqueView = opaque.createView(),
          sampler = device.createSampler({
            minFilter: 'linear',
            magFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
          }),
          materialResults = [];
        for (const item of payload.materialCases) {
          const make = (transformed) => (primitive) => {
            const map = {
              view: markerView,
              sampler,
              texCoord: transformed ? 0 : 1,
              ...(transformed ? { transform: item.transform } : {}),
            };
            if (item.name === 'coatFactor')
              return materials.clearcoat({ factor: 1, roughnessFactor: 0.2, clearcoatTexture: map });
            if (item.name === 'coatRoughness')
              return materials.clearcoat({ factor: 1, roughnessFactor: 1, clearcoatRoughnessTexture: map });
            if (item.name === 'coatNormal')
              return materials.clearcoat({ factor: 1, roughnessFactor: 0.2, clearcoatNormalTexture: map });
            primitive.material.settings[0] = 2;
            return materials.transmission({
              factor: 1,
              ior: 1,
              opaqueColor: opaqueView,
              ...(item.name === 'transmissionFactor'
                ? { transmissionTexture: map }
                : {
                    volume: {
                      thicknessFactor: 1,
                      thicknessTexture: map,
                      attenuationColor: [0.2, 0.5, 1],
                      attenuationDistance: 0.5,
                    },
                  }),
            });
          };
          const actual = await render(item.actual, make(true)),
            reference = await render(item.reference, make(false)),
            delta = difference(actual.beauty, reference.beauty);
          assert(delta.max <= 1, `${item.name} extension texture differs from baked UVs: ${JSON.stringify(delta)}`);
          materialResults.push({ name: item.name, beauty: delta });
        }

        const maskPixels = new Uint8ClampedArray(payload.pixels);
        for (let i = 0; i < 16; i++) maskPixels[i * 4 + 3] = ((i % 4) + Math.floor(i / 4)) % 2 ? 255 : 0;
        imageCanvas.getContext('2d').putImageData(new ImageData(maskPixels, 4, 4), 0, 0);
        const renderShadow = async (fixture) => {
          const image = await createImageBitmap(imageCanvas, {
              colorSpaceConversion: 'none',
              premultiplyAlpha: 'none',
            }),
            model = parseGLTF(
              engine,
              structuredClone(fixture.doc),
              fixture.buffers.map((buffer) => new Uint8Array(buffer)),
              [image],
            );
          const shadows = Shadows.attach(engine, { resolution: 64, distance: 10, casterMargin: 10 });
          try {
            shadows.add(model);
            engine.store.tick(false);
            const encoder = device.createCommandEncoder();
            shadows.render({ backend: 'webgpu', device, encoder, width, height, camera: engine.camera });
            const buffer = device.createBuffer({
              size: 64 * 64 * 4 * 4,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            try {
              encoder.copyTextureToBuffer(
                { texture: shadows.combined, aspect: 'depth-only' },
                { buffer, bytesPerRow: 256, rowsPerImage: 64 },
                [64, 64, 4],
              );
              device.queue.submit([encoder.finish()]);
              await buffer.mapAsync(GPUMapMode.READ);
              const values = new Float32Array(buffer.getMappedRange()).slice();
              buffer.unmap();
              assert(shadows.stats.dynamicDraws === 4, 'Masked PBR caster did not draw all four cascades');
              return values;
            } finally {
              buffer.destroy();
            }
          } finally {
            shadows.dispose();
            model.destroy();
          }
        };
        const transformedShadow = await renderShadow(payload.shadowActual),
          bakedShadow = await renderShadow(payload.shadowReference);
        const shadowDifference = difference(transformedShadow, bakedShadow),
          shadowCovered = transformedShadow.filter((value) => value < 1).length;
        assert(shadowCovered > 0, 'Transformed alpha caster produced no shadow-map samples');
        assert(shadowDifference.changed === 0, 'Transformed alpha caster shadow differs from independently baked UVs');

        const before = textures.length,
          ktx = await loadGLTF(engine, new URL('/test-results/gltf-textures/basis-quad.gltf', location.href), {
            allowedURLs: [new URL('/packages/decoders/tests/fixtures/', location.href).href],
          });
        let ktxReport;
        try {
          assert(workers.length > 0, 'Automatic KTX2 loading did not create its lazy decoder worker');
          assert(
            workers.every((worker) => worker.terminated),
            'Automatic KTX2 loading retained a decoder worker',
          );
          const uploads = textures.slice(before).filter((record) => record.descriptor.mipLevelCount > 1);
          assert(
            uploads.some((record) => record.descriptor.size[0] === 128 && record.descriptor.mipLevelCount === 8),
            'KTX2 base color mip chain was not retained',
          );
          assert(
            uploads.some((record) => record.descriptor.size[0] === 32 && record.descriptor.mipLevelCount === 6),
            'KTX2 normal mip chain was not retained',
          );
          const image = await renderModel(ktx);
          assert(
            image.beauty.some((value, index) => index % 4 !== 3 && value > 0),
            'KTX2 textured glTF rendered no color',
          );
          const original = uploads.map((record) => record.value);
          ktx.onDeviceRestored(engine);
          assert(
            uploads.every((record) => record.destroyed),
            'Device restoration retained old KTX2 GPU textures',
          );
          const restored = await renderModel(ktx);
          assert(
            difference(image.beauty, restored.beauty).changed === 0,
            'Device restoration changed KTX2 texture pixels',
          );
          assert(original.length >= 2, 'The glTF BasisU sources did not replace the PNG fallback');
          ktxReport = {
            mips: uploads.map((record) => ({
              size: record.descriptor.size,
              levels: record.descriptor.mipLevelCount,
              format: record.descriptor.format,
            })),
            restored: true,
            workers: workers.map(({ terminated }) => ({ terminated })),
          };
        } finally {
          ktx.destroy();
        }
        assert(
          textures.slice(before).every((record) => record.destroyed),
          'KTX2 model disposal retained a GPU texture',
        );
        const validation = await device.popErrorScope();
        assert(!validation, validation?.message);
        const compilationErrors = (
          await Promise.all([...modules.keys()].map((module) => module.getCompilationInfo()))
        ).flatMap((info) =>
          info.messages.filter((message) => message.type === 'error').map((message) => message.message),
        );
        assert(!compilationErrors.length, compilationErrors.join('\n'));
        return {
          pixelsPerCapture: width * height,
          captures,
          compression,
          identity: baselineDifference,
          transforms: results,
          composedClearcoat: composedDifference,
          materialTransforms: materialResults,
          maskedShadows: { difference: shadowDifference, coveredSamples: shadowCovered, cascades: 4 },
          ktx2: ktxReport,
          shaderModules: modules.size,
          compilationErrors,
        };
      } finally {
        window.Worker = NativeWorker;
        engine.dispose();
        for (const resource of owned) resource.destroy();
        canvas.remove();
      }
    },
    {
      ordinary: serialize(ordinary),
      identity: serialize(identity),
      cases: cases.map((item) => ({
        ...item,
        actual: serialize(item.actual, true),
        reference: serialize(item.reference, true),
        baseline: serialize(item.baseline, true),
      })),
      materialCases,
      normalCases,
      shadowActual: serialize(shadowActual),
      shadowReference: serialize(shadowReference),
      pixels: [...texturePixels],
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5201 }),
    errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error' || /Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))
      errors.push(message.text());
  });
  try {
    const checks = await textureBrowserChecks(browser.page);
    assert.deepEqual(errors, []);
    const report = { hardware: browser.hardware, ...checks, errors };
    await writeFile('test-results/gltf-textures-webgpu.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}
