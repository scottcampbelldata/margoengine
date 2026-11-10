/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { atlasTexture } from '../../shared/atlas-texture.js';
import { texelVarying } from '../../shared/texel-varying.js';
import { applyView, checkLayers, ViewStates } from '../../shared/view-rect.js';
import { fault, rangeError } from '../../shared/errors.js';
import { mapColor } from './chunks.js';
import { validateTileMap, type TileMapData } from './index.js';
import { buildMapQuads } from './object-quads.js';
import type { GridTileMapOptions } from './iso.js';
import type { TileAtlas, TileCamera, TileMapStats } from './renderer.js';

export { buildMapQuads, type TileQuad, type TileQuadOptions } from './object-quads.js';

declare const GPUBufferUsage: { UNIFORM: number; VERTEX: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Ordered drawing of every map layer. Image keys are image source paths; atlas keys are tileset names. */
export interface ObjectTileMapOptions extends GridTileMapOptions {
  /** Per-tile collection images and image-layer sources. Default empty. */
  images?: { readonly [source: string]: TileAtlas };
}

const shader = /* wgsl */ `
@group(0) @binding(0) var<uniform> projection:mat4x4f;
@group(1) @binding(0) var atlas:texture_2d<f32>;
${texelVarying}
@vertex fn vertexMain(@builtin(vertex_index) corner:u32,
  @location(0) origin:vec2f,@location(1) ax:vec2f,@location(2) ay:vec2f,
  @location(3) texel:vec2f,@location(4) size:vec2f,@location(5) flags:u32,@location(6) tint:u32)->Varying{
  let c=vec2f(f32(corner&1u),f32(corner>>1u));
  var v:Varying;
  v.position=projection*vec4f(origin+c.x*ax+c.y*ay,0,1);
  var s=c;
  if((flags&1u)!=0u){s.x=1-s.x;}
  if((flags&2u)!=0u){s.y=1-s.y;}
  if((flags&4u)!=0u){s=s.yx;}
  v.texel=texel+s*size;v.low=texel;v.high=texel+size-1;v.tint=unpack4x8unorm(tint);
  return v;
}
@fragment fn fragmentMain(v:Varying)->@location(0) vec4f{
  let color=textureLoad(atlas,vec2i(clamp(floor(v.texel),v.low,v.high)),0)*v.tint;
  if(color.a==0){discard;}
  return color;
}`;
interface TextureState {
  texture: GPUTexture;
  owned: boolean;
  group: GPUBindGroup;
}
interface ViewState {
  uniform: GPUBuffer;
  group?: GPUBindGroup;
  vertices?: GPUBuffer;
}
let serial = 0;

/** Instanced exact-texel drawing in map order, including tile objects, image layers and image collections. */
export class ObjectTileMap implements EnginePlugin {
  readonly name: string;
  /** Read each frame. Default the identity 2D camera. */
  camera: TileCamera;
  /** Snap screen origins to integer pixels. Default true. */
  snap: boolean;
  /** Apply layer parallax. Default true. */
  parallax: boolean;
  /** Animation time in milliseconds. */
  time = 0;
  /** Last frame's ordered texture runs and uploaded instance bytes. */
  readonly stats: TileMapStats = { draws: 0, uploadedBytes: 0 };
  protected readonly options: ObjectTileMapOptions;
  private data: TileMapData;
  private engine?: Engine;
  private device?: GPUDevice;
  private module?: GPUShaderModule;
  private frameLayout?: GPUBindGroupLayout;
  private textureLayout?: GPUBindGroupLayout;
  private readonly textures = new Map<string, TextureState>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly sources: { [key: string]: TileAtlas } = {};
  private readonly mask: number;
  private disposed = false;
  private readonly states = new ViewStates<ViewState>(
    () => ({
      uniform: this.device!.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    }),
    (state) => {
      state.uniform.destroy();
      state.vertices?.destroy();
    },
  );

  constructor(options: ObjectTileMapOptions) {
    validateTileMap(options.map);
    if (!options.atlases) throw fault('state', 'ObjectTileMap needs atlases', 'tilemap-options');
    if (!Number.isFinite(options.order ?? 10)) throw rangeError('Invalid tile map order', 'tilemap-options');
    this.options = { ...options };
    this.data = options.map;
    this.name = options.name ?? `object-tilemap-${++serial}`;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.snap = options.snap ?? true;
    this.parallax = options.parallax ?? true;
    this.mask = checkLayers(options.layers ?? 1, 'ObjectTileMap layers');
    for (const [key, value] of Object.entries(options.atlases)) this.sources[`a:${key}`] = value;
    for (const [key, value] of Object.entries(options.images ?? {})) this.sources[`i:${key}`] = value;
  }
  /** Create and attach an ordered map renderer. */
  static attach(instance: EngineKernel, options: ObjectTileMapOptions): ObjectTileMap {
    const map = new ObjectTileMap(options);
    engineRuntime(instance).use(map);
    return map;
  }
  /** Current map. Runtime cell and object edits are read on the next frame. */
  get map(): TileMapData {
    return this.data;
  }
  /** Replace the map, retaining supplied images. */
  setMap(map: TileMapData): void {
    this.assertLive();
    validateTileMap(map);
    this.data = map;
  }
  /** Replace a named tileset atlas. */
  setAtlas(name: string, source: TileAtlas): void {
    this.setSource(`a:${name}`, source);
  }
  /** Replace a collection tile or layer image by its source path. */
  setImage(source: string, image: TileAtlas): void {
    this.setSource(`i:${source}`, image);
  }
  setup(engine: Engine): void {
    this.assertLive();
    if (engine.backend !== 'webgpu')
      throw fault('unsupported', 'ObjectTileMap needs WebGPU or its compatibility device', 'webgpu');
    this.engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.options.order ?? 10,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) {
      this.time += delta * 1000;
      this.states.prune();
    }
  }
  onDeviceRestored(): void {
    this.releaseDevice();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.releaseDevice();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** Projection of map pixels, including the screen camera, to clip coordinates. */
  protected projection(_c: Context, width: number, height: number): Float32Array<ArrayBuffer> {
    return new Float32Array([
      (2 * this.camera.zoom) / width,
      0,
      0,
      0,
      0,
      (-2 * this.camera.zoom) / height,
      0,
      0,
      0,
      0,
      1,
      0,
      -1,
      1,
      0,
      1,
    ]);
  }
  /** Culling bounds in camera-relative map pixels. */
  protected bounds(width: number, height: number): readonly [number, number, number, number] | undefined {
    return [0, 0, width / this.camera.zoom, height / this.camera.zoom];
  }
  /** Additional render-pass and pipeline settings, for scene-space consumers. */
  protected depth(_c: Context): { attachment?: GPURenderPassDepthStencilAttachment; state?: GPUDepthStencilState } {
    return {};
  }
  private assertLive(): void {
    if (this.disposed) throw fault('disposed', 'ObjectTileMap disposed', 'disposed');
  }
  private setSource(key: string, source: TileAtlas): void {
    this.assertLive();
    const old = this.textures.get(key);
    if (old?.owned) old.texture.destroy();
    this.textures.delete(key);
    this.sources[key] = source;
  }
  private releaseDevice(): void {
    this.states.clear();
    for (const value of this.textures.values()) if (value.owned) value.texture.destroy();
    this.textures.clear();
    this.pipelines.clear();
    this.device = this.module = this.frameLayout = this.textureLayout = undefined;
  }
  private texture(key: string): TextureState {
    let value = this.textures.get(key);
    if (!value) {
      const source = this.sources[key];
      if (!source) throw fault('state', `No image for ${key.slice(2)}`, 'tilemap-options');
      const atlas = atlasTexture(this.device!, source, () =>
        rangeError('Invalid tile image pixels', 'tilemap-options'),
      );
      value = {
        ...atlas,
        group: this.device!.createBindGroup({
          layout: this.textureLayout!,
          entries: [{ binding: 0, resource: atlas.texture.createView() }],
        }),
      };
      this.textures.set(key, value);
    }
    return value;
  }
  private draw(c: Context): void {
    if (c.view?.layers !== undefined && !(c.view.layers & this.mask)) return;
    const own = typeof this.options.target === 'function' ? this.options.target() : this.options.target;
    if (own && c.view?.index) return;
    if (!(this.camera.zoom > 0) || !Number.isFinite(this.camera.x + this.camera.y + this.camera.zoom))
      throw rangeError('Invalid tile map camera', 'tilemap-options');
    if (this.device !== c.device) {
      this.releaseDevice();
      this.device = c.device;
    }
    const device = c.device;
    if (!this.module) {
      this.module = device.createShaderModule({ code: shader, label: 'ordered tilemap' });
      this.frameLayout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
      });
      this.textureLayout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }],
      });
    }
    const width = own?.width ?? c.view?.viewport[2] ?? c.width,
      height = own?.height ?? c.view?.viewport[3] ?? c.height;
    const quads = buildMapQuads(this.data, {
      time: this.time,
      mapLayers: this.options.mapLayers,
      camera: this.camera,
      parallax: this.parallax,
      view: this.bounds(width, height),
      imageSize: (source) => {
        const t = this.texture(`i:${source}`).texture;
        return [t.width, t.height];
      },
    });
    const words = new Uint32Array(quads.length * 12),
      floats = new Float32Array(words.buffer);
    const runs: { key: string; first: number; count: number }[] = [];
    for (let i = 0; i < quads.length; i++) {
      const q = quads[i],
        at = i * 12,
        key = `${q.image ? 'i' : 'a'}:${q.source}`;
      this.texture(key);
      floats.set([...q.origin, ...q.axisX, ...q.axisY, ...q.texel, ...q.size], at);
      if (this.snap) {
        floats[at] = Math.round(floats[at] * this.camera.zoom) / this.camera.zoom;
        floats[at + 1] = Math.round(floats[at + 1] * this.camera.zoom) / this.camera.zoom;
      }
      words[at + 10] = q.flags;
      words[at + 11] = q.tint.reduce((packed, v, j) => packed | (Math.round(v * 255) << (j * 8)), 0) >>> 0;
      const last = runs[runs.length - 1];
      if (last?.key === key) last.count++;
      else runs.push({ key, first: i, count: 1 });
    }
    const state = this.states.get(c),
      projection = this.projection(c, width, height),
      depth = this.depth(c);
    device.queue.writeBuffer(state.uniform, 0, projection);
    state.group ??= device.createBindGroup({
      layout: this.frameLayout!,
      entries: [{ binding: 0, resource: { buffer: state.uniform } }],
    });
    if (words.byteLength > (state.vertices?.size ?? 0)) {
      state.vertices?.destroy();
      state.vertices = device.createBuffer({
        size: Math.max(1024, words.byteLength * 2),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    if (words.length) device.queue.writeBuffer(state.vertices!, 0, words);
    const attachment: GPURenderPassColorAttachment = {
      view: own?.createView() ?? c.color,
      loadOp: 'load',
      storeOp: 'store',
    };
    if (own && this.options.clear !== false) {
      attachment.loadOp = 'clear';
      const color = this.options.clear ?? mapColor(this.data.backgroundColor) ?? [0, 0, 0, 0];
      attachment.clearValue = this.options.clear
        ? [...color]
        : [color[0] * color[3], color[1] * color[3], color[2] * color[3], color[3]];
    }
    const format = own?.format ?? c.format,
      samples = own?.sampleCount ?? c.descriptor.multisample?.count ?? 1;
    const pipeline = quads.length ? this.pipeline(format, samples, depth.state) : undefined;
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [attachment],
      ...(depth.attachment ? { depthStencilAttachment: depth.attachment } : {}),
    });
    if (!own) applyView(pass, c);
    if (pipeline) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, state.group);
      pass.setVertexBuffer(0, state.vertices!);
      for (const run of runs) {
        pass.setBindGroup(1, this.textures.get(run.key)!.group);
        pass.draw(4, run.count, 0, run.first);
      }
    }
    pass.end();
    this.stats.draws = runs.length;
    this.stats.uploadedBytes = words.byteLength;
  }
  private pipeline(format: GPUTextureFormat, samples: number, depth?: GPUDepthStencilState): GPURenderPipeline {
    const key = `${format}/${samples}/${depth?.format ?? ''}/${depth?.depthCompare ?? ''}/${depth?.depthWriteEnabled ?? ''}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = this.device!.createRenderPipeline({
        layout: this.device!.createPipelineLayout({ bindGroupLayouts: [this.frameLayout!, this.textureLayout!] }),
        vertex: {
          module: this.module!,
          entryPoint: 'vertexMain',
          buffers: [
            {
              arrayStride: 48,
              stepMode: 'instance',
              attributes: [
                ...[0, 1, 2, 3, 4].map((i) => ({ shaderLocation: i, offset: i * 8, format: 'float32x2' as const })),
                { shaderLocation: 5, offset: 40, format: 'uint32' },
                { shaderLocation: 6, offset: 44, format: 'uint32' },
              ],
            },
          ],
        },
        fragment: {
          module: this.module!,
          entryPoint: 'fragmentMain',
          targets: [
            {
              format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-strip' },
        multisample: { count: samples },
        ...(depth ? { depthStencil: depth } : {}),
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}
