// Generated color targets are stand-ins, read back on a real GPU.
export async function transitionChecks() {
  const { Engine, FrameGraph } = await import('../../core/dist/extension.js');
  const { webglRenderer } = await import('../../webgl/dist/index.js');
  const { createCustomTransition } = await import('../dist/custom.js');
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const fallback = await Engine.create(canvas, { backend: 'webgl2', fallback: webglRenderer });
  try {
    let refused = false;
    try {
      await createCustomTransition(fallback, 'invalid');
    } catch (error) {
      refused = error.code === 'unsupported' && /https:/.test(error.message);
    }
    assert(fallback.backend === 'webgl2' && refused, 'actual WebGL2 rejects with code and help');
  } finally {
    fallback.dispose();
  }
  let pixels = 0;
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
      replacement.destroy();
      assert(plugins.size === 0, 'dispose detaches');
      assert(errors.length === 0, errors.join('\n'));
    } finally {
      effect?.dispose();
      for (const texture of outputs) texture.destroy();
      device.destroy();
    }
  }
  return { pixels, samples: [1, 4], fallback: 'unsupported', restoration: true };
}
