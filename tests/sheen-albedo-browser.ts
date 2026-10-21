// GPU fixture for scripts/sheen-albedo-gpu-check.js: runs the shipped materialLobesSheenAlbedo WGSL in a compute
// shader, and draws a lit sphere with the sheen lobe into a linear rgba16float target. setReference() swaps in another
// body for that one function at shader-module creation (the check passes the previous fit, read from git), so a page
// loaded for the reference compiles every sheen pipeline with it; nothing else in the shader changes.
import { Engine } from '../packages/core/dist/extension.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import type { PBRModel } from '../packages/gltf-pro/dist/index.js';
import { materialLobes } from '../packages/materials/dist/index.js';
import type { MaterialLobeOptions } from '../packages/materials/dist/index.js';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number };
declare const GPUBufferUsage: { STORAGE: number; COPY_SRC: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

const size = 192,
  albedoPattern = /fn materialLobesSheenAlbedo\(mu:f32,roughness:f32\)->f32 \{[\s\S]*?\n\}/,
  shipped = albedoPattern.exec(materialLobes({ sheen: { colorFactor: [1, 1, 1] } }).declarations ?? '')?.[0],
  canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  device = engine.gpu!,
  errors: string[] = [];
engine.stop();
if (!shipped) errors.push('materialLobesSheenAlbedo is missing from the built sheen declarations');
device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
let reference: string | undefined,
  modules = 0,
  shippedModules = 0,
  replaced = 0;
const createShaderModule = device.createShaderModule.bind(device);
device.createShaderModule = (descriptor) => {
  modules++;
  if (shipped && descriptor.code.includes(shipped)) {
    shippedModules++;
    if (reference !== undefined) {
      replaced++;
      descriptor = { ...descriptor, code: descriptor.code.replace(shipped, reference) };
    }
  }
  return createShaderModule(descriptor);
};

/** A UV sphere as a glTF document, so every view angle from normal to grazing is on screen. */
function sphere() {
  const columns = 128,
    rows = 96,
    positions: number[] = [],
    tangents: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const theta = (Math.PI * j) / rows,
        phi = (2 * Math.PI * i) / columns;
      positions.push(Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi));
      tangents.push(Math.cos(phi), 0, -Math.sin(phi), 1);
      uvs.push(i / columns, j / rows);
    }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const a = j * (columns + 1) + i,
        b = a + columns + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const buffers: ArrayBufferView[] = [],
    bufferViews: { buffer: number; byteLength: number }[] = [],
    accessors: object[] = [];
  const accessor = (data: Float32Array | Uint16Array, type: string, count: number, bounds?: object) => {
    buffers.push(data);
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    accessors.push({
      bufferView: buffers.length - 1,
      componentType: data instanceof Uint16Array ? 5123 : 5126,
      count,
      type,
      ...bounds,
    });
    return accessors.length - 1;
  };
  const vertices = positions.length / 3,
    attributes = {
      POSITION: accessor(new Float32Array(positions), 'VEC3', vertices, { min: [-1, -1, -1], max: [1, 1, 1] }),
      NORMAL: accessor(new Float32Array(positions), 'VEC3', vertices),
      TANGENT: accessor(new Float32Array(tangents), 'VEC4', vertices),
      TEXCOORD_0: accessor(new Float32Array(uvs), 'VEC2', vertices),
    },
    index = accessor(new Uint16Array(indices), 'SCALAR', indices.length);
  const doc = {
    asset: { version: '2.0' },
    buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
    bufferViews,
    accessors,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices: index, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
  };
  return parseGLTF(engine, doc, buffers) as PBRModel;
}
const model = sphere(),
  target = (format: GPUTextureFormat, usage: number) =>
    device.createTexture({ size: [size, size], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | usage }),
  linear = target('rgba16float', GPUTextureUsage.COPY_SRC),
  depth = target('depth32float', 0);

