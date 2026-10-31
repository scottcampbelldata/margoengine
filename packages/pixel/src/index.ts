/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { checkLayers, ViewStates } from '../../shared/view-rect.js';
import { PixelCamera, type LayerScroll, type Parallax, type PixelCameraOptions } from './camera.js';
export {
  PixelCamera,
  type LayerScroll,
  type Parallax,
  type PixelCameraOptions,
  type PixelProjection,
} from './camera.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_DST: number;
  COPY_SRC: number;
};
declare const GPUShaderStage: { FRAGMENT: number };
type PixelPassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** How a layer's colours mix with what is below it. */
export type PixelBlend = 'normal' | 'add' | 'multiply' | 'screen';
/**
 * Who moves a layer when the camera scrolls. `'view'`: whatever draws it follows {@link PixelLayer.camera}, so the
 * layer holds what the camera sees. `'world'`: the layer holds a fixed picture and the compositor moves it.
 */
export type LayerAnchor = 'view' | 'world';
/** Straight-alpha RGBA8 texels, row by row from the top: `ImageData` fits. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}
/** A camera in the shape a sprite layer reads each frame: the world point at the top-left and pixels per world unit. */
export interface LayerCamera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Settings of {@link PixelLayer}, passed to {@link LayerCompositor.addLayer}. */
export interface PixelLayerOptions {
  /** Target width in low-res pixels. Default the camera's. */
  width?: number;
  /** Target height in low-res pixels. Default the camera's. */
  height?: number;
  /** See {@link LayerAnchor}. Default `'view'`. */
  anchor?: LayerAnchor;
  /** Scroll factor against the camera. Default 1. */
  parallax?: Parallax;
  /** Extra offset in low-res pixels. Default 0. */
  x?: number;
  /** Extra offset in low-res pixels. Default 0. */
  y?: number;
  /** Multiplies the layer's colours, 0 to 1. Default 1. */
  opacity?: number;
  /** Default `'normal'`. */
  blend?: PixelBlend;
  /** Clockwise turn about {@link pivot}, radians. Default 0. */
  rotation?: number;
  /** The point it turns about, in low-res view pixels. Default the middle of the view. */
  pivot?: readonly [number, number];
  /** Higher draws over lower; equal `z` keeps the order added. Default 0. */
  z?: number;
  /** False leaves it out of the composite. Default true. */
  visible?: boolean;
}

/** Settings of {@link LayerCompositor}. */
export interface LayerCompositorOptions {
  /** The view, a {@link PixelCamera} or the options to make one. Required. */
  camera: PixelCamera | PixelCameraOptions;
  /** Frame-graph order. 30 runs before a Tonemap (31); 40 keeps the bytes out of it. Default 30. */
  order?: number;
  /** Render-layer bits; a canvas view whose `layers` shares none gets no composite. Default 1. */
  layers?: number;
  /** Plugin name, unique per scene. Default `pixel-1`, `pixel-2`, ... */
  name?: string;
}

const shader = /* wgsl */ `
struct Layer{origin:vec2f,zoom:f32,opacity:f32,pivot:vec2f,turn:vec2f,offset:vec2f}
@group(0) @binding(0) var<uniform> layer:Layer;
@group(1) @binding(0) var image:texture_2d<f32>;
@vertex fn vertexMain(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
  return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);
}
@fragment fn fragmentMain(@builtin(position) p:vec4f)->@location(0) vec4f{
  let q=p.xy-layer.origin-layer.pivot;
  let r=vec2f(q.x*layer.turn.x+q.y*layer.turn.y,q.y*layer.turn.x-q.x*layer.turn.y)+layer.pivot-layer.offset;
  let t=vec2i(floor(r/layer.zoom));
  if(any(t<vec2i(0))||any(t>=vec2i(textureDimensions(image)))){discard;}
  return textureLoad(image,t,0)*layer.opacity;
}`;

/** Layer colours are premultiplied: a sprite pass over a clear target leaves them so, and write() converts. */
const blends: Record<PixelBlend, GPUBlendState> = {
  normal: {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  },
  add: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } },
  multiply: {
    color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'zero', dstFactor: 'one' },
  },
  screen: {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  },
};
/** Bytes per layer in the uniform buffer: the largest `minUniformBufferOffsetAlignment` WebGPU allows. */
const STRIDE = 256;
const UNIFORM_BYTES = 40;

