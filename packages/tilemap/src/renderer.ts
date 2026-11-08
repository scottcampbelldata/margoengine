/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { atlasTexture } from '../../shared/atlas-texture.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { applyView, checkLayers, ViewStates } from '../../shared/view-rect.js';
import {
  animatedTile,
  CHUNK_CELLS,
  chunkGrid,
  countTilesets,
  fillChunk,
  mapColor,
  tileReach,
  visibleChunks,
  type ChunkRange,
  type TileReach,
} from './chunks.js';
import type { MapTileset, TileLayer, TileMapData } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type TilePassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Straight-alpha RGBA8 texels, row by row from the top: `ImageData` fits. */
export interface TilePixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
/**
 * Where a tileset's texels come from. Pixels and `ImageBitmap`s are uploaded to an `rgba8unorm` texture the map owns and
 * uploads again after a device loss. A function is called with the device, also after a device loss. A plain
 * `GPUTexture` stays the caller's and needs {@link TileMap.setAtlas} after a device loss.
 */
export type TileAtlas = TilePixels | ImageBitmap | GPUTexture | ((device: GPUDevice) => GPUTexture);
/** A render target, or a function read each frame for one that changes. A pixel layer's `target` fits. */
export type TileTarget = GPUTexture | (() => GPUTexture);
/** Map pixels to target pixels: the map point at the top left and target pixels per map pixel. A pixel layer's `camera` fits. */
export interface TileCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Settings of {@link TileMap}, fixed when it is created except where a member says otherwise. */
export interface TileMapOptions {
  /** The map to draw. Required. */
  map: TileMapData;
  /** The texels of each tileset by its name; a tileset no drawn tile uses can be left out. Required. */
  atlases: { readonly [tileset: string]: TileAtlas };
  /** Read each frame. Default `{x: 0, y: 0, zoom: 1}`: map pixels are target pixels. */
  camera?: TileCamera;
  /** Rounds each layer's top left to a whole target pixel, read each frame. Default true. */
  snap?: boolean;
  /** Names of the tile layers to draw, in map order. Default every tile layer. */
  mapLayers?: readonly string[];
  /**
   * Scrolls each map layer by its own `parallax`, read each frame. Set it to false when the camera already carries it, as
   * a pixel layer's `camera` does. Default true.
   */
  parallax?: boolean;
  /** Draw here instead of the canvas or the view's target. Default the frame's colour target. */
  target?: TileTarget;
  /**
   * With `target`: the colour `[r, g, b, a]` (0 to 1) to clear it to first, or false to draw over it. Default the map's
   * `backgroundColor`, or `[0, 0, 0, 0]` without one.
   */
  clear?: readonly [number, number, number, number] | false;
  /** Frame-graph order. Runs after the scene (0); 40 draws after a Tonemap. Default 10. */
  order?: number;
  /** Render-layer bits; a view whose `layers` shares none leaves this map out. Default 1. */
  layers?: number;
  /** Plugin name, unique per scene. Default `tilemap-1`, `tilemap-2`, ... */
  name?: string;
}

/** What the last frame cost, for a budget check or a test. */
export interface TileMapStats {
  /** Draw calls in the last frame: one per visible chunk per tileset it uses. */
  draws: number;
  /** Bytes of tile values uploaded in the last frame: 16,384 per changed chunk. */
  uploadedBytes: number;
}

