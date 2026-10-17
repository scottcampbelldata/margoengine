import { Engine } from '../packages/core/dist/extension.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';
import { PostStack } from '../packages/post/dist/stack.js';
import { SceneTarget } from '../packages/shared/msaa.js';

declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare global {
  var margoLow: number | undefined;
}

type Config = {
  size?: number;
  path?: 'external' | 'standalone' | 'stack';
  output?: boolean;
  p3?: boolean;
  peak?: number;
  parsed?: boolean;
  legacy?: boolean;
  noLUT?: boolean;
  mutate?: boolean;
  variant?: number;
};
const width = 256,
  height = 64,
  sourceRGB = [
    ...Array.from({ length: 8 }, (_, index) => [index & 1 ? 2 : 0, index & 2 ? 2 : 0, index & 4 ? 2 : 0]),
    [0.375, 0.5, 0.625],
    [0.5, 0.625, 0.375],
    [0.625, 0.375, 0.5],
    [0.5, 0.5, 0.5],
    [-0.125, 1, 0],
    [1, -0.25, 0.25],
    [4, 1, 0.125],
    [16, 8, 4],
  ],
  sources = sourceRGB.map((rgb, index) => [...rgb, index % 2 ? 0.5 : 1]),
  domainMin = [0.2, 0.25, 0.3],
  domainMax = [0.65, 0.7, 0.75];
globalThis.margoLow = new URLSearchParams(location.search).get('samples') === '1' ? 1 : undefined;
const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' }),
  errors: string[] = [],
  allocations = { textures: 0, buffers: 0, groups: 0, pipelines: 0, uploads: 0 };
engine.stop();
engine.onError = (error) => errors.push(String(error));
let observed: GPUDevice | undefined,
  current: Config = {},
  effect: Tonemap | undefined,
  stack: PostStack | undefined,
  sampleCount = 0,
  targetDevice: GPUDevice | undefined,
  target: SceneTarget | undefined,
  color: GPUTexture | undefined,
  depth: GPUTexture | undefined,
  source: GPUTexture | undefined,
  excess: GPUTexture | undefined,
  fillPipeline: GPURenderPipeline | undefined,
  fillKey = '',
  selectedShader = '',
  lastLUT:
    | { size: number[]; format: string; bytesPerRow?: number; rowsPerImage?: number; extent?: number[] }
    | undefined;