interface ViewState {
  buffer?: GPUBuffer;
  group?: GPUBindGroup;
  values: Float32Array<ArrayBuffer>;
}
let compositorCount = 0;

/**
 * One low-res `rgba8unorm` target and how it reaches the screen. Make one with {@link LayerCompositor.addLayer}. Draw
 * into it with a sprite layer (`target: layer.target, camera: layer.camera`), a core view
 * (`target: {color: layer.texture}`) or {@link write}. Colours in it are premultiplied by alpha.
 */
export class PixelLayer {
  readonly width: number;
  readonly height: number;
  readonly anchor: LayerAnchor;
  /** Scroll factor against the camera, read each frame. */
  parallax: Parallax;
  /** Extra offset in low-res pixels, read each frame. */
  x: number;
  /** Extra offset in low-res pixels, read each frame. */
  y: number;
  /** Multiplies the layer's colours, 0 to 1, read each frame. */
  opacity: number;
  /** How the layer mixes with what is below it, read each frame. */
  blend: PixelBlend;
  /** Clockwise turn in radians, read each frame. Each output pixel still shows exactly one source pixel. */
  rotation: number;
  /** The point it turns about in low-res view pixels, read each frame. Undefined is the middle of the view. */
  pivot?: readonly [number, number];
  /** Higher draws over lower, read each frame. */
  z: number;
  /** False leaves it out of the composite, read each frame. */
  visible: boolean;
  /** The target as a function, for options that read one each frame such as a sprite layer's `target`. */
  readonly target = (): GPUTexture => this.texture;
  /** The camera whatever draws a `'view'` layer should use, live: whole pixels only, at this layer's parallax. */
  readonly camera: LayerCamera;
  /** @internal */ owner?: LayerCompositor;
  /** @internal */ group?: GPUBindGroup;
  /** @internal */ order = 0;
  private made?: GPUTexture;
  private image?: PixelImage | ImageBitmap;
  private readonly margin: number;

  /** Use {@link LayerCompositor.addLayer}; a layer belongs to its compositor. */
  constructor(owner: LayerCompositor, camera: PixelCamera, options: PixelLayerOptions = {}) {
    this.owner = owner;
    this.width = options.width ?? camera.width;
    this.height = options.height ?? camera.height;
    if (!Number.isInteger(this.width) || !Number.isInteger(this.height) || this.width < 1 || this.height < 1)
      throw rangeError('Invalid pixel layer size', 'pixel-options');
    this.anchor = options.anchor ?? 'view';
    if (this.anchor !== 'view' && this.anchor !== 'world')
      throw rangeError('Invalid pixel layer anchor', 'pixel-options');
    this.margin = camera.smooth && this.anchor === 'view' ? 1 : 0;
    this.parallax = options.parallax ?? 1;
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.opacity = options.opacity ?? 1;
    this.blend = options.blend ?? 'normal';
    this.rotation = options.rotation ?? 0;
    this.pivot = options.pivot;
    this.z = options.z ?? 0;
    this.visible = options.visible ?? true;
    const layer = this;
    this.camera = {
      get x() {
        return camera.pixelX(layer.parallax) * camera.unitsPerPixel;
      },
      get y() {
        return camera.pixelY(layer.parallax) * camera.unitsPerPixel;
      },
      get zoom() {
        return 1 / camera.unitsPerPixel;
      },
    };
  }
  /**
   * The target. A `smooth` camera's `'view'` layer has one more pixel each way, to show when it shifts. Read it each
   * frame: it is a new texture after a device loss.
   * @throws MargoError `'state'` before the compositor is attached, `'disposed'` once the layer is removed.
   */
  get texture(): GPUTexture {
    if (!this.owner) throw fault('disposed', 'Pixel layer removed; add a new one', 'disposed');
    const device = this.owner.currentDevice();
    if (!this.made) {
      this.made = device.createTexture({
        label: 'pixel layer',
        size: [this.width + this.margin, this.height + this.margin],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC,
      });
      this.group = undefined;
      if (this.image) this.upload(device);
    }
    return this.made;
  }
  /** Puts a picture at the top-left of the target, kept and put back after a device loss. Bytes are straight alpha. */
  write(image: PixelImage | ImageBitmap): void {
    if (!this.owner) throw fault('disposed', 'Pixel layer removed; add a new one', 'disposed');
    const { width, height } = image;
    if (!(width > 0) || !(height > 0) || width > this.width + this.margin || height > this.height + this.margin)
      throw rangeError('Invalid pixel image', 'pixel-options');
    if ('data' in image) {
      if (image.data.length !== width * height * 4) throw rangeError('Invalid pixel image', 'pixel-options');
      const data = new Uint8Array(image.data);
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha < 255) for (let c = 0; c < 3; c++) data[i + c] = Math.round((data[i + c] * alpha) / 255);
      }
      this.image = { width, height, data };
    } else this.image = image;
    const device = this.owner.device;
    if (device) {
      if (this.made) this.upload(device);
      else void this.texture;
    }
  }
  private upload(device: GPUDevice): void {
    const image = this.image!,
      { width, height } = image,
      texture = this.made!;
    if ('data' in image)
      device.queue.writeTexture({ texture }, image.data as Uint8Array<ArrayBuffer>, { bytesPerRow: width * 4 }, [
        width,
        height,
      ]);
    else
      device.queue.copyExternalImageToTexture({ source: image }, { texture, premultipliedAlpha: true }, [
        width,
        height,
      ]);
  }
  /** @internal */
  release(destroy: boolean): void {
    if (destroy) this.made?.destroy();
    this.made = this.group = undefined;
  }
}

