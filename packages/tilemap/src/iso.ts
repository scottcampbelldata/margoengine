/// <reference lib="esnext.disposable" preserve="true" />
// Isometric, staggered and hexagonal tile maps: the cell geometry of ./layout.ts and a renderer that draws the cells in
// view back to front, so tiles taller than their cell cover the ones behind them, with exact texels.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { atlasTexture } from '../../shared/atlas-texture.js';
import { texelVarying } from '../../shared/texel-varying.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { applyView, checkLayers, ViewStates } from '../../shared/view-rect.js';
import { animatedTile, mapColor } from './chunks.js';
import { FLIP_D, FLIP_H, FLIP_V, GID_MASK, type MapTileset, type TileLayer, type TileMapData } from './index.js';
import { cellBox, type MapGrid } from './layout.js';
import type { TileAtlas, TileCamera, TileMapStats, TileTarget } from './renderer.js';

export {
  cellBox,
  cellCenter,
  cellNeighbors,
  cellPolygon,
  mapPixelSize,
  paintOrder,
  pixelToCell,
  type CellBox,
  type MapGrid,
} from './layout.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type GridPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Tiled's bit 28 on hexagonal maps: the tile turned 120 degrees clockwise. Bit 29 (`FLIP_D`) turns it 60 degrees. */
export const HEX_ROTATE_120 = 0x10000000;

/** Settings of {@link GridTileMap}: those of a `TileMap`, for maps of any orientation. */
export interface GridTileMapOptions {
  /** The map to draw. Required. Any `orientation`. */
  map: TileMapData;
  /** The texels of each tileset by its name; a tileset no drawn tile uses can be left out. Required. */
  atlases: { readonly [tileset: string]: TileAtlas };
  /** Map pixels to target pixels, read each frame. Default `{x: 0, y: 0, zoom: 1}`. */
  camera?: TileCamera;
  /** Rounds each tile's corner to a whole target pixel, read each frame. Default true. */
  snap?: boolean;
  /** Names of the tile layers to draw, in map order. Default every tile layer. */
  mapLayers?: readonly string[];
  /** Scrolls each map layer by its own `parallax`, read each frame. Default true. */
  parallax?: boolean;
  /** Draw here instead of the canvas or the view's target. Default the frame's colour target. */
  target?: TileTarget;
  /** With `target`: the colour to clear it to first, or false. Default the map's `backgroundColor`, else transparent. */
  clear?: readonly [number, number, number, number] | false;
  /** Frame-graph order. Default 10. */
  order?: number;
  /** Render-layer bits. Default 1. */
  layers?: number;
  /** Plugin name, unique per scene. Default `grid-tilemap-1`, ... */
  name?: string;
}

const WORDS = 12;
const shader = /* wgsl */ `
struct Tile{p:vec2f,s:vec2f,texel:vec2f,size:vec2f,flags:u32,tint:u32,pad0:u32,pad1:u32}
@group(0) @binding(0) var<uniform> view:vec4f;
@group(0) @binding(1) var<storage,read> tiles:array<Tile>;
@group(1) @binding(0) var atlas:texture_2d<f32>;
${texelVarying}
@vertex fn vertexMain(@builtin(vertex_index) corner:u32,@builtin(instance_index) index:u32)->Varying{
  let t=tiles[index];
  let c=vec2f(f32(corner&1u),f32(corner>>1u));
  let hex=(t.flags&8u)!=0u;
  // Hexagonal maps turn the image about its centre by 60 degrees per step; the others flip the diagonal.
  let turns=select(0.0,f32(select(0u,1u,(t.flags&4u)!=0u)+select(0u,2u,(t.flags&16u)!=0u)),hex);
  let a=turns*1.0471975511965976;
  let q=(c-0.5)*t.s;
  let p=t.p+t.s*0.5+vec2f(q.x*cos(a)-q.y*sin(a),q.x*sin(a)+q.y*cos(a));
  var v:Varying;
  v.position=vec4f(p/view.xy*vec2f(2,-2)+vec2f(-1,1),0,1);
  // Screen to texture undoes the flips in reverse: Tiled applies the diagonal first, then horizontal and vertical.
  var s=c;
  if((t.flags&1u)!=0u){s.x=1-s.x;}
  if((t.flags&2u)!=0u){s.y=1-s.y;}
  if(!hex&&(t.flags&4u)!=0u){s=s.yx;}
  v.texel=t.texel+s*t.size;
  v.low=t.texel;
  v.high=t.texel+t.size-1;
  v.tint=unpack4x8unorm(t.tint);
  return v;
}
@fragment fn fragmentMain(v:Varying)->@location(0) vec4f{
  let color=textureLoad(atlas,vec2i(clamp(floor(v.texel),v.low,v.high)),0)*v.tint;
  if(color.a==0){discard;}
  return color;
}`;

