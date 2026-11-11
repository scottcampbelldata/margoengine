/// <reference lib="esnext.disposable" preserve="true" />
// The WebGPU-shaped GPU, adapter, device and queue of the compatibility layer (W3C WebGPU specification sections 4
// and 21 to 22), on one WebGL2 context per device. Validation errors go to error scopes or `uncapturederror`, as in
// WebGPU; what the layer cannot do throws MargoError code `unsupported`.
import type { CompatXR, CompatXROptions } from '../xr.js';
import { fault } from '../../../shared/errors.js';
import { webgl2Capabilities, type WebGL2Capabilities, type CompatTier } from '../index.js';
import type { TierFormats } from '../tiers.js';
import { extensions, type Extensions, GLObjects, GLState } from './gl.js';
import { nextGPUTask } from './tasks.js';
import { ExternalCopies } from './externals.js';
import { COMPRESSION_EXTENSIONS } from './formats.js';
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
  IDLE_PROGRAMS,
  type LinkedProgram,
  Replayer,
  writeTexture,
  copyExternalImage,
} from './render.js';

/** The vendor string compatibility adapters report, so apps and stats can show "compatibility mode". */
export const COMPAT_VENDOR = 'margo-webgl2';

/** Options for {@link CompatGPU}. */
export interface CompatGPUOptions {
  /** Lowest permitted device tier. Default `full`; use the `/tiers` entry to allow lower tiers. */
  readonly minimumTier?: CompatTier;
  /**
   * Makes the WebGL2 context a device renders with. Default: a new `OffscreenCanvas` (or a detached `<canvas>`)
   * with `antialias: false`, so exact-pixel rendering stays exact; the layer multisamples itself when a pipeline
   * asks for 4 samples.
   */
  readonly createContext?: (attributes: WebGLContextAttributes) => WebGL2RenderingContext | null;
  /**
   * The most work one compute dispatch may do on the CPU tier, counted in invocations plus loop iterations (default
   * {@link CPU_WORK_BUDGET}, 100,000,000: about one to three seconds of JavaScript). A dispatch that passes it (an
   * endless loop, or a dispatch too large for the CPU) stops, leaves its buffers and textures as they were, and is
   * reported as a `GPUInternalError` with MargoError code `failed`. Raise it for long, legitimate CPU kernels.
   */
  readonly cpuWorkBudget?: number;
}

/** The default {@link CompatGPUOptions.cpuWorkBudget}: invocations plus loop iterations per CPU-tier dispatch. */
export const CPU_WORK_BUDGET = 100_000_000;

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

/** Backed adapter limits. Array-layer capacity may exceed the device default and is negotiated at requestDevice. */
function limitsOf(caps: WebGL2Capabilities): Record<string, number> {
  const l = caps.limits,
    out = { ...WEBGPU_DEFAULT_LIMITS };
  const cap = (name: string, value: number) => (out[name] = Math.min(out[name], value));
  cap('maxTextureDimension1D', l.MAX_TEXTURE_SIZE);
  cap('maxTextureDimension2D', l.MAX_TEXTURE_SIZE);
  cap('maxTextureDimension3D', l.MAX_3D_TEXTURE_SIZE);
  out.maxTextureArrayLayers = l.MAX_ARRAY_TEXTURE_LAYERS;
  cap('maxSampledTexturesPerShaderStage', l.MAX_TEXTURE_IMAGE_UNITS);
  cap('maxSamplersPerShaderStage', l.MAX_TEXTURE_IMAGE_UNITS);
  cap('maxUniformBuffersPerShaderStage', Math.min(l.MAX_VERTEX_UNIFORM_BLOCKS, l.MAX_FRAGMENT_UNIFORM_BLOCKS));
  // A uniform buffer larger than a GL uniform block is read through a data texture: WebGPU's 64 KiB stands.
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
  // A compressed family only when every extension it needs is there (BC: s3tc, its sRGB twin, RGTC and BPTC).
  for (const [feature, names] of Object.entries(COMPRESSION_EXTENSIONS))
    if (names.every((n) => caps.extensions[n as keyof typeof caps.extensions])) f.add(feature);
  return f;
}

