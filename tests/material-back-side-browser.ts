// Real published boundaries, physical GPU rasterization, and readback of the raw attachment.
import { Engine } from '../packages/core/dist/extension.js';
import {
  Material,
  Texture,
  createMesh,
  createInstancedMesh,
  clearcoat,
  nodeMaterial,
} from '../packages/materials/dist/index.js';
import type { MaterialOptions, MeshGeometry } from '../packages/materials/dist/index.js';
import { NodeMaterial, vec3 } from '../packages/shader/dist/index.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import type { PBRModel } from '../packages/gltf-pro/dist/index.js';
import { Picking } from '../packages/selection/dist/index.js';
import { Raycaster } from '../packages/bvh/dist/index.js';
import { Transmission } from '../packages/materials/dist/transmission.js';
import { OIT } from '../packages/oit/dist/index.js';
import { PostStack } from '../packages/post/dist/index.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';
import { SceneTarget } from '../packages/shared/msaa.js';
import { viewMatrix } from '../packages/shared/view.js';

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
type Variant = {
  camera?: 'front' | 'back';
  mirror?: boolean;
  geometry?: 'quad' | 'mirror' | 'instances' | 'groups' | 'lines' | 'points';
  secondary?: MaterialOptions;
  node?: boolean;
  mapped?: boolean;
  physical?: boolean;
  auxiliary?: boolean;
  capture?: boolean;
  occlusion?: boolean;
  extension?: 'coat' | 'graph-normal';
  loaded?: boolean;
  legacy?: boolean;
  hdr?: boolean;
  transmission?: boolean;
  fallback?: boolean;
  oit?: boolean;
  empty?: boolean;
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
  allocations = { textures: 0, samplers: 0, buffers: 0, groups: 0, pipelines: 0 },
  entries: string[] = [];
engine.stop();
engine.camera.project = (out) => {
  out[0] = 0.5;
  out[5] = 2 / 3;
  out[10] = 1 / 20;
  out[14] = 21 / 20;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
Picking.attach(engine, { capture: false });
let observed: GPUDevice | undefined,
  targetDevice: GPUDevice | undefined,
  target: SceneTarget | undefined,
  color: GPUTexture | undefined,
  depth: GPUTexture | undefined,
  auxiliary: GPUTexture[] = [],
  auxiliaryResolved: GPUTexture[] = [],
  sampleCount = 0,
  variant: Variant = {},
  current: Material | undefined,
  currentModel: PBRModel | undefined,
  stack: PostStack | undefined,
  transmission: Transmission | undefined,
  oit: OIT | undefined,
  legacy: typeof import('../packages/materials/dist/index.js') | undefined;
let extensionTexture: GPUTexture | undefined, capturePass: GPURenderPassEncoder | undefined;
const drawView = new Float32Array(16);
function observe() {
  const device = engine.gpu!;
  if (observed !== device) {
    observed = device;
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const texture = device.createTexture.bind(device),
      sampler = device.createSampler.bind(device),
      buffer = device.createBuffer.bind(device),
      group = device.createBindGroup.bind(device),
      pipeline = device.createRenderPipeline.bind(device);
    device.createTexture = (d) => {
      allocations.textures++;
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
      if (d.fragment) entries.push(d.fragment.entryPoint ?? 'fragment');
      return pipeline(d);
    };
  }
  return device;
}
observe();
function releaseTarget() {
  target?.dispose();
  color?.destroy();
  depth?.destroy();
  auxiliary.forEach((t) => t.destroy());
  auxiliaryResolved.forEach((t) => t.destroy());
  target = undefined;
  targetDevice = undefined;
  color = depth = undefined;
  auxiliary = [];
  auxiliaryResolved = [];
}
engine.frameGraph.add({
  name: 'back-side:raw',
  order: -100,
  execute(c) {
    if (c.backend !== 'webgpu') return;
    sampleCount = c.descriptor.multisample?.count ?? 1;
    if (variant.hdr) return;
    if (!target || targetDevice !== c.device) {
      releaseTarget();
      color = c.device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      depth = c.device.createTexture({
        size: [width, height],
        format: c.descriptor.depthStencil!.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      target = new SceneTarget(c.device, color, depth, sampleCount);
      targetDevice = c.device;
      auxiliary = [0, 1, 2, 3, 4].map(() =>
        c.device.createTexture({
          size: [width, height],
          format: 'rgba16float',
          sampleCount,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        }),
      );
      auxiliaryResolved = [0, 1, 2, 3, 4].map(() =>
        c.device.createTexture({
          size: [width, height],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        }),
      );
    }
    target.begin(c);
  },
});
engine.frameGraph.add({
  name: 'back-side:auxiliary',
  order: 2,
  execute(c) {
    if (c.backend !== 'webgpu' || !variant.auxiliary) return;
    for (const [index, mode] of (variant.capture
      ? ['gbuffer', 'ambient', 'capture']
      : ['gbuffer', 'ambient']
    ).entries()) {
      const view = auxiliary[index].createView();
      c.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] }).end();
      if (mode === 'capture')
        capturePass = c.encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true },
        });
      for (const model of models) model.draw(c, mode as 'gbuffer' | 'ambient' | 'capture', view, c.depth);
      capturePass?.end();
      capturePass = undefined;
      if (sampleCount === 4)
        c.encoder
          .beginRenderPass({
            colorAttachments: [
              { view, resolveTarget: auxiliaryResolved[index].createView(), loadOp: 'load', storeOp: 'store' },
            ],
          })
          .end();
    }
    if (variant.occlusion) {
      const views = [3, 4].map((i) => auxiliary[i].createView()),
        pass = c.encoder.beginRenderPass({
          colorAttachments: views.map((view) => ({ view, loadOp: 'clear', storeOp: 'store' })),
          depthStencilAttachment: { view: c.depth, depthLoadOp: 'load', depthStoreOp: 'store', stencilReadOnly: true },
        });
      for (const model of models)
        model.draw(c, 'occlusion', views[0], c.depth, 'all', {
          pass,
          view: viewMatrix(drawView, c.camera),
          depthCompare: 'equal',
        });
      pass.end();
      if (sampleCount === 4)
        c.encoder
          .beginRenderPass({
            colorAttachments: views.map((view, i) => ({
              view,
              resolveTarget: auxiliaryResolved[i + 3].createView(),
              loadOp: 'load',
              storeOp: 'store',
            })),
          })
          .end();
    }
  },
});
engine.frameGraph.add({
  name: 'back-side:resolve',
  order: 100,
  execute(c) {
    if (c.backend === 'webgpu' && !variant.hdr) {
      target!.resolve(c.encoder);
      target!.restore(c);
    }
  },
});
const map = new Texture({ data: new Uint8Array([220, 90, 40, 255]), width: 1, height: 1 }, { mipmaps: false }),
  normal = new Texture({ data: new Uint8Array([180, 210, 230, 255]), width: 1, height: 1 }, { mipmaps: false }),
  scalar = new Texture({ data: new Uint8Array([180, 160, 220, 255]), width: 1, height: 1 }, { mipmaps: false });
