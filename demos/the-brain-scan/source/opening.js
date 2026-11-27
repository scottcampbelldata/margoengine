const sliceCode = `
struct View {
  clipFromWorld: mat4x4f,
  halfSize: vec4f,
  slices: vec4f,
  dimensions: vec4f,
}
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var scan: texture_3d<f32>;
@group(0) @binding(2) var sampler3d: sampler;

struct Pixel { @builtin(position) position: vec4f, @location(0) samplePoint: vec3f }

@vertex fn vertex(@builtin(vertex_index) index: u32, @builtin(instance_index) plane: u32) -> Pixel {
  let square = vec2f(f32(index % 2u), f32(index / 2u));
  var p = vec3f(view.slices.x, square.x, square.y);
  if (plane == 1u) { p = vec3f(square.x, view.slices.y, square.y); }
  if (plane == 2u) { p = vec3f(square.x, square.y, view.slices.z); }
  let centered = (2.0 * p - 1.0) * view.halfSize.xyz;
  var clip = view.clipFromWorld * vec4f(centered.x, centered.z, -centered.y, 1.0);
  if (view.slices.w >= 0.0 && view.slices.w != f32(plane)) { clip = vec4f(2.0, 2.0, 2.0, 1.0); }
  let texel = (p * (view.dimensions.xyz - 1.0) + 0.5) / view.dimensions.xyz;
  return Pixel(clip, texel);
}

@fragment fn fragment(p: Pixel) -> @location(0) vec4f {
  let value = textureSample(scan, sampler3d, p.samplePoint).r;
  let tone = pow(clamp((value - .025) * 1.12, 0.0, 1.0), .82);
  // The background of the source crop is zero. Keep this transparent in the 3D rig.
  let alpha = smoothstep(.025, .079, value);
  if (alpha < .06) { discard; }
  return vec4f(vec3f(.092, .143, .170) + tone * vec3f(.816, .801, .743), alpha);
}
`;

export function openingSlices(values, dimensions, halfSize) {
  const name = 'registered-mri-opening-slices';
  const state = new Float32Array(28);
  state.set(halfSize, 16);
  state.set(dimensions, 24);
  let resources;
  let active = true;
  const planeIndex = { sagittal: 0, coronal: 1, axial: 2 };
  const keyOf = (format, depth, samples) => [format, depth, samples].join('/');

  function dispose() {
    resources?.uniform.destroy();
    resources?.texture.destroy();
    resources = undefined;
  }

  function buffers(device) {
    if (resources?.device === device) return resources;
    dispose();
    const texture = device.createTexture({
      size: dimensions, dimension: '3d', format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, values, {
      bytesPerRow: dimensions[0], rowsPerImage: dimensions[1],
    }, dimensions);
    resources = {
      device, texture, view: texture.createView({ dimension: '3d' }),
      sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
      module: device.createShaderModule({ label: 'Opening MRI slices', code: sliceCode }),
      uniform: device.createBuffer({ size: state.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      programs: new Map(),
    };
    return resources;
  }

  function descriptor(module, format, depthFormat, samples) {
    return {
      label: 'Opening MRI slices', layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format, blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      }}] },
      primitive: { topology: 'triangle-strip' },
      multisample: { count: samples },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater-equal' },
    };
  }

  function bind(buffers, key, pipeline) {
    const group = buffers.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: buffers.uniform } },
        { binding: 1, resource: buffers.view },
        { binding: 2, resource: buffers.sampler },
      ],
    });
    const program = { pipeline, group };
    buffers.programs.set(key, program);
    return program;
  }

  function draw(context) {
    if (!active) return;
    const { device, camera, encoder, format } = context;
    const depthFormat = context.descriptor.depthStencil.format;
    const samples = context.descriptor.multisample?.count ?? 4;
    const current = buffers(device);
    const key = keyOf(format, depthFormat, samples);
    const program = current.programs.get(key) ?? bind(current, key,
      device.createRenderPipeline(descriptor(current.module, format, depthFormat, samples)));
    state.set(camera.matrix);
    device.queue.writeBuffer(current.uniform, 0, state);
    const depth = { view: context.depth, depthLoadOp: 'load', depthStoreOp: 'store' };
    if (depthFormat.includes('stencil')) Object.assign(depth, { stencilLoadOp: 'load', stencilStoreOp: 'store' });
    const pass = encoder.beginRenderPass({
      label: 'Registered MRI opening slices',
      colorAttachments: [{ view: context.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: depth,
    });
    pass.setPipeline(program.pipeline);
    pass.setBindGroup(0, program.group);
    pass.draw(4, 3);
    pass.end();
  }

  return {
    name,
    setup() {},
    registerPasses(graph) { graph.add({ name, order: 4, execute: draw }); },
    update(slices, inspect, visible) {
      active = visible;
      state.set([slices.sagittal, slices.coronal, slices.axial, planeIndex[inspect] ?? -1], 20);
    },
    dispose,
  };
}

