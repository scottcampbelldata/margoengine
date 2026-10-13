import type {Engine, EnginePlugin, FrameGraph, PassContext} from '@margoengine/core/extension';
import {engineRuntime, meshRuntime} from '@margoengine/core/extension';
import type {EngineKernel, Mesh} from '@margoengine/core';
import {PointCloud} from './cloud.js';
import {SpriteBatch, SPRITE_STRIDE} from './sprites.js';
import type {PointsMaterial, SpriteMaterial, TextureSource} from './material.js';
import {allocateBudget, boxInFrustum, boxScreenRect, mergeRanges, multiply, pickPoint, screenArea, worldBox, type PickRange} from './math.js';
import {CLOUD_BYTES, FLAG, FRAME_BYTES, SPRITE_BYTES, edlShader, pointShader, spriteShader} from './shaders.js';

declare const GPUBufferUsage: {UNIFORM: number; STORAGE: number; COPY_DST: number};
declare const GPUShaderStage: {VERTEX: number; FRAGMENT: number};
declare const GPUTextureUsage: {TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number};

type GpuContext = Extract<PassContext, {backend: 'webgpu'}>;
type AnyMaterial = PointsMaterial | SpriteMaterial;

interface CloudGpu {
  structure: number;
  uniform: GPUBuffer; positions: GPUBuffer; colors: GPUBuffer | null; sizes: GPUBuffer | null; order: GPUBuffer | null;
  group: GPUBindGroup | null; groupView: GPUTextureView | null; groupSampler: GPUSampler | null;
  floats: Float32Array; uints: Uint32Array; written: Float32Array;
  /** Model matrix and drawn [block, count] pairs of the latest frame, for picking. */
  model: Float32Array; drawn: number[]; pipeline: GPURenderPipeline | null; transparent: boolean;
}
interface BatchGpu {
  structure: number; capacity: number;
  uniform: GPUBuffer; instances: GPUBuffer;
  group: GPUBindGroup | null; groupView: GPUTextureView | null; groupSampler: GPUSampler | null;
  floats: Float32Array; written: Float32Array;
}
interface OwnedTexture {source: TextureSource; version: number; texture: GPUTexture; view: GPUTextureView}

export interface PointsPluginOptions {
  /** Plugin name, unique per engine. Default 'points'. */
  name?: string;
  /** Frame graph order. Default 10: after the scene (0), before fat lines (20) and post-processing (30). */
  order?: number;
  /** Most points drawn per frame across all clouds. Visible blocks share it by screen area. Default 1,000,000. */
  pointBudget?: number;
  /** Eye-dome lighting strength. Default 1. */
  edlStrength?: number;
  /** Eye-dome lighting neighbor radius in pixels. Default 1.4. */
  edlRadius?: number;
}

export interface PointsPickOptions {
  /** Search radius in CSS pixels. Default 6. */
  radius?: number;
}

export interface PointsPickResult {
  cloud: PointCloud;
  /** Index into the cloud's arrays. */
  index: number;
  /** World position of the point. */
  position: [number, number, number];
  /** Distance from the pick position in CSS pixels. */
  distance: number;
  /** View depth (clip w) of the point. */
  depth: number;
}

let warned = false;
const warnOnce = (message: string) => {if (!warned) {warned = true; console.warn(`@margoengine/points: ${message}`);}};
let warnedTexture = false;

/** World matrix of a live, visible core mesh after the latest transform tick, or null. */
export function meshWorldMatrix(engine: EngineKernel, mesh: Mesh): Float32Array | null {
  const runtime = engineRuntime(engine), object = meshRuntime(mesh), id = object.id;
  if (runtime.disposed || runtime.meshes.get(id) !== (mesh as unknown)) return null;
  for (let current=id,depth=0;current>=0&&depth<64;current=runtime.store.parents?.[current]??-1,depth++) if (runtime.store.hidden[current]) return null;
  return object.matrix ?? runtime.store.matrices.subarray(id * 16, id * 16 + 16);
}

const isGpuTexture = (value: TextureSource): value is GPUTexture => typeof (value as GPUTexture).createView === 'function';

/**
 * Engine plugin that draws `PointCloud`s and `SpriteBatch`es over the scene color and depth (WebGPU).
 * On the WebGL2 backend it warns once and draws nothing.
 */