function half(word: number) {
  const exponent = (word >> 10) & 31,
    mantissa = word & 1023,
    value = exponent ? 2 ** (exponent - 15) * (1 + mantissa / 1024) : (2 ** -14 * mantissa) / 1024;
  return word & 32768 ? -value : value;
}

async function read(texture: GPUTexture) {
  const row = size * 8,
    buffer = device.createBuffer({ size: row * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [size, size]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const words = new Uint16Array(buffer.getMappedRange()),
      rgb: number[] = [],
      alpha: number[] = [];
    for (let i = 0; i < size * size; i++) {
      rgb.push(half(words[i * 4]), half(words[i * 4 + 1]), half(words[i * 4 + 2]));
      alpha.push(half(words[i * 4 + 3]));
    }
    return { rgb, alpha };
  } finally {
    buffer.unmap();
    buffer.destroy();
  }
}

type Scene = {
  lobes?: MaterialLobeOptions;
  base?: [number, number, number, number];
  roughness?: number;
  direction?: [number, number, number, number];
  ambient?: number;
};

const sheenAlbedoFixture = {
  errors,
  shipped,
  setReference(text: string) {
    reference = text;
  },
  counts: () => ({ modules, shippedModules, replaced }),
  /** Evaluates the shipped (or reference) WGSL function at [mu, roughness] pairs on the GPU. */
  async evaluate(points: [number, number][]) {
    const code = `${reference ?? shipped}
@group(0) @binding(0) var<storage,read> inputs:array<vec2f>;
@group(0) @binding(1) var<storage,read_write> outputs:array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x<arrayLength(&outputs)){let p=inputs[id.x];outputs[id.x]=materialLobesSheenAlbedo(p.x,p.y);}
}`;
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code }),
      messages = (await module.getCompilationInfo()).messages.map((m) => `${m.type}: ${m.message}`),
      count = points.length,
      input = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      output = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      staging = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      device.queue.writeBuffer(input, 0, new Float32Array(points.flat()));
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
        group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: input } },
            { binding: 1, resource: { buffer: output } },
          ],
        }),
        encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, count * 4);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const values = Array.from(new Float32Array(staging.getMappedRange().slice(0)));
      staging.unmap();
      const error = await device.popErrorScope();
      return { values, messages, validation: error?.message ?? null };
    } finally {
      for (const buffer of [input, output, staging]) buffer.destroy();
    }
  },
  /** Draws the sphere once into the linear HDR target and returns its RGB and alpha channels. */
  async render(scene: Scene = {}) {
    const material = model.primitives[0].material;
    material.base = scene.base ?? [0.5, 0.12, 0.1, 1];
    material.factors[0] = scene.roughness ?? 0.6;
    material.factors[1] = 0;
    material.emission = [0, 0, 0];
    engine.lighting.direction.set(scene.direction ?? [0.5, 0.45, 0.74, 2]);
    engine.lighting.radiance.set([1, 1, 1, scene.ambient ?? 0.35]);
    if (scene.lobes) model.primitives[0].extension = materialLobes(scene.lobes);
    else delete model.primitives[0].extension;
    engine.camera.update(1, true);
    engine.store.tick(false);
    device.pushErrorScope('validation');
    const encoder = device.createCommandEncoder(),
      view = linear.createView(),
      depthView = depth.createView(),
      context = {
        backend: 'webgpu',
        device,
        encoder,
        color: view,
        depth: depthView,
        format: 'rgba16float',
        width: size,
        height: size,
        camera: engine.camera,
        descriptor: { multisample: { count: 1 }, depthStencil: { format: 'depth32float' } },
      };
    encoder
      .beginRenderPass({
        colorAttachments: [{ view, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      })
      .end();
    model.draw(context as never, 'beauty', view, depthView);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
    return read(linear);
  },
  dispose() {
    model.dispose();
    linear.destroy();
    depth.destroy();
    engine.dispose();
  },
};
Object.assign(window, { sheenAlbedoFixture });
