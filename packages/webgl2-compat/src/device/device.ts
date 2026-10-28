/// <reference lib="esnext.disposable" preserve="true" />
// The WebGPU-shaped GPU, adapter, device and queue of the compatibility layer (W3C WebGPU specification sections 4
// and 21 to 22), on one WebGL2 context per device. Validation errors go to error scopes or `uncapturederror`, as in
// WebGPU; what the layer cannot do throws MargoError code `unsupported`.
import { fault } from '../../../shared/errors.js';
import { webgl2Capabilities, type WebGL2Capabilities } from '../index.js';
import { extensions, type Extensions, GLState } from './gl.js';
import { CompatComputePipeline, type ComputeRuntime } from './compute.js';
import {
  CompatBindGroup,
  CompatBindGroupLayout,
  CompatBuffer,
  CompatExternalTexture,
  CompatPipelineLayout,
  CompatSampler,
  CompatShaderModule,
  CompatTexture,
} from './resources.js';
import {
  CompatCommandEncoder,
  CompatQuerySet,
  CompatRenderBundleEncoder,
  CompatRenderPipeline,
  Replayer,
  writeTexture,
  copyExternalImage,
} from './render.js';

/** The vendor string compatibility adapters report, so apps and stats can show "compatibility mode". */
export const COMPAT_VENDOR = 'margo-webgl2';

/** Options for {@link CompatGPU}. */
export interface CompatGPUOptions {
  /**
   * Makes the WebGL2 context a device renders with. Default: a new `OffscreenCanvas` (or a detached `<canvas>`)
   * with `antialias: false`, so exact-pixel rendering stays exact; the layer multisamples itself when a pipeline
   * asks for 4 samples.
   */
  readonly createContext?: (attributes: WebGLContextAttributes) => WebGL2RenderingContext | null;
}

const WEBGPU_DEFAULT_LIMITS: Record<string, number> = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxBindGroupsPlusVertexBuffers: 24,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8,
  maxBufferSize: 268435456,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxInterStageShaderVariables: 16,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 32,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
};

/** WebGPU limits from what the context reports (never above WebGPU's defaults, never above the context's own). */
function limitsOf(caps: WebGL2Capabilities): Record<string, number> {
  const l = caps.limits,
    out = { ...WEBGPU_DEFAULT_LIMITS };
  const cap = (name: string, value: number) => (out[name] = Math.min(out[name], value));
  cap('maxTextureDimension1D', l.MAX_TEXTURE_SIZE);
  cap('maxTextureDimension2D', l.MAX_TEXTURE_SIZE);
  cap('maxTextureDimension3D', l.MAX_3D_TEXTURE_SIZE);
  cap('maxTextureArrayLayers', l.MAX_ARRAY_TEXTURE_LAYERS);
  cap('maxSampledTexturesPerShaderStage', l.MAX_TEXTURE_IMAGE_UNITS);
  cap('maxSamplersPerShaderStage', l.MAX_TEXTURE_IMAGE_UNITS);
  cap('maxUniformBuffersPerShaderStage', Math.min(l.MAX_VERTEX_UNIFORM_BLOCKS, l.MAX_FRAGMENT_UNIFORM_BLOCKS));
  cap('maxUniformBufferBindingSize', l.MAX_UNIFORM_BLOCK_SIZE);
  // A storage buffer is read through an RGBA32UI data texture at most 2,048 texels (32 KiB) wide.
  cap('maxStorageBufferBindingSize', 2048 * 16 * l.MAX_TEXTURE_SIZE);
  out.minUniformBufferOffsetAlignment = Math.max(256, l.UNIFORM_BUFFER_OFFSET_ALIGNMENT);
  cap('maxVertexAttributes', l.MAX_VERTEX_ATTRIBS);
  // WebGL caps vertexAttribPointer strides at 255 bytes.
  cap('maxVertexBufferArrayStride', 255);
  cap('maxInterStageShaderVariables', Math.floor(l.MAX_VARYING_COMPONENTS / 4));
  cap('maxColorAttachments', Math.min(l.MAX_COLOR_ATTACHMENTS, l.MAX_DRAW_BUFFERS));
  return out;
}