/**
 * Draws low-res layers to the screen at a whole-number scale with no filtering. Every output pixel works out which
 * source pixel it shows, so a turned layer stays made of source colours with no blur. Each layer has its own target;
 * the composite is one frame-graph pass over whatever the frame has drawn. Canvas views get it, views into a texture
 * do not. WebGPU only.
 * @throws TypeError / RangeError on invalid options or, each frame, an invalid layer field.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` when a layer's texture
 * is read before the compositor is attached.
 */
export class LayerCompositor implements EnginePlugin {
  readonly name: string;
  readonly camera: PixelCamera;
  /** @internal */ device?: GPUDevice;
  private readonly order: number;
  private readonly layerMask: number;
  private engine?: Engine;
  private list: PixelLayer[] = [];
  private added = 0;
  private disposed = false;
  private uniformLayout?: GPUBindGroupLayout;
  private imageLayout?: GPUBindGroupLayout;
  private pipelineLayout?: GPUPipelineLayout;
  private module?: GPUShaderModule;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly offsets = new Uint32Array(1);
  private readonly next = new Float32Array(UNIFORM_BYTES / 4);
  private readonly scroll: LayerScroll = { x: 0, y: 0, subX: 0, subY: 0 };
  private readonly attachments: GPURenderPassColorAttachment[] = [
    { view: undefined!, loadOp: 'load', storeOp: 'store' },
  ];
  private readonly pass = { colorAttachments: this.attachments };
  private readonly states = new ViewStates<ViewState>(
    () => ({ values: new Float32Array(0) }),
    (state) => state.buffer?.destroy(),
  );