export class PointsPlugin implements EnginePlugin {
  readonly name: string;
  readonly order: number;
  pointBudget: number;
  edlStrength: number;
  edlRadius: number;
  /** Counters of the latest frame. */
  readonly stats = {clouds: 0, blocks: 0, blocksVisible: 0, pointsVisible: 0, pointsDrawn: 0, sprites: 0, drawCalls: 0, uploads: 0, uploadBytes: 0};
  private readonly clouds = new Set<PointCloud>();
  private readonly batches = new Set<SpriteBatch>();
  private readonly cloudGpu = new Map<PointCloud, CloudGpu>();
  private readonly batchGpu = new Map<SpriteBatch, BatchGpu>();
  private readonly owned = new Map<AnyMaterial, OwnedTexture>();
  private readonly borrowed = new WeakMap<GPUTexture, {device: GPUDevice; view: GPUTextureView}>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private engine?: Engine;
  private device?: GPUDevice;
  private gpu?: {
    pointModule: GPUShaderModule; spriteModule: GPUShaderModule; edlModule: GPUShaderModule;
    frameLayout: GPUBindGroupLayout; cloudLayout: GPUBindGroupLayout; spriteLayout: GPUBindGroupLayout; edlLayout: GPUBindGroupLayout;
    pointPipelineLayout: GPUPipelineLayout; spritePipelineLayout: GPUPipelineLayout; edlPipelineLayout: GPUPipelineLayout;
    frame: GPUBuffer; frameGroup: GPUBindGroup; dummy: GPUBuffer; white: GPUTexture; whiteView: GPUTextureView;
    linear: GPUSampler; nearest: GPUSampler; edlParams: GPUBuffer;
  };
  private edl?: {pipeline: GPURenderPipeline; texture: GPUTexture; view: GPUTextureView; group: GPUBindGroup; width: number; height: number};
  private readonly frameData = new Float32Array(FRAME_BYTES / 4);
  private readonly edlData = new Float32Array(4);
  private readonly lastViewProj = new Float32Array(16);
  private lastSize: [number, number] = [0, 0];
  private hasFrame = false;
  private readonly box = new Float64Array(6);

  constructor(options: PointsPluginOptions = {}) {
    this.name = options.name ?? 'points';
    this.order = options.order ?? 10;
    this.pointBudget = options.pointBudget ?? 1_000_000;
    this.edlStrength = options.edlStrength ?? 1;
    this.edlRadius = options.edlRadius ?? 1.4;
    if (!this.name || typeof this.name !== 'string' || !Number.isFinite(this.order)) throw new TypeError('Invalid PointsPlugin options');
    if (!(this.pointBudget >= 0) || !(this.edlStrength >= 0) || !(this.edlRadius > 0)) throw new RangeError('pointBudget, edlStrength and edlRadius must be non-negative');
  }

  /** Clouds and sprite batches drawn by this plugin. */
  get pointClouds(): ReadonlySet<PointCloud> {return this.clouds;}
  get spriteBatches(): ReadonlySet<SpriteBatch> {return this.batches;}

  /** Adds a cloud or a sprite batch and returns it. */
  add<T extends PointCloud | SpriteBatch>(item: T): T {
    if (item instanceof PointCloud) {item.bind(this); this.clouds.add(item);}
    else if (item instanceof SpriteBatch) {item.bind(this); this.batches.add(item);}
    else throw new TypeError('Expected a PointCloud or SpriteBatch');
    return item;
  }

  /** Removes a cloud or batch and frees its GPU buffers. */
  remove(item: unknown): void {
    if (item instanceof PointCloud && this.clouds.delete(item)) {this.releaseCloud(item); item.bind(undefined); this.releaseUnusedTexture(item.material);}
    else if (item instanceof SpriteBatch && this.batches.delete(item)) {this.releaseBatch(item); item.bind(undefined); this.releaseUnusedTexture(item.material);}
  }

  clear(): void {for (const item of [...this.clouds, ...this.batches]) this.remove(item);}

