import { Engine } from '../packages/core/dist/extension.js';
import type { PassContext } from '../packages/core/dist/extension.js';
import { Material, Texture, createMesh, createInstancedMesh, StencilBuffer } from '../packages/materials/dist/index.js';
import type { MaterialOptions, MeshGeometry } from '../packages/materials/dist/index.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import type { PBRModel, PBRRenderState } from '../packages/gltf-pro/dist/index.js';
import { SceneTarget } from '../packages/shared/msaa.js';
import { viewMatrix } from '../packages/shared/view.js';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare global {
  var margoLow: number | undefined;
}
type Draw = {
  options?: MaterialOptions;
  state?: PBRRenderState;
  bounds?: [number, number, number, number];
  x?: number;
  z?: number;
  slope?: number;
  mirror?: boolean;
  reverse?: boolean;
  instances?: boolean;
  staticMirrors?: boolean;
  alphaMask?: boolean;
};
type Variant = {
  clear?: number;
  combined?: boolean;
  legacy?: boolean;
  noStencil?: boolean;
  back?: boolean;
  stencilBuffer?: boolean;
  forward?: boolean;
};
globalThis.margoLow = new URLSearchParams(location.search).get('samples') === '1' ? 1 : undefined;
const width = 320,
  height = 240,
  engine = await Engine.create(document.querySelector('canvas')!, {
    backend: 'webgpu',
    camera: { position: [0, 0, 5], target: [0, 0, 0], near: 1, far: 21 },
  }),
  errors: string[] = [],
  models: PBRModel[] = [],
  materials: Material[] = [],
  allocations = { textures: 0, samplers: 0, buffers: 0, groups: 0, pipelines: 0 },
  descriptors: { depthStencil: GPUDepthStencilState | undefined; writeMask: GPUColorWriteFlags | undefined }[] = [],
  references: number[] = [],
  createdFormats: GPUTextureFormat[] = [];