/** WebGPU features the context can back. */
function featuresOf(caps: WebGL2Capabilities): Set<string> {
  const f = new Set<string>(['depth32float-stencil8']);
  if (caps.extensions.OES_texture_float_linear) f.add('float32-filterable');
  if (caps.extensions.EXT_color_buffer_float) f.add('rg11b10ufloat-renderable');
  if (caps.extensions.EXT_depth_clamp) f.add('depth-clip-control');
  return f;
}

function defaultContext(attributes: WebGLContextAttributes): WebGL2RenderingContext | null {
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(1, 1)
      : typeof document === 'object'
        ? document.createElement('canvas')
        : undefined;
  return (canvas?.getContext('webgl2', attributes) as WebGL2RenderingContext | null) ?? null;
}

const ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: false,
};

/** `navigator.gpu` of the compatibility layer. */
export class CompatGPU {
  readonly wgslLanguageFeatures: ReadonlySet<string> = new Set();
  constructor(private readonly options: CompatGPUOptions = {}) {}

  /** A WebGL2-backed adapter, or null when the browser has no WebGL2 at the `full` tier. */
  requestAdapter(options: GPURequestAdapterOptions = {}): Promise<CompatAdapter | null> {
    if (options.forceFallbackAdapter) return Promise.resolve(null);
    const gl = (this.options.createContext ?? defaultContext)({
      ...ATTRIBUTES,
      powerPreference: options.powerPreference ?? 'default',
    });
    if (!gl) return Promise.resolve(null);
    const caps = webgl2Capabilities(gl);
    if (!caps.supported) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return Promise.resolve(null);
    }
    return Promise.resolve(new CompatAdapter(gl, caps));
  }

  /** The canvas format the layer renders fastest: WebGL2 stores rgba. */
  getPreferredCanvasFormat(): GPUTextureFormat {
    return 'rgba8unorm';
  }
}

/** A GPUAdapter on one WebGL2 context; its one device gets that context. */
export class CompatAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
  readonly info: { vendor: string; architecture: string; device: string; description: string };
  readonly isFallbackAdapter = false;
  private used = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly capabilities: WebGL2Capabilities,
  ) {
    this.features = featuresOf(capabilities);
    this.limits = Object.freeze(limitsOf(capabilities));
    this.info = Object.freeze({
      vendor: COMPAT_VENDOR,
      architecture: 'webgl2',
      device: capabilities.renderer,
      description: `WebGL2 compatibility layer on ${capabilities.renderer}`,
    });
  }

  requestDevice(descriptor: GPUDeviceDescriptor = {}): Promise<CompatDevice> {
    if (this.used)
      return Promise.reject(
        new DOMException('This adapter already made its device; request a new adapter', 'OperationError'),
      );
    for (const f of descriptor.requiredFeatures ?? [])
      if (!this.features.has(f)) return Promise.reject(new TypeError(`The WebGL2 adapter has no feature '${f}'`));
    for (const [name, value] of Object.entries(descriptor.requiredLimits ?? {})) {
      if (value === undefined) continue;
      const have = this.limits[name];
      if (have === undefined) return Promise.reject(new TypeError(`Unknown limit '${name}'`));
      const better = name.startsWith('min') ? value < have : value > have;
      if (better) return Promise.reject(new DOMException(`The WebGL2 adapter's ${name} is ${have}`, 'OperationError'));
    }
    this.used = true;
    return Promise.resolve(new CompatDevice(this.gl, this, new Set(descriptor.requiredFeatures ?? [])));
  }
}

type ErrorFilter = 'validation' | 'out-of-memory' | 'internal';
/** The error object of a validation error (GPUValidationError's shape: `message`). */
export class CompatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GPUValidationError';
  }
}

