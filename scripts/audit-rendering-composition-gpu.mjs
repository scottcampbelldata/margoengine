import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-game.html' });
try {
  const result = await browser.page.evaluate(async () => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { TAA } = await import('/packages/taa/dist/index.js');
    const { Sky } = await import('/packages/sky/dist/index.js');
    const { Scatter } = await import('/packages/scatter/dist/index.js');
    const { ToonShading } = await import('/packages/creative/dist/toon.js');
    const { Shadows } = await import('/packages/shadows/dist/index.js');
    const { Clustered } = await import('/packages/clustered/dist/index.js');
    const { TerrainColors } = await import('/packages/terrain/dist/index.js');
    const { SSAO } = await import('/packages/post/dist/ssao.js');
    const cases = [],
      errors = [];
    for (const name of ['taa-sky', 'taa-scatter', 'taa-ssao', 'toon-shadows-clustered', 'two-wet-terrains']) {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:64px;height:64px';
      document.body.append(canvas);
      const instance = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [3, 3, 5], target: [0, 0, 0] },
      });
      const engine = engineRuntime(instance),
        device = engine.gpu,
        modules = [],
        create = device.createShaderModule.bind(device);
      let ambientShaders = 0;
      engine.onError = (error) => errors.push(name + ': ' + error.message);
      device.createShaderModule = (descriptor) => {
        const module = create(descriptor);
        modules.push(module);
        if (
          descriptor.code.includes('taaCamera') &&
          descriptor.code.includes('return vec4f(i.color*(1.0-i.material.y)*frame.radiance.w,1);')
        )
          ambientShaders++;
        return module;
      };
      device.pushErrorScope('validation');
      const mesh = instance.createMesh().setGeometry(box());
      const ssao = name === 'taa-ssao' ? SSAO.attach(instance) : undefined;
      if (name.startsWith('taa-')) TAA.attach(instance, ssao ? { depth: () => ssao.depthTexture } : undefined);
      if (name === 'taa-sky')
        Sky.attach(instance, { lighting: { ambient: { day: [0.2, 0.2, 0.2], night: [0.01, 0.01, 0.02] } } });
      if (name === 'taa-scatter') Scatter.attach(instance, box(), { count: 8, material: new PbrMaterial() });
      if (name === 'toon-shadows-clustered') {
        ToonShading.attach(instance);
        const shadows = Shadows.attach(instance, { resolution: 64 });
        shadows.add(mesh);
        const lights = Clustered.attach(instance, { grid: [2, 2, 2] });
        lights.setLights([{ position: [0, 2, 0], range: 4 }]);
      }
      if (name === 'two-wet-terrains') {
        const options = {
          sand: [0.4, 0.3, 0.2],
          meadow: [
            [0.1, 0.2, 0.1],
            [0.2, 0.3, 0.1],
          ],
          stone: [0.3, 0.3, 0.3],
          shore: [0, 1],
          meadowHeight: [1, 10],
          stoneHeight: [10, 20],
          stoneNormal: [0.5, 0.8],
          wetHeight: [0, 0.6],
          wetDarkening: 0.55,
        };
        for (const [index, target] of [mesh, instance.createMesh().setGeometry(box()).setPosition([2, 0, 0])].entries())
          TerrainColors.attach(instance, target, {
            ...options,
            wetness: { texture: () => undefined, origin: [index * 4, 0], size: [4, 4] },
          });
      }
      for (let i = 0; i < 3; i++) instance.render({ culling: false, delta: 0.1 });
      await device.queue.onSubmittedWorkDone();
      for (const module of modules)
        for (const message of (await module.getCompilationInfo()).messages)
          if (message.type === 'error') errors.push(name + ': ' + message.message);
      const validation = await device.popErrorScope();
      if (validation) errors.push(name + ': ' + validation.message);
      if (name === 'taa-ssao' && !ambientShaders) errors.push(name + ': missing ambient-only replay with TAA camera');
      cases.push({ name, shaders: modules.length, ...(name === 'taa-ssao' ? { ambientShaders } : {}) });
      instance.dispose();
      canvas.remove();
    }
    const { resolve, present } = await import('/packages/taa/src/shader.ts');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
      device = await adapter.requestDevice();
    const colors = [];
    for (const [format, manualSRGB, expected] of [
      ['bgra8unorm', 1, 0.21586],
      ['rgba8unorm-srgb', 0, 0.21586],
      ['rgba16float', 0, 2],
    ]) {
      device.pushErrorScope('validation');
      const owned = [],
        texture = (format, usage) => {
          const value = device.createTexture({ size: [1, 1], format, usage });
          owned.push(value);
          return value;
        };
      const scene = texture(format, GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING);
      const bytes =
        format === 'rgba16float'
          ? new Uint16Array([0x4000, 0x4000, 0x4000, 0x3c00])
          : new Uint8Array([128, 128, 128, 255]);
      device.queue.writeTexture({ texture: scene }, bytes, { bytesPerRow: bytes.byteLength }, [1, 1]);
      const velocity = texture('rg16float', GPUTextureUsage.TEXTURE_BINDING),
        expectedDepth = texture('r32float', GPUTextureUsage.TEXTURE_BINDING);
      const depth = texture('depth32float', GPUTextureUsage.TEXTURE_BINDING),
        history = texture('rgba16float', GPUTextureUsage.TEXTURE_BINDING),
        historyDepth = texture('r32float', GPUTextureUsage.TEXTURE_BINDING);
      const output = texture(
          'rgba16float',
          GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
        ),
        outputDepth = texture('r32float', GPUTextureUsage.STORAGE_BINDING);
      const target = texture(format, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
      const uniform = device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      owned.push(uniform);
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({ code: resolve }),
          entryPoint: 'main',
          constants: { manualSRGB },
        },
      });
      const entries = [
        { binding: 0, resource: { buffer: uniform } },
        ...[scene, velocity, expectedDepth, depth, history, historyDepth, output, outputDepth].map(
          (texture, index) => ({ binding: index + 1, resource: texture.createView() }),
        ),
      ];
      const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const module = device.createShaderModule({ code: present }),
        draw = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format }], constants: { manualSRGB } },
        });
      const drawBind = device.createBindGroup({
        layout: draw.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: output.createView() }],
      });
      const read = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      owned.push(read);
      const encoder = device.createCommandEncoder(),
        compute = encoder.beginComputePass();
      compute.setPipeline(pipeline);
      compute.setBindGroup(0, bind);
      compute.dispatchWorkgroups(1);
      compute.end();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(draw);
      pass.setBindGroup(0, drawBind);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer({ texture: output }, { buffer: read, bytesPerRow: 256 }, [1, 1]);
      encoder.copyTextureToBuffer({ texture: target }, { buffer: read, offset: 256, bytesPerRow: 256 }, [1, 1]);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const result = new DataView(read.getMappedRange()),
        half = (value) => {
          const exponent = (value >>> 10) & 31;
          return (1 + (value & 1023) / 1024) * 2 ** (exponent - 15);
        };
      const linear = half(result.getUint16(0, true)),
        display = format === 'rgba16float' ? half(result.getUint16(256, true)) : result.getUint8(256) / 255;
      if (
        Math.abs(linear - expected) > 0.001 ||
        Math.abs(display - (format === 'rgba16float' ? 2 : 128 / 255)) > 1 / 255
      )
        errors.push(`${format}: wrong transfer ${linear}/${display}`);
      colors.push({ format, linear, display });
      read.unmap();
      for (const resource of owned) resource.destroy();
      const validation = await device.popErrorScope();
      if (validation) errors.push(format + ': ' + validation.message);
    }
    device.pushErrorScope('validation');
    const depth = device.createTexture({
      size: [1, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthClearValue: 0,
          depthStoreOp: 'store',
          stencilReadOnly: true,
        },
      })
      .end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const stencil = await device.popErrorScope();
    if (stencil) errors.push('depth-only stencilReadOnly: ' + stencil.message);
    depth.destroy();
    device.destroy();
    return { cases, colors, errors };
  });
  assert.deepEqual(result.errors, []);
  await writeFile(
    'test-results/audit-rendering-composition-gpu.json',
    JSON.stringify({ hardware: browser.hardware, ...result }, null, 2),
  );
  console.log(JSON.stringify({ hardware: browser.hardware, ...result }, null, 2));
} finally {
  await browser.close();
}