function defaultContext(attributes: WebGLContextAttributes): WebGL2RenderingContext | null {
  // A page canvas for XR: browsers differ on an XRWebGLLayer over an OffscreenCanvas context.
  const canvas =
    typeof OffscreenCanvas === 'function' && !attributes.xrCompatible
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

  /**
   * Runs `installXR` of `@margoengine/webgl2-compat/xr`, loading that entry only now. With it, code that holds
   * `navigator.gpu` finds the XR route of the layer without naming the layer, as `addXRButton` of `@margoengine/stage` does.
   */
  xrRoute(options?: CompatXROptions): Promise<CompatXR> {
    return import('../xr.js').then(({ installXR }) => installXR(options));
  }

  /** A WebGL2-backed adapter, or null when the browser has no WebGL2 at the `full` tier. */
  async requestAdapter(options: GPURequestAdapterOptions = {}): Promise<CompatAdapter | null> {
    const ranks = { ldr: 0, 'half-float': 1, full: 2 };
    const minimum = this.options.minimumTier ?? 'full';
    if (!Object.hasOwn(ranks, minimum)) throw new TypeError('minimumTier must be full, half-float or ldr');
    const budget = this.options.cpuWorkBudget ?? CPU_WORK_BUDGET;
    if (!(budget > 0))
      throw new RangeError('Invalid cpuWorkBudget; pass a positive number of invocations and loop iterations');
    if (options.forceFallbackAdapter) return Promise.resolve(null);
    const gl = (this.options.createContext ?? defaultContext)({
      ...ATTRIBUTES,
      powerPreference: options.powerPreference ?? 'default',
      xrCompatible: (options as { xrCompatible?: boolean }).xrCompatible,
    });
    if (!gl) return Promise.resolve(null);
    const caps = webgl2Capabilities(gl);
    if (!caps.highpFragment || ranks[caps.tier] < ranks[minimum]) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return Promise.resolve(null);
    }
    const formats = caps.tier === 'full' ? undefined : (await import('../tiers.js')).tierFormats(caps.tier);
    return new CompatAdapter(gl, caps, budget, formats);
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
    /** See {@link CompatGPUOptions.cpuWorkBudget}. */
    readonly cpuWorkBudget = CPU_WORK_BUDGET,
    /** @internal Lower-tier target selection, loaded only for a lower-tier adapter. */
    readonly tierFormats?: TierFormats,
  ) {
    this.features = featuresOf(capabilities);
    this.limits = Object.freeze(limitsOf(capabilities));
    this.info = Object.freeze({
      vendor: COMPAT_VENDOR,
      architecture: 'webgl2',
      device: capabilities.renderer,
      description: `WebGL2 compatibility layer (${capabilities.tier}) on ${capabilities.renderer}`,
    });
  }

  async requestDevice(descriptor: GPUDeviceDescriptor = {}): Promise<CompatDevice> {
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
    const device = new CompatDevice(this.gl, this, new Set(descriptor.requiredFeatures ?? []), descriptor);
    // Lower tiers cannot blit sample-only float textures. View synchronization can need the readback helper in
    // an ordinary render command, so make it available before exposing a device with these copy semantics.
    if (this.tierFormats) await device.loadReadback();
    return device;
  }
}