function quad(left = -1.8, right = 1.8, bottom = -1.3, top = 1.3): MeshGeometry {
  return {
    positions: [left, bottom, 0, right, bottom, 0, right, top, 0, left, top, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}
function grouped(): MeshGeometry {
  const a = quad(-1.8, 0),
    b = quad(0, 1.8);
  return {
    positions: [...Array.from(a.positions), ...Array.from(b.positions)],
    normals: [...Array.from(a.normals), ...Array.from(b.normals)],
    uvs: [...Array.from(a.uvs!), ...Array.from(b.uvs!)],
    indices: [...Array.from(a.indices!), ...Array.from(b.indices!, (v) => v + 4)],
    groups: [
      { start: 0, count: 6, materialIndex: 0 },
      { start: 6, count: 6, materialIndex: 1 },
    ],
  };
}
function loaded(options: MaterialOptions): PBRModel {
  const g = quad(),
    indices =
      variant.geometry === 'lines'
        ? [0, 1, 1, 2, 2, 3, 3, 0]
        : variant.geometry === 'points'
          ? [0, 1, 2, 3]
          : g.indices!,
    data = [
      new Float32Array(g.positions),
      new Float32Array(g.normals),
      new Float32Array(g.uvs!),
      new Uint16Array(indices),
    ],
    doc = {
      asset: { version: '2.0' },
      buffers: data.map((v) => ({ byteLength: v.byteLength })),
      bufferViews: data.map((v, i) => ({ buffer: i, byteLength: v.byteLength })),
      accessors: data.map((v, i) => ({
        bufferView: i,
        componentType: i === 3 ? 5123 : 5126,
        count: v.length / [3, 3, 2, 1][i],
        type: ['VEC3', 'VEC3', 'VEC2', 'SCALAR'][i],
      })),
      nodes: [{ mesh: 0 }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
              indices: 3,
              material: 0,
              ...(variant.geometry === 'lines' ? { mode: 1 } : variant.geometry === 'points' ? { mode: 0 } : {}),
            },
          ],
        },
      ],
      materials: [
        {
          doubleSided: options.doubleSided,
          pbrMetallicRoughness: { baseColorFactor: [0.8, 0.3, 0.1, 1], metallicFactor: 0, roughnessFactor: 1 },
        },
      ],
    },
    model = parseGLTF(engine, doc, data, []);
  if (options.side !== undefined) (model.primitives[0] ?? model.pointsAndLines[0]).material.side = options.side;
  return model;
}
function clear() {
  for (const model of models.splice(0)) model.dispose();
  extensionTexture?.destroy();
  extensionTexture = undefined;
  if (transmission) engine.removePlugin(transmission.name);
  if (oit) engine.removePlugin(oit.name);
  if (stack) engine.removePlugin(stack.name);
  transmission = undefined;
  oit = undefined;
  stack = undefined;
  current = undefined;
  currentModel = undefined;
}
function add<T extends PBRModel>(model: T): T {
  models.push(model);
  return model;
}
function differences(before: typeof allocations) {
  return Object.fromEntries(
    Object.entries(allocations).map(([k, v]) => [k, v - before[k as keyof typeof allocations]]),
  );
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
function state() {
  return {
    sampleCount,
    properties: current
      ? { side: current.side, doubleSided: current.doubleSided }
      : currentModel
        ? {
            side: (currentModel.primitives[0] ?? currentModel.pointsAndLines[0]).material.side,
            doubleSided: (currentModel.primitives[0] ?? currentModel.pointsAndLines[0]).material.settings[2] === 1,
          }
        : {},
    metadata: currentModel?.pickingPrimitives.map((p) => ({ side: p.side, doubleSided: p.doubleSided })),
    entries: [...new Set(entries)],
  };
}
function half(word: number) {
  const e = (word >> 10) & 31,
    m = word & 1023,
    v = e ? 2 ** (e - 15) * (1 + m / 1024) : (2 ** -14 * m) / 1024;
  return word & 32768 ? -v : v;
}
const backSideFixture = {
  errors,
  async render(options: MaterialOptions = {}, value: Variant = {}) {
    clear();
    variant = value;
    engine.camera.position = variant.camera === 'back' ? [0, 0, -5] : [0, 0, 5];
    engine.lighting.direction.set([0.6, 0.3, variant.camera === 'back' ? -1 : 1, 2]);
    engine.lighting.radiance[3] = 0.3;
    if (variant.legacy && !legacy) {
      engine.removePlugin('materials:0');
      const path = '/test-results/pre-side-materials-dist/index.js';
      legacy = await import(/* @vite-ignore */ path);
    }
    const Constructor = variant.legacy ? legacy!.Material : variant.node ? NodeMaterial : Material,
      mesh = variant.legacy ? legacy!.createMesh : createMesh,
      make = (o: MaterialOptions) =>
        new Constructor({
          ...o,
          ...(variant.node ? { colorNode: vec3(0.8, 0.2, 0.4) } : {}),
          ...(variant.mapped ? { map, normalMap: normal } : {}),
          ...(variant.physical
            ? {
                clearcoat: 0.7,
                clearcoatMap: scalar,
                clearcoatNormalMap: normal,
                sheenColor: [0.1, 0.3, 0.8],
                sheenColorMap: map,
                anisotropy: 0.4,
                anisotropyMap: normal,
                iridescence: 0.3,
              }
            : {}),
        });
    if (!variant.empty) {
      if (variant.loaded || variant.geometry === 'lines' || variant.geometry === 'points')
        currentModel = add(loaded(options));
      else {
        current = make(options);
        if (variant.geometry === 'instances') {
          const model = add(createInstancedMesh(engine, quad(-0.65, 0.65, -0.9, 0.9), current, 2));
          for (const [index, x] of [-1, 1].entries())
            model.instances.setMatrixAt(index, [index ? -1 : 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
          currentModel = model;
        } else if (variant.geometry === 'groups')
          currentModel = add(mesh(engine, grouped(), [current, make({ ...options, ...variant.secondary })]));
        else {
          const g = quad();
          currentModel = add(mesh(engine, g, current));
          if (variant.geometry === 'mirror') currentModel.root.setScale([-1, 1, 1]);
        }
      }
      if (variant.mirror) currentModel!.root.setScale([-1, 1, 1]);
      if (variant.extension) {
        const device = observe();
        extensionTexture = device.createTexture({
          size: [1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture: extensionTexture },
          new Uint8Array([180, 210, 230, 255]),
          { bytesPerRow: 4 },
          [1, 1],
        );
        const texture = { view: extensionTexture.createView() },
          extension =
            variant.extension === 'coat'
              ? clearcoat({ factor: 0.7, roughnessFactor: 0.3, clearcoatNormalTexture: texture })
              : nodeMaterial({
                  nodes: [
                    {
                      type: 'emit',
                      color: { type: 'color', value: [0.7, 0.3, 0.2, 1] },
                      normal: { type: 'normalMap', texture: { type: 'texture', texture } },
                    },
                  ],
                });
        for (const primitive of currentModel!.primitives) primitive.material.extension = extension;
      }
      if (variant.capture)
        currentModel!.setCapture({
          targets: [{ format: 'rgba16float' }],
          declarations: () =>
            'struct MargoCapture {@location(0) color:vec4f}\nfn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {return MargoCapture(vec4f(s.n*0.5+0.5,1));}\n',
          begin: () => capturePass!,
        });
    }
    if (variant.hdr) stack = PostStack.attach(engine, [new Tonemap({ curve: 'neutral' })]);
    if (variant.transmission || variant.fallback) {
      add(
        createMesh(engine, quad(), new Material({ shading: 'basic', color: [0.15, 0.6, 0.25], doubleSided: true })),
      ).root.setPosition([0, 0, variant.camera === 'back' ? 1 : -1]);
      if (variant.transmission) {
        transmission = Transmission.attach(engine);
        transmission.add(currentModel!);
      }
    }
    if (variant.oit) {
      oit = OIT.attach(engine);
      oit.add(currentModel!);
    }
    await frame();
    return state();
  },
  async live(options: MaterialOptions) {
    const controlBefore = { ...allocations };
    await frame();
    const controlAllocations = differences(controlBefore);
    Object.assign(current ?? currentModel!.primitives[0].material, options);
    const before = { ...allocations };
    await frame();
    return { ...state(), allocations: differences(before), controlAllocations };
  },
  async picks(points: [number, number][], explicit = false) {
    const gpu = [],
      cpu = [],
      snapshot = [];
    const remove = explicit ? Picking.forEngine(engine)!.add(currentModel!) : undefined;
    for (const [x, y] of points) {
      const hit = await engine.pick(x, y),
        worldX = (((x + 0.5) / width) * 2 - 1) * 2 * (variant.camera === 'back' ? -1 : 1),
        worldY = (1 - ((y + 0.5) / height) * 2) * 1.5,
        ray = new Raycaster(
          [worldX, worldY, variant.camera === 'back' ? -5 : 5],
          [0, 0, variant.camera === 'back' ? 1 : -1],
        );
      gpu.push(!!hit);
      cpu.push(ray.intersectObjects(engine, [currentModel!]).length > 0);
      // The existing async deformation snapshot has one node matrix and does not expand instances.
      if (variant.geometry !== 'instances') snapshot.push((await ray.intersectModel(currentModel!)).length > 0);
    }
    remove?.();
    return { gpu, cpu, snapshot };
  },
  async readAuxiliary(point: [number, number] = [160, 120]) {
    const device = observe(),
      count = variant.occlusion ? 5 : variant.capture ? 3 : 2,
      buffer = device.createBuffer({ size: count * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      for (const [i, source] of (sampleCount === 4 ? auxiliaryResolved : auxiliary).slice(0, count).entries())
        encoder.copyTextureToBuffer(
          { texture: source, origin: point },
          { buffer, offset: i * 256, bytesPerRow: 256 },
          [1, 1],
        );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const words = new Uint16Array(buffer.getMappedRange());
      return Array.from({ length: count }, (_, i) => Array.from(words.slice(i * 128, i * 128 + 4), half));
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  },
  async restore() {
    const old = engine.gpu;
    await engine.rebootDevice();
    await frame();
    return { ...state(), changedDevice: engine.gpu !== old };
  },
  async visible(value: boolean) {
    currentModel!.root.visible = value;
    await frame();
    return state();
  },
  async read(points: [number, number][]) {
    const device = observe(),
      source = stack?.sceneTexture ?? color!,
      hdr = !!stack,
      buffer = device.createBuffer({
        size: points.length * 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    try {
      const encoder = device.createCommandEncoder();
      for (const [i, point] of points.entries())
        encoder.copyTextureToBuffer(
          { texture: source, origin: point },
          { buffer, offset: i * 256, bytesPerRow: 256 },
          [1, 1],
        );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const range = buffer.getMappedRange(),
        bytes = new Uint8Array(range),
        words = new Uint16Array(range);
      return points.map((point, i) => ({
        point,
        rgba: hdr ? Array.from(words.slice(i * 128, i * 128 + 4), half) : Array.from(bytes.slice(i * 256, i * 256 + 4)),
      }));
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  },
  async digest() {
    const device = observe(),
      source = stack?.sceneTexture ?? color!,
      stride = stack ? width * 8 : width * 4,
      buffer = device.createBuffer({ size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow: stride }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const hash = await crypto.subtle.digest('SHA-256', buffer.getMappedRange().slice(0));
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  },
  dispose() {
    clear();
    map.dispose();
    normal.dispose();
    scalar.dispose();
    releaseTarget();
    engine.dispose();
  },
};
Object.assign(window, { backSideFixture });
