/// <reference lib="esnext.disposable" preserve="true" />
// Camera-facing sprites in a 3D scene: one instanced draw per view, depth tested against the scene, sized in world units
// (shrinking with distance) or in pixels (markers). The quad is built in the vertex shader from the camera's right and up
// axes, the usual view-plane construction (Akenine-Moller, Haines and Hoffman, Real-Time Rendering, 4th ed., 13.6).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { atlasTexture } from '../../shared/atlas-texture.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { overlayDepthPass, overlayPass } from '../../shared/pass.js';
import { viewMatrix } from '../../shared/view.js';
import { applyView, checkLayers, ViewStates } from '../../shared/view-rect.js';
import { parseTint } from './sprite.js';
import type { SpriteAtlas } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type BillboardPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Floats per billboard in the instance buffer (64 bytes). See {@link packBillboards} for the layout. */
export const BILLBOARD_FLOATS = 16;

/** Every setting of a {@link Billboard}; each is optional and has the default the field states. */
export interface BillboardOptions {
  x?: number;
  y?: number;
  z?: number;
  width?: number;
  height?: number;
  pivotX?: number;
  pivotY?: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  tint?: number | string;
  alpha?: number;
  rect?: readonly [number, number, number, number];
  visible?: boolean;
}

/** One camera-facing image in a {@link BillboardLayer}. Change any field at any time; the layer reads them each frame. */
export class Billboard implements BillboardOptions {
  /** World x of the pivot. Default 0. */
  x = 0;
  /** World y of the pivot (y up, as in the 3D scene). Default 0. */
  y = 0;
  /** World z of the pivot. Default 0. */
  z = 0;
  /** Width in world units, or in pixels on a layer with `sizeAttenuation: false`. Default 1. */
  width = 1;
  /** Height in world units, or in pixels on a layer with `sizeAttenuation: false`. Default 1. */
  height = 1;
  /** Where the pivot sits across the image, 0 left to 1 right. Default 0.5. */
  pivotX = 0.5;
  /** Where the pivot sits down the image, 0 top to 1 bottom; 1 stands the image on its pivot. Default 0.5. */
  pivotY = 0.5;
  /** Clockwise turn on screen about the pivot, in radians. Default 0. */
  rotation = 0;
  /** Mirrors the image left to right. Default false. */
  flipX = false;
  /** Mirrors the image top to bottom. Default false. */
  flipY = false;
  /** Opacity, 0 to 1, multiplied with the atlas alpha. Default 1. */
  alpha = 1;
  /** Atlas rectangle `[x, y, width, height]` in whole texels. Default the whole atlas. */
  rect?: readonly [number, number, number, number];
  /** False leaves the billboard out of the draw. Default true. */
  visible = true;
  /** @internal Add order, the last sort key. */
  index = 0;
  /** @internal The layer that holds this billboard. */
  owner?: object;
  private color = 0xffffff;

  constructor(options: BillboardOptions = {}) {
    Object.assign(this, options);
  }
  /** Colour multiplied with the atlas: set `0xrrggbb`, `'#rrggbb'` or `'#rgb'`, read `0xrrggbb`. Default white. */
  get tint(): number {
    return this.color;
  }
  set tint(value: number | string) {
    this.color = parseTint(value);
  }
}

/** The range of floats a {@link packBillboards} call changed, and how many billboards it wrote. */
export interface PackedBillboards {
  count: number;
  start: number;
  end: number;
}

/**
 * Writes `boards` in the given order into `data` (at least `boards.length * BILLBOARD_FLOATS` long) and reports which
 * floats changed. Hidden ones are skipped. Per billboard: world position (0 to 2), rotation (3), size (4, 5), pivot
 * fractions (6, 7), atlas origin (8, 9) and signed atlas size in texels (10, 11, a flip moves the origin to the far edge
 * and negates the size), tint as RGBA8 with red in the low byte (12), then three unused floats.
 * @throws RangeError for a non-finite value, a size not above 0, or a rectangle outside the atlas or not whole texels.
 */