interface SetRun {
  readonly set: MapTileset;
  readonly frames: Map<number, NonNullable<NonNullable<MapTileset['tiles']>[number]['animation']>>;
  atlas?: { texture: GPUTexture; owned: boolean };
  group?: GPUBindGroup;
}
interface ViewState {
  uniform: GPUBuffer;
  values: Float32Array<ArrayBuffer>;
  group?: GPUBindGroup;
  buffer?: GPUBuffer;
}
let mapCount = 0;

/** The visible cells of a layer in paint order, `y * width + x`, for a view of map pixels `[left, top, right, bottom]`. */
export function visibleCells(
  map: MapGrid,
  layer: Pick<TileLayer, 'width' | 'height'>,
  view: readonly [number, number, number, number],
  out: number[] = [],
): number[] {
  out.length = 0;
  const { width, height } = layer,
    tw = map.tileWidth,
    th = map.tileHeight,
    [left, top, right, bottom] = view,
    orientation = map.orientation ?? 'orthogonal';
  if (!width || !height || !(right > left && bottom > top)) return out;
  const clamp = (v: number, n: number) => Math.min(Math.max(v, 0), n - 1);
  if (orientation === 'isometric') {
    // A cell's box spans x - y from (2 left / tw - rows - 1) and x + y from (2 top / th - 2), give or take one.
    const rows = map.height,
      d1Low = Math.floor((2 * left) / tw) - rows - 1,
      d1High = Math.ceil((2 * right) / tw) - rows + 1,
      d2Low = Math.max(Math.floor((2 * top) / th) - 2, 0),
      d2High = Math.min(Math.ceil((2 * bottom) / th) + 1, width + height - 2);
    for (let d2 = d2Low; d2 <= d2High; d2++)
      for (let x = Math.max(0, d2 - height + 1); x <= Math.min(d2, width - 1); x++) {
        const d1 = 2 * x - d2;
        if (d1 >= d1Low && d1 <= d1High) out.push((d2 - x) * width + x);
      }
    return out;
  }
  const axisY = (map.staggerAxis ?? 'y') === 'y' || orientation === 'orthogonal',
    side = orientation === 'hexagonal' ? (map.hexSideLength ?? 0) : 0,
    step = orientation === 'orthogonal' ? (axisY ? th : tw) : ((axisY ? th : tw) + side) / 2,
    // Rows (y axis) or columns (x axis) the view touches, one more each way for the half-cell shift.
    a0 = Math.floor((axisY ? top : left) / step) - 2,
    a1 = Math.ceil((axisY ? bottom : right) / step) + 1,
    b0 = Math.floor((axisY ? left : top) / (axisY ? tw : th)) - 1,
    b1 = Math.ceil((axisY ? right : bottom) / (axisY ? tw : th)) + 1;
  const ys0 = clamp(axisY ? a0 : b0, height),
    ys1 = clamp(axisY ? a1 : b1, height),
    xs0 = clamp(axisY ? b0 : a0, width),
    xs1 = clamp(axisY ? b1 : a1, width);
  if (axisY) {
    for (let y = ys0; y <= ys1; y++) for (let x = xs0; x <= xs1; x++) out.push(y * width + x);
    return out;
  }
  // Each row draws its raised columns, then its lowered ones.
  const odd = (map.staggerIndex ?? 'odd') === 'odd';
  for (let y = ys0; y <= ys1; y++)
    for (const low of [false, true])
      for (let x = xs0; x <= xs1; x++) if ((((x & 1) === 1) === odd) === low) out.push(y * width + x);
  return out;
}

/**
 * Draws a {@link TileMapData} of any orientation (orthogonal, isometric, staggered or hexagonal), the cells in view
 * back to front, one draw per run of tiles from the same tileset. Tiles bigger than the cell sit on its bottom left, as
 * Tiled draws them. WebGPU only.
 * @throws MargoError `'unsupported'` on WebGL, `'disposed'` after `dispose()`, `'state'` for a missing atlas.
 */
