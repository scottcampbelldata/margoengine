import { Engine } from '../packages/core/dist/extension.js';
import { Material, Texture, createMesh, createInstancedMesh } from '../packages/materials/dist/index.js';
import type { MaterialOptions, MeshGeometry } from '../packages/materials/dist/index.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import type { PBRModel } from '../packages/gltf-pro/dist/index.js';
import { SceneTarget } from '../packages/shared/msaa.js';

declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number; VERTEX: number; STORAGE: number; INDEX: number };
declare const GPUMapMode: { READ: number };
declare global {
  var margoLow: number | undefined;
}

type Options = {
  native?: boolean;
  reference?: boolean;
  deduplicated?: boolean;
  wireframe?: boolean;
  nonindexed?: boolean;
  instances?: boolean;
  mirror?: boolean;
  groups?: boolean;
  deformation?: boolean;
  map?: 'color' | 'alpha';
  material?: MaterialOptions;
};

globalThis.margoLow = new URLSearchParams(location.search).get('samples') === '1' ? 1 : undefined;
const width = 320,
  height = 240,
  engine = await Engine.create(document.querySelector('canvas')!, {
    backend: 'webgpu',
    camera: { position: [0, 0, 5], target: [0, 0, 0], near: 1, far: 21 },
  }),
  device = engine.gpu!,
  errors: string[] = [],
  allocations = { textures: 0, samplers: 0, buffers: 0, groups: 0, pipelines: 0 },
  topologies: (GPUPrimitiveTopology | undefined)[] = [],
  models: PBRModel[] = [],
  deformed: GPUBuffer[] = [],
  capturedTextures: GPUTexture[] = [],
  shadowCleanup: (() => void)[] = [],
  textures = {
    color: new Texture(
      { data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1 },
      { minFilter: 'nearest', magFilter: 'nearest', mipmaps: false },
    ),
    alpha: new Texture(
      { data: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]), width: 2, height: 1 },
      { minFilter: 'nearest', magFilter: 'nearest', mipmaps: false },
    ),
  };
engine.stop();
engine.camera.project = (out) => {
  out[0] = 0.5;
  out[5] = 2 / 3;
  out[10] = 1 / 20;
  out[14] = 21 / 20;
  out[15] = 1;
};
engine.onError = (error) => errors.push(String(error));
device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
for (const [method, field] of [
  ['createTexture', 'textures'],
  ['createSampler', 'samplers'],
  ['createBuffer', 'buffers'],
  ['createBindGroup', 'groups'],
  ['createRenderPipeline', 'pipelines'],
] as const) {
  const create = device[method].bind(device);
  Object.assign(device, {
    [method]: (descriptor: never) => {
      allocations[field]++;
      if (method === 'createRenderPipeline')
        topologies.push((descriptor as GPURenderPipelineDescriptor).primitive?.topology);
      if (method === 'createTexture') {
        const texture = descriptor as GPUTextureDescriptor,
          size = texture.size as number[];
        // Read actual shadow attachments without changing their format or raster state.
        if (Array.isArray(size) && size[0] === 64 && size[1] === 64) {
          const result = create({ ...texture, usage: texture.usage | GPUTextureUsage.COPY_SRC } as never) as GPUTexture;
          capturedTextures.push(result);
          return result;
        }
      }
      return create(descriptor);
    },
  });
}
let sampleCount = 0,
  target: SceneTarget | undefined,
  color: GPUTexture | undefined,
  depth: GPUTexture | undefined;
