/// <reference lib="esnext.disposable" preserve="true" />
import { fault } from '../../shared/errors.js';

/** One live captured texture, including render targets, storage images and unbound material maps. */
export interface InspectorTexture {
  id: number;
  label: string;
  width: number;
  height: number;
  depthOrArrayLayers: number;
  dimension: GPUTextureDimension;
  format: GPUTextureFormat;
  mipLevelCount: number;
  sampleCount: number;
  usage: number;
}
/** Display the original RGBA/RGB or an isolated channel as grayscale. */
export type TextureChannel = 'rgba' | 'rgb' | 'r' | 'g' | 'b' | 'a';
/** Preview settings, all optional. Values are loaded exactly from one mip without filtering. */
export interface TexturePreviewOptions {
  /** Default 0. */
  mip?: number;
  /** Array/cube face or 3D depth slice at this mip. Default 0. */
  layer?: number;
  /** Default rgba. */
  channel?: TextureChannel;
  /** Depth/stencil aspect. Default depth-only for combined formats, otherwise all. */
  aspect?: GPUTextureAspect;
  /** Multiply source values before display mapping. Default 1. */
  exposure?: number;
  /** Maps (value - range[0]) / (range[1] - range[0]), then clamps for display. Default [0,1]. */
  range?: readonly [number, number];
  /** Stops waiting for readback; no global operation is cancelled. Default unset. */
  signal?: AbortSignal;
}
/** Display pixels in top-left row order, including the exact selected mip's dimensions. */
export interface TexturePreview {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
/** Explicit startup instrumentation, never installed by importing this module. */
export interface TextureCaptureOptions {
  /** Default navigator.gpu when present. Null captures only explicitly watched devices. */
  gpu?: GPU | null;
  /** Add TEXTURE_BINDING to captured creation descriptors for preview. Default true; application descriptors are not mutated. */
  inspectable?: boolean;
  signal?: AbortSignal;
}
type RecordTexture = { texture: WeakRef<GPUTexture>; device: WeakRef<GPUDevice> };
// All capture layers exclude the module's temporary preview allocations.
let previewDepth = 0;

/** Tracks textures from device creation, so a panel opened later still sees textures created before it. */
export class TextureCapture {
  private readonly records = new Map<number, RecordTexture>();
  private readonly ids = new WeakMap<GPUTexture, number>();
  private readonly watched = new WeakSet<object>();
  private readonly cleanup: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private next = 0;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly abort = () => this.dispose();