const shader = /* wgsl */ `
struct Layer{size:vec2f,origin:vec2f,cell:vec2f,zoom:f32,opacity:f32,tint:vec4f,chunks:u32}
struct Sheet{first:u32,count:u32,columns:u32,margin:u32,tile:vec2f,step:vec2f,offset:vec2f}
@group(0) @binding(0) var<uniform> layer:Layer;
@group(1) @binding(0) var<storage,read> cells:array<u32>;
@group(2) @binding(0) var<uniform> sheet:Sheet;
@group(2) @binding(1) var<storage,read> frames:array<u32>;
@group(2) @binding(2) var atlas:texture_2d<f32>;
struct Varying{
  @builtin(position) position:vec4f,
  @location(0) texel:vec2f,
  @location(1) @interpolate(flat) low:vec2f,
  @location(2) @interpolate(flat) high:vec2f,
}
@vertex fn vertexMain(@builtin(vertex_index) corner:u32,@builtin(instance_index) index:u32)->Varying{
  var v:Varying;
  let value=cells[index];
  let gid=value&0x0fffffffu;
  if(gid<sheet.first||gid>=sheet.first+sheet.count){v.position=vec4f(2,2,2,1);return v;}
  let id=frames[gid-sheet.first];
  let chunk=index/4096u;
  let inner=index%4096u;
  let tile=vec2u(chunk%layer.chunks,chunk/layer.chunks)*64u+vec2u(inner%64u,inner/64u);
  let c=vec2f(f32(corner&1u),f32(corner>>1u));
  let diagonal=(value&0x20000000u)!=0u;
  let drawn=select(sheet.tile,sheet.tile.yx,diagonal);
  let place=vec2f(tile)*layer.cell+vec2f(0,layer.cell.y-drawn.y)+sheet.offset;
  let p=layer.origin+(place+c*drawn)*layer.zoom;
  v.position=vec4f(p/layer.size*vec2f(2,-2)+vec2f(-1,1),0,1);
  // Screen to texture undoes the flips in reverse: Tiled applies the diagonal first, then horizontal and vertical.
  var s=c;
  if((value&0x80000000u)!=0u){s.x=1-s.x;}
  if((value&0x40000000u)!=0u){s.y=1-s.y;}
  if(diagonal){s=s.yx;}
  let corner0=vec2f(f32(sheet.margin))+vec2f(f32(id%sheet.columns),f32(id/sheet.columns))*sheet.step;
  v.texel=corner0+s*sheet.tile;
  v.low=corner0;
  v.high=corner0+sheet.tile-1;
  return v;
}
@fragment fn fragmentMain(v:Varying)->@location(0) vec4f{
  var color=textureLoad(atlas,vec2i(clamp(floor(v.texel),v.low,v.high)),0)*layer.tint;
  color.a*=layer.opacity;
  if(color.a==0){discard;}
  return color;
}`;

/** Bytes per drawn layer in the uniform buffer: the largest `minUniformBufferOffsetAlignment` WebGPU allows. */
const STRIDE = 256;
const LAYER_BYTES = 64;
const SET_BYTES = 40;

interface Owned {
  texture: GPUTexture;
  owned: boolean;
}
interface SetRun {
  readonly set: MapTileset;
  readonly animated: readonly {
    id: number;
    steps: NonNullable<NonNullable<MapTileset['tiles']>[number]['animation']>;
  }[];
  frames: Uint32Array<ArrayBuffer>;
  framesBuffer?: GPUBuffer;
  uniform?: GPUBuffer;
  atlas?: Owned;
  group?: GPUBindGroup;
}
interface LayerRun {
  readonly layer: TileLayer;
  readonly chunksWide: number;
  readonly chunksHigh: number;
  /** Cells of each tileset per chunk: `counts[chunk * tilesets + tileset]`. */
  readonly counts: Uint32Array;
  /** Which tilesets any chunk of this layer uses. */
  readonly used: Uint8Array;
  readonly dirty: Set<number>;
  buffer?: GPUBuffer;
  group?: GPUBindGroup;
}
interface ViewState {
  buffer?: GPUBuffer;
  group?: GPUBindGroup;
  values: Float32Array<ArrayBuffer>;
}
let mapCount = 0;

/**
 * Draws a {@link TileMapData}'s tile layers, one instanced draw per visible 64 x 64 chunk per tileset, with exact pixels
 * when the target has one sample per pixel. Tile values live in a storage buffer and only changed chunks go up again.
 * Animated tiles change a small lookup in the shader, not the cells. Orthogonal maps only; object layers are not drawn.
 * WebGPU only.
 * @throws TypeError / RangeError on invalid options or, in a frame, a tileset with no atlas or larger than its atlas.
 * @throws MargoError `'unsupported'` on a WebGL engine or for a drawn image-collection tileset, `'disposed'` after
 * `dispose()`, `'state'` for a plain `GPUTexture` atlas after a device loss.
 */
