/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { atlasTexture } from '../../shared/atlas-texture.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { generateMipmaps } from '../../shared/mipmaps.js';
import { applyView, checkLayers, ViewStates } from '../../shared/view-rect.js';
import { packSprites, sortSprites, Sprite, SPRITE_FLOATS, type SpriteCamera, type SpriteOptions } from './sprite.js';
export {
  packSprites,
  snapToPixel,
  sortSprites,
  Sprite,
  SPRITE_FLOATS,
  type PackedSprites,
  type SpriteCamera,
  type SpriteOptions,
} from './sprite.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; RENDER_ATTACHMENT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type SpritesPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Straight-alpha RGBA8 texels, row by row from the top: `ImageData` fits. */
export interface SpritePixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
/**
 * Where a layer's texels come from. Pixels and `ImageBitmap`s are uploaded by the layer to an `rgba8unorm` texture it
 * owns and uploads again after a device loss. A function is called with the device, also after a device loss. A plain
 * `GPUTexture` stays the caller's and needs {@link SpriteLayer.setAtlas} after a device loss.
 */
export type SpriteAtlas = SpritePixels | ImageBitmap | GPUTexture | ((device: GPUDevice) => GPUTexture);
/** A render target, or a function read each frame for one that changes. */
export type SpriteTarget = GPUTexture | (() => GPUTexture);

/** A second colour target holding each sprite's normal, for 2D lighting. */
export interface SpriteNormals {
  /** Tangent-space normals (`rgb = n * 0.5 + 0.5`) laid out like the colour atlas, the same size. */
  atlas: SpriteAtlas;
  /** Single-sample target the same size as the colour target. Each covered pixel gets the normal turned and flipped with its sprite, alpha 1. */
  target: SpriteTarget;
  /** Clear to a flat normal with alpha 0 before drawing. False keeps what earlier layers wrote. Default true. */
  clear?: boolean;
}

/** Settings of {@link SpriteLayer}, fixed when it is created except where a member says otherwise. */
export interface SpriteLayerOptions {
  /** The texels sprites cut their rectangles from, read with no filtering. Required. */
  atlas: SpriteAtlas;
  /** World units to pixels; see {@link SpriteLayer.camera}. Default `{x: 0, y: 0, zoom: 1}`: world units are pixels. */
  camera?: SpriteCamera;
  /** Rounds each image's corner to a whole pixel after the camera; see {@link SpriteLayer.snap}. Default true. */
  snap?: boolean;
  /** Among equal `z`, a sprite lower on the screen draws over a higher one; see {@link SpriteLayer.ySort}. Default false. */
  ySort?: boolean;
  /** Draw here instead of the canvas or the view's target. Default the frame's colour target. */
  target?: SpriteTarget;
  /** With `target`: the colour `[r, g, b, a]` (0 to 1) to clear it to first, or false to draw over it. Default `[0, 0, 0, 0]`. */
  clear?: readonly [number, number, number, number] | false;
  /**
   * `'nearest'` (default) reads whole texels with no filtering, for exact pixels. `'linear'` filters for smooth HD art:
   * the layer keeps its own premultiplied, sRGB-decoded copy of the atlas with mipmaps, so edges carry no fringe and
   * small sprites do not shimmer. Fixed.
   */
  filter?: 'nearest' | 'linear';
  /** With `filter: 'linear'`, builds a full mip chain for the atlas. Default true. */
  mipmaps?: boolean;
  /** Writes normals to a second colour target. Needs a single-sample colour target. Default none. */
  normals?: SpriteNormals;
  /** Frame-graph order. Runs after the scene (0); 40 draws after a Tonemap. Default 10. */
  order?: number;
  /** Render-layer bits; a view whose `layers` shares none leaves this layer out. Default 1. */
  layers?: number;
  /** Sprites the buffer holds before it grows, at least 1. Default 256. */
  capacity?: number;
  /** Plugin name, unique per scene. Default `sprites-1`, `sprites-2`, ... */
  name?: string;
}