engine.stop();
engine.camera.project = (out) => {
  out[0] = 0.5;
  out[5] = 2 / 3;
  out[10] = 1 / 20;
  out[14] = 21 / 20;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
let sampleCount = 0,
  observed: GPUDevice | undefined,
  targetDevice: GPUDevice | undefined,
  target: SceneTarget | undefined,
  color: GPUTexture | undefined,
  depth: GPUTexture | undefined,
  current: Variant = {},
  legacy: typeof import('../packages/materials/dist/index.js') | undefined,
  stencilBuffer: StencilBuffer | undefined,
  renderingFormat: GPUTextureFormat | undefined,
  restoredFormat: GPUTextureFormat | undefined,
  firstFormat = 0,
  lastContext: Extract<PassContext, { backend: 'webgpu' }> | undefined;
const drawView = new Float32Array(16);
function observe() {
  const device = engine.gpu!;
  if (observed !== device) {
    observed = device;
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const texture = device.createTexture.bind(device),
      sampler = device.createSampler.bind(device),
      buffer = device.createBuffer.bind(device),
      group = device.createBindGroup.bind(device),
      pipeline = device.createRenderPipeline.bind(device),
      encoder = device.createCommandEncoder.bind(device);
    device.createTexture = (d) => {
      allocations.textures++;
      createdFormats.push(d.format);
      return texture(d);
    };
    device.createSampler = (d) => {
      allocations.samplers++;
      return sampler(d);
    };
    device.createBuffer = (d) => {
      allocations.buffers++;
      return buffer(d);
    };
    device.createBindGroup = (d) => {
      allocations.groups++;
      return group(d);
    };
    device.createRenderPipeline = (d) => {
      allocations.pipelines++;
      descriptors.push({ depthStencil: d.depthStencil, writeMask: d.fragment?.targets[0]?.writeMask });
      return pipeline(d);
    };
    device.createCommandEncoder = (d) => {
      const value = encoder(d),
        begin = value.beginRenderPass.bind(value);
      value.beginRenderPass = (options) => {
        const pass = begin(options),
          set = pass.setStencilReference.bind(pass);
        pass.setStencilReference = (reference) => {
          references.push(reference);
          return set(reference);
        };
        return pass;
      };
      return value;
    };
  }
  return device;
}
function releaseTarget() {
  target?.dispose();
  color?.destroy();
  depth?.destroy();
  target = undefined;
  targetDevice = undefined;
  color = depth = undefined;
}
observe();
engine.frameGraph.add({
  name: 'render-state:raw',
  order: -120,
  execute(c) {
    if (c.backend !== 'webgpu') return;
    lastContext = c;
    sampleCount = c.descriptor.multisample?.count ?? 1;
    const format = current.noStencil ? 'depth32float' : c.descriptor.depthStencil!.format;
    if (!target || targetDevice !== c.device || depth?.format !== format) {
      releaseTarget();
      color = c.device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      depth = c.device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      target = new SceneTarget(c.device, color, depth, sampleCount);
      targetDevice = c.device;
    }
    target.begin(c);
  },
});
engine.frameGraph.add({
  name: 'render-state:observe-format',
  order: -90,
  execute(c) {
    if (c.backend === 'webgpu') renderingFormat = c.descriptor.depthStencil!.format;
  },
});
engine.frameGraph.add({
  name: 'render-state:stencil-clear',
  order: 0.5,
  execute(c) {
    if (current.clear !== undefined) c.draw({ clear: false, stencilClear: current.clear });
  },
});
engine.frameGraph.add({
  name: 'render-state:resolve',
  order: 20000,
  execute(c) {
    if (c.backend === 'webgpu') {
      target!.resolve(c.encoder);
      target!.restore(c);
    }
  },
});
engine.frameGraph.add({
  name: 'render-state:restored-format',
  order: 20001,
  execute(c) {
    if (c.backend === 'webgpu') restoredFormat = c.descriptor.depthStencil!.format;
  },
});
function quad(draw: Draw): MeshGeometry {
  const [left, right, bottom, top] = draw.bounds ?? [-1.8, 1.8, -1.3, 1.3],
    slope = draw.slope ?? 0;
  return {
    positions: [
      left,
      bottom,
      slope * left,
      right,
      bottom,
      slope * right,
      right,
      top,
      slope * right,
      left,
      top,
      slope * left,
    ],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: draw.reverse ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3],
  };
}
function staticMirrors(draw: Draw): PBRModel {
  const geometry = quad({ bounds: [-0.65, 0.65, -1.1, 1.1] }),
    data = [
      new Float32Array(geometry.positions),
      new Float32Array(geometry.normals),
      new Uint16Array(geometry.indices!),
    ],
    model = parseGLTF(
      engine,
      {
        asset: { version: '2.0' },
        buffers: data.map((value) => ({ byteLength: value.byteLength })),
        bufferViews: data.map((value, index) => ({ buffer: index, byteLength: value.byteLength })),
        accessors: data.map((value, index) => ({
          bufferView: index,
          componentType: index === 2 ? 5123 : 5126,
          count: value.length / (index === 2 ? 1 : 3),
          type: index === 2 ? 'SCALAR' : 'VEC3',
        })),
        nodes: [
          { mesh: 0, translation: [-1, 0, 0] },
          { mesh: 0, translation: [1, 0, 0], scale: [-1, 1, 1] },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
        materials: [{ doubleSided: true }],
      },
      data,
    );
  if (draw.state) model.primitives[0].material.renderState = draw.state;
  // The materials queue already exists. Run this native glTF mask before its reader.
  engine.frameGraph.removeOwner(model.name);
  engine.frameGraph.withOwner(model.name, () =>
    engine.frameGraph.add({
      name: model.name,
      order: 0.75,
      execute(context) {
        if (context.backend === 'webgpu') model.draw(context, 'beauty', context.color, context.depth);
      },
    }),
  );
  return model;
}
const alpha = new Texture(
  { data: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]), width: 2, height: 1 },
  { minFilter: 'nearest', magFilter: 'nearest', mipmaps: false },
);
function clear() {
  for (const model of models.splice(0)) model.dispose();
  materials.length = 0;
  stencilBuffer?.dispose();
  stencilBuffer = undefined;
}
async function frame() {
  const device = observe();
  device.pushErrorScope('validation');
  try {
    engine.render({ culling: false });
    await device.queue.onSubmittedWorkDone();
    if (current.forward) {
      const encoder = device.createCommandEncoder(),
        context = {
          ...lastContext!,
          encoder,
          color: target!.color,
          depth: target!.depth,
          format: 'rgba8unorm' as const,
          descriptor: {
            ...lastContext!.descriptor,
            depthStencil: {
              ...lastContext!.descriptor.depthStencil!,
              format: depth!.format,
              depthCompare: 'less-equal' as const,
            },
            multisample: { count: sampleCount },
          },
        },
        replicas = models.map((model) => model.createRenderer(device));
      try {
        for (const replica of replicas) replica.prepare(context);
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target!.color, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          depthStencilAttachment: {
            view: target!.depth,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
            depthClearValue: 1,
            ...(depth!.format.includes('stencil')
              ? {
                  stencilLoadOp: 'clear' as const,
                  stencilStoreOp: 'store' as const,
                  stencilClearValue: current.clear ?? 0,
                }
              : {}),
          },
        });
        for (const replica of replicas) replica.draw(context, pass, viewMatrix(drawView, engine.camera));
        pass.end();
        target!.resolve(encoder);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
      } finally {
        replicas.forEach((replica) => replica.dispose());
      }
    }
  } finally {
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}
function state() {
  return {
    sampleCount,
    stencilFeature: engine.gpu!.features.has('depth32float-stencil8'),
    format: depth?.format,
    renderingFormat,
    restoredFormat,
    promotedTextures: createdFormats.slice(firstFormat).filter((format) => format === 'depth24plus-stencil8').length,
    descriptors,
    references,
    properties: materials.map((m) => ({
      colorWrite: m.colorWrite,
      polygonOffset: m.polygonOffset,
      polygonOffsetFactor: m.polygonOffsetFactor,
      polygonOffsetUnits: m.polygonOffsetUnits,
      polygonOffsetClamp: m.polygonOffsetClamp,
      stencilWrite: m.stencilWrite,
      stencilFunc: m.stencilFunc,
      stencilRef: m.stencilRef,
      stencilReadMask: m.stencilReadMask,
      stencilWriteMask: m.stencilWriteMask,
      stencilFail: m.stencilFail,
      stencilZFail: m.stencilZFail,
      stencilZPass: m.stencilZPass,
    })),
  };
}
function differences(before: typeof allocations) {
  return Object.fromEntries(
    Object.entries(allocations).map(([k, v]) => [k, v - before[k as keyof typeof allocations]]),
  );
}
const renderStateFixture = {
  errors,
  async render(draws: Draw[], variant: Variant = {}) {
    clear();
    current = variant;
    engine.camera.project = (out) => {
      out[0] = 0.5;
      out[5] = 2 / 3;
      out[10] = current.forward ? -1 / 20 : 1 / 20;
      out[14] = current.forward ? -1 / 20 : 21 / 20;
      out[15] = 1;
    };
    firstFormat = createdFormats.length;
    if (variant.stencilBuffer) stencilBuffer = StencilBuffer.attach(engine);
    engine.camera.position = variant.back ? [0, 0, -5] : [0, 0, 5];
    if (variant.legacy && !legacy) {
      engine.removePlugin('materials:0');
      const path = '/test-results/pre-render-state-materials-dist/index.js';
      legacy = await import(/* @vite-ignore */ path);
    }
    const Constructor = variant.legacy ? legacy!.Material : Material,
      mesh = variant.legacy ? legacy!.createMesh : createMesh;
    const make = (draw: Draw) =>
      new Constructor({
        shading: draw.options?.transmission === undefined ? 'basic' : 'standard',
        color: [1, 0, 0],
        ...draw.options,
        ...(draw.alphaMask ? { map: alpha, alphaTest: 0.5 } : {}),
      });
    if (variant.combined) {
      const geometry: MeshGeometry = { positions: [], normals: [], indices: [], groups: [] },
        positions: number[] = [],
        normals: number[] = [],
        indices: number[] = [],
        groups: { start: number; count: number; materialIndex: number }[] = [];
      for (const [i, draw] of draws.entries()) {
        const g = quad(draw);
        for (let vertex = 0; vertex < g.positions.length; vertex += 3)
          positions.push(
            g.positions[vertex] * (draw.mirror ? -1 : 1) + (draw.x ?? 0),
            g.positions[vertex + 1],
            g.positions[vertex + 2] + (draw.z ?? 0),
          );
        normals.push(...Array.from(g.normals));
        indices.push(...Array.from(g.indices!, (v) => v + i * 4));
        groups.push({ start: i * 6, count: 6, materialIndex: i });
        materials.push(make(draw));
      }
      geometry.positions = positions;
      geometry.normals = normals;
      geometry.indices = indices;
      geometry.groups = groups;
      const model = mesh(engine, geometry, materials);
      models.push(model);
      for (const [i, draw] of draws.entries()) if (draw.state) model.primitives[i].material.renderState = draw.state;
    } else
      for (const draw of draws) {
        if (draw.staticMirrors) {
          models.push(staticMirrors(draw));
          continue;
        }
        const material = make(draw),
          instanced = draw.instances
            ? createInstancedMesh(
                engine,
                quad({ ...draw, bounds: draw.bounds ?? [-0.65, 0.65, -1.1, 1.1] }),
                material,
                2,
              )
            : undefined,
          model = instanced ?? mesh(engine, quad(draw), material);
        materials.push(material);
        models.push(model);
        model.root.setPosition([draw.x ?? 0, 0, draw.z ?? 0]);
        if (instanced)
          for (const [i, x] of [-1, 1].entries())
            instanced.instances.setMatrixAt(i, [i ? -1 : 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
        if (draw.mirror) model.root.setScale([-1, 1, 1]);
        if (draw.state) model.primitives[0].material.renderState = draw.state;
      }
    await frame();
    return state();
  },
  async liveNative(index: number, value: PBRRenderState) {
    const controlBefore = { ...allocations };
    await frame();
    const controlAllocations = differences(controlBefore);
    const primitive = current.combined ? models[0].primitives[index] : models[index].primitives[0];
    primitive.material.renderState = value;
    const before = { ...allocations };
    await frame();
    return { ...state(), allocations: differences(before), controlAllocations };
  },
  async restore() {
    const before = engine.gpu;
    await engine.rebootDevice();
    await frame();
    return { ...state(), changedDevice: before !== engine.gpu };
  },
  async digest() {
    const device = observe(),
      buffer = device.createBuffer({
        size: width * height * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: color! }, { buffer, bytesPerRow: width * 4 }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const hash = await crypto.subtle.digest('SHA-256', buffer.getMappedRange().slice(0));
      return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  },
  async read(points: [number, number][]) {
    const device = observe(),
      buffer = device.createBuffer({
        size: points.length * 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    try {
      const encoder = device.createCommandEncoder();
      for (const [i, point] of points.entries())
        encoder.copyTextureToBuffer(
          { texture: color!, origin: point },
          { buffer, offset: i * 256, bytesPerRow: 256 },
          [1, 1],
        );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(buffer.getMappedRange());
      return points.map((point, i) => ({ point, rgba: Array.from(bytes.slice(i * 256, i * 256 + 4)) }));
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  },
  dispose() {
    clear();
    alpha.dispose();
    releaseTarget();
    engine.dispose();
  },
};
Object.assign(window, { renderStateFixture });