  setup(engine: Engine): void {
    this.engine = engine;
    if (engine.backend !== 'webgpu' || !engine.gpu) {warnOnce('the WebGL2 backend is not supported, points and sprites will not be drawn.'); return;}
    const device = this.device = engine.gpu;
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({binding, visibility: V, buffer: {type: 'read-only-storage'}});
    const frameLayout = device.createBindGroupLayout({entries: [{binding: 0, visibility: VF, buffer: {type: 'uniform', minBindingSize: FRAME_BYTES}}]});
    const cloudLayout = device.createBindGroupLayout({entries: [
      {binding: 0, visibility: VF, buffer: {type: 'uniform', minBindingSize: CLOUD_BYTES}},
      storage(1), storage(2), storage(3), storage(4),
      {binding: 5, visibility: F, texture: {sampleType: 'float'}}, {binding: 6, visibility: F, sampler: {type: 'filtering'}},
    ]});
    const spriteLayout = device.createBindGroupLayout({entries: [
      {binding: 0, visibility: VF, buffer: {type: 'uniform', minBindingSize: SPRITE_BYTES}}, storage(1),
      {binding: 2, visibility: F, texture: {sampleType: 'float'}}, {binding: 3, visibility: F, sampler: {type: 'filtering'}},
    ]});
    const edlLayout = device.createBindGroupLayout({entries: [
      {binding: 0, visibility: F, texture: {sampleType: 'unfilterable-float'}}, {binding: 1, visibility: F, buffer: {type: 'uniform', minBindingSize: 16}},
    ]});
    const created: Array<GPUBuffer|GPUTexture> = [];
    const buffer = (size:number,usage:number):GPUBuffer => {const value=device.createBuffer({size,usage});created.push(value);return value;};
    try {
    const frame = buffer(FRAME_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const white = device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    created.push(white);
    device.queue.writeTexture({texture: white}, new Uint8Array([255, 255, 255, 255]), {bytesPerRow: 4}, [1, 1]);
    this.gpu = {
      pointModule: device.createShaderModule({code: pointShader}), spriteModule: device.createShaderModule({code: spriteShader}), edlModule: device.createShaderModule({code: edlShader}),
      frameLayout, cloudLayout, spriteLayout, edlLayout,
      pointPipelineLayout: device.createPipelineLayout({bindGroupLayouts: [frameLayout, cloudLayout]}),
      spritePipelineLayout: device.createPipelineLayout({bindGroupLayouts: [frameLayout, spriteLayout]}),
      edlPipelineLayout: device.createPipelineLayout({bindGroupLayouts: [edlLayout]}),
      frame, frameGroup: device.createBindGroup({layout: frameLayout, entries: [{binding: 0, resource: {buffer: frame}}]}),
      dummy: buffer(16, GPUBufferUsage.STORAGE),
      white, whiteView: white.createView(),
      linear: device.createSampler({magFilter: 'linear', minFilter: 'linear'}),
      nearest: device.createSampler({magFilter: 'nearest', minFilter: 'nearest'}),
      edlParams: buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    };
    } catch (error) {for (const resource of created) resource.destroy(); throw error;}
  }

  registerPasses(graph: FrameGraph): void {graph.add({name: `${this.name}:draw`, order: this.order, execute: this.execute});}

  onDeviceRestored(engine: Engine): void {this.releaseGpu(); this.setup(engine);}

  /** Releases every GPU resource. Clouds and batches stay registered, so the plugin can be used again. */
  dispose(): void {this.releaseGpu(); this.engine = undefined;}

  /**
   * CPU picking: the drawn point nearest to CSS pixel (x, y) of the canvas within `radius`, using the latest
   * frame's camera, transforms and level of detail. Meshes do not occlude picks.
   */
  pick(x: number, y: number, options: PointsPickOptions = {}): PointsPickResult | null {
    if (![x, y].every(Number.isFinite)) throw new RangeError('Invalid pick coordinates');
    const radius = options.radius ?? 6;
    if (!(radius >= 0)) throw new RangeError('radius must be non-negative');
    const engine = this.engine as unknown as EngineKernel | undefined;
    if (!engine || !this.hasFrame) return null;
    const canvas = engine.canvas, [width, height] = this.lastSize;
    const scale = canvas.clientWidth ? width / canvas.clientWidth : 1, px = x * scale, py = y * scale, r = radius * scale;
    let best: PointsPickResult | null = null, bestDistance = Infinity, bestDepth = Infinity;
    const mvp = new Float64Array(16);
    for (const cloud of this.clouds) {
      const gpu = this.cloudGpu.get(cloud);
      if (!gpu || !gpu.drawn.length) continue;
      multiply(this.lastViewProj, gpu.model, mvp);
      const ranges: PickRange[] = [];
      for (let i = 0; i < gpu.drawn.length; i += 2) {
        const block = gpu.drawn[i];
        worldBox(cloud.blocks.bounds, block, gpu.model, this.box);
        const rect = boxScreenRect(this.box, this.lastViewProj, width, height);
        if (rect && (px < rect[0] - r - 1 || px > rect[2] + r + 1 || py < rect[1] - r - 1 || py > rect[3] + r + 1)) continue;
        ranges.push({start: cloud.blocks.starts[block], count: gpu.drawn[i + 1]});
      }
      const hit = pickPoint(cloud.positions, cloud.direct ? null : cloud.blocks.order, ranges, mvp, width, height, px, py, r);
      if (!hit) continue;
      if (hit.distance < bestDistance - 0.5 || (Math.abs(hit.distance - bestDistance) <= 0.5 && hit.depth < bestDepth)) {
        const p = hit.index * 3, m = gpu.model, lx = cloud.positions[p], ly = cloud.positions[p + 1], lz = cloud.positions[p + 2];
        const position: [number, number, number] = [0, 1, 2].map(k => m[k] * lx + m[4 + k] * ly + m[8 + k] * lz + m[12 + k]) as [number, number, number];
        best = {cloud, index: hit.index, position, distance: hit.distance / scale, depth: hit.depth};
        bestDistance = hit.distance; bestDepth = hit.depth;
      }
    }
    return best;
  }

  // ---- GPU resources ------------------------------------------------------------------------------------

  private texture(material: AnyMaterial): GPUTextureView | null {
    const source = material.map, device = this.device!;
    if (!source) return this.gpu!.whiteView;
    if (isGpuTexture(source)) {
      let entry = this.borrowed.get(source);
      if (!entry) {entry = {device, view: source.createView()}; this.borrowed.set(source, entry);}
      if (entry.device !== device) {
        if (!warnedTexture) {warnedTexture = true; console.warn('@margoengine/points: a GPUTexture map belongs to a lost device; assign a new texture after onDeviceRestored. Drawing untextured.');}
        return null;
      }
      return entry.view;
    }
    let owned = this.owned.get(material);
    if (owned && owned.source === source && owned.version === material.mapVersion) return owned.view;
    if (owned) {owned.texture.destroy(); this.owned.delete(material);}
    const image = source as {width?: number; height?: number; naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number};
    const width = image.naturalWidth || image.videoWidth || image.width || 0, height = image.naturalHeight || image.videoHeight || image.height || 0;
    if (!width || !height) throw new RangeError('Texture source has no size');
    const texture = device.createTexture({size: [width, height], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT});
    try {
      if (typeof ImageData !== 'undefined' && source instanceof ImageData) device.queue.writeTexture({texture}, source.data, {bytesPerRow: width * 4}, [width, height]);
      else device.queue.copyExternalImageToTexture({source: source as GPUCopyExternalImageSource}, {texture}, [width, height]);
      owned = {source, version: material.mapVersion, texture, view: texture.createView()};
    } catch (error) {texture.destroy(); throw error;}
    this.owned.set(material, owned);
    return owned.view;
  }

  private releaseUnusedTexture(material: AnyMaterial): void {
    const owned = this.owned.get(material);
    if (!owned) return;
    for (const item of [...this.clouds, ...this.batches]) if (item.material === material) return;
    owned.texture.destroy(); this.owned.delete(material);
  }

  private ensureCloud(cloud: PointCloud): CloudGpu {
    let r = this.cloudGpu.get(cloud);
    if (r && r.structure === cloud.structure) return r;
    if (r) this.releaseCloud(cloud);
    const device = this.device!, limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    if (cloud.count * 12 > limit) throw new RangeError(`Point cloud of ${cloud.count} points exceeds the device storage limit of ${Math.floor(limit / 12)} points`);
    const created: GPUBuffer[] = [];
    const make = (size: number, usage: number) => {const b = device.createBuffer({size: Math.max(16, Math.ceil(size / 4) * 4), usage}); created.push(b); return b;};
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    try {
      const uniform = make(CLOUD_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const positions = make(cloud.count * 12, storage);
      const colors = cloud.colors ? make(cloud.count * 4, storage) : null;
      const sizes = cloud.sizes ? make(cloud.count * 4, storage) : null;
      const order = cloud.direct ? null : make(cloud.count * 4, storage);
      const data = new ArrayBuffer(CLOUD_BYTES);
      r = {structure: cloud.structure, uniform, positions, colors, sizes, order, group: null, groupView: null, groupSampler: null,
        floats: new Float32Array(data), uints: new Uint32Array(data), written: new Float32Array(CLOUD_BYTES / 4).fill(NaN),
        model: new Float32Array(16), drawn: [], pipeline: null, transparent: false};
    } catch (error) {for (const b of created) b.destroy(); throw error;}
    const q = device.queue, n = cloud.count;
    if (n) {
      q.writeBuffer(r.positions, 0, cloud.positions as Float32Array<ArrayBuffer>, 0, n * 3);
      if (r.colors) q.writeBuffer(r.colors, 0, cloud.colors! as Uint32Array<ArrayBuffer>, 0, n);
      if (r.sizes) q.writeBuffer(r.sizes, 0, cloud.sizes! as Float32Array<ArrayBuffer>, 0, n);
      if (r.order) q.writeBuffer(r.order, 0, cloud.blocks.order as Uint32Array<ArrayBuffer>, 0, n);
      this.stats.uploads += 1 + +!!r.colors + +!!r.sizes + +!!r.order;
      this.stats.uploadBytes += n * (12 + (r.colors ? 4 : 0) + (r.sizes ? 4 : 0) + (r.order ? 4 : 0));
    }
    cloud.dirty.positions.length = cloud.dirty.colors.length = cloud.dirty.sizes.length = 0;
    this.cloudGpu.set(cloud, r);
    return r;
  }

  private flushCloud(cloud: PointCloud, r: CloudGpu): void {
    const q = this.device!.queue;
    const channels = [['positions', r.positions, cloud.positions, 3], ['colors', r.colors, cloud.colors, 1], ['sizes', r.sizes, cloud.sizes, 1]] as const;
    for (const [channel, buffer, array, stride] of channels) {
      const ranges = cloud.dirty[channel];
      if (!ranges.length) continue;
      if (buffer && array) for (const [start, end] of mergeRanges(ranges)) {
        q.writeBuffer(buffer, start * stride * 4, array as Float32Array<ArrayBuffer>, start * stride, (end - start) * stride);
        this.stats.uploads++; this.stats.uploadBytes += (end - start) * stride * 4;
      }
      ranges.length = 0;
    }
  }

  private releaseCloud(cloud: PointCloud): void {
    const r = this.cloudGpu.get(cloud);
    if (!r) return;
    r.uniform.destroy(); r.positions.destroy(); r.colors?.destroy(); r.sizes?.destroy(); r.order?.destroy();
    this.cloudGpu.delete(cloud);
  }

  private ensureBatch(batch: SpriteBatch): BatchGpu {
    let r = this.batchGpu.get(batch);
    if (r && r.structure === batch.structure) return r;
    if (r) this.releaseBatch(batch);
    const device = this.device!;
    const uniform = device.createBuffer({size: SPRITE_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    let instances: GPUBuffer;
    try {instances = device.createBuffer({size: batch.capacity * SPRITE_STRIDE * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});}
    catch (error) {uniform.destroy(); throw error;}
    r = {structure: batch.structure, capacity: batch.capacity, uniform, instances, group: null, groupView: null, groupSampler: null,
      floats: new Float32Array(SPRITE_BYTES / 4), written: new Float32Array(SPRITE_BYTES / 4).fill(NaN)};
    if (batch.count) {
      device.queue.writeBuffer(instances, 0, batch.data as Float32Array<ArrayBuffer>, 0, batch.count * SPRITE_STRIDE);
      this.stats.uploads++; this.stats.uploadBytes += batch.count * SPRITE_STRIDE * 4;
    }
    batch.dirty.length = 0;
    this.batchGpu.set(batch, r);
    return r;
  }

  private releaseBatch(batch: SpriteBatch): void {
    const r = this.batchGpu.get(batch);
    if (!r) return;
    r.uniform.destroy(); r.instances.destroy(); this.batchGpu.delete(batch);
  }

  private releaseGpu(): void {
    for (const cloud of [...this.cloudGpu.keys()]) this.releaseCloud(cloud);
    for (const batch of [...this.batchGpu.keys()]) this.releaseBatch(batch);
    for (const owned of this.owned.values()) owned.texture.destroy();
    this.owned.clear();
    this.edl?.texture.destroy(); this.edl = undefined;
    if (this.gpu) {this.gpu.frame.destroy(); this.gpu.dummy.destroy(); this.gpu.white.destroy(); this.gpu.edlParams.destroy();}
    this.gpu = undefined; this.device = undefined; this.hasFrame = false;
    this.pipelines.clear();
  }

  private blend(blending: 'normal' | 'additive'): GPUBlendState {
    return blending === 'additive'
      ? {color: {srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add'}, alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'}}
      : {color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add'}, alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'}};
  }

  private pointPipeline(context: GpuContext, material: PointsMaterial, edl: boolean): GPURenderPipeline {
    const depthFormat = context.descriptor.depthStencil!.format, sphere = material.shading === 'sphere';
    const key = `p|${context.descriptor.multisample?.count}|${context.format}|${depthFormat}|${edl}|${sphere}|${material.writesDepth}|${material.depthTest}|${material.blending}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const gpu = this.gpu!, module = gpu.pointModule;
      const targets: GPUColorTargetState[] = [{format: context.format, blend: this.blend(material.blending)}];
      if (edl) targets.push({format: 'r32float'});
      pipeline = this.device!.createRenderPipeline({
        layout: gpu.pointPipelineLayout,
        vertex: {module, entryPoint: 'vertex'},
        fragment: {module, entryPoint: `fragment${sphere ? 'Sphere' : ''}${edl ? 'Edl' : ''}`, targets},
        primitive: {topology: 'triangle-strip', cullMode: 'none'},
        multisample: context.descriptor.multisample,
        depthStencil: {format: depthFormat, depthWriteEnabled: material.writesDepth, depthCompare: material.depthTest ? 'greater-equal' : 'always'},
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private spritePipeline(context: GpuContext, material: SpriteMaterial): GPURenderPipeline {
    const depthFormat = context.descriptor.depthStencil!.format;
    const key = `s|${context.descriptor.multisample?.count}|${context.format}|${depthFormat}|${material.writesDepth}|${material.depthTest}|${material.blending}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const gpu = this.gpu!, module = gpu.spriteModule;
      pipeline = this.device!.createRenderPipeline({
        layout: gpu.spritePipelineLayout,
        vertex: {module, entryPoint: 'vertex'},
        fragment: {module, entryPoint: 'fragment', targets: [{format: context.format, blend: this.blend(material.blending)}]},
        primitive: {topology: 'triangle-strip', cullMode: 'none'},
        multisample: context.descriptor.multisample,
        depthStencil: {format: depthFormat, depthWriteEnabled: material.writesDepth, depthCompare: material.depthTest ? 'greater-equal' : 'always'},
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private edlPipeline(format: GPUTextureFormat, count: number): GPURenderPipeline {
    const key = `e|${format}|${count}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const gpu = this.gpu!, module = count === 1 ? gpu.edlModule : this.device!.createShaderModule({code:
        // Compare matching coverage samples; averaging empty samples invents depth steps.
        edlShader.replace('texture_2d<f32>', 'texture_multisampled_2d<f32>')
          .replace('position:vec4f)', 'position:vec4f,@builtin(sample_index) sample:u32)')
          .replace(/textureLoad\(depths,([pq]),0\)/g, 'textureLoad(depths,$1,i32(sample))')});
      pipeline = this.device!.createRenderPipeline({
        layout: count === 1 ? gpu.edlPipelineLayout : 'auto',
        vertex: {module, entryPoint: 'vertex'},
        fragment: {module, entryPoint: 'fragment', targets: [{format, blend: {
          color: {srcFactor: 'zero', dstFactor: 'src', operation: 'add'}, alpha: {srcFactor: 'zero', dstFactor: 'one', operation: 'add'}}}]},
        primitive: {topology: 'triangle-list'},
        multisample: {count},
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  private edlTarget(width: number, height: number, sampleCount: number, pipeline: GPURenderPipeline): NonNullable<PointsPlugin['edl']> {
    if (this.edl && this.edl.width === width && this.edl.height === height && this.edl.pipeline === pipeline) return this.edl;
    this.edl?.texture.destroy();
    const device = this.device!, gpu = this.gpu!;
    const texture = device.createTexture({size: [width, height], sampleCount, format: 'r32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING});
    const view = texture.createView();
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: view}, {binding: 1, resource: {buffer: gpu.edlParams}}]});
    return this.edl = {texture, view, group, width, height, pipeline};
  }

  // ---- Frame --------------------------------------------------------------------------------------------

  private writeFrame(context: GpuContext): void {
    const camera = context.camera, f = this.frameData;
    f.set(camera.matrix, 0);
    const projScale = 0.5 * context.height / Math.tan(camera.fov * Math.PI / 360);
    f[16] = context.width; f[17] = context.height; f[18] = projScale;
    f[19] = context.format.endsWith('-srgb') || context.format.includes('float') ? 0 : 1;
    f[20] = camera.near / (camera.far - camera.near); f[21] = camera.far * camera.near / (camera.far - camera.near); f[22] = camera.near; f[23] = 0;
    // Camera basis, matching Camera.update.
    const p = camera.position, t = camera.target;
    let zx = p[0] - t[0], zy = p[1] - t[1], zz = p[2] - t[2];
    const length = Math.hypot(zx, zy, zz) || 1; zx /= length; zy /= length; zz /= length;
    const horizontal = Math.hypot(zx, zz) || 1, xx = zz / horizontal, xz = -zx / horizontal;
    f.set([xx, 0, xz, 0, zy * xz, zz * xx - zx * xz, -zy * xx, 0, zx, zy, zz, 0], 24);
    this.device!.queue.writeBuffer(this.gpu!.frame, 0, f);
    this.lastViewProj.set(camera.matrix); this.lastSize = [context.width, context.height]; this.hasFrame = true;
  }

  private writeCloudUniform(cloud: PointCloud, r: CloudGpu, model: ArrayLike<number>, mapped: boolean): void {
    const m = cloud.material, f = r.floats, u = r.uints;
    f.set(model, 0); f.set(m.color, 16); f[19] = m.opacity;
    f[20] = m.size; f[21] = m.minPixelSize; f[22] = m.maxPixelSize; f[23] = m.alphaTest;
    u[24] = (cloud.colors && m.vertexColors ? FLAG.colors : 0) | (cloud.sizes ? FLAG.sizes : 0) | (m.sizeUnits === 'world' ? FLAG.world : 0)
      | (m.shape === 'round' ? FLAG.round : 0) | (mapped ? FLAG.map : 0) | (m.shading === 'sphere' ? FLAG.sphere : 0)
      | (cloud.direct ? FLAG.direct : 0) | (cloud.colorSpace === 'srgb' ? FLAG.srgbColors : 0);
    u[25] = u[26] = u[27] = 0;
    let changed = false;
    for (let i = 0; i < 28; i++) if (!Object.is(r.written[i], f[i])) {changed = true; break;}
    if (changed) {this.device!.queue.writeBuffer(r.uniform, 0, f); r.written.set(f);}
  }

  private cloudGroup(r: CloudGpu, view: GPUTextureView, sampler: GPUSampler): GPUBindGroup {
    if (r.group && r.groupView === view && r.groupSampler === sampler) return r.group;
    const gpu = this.gpu!, dummy = gpu.dummy;
    r.group = this.device!.createBindGroup({layout: gpu.cloudLayout, entries: [
      {binding: 0, resource: {buffer: r.uniform}}, {binding: 1, resource: {buffer: r.positions}},
      {binding: 2, resource: {buffer: r.colors ?? dummy}}, {binding: 3, resource: {buffer: r.sizes ?? dummy}},
      {binding: 4, resource: {buffer: r.order ?? dummy}}, {binding: 5, resource: view}, {binding: 6, resource: sampler},
    ]});
    r.groupView = view; r.groupSampler = sampler;
    return r.group;
  }

  private batchGroup(r: BatchGpu, view: GPUTextureView, sampler: GPUSampler): GPUBindGroup {
    if (r.group && r.groupView === view && r.groupSampler === sampler) return r.group;
    r.group = this.device!.createBindGroup({layout: this.gpu!.spriteLayout, entries: [
      {binding: 0, resource: {buffer: r.uniform}}, {binding: 1, resource: {buffer: r.instances}}, {binding: 2, resource: view}, {binding: 3, resource: sampler},
    ]});
    r.groupView = view; r.groupSampler = sampler;
    return r.group;
  }

  private readonly execute = (context: PassContext): void => {
    const s = this.stats;
    s.clouds = s.blocks = s.blocksVisible = s.pointsVisible = s.pointsDrawn = s.sprites = s.drawCalls = s.uploads = s.uploadBytes = 0;
    if (context.backend !== 'webgpu' || !this.device || !this.gpu || !this.engine || context.device !== this.device) return;
    if (!this.clouds.size && !this.batches.size) return;
    const engine = this.engine as unknown as EngineKernel, device = this.device, gpu = this.gpu, camera = context.camera;
    this.writeFrame(context);
    const projScale = this.frameData[18];

    // 1. Upload changes, cull blocks and collect candidates.
    const active: Array<{cloud: PointCloud; r: CloudGpu; view: GPUTextureView; first: number; end: number}> = [];
    const entryBlock: number[] = [], entryCount: number[] = [], entryWeight: number[] = [], entryDistance: number[] = [];
    for (const cloud of this.clouds) {
      cloud.stats.blocksVisible = cloud.stats.pointsVisible = cloud.stats.pointsDrawn = 0;
      const prior = this.cloudGpu.get(cloud);
      if (prior) prior.drawn.length = 0;
      if (!cloud.visible || !cloud.count) continue;
      const mesh = cloud.attachedMesh, model = mesh ? meshWorldMatrix(engine, mesh) : cloud.matrix;
      if (!model) continue;
      cloud.material.validate();
      const r = this.ensureCloud(cloud);
      this.flushCloud(cloud, r);
      const view = this.texture(cloud.material);
      this.writeCloudUniform(cloud, r, model, !!view && cloud.material.map !== null);
      r.model.set(model);
      s.clouds++;
      const blocks = cloud.blocks, first = entryBlock.length;
      s.blocks += blocks.length;
      for (let b = 0; b < blocks.length; b++) {
        if (!blocks.counts[b]) continue;
        worldBox(blocks.bounds, b, model, this.box);
        if (!boxInFrustum(this.box, camera.planes, cloud.cullMargin)) continue;
        const box = this.box;
        entryBlock.push(b); entryCount.push(blocks.counts[b]);
        entryWeight.push(screenArea(box, camera.position, projScale, context.width, context.height));
        entryDistance.push(Math.hypot(box[0] - camera.position[0], box[1] - camera.position[1], box[2] - camera.position[2]));
        cloud.stats.blocksVisible++; cloud.stats.pointsVisible += blocks.counts[b];
      }
      s.blocksVisible += cloud.stats.blocksVisible; s.pointsVisible += cloud.stats.pointsVisible;
      if (entryBlock.length > first) active.push({cloud, r, view: view ?? gpu.whiteView, first, end: entryBlock.length});
    }

    // 2. Share the point budget across every visible block.
    const allotment = new Uint32Array(entryBlock.length);
    s.pointsDrawn = allocateBudget(entryCount, entryWeight, entryBlock.length, this.pointBudget, allotment);

    // 3. Draw: opaque clouds front to back, then transparent clouds back to front.
    const edlUsed = active.some(a => a.cloud.material.edl);
    for (const a of active) {
      a.r.transparent = a.cloud.material.transparent;
      a.r.pipeline = this.pointPipeline(context as GpuContext, a.cloud.material, edlUsed);
    }
    active.sort((a, b) => +a.r.transparent - +b.r.transparent);
    if (active.length) {
      const depthFormat = context.descriptor.depthStencil!.format;
      const colorAttachments: GPURenderPassColorAttachment[] = [{view: context.color, loadOp: 'load', storeOp: 'store'}];
      if (edlUsed) {
        const count = context.descriptor.multisample?.count ?? 1;
        const target = this.edlTarget(context.width, context.height, count, this.edlPipeline(context.format, count));
        colorAttachments.push({view: target.view, loadOp: 'clear', storeOp: 'store', clearValue: {r: 0, g: 0, b: 0, a: 0}});
      }
      const depthAttachment: GPURenderPassDepthStencilAttachment = {view: context.depth, depthLoadOp: 'load', depthStoreOp: 'store'};
      if (depthFormat.includes('stencil')) depthAttachment.stencilReadOnly = true;
      const pass = context.encoder.beginRenderPass({colorAttachments, depthStencilAttachment: depthAttachment});
      pass.setBindGroup(0, gpu.frameGroup);
      for (const a of active) {
        const {cloud, r} = a, blocks = cloud.blocks;
        const sampler = cloud.material.mapFilter === 'nearest' ? gpu.nearest : gpu.linear;
        pass.setPipeline(r.pipeline!);
        pass.setBindGroup(1, this.cloudGroup(r, a.view, sampler));
        const order: number[] = [];
        for (let e = a.first; e < a.end; e++) if (allotment[e]) order.push(e);
        order.sort((x, y) => r.transparent ? entryDistance[y] - entryDistance[x] : entryDistance[x] - entryDistance[y]);
        for (const e of order) {
          const block = entryBlock[e], n = allotment[e];
          pass.draw(4, n, 0, blocks.starts[block]);
          r.drawn.push(block, n); cloud.stats.pointsDrawn += n; s.drawCalls++;
        }
      }
      pass.end();
      if (edlUsed && this.edl) {
        this.edlData[0] = this.edlStrength; this.edlData[1] = this.edlRadius;
        device.queue.writeBuffer(gpu.edlParams, 0, this.edlData);
        const edlPass = context.encoder.beginRenderPass({colorAttachments: [{view: context.color, loadOp: 'load', storeOp: 'store'}]});
        edlPass.setPipeline(this.edlPipeline(context.format, context.descriptor.multisample?.count ?? 1));
        edlPass.setBindGroup(0, this.edl.group);
        edlPass.draw(3);
        edlPass.end();
        s.drawCalls++;
      }
    }

    // 4. Sprites, one instanced draw per batch.
    const drawBatches: Array<[SpriteBatch, BatchGpu, GPUBindGroup]> = [];
    for (const batch of this.batches) {
      if (!batch.visible || !batch.count) continue;
      const mesh = batch.attachedMesh, model = mesh ? meshWorldMatrix(engine, mesh) : batch.matrix;
      if (!model) continue;
      const m = batch.material;
      m.validate();
      const r = this.ensureBatch(batch);
      if (batch.dirty.length) {
        for (const [start, end] of mergeRanges(batch.dirty)) {
          const to = Math.min(end, batch.count);
          if (to <= start) continue;
          device.queue.writeBuffer(r.instances, start * SPRITE_STRIDE * 4, batch.data as Float32Array<ArrayBuffer>, start * SPRITE_STRIDE, (to - start) * SPRITE_STRIDE);
          s.uploads++; s.uploadBytes += (to - start) * SPRITE_STRIDE * 4;
        }
        batch.dirty.length = 0;
      }
      const view = this.texture(m) ?? gpu.whiteView, f = r.floats;
      f.set(model, 0); f.set(m.color, 16); f[19] = m.opacity;
      f[20] = m.rotation; f[21] = m.alphaTest; f[22] = m.sizeUnits === 'pixels' ? 1 : 0; f[23] = 0;
      let changed = false;
      for (let i = 0; i < f.length; i++) if (!Object.is(r.written[i], f[i])) {changed = true; break;}
      if (changed) {device.queue.writeBuffer(r.uniform, 0, f); r.written.set(f);}
      drawBatches.push([batch, r, this.batchGroup(r, view, m.mapFilter === 'nearest' ? gpu.nearest : gpu.linear)]);
    }
    if (drawBatches.length) {
      drawBatches.sort((a, b) => +a[0].material.transparent - +b[0].material.transparent);
      const depthAttachment: GPURenderPassDepthStencilAttachment = {view: context.depth, depthLoadOp: 'load', depthStoreOp: 'store'};
      if (context.descriptor.depthStencil!.format.includes('stencil')) depthAttachment.stencilReadOnly = true;
      const pass = context.encoder.beginRenderPass({colorAttachments: [{view: context.color, loadOp: 'load', storeOp: 'store'}], depthStencilAttachment: depthAttachment});
      pass.setBindGroup(0, gpu.frameGroup);
      for (const [batch, , group] of drawBatches) {
        pass.setPipeline(this.spritePipeline(context as GpuContext, batch.material));
        pass.setBindGroup(1, group);
        pass.draw(4, batch.count);
        s.sprites += batch.count; s.drawCalls++;
      }
      pass.end();
    }
  };
}