export class TileMap implements EnginePlugin {
  readonly name: string;
  /** Map pixels to target pixels, read each frame. */
  camera: TileCamera;
  /** Rounds each layer's top left to a whole target pixel, read each frame. */
  snap: boolean;
  /** Scrolls each map layer by its own `parallax`, read each frame. */
  parallax: boolean;
  /** The animation clock in milliseconds. Each frame adds its delta; set it to jump or to hold a frame. */
  time = 0;
  /** What the last frame cost. */
  readonly stats: TileMapStats = { draws: 0, uploadedBytes: 0 };
  private readonly order: number;
  private readonly layerMask: number;
  private readonly target?: TileTarget;
  private readonly clear?: readonly [number, number, number, number] | false;
  private readonly names?: readonly string[];
  private atlases: { [tileset: string]: TileAtlas };
  private data!: TileMapData;
  private sets: SetRun[] = [];
  private runs: LayerRun[] = [];
  private reach!: TileReach;
  private engine?: Engine;
  private device?: GPUDevice;
  private stale = new Set<string>();
  private module?: GPUShaderModule;
  private layerLayout?: GPUBindGroupLayout;
  private cellsLayout?: GPUBindGroupLayout;
  private setLayout?: GPUBindGroupLayout;
  private pipelineLayout?: GPUPipelineLayout;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly chunk = new Uint32Array(CHUNK_CELLS);
  private readonly range: ChunkRange = { firstX: 0, firstY: 0, lastX: -1, lastY: -1 };
  private readonly offsets = new Uint32Array(1);
  private readonly next = new Float32Array(LAYER_BYTES / 4);
  private readonly words = new Uint32Array(this.next.buffer);
  private animatedAt = NaN;
  private disposed = false;
  private readonly states = new ViewStates<ViewState>(
    () => ({ values: new Float32Array(0) }),
    (state) => state.buffer?.destroy(),
  );
  private readonly attachments: GPURenderPassColorAttachment[] = [
    { view: undefined!, loadOp: 'load', storeOp: 'store' },
  ];
  private readonly pass = { colorAttachments: this.attachments };
  private targetTexture?: GPUTexture;
  private targetView?: GPUTextureView;