const shader = (normals: boolean, smooth: boolean) => /* wgsl */ `
struct Sprite{p:vec2f,s:vec2f,pivot:vec2f,turn:f32,tint:u32,rect:vec4f}
@group(0) @binding(0) var<uniform> size:vec4f;
@group(0) @binding(1) var<storage,read> sprites:array<Sprite>;
@group(0) @binding(2) var atlas:texture_2d<f32>;
${normals ? '@group(0) @binding(3) var bumps:texture_2d<f32>;' : ''}
${smooth ? `@group(0) @binding(4) var filtered:sampler;\n${srgb}` : ''}
struct Varying{
  @builtin(position) position:vec4f,
  @location(0) texel:vec2f,
  @location(1) @interpolate(flat) low:vec2f,
  @location(2) @interpolate(flat) high:vec2f,
  @location(3) @interpolate(flat) tint:vec4f,
  @location(4) @interpolate(flat) axes:vec4f,
}
@vertex fn vertexMain(@builtin(vertex_index) corner:u32,@builtin(instance_index) index:u32)->Varying{
  let s=sprites[index];
  let c=vec2f(f32(corner&1u),f32(corner>>1u));
  let q=(c-s.pivot)*s.s;
  let x=cos(s.turn);
  let y=sin(s.turn);
  let p=s.p+vec2f(q.x*x-q.y*y,q.x*y+q.y*x);
  var v:Varying;
  v.position=vec4f(p/size.xy*vec2f(2,-2)+vec2f(-1,1),0,1);
  v.texel=s.rect.xy+s.rect.zw*c;
  v.low=min(s.rect.xy,s.rect.xy+s.rect.zw);
  v.high=max(s.rect.xy,s.rect.xy+s.rect.zw)-1;
  v.tint=unpack4x8unorm(s.tint);
  v.axes=vec4f(x*sign(s.rect.z)*sign(s.s.x),y*sign(s.rect.z)*sign(s.s.x),-y*sign(s.rect.w)*sign(s.s.y),x*sign(s.rect.w)*sign(s.s.y));
  return v;
}
${
  normals
    ? 'struct Output{@location(0) color:vec4f,@location(1) normal:vec4f}\n@fragment fn fragmentMain(v:Varying)->Output'
    : '@fragment fn fragmentMain(v:Varying)->@location(0) vec4f'
}{
  let t=vec2i(clamp(floor(v.texel),v.low,v.high));
  ${
    smooth
      ? `// Premultiplied linear texels, kept half a texel inside the rectangle so the next cell does not bleed in.
  let f=textureSample(atlas,filtered,clamp(v.texel,v.low+0.5,v.high+0.5)/vec2f(textureDimensions(atlas)));
  let linear=f*vec4f(decode(v.tint.rgb)*v.tint.a,v.tint.a);
  if(linear.a==0){discard;}
  let color=select(vec4f(encode(linear.rgb/linear.a)*linear.a,linear.a),linear,size.z>0);`
      : `let color=textureLoad(atlas,t,0)*v.tint;
  if(color.a==0){discard;}`
  }
  ${
    normals
      ? `let n=textureLoad(bumps,t,0).xyz*2-1;
  return Output(color,vec4f(vec3f(v.axes.xy*n.x+v.axes.zw*n.y,n.z)*0.5+0.5,1));`
      : 'return color;'
  }
}`;