  /** Install before Engine.create or before creating/loading app textures. */
  static start(options: TextureCaptureOptions = {}): TextureCapture {
    return new TextureCapture(options);
  }
  constructor(private readonly options: TextureCaptureOptions = {}) {
    options.signal?.throwIfAborted();
    const gpu = options.gpu === undefined ? globalThis.navigator?.gpu : options.gpu;
    if (gpu) this.watchGPU(gpu);
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }
  private alive(): void {
    if (this.disposed) throw fault('disposed', 'Texture capture is disposed; start a new capture');
  }
  // Wrappers installed above us keep forwarding after disposal. Restore only our own top layer.
  private wrap<T extends object, K extends keyof T>(target: T, key: K, make: (original: T[K]) => T[K]): void {
    const own = Object.getOwnPropertyDescriptor(target, key),
      original = target[key],
      wrapper = make(original),
      ref = new WeakRef(target);
    Object.defineProperty(target, key, { configurable: true, writable: true, value: wrapper });
    this.cleanup.push(() => {
      const object = ref.deref();
      if (!object || object[key] !== wrapper) return;
      if (own) Object.defineProperty(object, key, own);
      else Reflect.deleteProperty(object, key);
    });
  }
  /** Watches future adapters/devices from this GPU, including restoration requests. Idempotent per GPU. */
  watchGPU(gpu: GPU): void {
    this.alive();
    if (this.watched.has(gpu)) return;
    this.watched.add(gpu);
    const self = this;
    this.wrap(
      gpu,
      'requestAdapter',
      (original) =>
        async function (this: GPU, ...args) {
          const adapter = await original.apply(this, args);
          if (adapter && !self.disposed) self.watchAdapter(adapter);
          return adapter;
        },
    );
  }
  /** Watches future devices from a previously requested adapter. */
  watchAdapter(adapter: GPUAdapter): void {
    this.alive();
    if (this.watched.has(adapter)) return;
    this.watched.add(adapter);
    const self = this;
    this.wrap(
      adapter,
      'requestDevice',
      (original) =>
        async function (this: GPUAdapter, ...args) {
          const device = await original.apply(this, args);
          if (!self.disposed) self.watchDevice(device);
          return device;
        },
    );
  }
  /** Watches new textures of an existing device. Earlier textures must be register()ed explicitly. */
  watchDevice(device: GPUDevice): void {
    this.alive();
    if (this.watched.has(device)) return;
    this.watched.add(device);
    const self = this;
    this.wrap(
      device,
      'createTexture',
      (original) =>
        function (this: GPUDevice, descriptor) {
          const inspect = !self.disposed && previewDepth === 0;
          // Transient attachments forbid sampling; leave their usage intact and list the restriction.
          const usage =
            inspect && self.options.inspectable !== false && !(descriptor.usage & 32)
              ? descriptor.usage | 4
              : descriptor.usage;
          const texture = original.call(this, usage === descriptor.usage ? descriptor : { ...descriptor, usage });
          if (inspect) self.register(this, texture);
          return texture;
        },
    );
    this.wrap(
      device,
      'destroy',
      (original) =>
        function (this: GPUDevice) {
          original.call(this);
          if (!self.disposed) {
            self.forgetDevice(this);
          }
        },
    );
    // A lost native device's resources are no longer previewable. Device restore is observed through watchGPU.
    void device.lost.then(() => {
      if (!self.disposed) self.forgetDevice(device);
    });
  }
  private forgetDevice(device: GPUDevice): void {
    for (const [id, entry] of this.records) if (entry.device.deref() === device) this.records.delete(id);
    this.changed();
  }
  /** Registers a known earlier texture, without modifying its usage. Returns its stable capture id. */
  register(device: GPUDevice, texture: GPUTexture): number {
    this.alive();
    const previous = this.ids.get(texture);
    if (previous !== undefined && this.records.has(previous)) return previous;
    const id = ++this.next,
      self = this;
    this.ids.set(texture, id);
    this.records.set(id, { texture: new WeakRef(texture), device: new WeakRef(device) });
    this.wrap(
      texture,
      'destroy',
      (original) =>
        function (this: GPUTexture) {
          original.call(this);
          if (!self.disposed) {
            self.records.delete(id);
            self.changed();
          }
        },
    );
    this.changed();
    return id;
  }
  /** Registers swapchain textures when requested. Call before the first canvas frame to include them. */
  watchCanvas(context: GPUCanvasContext): void {
    this.alive();
    if (this.watched.has(context)) return;
    this.watched.add(context);
    const self = this;
    this.wrap(
      context,
      'getCurrentTexture',
      (original) =>
        function (this: GPUCanvasContext) {
          const texture = original.call(this),
            configuration = this.getConfiguration();
          if (!self.disposed && configuration) self.register(configuration.device, texture);
          return texture;
        },
    );
  }
  /** Snapshot of all live captured textures; collected and destroyed resources are omitted. */
  list(): InspectorTexture[] {
    this.alive();
    const out: InspectorTexture[] = [];
    for (const [id, entry] of this.records) {
      const t = entry.texture.deref();
      if (!t || !entry.device.deref()) {
        this.records.delete(id);
        continue;
      }
      out.push({
        id,
        label: t.label,
        width: t.width,
        height: t.height,
        depthOrArrayLayers: t.depthOrArrayLayers,
        dimension: t.dimension,
        format: t.format,
        mipLevelCount: t.mipLevelCount,
        sampleCount: t.sampleCount,
        usage: t.usage,
      });
    }
    return out;
  }
  /** Runs after resource creation/destruction. Returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.alive();
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Reads one mip/layer through a format-correct, unfiltered GPU shader. Integer and HDR data use explicit display range. */
  async preview(id: number, options: TexturePreviewOptions = {}): Promise<TexturePreview> {
    this.alive();
    options.signal?.throwIfAborted();
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
    const entry = this.records.get(id),
      texture = entry?.texture.deref(),
      device = entry?.device.deref();
    if (!texture || !device) throw fault('state', 'Texture is no longer available; refresh the texture list');
    const mip = options.mip ?? 0,
      layer = options.layer ?? 0,
      channel = options.channel ?? 'rgba',
      exposure = options.exposure ?? 1,
      range = options.range ?? [0, 1];
    if (!Number.isInteger(mip) || mip < 0 || mip >= texture.mipLevelCount)
      throw new RangeError('Mip is outside the texture; choose a listed mip level');
    const width = Math.max(1, texture.width >> mip),
      height = texture.dimension === '1d' ? 1 : Math.max(1, texture.height >> mip),
      depth = texture.dimension === '3d' ? Math.max(1, texture.depthOrArrayLayers >> mip) : texture.depthOrArrayLayers;
    if (!Number.isInteger(layer) || layer < 0 || layer >= depth)
      throw new RangeError('Layer is outside the texture; choose a listed layer or slice');
    if (
      !['rgba', 'rgb', 'r', 'g', 'b', 'a'].includes(channel) ||
      !Number.isFinite(exposure) ||
      exposure < 0 ||
      range.length !== 2 ||
      !range.every(Number.isFinite) ||
      !(range[1] > range[0])
    )
      throw new RangeError('Invalid display mapping; use a channel, nonnegative exposure and increasing finite range');
    if (!(texture.usage & 4))
      throw fault(
        'unsupported',
        'Texture lacks TEXTURE_BINDING; start TextureCapture before creation with inspectable:true',
      );
    const aspect =
      options.aspect ??
      (texture.format.startsWith('depth') ? 'depth-only' : texture.format === 'stencil8' ? 'stencil-only' : 'all');
    if (
      !['all', 'depth-only', 'stencil-only'].includes(aspect) ||
      (aspect === 'stencil-only' && !texture.format.includes('stencil')) ||
      (aspect === 'depth-only' && !texture.format.startsWith('depth')) ||
      (aspect === 'all' && texture.format.includes('stencil') && texture.format.startsWith('depth'))
    )
      throw new RangeError('Invalid texture aspect; select an existing depth or stencil aspect');
    const stencil = texture.format === 'stencil8' || aspect === 'stencil-only',
      depthFormat = texture.format.startsWith('depth') && !stencil,
      integer = /(?:u|s)int$/.test(texture.format),
      scalar = /uint$/.test(texture.format) || stencil ? 'u32' : integer ? 'i32' : 'f32';
    const dimension = texture.dimension,
      multi = texture.sampleCount > 1;
    const kind = depthFormat
      ? `texture_depth_${multi ? 'multisampled_2d' : '2d'}`
      : `texture_${multi ? 'multisampled_2d' : dimension}<${scalar}>`;
    const coordinates =
      dimension === '1d' ? 'i32(p.x)' : dimension === '3d' ? `vec3i(i32(p.x),i32(p.y),${layer})` : 'vec2i(p.xy)';
    const load = depthFormat
      ? multi
        ? 'textureLoad(source,vec2i(p.xy),sample)'
        : 'textureLoad(source,vec2i(p.xy),0)'
      : `textureLoad(source,${coordinates},${multi ? 'sample' : '0'})`;
    const cast = depthFormat || stencil ? `vec4f(vec3f(${depthFormat ? load : `f32(${load}.r)`}),1)` : `vec4f(${load})`;
    const channelValue =
      channel === 'rgba' ? 'value' : channel === 'rgb' ? 'vec4f(value.rgb,1)' : `vec4f(vec3f(value.${channel}),1)`;
    const code = `@group(0) @binding(0) var source:${kind};
@group(0) @binding(1) var<uniform> mapping:vec4f;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4f(x*2-1,y*2-1,0,1);}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
var value=vec4f(0);${multi ? `for(var sample=0;sample<${texture.sampleCount};sample++){value+=${cast};} value/=f32(${texture.sampleCount});` : `value=${cast};`}
value=clamp((value*vec4f(mapping.xxx,1)-vec4f(mapping.yyy,0))/vec4f(mapping.zzz,1),vec4f(0),vec4f(1));${texture.format.endsWith('-srgb') ? 'value=vec4f(select(1.055*pow(value.rgb,vec3f(1.0/2.4))-0.055,value.rgb*12.92,value.rgb<=vec3f(0.0031308)),value.a);' : ''}return ${channelValue};}`;
    const resources: { destroy(): void }[] = [];
    const own = <T extends { destroy(): void }>(resource: T): T => {
      resources.push(resource);
      return resource;
    };
    let buffer: GPUBuffer | undefined;
    try {
      // Explicit suppression: our output texture is a viewer implementation detail, never another user texture.
      previewDepth++;
      let output: GPUTexture;
      try {
        output = own(
          device.createTexture({
            label: 'Texture inspector preview',
            size: [width, height],
            format: 'rgba8unorm',
            usage: 17,
          }),
        );
      } finally {
        previewDepth--;
      }
      const uniform = own(device.createBuffer({ size: 16, usage: 72 }));
      device.queue.writeBuffer(uniform, 0, new Float32Array([exposure, range[0], range[1] - range[0], 0]));
      const module = device.createShaderModule({ label: 'Texture inspector channels', code });
      const layout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 2,
            texture: {
              sampleType: depthFormat
                ? 'depth'
                : integer || stencil
                  ? scalar === 'u32'
                    ? 'uint'
                    : 'sint'
                  : 'unfilterable-float',
              viewDimension: dimension,
              multisampled: multi,
            },
          },
          { binding: 1, visibility: 2, buffer: { type: 'uniform' } },
        ],
      });
      const pipeline = await this.wait(
        device.createRenderPipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: 'triangle-list' },
        }),
        signal,
      );
      this.alive();
      signal.throwIfAborted();
      const view = texture.createView({
        dimension,
        baseMipLevel: mip,
        mipLevelCount: 1,
        ...(dimension === '2d' ? { baseArrayLayer: layer, arrayLayerCount: 1 } : {}),
        aspect,
      });
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: { buffer: uniform } },
        ],
      });
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      buffer = own(device.createBuffer({ size: bytesPerRow * height, usage: 9 }));
      const encoder = device.createCommandEncoder({ label: 'Texture inspector preview' }),
        pass = encoder.beginRenderPass({
          colorAttachments: [
            { view: output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
          ],
        });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow }, [width, height]);
      device.queue.submit([encoder.finish()]);
      const pending = buffer.mapAsync(1);
      await this.wait(pending, signal);
      this.alive();
      signal.throwIfAborted();
      const mapped = new Uint8Array(buffer.getMappedRange()),
        data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        data.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      buffer.unmap();
      return { width, height, data };
    } finally {
      for (const resource of resources.reverse()) resource.destroy();
    }
  }
  private async wait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending;
    let stop!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  /** Stops capture, removes owned wrappers and forgets metadata. User textures are never destroyed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort(fault('disposed', 'Texture capture is disposed; start a new capture'));
    this.options.signal?.removeEventListener('abort', this.abort);
    for (const cleanup of this.cleanup.reverse()) cleanup();
    this.cleanup.length = 0;
    this.records.clear();
    this.listeners.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** A texture list, dimensions/format/mip metadata, and channel/mip/layer controls. */