/** A GPUDevice on WebGL2. */
export class CompatDevice extends EventTarget {
  label = '';
  readonly features: ReadonlySet<string>;
  readonly limits: Readonly<Record<string, number>>;
  readonly adapterInfo: CompatAdapter['info'];
  readonly queue: CompatQueue;
  readonly lost: Promise<{ reason: 'destroyed' | 'unknown'; message: string }>;
  readonly ext: Extensions;
  readonly state: GLState;
  /** Synchronous GPU-to-CPU reads the layer had to make (indirect arguments written by the GPU and the like). */
  stalls = 0;
  destroyed = false;
  onuncapturederror: ((event: Event) => void) | null = null;
  /** The sampler that loads and size queries use (no filtering, every level). */
  readonly loadSampler: WebGLSampler;
  private resolveLost!: (info: { reason: 'destroyed' | 'unknown'; message: string }) => void;
  private readonly scopes: { filter: ErrorFilter; error: CompatValidationError | null }[] = [];
  private readonly framebuffers = new Map<string, WebGLFramebuffer>();
  /** Canvas contexts with a frame waiting to be shown. */
  readonly presents = new Set<{ present(): void }>();
  readonly replayer: Replayer;
  /** The texture each external source copies into, reused while its size stays. */
  private readonly externals = new WeakMap<object, CompatTexture>();
  /** The compute runtime, once its entry has loaded (the first compute pipeline loads it). */
  computeRuntime: ComputeRuntime | null = null;
  private computeLoad: Promise<void> | null = null;

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly adapter: CompatAdapter,
    features: ReadonlySet<string>,
  ) {
    super();
    this.features = features;
    this.limits = adapter.limits;
    this.adapterInfo = adapter.info;
    this.ext = extensions(gl);
    this.state = new GLState(gl);
    this.lost = new Promise((resolve) => (this.resolveLost = resolve));
    const canvas = gl.canvas as EventTarget;
    canvas.addEventListener?.('webglcontextlost', (event) => {
      event.preventDefault();
      this.lose('unknown', 'The WebGL2 context was lost');
    });
    // WebGPU's conventions: clip z in [0, w], the first vertex provokes flat values, tight pixel rows.
    this.ext.clipControl?.clipControlEXT(this.ext.clipControl.LOWER_LEFT_EXT, this.ext.clipControl.ZERO_TO_ONE_EXT);
    this.ext.provoking?.provokingVertexWEBGL(this.ext.provoking.FIRST_VERTEX_CONVENTION_WEBGL);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.enable(gl.SCISSOR_TEST);
    this.state.enable(gl.SCISSOR_TEST, true);
    this.loadSampler = gl.createSampler() as WebGLSampler;
    gl.samplerParameteri(this.loadSampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.samplerParameteri(this.loadSampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.queue = new CompatQueue(this);
    this.replayer = new Replayer(this);
  }

  /** The value of a WebGL2 enum by name. */
  enum(name: string): number {
    const v = (this.gl as unknown as Record<string, number>)[name];
    if (typeof v !== 'number')
      throw fault('failed', `WebGL2 has no enum ${name} (a bug: report it)`, 'compatibility-layer');
    return v;
  }

  /** GL comparison function of a WebGPU compare function. */
  compare(f: GPUCompareFunction): number {
    const gl = this.gl;
    return (
      {
        never: gl.NEVER,
        less: gl.LESS,
        equal: gl.EQUAL,
        'less-equal': gl.LEQUAL,
        greater: gl.GREATER,
        'not-equal': gl.NOTEQUAL,
        'greater-equal': gl.GEQUAL,
        always: gl.ALWAYS,
      }[f] ?? gl.ALWAYS
    );
  }

  /** A coded refusal for something the layer cannot do (yet). */
  unsupported(what: string): Error {
    return fault('unsupported', `WebGL2 compatibility cannot do ${what}`, 'compatibility-layer');
  }

  // ---------------------------------------------------------------- errors

  pushErrorScope(filter: ErrorFilter): void {
    this.scopes.push({ filter, error: null });
  }
  popErrorScope(): Promise<CompatValidationError | null> {
    const scope = this.scopes.pop();
    if (!scope) return Promise.reject(new DOMException('No error scope to pop', 'OperationError'));
    return Promise.resolve(scope.error);
  }
  /** Reports a validation error to the innermost validation scope, else as `uncapturederror`. */
  validationError(message: string): void {
    const error = new CompatValidationError(message);
    for (let i = this.scopes.length - 1; i >= 0; i--)
      if (this.scopes[i].filter === 'validation') {
        this.scopes[i].error ??= error;
        return;
      }
    const event = Object.assign(new Event('uncapturederror'), { error });
    this.dispatchEvent(event);
    this.onuncapturederror?.(event);
  }

  // ---------------------------------------------------------------- lifetime

  lose(reason: 'destroyed' | 'unknown', message: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resolveLost({ reason, message });
  }

  /** Same as destroy(): frees the device and its WebGL2 context (the repository convention; WebGPU code calls destroy()). */
  dispose(): void {
    this.destroy();
  }

  /** Same as dispose(), for `using` (where the browser has Symbol.dispose). */
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.lose('destroyed', 'The device was destroyed');
    this.ext.lose?.loseContext();
  }

  /** Resolves when the GPU has finished every command submitted so far. */
  idle(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const waiting = this.queue.waiting;
    if (waiting) return waiting.then(() => this.idle());
    const gl = this.gl,
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (!sync) return Promise.resolve();
    return new Promise((resolve) => {
      const poll = () => {
        if (this.destroyed || gl.isContextLost()) {
          resolve();
          return;
        }
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) {
          setTimeout(poll, 1);
          return;
        }
        gl.deleteSync(sync);
        resolve();
      };
      setTimeout(poll, 0);
    });
  }

  /** Marks a canvas whose texture a replayed pass drew into; the submit shows it when it ends. */
  queuePresent(context: { present(): void }): void {
    this.presents.add(context);
  }

  /**
   * Shows the canvas frames a submit drew, as it ends: WebGPU shows a canvas texture's contents to anything that
   * reads the canvas in the same task (drawImage, toDataURL), so the page canvas cannot wait for a later microtask.
   */
  flushPresents(): void {
    if (this.destroyed) return;
    for (const c of [...this.presents]) c.present();
    this.presents.clear();
  }

  // ---------------------------------------------------------------- framebuffers

  /** A framebuffer with these attachments, made once per attachment set. */
  framebuffer(
    key: string,
    textures: readonly CompatTexture[],
    build: (fbo: WebGLFramebuffer) => void,
  ): WebGLFramebuffer {
    let fbo = this.framebuffers.get(key);
    if (!fbo) {
      fbo = this.gl.createFramebuffer() as WebGLFramebuffer;
      this.framebuffers.set(key, fbo);
      for (const t of textures) t.framebuffers.add(key);
      build(fbo);
    }
    return fbo;
  }

  dropFramebuffers(texture: CompatTexture): void {
    for (const key of texture.framebuffers) {
      const fbo = this.framebuffers.get(key);
      if (fbo) this.gl.deleteFramebuffer(fbo);
      this.framebuffers.delete(key);
    }
    texture.framebuffers.clear();
    this.state.forgetFramebuffers();
  }

  // ---------------------------------------------------------------- object creation

  createBuffer(descriptor: GPUBufferDescriptor): CompatBuffer {
    return new CompatBuffer(this, descriptor);
  }
  createTexture(descriptor: GPUTextureDescriptor): CompatTexture {
    return new CompatTexture(this, descriptor);
  }
  createSampler(descriptor?: GPUSamplerDescriptor): CompatSampler {
    return new CompatSampler(this, descriptor);
  }
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): CompatBindGroupLayout {
    return new CompatBindGroupLayout(descriptor);
  }
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): CompatPipelineLayout {
    return new CompatPipelineLayout(descriptor);
  }
  createBindGroup(descriptor: GPUBindGroupDescriptor): CompatBindGroup {
    return new CompatBindGroup(this, descriptor);
  }
  createShaderModule(descriptor: GPUShaderModuleDescriptor): CompatShaderModule {
    return new CompatShaderModule(this, descriptor);
  }
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): CompatRenderPipeline {
    return new CompatRenderPipeline(this, descriptor);
  }
  createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor): Promise<CompatRenderPipeline> {
    let pipeline: CompatRenderPipeline;
    try {
      pipeline = new CompatRenderPipeline(this, descriptor, true);
    } catch (error) {
      return Promise.reject(error);
    }
    return pipeline.whenLinked().then(() => {
      if (pipeline.failure)
        throw Object.assign(new DOMException(pipeline.failure, 'OperationError'), {
          name: 'GPUPipelineError',
          reason: 'validation',
        });
      return pipeline;
    });
  }
  /**
   * Loads the compute runtime (the compute entry) once. A render-only page never calls this, so it never downloads
   * compute; command buffers with compute passes wait in the queue until it has loaded.
   */
  loadCompute(): Promise<void> {
    this.computeLoad ??= import('../compute/runtime.js').then(
      (m) => {
        this.computeRuntime = m.computeRuntime(this);
      },
      (error) => {
        this.lose(
          'unknown',
          `The compute part of the WebGL2 compatibility layer did not load: ${(error as Error).message}`,
        );
        throw error;
      },
    );
    return this.computeLoad;
  }
  /**
   * A compute pipeline. Once the compute runtime has loaded, what no tier can run throws MargoError code
   * `unsupported` here; before that (the first pipeline of a page) it is planned at its first dispatch and a refusal
   * is a validation error then. createComputePipelineAsync always refuses at creation.
   */
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): CompatComputePipeline {
    const pipeline = new CompatComputePipeline(this, descriptor);
    if (this.computeRuntime) pipeline.ready();
    else void this.loadCompute().catch(() => undefined);
    return pipeline;
  }
  createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor): Promise<CompatComputePipeline> {
    return this.loadCompute().then(() => {
      const pipeline = new CompatComputePipeline(this, descriptor);
      pipeline.ready();
      if (pipeline.failure)
        throw Object.assign(new DOMException(pipeline.failure, 'OperationError'), {
          name: 'GPUPipelineError',
          reason: 'validation',
        });
      return pipeline;
    });
  }
  createCommandEncoder(descriptor: GPUCommandEncoderDescriptor = {}): CompatCommandEncoder {
    return new CompatCommandEncoder(this, descriptor.label ?? '');
  }
  createRenderBundleEncoder(descriptor: GPURenderBundleEncoderDescriptor): CompatRenderBundleEncoder {
    return new CompatRenderBundleEncoder(this, descriptor);
  }
  createQuerySet(descriptor: GPUQuerySetDescriptor): CompatQuerySet {
    return new CompatQuerySet(this, descriptor);
  }
  /**
   * A video element's or VideoFrame's current frame as an external texture: copied into an rgba8unorm texture (one
   * per source, reused while its size stays), since WebGL2 has no zero-copy video.
   */
  importExternalTexture(descriptor: GPUExternalTextureDescriptor): CompatExternalTexture {
    const source = descriptor.source as unknown as {
      videoWidth?: number;
      videoHeight?: number;
      displayWidth?: number;
      displayHeight?: number;
    };
    if ((descriptor.colorSpace ?? 'srgb') !== 'srgb')
      throw this.unsupported(`external textures in the '${descriptor.colorSpace}' colour space (only srgb)`);
    const w = source.videoWidth ?? source.displayWidth ?? 0,
      h = source.videoHeight ?? source.displayHeight ?? 0;
    if (!w || !h)
      throw new DOMException(
        'The video has no frame yet; import it once it has data (readyState 2 or more)',
        'InvalidStateError',
      );
    let t = this.externals.get(source);
    if (!t || t.width !== w || t.height !== h || t.destroyed) {
      t?.destroy();
      t = this.createTexture({ size: [w, h], format: 'rgba8unorm', usage: 0x16, label: 'external texture' });
      this.externals.set(source, t);
    }
    copyExternalImage(this, { source: descriptor.source as never }, { texture: t } as never, [w, h]);
    return new CompatExternalTexture(t.createView(), descriptor.label ?? '');
  }
}

