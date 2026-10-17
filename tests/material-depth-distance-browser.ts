// Built imports exercise the published package boundary and the real GPU shader.
import { Engine } from '../packages/core/dist/extension.js';
import { Material, Texture, createMesh, createInstancedMesh } from '../packages/materials/dist/index.js';
import type { MaterialOptions, MaterialMesh, MeshGeometry } from '../packages/materials/dist/index.js';
import { NodeMaterial, positionLocal, vec3 } from '../packages/shader/dist/index.js';
import { SceneTarget } from '../packages/shared/msaa.js';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare global {
  var margoLow: number | undefined;
}

type Variant = {
  projection?: 'perspective' | 'orthographic';
  camera?: { position: [number, number, number]; target: [number, number, number] };
  z?: number;
  geometry?: 'plane' | 'groups' | 'instances' | 'mirror' | 'transformed' | 'shared';
  secondary?: MaterialOptions;
  mapped?: 'uv0' | 'uv1' | 'uv1-transform';
  auxiliary?: boolean;
  node?: boolean;
  nodePosition?: number;
  legacy?: boolean;
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
  models: MaterialMesh<Material | readonly Material[]>[] = [],
  allocations = { textures: 0, samplers: 0, buffers: 0, groups: 0 },
  entries: string[] = [],
  writes = new WeakMap<GPUBuffer, number[]>(),
  dataBuffers = new Set<GPUBuffer>();
engine.stop();
engine.onError = (error) => errors.push(String(error));
let observed: GPUDevice | undefined,
  targetDevice: GPUDevice | undefined,
  target: SceneTarget | undefined,
  color: GPUTexture | undefined,
  depth: GPUTexture | undefined,
  aux: GPUTexture[] = [],
  sampleCount = 0,
  auxiliary = false,
  current: Material | undefined,
  legacy: typeof import('../packages/materials/dist/index.js') | undefined;
function observe() {
  const device = engine.gpu!;
  if (observed !== device) {
    observed = device;
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const texture = device.createTexture.bind(device),
      sampler = device.createSampler.bind(device),
      buffer = device.createBuffer.bind(device),
      group = device.createBindGroup.bind(device);
    device.createTexture = (descriptor) => {
      allocations.textures++;
      return texture(descriptor);
    };
    device.createSampler = (descriptor) => {
      allocations.samplers++;
      return sampler(descriptor);
    };
    device.createBuffer = (descriptor) => {
      allocations.buffers++;
      return buffer(descriptor);
    };
    device.createBindGroup = (descriptor) => {
      allocations.groups++;
      for (const entry of descriptor.entries)
        if (entry.binding === 196 && 'buffer' in entry.resource) dataBuffers.add(entry.resource.buffer);
      return group(descriptor);
    };
    const pipeline = device.createRenderPipeline.bind(device),
      write = device.queue.writeBuffer.bind(device.queue);
    device.createRenderPipeline = (descriptor) => {
      if (descriptor.fragment) entries.push(descriptor.fragment.entryPoint ?? 'fragment');
      return pipeline(descriptor);
    };
    device.queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
      if (ArrayBuffer.isView(data) && data.byteLength === 32)
        writes.set(buffer, Array.from(new Float32Array(data.buffer, data.byteOffset, 8)));
      return write(buffer, offset, data, dataOffset, size);
    };
  }
  return device;
}
observe();
function releaseTarget() {
  target?.dispose();
  color?.destroy();
  depth?.destroy();
  aux.forEach((texture) => texture.destroy());
  target = undefined;
  targetDevice = undefined;
  color = depth = undefined;
  aux = [];
}
engine.frameGraph.add({
  name: 'depth-distance:raw-capture',
  order: -100,
  execute(c) {
    if (c.backend !== 'webgpu') return;
    sampleCount = c.descriptor.multisample?.count ?? 1;
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
      aux = [0, 1].map(() =>
        c.device.createTexture({
          size: [width, height],
          format: 'rgba16float',
          sampleCount,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        }),
      );
    }
    target.begin(c);
  },
});
engine.frameGraph.add({
  name: 'depth-distance:auxiliary',
  order: 2,
  execute(c) {
    if (c.backend !== 'webgpu' || !auxiliary) return;
    for (const [index, mode] of ['gbuffer', 'ambient'].entries()) {
      const view = aux[index].createView();
      c.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] }).end();
      for (const model of models) model.draw(c, mode as 'gbuffer' | 'ambient', view, c.depth);
    }
  },
});
engine.frameGraph.add({
  name: 'depth-distance:resolve',
  order: 100,
  execute(c) {
    if (c.backend === 'webgpu') {
      target!.resolve(c.encoder);
      target!.restore(c);
    }
  },
});
const alphaMap = new Texture(
  { data: new Uint8Array([180, 70, 220, 0, 35, 240, 50, 255]), width: 2, height: 1 },
  { minFilter: 'nearest', magFilter: 'nearest', mipmaps: false, wrapS: 'clamp', wrapT: 'clamp' },
);
function quad(left = -8, right = 8, z = 0, bottom = -8, top = 8): MeshGeometry {
  return {
    positions: [left, bottom, z, right, bottom, z, right, top, z, left, top, z],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0.25, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 0.5],
    uvs1: [0.75, 0.5, 0.75, 0.5, 0.75, 0.5, 0.75, 0.5],
    indices: [0, 1, 2, 0, 2, 3],
  };
}
function grouped(size = 40): MeshGeometry {
  const a = quad(-size, 0, 0, -size, size),
    b = quad(0, size, 0, -size, size);
  return {
    positions: [...Array.from(a.positions), ...Array.from(b.positions)],
    normals: [...Array.from(a.normals), ...Array.from(b.normals)],
    uvs: [...Array.from(a.uvs!), ...Array.from(b.uvs!)],
    uvs1: [...Array.from(a.uvs1!), ...Array.from(b.uvs1!)],
    indices: [...Array.from(a.indices!), ...Array.from(b.indices!, (value) => value + 4)],
    groups: [
      { start: 0, count: 6, materialIndex: 0 },
      { start: 6, count: 6, materialIndex: 1 },
    ],
  };
}
function clear() {
  for (const model of models.splice(0)) model.dispose();
}
function add<T extends MaterialMesh<Material | readonly Material[]>>(model: T): T {
  models.push(model);
  return model;
}
function differences(before: typeof allocations) {
  return Object.fromEntries(
    Object.entries(allocations).map(([key, value]) => [key, value - before[key as keyof typeof before]]),
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
    primitives: models.map((model) => model.primitives.length),
    entries: [...new Set(entries)],
    uniforms: [...dataBuffers].flatMap((buffer) => (writes.has(buffer) ? [writes.get(buffer)] : [])),
    properties: current
      ? {
          shading: current.shading,
          depthPacking: current.depthPacking,
          referencePosition: current.referencePosition,
          nearDistance: current.nearDistance,
          farDistance: current.farDistance,
        }
      : {},
  };
}
const depthDistanceFixture = {
  errors,
  async render(options: MaterialOptions = {}, variant: Variant = {}) {
    clear();
    auxiliary = !!variant.auxiliary;
    engine.camera.position = variant.camera?.position ?? [0, 0, 5];
    engine.camera.target = variant.camera?.target ?? [0, 0, 0];
    engine.camera.project =
      variant.projection === 'orthographic'
        ? (out) => {
            out[0] = 0.25;
            out[5] = 1 / 3;
            out[10] = 1 / 20;
            out[14] = 21 / 20;
            out[15] = 1;
          }
        : undefined;
    engine.lighting.direction.set([0.6, 0.3, 1, 2]);
    engine.lighting.radiance[3] = 0.4;
    let sharedInstances = true;
    if (!variant.empty) {
      if (variant.legacy && !legacy) {
        // The before/after module copies each start their private queue serial at zero.
        // Remove the now-empty first queue before registering the legacy copy on this test engine.
        engine.removePlugin('materials:0');
        const path = '/test-results/pre-depth-materials-dist/index.js';
        legacy = await import(/* @vite-ignore */ path);
      }
      const Constructor = variant.legacy ? legacy!.Material : variant.node ? NodeMaterial : Material,
        mesh = variant.legacy ? legacy!.createMesh : createMesh,
        make = (value: MaterialOptions) => {
          const material = new Constructor({
            ...value,
            ...(variant.mapped ? { map: alphaMap } : {}),
            ...(variant.node ? { colorNode: vec3(0.9, 0.1, 0.6) } : {}),
            ...(variant.nodePosition === undefined
              ? {}
              : { positionNode: positionLocal.add(vec3(0, 0, variant.nodePosition)) }),
          });
          if (variant.mapped)
            material.setUVTransform(
              {
                texCoord: variant.mapped === 'uv0' ? 0 : 1,
                ...(variant.mapped === 'uv1-transform' ? { offset: [-0.5, 0] } : {}),
              },
              'map',
            );
          return material;
        };
      current = make(options);
      const z = variant.z ?? 0;
      if (variant.geometry === 'groups' || variant.geometry === 'instances') {
        const materials = [current!, make({ ...options, ...variant.secondary })];
        if (variant.geometry === 'instances') {
          const model = add(createInstancedMesh(engine, grouped(0.65), materials, 2));
          for (const [index, x] of [-1.4, 1.4].entries())
            model.instances.setMatrixAt(index, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, -index, 1]);
          model.root.setPosition([0, 0, z]);
          sharedInstances = model.primitives.every((primitive) => primitive.instances === model.instances);
        } else add(mesh(engine, grouped(), materials)).root.setPosition([0, 0, z]);
      } else if (variant.geometry === 'shared') {
        add(mesh(engine, quad(-4, -0.1), current!)).root.setPosition([0, 0, z]);
        add(mesh(engine, quad(0.1, 4), current!)).root.setPosition([0, 0, z - 1]);
      } else {
        const model = add(mesh(engine, z < -10 ? quad(-40, 40, 0, -40, 40) : quad(), current!));
        if (variant.geometry === 'transformed')
          model.root.setPosition([1, -2, z]).setRotation([0, 0.3, 0]).setScale([1.4, 0.8, 1.2]);
        else {
          model.root.setPosition([0, 0, z]);
          if (variant.geometry === 'mirror') model.root.setScale([-1, 1, 1]);
        }
      }
    }
    await frame();
    return { ...state(), sharedInstances };
  },
  async live(options: MaterialOptions) {
    const controlBefore = { ...allocations };
    await frame();
    const controlAllocations = differences(controlBefore);
    Object.assign(current!, options);
    const before = { ...allocations };
    await frame();
    return { ...state(), allocations: differences(before), controlAllocations };
  },
  async restore() {
    const old = engine.gpu;
    await engine.rebootDevice();
    await frame();
    return { ...state(), changedDevice: engine.gpu !== old };
  },
  async read(points: [number, number][]) {
    const device = observe(),
      readback = device.createBuffer({
        size: points.length * 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    try {
      const encoder = device.createCommandEncoder();
      for (const [index, point] of points.entries())
        encoder.copyTextureToBuffer(
          { texture: color!, origin: point },
          { buffer: readback, offset: index * 256, bytesPerRow: 256 },
          [1, 1],
        );
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(readback.getMappedRange());
      return points.map((point, index) => ({ point, rgba: Array.from(bytes.slice(index * 256, index * 256 + 4)) }));
    } finally {
      readback.unmap();
      readback.destroy();
    }
  },
  async digest() {
    const device = observe(),
      readback = device.createBuffer({
        size: width * height * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: color! }, { buffer: readback, bytesPerRow: width * 4 }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const hash = await crypto.subtle.digest('SHA-256', readback.getMappedRange().slice(0));
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } finally {
      readback.unmap();
      readback.destroy();
    }
  },
  dispose() {
    clear();
    alphaMap.dispose();
    releaseTarget();
    engine.dispose();
  },
};
Object.assign(window, { depthDistanceFixture });