type ErrorFilter = 'validation' | 'out-of-memory' | 'internal';
type CompatError = CompatValidationError | CompatOutOfMemoryError | CompatInternalError;
/** The error object of a validation error (GPUValidationError's shape: `message`). */
export class CompatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GPUValidationError';
  }
}
/** The error object of an allocation the driver could not make (GPUOutOfMemoryError's shape). */
export class CompatOutOfMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GPUOutOfMemoryError';
  }
}
/** The error object of an internal error (GPUInternalError's shape), with a MargoError code. */
export class CompatInternalError extends Error {
  readonly code = 'failed';
  constructor(message: string) {
    super(message);
    this.name = 'GPUInternalError';
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
  /** @internal Every WebGL object the context made, held until the device deletes it (see GLObjects in gl.ts). */
  readonly objects: GLObjects;
  /** @internal The GL programs of its render pipelines by GLSL and vertex layout, least recently used first. */
  readonly linked = new Map<string, LinkedProgram>();
  /** Synchronous GPU-to-CPU reads the layer had to make (indirect arguments written by the GPU and the like). */
  stalls = 0;
  /** Compute dispatches run so far, per tier: fragment draws, point draws (scatter) and the CPU. */
  readonly dispatches = { fragment: 0, scatter: 0, cpu: 0 };
  /** Render passes replayed so far, and the draws replayed that drew something (work counts for tests and tuning). */
  readonly passes = { run: 0, draws: 0 };
  /**
   * Render programs made so far: how many, the milliseconds spent translating their WGSL to GLSL, and the
   * milliseconds from handing GLSL to WebGL2 to a known link status (with KHR_parallel_shader_compile, wall time
   * while the page went on).
   */
  readonly programs = { count: 0, translateMs: 0, linkMs: 0 };
  /** See {@link CompatGPUOptions.cpuWorkBudget}; may be raised or lowered at any time. */
  cpuWorkBudget: number;
  destroyed = false;
  onuncapturederror: ((event: Event) => void) | null = null;
  /** The sampler that loads and size queries use (no filtering, every level). */
  readonly loadSampler: WebGLSampler;
  private resolveLost!: (info: { reason: 'destroyed' | 'unknown'; message: string }) => void;
  private readonly scopes: { filter: ErrorFilter; error: CompatError | null }[] = [];
  /** Cached framebuffers by attachment key, with how to attach them again and the frame they were last attached in. */
  private readonly framebuffers = new Map<
    string,
    { fbo: WebGLFramebuffer; build: (fbo: WebGLFramebuffer) => void; frame: number }
  >();
  /**
   * @internal Frames this device's canvases have shown (CompatCanvasContext.present). A cached framebuffer is attached
   * again on its first use in each new frame: see {@link framebuffer}.
   */
  frame = 0;
  /** Canvas contexts with a frame waiting to be shown. */
  readonly presents = new Set<{ present(): void }>();
  /** Canvas contexts showing an image of this device's WebGL2 context. */
  readonly shown = new Set<{ keepFrame(): void }>();
  readonly replayer: Replayer;
  /** The texture each external source copies into, reused while its size stays. */
  // The storage behind imported external textures belongs to the layer, as a browser's does on native WebGPU: made
  // directly, not through createTexture, and expired with the import (see externals.ts).
  private readonly externals = new ExternalCopies<CompatTexture>(
    (width, height) =>
      new CompatTexture(this, { size: [width, height], format: 'rgba8unorm', usage: 0x16, label: 'external texture' }),
    (end) => void nextGPUTask().then(end),
  );
  /** The compute runtime, once its entry has loaded (the first compute pipeline loads it). */
  computeRuntime: ComputeRuntime | null = null;
  private computeLoad: Promise<void> | null = null;
  /** Texture read-back (readback.ts): loaded by the first submit that copies a texture to a buffer, and with compute. */
  readback: typeof import('./readback.js') | null = null;
  private readbackLoad: Promise<void> | null = null;

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly adapter: CompatAdapter,
    features: ReadonlySet<string>,
    descriptor: GPUDeviceDescriptor = {},
  ) {
    super();
    this.features = features;
    const defaultLayers = Math.min(WEBGPU_DEFAULT_LIMITS.maxTextureArrayLayers, adapter.limits.maxTextureArrayLayers),
      layers = Math.max(defaultLayers, descriptor.requiredLimits?.maxTextureArrayLayers ?? defaultLayers);
    if (layers > adapter.limits.maxTextureArrayLayers)
      throw new RangeError('Requested array layer limit exceeds the adapter capacity; use adapter.limits.maxTextureArrayLayers or fewer layers');
    this.limits = Object.freeze({ ...adapter.limits, maxTextureArrayLayers: layers });
    this.adapterInfo = adapter.info;
    this.cpuWorkBudget = adapter.cpuWorkBudget;
    this.objects = new GLObjects(gl);
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
    // WebGPU has no implicit colour dithering. GL enables it by default, including UNORM tier targets.
    this.state.enable(gl.DITHER, false);
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
    let v: unknown = (this.gl as unknown as Record<string, unknown>)[name];
    // Compressed formats' enums are on their extension objects, not on the context.
    for (const e of this.ext.compressed) v ??= e[name];
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
  popErrorScope(): Promise<CompatError | null> {
    const scope = this.scopes.pop();
    if (!scope) return Promise.reject(new DOMException('No error scope to pop', 'OperationError'));
    return Promise.resolve(scope.error);
  }
  /** Reports a validation error to the innermost validation scope, else as `uncapturederror`. */
  validationError(message: string): void {
    this.report('validation', new CompatValidationError(message));
  }
  /** Reports an internal error (a CPU-tier dispatch over its work budget) the same way, to an 'internal' scope. */
  internalError(message: string): void {
    this.report('internal', new CompatInternalError(message));
  }
  /**
   * After an allocation (bufferData, texStorage, renderbufferStorage): WebGL2 reports a store the driver could not make
   * only as GL_OUT_OF_MEMORY from getError, and the object then draws as if empty. That becomes an `out-of-memory` error
   * (to its scope, else `uncapturederror`), as WebGPU reports a failed allocation; any other GL error left by the layer
   * becomes an `internal` one. One getError per allocation, never per draw or submit.
   */
  allocated(what: string): void {
    for (let i = 0, e = this.gl.getError(); e !== 0 && i < 8; i++, e = this.gl.getError()) {
      if (e === 0x0505) this.report('out-of-memory', new CompatOutOfMemoryError(`WebGL2 is out of memory for ${what}`));
      else if (typeof e === 'number' && !this.gl.isContextLost())
        this.report('internal', new CompatInternalError(`WebGL2 error 0x${e.toString(16)} at ${what}`));
      else return;
    }
  }
  private report(filter: ErrorFilter, error: CompatError): void {
    for (let i = this.scopes.length - 1; i >= 0; i--)
      if (this.scopes[i].filter === filter) {
        this.scopes[i].error ??= error;
        return;
      }
    const event = Object.assign(new Event('uncapturederror', { cancelable: true }), { error });
    this.dispatchEvent(event);
    this.onuncapturederror?.(event);
    // As browsers do: an uncaptured error nobody prevented shows in the console, so dropped work is never silent.
    if (!event.defaultPrevented) console.warn(`WebGL2 compatibility: uncaptured ${error.name}: ${error.message}`);
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
    for (const c of this.shown) c.keepFrame();
    this.shown.clear();
    this.lose('destroyed', 'The device was destroyed');
    this.externals.destroy();
    this.objects.destroy();
    this.ext.lose?.loseContext();
  }

  /**
   * @internal At the end of each submission, never during one: deletes the oldest idle programs beyond IDLE_PROGRAMS
   * (no live pipeline uses them), then the objects of collected resources and the deletes asked for while it replayed.
   */
  collect(): void {
    if (this.objects.dirty) {
      const idle: [string, LinkedProgram][] = [];
      for (const [key, e] of this.linked) {
        const live = e.users.filter((u) => !u || u.deref());
        e.users.splice(0, e.users.length, ...live);
        if (!live.length) idle.push([key, e]);
      }
      for (const [key, e] of idle.slice(0, Math.max(0, idle.length - IDLE_PROGRAMS))) {
        e.free();
        this.linked.delete(key);
      }
    }
    this.objects.collect();
  }

  /**
   * WebGL objects made and deleted so far, per kind (Buffer, Texture, Framebuffer, Program, VertexArray and the
   * rest). The device deletes every object it makes itself, never leaving one to the browser's garbage collector:
   * after destroy() the two counts match.
   */
  get glObjects(): { readonly created: Readonly<Record<string, number>>; readonly deleted: Readonly<Record<string, number>> } {
    return this.objects;
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
          void nextGPUTask().then(poll);
          return;
        }
        gl.deleteSync(sync);
        resolve();
      };
      void nextGPUTask().then(poll);
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