const srgb = /* wgsl */ `fn decode(c:vec3f)->vec3f{return select(pow((c+0.055)/1.055,vec3f(2.4)),c/12.92,c<=vec3f(0.04045));}
fn encode(c:vec3f)->vec3f{return select(1.055*pow(c,vec3f(1/2.4))-0.055,c*12.92,c<=vec3f(0.0031308));}`;
// Copies any atlas into the layer's filtered texture: sRGB bytes decoded, colour multiplied by alpha, so filtering and
// mip averages happen in linear light on premultiplied texels (T. Porter and T. Duff, Compositing Digital Images, 1984).
const premultiply = /* wgsl */ `
override decoded:bool=false;
@group(0) @binding(0) var source:texture_2d<f32>;
${srgb}
@vertex fn vertexMain(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
  let p=array(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0,1);
}
@fragment fn fragmentMain(@builtin(position) p:vec4f)->@location(0) vec4f{
  let c=textureLoad(source,vec2i(p.xy),0);
  return vec4f(select(decode(c.rgb),c.rgb,decoded)*c.a,c.a);
}`;

interface ViewState {
  uniform: GPUBuffer;
  values: Float32Array<ArrayBuffer>;
  group?: GPUBindGroup;
  generation: number;
}
interface OwnedAtlas {
  texture: GPUTexture;
  owned: boolean;
}
let layerCount = 0;

/**
 * A list of 2D sprites drawn in one instanced draw, with exact pixels when the target has one sample per pixel
 * (`exactSize` on the engine, or your own texture). Texels go through as they are, with no filtering and no colour
 * conversion. WebGPU only.
 * @throws TypeError / RangeError on invalid options or, each frame, an invalid sprite.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'attached'` when a sprite is
 * already in a layer, `'state'` for a normal target that does not fit or a plain `GPUTexture` atlas after a device loss.
 */
export class SpriteLayer implements EnginePlugin {
  readonly name: string;
  /** World units to pixels, read each frame. */
  camera: SpriteCamera;
  /** Rounds each image's corner to a whole pixel after the camera, read each frame. Rotated images turn about the rounded place. */
  snap: boolean;
  /** Sorts equal `z` by `y`, read each frame. */
  ySort: boolean;
  private readonly order: number;
  private readonly layerMask: number;
  private readonly target?: SpriteTarget;
  private readonly clear: number[] | false;
  private readonly normals?: SpriteNormals;
  private readonly smooth: boolean;
  private readonly mipmaps: boolean;
  private readonly mipCache = new Map<unknown, unknown>();
  private atlas: SpriteAtlas;
  private engine?: Engine;
  private removePass?: () => void;
  private device?: GPUDevice;
  private colorAtlas?: OwnedAtlas;
  private normalAtlas?: OwnedAtlas;
  private stale = false;
  private layout?: GPUBindGroupLayout;
  private module?: GPUShaderModule;
  private sampler?: GPUSampler;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private buffer?: GPUBuffer;
  private data: Float32Array<ArrayBuffer>;
  private list: Sprite[] = [];
  private added = 0;
  private generation = 0;
  private uploadAll = true;
  private disposed = false;
  private readonly states = new ViewStates<ViewState>(
    () => {
      const uniform = this.device!.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      return { uniform, values: new Float32Array(4), generation: -1 };
    },
    (state) => state.uniform.destroy(),
  );
  private readonly attachments: GPURenderPassColorAttachment[] = [
    { view: undefined!, loadOp: 'load', storeOp: 'store' },
  ];
  private targetTexture?: GPUTexture;
  private targetView?: GPUTextureView;
  private normalTexture?: GPUTexture;
  private normalView?: GPUTextureView;