engine.frameGraph.add({
  name: 'wireframe:raw',
  order: -120,
  execute(context) {
    if (context.backend !== 'webgpu') return;
    sampleCount = context.descriptor.multisample?.count ?? 1;
    if (!target) {
      color = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      depth = device.createTexture({
        size: [width, height],
        format: context.descriptor.depthStencil!.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      target = new SceneTarget(device, color, depth, sampleCount);
    }
    target.begin(context);
  },
});
engine.frameGraph.add({
  name: 'wireframe:resolve',
  order: 20000,
  execute(context) {
    if (context.backend !== 'webgpu') return;
    target!.resolve(context.encoder);
    target!.restore(context);
  },
});

// Explicit expected edges of [0,1,2], [0,2,3]. The shared diagonal occurs twice.
// This reference never calls the wireframe implementation or geometry.wireframe.
const triangles = [0, 1, 2, 0, 2, 3],
  edges = [0, 1, 1, 2, 2, 0, 0, 2, 2, 3, 3, 0],
  uniqueEdges = [0, 1, 1, 2, 2, 3, 3, 0, 0, 2, 0, 0],
  sequentialEdges = [0, 1, 1, 2, 2, 0, 3, 4, 4, 5, 5, 3];
function geometry(options: Options): MeshGeometry {
  const small = options.instances,
    x = small ? 0.65 : 1.5,
    y = small ? 0.9 : 1,
    positions = [-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0],
    normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  if (options.nonindexed)
    return {
      positions: triangles.flatMap((index) => positions.slice(index * 3, index * 3 + 3)),
      normals: triangles.flatMap((index) => normals.slice(index * 3, index * 3 + 3)),
      uvs: triangles.flatMap((index) => uvs.slice(index * 2, index * 2 + 2)),
      ...(options.reference ? { indices: sequentialEdges } : {}),
    };
  const indices = options.reference ? (options.deduplicated ? uniqueEdges : edges) : triangles;
  return {
    positions,
    normals,
    uvs,
    indices,
    ...(options.groups
      ? {
          groups: [
            { start: 0, count: options.reference ? 6 : 3, materialIndex: 0 },
            { start: options.reference ? 6 : 3, count: options.reference ? 6 : 3, materialIndex: 1 },
          ],
        }
      : {}),
  };
}
function native(options: Options) {
  const g = geometry(options),
    arrays = [
      new Float32Array(g.positions),
      new Float32Array(g.normals),
      new Float32Array(g.uvs!),
      new Uint16Array(g.indices!),
    ],
    model = parseGLTF(
      engine,
      {
        asset: { version: '2.0' },
        extensionsUsed: ['KHR_materials_unlit'],
        buffers: arrays.map((array) => ({ byteLength: array.byteLength })),
        bufferViews: arrays.map((array, buffer) => ({ buffer, byteLength: array.byteLength })),
        accessors: arrays.map((array, index) => ({
          bufferView: index,
          componentType: index === 3 ? 5123 : 5126,
          count: array.length / (index === 3 ? 1 : index === 2 ? 2 : 3),
          type: index === 3 ? 'SCALAR' : index === 2 ? 'VEC2' : 'VEC3',
        })),
        nodes: [{ mesh: 0 }],
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
                indices: 3,
                material: 0,
                mode: options.reference ? 1 : 4,
              },
            ],
          },
        ],
        materials: [
          {
            pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] },
            doubleSided: true,
            extensions: { KHR_materials_unlit: {} },
          },
        ],
      },
      arrays,
    );
  if (!options.reference) model.primitives[0].material.wireframe = options.wireframe ?? true;
  return model;
}
function clear() {
  for (const cleanup of shadowCleanup.splice(0).reverse()) cleanup();
  for (const model of models.splice(0)) model.dispose();
  for (const buffer of deformed.splice(0)) buffer.destroy();
}
async function frame() {
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
    properties: models.flatMap((model) => model.primitives.map((primitive) => primitive.material.wireframe ?? false)),
    indices: models.flatMap((model) => model.primitives.map((primitive) => Array.from(primitive.indices))),
    pickingCounts: models.flatMap((model) => model.pickingPrimitives.map((primitive) => primitive.count)),
    topologies: [...topologies],
  };
}
const wireframeFixture = {
  errors,
  async render(options: Options = {}) {
    clear();
    topologies.length = 0;
    const m = (color: [number, number, number]) =>
        new Material({
          shading: options.material?.transmission === undefined ? 'basic' : 'standard',
          color,
          side: 'double',
          ...options.material,
          wireframe: options.reference ? false : (options.wireframe ?? true),
          ...(options.map
            ? { map: textures[options.map], ...(options.map === 'alpha' ? { alphaTest: 0.5 } : {}) }
            : {}),
        }),
      material = options.groups ? [m([1, 0, 0]), m([0, 1, 0])] : m(options.map === 'color' ? [1, 1, 1] : [1, 0, 0]),
      model = options.native
        ? native(options)
        : options.instances
          ? createInstancedMesh(engine, geometry(options), material, 2)
          : createMesh(engine, geometry(options), material);
    models.push(model);
    if (options.reference && !options.native)
      for (const primitive of model.primitives) primitive.topology = 'line-list';
    if (options.instances && 'instances' in model)
      for (const [i, x] of [-1, 1].entries())
        model.instances.setMatrixAt(i, [i ? -1 : 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
    if (options.mirror) model.root.setScale([-1, 1, 1]);
    if (options.deformation)
      for (const primitive of model.primitives) {
        const vertices = primitive.vertices.slice();
        for (let offset = 0; offset < vertices.length; offset += 20) vertices[offset + 1] += vertices[offset] * 0.15;
        const buffer = device.createBuffer({
          size: vertices.byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
        });
        device.queue.writeBuffer(buffer, 0, vertices);
        primitive.deformed = buffer;
        deformed.push(buffer);
      }
    await frame();
    return state();
  },
  async toggle(value: boolean) {
    await frame();
    const before = { ...allocations };
    for (const model of models) for (const primitive of model.primitives) primitive.material.wireframe = value;
    await frame();
    return {
      ...state(),
      allocations: Object.fromEntries(
        Object.entries(allocations).map(([key, count]) => [key, count - before[key as keyof typeof allocations]]),
      ),
    };
  },
  async shadows(kind: 'directional' | 'local' | 'integrated' | 'contact', options: Options = {}) {
    await wireframeFixture.render(options);
    const model = models[0],
      firstTexture = capturedTextures.length,
      sourceIndices: GPUBuffer[] = [],
      explicit = {
        shadowPrimitives: model.shadowPrimitives.map((primitive, index) => {
          const indices = Uint32Array.from(options.groups ? (index === 0 ? edges.slice(0, 6) : edges.slice(6)) : edges),
            buffer = device.createBuffer({
              size: indices.byteLength,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.INDEX,
            });
          device.queue.writeBuffer(buffer, 0, indices);
          sourceIndices.push(buffer);
          return { ...primitive, primitive: {}, index: buffer, count: indices.length, topology: 'line-list' as const };
        }),
      };
    model.root.setRotation([-Math.PI / 2, 0, 0]).setPosition([0, 0.5, 0]);
    engine.lighting.direction.set([0, -1, 0]);
    let add: (source: typeof model | typeof explicit) => () => void, stats: () => object;
    if (kind === 'directional') {
      const { Shadows } = await import('../packages/shadows/dist/index.js'),
        effect = Shadows.attach(engine, {
          resolution: 64,
          bounds: { min: [-2, -1, -2], max: [2, 2, 2] },
          bias: 0,
          normalBias: 0,
        });
      add = (source) => effect.add(source);
      stats = () => ({ ...effect.stats });
      shadowCleanup.push(() => engine.removePlugin(effect.name));
    } else if (kind === 'contact') {
      const { ContactShadows } = await import('../packages/staging/dist/index.js'),
        effect = ContactShadows.attach(engine, {
          static: true,
          resolution: 64,
          position: [0, 0, 0],
          size: 4,
          height: 2,
          blur: 0,
          opacity: 0,
        });
      add = (source) => effect.add(source);
      stats = () => ({ ...effect.stats });
      shadowCleanup.push(() => engine.removePlugin(effect.name));
    } else {
      const { Clustered } = await import('../packages/clustered/dist/index.js'),
        lights = Clustered.attach(engine, {
          grid: [1, 1, 1],
          ...(kind === 'integrated' ? { shadows: { resolution: 64, maxLights: 1 } } : {}),
        });
      lights.setLights([
        {
          position: [0, 3, 0],
          range: 6,
          direction: [0, -1, 0],
          outerAngle: 0.8,
          castShadow: true,
          ...(kind === 'integrated' ? { shadow: { bias: 0, normalBias: 0 } } : {}),
        },
      ]);
      shadowCleanup.push(() => engine.removePlugin(lights.name));
      if (kind === 'local') {
        const { LocalShadows } = await import('../packages/clustered/dist/shadows.js'),
          effect = LocalShadows.attach(engine, { lights, resolution: 64, maxLights: 1, bias: 0, normalBias: 0 });
        add = (source) => effect.add(source);
        stats = () => ({ ...effect.stats });
        shadowCleanup.push(() => engine.removePlugin(effect.name));
      } else {
        add = (source) => lights.addShadowCaster(source);
        stats = () => ({});
      }
    }
    let remove = add(model);
    const read = async () => {
      await frame();
      const textures = capturedTextures
          .slice(firstTexture)
          .filter((texture) => texture.format === (kind === 'contact' ? 'r16float' : 'depth32float')),
        texture = kind === 'contact' ? textures[0] : textures.at(-1)!,
        buffer = device.createBuffer({ size: 64 * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture, ...(kind === 'contact' ? {} : { aspect: 'depth-only' as const }) },
          { buffer, bytesPerRow: 256 },
          [64, 64],
        );
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const rowBytes = kind === 'contact' ? 128 : 256,
          bytes = new Uint8Array(64 * rowBytes),
          mapped = new Uint8Array(buffer.getMappedRange());
        for (let y = 0; y < 64; y++) bytes.set(mapped.subarray(y * 256, y * 256 + rowBytes), y * rowBytes);
        const digest = await crypto.subtle.digest('SHA-256', bytes),
          values = kind === 'contact' ? new Uint16Array(bytes.buffer) : new Float32Array(bytes.buffer),
          clear = kind === 'contact' || kind === 'local' ? 0 : 1;
        return {
          hash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
          pixels: Array.from(values).filter((value) => value !== clear).length,
          stats: stats(),
        };
      } finally {
        buffer.unmap();
        buffer.destroy();
      }
    };
    try {
      const actual = await read();
      remove();
      remove = add(explicit);
      const reference = await read();
      remove();
      remove = add(model);
      const restored = await read();
      if (!options.native) return { actual, reference, restored };
      model.primitives[0].material.wireframe = false;
      const off = await read();
      model.primitives[0].material.wireframe = true;
      const on = await read();
      return { actual, reference, restored, off, on };
    } finally {
      remove();
      for (const buffer of sourceIndices) buffer.destroy();
      for (const cleanup of shadowCleanup.splice(0).reverse()) cleanup();
    }
  },
  async read() {
    const buffer = device.createBuffer({
      size: width * height * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: color! }, { buffer, bytesPerRow: width * 4 }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(buffer.getMappedRange().slice(0)),
        digest = await crypto.subtle.digest('SHA-256', bytes),
        hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
        pixels = (left: number, top: number, right: number, bottom: number) => {
          let count = 0,
            max = 0,
            sum = 0;
          for (let y = top; y < bottom; y++)
            for (let x = left; x < right; x++) {
              const offset = (y * width + x) * 4,
                value = Math.max(...[0, 1, 2].map((channel) => Math.abs(bytes[offset + channel] - bytes[channel])));
              if (value) count++;
              max = Math.max(max, value);
              sum += value;
            }
          return { count, max, sum };
        },
        canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0);
      return {
        hash,
        background: Array.from(bytes.slice(0, 4)),
        whole: pixels(0, 0, width, height),
        interior: pixels(70, 70, 100, 95),
        diagonal: pixels(145, 110, 175, 130),
        edge: pixels(90, 38, 130, 42),
        row: pixels(35, 70, 45, 71),
        png: canvas.toDataURL('image/png').split(',')[1],
      };
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  },
  dispose() {
    clear();
    for (const texture of Object.values(textures)) texture.dispose();
    target?.dispose();
    color?.destroy();
    depth?.destroy();
    engine.dispose();
  },
};
Object.assign(window, { wireframeFixture });