  /**
   * A framebuffer with these attachments, made once per attachment set and attached again on its first use after each
   * frame the device's canvas showed. Chrome on ANGLE's Metal back end drops every draw through a framebuffer whose
   * texture was uploaded to (texSubImage2D, from memory or a pixel unpack buffer) when the first draw through it comes
   * after the context's OffscreenCanvas was shown with transferToImageBitmap: no GL error, a complete framebuffer, the
   * texture keeps the uploaded data. Attaching the texture again before that draw makes it land (measured on an Apple
   * M6, HeadlessChrome 156.0.8078.4, raw WebGL2 with no layer: docs/known-bugs.md "Batch 132 audit: animation").
   */
  framebuffer(
    key: string,
    textures: readonly CompatTexture[],
    build: (fbo: WebGLFramebuffer) => void,
  ): WebGLFramebuffer {
    const cached = this.framebuffers.get(key);
    if (cached) {
      if (cached.frame !== this.frame) {
        cached.frame = this.frame;
        cached.build(cached.fbo);
      }
      return cached.fbo;
    }
    const fbo = this.gl.createFramebuffer() as WebGLFramebuffer;
    this.framebuffers.set(key, { fbo, build, frame: this.frame });
    for (const t of textures) t.framebuffers.add(key);
    build(fbo);
    return fbo;
  }