export function packBillboards(
  boards: readonly Billboard[],
  data: Float32Array,
  atlasWidth: number,
  atlasHeight: number,
): PackedBillboards {
  const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
  let at = 0,
    start = -1,
    end = 0;
  const put = (value: number) => {
    if (data[at] !== value) {
      data[at] = value;
      if (start < 0) start = at;
      end = at + 1;
    }
    at++;
  };
  for (const b of boards) {
    if (!b.visible) continue;
    if (
      !Number.isFinite(b.x + b.y + b.z + b.width + b.height + b.pivotX + b.pivotY + b.rotation + b.alpha) ||
      !(b.width > 0) ||
      !(b.height > 0) ||
      b.alpha < 0 ||
      b.alpha > 1
    )
      throw rangeError('Invalid billboard', 'sprite-options');
    const [rx, ry, rw, rh] = b.rect ?? [0, 0, atlasWidth, atlasHeight];
    if (
      !Number.isInteger(rx) ||
      !Number.isInteger(ry) ||
      !Number.isInteger(rw) ||
      !Number.isInteger(rh) ||
      rx < 0 ||
      ry < 0 ||
      rw < 1 ||
      rh < 1 ||
      rx + rw > atlasWidth ||
      ry + rh > atlasHeight
    )
      throw rangeError('Invalid billboard rect', 'sprite-options');
    put(b.x);
    put(b.y);
    put(b.z);
    put(b.rotation);
    put(b.width);
    put(b.height);
    put(b.pivotX);
    put(b.pivotY);
    put(b.flipX ? rx + rw : rx);
    put(b.flipY ? ry + rh : ry);
    put(b.flipX ? -rw : rw);
    put(b.flipY ? -rh : rh);
    const tint = b.tint,
      packed = ((tint >> 16) | (tint & 0xff00) | ((tint & 0xff) << 16) | (Math.round(b.alpha * 255) << 24)) >>> 0;
    if (bits[at] !== packed) {
      bits[at] = packed;
      if (start < 0) start = at;
      end = at + 1;
    }
    at++;
    put(0);
    put(0);
    put(0);
  }
  return { count: at / BILLBOARD_FLOATS, start: start < 0 ? end : start, end };
}

/**
 * Puts `boards` back to front from `eye` in place (farthest first), by squared distance, then by add order, so blended
 * billboards cover each other in the right order.
 */
export function sortBillboards(boards: Billboard[], eye: readonly [number, number, number]): void {
  const d = (b: Billboard) => (b.x - eye[0]) ** 2 + (b.y - eye[1]) ** 2 + (b.z - eye[2]) ** 2;
  boards.sort((a, b) => d(b) - d(a) || a.index - b.index);
}

/** Settings of {@link BillboardLayer}, fixed when it is created except where a member says otherwise. */
export interface BillboardLayerOptions {
  /** The texels billboards cut their rectangles from, read with no filtering. Required. */
  atlas: SpriteAtlas;
  /** True sizes billboards in world units, so they shrink with distance; false sizes them in pixels. Read each frame. Default true. */
  sizeAttenuation?: boolean;
  /** Keeps billboards upright: they turn about world +Y only, for trees and grass. Read each frame. Default false. */
  lockY?: boolean;
  /**
   * False (default): cut-out. Texels with alpha under `alphaTest` are dropped, the rest draw opaque and write depth, so
   * order does not matter. True: blended with straight alpha, sorted back to front, depth tested without writing it.
   */
  transparent?: boolean;
  /** With `transparent: false`, the alpha under which a texel is dropped, 0 to 1. Read each frame. Default 0.5. */
  alphaTest?: number;
  /** Frame-graph order. Default 15: after the scene (0), before text (22) and post-processing (30). */
  order?: number;
  /** Render-layer bits; a view whose `layers` shares none leaves this layer out. Default 1. */
  layers?: number;
  /** Billboards the buffer holds before it grows, at least 1. Default 256. */
  capacity?: number;
  /** Plugin name, unique per scene. Default `billboards-1`, `billboards-2`, ... */
  name?: string;
}

