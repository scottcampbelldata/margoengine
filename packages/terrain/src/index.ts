/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import { margoError } from '../../shared/errors.js';
import { clipmapGrid } from './grid.js';
import { terrainVertex, terrainFragment } from './shader.js';
export { clipmapGrid } from './grid.js';
export { TerrainColors, type TerrainColorOptions } from './colors.js';
export { heightfieldGeometry, TerrainHeightmap, type HeightField, type HeightfieldOptions } from './heightfield.js';
declare const GPUBufferUsage: { UNIFORM: number; VERTEX: number; INDEX: number; STORAGE: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
export interface TerrainTextures {
  heightmap: GPUTexture;
  normalmap?: GPUTexture;
  layers: GPUTexture;
}
export interface TerrainLayer {
  height: readonly [number, number];
  slope: readonly [number, number];
  scale: number;
}
export interface TerrainOptions {
  textures: (device: GPUDevice) => TerrainTextures;
  layers: readonly TerrainLayer[];
  origin?: readonly [number, number];
  size: readonly [number, number];
  heightScale?: number;
  heightOffset?: number;
  cellSize?: number;
  resolution?: number;
  levels?: number;
  /** Surface roughness (GGX, 0-1), for the sun's highlight and screen-space reflections (`ssr.add(terrain)`). Default
   * 0.9; leaving it out keeps the shader as it was. */
  roughness?: number;
}
/** What `setCapture` takes: `@margoengine/post` SSR's material capture hook (its `SSRCapture`), declared here so terrain
 * does not import post. */
export interface TerrainCapture {
  /** Module-scope WGSL for the lit shader `code`: `struct MargoSSR` and `fn margoSSR(n,v,base,metal,rough)->MargoSSR`. */
  declarations(code: string): string;
  /** Colour targets of the capture pass, in `MargoSSR` location order. */
  readonly targets: readonly GPUColorTargetState[];
  /** This frame's capture pass: these targets and a depth attachment of the context's format; ended by the owner. */
  begin(): GPURenderPassEncoder;
}
export interface TerrainLighting {
  readonly owner?: Engine;
  shader(source: string, group: number): string;
  bindings(): GPUBindGroupEntry[];
}
interface Ring {
  uniform: GPUBuffer;
  group: GPUBindGroup;
  values: Float32Array;
  shadowUniforms: GPUBuffer[];
  shadowGroups: GPUBindGroup[];
  shadowValues: Float32Array;
}
interface LightingGroup {
  device: GPUDevice;
  entries: GPUBindGroupEntry[];
  group: GPUBindGroup;
}
let nextId = 0;
export class Terrain implements EnginePlugin {
  readonly name = 'terrain:' + nextId++;
  shadowVersion = 0;
  disposed = false;
  private engine?: Engine;
  private device?: GPUDevice;
  private textures?: TerrainTextures;
  private vertex?: GPUBuffer;
  private center?: GPUBuffer;
  private ring?: GPUBuffer;
  private rules?: GPUBuffer;
  private sampler?: GPUSampler;
  private layout?: GPUBindGroupLayout;
  private shadowPipeline?: GPURenderPipeline;
  private rings: Ring[] = [];
  private pipelines = new Map<string, GPURenderPipeline>();
  private lightingGroups = new Map<GPURenderPipeline, LightingGroup>();
  private lighting = new Set<TerrainLighting>();
  /** Bind-group entries for the current draw. Lighting providers may return fresh wrappers; the group cache compares them. */
  private readonly lightingEntries: GPUBindGroupEntry[] = [];
  private centerCount = 0;
  private ringCount = 0;
  private capture?: TerrainCapture;
  private captureCode = new Map<string, string>();
  private readonly disposers = new Set<() => void>();
  constructor(readonly options: TerrainOptions) {
    this.validate();
  }
  static attach(instance: EngineKernel, options: TerrainOptions): Terrain {
    const terrain = new Terrain(options);
    engineRuntime(instance).use(terrain);
    return terrain;
  }
  private validate(): void {
    const o = this.options;
    if (
      typeof o.textures !== 'function' ||
      !Number.isInteger(o.resolution ?? 64) ||
      (o.resolution ?? 64) < 8 ||
      (o.resolution ?? 64) > 256 ||
      (o.resolution ?? 64) % 4 ||
      !Number.isInteger(o.levels ?? 6) ||
      (o.levels ?? 6) < 1 ||
      (o.levels ?? 6) > 12 ||
      (o.roughness !== undefined && !(o.roughness >= 0 && o.roughness <= 1)) ||
      !Number.isFinite(Math.fround(o.cellSize ?? 1)) ||
      (o.cellSize ?? 1) <= 0 ||
      !Number.isFinite(Math.fround(o.heightScale ?? 100)) ||
      !Number.isFinite(Math.fround(o.heightOffset ?? 0)) ||
      !Array.isArray(o.layers) ||
      o.layers.length < 4 ||
      o.layers.length > 8
    )
      throw new RangeError('Invalid terrain options');
    finiteVector(o.origin ?? [0, 0], 2, 'Terrain origin');
    finiteVector(o.size, 2, 'Terrain size');
    if (o.size.some((v) => v <= 0)) throw new RangeError('Invalid terrain size');
    for (const layer of o.layers) {
      finiteVector(layer.height, 2, 'Layer height');
      finiteVector(layer.slope, 2, 'Layer slope');
      if (
        layer.height[0] >= layer.height[1] ||
        layer.slope[0] < 0 ||
        layer.slope[1] > 1 ||
        layer.slope[0] >= layer.slope[1] ||
        !Number.isFinite(Math.fround(layer.scale)) ||
        layer.scale <= 0
      )
        throw new RangeError('Invalid terrain layer');
    }
  }
  addLighting(effect: TerrainLighting): () => void {
    if (this.disposed || !effect || typeof effect.shader !== 'function' || typeof effect.bindings !== 'function')
      throw new TypeError('Invalid terrain lighting');
    if (effect.owner && this.engine && effect.owner !== this.engine)
      throw new Error('Terrain lighting belongs to another engine');
    this.lighting.add(effect);
    return () => this.lighting.delete(effect);
  }
  invalidate(): void {
    this.shadowVersion++;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('Terrain requires WebGPU and a live module');
    this.engine = engine;
    this.device = engine.gpu;
    this.textures = this.options.textures(this.device);
    const t = this.textures;
    for (const texture of [t.heightmap, t.layers, ...(t.normalmap ? [t.normalmap] : [])])
      if (texture.dimension !== '2d' || !(texture.usage & GPUTextureUsage.TEXTURE_BINDING) || texture.sampleCount !== 1)
        throw new TypeError('Terrain textures must be sampled 2D textures');
    if (
      t.heightmap.depthOrArrayLayers !== 1 ||
      (t.normalmap && t.normalmap.depthOrArrayLayers !== 1) ||
      t.layers.depthOrArrayLayers !== this.options.layers.length ||
      !['rgba8unorm', 'rgba8unorm-srgb', 'rgba16float'].includes(t.layers.format) ||
      !['r32float', 'rgba16float', 'rgba8unorm'].includes(t.heightmap.format) ||
      (t.normalmap && !['rgba8unorm', 'rgba16float'].includes(t.normalmap.format))
    )
      throw new TypeError('Invalid terrain texture format or layer count');
    const geometry = clipmapGrid(this.options.resolution ?? 64),
      upload = (data: Float32Array | Uint32Array, usage: number) => {
        if (data.byteLength > this.device!.limits.maxBufferSize)
          throw new RangeError('Terrain grid exceeds device limits');
        const buffer = this.device!.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
        try {
          this.device!.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
        } catch (error) {
          buffer.destroy();
          throw error;
        }
        return buffer;
      };
    this.vertex = upload(geometry.vertices, GPUBufferUsage.VERTEX);
    this.center = upload(geometry.center, GPUBufferUsage.INDEX);
    this.ring = upload(geometry.ring, GPUBufferUsage.INDEX);
    this.centerCount = geometry.center.length;
    this.ringCount = geometry.ring.length;
    const data = new Float32Array(this.options.layers.length * 8);
    this.options.layers.forEach((layer, i) =>
      data.set(
        [
          ...layer.height,
          ...layer.slope,
          layer.scale,
          Math.max(0.01, (layer.height[1] - layer.height[0]) * 0.05),
          0.05,
          0,
        ],
        i * 8,
      ),
    );
    this.rules = upload(data, GPUBufferUsage.STORAGE);
    this.sampler = this.device.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
    const vertex = GPUShaderStage.VERTEX,
      fragment = GPUShaderStage.FRAGMENT;
    this.layout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vertex | fragment, buffer: { type: 'uniform' } },
        { binding: 1, visibility: vertex, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: vertex, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: fragment, texture: { viewDimension: '2d-array' } },
        { binding: 4, visibility: fragment, sampler: { type: 'filtering' } },
        { binding: 5, visibility: fragment, buffer: { type: 'read-only-storage' } },
      ],
    });
    const resources = [
      t.heightmap.createView(),
      (t.normalmap ?? t.heightmap).createView(),
      t.layers.createView({ dimension: '2d-array' }),
      this.sampler,
      { buffer: this.rules },
    ];
    const group = (buffer: GPUBuffer) =>
      this.device!.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: { buffer } },
          ...resources.map((resource, i) => ({ binding: i + 1, resource })),
        ],
      });
    for (let i = 0; i < (this.options.levels ?? 6); i++) {
      const uniform = this.device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        shadowUniforms: GPUBuffer[] = [];
      const r: Ring = {
        uniform,
        group: undefined!,
        values: new Float32Array(44),
        shadowUniforms,
        shadowGroups: [],
        shadowValues: new Float32Array(44),
      };
      this.rings.push(r);
      r.group = group(uniform);
      for (let j = 0; j < 4; j++) {
        const buffer = this.device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        shadowUniforms.push(buffer);
        r.shadowGroups.push(group(buffer));
      }
    }
    const module = this.device.createShaderModule({ code: terrainVertex });
    this.shadowPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: {
        module,
        entryPoint: 'vertex',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    this.invalidate();
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':prepare',
      order: -6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.prepare(c);
      },
    });
    graph.add({
      name: this.name,
      order: 1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.drawRings(c);
      },
    });
  }
  private prepare(c: Context): void {
    const origin = this.options.origin,
      size = this.options.size,
      resolution = this.options.resolution ?? 64,
      heightScale = this.options.heightScale ?? 100,
      heightOffset = this.options.heightOffset ?? 0,
      layers = this.options.layers.length,
      cell = this.options.cellSize ?? 1,
      hdr = +(c.format === 'rgba16float'),
      normal = +!!this.textures!.normalmap;
    let previousX = 0,
      previousZ = 0,
      changed = false;
    for (let i = 0; i < this.rings.length; i++) {
      const values = this.rings[i].values,
        spacing = cell * 2 ** i,
        x = Math.floor(c.camera.position[0] / spacing) * spacing,
        z = Math.floor(c.camera.position[2] / spacing) * spacing;
      if (values[28] !== x || values[29] !== z) changed = true;
      values.set(c.camera.matrix);
      values.set(c.camera.position, 16);
      values.set(this.engine!.lighting.direction, 20);
      values.set(this.engine!.lighting.radiance, 24);
      values[28] = x;
      values[29] = z;
      values[30] = spacing;
      values[31] = resolution;
      values[32] = i ? previousX - x : 0;
      values[33] = i ? previousZ - z : 0;
      values[34] = i;
      values[35] = normal;
      values[36] = origin?.[0] ?? 0;
      values[37] = origin?.[1] ?? 0;
      values[38] = size[0];
      values[39] = size[1];
      values[40] = heightScale;
      values[41] = heightOffset;
      values[42] = layers;
      values[43] = hdr;
      c.device.queue.writeBuffer(this.rings[i].uniform, 0, values as Float32Array<ArrayBuffer>);
      previousX = x;
      previousZ = z;
    }
    if (changed) this.invalidate();
  }
  /** The lit shader: terrain's own (with `roughness`, when given) through every lighting effect. */
  private shader(): string {
    const r = this.options.roughness;
    let code =
      (r === undefined
        ? terrainVertex
        : terrainVertex.replace('o.material=vec4f(0.9,0,1,1)', `o.material=vec4f(${r},0,1,1)`)) + terrainFragment;
    for (const effect of this.lighting) code = effect.shader(code, 1);
    return code;
  }
  /** The lighting group's layout entries for `entries` (shadow maps, comparison samplers, buffers). */
  private lightingLayout(device: GPUDevice, entries: GPUBindGroupEntry[]): GPUBindGroupLayout {
    return device.createBindGroupLayout({
      entries: entries.map((entry) => {
        const binding = entry.binding,
          visibility = GPUShaderStage.FRAGMENT;
        if (binding === 2 || binding === 15 || binding === 29)
          return {
            binding,
            visibility,
            texture: { sampleType: 'depth' as const, viewDimension: '2d-array' as const },
          };
        if (binding === 3 || binding === 16 || binding === 30)
          return { binding, visibility, sampler: { type: 'comparison' as const } };
        return {
          binding,
          visibility,
          buffer: {
            type: binding >= 5 && binding !== 14 ? ('read-only-storage' as const) : ('uniform' as const),
          },
        };
      }),
    });
  }
  private drawRings(c: Context): void {
    const code = this.shader();
    const key = c.descriptor.multisample?.count + ':' + c.format + ':' + c.descriptor.depthStencil!.format + code;
    let pipeline = this.pipelines.get(key);
    const entries = this.lightingEntries;
    entries.length = 0;
    for (const effect of this.lighting) {
      const bound = effect.bindings();
      for (let i = 0; i < bound.length; i++) entries.push(bound[i]);
    }
    if (!pipeline) {
      const module = c.device.createShaderModule({ code }),
        layouts = [this.layout!];
      if (entries.length) layouts.push(this.lightingLayout(c.device, entries));
      pipeline = c.device.createRenderPipeline({
        layout: c.device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: true,
          depthCompare: 'greater-equal',
        },
      });
      this.pipelines.set(key, pipeline);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: c.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        ...(c.descriptor.depthStencil!.format.includes('stencil')
          ? { stencilLoadOp: 'load', stencilStoreOp: 'store' }
          : {}),
      },
    });
    pass.setPipeline(pipeline);
    if (entries.length) pass.setBindGroup(1, this.lightingGroup(c.device, pipeline, entries));
    pass.setVertexBuffer(0, this.vertex!);
    for (let i = 0; i < this.rings.length; i++) {
      pass.setBindGroup(0, this.rings[i].group);
      pass.setIndexBuffer(i ? this.ring! : this.center!, 'uint32');
      pass.drawIndexed(i ? this.ringCount : this.centerCount);
      this.engine!.stats.drawCalls++;
    }
    pass.end();
  }
  /**
   * Lets a capture hook (`@margoengine/post` SSR: `ssr.add(terrain)`) draw the terrain's material with
   * `draw(c, 'capture', ...)`: its normal, layer colour and roughness through the hook's `margoSSR`, depth tested
   * (greater-equal) and written. Returns a remover. Without a hook the terrain draws exactly as before.
   */
  setCapture(hook: TerrainCapture): () => void {
    if (
      this.disposed ||
      !hook ||
      typeof hook.declarations !== 'function' ||
      typeof hook.begin !== 'function' ||
      !Array.isArray(hook.targets)
    )
      throw new TypeError('Invalid terrain capture hook');
    this.capture = hook;
    return () => {
      if (this.capture === hook) this.capture = undefined;
    };
  }
  /** Calls `callback` once when the terrain is disposed; returns a remover. */
  onDispose(callback: () => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('Terrain onDispose needs a function');
    this.disposers.add(callback);
    return () => this.disposers.delete(callback);
  }
  /** `mode` 'capture': draws the terrain into the capture hook's pass (`setCapture`); `color` and `depth` are unused (the
   * hook's pass has its own). Does nothing without a hook or after disposal. */
  draw(c: Context, mode: 'capture', color?: GPUTextureView, depth?: GPUTextureView): void {
    const hook = this.capture;
    if (mode !== 'capture' || !hook || this.disposed || !this.rings.length) return;
    void color;
    void depth;
    const lit = this.shader();
    let code = this.captureCode.get(lit);
    if (code === undefined) {
      const declarations = hook.declarations(lit),
        head = '@fragment fn fragment(i:Output)->@location(0) vec4f {';
      if (lit.split(head).length !== 2)
        throw margoError(
          'unsupported',
          'Terrain capture needs the terrain fragment entry point once; a lighting effect changed it',
        );
      code =
        declarations +
        lit.replace(head, 'fn margoShade(i:Output)->vec4f {') +
        `\n@fragment fn capture(i:Output)->MargoSSR {let n=normalize(i.normal);let base=terrainColor(i.position,n);let v=normalize(frame.eye.xyz-i.position);${declarations.includes('var<private> margoPosition:') ? 'margoPosition=i.position;' : ''}return margoSSR(n,v,base,i.material.y,i.material.x);}\n`;
      if (this.captureCode.size >= 16) this.captureCode.clear();
      this.captureCode.set(lit, code);
    }
    const entries = this.lightingEntries;
    entries.length = 0;
    for (const effect of this.lighting) {
      const bound = effect.bindings();
      for (let i = 0; i < bound.length; i++) entries.push(bound[i]);
    }
    const key =
      'capture:' +
      hook.targets.map((t) => t.format).join(',') +
      ':' +
      c.descriptor.multisample?.count +
      ':' +
      c.descriptor.depthStencil!.format +
      code;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ code }),
        layouts = [this.layout!];
      if (entries.length) layouts.push(this.lightingLayout(c.device, entries));
      pipeline = c.device.createRenderPipeline({
        layout: c.device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
        },
        fragment: { module, entryPoint: 'capture', targets: hook.targets as GPUColorTargetState[] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: true,
          depthCompare: 'greater-equal',
        },
      });
      this.pipelines.set(key, pipeline);
    }
    const pass = hook.begin();
    pass.setPipeline(pipeline);
    if (entries.length) pass.setBindGroup(1, this.lightingGroup(c.device, pipeline, entries));
    pass.setVertexBuffer(0, this.vertex!);
    for (let i = 0; i < this.rings.length; i++) {
      pass.setBindGroup(0, this.rings[i].group);
      pass.setIndexBuffer(i ? this.ring! : this.center!, 'uint32');
      pass.drawIndexed(i ? this.ringCount : this.centerCount);
    }
  }
  private lightingGroup(device: GPUDevice, pipeline: GPURenderPipeline, entries: GPUBindGroupEntry[]): GPUBindGroup {
    const cached = this.lightingGroups.get(pipeline);
    if (
      cached?.device === device &&
      cached.entries.length === entries.length &&
      entries.every((entry, i) => {
        const previous = cached.entries[i],
          resource = entry.resource,
          old = previous.resource;
        return (
          entry.binding === previous.binding &&
          (resource === old ||
            ('buffer' in resource &&
              'buffer' in old &&
              resource.buffer === old.buffer &&
              resource.offset === old.offset &&
              resource.size === old.size))
        );
      })
    )
      return cached.group;
    // Providers may mutate the same buffer-binding wrapper between draws.
    const snapshot = entries.map(({ binding, resource }) => ({
      binding,
      resource:
        'buffer' in resource ? { buffer: resource.buffer, offset: resource.offset, size: resource.size } : resource,
    }));
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries });
    this.lightingGroups.set(pipeline, { device, entries: snapshot, group });
    return group;
  }
  drawShadow({
    context,
    pass,
    matrix,
    cascade,
  }: {
    context: Context;
    pass: GPURenderPassEncoder;
    matrix: Float32Array;
    cascade: number;
  }): void {
    if (this.disposed) return;
    pass.setPipeline(this.shadowPipeline!);
    pass.setVertexBuffer(0, this.vertex!);
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      r.shadowValues.set(r.values);
      r.shadowValues.set(matrix);
      context.device.queue.writeBuffer(r.shadowUniforms[cascade], 0, r.shadowValues as Float32Array<ArrayBuffer>);
      pass.setBindGroup(0, r.shadowGroups[cascade]);
      pass.setIndexBuffer(i ? this.ring! : this.center!, 'uint32');
      pass.drawIndexed(i ? this.ringCount : this.centerCount);
    }
  }
  private release(): void {
    for (const texture of new Set(
      this.textures ? [this.textures.heightmap, this.textures.normalmap, this.textures.layers] : [],
    ))
      texture?.destroy();
    for (const buffer of [this.vertex, this.center, this.ring, this.rules]) buffer?.destroy();
    for (const r of this.rings) for (const buffer of [r.uniform, ...r.shadowUniforms]) buffer.destroy();
    this.textures = undefined;
    this.vertex = this.center = this.ring = this.rules = undefined;
    this.rings = [];
    this.pipelines.clear();
    this.lightingGroups.clear();
    this.shadowPipeline = undefined;
    this.layout = undefined;
    this.sampler = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.lighting.clear();
    this.capture = undefined;
    this.captureCode.clear();
    this.engine = this.device = undefined;
    const disposers = [...this.disposers];
    this.disposers.clear();
    for (const callback of disposers) callback();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  destroy(): void {
    this.dispose();
  }
}
