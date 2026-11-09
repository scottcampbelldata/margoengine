// Generated color targets are stand-ins, read back on a real GPU.
export async function transitionChecks() {
  const { Engine, FrameGraph } = await import('../../core/dist/extension.js');
  const { webglRenderer } = await import('../../webgl2-compat/dist/preview.js');
  const { createCustomTransition } = await import('../dist/custom.js');
  const { createMaskTransition } = await import('../dist/mask.js');
  const { Transitions } = await import('../dist/index.js');
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const sceneCanvas = document.createElement('canvas');
  sceneCanvas.width = sceneCanvas.height = 8;
  const sceneEngine = await Engine.create(sceneCanvas);
  try {
    const owner = sceneEngine.createScene('outgoing');
    const defaultEffect = Transitions.attach(sceneEngine);
    const effect = new Transitions();
    owner.use(effect);
    effect.dispose();
    effect.dispose();
    assert(owner.plugins.size === 0 && !sceneEngine.sceneOf(effect), 'disposal removes owning scene registration');
    assert(sceneEngine.scene.plugins.get(defaultEffect.name) === defaultEffect, 'default-scene effect stays attached');
    sceneEngine.render({ views: [{ scene: owner, camera: sceneEngine.camera, viewport: [0, 0, 1, 1] }] });
    sceneEngine.render();
    defaultEffect.dispose();
    owner.dispose();
  } finally {
    sceneEngine.dispose();
  }
  const fallback = await Engine.create(canvas, { backend: 'webgl2', fallback: webglRenderer });
  try {
    let refused = false;
    try {
      await createCustomTransition(fallback, 'invalid');
    } catch (error) {
      refused = error.code === 'unsupported' && /https:/.test(error.message);
    }
    assert(fallback.backend === 'webgl2' && refused, 'actual WebGL2 rejects with code and help');
    let maskRefused = false;
    try {
      createMaskTransition(fallback, new ImageData(1, 1));
    } catch (error) {
      maskRefused = error.code === 'unsupported' && /https:/.test(error.message);
    }
    assert(maskRefused, 'mask WebGL2 refusal includes code and help');
  } finally {
    fallback.dispose();
  }
  let pixels = 0;
  let maskPixels = 0;
  for (const samples of [1, 4]) {
    let device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const errors = [];
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const graph = new FrameGraph();
    const plugins = new Map();
    const engine = {
      gpu: device,
      disposed: false,
      use(effect) {
        graph.withOwner(effect.name, () => {
          effect.setup(engine);
          effect.registerPasses(graph);
        });
        plugins.set(effect.name, effect);
      },
      removePlugin(name) {
        graph.removeOwner(name);
        plugins.delete(name);
      },
      sceneOf(effect) {
        return plugins.get(effect.name) === effect ? engine : undefined;
      },
    };
    let effect;
    let outputs = [];
    let width = 8,
      height = 4;
    let color = [1, 0, 0, 1];
    graph.add({
      name: 'test:scene',
      order: 0,
      execute: (c) => {
        const pass = c.encoder.beginRenderPass({
          colorAttachments: [{ view: c.color, loadOp: 'clear', storeOp: 'store', clearValue: color }],
        });
        pass.end();
      },
    });
    const allocate = () => {
      for (const texture of outputs) texture.destroy();
      const output = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const msaa =
        samples === 4
          ? device.createTexture({
              size: [width, height],
              format: 'rgba8unorm',
              sampleCount: 4,
              usage: GPUTextureUsage.RENDER_ATTACHMENT,
            })
          : output;
      const depth = device.createTexture({
        size: [width, height],
        format: 'depth32float',
        sampleCount: samples,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      outputs = [...new Set([output, msaa, depth])];
      return { output, msaa, depth };
    };
    let target = allocate();
    const frame = async (delta) => {
      const encoder = device.createCommandEncoder();
      const c = {
        draw() {},
        backend: 'webgpu',
        device,
        encoder,
        width,
        height,
        format: 'rgba8unorm',
        color: target.msaa.createView(),
        depth: target.depth.createView(),
        descriptor: { multisample: { count: samples }, depthStencil: { format: 'depth32float' } },
        delta,
      };
      graph.execute(c);
      if (samples === 4) {
        encoder
          .beginRenderPass({
            colorAttachments: [
              {
                view: target.msaa.createView(),
                resolveTarget: target.output.createView(),
                loadOp: 'load',
                storeOp: 'discard',
              },
            ],
          })
          .end();
      }
      const read = device.createBuffer({
        size: 256 * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyTextureToBuffer({ texture: target.output }, { buffer: read, bytesPerRow: 256 }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(read.getMappedRange()).slice();
      read.unmap();
      read.destroy();
      return data;
    };
    const check = (data, expected) => {
      const tolerance = expected.every((value) => value === 0 || value === 1) ? 0 : 1;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          for (let ch = 0; ch < 4; ch++)
            assert(
              Math.abs(data[y * 256 + x * 4 + ch] - Math.round(expected[ch] * 255)) <= tolerance,
              `samples=${samples} pixel ${x},${y} channel ${ch}`,
            );
          pixels++;
        }
    };
    try {
      for (const [index, invalid] of [
        'not wgsl',
        'fn transition()->vec4f{return vec4f(1);}',
        '@group(1) @binding(0) var t:texture_2d<f32>; fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f{return textureLoad(t,vec2i(0),0);}',
      ].entries()) {
        let refused = false;
        const create = device.createShaderModule.bind(device);
        if (index < 2)
          device.createShaderModule = (descriptor) => create({ ...descriptor, label: `expect-error:custom-${index}` });
        try {
          await createCustomTransition(engine, invalid);
        } catch (error) {
          refused = error.code === 'failed';
        } finally {
          device.createShaderModule = create;
        }
        assert(refused && plugins.size === 0, 'invalid WGSL never attaches');
      }
      effect = await createCustomTransition(
        engine,
        'fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f{return mix(sample(a,uv),sample(b,uv),p*p);}',
      );
      check(await frame(0), [1, 0, 0, 1]);
      effect.start('wipe', 1);
      color = [0, 0, 1, 1];
      check(await frame(0), [1, 0, 0, 1]);
      check(await frame(0.25), [0.9375, 0, 0.0625, 1]);
      width = 5;
      height = 7;
      target = allocate();
      check(await frame(0.25), [0.75, 0, 0.25, 1]);
      assert(effect.progress === 0.5, 'resize keeps custom progress');
      check(await frame(0.5), [0, 0, 1, 1]);
      // Real device loss, then a replacement device and the same transition instance.
      effect.start();
      await frame(0.1);
      device.destroy();
      await device.lost;
      const replacement = await (await navigator.gpu.requestAdapter()).requestDevice();
      engine.gpu = replacement;
      effect.onDeviceRestored(engine);
      assert(effect.progress === 1, 'device loss cancels unavailable history');
      device = replacement;
      device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      target = allocate();
      check(await frame(0), [0, 0, 1, 1]);
      effect.dispose();
      effect.dispose();
      const greys = [0, 127, 128, 255];
      const maskCheck = (bytes, progress, softness) => {
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const edge = greys[Math.floor(((y + 0.5) / height) * 2) * 2 + Math.floor(((x + 0.5) / width) * 2)] / 255;
            const t = Math.max(0, Math.min(1, (edge - (progress - softness)) / (2 * softness)));
            const weight =
              progress === 0 ? 0 : progress === 1 ? 1 : softness === 0 ? +(edge <= progress) : 1 - t * t * (3 - 2 * t);
            const expected = [weight, 0, 1 - weight, 1];
            for (let ch = 0; ch < 4; ch++) {
              const tolerance = progress === 0 || progress === 1 ? 0 : 1;
              assert(
                Math.abs(bytes[y * 256 + x * 4 + ch] - Math.round(expected[ch] * 255)) <= tolerance,
                `mask ${samples}x p=${progress} softness=${softness} at ${x},${y},${ch}`,
              );
            }
            maskPixels++;
          }
      };
      for (const softness of [0, 0.1])
        for (const kind of ['data', 'bitmap']) {
          const image = new ImageData(new Uint8ClampedArray(greys.flatMap((g) => [g, g, g, 255])), 2, 2);
          const input = kind === 'bitmap' ? await createImageBitmap(image) : image;
          effect = createMaskTransition(engine, input, { softness });
          color = [0, 0, 1, 1];
          maskCheck(await frame(0), 0, softness);
          effect.start('wipe', 1);
          color = [1, 0, 0, 1];
          maskCheck(await frame(0), 0, softness);
          maskCheck(await frame(0.5), 0.5, softness);
          width = width === 5 ? 7 : 5;
          height = height === 7 ? 3 : 7;
          target = allocate();
          maskCheck(await frame(0), 0.5, softness);
          assert(effect.progress === 0.5, 'mask progress survives resize');
          maskCheck(await frame(0.5), 1, softness);
          effect.start();
          await frame(0.1);
          if (kind === 'bitmap' && softness === 0.1) {
            device.destroy();
            await device.lost;
            device = await (await navigator.gpu.requestAdapter()).requestDevice();
            engine.gpu = device;
            device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
            target = allocate();
          }
          effect.onDeviceRestored(engine);
          maskCheck(await frame(0), 1, softness);
          effect.dispose();
          effect.dispose();
          if (kind === 'bitmap') input.close();
        }
      assert(plugins.size === 0, 'dispose detaches');
      assert(errors.length === 0, errors.join('\n'));
    } finally {
      effect?.dispose();
      for (const texture of outputs) texture.destroy();
      device.destroy();
    }
  }
  return { pixels, maskPixels, samples: [1, 4], fallback: 'unsupported', restoration: true };
}
