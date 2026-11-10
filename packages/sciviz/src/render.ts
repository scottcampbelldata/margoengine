// The sciviz render plugin: one frame-graph pass (after the scene, before points and fat lines) that draws the layers
// with pipelines of their own (surfaces, slices, isosurfaces opaque with depth; volumes blended over them), reading the
// camera from the frame. Layers may also encode compute work before the pass (an isosurface extraction, an upload).
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import type { EngineKernel } from '@margoengine/core';
import type { ComputeContext } from '@margoengine/compute';
import { invertMatrix } from '@margoengine/math/mat4';
import { overlayDepthPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';
import { fault } from '../../shared/errors.js';
import { VolumeDepthCapture, VolumeDepthSnapshot } from './volume-depth.js';
import type { FallbackBackend } from './fallback-types.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number; VERTEX: number; INDIRECT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number; COMPUTE: number };

/** @internal The WebGPU frame context. */
export type GpuContext = Extract<PassContext, { backend: 'webgpu' }>;
/** @internal The native WebGL2 engine frame context. */
export type GlContext = Extract<PassContext, { backend: 'webgl2' }>;

/** @internal Refuses a GPU-only layer before allocation or publication. */
export function requireGPU(renderer: SciRenderer): void {
  if (!renderer.device) throw fault('unsupported', 'Use WebGPU or webgl2-compat', 'sciviz');
}

/** @internal What the renderer draws: a layer with its own pipeline. */
export interface Drawable {
  /** Blended layers draw after opaque ones, farthest first. */
  readonly transparent: boolean;
  /** False skips the layer. */
  visible: boolean;
  /** @internal Ray integration consumes a snapshot of opaque scene depth. */
  readonly needsSceneDepth?: boolean;
  /** Rebuilds device-owned resources after replacement. */
  restore(): void | Promise<void>;
  /** Scene-space point for sorting transparent layers. */
  center(): readonly [number, number, number];
  /** Compute or uploads before the render pass, in the frame's encoder. */
  prepare?(context: GpuContext, renderer: SciRenderer): void;
  /** Draws into the open pass (group 0 is the frame). */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void;
  /** Draws through the optional native WebGL2 backend. */
  drawGL?(context: GlContext): void;
  /** Frees GPU resources. */
  dispose(): void;
}

/** WGSL every sciviz pipeline shares: the frame uniform and the output encoding. */
export const frameWGSL = /* Shader notes kept outside the uploaded source:
 * Linear light to the canvas: sRGB-encoded unless the target format encodes it already (viewport.z).
 * A key light from over the viewer's shoulder plus a soft fill, so shapes read without a scene light set-up.
 */ /* wgsl */ `struct Frame { clip: mat4x4f, inverse: mat4x4f, eye: vec4f, viewport: vec4f }
@group(0) @binding(0) var<uniform> frame: Frame;
fn toOutput(c: vec3f) -> vec3f {
  if (frame.viewport.z < 0.5) { return c; }
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, 12.92 * x, x <= vec3f(0.0031308));
}
fn shade(albedo: vec3f, normal: vec3f, toEye: vec3f) -> vec3f {
  let n = select(-normal, normal, dot(normal, toEye) >= 0.0);
  let key = normalize(toEye + vec3f(0.35, 0.6, 0.2));
  let diffuse = max(dot(n, key), 0.0);
  let halfway = normalize(key + toEye);
  let specular = pow(max(dot(n, halfway), 0.0), 48.0) * 0.25;
  return albedo * (0.28 + 0.72 * diffuse) + vec3f(specular);
}`;

let serial = 0;

/**
 * Draws sciviz layers in an engine's frame. Created by `Figure` (one per figure); use it directly only for layers you
 * place yourself.
 */
export class SciRenderer implements EnginePlugin {
  /** @internal Optional CPU extractor, installed only by sciviz/fallback. */
  cpuIsosurface?: (data: Float32Array, level: number, options: {
    dims: readonly [number, number, number]; maxTriangles: number; signal: AbortSignal;
  }) => Promise<{ vertices: Float32Array; triangles: number }>;
  /** Plugin name, unique per renderer. */
  readonly name = `sciviz:${serial++}`;
  /** Frame-graph order: after the scene (0), before points (10) and fat lines (20). */
  readonly order: number;
  /** @internal Optional driver; the root does not import its implementation. */
  readonly fallback: FallbackBackend | undefined;
  /** @internal */ device: GPUDevice | undefined;
  /** @internal */ frameLayout: GPUBindGroupLayout | undefined;
  /** @internal */ frameGroup: GPUBindGroup | undefined;
  /** @internal Group 2 for volume ray termination. */
  depthLayout: GPUBindGroupLayout | undefined;
  /** @internal Current opaque depth snapshot. */
  depthGroup: GPUBindGroup | undefined;
  /** @internal Current opaque depth texture for pre-pass volume integration. */
  depthView: GPUTextureView | undefined;
  #depthCapture: VolumeDepthCapture | undefined;
  readonly #depthSnapshot = new VolumeDepthSnapshot();
  #frameBuffer: GPUBuffer | undefined;
  readonly #frame = new Float32Array(40);
  readonly #inverse = new Float32Array(16);
  readonly #drawables = new Set<Drawable>();
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #pass = overlayDepthPass();
  #engine: Engine | undefined;
  #disposed = false;
  #restoring: Promise<void> = Promise.resolve();
  #restoreError: unknown;
  #compute: Promise<ComputeContext> | undefined;

  /** @internal One lazily created compute context shared by the figure's CPU-backed extractions. */
  compute(): Promise<ComputeContext> {
    requireGPU(this);
    const device = this.device!;
    return (this.#compute ??= import('@margoengine/compute').then(({ createCompute }) => createCompute({ device })));
  }

  #clearCompute(): void {
    void this.#compute?.then(
      (gpu) => gpu.dispose(),
      () => {},
    );
    this.#compute = undefined;
  }

  /** Creates a renderer and adds it to `engine` (WebGPU backend). */
  static attach(engine: EngineKernel, options: { readonly order?: number } = {}): SciRenderer {
    const renderer = new SciRenderer(options);
    (engine as unknown as Engine).use(renderer);
    return renderer;
  }

  /** @param options `order` in the frame graph (default 5). Attach with {@link SciRenderer.attach}. */
  constructor(options: { readonly order?: number; readonly fallback?: FallbackBackend } = {}) {
    this.order = options.order ?? 5;
    this.fallback = options.fallback;
  }

  /** @internal EnginePlugin hook. */
  setup(engine: Engine): void {
    if (!engine.gpu && !this.fallback) throw fault('unsupported', 'Use attachWebGL2 from sciviz/webgl2', 'sciviz');
    this.#engine = engine;
    if (engine.gpu) this.#create(engine.gpu);
    else this.fallback!.setup(engine);
  }

  #create(device: GPUDevice): void {
    this.device = device;
    this.#pipelines.clear();
    this.#depthSnapshot.dispose();
    this.depthGroup = undefined;
    this.depthView = undefined;
    this.depthLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }],
    });
    this.#frameBuffer = device.createBuffer({
      size: this.#frame.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.frameLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.frameGroup = device.createBindGroup({
      layout: this.frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.#frameBuffer } }],
    });
  }

  /** @internal EnginePlugin hook: layers rebuild their GPU data on the new device. */
  onDeviceRestored(engine: Engine): void {
    if (engine.gpu) this.#create(engine.gpu);
    this.#restoreError = undefined;
    const restoring = Promise.all([...this.#drawables].map((d) => Promise.resolve().then(() => d.restore()))).then(
      () => {},
    );
    this.#restoring = restoring;
    // Observe failures immediately, and report them through ready() and subsequent renders.
    void restoring.catch((error: unknown) => {
      if (this.#restoring === restoring) this.#restoreError = error;
    });
    this.#clearCompute();
  }

  /** @internal Waits for asynchronous layer reconstruction. */
  ready(): Promise<void> {
    return this.#restoring;
  }

  /** @internal EnginePlugin hook. */
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: (context) => this.#execute(context) });
  }

  /** The engine the renderer is attached to. */
  get engine(): Engine {
    if (!this.#engine) throw fault('state', 'Attach SciRenderer first', 'sciviz');
    return this.#engine;
  }

  /** @internal Adds a layer. */
  add(drawable: Drawable): void {
    this.#drawables.add(drawable);
    if (drawable.needsSceneDepth && this.#engine && this.device) {
      this.#depthCapture ??= VolumeDepthCapture.attach(this.#engine);
      this.#depthCapture.members.add(drawable);
    }
  }

  /** @internal Removes a layer (without disposing it). */
  remove(drawable: Drawable): void {
    this.#drawables.delete(drawable);
    this.#depthCapture?.forget(drawable);
  }

  /** @internal A render pipeline for the frame's colour format, depth format and samples, cached by `key`. */
  pipeline(
    key: string,
    context: GpuContext,
    build: (target: {
      format: GPUTextureFormat;
      depth: GPUTextureFormat;
      multisample?: GPUMultisampleState;
    }) => GPURenderPipelineDescriptor,
  ): GPURenderPipeline {
    const depth = context.descriptor.depthStencil!.format,
      full = `${key}|${context.format}|${depth}|${context.descriptor.multisample?.count ?? 1}`;
    let pipeline = this.#pipelines.get(full);
    if (!pipeline) {
      pipeline = this.device!.createRenderPipeline(
        build({ format: context.format, depth, multisample: context.descriptor.multisample }),
      );
      this.#pipelines.set(full, pipeline);
    }
    return pipeline;
  }

  #execute(context: PassContext): void {
    if (this.#restoreError) throw this.#restoreError;
    if (this.#disposed || !this.#drawables.size) return;
    const visible = [...this.#drawables].filter((d) => d.visible);
    if (!visible.length) return;
    if (context.backend === 'webgl2') {
      this.fallback!.render(context, visible);
      return;
    }
    const camera = context.camera,
      f = this.#frame,
      clip = camera.matrix;
    f.set(clip, 0);
    if (invertMatrix(clip, this.#inverse)) f.set(this.#inverse, 16);
    f.set([camera.position[0], camera.position[1], camera.position[2], 1], 32);
    const orthographic = !(clip[3] || clip[7] || clip[11]);
    f.set(
      [
        context.width,
        context.height,
        context.format.endsWith('-srgb') || context.format.includes('float') ? 0 : 1,
        orthographic ? 1 : 0,
      ],
      36,
    );
    this.device!.queue.writeBuffer(this.#frameBuffer!, 0, f);
    const depth = visible.some((d) => d.needsSceneDepth);
    for (const d of visible) if (!depth || !d.transparent) d.prepare?.(context, this);
    const pass = this.#pass;
    pass.colorAttachments[0].view = context.color;
    pass.depthStencilAttachment.view = context.depth;
    if (context.descriptor.depthStencil!.format.includes('stencil')) pass.depthStencilAttachment.stencilReadOnly = true;
    else delete pass.depthStencilAttachment.stencilReadOnly;
    let encoder = context.encoder.beginRenderPass(pass);
    applyView(encoder, context);
    encoder.setBindGroup(0, this.frameGroup!);
    const eye = camera.position,
      distance = (d: Drawable) => {
        const c = d.center();
        return Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]);
      };
    for (const d of visible) if (!d.transparent) d.draw(encoder, context, this);
    if (depth) {
      encoder.end();
      this.depthView = this.#depthSnapshot.update(context);
      this.depthGroup = this.device!.createBindGroup({
        layout: this.depthLayout!,
        entries: [{ binding: 0, resource: this.depthView }],
      });
      for (const d of visible) if (d.transparent) d.prepare?.(context, this);
      encoder = context.encoder.beginRenderPass(pass);
      applyView(encoder, context);
      encoder.setBindGroup(0, this.frameGroup!);
    }
    for (const d of visible.filter((x) => x.transparent).sort((a, b) => distance(b) - distance(a)))
      d.draw(encoder, context, this);
    encoder.end();
  }

  /** Disposes every layer and the frame buffer, and leaves the engine. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const d of this.#drawables) d.dispose();
    this.#drawables.clear();
    this.#frameBuffer?.destroy();
    this.#depthSnapshot.dispose();
    this.#clearCompute();
    this.#pipelines.clear();
    const engine = this.#engine;
    this.#engine = undefined;
    engine?.removePlugin(this.name);
  }

  /** Same as `dispose()`, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