const shader = /* wgsl */ `
struct Frame{viewProj:mat4x4f,right:vec4f,up:vec4f,size:vec2f,cut:f32,flags:u32}
struct Board{p:vec3f,turn:f32,s:vec2f,pivot:vec2f,rect:vec4f,tint:u32,a:u32,b:u32,c:u32}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> boards:array<Board>;
@group(0) @binding(2) var atlas:texture_2d<f32>;
struct Varying{
  @builtin(position) position:vec4f,
  @location(0) texel:vec2f,
  @location(1) @interpolate(flat) low:vec2f,
  @location(2) @interpolate(flat) high:vec2f,
  @location(3) @interpolate(flat) tint:vec4f,
}
fn linear(c:vec3f)->vec3f{return select(pow((c+0.055)/1.055,vec3f(2.4)),c/12.92,c<=vec3f(0.04045));}
@vertex fn vertexMain(@builtin(vertex_index) corner:u32,@builtin(instance_index) index:u32)->Varying{
  let b=boards[index];
  let c=vec2f(f32(corner&1u),f32(corner>>1u));
  let q=(c-b.pivot)*b.s*vec2f(1,-1);
  let x=cos(b.turn);
  let y=sin(b.turn);
  let r=vec2f(q.x*x+q.y*y,q.y*x-q.x*y);
  var v:Varying;
  if((frame.flags&1u)!=0u){
    v.position=frame.viewProj*vec4f(b.p+frame.right.xyz*r.x+frame.up.xyz*r.y,1);
  }else{
    let p=frame.viewProj*vec4f(b.p,1);
    v.position=vec4f(p.xy+r*2/frame.size*p.w,p.zw);
  }
  v.texel=b.rect.xy+b.rect.zw*c;
  v.low=min(b.rect.xy,b.rect.xy+b.rect.zw);
  v.high=max(b.rect.xy,b.rect.xy+b.rect.zw)-1;
  v.tint=unpack4x8unorm(b.tint);
  return v;
}
@fragment fn fragmentMain(v:Varying)->@location(0) vec4f{
  var color=textureLoad(atlas,vec2i(clamp(floor(v.texel),v.low,v.high)),0)*v.tint;
  if(color.a==0||color.a<frame.cut){discard;}
  if((frame.flags&4u)!=0u){color=vec4f(linear(color.rgb),color.a);}
  if((frame.flags&2u)==0u){color.a=1;}
  return color;
}`;

interface ViewState {
  uniform: GPUBuffer;
  frame: ArrayBuffer;
  floats: Float32Array<ArrayBuffer>;
  uints: Uint32Array<ArrayBuffer>;
  buffer?: GPUBuffer;
  data: Float32Array<ArrayBuffer>;
  group?: GPUBindGroup;
  generation: number;
  fresh: boolean;
}
interface OwnedAtlas {
  texture: GPUTexture;
  owned: boolean;
}
let layerCount = 0;

/**
 * Camera-facing sprites in a 3D scene, drawn in one instanced draw per view after the scene and depth tested against
 * it. Sizes are world units that shrink with distance, or pixels with `sizeAttenuation: false`. Texels go through with
 * no filtering; on an sRGB or float target they are decoded from sRGB, like any colour texture. WebGPU only.
 * @throws TypeError / RangeError on invalid options or, each frame, an invalid billboard.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'attached'` when a billboard is
 * already in a layer, `'state'` for a plain `GPUTexture` atlas after a device loss.
 */
export class BillboardLayer implements EnginePlugin {
  readonly name: string;
  /** Sizes are world units when true, pixels when false. Read each frame. */
  sizeAttenuation: boolean;
  /** Turns billboards about world +Y only. Read each frame. */
  lockY: boolean;
  /** Cut-out alpha, 0 to 1, with `transparent: false`. Read each frame. */
  alphaTest: number;
  /** Blended and sorted (true) or cut-out with depth writes (false). Fixed. */
  readonly transparent: boolean;
  private readonly order: number;
  private readonly layerMask: number;
  private atlas: SpriteAtlas;
  private engine?: Engine;
  private device?: GPUDevice;
  private colorAtlas?: OwnedAtlas;
  private stale = false;
  private layout?: GPUBindGroupLayout;
  private module?: GPUShaderModule;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private list: Billboard[] = [];
  private readonly drawList: Billboard[] = [];
  private added = 0;
  private generation = 0;
  private capacity: number;
  private disposed = false;
  private readonly view = new Float32Array(16);
  private readonly descriptor: ReturnType<typeof overlayPass>;
  private readonly states = new ViewStates<ViewState>(
    () => {
      const uniform = this.device!.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        frame = new ArrayBuffer(112);
      return {
        uniform,
        frame,
        floats: new Float32Array(frame),
        uints: new Uint32Array(frame),
        data: new Float32Array(this.capacity * BILLBOARD_FLOATS),
        generation: -1,
        fresh: true,
      };
    },
    (state) => {
      state.uniform.destroy();
      state.buffer?.destroy();
    },
  );