  constructor(options: LayerCompositorOptions) {
    if (!options?.camera) throw typeError('LayerCompositor needs a camera', 'pixel-options');
    const order = options.order ?? 30;
    if (!Number.isFinite(order)) throw rangeError('Invalid pixel order', 'pixel-options');
    this.camera = options.camera instanceof PixelCamera ? options.camera : new PixelCamera(options.camera);
    this.order = order;
    this.layerMask = checkLayers(options.layers ?? 1, 'LayerCompositor layers');
    this.name = options.name ?? `pixel-${++compositorCount}`;
  }
  /** Creates a compositor and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: LayerCompositorOptions): LayerCompositor {
    const compositor = new LayerCompositor(options);
    engineRuntime(instance).use(compositor);
    return compositor;
  }
  /** The layers, in draw order as of the last frame. Change them through {@link addLayer} and {@link removeLayer}. */
  get layers(): readonly PixelLayer[] {
    return this.list;
  }
  /** Adds a layer with its own target and returns it. */
  addLayer(options?: PixelLayerOptions): PixelLayer {
    if (this.disposed) throw fault('disposed', 'LayerCompositor disposed; create a new one', 'disposed');
    const layer = new PixelLayer(this, this.camera, options);
    layer.order = this.added++;
    this.list.push(layer);
    return layer;
  }
  /** Takes a layer out and frees its target; false when it is not in this compositor. */
  removeLayer(layer: PixelLayer): boolean {
    const at = this.list.indexOf(layer);
    if (at < 0) return false;
    this.list.splice(at, 1);
    layer.release(true);
    layer.owner = undefined;
    return true;
  }
  setup(engine: Engine): void {
    if (this.disposed || engine.backend !== 'webgpu')
      throw fault(
        this.disposed ? 'disposed' : 'unsupported',
        this.disposed ? 'LayerCompositor disposed; create a new one' : 'LayerCompositor needs WebGPU',
        this.disposed ? 'disposed' : 'webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu ?? undefined;
    engine.frameGraph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.composite(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) this.states.prune();
  }
  onDeviceRestored(): void {
    this.release();
    this.device = this.engine?.gpu ?? undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.engine = undefined;
    for (const layer of this.list.slice()) this.removeLayer(layer);
    this.release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** @internal The device layers make their targets on. */
  currentDevice(): GPUDevice {
    const device = this.engine?.gpu;
    if (!device) throw fault('state', 'Pixel layer texture needs an attached compositor', 'pixel-state');
    if (device !== this.device) {
      this.release();
      this.device = device;
    }
    return device;
  }
  private release(): void {
    this.states.clear();
    for (const layer of this.list) layer.release(false);
    this.uniformLayout = this.imageLayout = this.pipelineLayout = this.module = this.device = undefined;
    this.pipelines.clear();
  }
  private pipeline(device: GPUDevice, format: GPUTextureFormat, samples: number, blend: PixelBlend): GPURenderPipeline {
    const key = `${format}/${samples}/${blend}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: 'pixel composite',
        layout: this.pipelineLayout!,
        vertex: { module: this.module!, entryPoint: 'vertexMain' },
        fragment: { module: this.module!, entryPoint: 'fragmentMain', targets: [{ format, blend: blends[blend] }] },
        multisample: { count: samples },
      });
      this.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
  private prepare(device: GPUDevice): void {
    if (this.device !== device) {
      if (this.device) this.release();
      this.device = device;
    }
    if (this.module) return;
    this.uniformLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES },
        },
      ],
    });
    this.imageLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.uniformLayout, this.imageLayout] });
    this.module = device.createShaderModule({ label: 'pixel composite', code: shader });
  }
  /** Stable insertion sort by z then add order, in place: most frames find it sorted and allocate nothing. */
  private sort(): void {
    const list = this.list;
    for (let i = 1; i < list.length; i++) {
      const layer = list[i];
      if (!Number.isFinite(layer.z)) throw rangeError('Invalid pixel layer', 'pixel-options');
      let at = i - 1;
      while (at >= 0 && (list[at].z > layer.z || (list[at].z === layer.z && list[at].order > layer.order))) {
        list[at + 1] = list[at];
        at--;
      }
      list[at + 1] = layer;
    }
  }
  /** Puts one layer's uniform values at `at` (floats), in output pixels; true when any differ from what was there. */
  private fill(values: Float32Array, at: number, layer: PixelLayer, left: number, top: number): boolean {
    const { opacity, rotation, x, y } = layer,
      camera = this.camera,
      zoom = camera.zoom;
    if (
      !(opacity >= 0 && opacity <= 1) ||
      !Number.isFinite(rotation + x + y) ||
      !blends[layer.blend] ||
      (layer.pivot && !Number.isFinite(layer.pivot[0] + layer.pivot[1]))
    )
      throw rangeError('Invalid pixel layer', 'pixel-options');
    // Quarter turns are exact: cos(pi / 2) is 6e-17 in numbers, and that would move pixels lying on a texel edge.
    let cos = Math.cos(rotation),
      sin = Math.sin(rotation);
    if (Math.abs(cos) < 1e-9) {
      cos = 0;
      sin = Math.sign(sin);
    } else if (Math.abs(sin) < 1e-9) {
      sin = 0;
      cos = Math.sign(cos);
    }
    const parallax = layer.parallax,
      world = layer.anchor === 'world',
      moveX = world ? camera.pixelX(parallax) : 0,
      moveY = world ? camera.pixelY(parallax) : 0;
    let offsetX = Math.round((x - moveX) * zoom),
      offsetY = Math.round((y - moveY) * zoom);
    if (camera.smooth) {
      const scroll = camera.scroll(parallax, this.scroll);
      offsetX -= Math.floor(scroll.subX * zoom);
      offsetY -= Math.floor(scroll.subY * zoom);
    }
    const next = this.next;
    next[0] = left;
    next[1] = top;
    next[2] = zoom;
    next[3] = opacity;
    next[4] = (layer.pivot ? layer.pivot[0] : camera.width / 2) * zoom;
    next[5] = (layer.pivot ? layer.pivot[1] : camera.height / 2) * zoom;
    next[6] = cos;
    next[7] = sin;
    next[8] = offsetX;
    next[9] = offsetY;
    let changed = false;
    for (let i = 0; i < next.length; i++)
      if (values[at + i] !== next[i]) {
        values[at + i] = next[i];
        changed = true;
      }
    return changed;
  }
  private composite(c: PixelPassContext): void {
    const view = c.view;
    // A view into a texture may be drawing one of these very layers; only canvas views get the composite.
    if (view?.target || (view?.layers !== undefined && !(view.layers & this.layerMask))) return;
    const device = c.device,
      camera = this.camera,
      list = this.list;
    this.prepare(device);
    const viewX = view ? view.viewport[0] : 0,
      viewY = view ? view.viewport[1] : 0,
      viewWidth = view ? view.viewport[2] : c.width,
      viewHeight = view ? view.viewport[3] : c.height;
    if (camera.autoFit) camera.fit(viewWidth, viewHeight);
    const zoom = camera.zoom,
      width = camera.width * zoom,
      height = camera.height * zoom,
      left = viewX + Math.floor((viewWidth - width) / 2),
      top = viewY + Math.floor((viewHeight - height) / 2),
      clipX = view?.scissor ? view.scissor[0] : viewX,
      clipY = view?.scissor ? view.scissor[1] : viewY,
      clipWidth = view?.scissor ? view.scissor[2] : viewWidth,
      clipHeight = view?.scissor ? view.scissor[3] : viewHeight,
      startX = Math.max(left, clipX, 0),
      startY = Math.max(top, clipY, 0),
      endX = Math.min(left + width, clipX + clipWidth, c.width),
      endY = Math.min(top + height, clipY + clipHeight, c.height);
    this.sort();
    if (endX <= startX || endY <= startY || !list.length) return;
    const state = this.states.get(c),
      floats = list.length * (STRIDE / 4);
    if (state.values.length < floats) {
      state.values = new Float32Array(floats);
      state.buffer?.destroy();
      state.buffer = device.createBuffer({
        label: 'pixel composite',
        size: state.values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      state.group = device.createBindGroup({
        layout: this.uniformLayout!,
        entries: [{ binding: 0, resource: { buffer: state.buffer, size: UNIFORM_BYTES } }],
      });
      // Zeros are never a real layer (zoom is at least 1), so the first frame writes every one.
    }
    for (let i = 0; i < list.length; i++) {
      const at = i * (STRIDE / 4);
      if (this.fill(state.values, at, list[i], left, top))
        device.queue.writeBuffer(state.buffer!, at * 4, state.values, at, UNIFORM_BYTES / 4);
    }
    this.attachments[0].view = c.color;
    const pass = c.encoder.beginRenderPass(this.pass),
      format = c.format,
      samples = c.descriptor.multisample?.count ?? 1;
    pass.setScissorRect(startX, startY, endX - startX, endY - startY);
    for (let i = 0; i < list.length; i++) {
      const layer = list[i];
      if (!layer.visible || layer.opacity === 0) continue;
      const texture = layer.texture;
      layer.group ??= device.createBindGroup({
        layout: this.imageLayout!,
        entries: [{ binding: 0, resource: texture.createView() }],
      });
      pass.setPipeline(this.pipeline(device, format, samples, layer.blend));
      this.offsets[0] = i * STRIDE;
      pass.setBindGroup(0, state.group!, this.offsets);
      pass.setBindGroup(1, layer.group);
      pass.draw(3);
    }
    pass.end();
  }
}
