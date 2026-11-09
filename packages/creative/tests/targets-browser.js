// Generated colors and fullscreen triangles are stand-ins. Read back every texel of every subresource.
export async function targetChecks() {
  const { TextureRenderTarget } = await import('../dist/targets.js');
  const { Engine } = await import('../../core/dist/extension.js');
  const { webglRenderer } = await import('../../webgl/dist/index.js');
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 8;
  const fallback = await Engine.create(canvas, { backend: 'webgl2', fallback: webglRenderer });
  assert(fallback.backend === 'webgl2', 'actual WebGL2 engine');
  let rejected = false;
  try {
    new TextureRenderTarget(fallback.gpu, { kind: 'cube', width: 4 });
  } catch (error) {
    rejected = error.code === 'unsupported' && /https:/.test(error.message);
  }
  fallback.dispose();
  assert(rejected, 'WebGL2 gets a coded error and help link');
  let device = await (await navigator.gpu.requestAdapter()).requestDevice();
  const errors = [];
  const watch = (gpu) => gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  watch(device);
  let tested = 0;
  const verify = async (target, draw = false) => {
    device.pushErrorScope('validation');
    const module = device.createShaderModule({
      code: `
      @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
        let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
      }
      @fragment fn fs()->@location(0) vec4f {return vec4f(0,1,0,1);}`,
    });
    const info = await module.getCompilationInfo();
    assert(!info.messages.some((m) => m.type === 'error'), 'shader compiles');
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: target.options.format }] },
    });
    const levels = [];
    const enc = device.createCommandEncoder();
    for (let mip = 0; mip < target.options.mipLevelCount; mip++) {
      const [w, h, d] = target.mipSize(mip);
      for (let layer = 0; layer < d; layer++) {
        const color = [((layer + mip) % 3) / 2, layer % 2, mip % 2, 1];
        const pass = target.begin(enc, { mip, layer, clearColor: color });
        pass.end();
        if (draw && layer === 0) {
          const load = target.begin(enc, { mip, layer, loadOp: 'load' });
          load.setPipeline(pipeline);
          load.setScissorRect(0, 0, 1, 1);
          load.draw(3);
          load.end();
        }
        const hdr = target.options.format === 'rgba16float';
        const buffer = device.createBuffer({ size: 256 * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        enc.copyTextureToBuffer(
          { texture: target.texture, mipLevel: mip, origin: [0, 0, layer] },
          { buffer, bytesPerRow: 256, rowsPerImage: h },
          [w, h, 1],
        );
        levels.push({ buffer, w, h, color, layer, hdr });
      }
    }
    device.queue.submit([enc.finish()]);
    for (const { buffer, w, h, color, layer, hdr } of levels) {
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new DataView(buffer.getMappedRange());
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const expected = draw && layer === 0 && x === 0 && y === 0 ? [0, 1, 0, 1] : color;
          for (let c = 0; c < 4; c++) {
            const at = y * 256 + (x * 4 + c) * (hdr ? 2 : 1);
            // Test colors are exactly 0, 0.5, 1 in float16; UNORM rounding allows one integer step.
            const actual = hdr ? data.getUint16(at, true) : data.getUint8(at);
            const want = hdr
              ? expected[c] === 0
                ? 0
                : expected[c] === 0.5
                  ? 0x3800
                  : 0x3c00
              : Math.round(expected[c] * 255);
            assert(
              Math.abs(actual - want) <= (hdr ? 0 : 1),
              `${target.options.kind} texel ${x},${y} layer ${layer}: ${actual} != ${want}`,
            );
          }
        }
      buffer.unmap();
      buffer.destroy();
      tested++;
    }
    const count = target.options.depthOrLayers;
    const kind = target.options.kind;
    const declaration =
      kind === 'cube' ? 'texture_cube<f32>' : kind === 'array' ? 'texture_2d_array<f32>' : 'texture_3d<f32>';
    const expression =
      kind === 'cube'
        ? 'textureSampleLevel(image, nearest, directions[i], 0.0)'
        : kind === 'array'
          ? 'textureLoad(image, vec2i(1,1), i32(i), 0)'
          : 'textureLoad(image, vec3i(1,1,i32(i)), 0)';
    const sampling = device.createShaderModule({
      code: `
      @group(0) @binding(0) var image:${declaration};
      ${kind === 'cube' ? '@group(0) @binding(1) var nearest:sampler;' : ''}
      @group(0) @binding(2) var<storage,read_write> out:array<vec4f>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
        let i=id.x;
        let directions=array<vec3f,6>(vec3f(1,0,0),vec3f(-1,0,0),vec3f(0,1,0),vec3f(0,-1,0),vec3f(0,0,1),vec3f(0,0,-1));
        out[i]=${expression};
      }`,
    });
    const compute = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: sampling, entryPoint: 'main' },
    });
    const output = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const entries = [
      { binding: 0, resource: target.view },
      { binding: 2, resource: { buffer: output } },
    ];
    if (kind === 'cube') entries.push({ binding: 1, resource: device.createSampler() });
    const group = device.createBindGroup({ layout: compute.getBindGroupLayout(0), entries });
    const sampleEncoder = device.createCommandEncoder();
    const samplePass = sampleEncoder.beginComputePass();
    samplePass.setPipeline(compute);
    samplePass.setBindGroup(0, group);
    samplePass.dispatchWorkgroups(count);
    samplePass.end();
    sampleEncoder.copyBufferToBuffer(output, 0, read, 0, count * 16);
    device.queue.submit([sampleEncoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const sampled = new Float32Array(read.getMappedRange());
    for (let layer = 0; layer < count; layer++) {
      const expected = [(layer % 3) / 2, layer % 2, 0, 1];
      for (let c = 0; c < 4; c++)
        assert(
          Math.abs(sampled[layer * 4 + c] - expected[c]) <= 0.5 / 255 + 1e-7,
          `${kind} sampling layer ${layer}, channel ${c}`,
        );
    }
    read.unmap();
    read.destroy();
    output.destroy();
    assert((await device.popErrorScope()) === null, 'no GPU validation errors');
  };
  try {
    for (const kind of ['cube', 'array', '3d'])
      for (const format of ['rgba8unorm', 'rgba16float']) {
        const target = new TextureRenderTarget(device, {
          kind,
          format,
          width: 4,
          height: kind === 'cube' ? 4 : 3,
          depthOrLayers: kind === 'cube' ? 6 : 3,
          mipLevelCount: 3,
        });
        await verify(target, true);
        target.dispose();
        target.dispose();
      }
    const target = new TextureRenderTarget(device, { kind: '3d', width: 4, depthOrLayers: 4, mipLevelCount: 3 });
    await verify(target);
    const oldTexture = target.texture,
      oldView = target.view;
    device.destroy();
    const loss = await device.lost;
    assert(loss.reason === 'destroyed', 'explicit device loss observed');
    device = await (await navigator.gpu.requestAdapter()).requestDevice();
    watch(device);
    target.restore(device);
    assert(target.texture !== oldTexture && target.view !== oldView, 'loss replaces handles');
    await verify(target, true);
    target.dispose();
    assert(errors.length === 0, errors.join('\n'));
    return { subresources: tested, webgl2: 'unsupported with help link', deviceLoss: 'redrawn on replacement device' };
  } finally {
    device.destroy();
  }
}