  constructor(options: BillboardLayerOptions) {
    if (!options?.atlas) throw typeError('BillboardLayer needs an atlas', 'sprite-options');
    const capacity = options.capacity ?? 256,
      order = options.order ?? 15,
      alphaTest = options.alphaTest ?? 0.5;
    if (!Number.isInteger(capacity) || capacity < 1) throw rangeError('Invalid billboard capacity', 'sprite-options');
    if (!Number.isFinite(order)) throw rangeError('Invalid billboard order', 'sprite-options');
    if (!(alphaTest >= 0 && alphaTest <= 1)) throw rangeError('Invalid billboard alphaTest', 'sprite-options');
    this.atlas = options.atlas;
    this.sizeAttenuation = options.sizeAttenuation ?? true;
    this.lockY = options.lockY ?? false;
    this.transparent = options.transparent ?? false;
    this.alphaTest = alphaTest;
    this.order = order;
    this.capacity = capacity;
    this.layerMask = checkLayers(options.layers ?? 1, 'BillboardLayer layers');
    this.name = options.name ?? `billboards-${++layerCount}`;
    this.descriptor = this.transparent ? overlayPass() : (overlayDepthPass() as ReturnType<typeof overlayPass>);
  }
  /** Creates a layer and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: BillboardLayerOptions): BillboardLayer {
    const layer = new BillboardLayer(options);
    engineRuntime(instance).use(layer);
    return layer;
  }
  /** The billboards in add order. Change them through {@link add} and {@link remove}. */
  get billboards(): readonly Billboard[] {
    return this.list;
  }
  /** Adds a billboard, or makes one from options, and returns it. */
  add(board: Billboard | BillboardOptions = {}): Billboard {
    if (this.disposed) throw fault('disposed', 'BillboardLayer disposed', 'disposed');
    const made = board instanceof Billboard ? board : new Billboard(board);
    if (made.owner) throw fault('attached', 'Billboard already in a layer', 'sprite-state');
    made.owner = this;
    made.index = this.added++;
    this.list.push(made);
    return made;
  }
  /** Takes a billboard out; false when it is not in this layer. */
  remove(board: Billboard): boolean {
    if (board.owner !== this) return false;
    board.owner = undefined;
    this.list.splice(this.list.indexOf(board), 1);
    return true;
  }
  /** Takes every billboard out. */
  clearBillboards(): void {
    for (const board of this.list) board.owner = undefined;
    this.list.length = 0;
  }
  /** Replaces the atlas. Billboard rectangles are checked against it next frame. */
  setAtlas(atlas: SpriteAtlas): void {
    if (!atlas) throw typeError('BillboardLayer needs an atlas', 'sprite-options');
    if (this.colorAtlas?.owned) this.colorAtlas.texture.destroy();
    this.colorAtlas = undefined;
    this.atlas = atlas;
    this.stale = false;
    this.generation++;
  }
  setup(engine: Engine): void {
    if (this.disposed || engine.backend !== 'webgpu')
      throw fault(
        this.disposed ? 'disposed' : 'unsupported',
        this.disposed ? 'BillboardLayer disposed' : 'BillboardLayer needs WebGPU',
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
    if (delta > 0) this.states.prune();
  }
  onDeviceRestored(): void {
    this.stale = !!this.colorAtlas && !this.colorAtlas.owned && typeof this.atlas !== 'function';
    this.release();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.clearBillboards();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private release(): void {
    this.states.clear();
    if (this.colorAtlas?.owned) this.colorAtlas.texture.destroy();
    this.colorAtlas = this.layout = this.module = this.device = undefined;
    this.pipelines.clear();
    this.generation++;
  }
  private prepare(device: GPUDevice): void {
    if (this.device !== device) {
      if (this.device) this.release();
      this.device = device;
    }
    if (this.stale) throw fault('state', 'Billboard atlas lost with the device; call setAtlas', 'sprite-state');
    this.colorAtlas ??= atlasTexture(device, this.atlas, () => rangeError('Invalid sprite pixels', 'sprite-options'));
    if (!this.layout) {
      this.layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        ],
      });
      this.module = device.createShaderModule({ label: 'billboards', code: shader });
    }
  }
  private pipeline(device: GPUDevice, format: GPUTextureFormat, depth: GPUTextureFormat, samples: number) {
    const key = `${format}/${depth}/${samples}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: 'billboards',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout!] }),
        vertex: { module: this.module!, entryPoint: 'vertexMain' },
        fragment: {
          module: this.module!,
          entryPoint: 'fragmentMain',
          targets: [
            this.transparent
              ? {
                  format,
                  blend: {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  },
                }
              : { format },
          ],
        },
        primitive: { topology: 'triangle-strip' },
        depthStencil: { format: depth, depthWriteEnabled: !this.transparent, depthCompare: 'greater-equal' },
        multisample: { count: samples },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  private draw(c: BillboardPassContext): void {
    const view = c.view;
    if (view?.layers !== undefined && !(view.layers & this.layerMask)) return;
    if (!(this.alphaTest >= 0 && this.alphaTest <= 1)) throw rangeError('Invalid billboard alphaTest', 'sprite-options');
    const device = c.device,
      camera = c.camera;
    this.prepare(device);
    const boards = this.drawList;
    boards.length = 0;
    for (const b of this.list) if (b.visible) boards.push(b);
    if (this.transparent) sortBillboards(boards, camera.position);
    const state = this.states.get(c),
      need = boards.length * BILLBOARD_FLOATS;
    if (need > state.data.length) {
      this.capacity = Math.max(boards.length, this.capacity * 2);
      state.data = new Float32Array(this.capacity * BILLBOARD_FLOATS);
      state.buffer?.destroy();
      state.buffer = undefined;
    }
    if (!state.buffer) {
      if (state.data.byteLength > device.limits.maxStorageBufferBindingSize)
        throw rangeError('Too many billboards in a layer', 'sprite-options');
      state.buffer = device.createBuffer({
        label: 'billboards',
        size: state.data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      state.generation = -1;
      state.fresh = true;
    }
    const atlas = this.colorAtlas!.texture,
      { count, start, end } = packBillboards(boards, state.data, atlas.width, atlas.height);
    if (state.fresh) device.queue.writeBuffer(state.buffer, 0, state.data, 0, count * BILLBOARD_FLOATS);
    else if (end > start) device.queue.writeBuffer(state.buffer, start * 4, state.data, start, end - start);
    state.fresh = false;

    // Frame block: viewProj (0 to 15), right (16 to 19), up (20 to 23), view size (24, 25), cut (26), flags (27).
    const f = state.floats,
      v = viewMatrix(this.view, camera);
    f.set(camera.matrix, 0);
    if (this.lockY) {
      const length = Math.hypot(v[0], v[8]);
      if (length > 1e-9) {
        f[16] = v[0] / length;
        f[17] = 0;
        f[18] = v[8] / length;
      } else {
        // Looking straight down or up: the camera's up axis lies flat and gives the turn.
        const up = Math.hypot(v[1], v[9]);
        f[16] = v[9] / up;
        f[17] = 0;
        f[18] = -v[1] / up;
      }
      f[20] = 0;
      f[21] = 1;
      f[22] = 0;
    } else {
      f[16] = v[0];
      f[17] = v[4];
      f[18] = v[8];
      f[20] = v[1];
      f[21] = v[5];
      f[22] = v[9];
    }
    f[24] = view ? view.viewport[2] : c.width;
    f[25] = view ? view.viewport[3] : c.height;
    f[26] = this.transparent ? 0 : this.alphaTest;
    const linear = c.format.endsWith('-srgb') || c.format.includes('float');
    state.uints[27] = (this.sizeAttenuation ? 1 : 0) | (this.transparent ? 2 : 0) | (linear ? 4 : 0);
    device.queue.writeBuffer(state.uniform, 0, state.frame);

    if (state.generation !== this.generation) {
      state.generation = this.generation;
      state.group = device.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: { buffer: state.uniform } },
          { binding: 1, resource: { buffer: state.buffer } },
          { binding: 2, resource: atlas.createView() },
        ],
      });
    }
    if (!count) return;
    const descriptor = this.descriptor;
    descriptor.colorAttachments[0].view = c.color;
    descriptor.depthStencilAttachment.view = c.depth;
    const pass = c.encoder.beginRenderPass(descriptor as unknown as GPURenderPassDescriptor);
    applyView(pass, c);
    pass.setPipeline(
      this.pipeline(device, c.format, c.descriptor.depthStencil!.format, c.descriptor.multisample?.count ?? 1),
    );
    pass.setBindGroup(0, state.group!);
    pass.draw(4, count);
    pass.end();
  }
}