  constructor(options: SpriteLayerOptions) {
    if (!options?.atlas) throw typeError('SpriteLayer needs an atlas', 'sprite-options');
    const capacity = options.capacity ?? 256,
      order = options.order ?? 10;
    if (!Number.isInteger(capacity) || capacity < 1) throw rangeError('Invalid sprite capacity', 'sprite-options');
    if (!Number.isFinite(order)) throw rangeError('Invalid sprite order', 'sprite-options');
    if (options.filter !== undefined && options.filter !== 'nearest' && options.filter !== 'linear')
      throw rangeError('Invalid sprite filter', 'sprite-options');
    if (options.clear && (options.clear.length !== 4 || !options.clear.every(Number.isFinite)))
      throw rangeError('Invalid sprite clear', 'sprite-options');
    this.atlas = options.atlas;
    this.camera = options.camera ?? { x: 0, y: 0, zoom: 1 };
    this.snap = options.snap ?? true;
    this.ySort = options.ySort ?? false;
    this.target = options.target;
    this.clear = options.clear === false ? false : [...(options.clear ?? [0, 0, 0, 0])];
    this.normals = options.normals;
    this.smooth = options.filter === 'linear';
    this.mipmaps = options.mipmaps ?? true;
    this.order = order;
    this.layerMask = checkLayers(options.layers ?? 1, 'SpriteLayer layers');
    this.name = options.name ?? `sprites-${++layerCount}`;
    this.data = new Float32Array(capacity * SPRITE_FLOATS);
  }
  /** Creates a layer and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: SpriteLayerOptions): SpriteLayer {
    const layer = new SpriteLayer(options);
    engineRuntime(instance).use(layer);
    return layer;
  }
  /** The sprites, in draw order as of the last frame. Change them through {@link add} and {@link remove}. */
  get sprites(): readonly Sprite[] {
    return this.list;
  }
  /** Adds a sprite, or makes one from options, and returns it. */
  add(sprite: Sprite | SpriteOptions = {}): Sprite {
    if (this.disposed) throw fault('disposed', 'SpriteLayer disposed', 'disposed');
    const made = sprite instanceof Sprite ? sprite : new Sprite(sprite);
    if (made.owner) throw fault('attached', 'Sprite already in a layer', 'sprite-state');
    made.owner = this;
    made.index = this.added++;
    this.list.push(made);
    return made;
  }
  /** Takes a sprite out; false when it is not in this layer. */
  remove(sprite: Sprite): boolean {
    if (sprite.owner !== this) return false;
    sprite.owner = undefined;
    this.list.splice(this.list.indexOf(sprite), 1);
    return true;
  }
  /** Takes every sprite out. */
  clearSprites(): void {
    for (const sprite of this.list) sprite.owner = undefined;
    this.list.length = 0;
  }
  /** Replaces the colour atlas. Sprite rectangles are checked against it next frame. */
  setAtlas(atlas: SpriteAtlas): void {
    if (!atlas) throw typeError('SpriteLayer needs an atlas', 'sprite-options');
    this.dropAtlas(this.colorAtlas);
    this.colorAtlas = undefined;
    this.atlas = atlas;
    this.stale = false;
    this.generation++;
  }
  setup(engine: Engine): void {
    if (this.disposed || engine.backend !== 'webgpu')
      throw fault(
        this.disposed ? 'disposed' : 'unsupported',
        this.disposed ? 'SpriteLayer disposed' : 'SpriteLayer needs WebGPU',
        this.disposed ? 'disposed' : 'webgpu',
      );
    this.engine = engine;
    this.removePass = engine.frameGraph.add({
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
    // A caller's plain GPUTexture went with the device; bytes, bitmaps and functions come back by themselves.
    this.stale = !!this.colorAtlas && typeof this.atlas !== 'function' && 'createView' in this.atlas;
    this.release();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removePass = undefined;
    this.engine?.removePlugin(this.name);
    this.release();
    this.clearSprites();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private dropAtlas(atlas?: OwnedAtlas): void {
    if (atlas?.owned) atlas.texture.destroy();
  }
  private release(): void {
    this.states.clear();
    this.dropAtlas(this.colorAtlas);
    this.dropAtlas(this.normalAtlas);
    this.buffer?.destroy();
    this.colorAtlas = this.normalAtlas = this.buffer = this.layout = this.module = this.device = this.sampler = undefined;
    this.mipCache.clear();
    this.targetTexture = this.normalTexture = undefined;
    this.targetView = this.normalView = undefined;
    this.pipelines.clear();
    this.uploadAll = true;
    this.generation++;
  }
  private prepare(device: GPUDevice): void {
    if (this.device !== device) {
      if (this.device) this.release();
      this.device = device;
    }
    if (this.stale) throw fault('state', 'Sprite atlas lost with the device; call setAtlas', 'sprite-state');
    this.colorAtlas ??= this.smooth ? this.filtered(device) : this.loadAtlas(device);
    if (this.normals && !this.normalAtlas) {
      this.normalAtlas = atlasTexture(device, this.normals.atlas, () =>
        rangeError('Invalid sprite pixels', 'sprite-options'),
      );
      if (
        this.normalAtlas.texture.width !== this.colorAtlas.texture.width ||
        this.normalAtlas.texture.height !== this.colorAtlas.texture.height
      )
        throw rangeError('Sprite normal atlas differs in size', 'sprite-options');
    }
    if (!this.layout) {
      const texture = (binding: number) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float' as const },
      });
      this.layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
          this.smooth
            ? { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' as const } }
            : texture(2),
          ...(this.normals ? [texture(3)] : []),
          ...(this.smooth
            ? [{ binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' as const } }]
            : []),
        ],
      });
      this.module = device.createShaderModule({ label: 'sprites', code: shader(!!this.normals, this.smooth) });
      if (this.smooth)
        this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    }
  }
  private loadAtlas(device: GPUDevice): OwnedAtlas {
    return atlasTexture(device, this.atlas, () => rangeError('Invalid sprite pixels', 'sprite-options'));
  }
  /** The premultiplied, linear-light copy of the atlas that `filter: 'linear'` samples, with its mip chain. */
  private filtered(device: GPUDevice): OwnedAtlas {
    const source = this.loadAtlas(device),
      { width, height, format } = source.texture,
      levels = this.mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1,
      texture = device.createTexture({
        label: 'sprites filtered atlas',
        size: [width, height],
        format: 'rgba8unorm-srgb',
        mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      module = device.createShaderModule({ label: 'sprites premultiply', code: premultiply }),
      pipeline = device.createRenderPipeline({
        label: 'sprites premultiply',
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: {
          module,
          entryPoint: 'fragmentMain',
          // A float or sRGB source already reads as linear.
          constants: { decoded: format.endsWith('-srgb') || format.includes('float') ? 1 : 0 },
          targets: [{ format: 'rgba8unorm-srgb' }],
        },
      }),
      encoder = device.createCommandEncoder(),
      pass = encoder.beginRenderPass({
        colorAttachments: [{ view: texture.createView({ mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }],
      });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source.texture.createView() }],
      }),
    );
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
    generateMipmaps(device, texture, levels, this.mipCache);
    if (source.owned) source.texture.destroy();
    return { texture, owned: true };
  }
  private pipeline(device: GPUDevice, format: GPUTextureFormat, samples: number, normal?: GPUTextureFormat) {
    const key = `${format}/${samples}/${normal ?? ''}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      // The filtered path writes premultiplied colour.
      const blend: GPUBlendState = {
        color: { srcFactor: this.smooth ? 'one' : 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      };
      pipeline = device.createRenderPipeline({
        label: 'sprites',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout!] }),
        vertex: { module: this.module!, entryPoint: 'vertexMain' },
        fragment: {
          module: this.module!,
          entryPoint: 'fragmentMain',
          targets: normal ? [{ format, blend }, { format: normal }] : [{ format, blend }],
        },
        primitive: { topology: 'triangle-strip' },
        multisample: { count: samples },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  /** Sorts, packs and uploads; returns how many sprites to draw. Several views in a frame upload once. */
  private upload(device: GPUDevice): number {
    sortSprites(this.list, this.ySort);
    const need = this.list.length * SPRITE_FLOATS;
    if (need > this.data.length) {
      this.data = new Float32Array(Math.max(need, this.data.length * 2));
      this.buffer?.destroy();
      this.buffer = undefined;
    }
    if (!this.buffer) {
      if (this.data.byteLength > device.limits.maxStorageBufferBindingSize)
        throw rangeError('Too many sprites in a layer', 'sprite-options');
      this.buffer = device.createBuffer({
        label: 'sprites',
        size: this.data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.generation++;
      this.uploadAll = true;
    }
    const atlas = this.colorAtlas!.texture,
      { count, start, end } = packSprites(this.list, this.data, this.camera, atlas.width, atlas.height, this.snap);
    if (this.uploadAll) device.queue.writeBuffer(this.buffer, 0, this.data, 0, count * SPRITE_FLOATS);
    else if (end > start) device.queue.writeBuffer(this.buffer, start * 4, this.data, start, end - start);
    this.uploadAll = false;
    return count;
  }
  private draw(c: SpritesPassContext): void {
    const view = c.view;
    if (view?.layers !== undefined && !(view.layers & this.layerMask)) return;
    const own = this.target && (typeof this.target === 'function' ? this.target() : this.target);
    // A layer with its own target draws once a frame, however many views the frame has.
    if (own && view?.index) return;
    const device = c.device;
    this.prepare(device);
    const count = this.upload(device);
    let width = view ? view.viewport[2] : c.width,
      height = view ? view.viewport[3] : c.height,
      format = c.format,
      samples = c.descriptor.multisample?.count ?? 1;
    const color = this.attachments[0];
    color.view = c.color;
    color.loadOp = 'load';
    if (own) {
      if (own !== this.targetTexture) {
        this.targetTexture = own;
        this.targetView = own.createView();
      }
      width = own.width;
      height = own.height;
      format = own.format;
      samples = own.sampleCount;
      color.view = this.targetView!;
      if (this.clear) {
        color.loadOp = 'clear';
        color.clearValue = this.clear;
      }
    }
    let normalFormat: GPUTextureFormat | undefined;
    this.attachments.length = 1;
    if (this.normals) {
      const { target, clear = true } = this.normals,
        texture = typeof target === 'function' ? target() : target;
      if (
        samples !== 1 ||
        texture.sampleCount !== 1 ||
        texture.width !== (own ? width : c.width) ||
        texture.height !== (own ? height : c.height)
      )
        throw fault('state', 'Sprite normals need one sample and a same-size target', 'sprite-state');
      if (texture !== this.normalTexture) {
        this.normalTexture = texture;
        this.normalView = texture.createView();
      }
      normalFormat = texture.format;
      this.attachments.push({
        view: this.normalView!,
        // Only the first view of a frame clears: a later view keeps what the first wrote.
        loadOp: clear && !view?.index ? 'clear' : 'load',
        // 128 in bytes: 0.5 lands between 127 and 128, and which one is up to the driver.
        clearValue: [128 / 255, 128 / 255, 1, 0],
        storeOp: 'store',
      });
    }
    const pipeline = this.pipeline(device, format, samples, normalFormat),
      state = this.states.get(c);
    // Targets that store linear light (sRGB and float formats) take the filtered colour as it is; 8-bit ones encoded.
    const linear = format.endsWith('-srgb') || format.includes('float') ? 1 : 0;
    if (state.values[0] !== width || state.values[1] !== height || state.values[2] !== linear) {
      state.values[0] = width;
      state.values[1] = height;
      state.values[2] = linear;
      device.queue.writeBuffer(state.uniform, 0, state.values);
    }
    if (state.generation !== this.generation) {
      state.generation = this.generation;
      state.group = device.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: { buffer: state.uniform } },
          { binding: 1, resource: { buffer: this.buffer! } },
          { binding: 2, resource: this.colorAtlas!.texture.createView() },
          ...(this.normalAtlas ? [{ binding: 3, resource: this.normalAtlas.texture.createView() }] : []),
          ...(this.sampler ? [{ binding: 4, resource: this.sampler }] : []),
        ],
      });
    }
    const pass = c.encoder.beginRenderPass({ colorAttachments: this.attachments });
    if (!own) applyView(pass, c);
    if (count) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, state.group!);
      pass.draw(4, count);
    }
    pass.end();
  }
}
