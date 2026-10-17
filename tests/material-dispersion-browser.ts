// Built imports exercise the published package boundary as well as the real GPU shader.
import { Engine } from '../packages/core/dist/extension.js';
import { Material, Texture, createMesh, createInstancedMesh, install } from '../packages/materials/dist/index.js';
import type { MaterialOptions, MeshGeometry } from '../packages/materials/dist/index.js';
import { Transmission, transmission as callerTransmission } from '../packages/materials/dist/transmission.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import type { PBRModel, GLTFImage } from '../packages/gltf-pro/dist/index.js';
import { extendedMaterials } from '../packages/gltf-pro/dist/extended.js';
import { PostStack } from '../packages/post/dist/index.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare global {
  var margoLow: number | undefined;
}

type Options = MaterialOptions;
type Variant = {
  path?: 'native' | 'install' | 'caller' | 'fallback';
  maps?: 'uv0' | 'uv1' | 'transform' | 'scalar0' | 'scalar1';
  mapSlots?: 'transmission' | 'both';
  geometry?: 'quad' | 'groups' | 'instances' | 'mirror';
  loaded?: boolean;
  lit?: boolean;
  secondary?: Options;
};
globalThis.margoLow = new URLSearchParams(location.search).get('samples') === '1' ? 1 : undefined;
const canvas = document.querySelector('canvas')!,
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } }),
  errors: string[] = [],
  models: PBRModel[] = [];
engine.stop();
engine.camera.project = (out) => {
  out[0] = 0.5;
  out[5] = 2 / 3;
  out[10] = 1 / 99.9;
  out[14] = 100 / 99.9;
  out[15] = 1;
};
engine.lighting.direction.set([0.6, 0.3, 1, 0]);
engine.lighting.radiance[3] = 0;
engine.onError = (error) => errors.push(String(error));
let sampleCount = 0;
engine.frameGraph.add({
  name: 'dispersion:sample-count',
  order: -100,
  execute(c) {
    if (c.backend === 'webgpu') sampleCount = c.descriptor.multisample?.count ?? 1;
  },
});
const allocations = { textures: 0, samplers: 0, buffers: 0, groups: 0 },
  bindings: number[][] = [];