/** The GPUQueue: buffer and texture writes run at once; command buffers replay on submit. */
export class CompatQueue {
  label = '';
  /** Queue operations waiting for the compute runtime, in submission order; null when nothing waits. */
  private backlog: (() => void)[] | null = null;
  /** Resolves when the waiting operations have run. */
  waiting: Promise<void> | null = null;
  constructor(private readonly device: CompatDevice) {}

  /** Runs `op` now, or after the operations already waiting. */
  private inOrder(op: () => void): void {
    if (this.backlog) this.backlog.push(op);
    else op();
  }

  submit(buffers: Iterable<{ ops: readonly ((r: Replayer) => void)[]; used?: boolean; compute?: boolean }>): void {
    const d = this.device;
    if (d.destroyed) return;
    const list: { ops: readonly ((r: Replayer) => void)[]; compute?: boolean }[] = [];
    for (const cb of buffers) {
      if (cb.used) {
        d.validationError('A command buffer can be submitted once');
        continue;
      }
      cb.used = true;
      list.push(cb);
    }
    if (!this.backlog && !d.computeRuntime && list.some((cb) => cb.compute)) {
      // The compute runtime loads first; everything the queue gets meanwhile runs after, in order.
      const backlog: (() => void)[] = (this.backlog = []);
      this.waiting = d.loadCompute().then(
        () => {
          this.backlog = null;
          this.waiting = null;
          for (const op of backlog) op();
        },
        () => {
          this.backlog = null;
          this.waiting = null;
        },
      );
    }
    this.inOrder(() => {
      for (const cb of list) if (!d.destroyed) d.replayer.run(cb.ops);
      d.flushPresents();
    });
  }

