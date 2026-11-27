import { chartHeight, chartWidth } from './wind-data.js';

const code = `
struct View { clipFromWorld: mat4x4f, chart: vec4f, playback: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlasSampler: sampler;
struct SheetPixel { @builtin(position) clip: vec4f, @location(0) uv: vec2f }

@vertex fn sheet(@builtin(vertex_index) index: u32) -> SheetPixel {
  let uv = vec2f(f32(index % 2u), f32(index / 2u));
  let p = (uv - .5) * view.chart.xy;
  return SheetPixel(view.clipFromWorld * vec4f(p.x, 0.006, p.y, 1.0), uv);
}

@fragment fn map(p: SheetPixel) -> @location(0) vec4f {
  let ink = textureSample(atlas, atlasSampler, p.uv).rgb;
  let paper = 0.96 + .06 * (1.0 - length((p.uv - vec2f(.42, .39)) * 1.1));
  return vec4f(ink * paper, 1.0);
}

struct FlowPixel {
  @builtin(position) clip: vec4f,
  @location(0) velocity: vec3f,
  @location(1) phase: vec2f,
}

@vertex fn arrowRibbon(@builtin(vertex_index) index: u32, @location(0) a: vec4f,
                       @location(1) b: vec4f, @location(2) details: vec3f) -> FlowPixel {
  let side = f32(index / 2u) * 2.0 - 1.0;
  let along = f32(index % 2u);
  let ca = view.clipFromWorld * vec4f(a.x, .011, a.y, 1.0);
  let cb = view.clipFromWorld * vec4f(b.x, .011, b.y, 1.0);
  let direction = (cb.xy / cb.w - ca.xy / ca.w) * view.chart.zw;
  let normal = vec2f(-direction.y, direction.x) / max(.0001, length(direction));
  let current = mix(ca, cb, along);
  let offset = normal * side * details.y * view.playback.y * 2.0 / view.chart.zw * current.w;
  let value = mix(a.zw, b.zw, along);
  return FlowPixel(vec4f(current.xy + offset, current.zw), vec3f(value, side), details.xz);
}

fn palette(speed: f32) -> vec3f {
  let cold = vec3f(.29, .61, .61);
  let low = vec3f(.47, .76, .69);
  let mid = vec3f(.75, .80, .69);
  let high = vec3f(.91, .72, .49);
  let hot = vec3f(.97, .54, .34);
  let t = clamp(speed / 5.0, 0.0, 4.0);
  if (t < 1.0) { return mix(cold, low, t); }
  if (t < 2.0) { return mix(low, mid, t - 1.0); }
  if (t < 3.0) { return mix(mid, high, t - 2.0); }
  return mix(high, hot, t - 3.0);
}

@fragment fn wind(p: FlowPixel) -> @location(0) vec4f {
  let speed = p.velocity.x;
  let phase = fract(p.velocity.y * 7.5 + p.phase.x - view.playback.x * (.48 + .017 * speed));
  let pulse = smoothstep(.53, .92, phase) * (1.0 - smoothstep(.93, 1.0, phase));
  let edge = 1.0 - smoothstep(.26, 1.0, abs(p.velocity.z));
  let ramp = palette(speed);
  if (p.phase.y > .5) {
    return vec4f(mix(ramp, vec3f(.98,.96,.85), .38), edge * .85);
  }
  return vec4f(mix(ramp, vec3f(1.,.93,.76), pulse * .40), edge * (.31 + pulse * .54));
}
`;

export function windPaint(atlas, canvas) {
  let resources, stream;
  let time = 0;
  const values = new Float32Array(24);
  values.set([chartWidth, chartHeight], 16);
  const name = 'north-america-atlas-and-winds';

  function dispose() {
    resources?.uniform.destroy();
    resources?.atlas.destroy();
    resources?.flow?.destroy();
    resources = undefined;
  }

  function buffers(device) {
    if (resources?.device === device) return resources;
    dispose();
    const texture = device.createTexture({
      size: [atlas.width, atlas.height], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: atlas }, { texture }, [atlas.width, atlas.height]);
    resources = {
      device, atlas: texture, atlasView: texture.createView(),
      sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
      uniform: device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      module: device.createShaderModule({ code, label: 'Wind archive' }),
      programs: new Map(),
    };
    return resources;
  }

  function program(state, format, depthFormat, samples, isFlow) {
    const key = [format, depthFormat, samples, isFlow].join('/');
    if (state.programs.has(key)) return state.programs.get(key);
    const vertex = {
      module: state.module,
      entryPoint: isFlow ? 'arrowRibbon' : 'sheet',
    };
    if (isFlow) vertex.buffers = [{
      arrayStride: 44, stepMode: 'instance', attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' },
        { shaderLocation: 1, offset: 16, format: 'float32x4' },
        { shaderLocation: 2, offset: 32, format: 'float32x3' },
      ],
    }];
    const target = { format };
    if (isFlow) target.blend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const label = isFlow ? 'NOAA wind flow and arrows' : 'Chart ink';
    const pipeline = state.device.createRenderPipeline({
      label, layout: 'auto', vertex,
      fragment: { module: state.module, entryPoint: isFlow ? 'wind' : 'map', targets: [target] },
      primitive: { topology: 'triangle-strip' },
      multisample: { count: samples },
      depthStencil: { format: depthFormat, depthWriteEnabled: !isFlow, depthCompare: 'greater-equal' },
    });
    const entries = [{ binding: 0, resource: { buffer: state.uniform } }];
    if (!isFlow) entries.push({ binding: 1, resource: state.atlasView }, { binding: 2, resource: state.sampler });
    const binding = state.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const result = { pipeline, binding };
    state.programs.set(key, result);
    return result;
  }

  function execute(context) {
    const { device, encoder, camera, format } = context, state = buffers(device);
    const depthFormat = context.descriptor.depthStencil.format;
    const samples = context.descriptor.multisample?.count ?? 4;
    const sheet = program(state, format, depthFormat, samples, false);
    const strokes = program(state, format, depthFormat, samples, true);
    if (state.uploaded !== stream) {
      state.flow?.destroy();
      state.flow = device.createBuffer({ size: stream.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(state.flow, 0, stream.vertices);
      state.uploaded = stream;
    }
    values.set(camera.matrix);
    values.set([canvas.width, canvas.height, time, canvas.width / canvas.clientWidth], 18);
    device.queue.writeBuffer(state.uniform, 0, values);
    const depth = { view: context.depth, depthLoadOp: 'load', depthStoreOp: 'store' };
    if (depthFormat.includes('stencil')) Object.assign(depth, { stencilLoadOp: 'load', stencilStoreOp: 'store' });
    const pass = encoder.beginRenderPass({
      label: 'Chart and NOAA surface wind',
      colorAttachments: [{ view: context.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: depth,
    });
    pass.setPipeline(sheet.pipeline);
    pass.setBindGroup(0, sheet.binding);
    pass.draw(4);
    pass.setPipeline(strokes.pipeline);
    pass.setBindGroup(0, strokes.binding);
    pass.setVertexBuffer(0, state.flow);
    pass.draw(4, stream.segments);
    pass.end();
  }

  return {
    name,
    setup() {},
    registerPasses(graph) { graph.add({ name, order: 4, execute }); },
    setFrame(next) { stream = next; },
    setTime(seconds) { time = seconds; },
    dispose,
  };
}