const shaderCodes: string[] = [];
function observe() {
  const device = engine.gpu!;
  if (observed === device) return device;
  observed = device;
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const texture = device.createTexture.bind(device),
    buffer = device.createBuffer.bind(device),
    group = device.createBindGroup.bind(device),
    pipeline = device.createRenderPipeline.bind(device),
    shader = device.createShaderModule.bind(device),
    write = device.queue.writeTexture.bind(device.queue);
  device.createTexture = (descriptor) => {
    allocations.textures++;
    if (descriptor.dimension === '3d')
      lastLUT = { size: Array.from(descriptor.size as number[]), format: descriptor.format };
    return texture(descriptor);
  };
  device.createBuffer = (descriptor) => {
    allocations.buffers++;
    return buffer(descriptor);
  };
  device.createBindGroup = (descriptor) => {
    allocations.groups++;
    return group(descriptor);
  };
  device.createRenderPipeline = (descriptor) => {
    allocations.pipelines++;
    return pipeline(descriptor);
  };
  device.createShaderModule = (descriptor) => {
    if (descriptor.code.includes('fn sampleLUT')) {
      selectedShader = descriptor.code;
      shaderCodes.push(descriptor.code);
    }
    return shader(descriptor);
  };
  device.queue.writeTexture = (destination, data, layout, size) => {
    allocations.uploads++;
    if (destination.texture.dimension === '3d' && lastLUT)
      Object.assign(lastLUT, {
        bytesPerRow: layout.bytesPerRow,
        rowsPerImage: layout.rowsPerImage,
        extent: Array.from(size as number[]),
      });
    return write(destination, data, layout, size);
  };
  return device;
}
observe();
function releaseTargets() {
  target?.dispose();
  color?.destroy();
  depth?.destroy();
  source?.destroy();
  excess?.destroy();
  target = undefined;
  color = depth = source = excess = undefined;
  targetDevice = undefined;
  fillPipeline = undefined;
  fillKey = '';
}
engine.frameGraph.add({
  name: 'lut-size:target',
  order: -120,
  execute(context) {
    if (context.backend !== 'webgpu') return;
    const device = observe();
    sampleCount = context.descriptor.multisample?.count ?? 1;
    if (targetDevice !== device) {
      releaseTargets();
      targetDevice = device;
      color = device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      depth = device.createTexture({
        size: [width, height],
        format: context.descriptor.depthStencil!.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      target = new SceneTarget(device, color, depth, sampleCount);
      source = device.createTexture({
        size: [width, height],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const pixels = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) pixels.set(sources[Math.floor(x / 16)], (y * width + x) * 4);
      device.queue.writeTexture({ texture: source }, pixels, { bytesPerRow: width * 16 }, [width, height]);
      excess = device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    }
    target!.begin(context);
  },
});
engine.frameGraph.add({
  name: 'lut-size:color-output-protocol',
  order: -90,
  execute(context) {
    if (context.backend !== 'webgpu') return;
    const key = Symbol.for('margoengine.color-output');
    if (current.output)
      Object.assign(context, {
        [key]: { peak: current.peak ?? 4, p3: !!current.p3, excess: () => excess!.createView() },
      });
    else Reflect.deleteProperty(context, key);
  },
});
engine.frameGraph.add({
  name: 'lut-size:known-hdr-stripes',
  order: 0.25,
  execute(context) {
    if (context.backend !== 'webgpu' || (current.path ?? 'external') === 'external') return;
    const key = context.format + ':' + context.descriptor.multisample?.count;
    if (fillKey !== key) {
      const module = context.device.createShaderModule({
        code: `
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
let colors=array<vec4f,16>(${sources.map((rgba) => `vec4f(${rgba.map((value) => (Number.isInteger(value) ? value + '.0' : value)).join(',')})`).join(',')});
return colors[min(u32(p.x)/16u,15u)];}`,
      });
      fillPipeline = context.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: context.format }] },
        multisample: context.descriptor.multisample,
      });
      fillKey = key;
    }
    const pass = context.encoder.beginRenderPass({
      colorAttachments: [{ view: context.color, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(fillPipeline!);
    pass.draw(3);
    pass.end();
  },
});
engine.frameGraph.add({
  name: 'lut-size:resolve',
  order: 20000,
  execute(context) {
    if (context.backend !== 'webgpu') return;
    target!.resolve(context.encoder);
    target!.restore(context);
  },
});

function sample(r: number, g: number, b: number, variant: number) {
  return variant
    ? [0.1 + 0.5 * g * g + 0.2 * b, 0.03 + 0.7 * b * b + 0.1 * r * g, 0.02 + 0.6 * r * r + 0.25 * g * b]
    : [
        -0.08 + 0.9 * r * r + 0.3 * g * b,
        0.02 + 0.6 * g * g + 0.2 * r * b + 0.05 * r,
        -0.03 + 0.75 * b * b + 0.22 * r * g,
      ];
}
function lut(config: Config) {
  const size = config.size ?? 33,
    data = new Float32Array(size ** 3 * 4);
  let text = `TITLE "Cross-channel fixture"\nLUT_3D_SIZE ${size}\nDOMAIN_MIN ${domainMin.join(' ')}\nDOMAIN_MAX ${domainMax.join(' ')}\n`,
    offset = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const rgb = sample(r / (size - 1), g / (size - 1), b / (size - 1), config.variant ?? 0);
        data.set([...rgb, 1], offset);
        offset += 4;
        if (config.parsed) text += rgb.map((value) => value.toFixed(6)).join(' ') + '\n';
      }
  return config.parsed
    ? text
    : {
        ...(config.legacy ? {} : { size }),
        data,
        domainMin: Float32Array.from(domainMin),
        domainMax: Float32Array.from(domainMax),
      };
}
function clear() {
  stack?.dispose();
  effect?.dispose();
  stack = undefined;
  effect = undefined;
}
async function frame() {
  const device = observe();
  device.pushErrorScope('validation');
  try {
    engine.render({ culling: false });
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}
function delta(before: typeof allocations) {
  return Object.fromEntries(
    Object.entries(allocations).map(([key, value]) => [key, value - before[key as keyof typeof allocations]]),
  );
}
function half(value: number) {
  const sign = value & 0x8000 ? -1 : 1,
    exponent = (value >> 10) & 31,
    fraction = value & 1023;
  return sign * (exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction * 2 ** -24);
}
async function read(texture: GPUTexture) {
  const device = observe(),
    buffer = device.createBuffer({
      size: width * height * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: width * 8 }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = buffer.getMappedRange().slice(0),
      values = new Uint16Array(bytes),
      digest = await crypto.subtle.digest('SHA-256', bytes);
    return {
      hash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
      pixels: sources.map((_, index) =>
        Array.from(values.slice((32 * width + index * 16 + 8) * 4, (32 * width + index * 16 + 8) * 4 + 4), half),
      ),
    };
  } finally {
    buffer.unmap();
    buffer.destroy();
  }
}
async function state() {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(selectedShader));
  return {
    sampleCount,
    lastLUT,
    shaderHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
    shaderCount: shaderCodes.length,
    image: await read(color!),
    ...(current.output ? { excess: await read(excess!) } : {}),
  };
}
const lutSizeFixture = {
  sources,
  domainMin,
  domainMax,
  errors,
  async render(config: Config) {
    clear();
    current = config;
    effect = new Tonemap({
      curve: 'neutral',
      ...((config.path ?? 'external') === 'external' ? { source: () => source } : {}),
    });
    if (config.path === 'stack') stack = PostStack.attach(engine, [effect]);
    else engine.use(effect);
    return lutSizeFixture.replace(config);
  },
  async replace(config: Config) {
    current = { ...current, ...config };
    const value = current.noLUT ? null : lut(current);
    try {
      effect!.setLUT(value);
    } catch (error) {
      return { accepted: false, error: String(error) };
    }
    if (current.mutate && value && typeof value !== 'string') {
      value.data.fill(0);
      value.domainMin.fill(-100);
      value.domainMax.fill(100);
      if ('size' in value) value.size = 2;
    }
    await frame();
    return { accepted: true, ...(await state()) };
  },
  async steady() {
    const before = { ...allocations };
    await frame();
    const changes = delta(before);
    return { ...(await state()), allocations: changes };
  },
  async restore() {
    const previous = engine.gpu;
    releaseTargets();
    await engine.rebootDevice();
    await frame();
    return { ...(await state()), changedDevice: previous !== engine.gpu };
  },
  dispose() {
    clear();
    releaseTargets();
    engine.dispose();
  },
};
Object.assign(window, { lutSizeFixture });