export class GridTileMap implements EnginePlugin {
  readonly name: string;
  /** Map pixels to target pixels, read each frame. */
  camera: TileCamera;
  /** Rounds each tile's corner to a whole target pixel, read each frame. */
  snap: boolean;
  /** Scrolls each map layer by its own `parallax`, read each frame. */
  parallax: boolean;
  /** The animation clock in milliseconds. Each frame adds its delta. */
  time = 0;
  /** What the last frame cost: draws and bytes of tiles written. */
  readonly stats: TileMapStats = { draws: 0, uploadedBytes: 0 };
  private readonly order: number;
  private readonly layerMask: number;
  private readonly target?: TileTarget;
  private readonly clear?: readonly [number, number, number, number] | false;
  private readonly names?: readonly string[];
  private atlases: { [tileset: string]: TileAtlas };
  private data!: TileMapData;
  private sets: SetRun[] = [];
  private engine?: Engine;
  private device?: GPUDevice;
  private module?: GPUShaderModule;
  private frameLayout?: GPUBindGroupLayout;
  private atlasLayout?: GPUBindGroupLayout;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private words = new Uint32Array(0);
  private readonly floats = () => new Float32Array(this.words.buffer);
  private readonly cells: number[] = [];
  private disposed = false;
  private readonly states = new ViewStates<ViewState>(
    () => ({
      uniform: this.device!.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      values: new Float32Array(4),
    }),
    (state) => {
      state.uniform.destroy();
      state.buffer?.destroy();
    },
  );