  writeBuffer(
    buffer: CompatBuffer,
    offset: number,
    data: BufferSource | SharedArrayBuffer,
    dataOffset = 0,
    size?: number,
  ): void {
    if (this.device.destroyed) return;
    const view = ArrayBuffer.isView(data) ? data : null;
    const unit =
      view && 'BYTES_PER_ELEMENT' in view ? (view as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT : 1;
    const base = view ? view.byteOffset : 0,
      total = view ? view.byteLength : (data as ArrayBuffer).byteLength;
    const start = dataOffset * unit,
      length = size === undefined ? total - start : size * unit;
    if (start + length > total || length % 4 || offset % 4 || offset + length > buffer.size) {
      this.device.validationError(
        'writeBuffer: the range is outside the data or the buffer, or not a multiple of 4 bytes',
      );
      return;
    }
    const bytes = new Uint8Array(view ? view.buffer : (data as ArrayBuffer), base + start, length);
    if (this.backlog) {
      const copy = bytes.slice();
      this.inOrder(() => buffer.write(offset, copy));
    } else buffer.write(offset, bytes);
  }

  writeTexture(
    destination: GPUTexelCopyTextureInfo,
    data: BufferSource | SharedArrayBuffer,
    layout: GPUTexelCopyBufferLayout,
    size: GPUExtent3D,
  ): void {
    if (this.device.destroyed) return;
    const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data as ArrayBuffer);
    let bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (this.backlog) bytes = bytes.slice();
    const target = { ...destination };
    this.inOrder(() => writeTexture(this.device, target as never, bytes, layout, size));
  }

  copyExternalImageToTexture(
    source: GPUCopyExternalImageSourceInfo,
    destination: GPUCopyExternalImageDestInfo,
    size: GPUExtent3D,
  ): void {
    if (this.device.destroyed) return;
    this.inOrder(() => copyExternalImage(this.device, source, destination as never, size));
  }

  onSubmittedWorkDone(): Promise<undefined> {
    return this.device.idle().then(() => undefined);
  }
}