let observed: GPUDevice | undefined;
function observe() {
  const device = engine.gpu!;
  if (device !== observed) {
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
      bindings.push(Array.from(descriptor.entries, (entry) => entry.binding));
      return group(descriptor);
    };
  }
  return device;
}
observe();
function quad(left = -1.5, right = 1.5, bottom = -1, top = 1, tilted = true): MeshGeometry {
  const n = tilted ? [0.55, 0.12, Math.sqrt(1 - 0.55 ** 2 - 0.12 ** 2)] : [0, 0, 1];
  return {
    positions: [left, bottom, 0, right, bottom, 0, right, top, 0, left, top, 0],
    normals: [...n, ...n, ...n, ...n],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    uvs1: [0.75, 0.5, 0.75, 0.5, 0.75, 0.5, 0.75, 0.5],
    tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}
const patternBytes = new Uint8Array(256 * 128 * 4);
for (let y = 0; y < 128; y++)
  for (let x = 0; x < 256; x++) {
    const i = (y * 256 + x) * 4;
    // Different spatial frequencies and phases prevent a tinted sample from faking RGB refraction.
    patternBytes[i] = Math.round(100 + 70 * Math.sin(x * 0.19 + y * 0.037));
    patternBytes[i + 1] = Math.round(110 + 65 * Math.sin(x * 0.137 - y * 0.071 + 1));
    patternBytes[i + 2] = Math.round(105 + 75 * Math.sin(x * 0.221 + y * 0.093 + 2));
    patternBytes[i + 3] = 255;
  }
const pattern = new Texture(
  { data: patternBytes, width: 256, height: 128 },
  { minFilter: 'linear', magFilter: 'linear', mipmaps: false, wrapS: 'clamp', wrapT: 'clamp' },
);
const mapBytes = new Uint8Array([80, 64, 0, 255, 210, 204, 255, 255]),
  factorMap = new Texture(
    { data: mapBytes, width: 2, height: 1 },
    { minFilter: 'nearest', magFilter: 'nearest', mipmaps: false, wrapS: 'clamp', wrapT: 'clamp' },
  );
let stack: PostStack | undefined,
  transmission: Transmission | undefined,
  installation: ReturnType<typeof install> | undefined,
  callerSnapshot: GPUTexture | undefined,
  live: Material | undefined;
function clear() {
  installation?.dispose();
  installation = undefined;
  for (const model of models.splice(0)) model.dispose();
  if (transmission) engine.removePlugin(transmission.name);
  if (stack) engine.removePlugin(stack.name);
  stack = undefined;
  transmission = undefined;
  callerSnapshot?.destroy();
  callerSnapshot = undefined;
}
function add<T extends PBRModel>(model: T): T {
  models.push(model);
  return model;
}
function background() {
  add(
    createMesh(engine, quad(-2, 2, -1.5, 1.5, false), new Material({ shading: 'basic', map: pattern })),
  ).root.setPosition([0, 0, -1]);
}
async function frame() {
  const device = observe();
  device.pushErrorScope('validation');
  try {
    engine.render();
    await device.queue.onSubmittedWorkDone();
  } finally {
    const error = await device.popErrorScope();
    if (error) throw new Error(error.message);
  }
  if (errors.length) throw new Error(errors.join('\n'));
}
const base: Options = {
  color: [1, 1, 1],
  metalness: 0,
  roughness: 0,
  specularIntensity: 0,
  transmission: 1,
  thickness: 2.5,
  ior: 1.5,
};
function mappedOptions(options: Options, variant: Variant): Options {
  const result = { ...base, ...options };
  if (variant.maps === 'scalar0' || variant.maps === 'scalar1') {
    const offset = variant.maps === 'scalar0' ? 0 : 4;
    result.transmission = (result.transmission! * mapBytes[offset]) / 255;
    if (variant.mapSlots !== 'transmission') result.thickness = (result.thickness! * mapBytes[offset + 1]) / 255;
  }
  return result;
}
function frontGeometry(left = -1.5, right = 1.5, bottom = -1, top = 1): MeshGeometry {
  const g = quad(left, right, bottom, top);
  g.uvs = [0.25, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 0.5];
  return g;
}
function split(small: boolean): MeshGeometry {
  const a = frontGeometry(small ? -0.5 : -1.5, 0, small ? -0.5 : -1, small ? 0.5 : 1),
    b = frontGeometry(0, small ? 0.5 : 1.5, small ? -0.5 : -1, small ? 0.5 : 1);
  return {
    positions: [...Array.from(a.positions), ...Array.from(b.positions)],
    normals: [...Array.from(a.normals), ...Array.from(b.normals)],
    tangents: [...Array.from(a.tangents!), ...Array.from(b.tangents!)],
    uvs: [...Array.from(a.uvs!), ...Array.from(b.uvs!)],
    uvs1: [...Array.from(a.uvs1!), ...Array.from(b.uvs1!)],
    indices: [...Array.from(a.indices!), ...Array.from(b.indices!, (i) => i + 4)],
    groups: [
      { start: 0, count: 6, materialIndex: 1 },
      { start: 6, count: 6, materialIndex: 0 },
    ],
  };
}
function material(options: Options, variant: Variant) {
  const result = new Material(mappedOptions(options, variant));
  if (variant.maps && !variant.maps.startsWith('scalar')) {
    result.transmissionMap = factorMap;
    if (variant.mapSlots !== 'transmission') result.thicknessMap = factorMap;
    for (const slot of ['transmissionMap', 'thicknessMap'] as const)
      result.setUVTransform(
        variant.maps === 'transform'
          ? { texCoord: 1, offset: [-0.5, 0] }
          : { texCoord: variant.maps === 'uv0' ? 0 : 1 },
        slot,
      );
  }
  return result;
}
function loadedModel(options: Options, variant: Variant): PBRModel {
  const o = mappedOptions(options, variant),
    g = frontGeometry(),
    buffers: ArrayBufferView[] = [],
    bufferViews: { buffer: number; byteLength: number }[] = [],
    accessors: { bufferView: number; componentType: number; count: number; type: string }[] = [];
  function accessor(data: Float32Array | Uint16Array, type: string, size: number) {
    const index = buffers.length;
    buffers.push(data);
    bufferViews.push({ buffer: index, byteLength: data.byteLength });
    accessors.push({
      bufferView: index,
      componentType: data instanceof Uint16Array ? 5123 : 5126,
      count: data.length / size,
      type,
    });
    return index;
  }
  const attributes = {
      POSITION: accessor(new Float32Array(g.positions), 'VEC3', 3),
      NORMAL: accessor(new Float32Array(g.normals), 'VEC3', 3),
      TANGENT: accessor(new Float32Array(g.tangents!), 'VEC4', 4),
      TEXCOORD_0: accessor(new Float32Array(g.uvs!), 'VEC2', 2),
      TEXCOORD_1: accessor(new Float32Array(g.uvs1!), 'VEC2', 2),
    },
    indices = accessor(new Uint16Array(g.indices!), 'SCALAR', 1),
    mapped = !!variant.maps && !variant.maps.startsWith('scalar'),
    info = mapped
      ? {
          index: 0,
          texCoord: variant.maps === 'uv0' ? 0 : 1,
          ...(variant.maps === 'transform' ? { extensions: { KHR_texture_transform: { offset: [-0.5, 0] } } } : {}),
        }
      : undefined,
    extensions = {
      KHR_materials_transmission: {
        transmissionFactor: o.transmission,
        ...(info ? { transmissionTexture: info } : {}),
      },
      KHR_materials_ior: { ior: o.ior },
      KHR_materials_volume: {
        thicknessFactor: o.thickness,
        attenuationColor: o.attenuationColor ?? [1, 1, 1],
        ...(o.attenuationDistance === undefined ? {} : { attenuationDistance: o.attenuationDistance }),
        ...(info && variant.mapSlots !== 'transmission' ? { thicknessTexture: info } : {}),
      },
      KHR_materials_specular: { specularFactor: o.specularIntensity },
      ...(o.dispersion === undefined ? {} : { KHR_materials_dispersion: { dispersion: o.dispersion } }),
      ...(o.iridescence === undefined
        ? {}
        : {
            KHR_materials_iridescence: {
              iridescenceFactor: o.iridescence,
              iridescenceIor: o.iridescenceIOR,
              iridescenceThicknessMinimum: o.iridescenceThicknessRange?.[0],
              iridescenceThicknessMaximum: o.iridescenceThicknessRange?.[1],
            },
          }),
      ...(o.anisotropy === undefined
        ? {}
        : { KHR_materials_anisotropy: { anisotropyStrength: o.anisotropy, anisotropyRotation: o.anisotropyRotation } }),
    },
    doc = {
      asset: { version: '2.0' },
      buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
      bufferViews,
      accessors,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes, indices, material: 0 }] }],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [...(o.color as number[]), 1],
            metallicFactor: o.metalness,
            roughnessFactor: o.roughness,
          },
          extensions,
        },
      ],
      ...(mapped
        ? {
            textures: [{ source: 0, sampler: 0 }],
            samplers: [{ minFilter: 9728, magFilter: 9728, wrapS: 33071, wrapT: 33071 }],
            images: [{}],
          }
        : {}),
    },
    images: GLTFImage[] = mapped
      ? [{ width: 2, height: 1, format: 'rgba8unorm', mipmaps: [{ width: 2, height: 1, data: mapBytes }] }]
      : [];
  return parseGLTF(engine, doc, buffers, images, { materials: extendedMaterials });
}
const identity = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
const dispersionFixture = {
  errors,
  async render(options: Options = {}, variant: Variant = {}) {
    clear();
    engine.lighting.direction[3] = variant.lit ? 1.7 : 0;
    engine.lighting.radiance[3] = variant.lit ? 0.08 : 0;
    const before = { ...allocations },
      firstBinding = bindings.length;
    background();
    let model: PBRModel,
      sharedInstances = true;
    if (variant.loaded || variant.path === 'install' || variant.path === 'caller')
      model = add(loadedModel(options, variant));
    else if (variant.geometry === 'groups' || variant.geometry === 'instances') {
      const materials = [material(options, variant), material({ ...options, ...variant.secondary }, variant)];
      if (variant.geometry === 'instances') {
        const instanced = add(createInstancedMesh(engine, split(true), materials, 2));
        instanced.instances.setMatrixAt(0, identity(-0.65));
        instanced.instances.setMatrixAt(1, identity(0.65));
        sharedInstances = instanced.primitives.every((p) => p.instances === instanced.instances);
        model = instanced;
      } else model = add(createMesh(engine, split(false), materials));
    } else {
      live = material(options, variant);
      model = add(createMesh(engine, frontGeometry(), live));
      if (variant.geometry === 'mirror') model.root.setScale([-1, 1, 1]);
    }
    stack = PostStack.attach(engine, [new Tonemap({ curve: 'neutral' })]);
    if (variant.path === 'install') installation = install(model);
    else if (variant.path === 'caller') {
      model.root.visible = false;
      await frame();
      const device = observe();
      callerSnapshot = device.createTexture({
        size: [320, 240],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture: stack.sceneTexture! }, { texture: callerSnapshot }, [320, 240]);
      device.queue.submit([encoder.finish()]);
      const o = mappedOptions(options, variant);
      model.primitives[0].material.extension = {
        ...callerTransmission({
          factor: o.transmission,
          ior: o.ior,
          dispersion: o.dispersion,
          opaqueColor: callerSnapshot.createView(),
          volume: {
            thicknessFactor: o.thickness,
            attenuationColor: o.attenuationColor as [number, number, number] | undefined,
            attenuationDistance: o.attenuationDistance,
          },
        }),
        replacesPhysical: true,
      };
      model.primitives[0].material.settings[0] = 2;
      model.root.visible = true;
    } else if (variant.path !== 'fallback') {
      transmission = Transmission.attach(engine);
      transmission.add(model);
    }
    await frame();
    return {
      allocations: Object.fromEntries(
        Object.entries(allocations).map(([key, value]) => [key, value - before[key as keyof typeof before]]),
      ),
      bindings: bindings
        .slice(firstBinding)
        .map((entries) => entries.join(','))
        .sort(),
      primitives: model.primitives.length,
      sharedInstances,
      sampleCount,
    };
  },
  async live(value: number) {
    live!.dispersion = value;
    const before = { ...allocations },
      firstBinding = bindings.length;
    await frame();
    return {
      allocations: Object.fromEntries(
        Object.entries(allocations).map(([key, count]) => [key, count - before[key as keyof typeof before]]),
      ),
      newBindings: bindings.length - firstBinding,
    };
  },
  async restore() {
    const old = engine.gpu;
    await engine.rebootDevice();
    await frame();
    return { changedDevice: old !== engine.gpu };
  },
  async read() {
    const device = observe(),
      source = stack!.sceneTexture!,
      buffer = device.createBuffer({ size: 320 * 240 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow: 320 * 8 }, [320, 240]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const words = new Uint16Array(buffer.getMappedRange()),
        result: number[] = [];
      const half = (word: number) => {
        const exponent = (word >> 10) & 31,
          mantissa = word & 1023,
          value = exponent ? 2 ** (exponent - 15) * (1 + mantissa / 1024) : (2 ** -14 * mantissa) / 1024;
        return word & 32768 ? -value : value;
      };
      for (let y = 70; y < 170; y++)
        for (let x = 80; x < 240; x++) for (let c = 0; c < 3; c++) result.push(half(words[(y * 320 + x) * 4 + c]));
      return result;
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  },
  dispose() {
    clear();
    pattern.dispose();
    factorMap.dispose();
    engine.dispose();
  },
};
Object.assign(window, { dispersionFixture });