  constructor(options: GridTileMapOptions) {
    if (!options?.map) throw typeError('GridTileMap needs a map', 'tilemap-options');
    if (!options.atlases) throw typeError('GridTileMap needs atlases', 'tilemap-options');
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
    this.layerMask = checkLayers(options.layers ?? 1, 'GridTileMap layers');
    this.name = options.name ?? `grid-tilemap-${++mapCount}`;
    this.setMap(options.map);
  }
  /** Creates a renderer and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: GridTileMapOptions): GridTileMap {
    const map = new GridTileMap(options);
    engineRuntime(instance).use(map);
    return map;
  }
  /** The map being drawn. Cells are read every frame, so writes into `layer.data` show on the next one. */
  get map(): TileMapData {
    return this.data;
  }
  /** Draws another map from the next frame. */
  setMap(map: TileMapData): void {
    cellBox(map, 0, 0);
    this.releaseSets();
    this.data = map;
    this.sets = [...map.tilesets]
      .sort((a, b) => a.firstGid - b.firstGid)
      .map((set) => ({
        set,
        frames: new Map((set.tiles ?? []).filter((t) => t.animation?.length).map((t) => [t.id, t.animation!])),
      }));
  }
  /** Swaps one tileset's atlas from the next frame. */
  setAtlas(tileset: string, atlas: TileAtlas): void {
    this.atlases[tileset] = atlas;
    for (const run of this.sets)
      if (run.set.name === tileset) {
        if (run.atlas?.owned) run.atlas.texture.destroy();
        run.atlas = run.group = undefined;
      }
  }
  setup(engine: Engine): void {
    if (this.disposed || engine.backend !== 'webgpu')
      throw fault(
        this.disposed ? 'disposed' : 'unsupported',
        this.disposed ? 'GridTileMap disposed' : 'GridTileMap needs WebGPU',
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
  private releaseSets(): void {
    for (const run of this.sets) if (run.atlas?.owned) run.atlas.texture.destroy();
    this.sets = [];
  }
  private releaseDevice(): void {
    this.states.clear();
    for (const run of this.sets) {
      if (run.atlas?.owned) run.atlas.texture.destroy();
      run.atlas = run.group = undefined;
    }
    this.pipelines.clear();
    this.module = this.frameLayout = this.atlasLayout = this.device = undefined;
  }
  private setFor(gid: number): number {
    const sets = this.sets;
    for (let s = sets.length - 1; s >= 0; s--) {
      const set = sets[s].set;
      if (gid >= set.firstGid) return gid < set.firstGid + set.tileCount ? s : -1;
    }
    return -1;
  }
  /** Writes every visible tile of the drawn layers in paint order; returns runs `[set, first, count]`. */
  private build(width: number, height: number): number[] {
    const map = this.data,
      camera = this.camera,
      hex = map.orientation === 'hexagonal',
      runs: number[] = [];
    let count = 0;
    const layers = map.layers.filter(
      (l): l is TileLayer =>
        l.type === 'tile' && (!this.names || this.names.includes(l.name)) && l.visible !== false && l.opacity !== 0,
    );
    // The tallest and widest tile any tileset draws, so cells just outside the view that reach into it are kept.
    let reachX = 0,
      reachY = 0;
    for (const { set } of this.sets) {
      reachX = Math.max(reachX, set.tileWidth - map.tileWidth + Math.abs(set.tileOffset?.[0] ?? 0));
      reachY = Math.max(reachY, set.tileHeight - map.tileHeight + Math.abs(set.tileOffset?.[1] ?? 0));
    }
    for (const layer of layers) {
      const px = this.parallax ? (layer.parallax?.[0] ?? 1) : 1,
        py = this.parallax ? (layer.parallax?.[1] ?? 1) : 1,
        ox = (layer.offset?.[0] ?? 0) - camera.x * px,
        oy = (layer.offset?.[1] ?? 0) - camera.y * py,
        tint = mapColor(layer.tint) ?? [1, 1, 1, 1],
        alpha = (layer.opacity ?? 1) * tint[3],
        packed =
          (Math.round(tint[0] * 255) |
            (Math.round(tint[1] * 255) << 8) |
            (Math.round(tint[2] * 255) << 16) |
            (Math.round(alpha * 255) << 24)) >>>
          0;
      visibleCells(
        map,
        layer,
        [-ox - reachX, -oy, width / camera.zoom - ox, height / camera.zoom - oy + reachY],
        this.cells,
      );
      if (this.words.length < (count + this.cells.length) * WORDS) {
        const grown = new Uint32Array(Math.max((count + this.cells.length) * WORDS, this.words.length * 2));
        grown.set(this.words);
        this.words = grown;
      }
      const words = this.words,
        floats = this.floats();
      for (const cell of this.cells) {
        const value = layer.data[cell],
          gid = value & GID_MASK;
        if (!gid) continue;
        const s = this.setFor(gid);
        if (s < 0) continue;
        const { set, frames } = this.sets[s],
          local = gid - set.firstGid,
          steps = frames.get(local),
          id = steps ? animatedTile(steps, this.time) : local,
          columns = set.columns,
          diagonal = !hex && (value & FLIP_D) !== 0,
          drawnW = diagonal ? set.tileHeight : set.tileWidth,
          drawnH = diagonal ? set.tileWidth : set.tileHeight;
        if (!(columns > 0)) throw fault('state', `Tileset ${set.name} has no atlas columns`, 'tilemap-options');
        const x = cell % layer.width,
          y = (cell - x) / layer.width,
          box = cellBox(map, x, y);
        let left = (ox + box.x + (set.tileOffset?.[0] ?? 0)) * camera.zoom,
          top = (oy + box.y + box.height - drawnH + (set.tileOffset?.[1] ?? 0)) * camera.zoom;
        if (this.snap) {
          left = Math.round(left);
          top = Math.round(top);
        }
        const at = count * WORDS,
          margin = set.margin ?? 0,
          spacing = set.spacing ?? 0;
        floats[at] = left;
        floats[at + 1] = top;
        floats[at + 2] = drawnW * camera.zoom;
        floats[at + 3] = drawnH * camera.zoom;
        floats[at + 4] = margin + (id % columns) * (set.tileWidth + spacing);
        floats[at + 5] = margin + Math.floor(id / columns) * (set.tileHeight + spacing);
        floats[at + 6] = set.tileWidth;
        floats[at + 7] = set.tileHeight;
        words[at + 8] =
          ((value & FLIP_H) !== 0 ? 1 : 0) |
          ((value & FLIP_V) !== 0 ? 2 : 0) |
          ((value & FLIP_D) !== 0 ? 4 : 0) |
          (hex ? 8 : 0) |
          (hex && (value & HEX_ROTATE_120) !== 0 ? 16 : 0);
        words[at + 9] = packed;
        if (runs.length && runs[runs.length - 3] === s && runs[runs.length - 2] + runs[runs.length - 1] === count)
          runs[runs.length - 1]++;
        else runs.push(s, count, 1);
        count++;
      }
    }
    return runs;
  }
  private group(device: GPUDevice, run: SetRun): GPUBindGroup {
    if (run.group) return run.group;
    const source = this.atlases[run.set.name];
    if (!source) throw fault('state', `No atlas for tileset ${run.set.name}`, 'tilemap-options');
    run.atlas ??= atlasTexture(device, source, () => rangeError('Invalid tile pixels', 'tilemap-options'));
    run.group = device.createBindGroup({
      layout: this.atlasLayout!,
      entries: [{ binding: 0, resource: run.atlas.texture.createView() }],
    });
    return run.group;
  }
  private draw(c: GridPassContext): void {
    const view = c.view;
    if (view?.layers !== undefined && !(view.layers & this.layerMask)) return;
    const own = this.target && (typeof this.target === 'function' ? this.target() : this.target);
    if (own && view?.index) return;
    const device = c.device,
      camera = this.camera;
    if (!(camera.zoom > 0) || !Number.isFinite(camera.x + camera.y + camera.zoom))
      throw rangeError('Invalid tile map camera', 'tilemap-options');
    if (this.device !== device) {
      if (this.device) this.releaseDevice();
      this.device = device;
    }
    if (!this.module) {
      this.module = device.createShaderModule({ label: 'grid tilemap', code: shader });
      this.frameLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      });
      this.atlasLayout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }],
      });
    }
    const width = own ? own.width : view ? view.viewport[2] : c.width,
      height = own ? own.height : view ? view.viewport[3] : c.height,
      format = own ? own.format : c.format,
      samples = own ? own.sampleCount : (c.descriptor.multisample?.count ?? 1);
    const runs = this.build(width, height),
      count = runs.length ? runs[runs.length - 2] + runs[runs.length - 1] : 0;
    // Everything that can throw comes before the pass opens.
    for (let r = 0; r < runs.length; r += 3) this.group(device, this.sets[runs[r]]);
    const state = this.states.get(c);
    if (count * WORDS * 4 > (state.buffer?.size ?? 0)) {
      state.buffer?.destroy();
      state.buffer = device.createBuffer({
        label: 'grid tilemap tiles',
        size: Math.max(count * WORDS * 4 * 2, 1024),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      state.group = undefined;
    }
    if (state.values[0] !== width || state.values[1] !== height) {
      state.values[0] = width;
      state.values[1] = height;
      device.queue.writeBuffer(state.uniform, 0, state.values);
    }
    state.group ??= device.createBindGroup({
      layout: this.frameLayout!,
      entries: [
        { binding: 0, resource: { buffer: state.uniform } },
        { binding: 1, resource: { buffer: state.buffer! } },
      ],
    });
    if (count) device.queue.writeBuffer(state.buffer!, 0, this.words, 0, count * WORDS);
    this.stats.draws = 0;
    this.stats.uploadedBytes = count * WORDS * 4;
    const attachment: GPURenderPassColorAttachment = { view: c.color, loadOp: 'load', storeOp: 'store' };
    if (own) {
      attachment.view = own.createView();
      if (this.clear !== false) {
        const clear: readonly number[] = this.clear ?? mapColor(this.data.backgroundColor) ?? [0, 0, 0, 0],
          a = clear[3];
        attachment.loadOp = 'clear';
        // Over a clear target the blend leaves premultiplied colours, so the clear colour matches them.
        attachment.clearValue = this.clear ? [...clear] : [clear[0] * a, clear[1] * a, clear[2] * a, a];
      }
    }
    const pass = c.encoder.beginRenderPass({ colorAttachments: [attachment] });
    if (!own) applyView(pass, c);
    if (count) {
      pass.setPipeline(this.pipeline(device, format, samples));
      pass.setBindGroup(0, state.group);
      for (let r = 0; r < runs.length; r += 3) {
        pass.setBindGroup(1, this.sets[runs[r]].group!);
        pass.draw(4, runs[r + 2], 0, runs[r + 1]);
        this.stats.draws++;
      }
    }
    pass.end();
  }
  private pipeline(device: GPUDevice, format: GPUTextureFormat, samples: number): GPURenderPipeline {
    const key = `${format}/${samples}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: 'grid tilemap',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout!, this.atlasLayout!] }),
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
}