export interface TextureViewerOptions {
  /** Default document.body. */
  parent?: HTMLElement | ShadowRoot;
  signal?: AbortSignal;
}
/** DOM texture explorer; attach after the scene has loaded using its startup capture. */
export class TextureViewer {
  readonly element: HTMLFieldSetElement;
  readonly canvas: HTMLCanvasElement;
  private readonly list: HTMLSelectElement;
  private readonly mip: HTMLInputElement;
  private readonly layer: HTMLInputElement;
  private readonly channel: HTMLSelectElement;
  private readonly aspect: HTMLSelectElement;
  private readonly exposure: HTMLInputElement;
  private readonly rangeMin: HTMLInputElement;
  private readonly rangeMax: HTMLInputElement;
  private readonly status: HTMLOutputElement;
  private readonly metadata: HTMLPreElement;
  private readonly stop: () => void;
  private disposed = false;
  private request = 0;
  private pending?: AbortController;
  private readonly abort = () => this.dispose();
  static attach(capture: TextureCapture, options: TextureViewerOptions = {}): TextureViewer {
    return new TextureViewer(capture, options);
  }
  constructor(
    readonly capture: TextureCapture,
    private readonly options: TextureViewerOptions = {},
  ) {
    options.signal?.throwIfAborted();
    const parent = options.parent ?? document.body,
      doc = parent.ownerDocument!;
    this.element = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    legend.textContent = 'Textures';
    this.element.append(legend);
    this.list = doc.createElement('select');
    this.list.setAttribute('aria-label', 'Texture');
    this.element.append(this.list);
    const number = (label: string) => {
      const input = doc.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.value = '0';
      input.setAttribute('aria-label', label);
      this.element.append(input);
      return input;
    };
    this.mip = number('Mip level');
    this.layer = number('Layer or slice');
    this.exposure = number('Texture exposure');
    this.exposure.value = '1';
    this.exposure.step = 'any';
    this.rangeMin = number('Texture range minimum');
    this.rangeMin.removeAttribute('min');
    this.rangeMin.step = 'any';
    this.rangeMax = number('Texture range maximum');
    this.rangeMax.removeAttribute('min');
    this.rangeMax.value = '1';
    this.rangeMax.step = 'any';
    this.aspect = doc.createElement('select');
    this.aspect.setAttribute('aria-label', 'Texture aspect');
    for (const value of ['default', 'depth-only', 'stencil-only']) {
      const option = doc.createElement('option');
      option.value = option.textContent = value;
      this.aspect.append(option);
    }
    this.element.append(this.aspect);
    this.channel = doc.createElement('select');
    this.channel.setAttribute('aria-label', 'Texture channel');
    for (const value of ['rgba', 'rgb', 'r', 'g', 'b', 'a']) {
      const option = doc.createElement('option');
      option.value = option.textContent = value;
      this.channel.append(option);
    }
    this.element.append(this.channel);
    this.metadata = doc.createElement('pre');
    this.element.append(this.metadata);
    this.canvas = doc.createElement('canvas');
    this.canvas.style.cssText =
      'max-width:100%;image-rendering:pixelated;background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0/16px 16px';
    this.element.append(this.canvas);
    this.status = doc.createElement('output');
    this.status.setAttribute('role', 'status');
    this.element.append(this.status);
    this.list.addEventListener('change', () => {
      this.mip.value = this.layer.value = '0';
      void this.render();
    });
    for (const input of [this.mip, this.layer, this.channel, this.aspect, this.exposure, this.rangeMin, this.rangeMax])
      input.addEventListener('change', () => void this.render());
    this.stop = capture.onChange(() => this.refresh());
    parent.append(this.element);
    options.signal?.addEventListener('abort', this.abort, { once: true });
    this.refresh();
  }
  /** Updates live metadata/list while preserving the selected resource. */
  refresh(): void {
    if (this.disposed) return;
    const textures = this.capture.list(),
      selected = this.list.value;
    this.list.replaceChildren();
    for (const info of textures) {
      const option = this.element.ownerDocument.createElement('option');
      option.value = String(info.id);
      option.textContent = `${info.label || `Texture ${info.id}`} | ${info.width} x ${info.height} x ${info.depthOrArrayLayers} | ${info.format} | ${info.mipLevelCount} mips`;
      this.list.append(option);
    }
    if (textures.some((t) => String(t.id) === selected)) this.list.value = selected;
    void this.render();
  }
  /** Displays a resource and optional subresource/channel selection. Resolves after its pixels are visible. */
  async select(id: number, options: TexturePreviewOptions = {}): Promise<void> {
    if (this.disposed) throw fault('disposed', 'Texture viewer is disposed; attach a new viewer');
    if (!this.capture.list().some((t) => t.id === id))
      throw fault('state', 'Texture is absent; refresh and select a listed texture');
    this.list.value = String(id);
    this.mip.value = String(options.mip ?? 0);
    this.layer.value = String(options.layer ?? 0);
    this.channel.value = options.channel ?? 'rgba';
    this.aspect.value = options.aspect ?? 'default';
    this.exposure.value = String(options.exposure ?? 1);
    this.rangeMin.value = String(options.range?.[0] ?? 0);
    this.rangeMax.value = String(options.range?.[1] ?? 1);
    await this.render(options);
  }
  private async render(options: TexturePreviewOptions = {}): Promise<void> {
    const ticket = ++this.request;
    this.pending?.abort();
    this.pending = new AbortController();
    const info = this.capture.list().find((t) => String(t.id) === this.list.value);
    if (!info) {
      this.metadata.textContent = 'No captured textures';
      this.canvas.width = this.canvas.height = 1;
      return;
    }
    this.metadata.textContent = `${info.width} x ${info.height} x ${info.depthOrArrayLayers}\n${info.format} | ${info.dimension} | ${info.mipLevelCount} mips | ${info.sampleCount} samples`;
    this.mip.max = String(info.mipLevelCount - 1);
    this.layer.max = String(
      (info.dimension === '3d'
        ? Math.max(1, info.depthOrArrayLayers >> Number(this.mip.value))
        : info.depthOrArrayLayers) - 1,
    );
    try {
      const result = await this.capture.preview(info.id, {
        ...options,
        mip: Number(this.mip.value),
        layer: Number(this.layer.value),
        channel: this.channel.value as TextureChannel,
        aspect: this.aspect.value === 'default' ? undefined : (this.aspect.value as GPUTextureAspect),
        exposure: Number(this.exposure.value),
        range: [Number(this.rangeMin.value), Number(this.rangeMax.value)],
        signal: options.signal ? AbortSignal.any([options.signal, this.pending.signal]) : this.pending.signal,
      });
      if (this.disposed || ticket !== this.request) return;
      this.canvas.width = result.width;
      this.canvas.height = result.height;
      const context = this.canvas.getContext('2d')!,
        pixels = context.createImageData(result.width, result.height);
      pixels.data.set(result.data);
      context.putImageData(pixels, 0, 0);
      this.status.textContent = '';
    } catch (error) {
      if (!this.disposed && ticket === this.request)
        this.status.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  /** Removes the panel and cancels its pending preview. Capture and user textures remain owned by the caller. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.request++;
    this.pending?.abort();
    this.stop();
    this.options.signal?.removeEventListener('abort', this.abort);
    this.element.remove();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