  dropFramebuffers(texture: CompatTexture): void {
    for (const key of texture.framebuffers) {
      const cached = this.framebuffers.get(key);
      if (cached) this.gl.deleteFramebuffer(cached.fbo);
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
        throw Object.assign(new DOMException(pipeline.failure, 'GPUPipelineError'), {
          reason: 'validation',
        });
      return pipeline;
    });
  }
  /**
   * Loads the compute runtime (the compute entry) once. A render-only page never calls this, so it never downloads
   * compute; command buffers with compute passes wait in the queue until it has loaded.
   */
  loadReadback(): Promise<void> {
    this.readbackLoad ??= import('./readback.js').then(
      (m) => {
        this.readback = m;
      },
      (error) => {
        this.lose(
          'unknown',
          `The read-back part of the WebGL2 compatibility layer did not load: ${(error as Error).message}`,
        );
        throw error;
      },
    );
    return this.readbackLoad;
  }

  loadCompute(): Promise<void> {
    this.computeLoad ??= import('../compute/runtime.js')
      .then((m) => m.computeRuntime(this))
      .then(
        (runtime) => {
          this.computeRuntime = runtime;
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
    return this.loadCompute().then(async () => {
      const pipeline = new CompatComputePipeline(this, descriptor);
      await pipeline.readyAsync();
      if (pipeline.failure)
        throw Object.assign(new DOMException(pipeline.failure, 'GPUPipelineError'), {
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
   * A video element's or VideoFrame's current frame as an external texture: copied into an rgba8unorm texture, since
   * WebGL2 has no zero-copy video. The copy expires when the importing task ends, as WebGPU's external texture does,
   * and the next import of the same size reuses it.
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
    const t = this.externals.take(source, w, h);
    copyExternalImage(this, { source: descriptor.source as never }, { texture: t } as never, [w, h]);
    return new CompatExternalTexture(t.createView(), descriptor.label ?? '');
  }
}

/** The GPUQueue: buffer and texture writes run at once; command buffers replay on submit. */
export class CompatQueue {
  label = '';
  /** Queue operations waiting for a lazy chunk, in submission order; null when nothing waits. */
  private backlog: (() => void)[] | null = null;
  private readonly loads: Promise<unknown>[] = [];
  /** Resolves when the waiting operations have run. */
  waiting: Promise<void> | null = null;
  constructor(private readonly device: CompatDevice) {}

  /** Runs `op` now, or after the operations already waiting. */
  private inOrder(op: () => void): void {
    if (this.backlog) this.backlog.push(op);
    else op();
  }
  /**
   * Queues `op` behind the operations waiting for a lazy chunk and answers true, or answers false when nothing
   * waits. A resource's destroy() goes through here: WebGPU frees it once the work submitted before is done.
   */
  afterWaiting(op: () => void): boolean {
    this.backlog?.push(op);
    return !!this.backlog;
  }

  /** Holds everything the queue gets from now on until `load` settles. */
  private hold(load: Promise<unknown>): void {
    this.loads.push(load);
    this.backlog ??= [];
    this.waiting ??= this.drain();
  }

  /** Runs the waiting operations once every load has finished; a failed load has lost the device, so they are dropped. */
  private async drain(): Promise<void> {
    const backlog = this.backlog as (() => void)[];
    let loaded = true;
    while (this.loads.length) await (this.loads.shift() as Promise<unknown>).catch(() => (loaded = false));
    this.backlog = null;
    this.waiting = null;
    if (loaded) for (const op of backlog) op();
  }

  submit(
    buffers: Iterable<{
      ops: readonly ((r: Replayer) => void)[];
      used?: boolean;
      compute?: boolean;
      readback?: boolean;
    }>,
  ): void {
    const d = this.device;
    if (d.destroyed) return;
    const list: { ops: readonly ((r: Replayer) => void)[]; compute?: boolean; readback?: boolean }[] = [];
    for (const cb of buffers) {
      if (cb.used) {
        d.validationError('A command buffer can be submitted once');
        continue;
      }
      cb.used = true;
      list.push(cb);
    }
    // What the commands need loads first; everything the queue gets meanwhile runs after, in order.
    if (!d.computeRuntime && list.some((cb) => cb.compute)) this.hold(d.loadCompute());
    if (!d.readback && list.some((cb) => cb.readback)) this.hold(d.loadReadback());
    this.inOrder(() => {
      d.objects.replaying++;
      try {
        for (const cb of list) if (!d.destroyed) d.replayer.run(cb.ops);
      } finally {
        d.objects.replaying--;
      }
      d.collect();
      d.flushPresents();
      // WebGPU's submit hands the commands to the GPU; WebGL2 may hold them back until a later flush, so a query or
      // copy submitted ahead of more work would only become available once that work finished too.
      if (!d.destroyed) d.gl.flush();
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

// writeBuffer copies its input before it returns (at once, or into a copy that waits its turn) and never changes it:
// the mark lets @margoengine/animation keep its uploaded-palette and morph weight caches on this queue as on the
// browser's own (known-bugs "Batch 132 audit: animation").
Object.defineProperty(CompatQueue.prototype.writeBuffer, Symbol.for('margoengine.writeBuffer.copiesInput'), {
  value: true,
});