  constructor(options: TileMapOptions) {
    if (!options?.map) throw typeError('TileMap needs a map', 'tilemap-options');
    if (!options.atlases) throw typeError('TileMap needs atlases', 'tilemap-options');
    const order = options.order ?? 10;
    if (!Number.isFinite(order)) throw rangeError('Invalid tile map order', 'tilemap-options');
    if (options.clear && (options.clear.length !== 4 || !options.clear.every(Number.isFinite)))
      throw rangeError('Invalid tile map clear', 'tilemap-options');
    this.atlases = { ...options.atlases };
    this.names = options.mapLayers;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.snap = options.snap ?? true;
    this.parallax = options.parallax ?? true;
    this.target = options.target;
    this.clear = options.clear;
    this.order = order;
    this.layerMask = checkLayers(options.layers ?? 1, 'TileMap layers');
    this.name = options.name ?? `tilemap-${++mapCount}`;
    this.setMap(options.map);
  }
  /** Creates a map renderer and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: TileMapOptions): TileMap {
    const map = new TileMap(options);
    engineRuntime(instance).use(map);
    return map;
  }
  /** The map being drawn. */
  get map(): TileMapData {
    return this.data;
  }
  /** Draws another map from the next frame: everything goes up again. */
  setMap(map: TileMapData): void {
    if (this.disposed) throw fault('disposed', 'TileMap disposed', 'disposed');
    if (!map) throw typeError('TileMap needs a map', 'tilemap-options');
    if ((map.orientation ?? 'orthogonal') !== 'orthogonal')
      throw rangeError('TileMap draws orthogonal maps; draw this one with GridTileMap', 'tilemap-options');
    const tiles = map.layers.filter((layer): layer is TileLayer => layer.type === 'tile');
    for (const name of this.names ?? [])
      if (!tiles.some((layer) => layer.name === name)) throw rangeError('Unknown tile layer', 'tilemap-options');
    this.releaseMap();
    this.data = map;
    const sets = [...map.tilesets].sort((a, b) => a.firstGid - b.firstGid);
    this.sets = sets.map((set) => {
      const frames = new Uint32Array(Math.max(1, set.tileCount));
      for (let i = 0; i < frames.length; i++) frames[i] = i;
      return {
        set,
        frames,
        animated: (set.tiles ?? []).flatMap((tile) =>
          tile.animation?.length ? [{ id: tile.id, steps: tile.animation }] : [],
        ),
      };
    });
    this.reach = tileReach(sets, map.tileWidth, map.tileHeight);
    this.runs = tiles
      .filter((layer) => !this.names || this.names.includes(layer.name))
      .map((layer) => {
        const { chunksWide, chunksHigh } = chunkGrid(layer.width, layer.height),
          chunks = chunksWide * chunksHigh,
          dirty = new Set<number>();
        for (let i = 0; i < chunks; i++) dirty.add(i);
        return {
          layer,
          chunksWide,
          chunksHigh,
          counts: new Uint32Array(chunks * sets.length),
          used: new Uint8Array(sets.length),
          dirty,
        };
      });
    this.animatedAt = NaN;
  }
  /** Replaces a tileset's atlas from the next frame. */
  setAtlas(tileset: string, atlas: TileAtlas): void {
    if (!atlas) throw typeError('TileMap needs atlases', 'tilemap-options');
    this.atlases[tileset] = atlas;
    this.stale.delete(tileset);
    for (const run of this.sets)
      if (run.set.name === tileset) {
        if (run.atlas?.owned) run.atlas.texture.destroy();
        run.atlas = run.group = undefined;
      }
  }
  /**
   * Sets one cell of a tile layer. Only that cell's chunk goes up, on the next frame. Writes straight into `layer.data`
   * need {@link invalidate} instead.
   * @throws RangeError for a cell outside the layer or a layer of another map.
   */
  setTile(layer: TileLayer | string, x: number, y: number, value: number): void {
    const run = this.runFor(layer);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= run.layer.width || y >= run.layer.height)
      throw rangeError('Tile outside the layer', 'tilemap-options');
    run.layer.data[y * run.layer.width + x] = value;
    run.dirty.add((y >> 6) * run.chunksWide + (x >> 6));
  }
  /** Sends a layer's cells up again on the next frame, after writing into `layer.data` yourself. Default every layer. */
  invalidate(layer?: TileLayer | string): void {
    for (const run of layer === undefined ? this.runs : [this.runFor(layer)])
      for (let i = 0; i < run.chunksWide * run.chunksHigh; i++) run.dirty.add(i);
  }
  setup(engine: Engine): void {
    if (this.disposed || engine.backend !== 'webgpu')
      throw fault(
        this.disposed ? 'disposed' : 'unsupported',
        this.disposed ? 'TileMap disposed' : 'TileMap needs WebGPU',
        this.disposed ? 'disposed' : 'webgpu',
      );
    this.engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) {
      this.states.prune();
      this.time += delta * 1000;
    }
    this.stats.draws = this.stats.uploadedBytes = 0;
  }
  onDeviceRestored(): void {
    for (const run of this.sets)
      if (run.atlas && !run.atlas.owned && typeof this.atlases[run.set.name] !== 'function')
        this.stale.add(run.set.name);
    this.releaseDevice();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.engine = undefined;
    this.releaseDevice();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private runFor(layer: TileLayer | string): LayerRun {
    const run = this.runs.find((r) => r.layer === layer || r.layer.name === layer);
    if (!run) throw rangeError('Unknown tile layer', 'tilemap-options');
    return run;
  }
  private releaseMap(): void {
    for (const run of this.sets) {
      if (run.atlas?.owned) run.atlas.texture.destroy();
      run.framesBuffer?.destroy();
      run.uniform?.destroy();
    }
    for (const run of this.runs) run.buffer?.destroy();
  }
  private releaseDevice(): void {
    this.states.clear();
    this.releaseMap();
    for (const run of this.sets) run.atlas = run.framesBuffer = run.uniform = run.group = undefined;
    for (const run of this.runs) {
      run.buffer = run.group = undefined;
      for (let i = 0; i < run.chunksWide * run.chunksHigh; i++) run.dirty.add(i);
    }
    this.module = this.layerLayout = this.cellsLayout = this.setLayout = this.pipelineLayout = this.device = undefined;
    this.targetTexture = undefined;
    this.targetView = undefined;
    this.pipelines.clear();
    this.animatedAt = NaN;
  }
  private prepare(device: GPUDevice): void {
    if (this.device !== device) {
      if (this.device) this.releaseDevice();
      this.device = device;
    }
    if (this.module) return;
    this.layerLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: LAYER_BYTES },
        },
      ],
    });
    this.cellsLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }],
    });
    this.setLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.layerLayout, this.cellsLayout, this.setLayout],
    });
    this.module = device.createShaderModule({ label: 'tilemap', code: shader });
  }
  private pipeline(device: GPUDevice, format: GPUTextureFormat, samples: number): GPURenderPipeline {
    const key = `${format}/${samples}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: 'tilemap',
        layout: this.pipelineLayout!,
        vertex: { module: this.module!, entryPoint: 'vertexMain' },
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
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  /** Sends changed chunks up and recounts their tilesets. Several views in a frame upload once. */
  private flush(device: GPUDevice): void {
    const count = this.sets.length,
      tilesets = this.sets.map((run) => run.set);
    for (const run of this.runs) {
      const { layer, chunksWide } = run;
      if (!run.buffer && chunksWide) {
        const size = run.chunksWide * run.chunksHigh * CHUNK_CELLS * 4;
        if (size > device.limits.maxStorageBufferBindingSize)
          throw rangeError('Tile layer too large for the device', 'tilemap-options');
        run.buffer = device.createBuffer({
          label: 'tilemap cells',
          size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        run.group = device.createBindGroup({
          layout: this.cellsLayout!,
          entries: [{ binding: 0, resource: { buffer: run.buffer } }],
        });
      }
      for (const index of run.dirty) {
        fillChunk(layer, index % chunksWide, Math.floor(index / chunksWide), this.chunk);
        countTilesets(this.chunk, tilesets, run.counts, index * count);
        device.queue.writeBuffer(run.buffer!, index * CHUNK_CELLS * 4, this.chunk);
        this.stats.uploadedBytes += CHUNK_CELLS * 4;
      }
      if (run.dirty.size) {
        run.used.fill(0);
        for (let i = 0; i < run.counts.length; i++) if (run.counts[i]) run.used[i % count] = 1;
      }
      run.dirty.clear();
    }
  }
  /** The bind group of a tileset some cell uses; made on first use, so an unused tileset needs no atlas. */
  private setGroup(device: GPUDevice, run: SetRun): GPUBindGroup {
    if (run.group) return run.group;
    const { set } = run,
      spacing = set.spacing ?? 0,
      margin = set.margin ?? 0;
    if (!set.columns) throw fault('unsupported', 'Image collection tilesets are not drawn', 'tilemap-state');
    if (this.stale.has(set.name))
      throw fault('state', 'Tile atlas lost with the device; call setAtlas', 'tilemap-state');
    const source = this.atlases[set.name];
    if (!source) throw typeError('Tileset has no atlas', 'tilemap-options');
    run.atlas ??= atlasTexture(device, source, () => rangeError('Invalid tile atlas pixels', 'tilemap-options'));
    const texture = run.atlas.texture,
      rows = Math.ceil(set.tileCount / set.columns);
    if (
      margin + set.columns * (set.tileWidth + spacing) - spacing > texture.width ||
      margin + rows * (set.tileHeight + spacing) - spacing > texture.height
    )
      throw rangeError('Tileset larger than its atlas', 'tilemap-options');
    if (!run.uniform) {
      const bytes = new ArrayBuffer(SET_BYTES),
        words = new Uint32Array(bytes),
        floats = new Float32Array(bytes);
      words[0] = set.firstGid;
      words[1] = set.tileCount;
      words[2] = set.columns;
      words[3] = margin;
      floats[4] = set.tileWidth;
      floats[5] = set.tileHeight;
      floats[6] = set.tileWidth + spacing;
      floats[7] = set.tileHeight + spacing;
      floats[8] = set.tileOffset?.[0] ?? 0;
      floats[9] = set.tileOffset?.[1] ?? 0;
      run.uniform = device.createBuffer({
        label: 'tilemap set',
        size: SET_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(run.uniform, 0, bytes);
      run.framesBuffer = device.createBuffer({
        label: 'tilemap frames',
        size: run.frames.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(run.framesBuffer, 0, run.frames);
    }
    run.group = device.createBindGroup({
      layout: this.setLayout!,
      entries: [
        { binding: 0, resource: { buffer: run.uniform } },
        { binding: 1, resource: { buffer: run.framesBuffer! } },
        { binding: 2, resource: texture.createView() },
      ],
    });
    return run.group;
  }
  /** Writes the frames that changed since the last time this clock value was drawn. */
  private animate(device: GPUDevice): void {
    if (this.animatedAt === this.time) return;
    this.animatedAt = this.time;
    for (const run of this.sets)
      for (const { id, steps } of run.animated) {
        const shown = animatedTile(steps, this.time);
        if (shown >= 0 && run.frames[id] !== shown) {
          run.frames[id] = shown;
          if (run.framesBuffer) device.queue.writeBuffer(run.framesBuffer, id * 4, run.frames, id, 1);
        }
      }
  }
  /** The layer's top left in target pixels. */
  private origin(run: LayerRun, camera: TileCamera, axis: 0 | 1): number {
    const { layer } = run,
      place =
        (layer.offset?.[axis] ?? 0) -
        (axis ? camera.y : camera.x) * (this.parallax ? (layer.parallax?.[axis] ?? 1) : 1),
      pixels = place * camera.zoom;
    return this.snap ? Math.round(pixels) : pixels;
  }
  private draw(c: TilePassContext): void {
    const view = c.view;
    if (view?.layers !== undefined && !(view.layers & this.layerMask)) return;
    const own = this.target && (typeof this.target === 'function' ? this.target() : this.target);
    // A map with its own target draws once a frame, however many views the frame has.
    if (own && view?.index) return;
    const device = c.device,
      camera = this.camera;
    if (!(camera.zoom > 0) || !Number.isFinite(camera.x + camera.y + camera.zoom))
      throw rangeError('Invalid tile map camera', 'tilemap-options');
    this.prepare(device);
    this.flush(device);
    this.animate(device);
    const width = own ? own.width : view ? view.viewport[2] : c.width,
      height = own ? own.height : view ? view.viewport[3] : c.height,
      format = own ? own.format : c.format,
      samples = own ? own.sampleCount : (c.descriptor.multisample?.count ?? 1),
      color = this.attachments[0];
    color.view = c.color;
    color.loadOp = 'load';
    if (own) {
      if (own !== this.targetTexture) {
        this.targetTexture = own;
        this.targetView = own.createView();
      }
      color.view = this.targetView!;
      if (this.clear !== false) {
        const clear: readonly number[] = this.clear ?? mapColor(this.data.backgroundColor) ?? [0, 0, 0, 0],
          a = clear[3];
        color.loadOp = 'clear';
        // Over a clear target the blend leaves premultiplied colours, so the clear colour matches them.
        color.clearValue = this.clear ? [...clear] : [clear[0] * a, clear[1] * a, clear[2] * a, a];
      }
    }
    const state = this.states.get(c),
      runs = this.runs,
      floats = runs.length * (STRIDE / 4);
    if (floats && state.values.length < floats) {
      state.values = new Float32Array(floats);
      state.buffer?.destroy();
      state.buffer = device.createBuffer({
        label: 'tilemap layers',
        size: state.values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      state.group = device.createBindGroup({
        layout: this.layerLayout!,
        entries: [{ binding: 0, resource: { buffer: state.buffer, size: LAYER_BYTES } }],
      });
    }
    // Everything that can throw comes before the pass opens.
    for (const run of runs)
      if (run.layer.visible !== false && run.layer.opacity !== 0)
        for (let s = 0; s < this.sets.length; s++) if (run.used[s]) this.setGroup(device, this.sets[s]);
    const pass = c.encoder.beginRenderPass(this.pass);
    if (!own) applyView(pass, c);
    pass.setPipeline(this.pipeline(device, format, samples));
    const sets = this.sets,
      map = this.data,
      next = this.next,
      range = this.range;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i],
        { layer, chunksWide, chunksHigh } = run,
        opacity = layer.opacity ?? 1;
      if (layer.visible === false || !opacity || !chunksWide) continue;
      const originX = this.origin(run, camera, 0),
        originY = this.origin(run, camera, 1),
        tint = mapColor(layer.tint) ?? [1, 1, 1, 1];
      next[0] = width;
      next[1] = height;
      next[2] = originX;
      next[3] = originY;
      next[4] = map.tileWidth;
      next[5] = map.tileHeight;
      next[6] = camera.zoom;
      next[7] = opacity;
      next.set(tint, 8);
      this.words[12] = chunksWide;
      const at = i * (STRIDE / 4);
      let changed = false;
      for (let f = 0; f < next.length; f++)
        if (state.values[at + f] !== next[f]) {
          state.values[at + f] = next[f];
          changed = true;
        }
      if (changed) device.queue.writeBuffer(state.buffer!, at * 4, state.values, at, LAYER_BYTES / 4);
      visibleChunks(
        originX,
        originY,
        camera.zoom,
        width,
        height,
        map.tileWidth,
        map.tileHeight,
        chunksWide,
        chunksHigh,
        this.reach,
        range,
      );
      this.offsets[0] = i * STRIDE;
      pass.setBindGroup(0, state.group!, this.offsets);
      pass.setBindGroup(1, run.group!);
      for (let s = 0; s < sets.length; s++) {
        if (!run.used[s]) continue;
        pass.setBindGroup(2, sets[s].group!);
        for (let y = range.firstY; y <= range.lastY; y++)
          for (let x = range.firstX; x <= range.lastX; x++) {
            const chunk = y * chunksWide + x;
            if (!run.counts[chunk * sets.length + s]) continue;
            pass.draw(4, CHUNK_CELLS, 0, chunk * CHUNK_CELLS);
            this.stats.draws++;
          }
      }
    }
    pass.end();
  }
}
