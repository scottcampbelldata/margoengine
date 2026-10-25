// The sciviz render plugin: one frame-graph pass (after the scene, before points and fat lines) that draws the layers
// with pipelines of their own (surfaces, slices, isosurfaces opaque with depth; volumes blended over them), reading the
// camera from the frame. Layers may also encode compute work before the pass (an isosurface extraction, an upload).
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { invertMatrix } from '@margoengine/math/mat4';
import { overlayDepthPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';
import { fault } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number; VERTEX: number; INDIRECT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number; COMPUTE: number };

/** @internal The WebGPU frame context. */
export type GpuContext = Extract<PassContext, { backend: 'webgpu' }>;

/** @internal What the renderer draws: a layer with its own pipeline. */
export interface Drawable {
  /** Blended layers draw after opaque ones, farthest first. */
  readonly transparent: boolean;
  /** False skips the layer. */
  visible: boolean;
  /** Scene-space point for sorting transparent layers. */
  center(): readonly [number, number, number];
  /** Compute or uploads before the render pass, in the frame's encoder. */
  prepare?(context: GpuContext, renderer: SciRenderer): void;
  /** Draws into the open pass (group 0 is the frame). */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void;
  /** Frees GPU resources. */
  dispose(): void;
}

/** WGSL every sciviz pipeline shares: the frame uniform and the output encoding. */
export const frameWGSL = /* wgsl */ `struct Frame { clip: mat4x4f, inverse: mat4x4f, eye: vec4f, viewport: vec4f }
@group(0) @binding(0) var<uniform> frame: Frame;
// Linear light to the canvas: sRGB-encoded unless the target format encodes it already (viewport.z).
fn toOutput(c: vec3f) -> vec3f {
  if (frame.viewport.z < 0.5) { return c; }
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, 12.92 * x, x <= vec3f(0.0031308));
}
// A key light from over the viewer's shoulder plus a soft fill, so shapes read without a scene light set-up.
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
  /** Plugin name, unique per renderer. */
  readonly name = `sciviz:${serial++}`;
  /** Frame-graph order: after the scene (0), before points (10) and fat lines (20). */
  readonly order: number;
  /** @internal */ device: GPUDevice | undefined;
  /** @internal */ frameLayout: GPUBindGroupLayout | undefined;
  /** @internal */ frameGroup: GPUBindGroup | undefined;
  #frameBuffer: GPUBuffer | undefined;
  readonly #frame = new Float32Array(40);
  readonly #inverse = new Float32Array(16);
  readonly #drawables = new Set<Drawable>();
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #pass = overlayDepthPass();
  #engine: Engine | undefined;
  #disposed = false;

  constructor(options: { readonly order?: number } = {}) {
    this.order = options.order ?? 5;
  }

  /** @internal EnginePlugin hook. */
  setup(engine: Engine): void {
    if (!engine.gpu) throw fault('unsupported', 'sciviz needs the WebGPU backend; the engine runs WebGL2', 'sciviz');
    this.#engine = engine;
    this.#create(engine.gpu);
  }

  #create(device: GPUDevice): void {
    this.device = device;
    this.#pipelines.clear();
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
    for (const d of this.#drawables) (d as Drawable & { restore?(): void }).restore?.();
  }

  /** @internal EnginePlugin hook. */
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: `${this.name}:draw`, order: this.order, execute: (context) => this.#execute(context) });
  }

  /** The engine the renderer is attached to. */
  get engine(): Engine {
    if (!this.#engine) throw fault('state', 'sciviz renderer is not attached; create a Figure on an engine', 'sciviz');
    return this.#engine;
  }

  /** @internal Adds a layer. */
  add(drawable: Drawable): void {
    this.#drawables.add(drawable);
  }

  /** @internal Removes a layer (without disposing it). */
  remove(drawable: Drawable): void {
    this.#drawables.delete(drawable);
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
    if (context.backend !== 'webgpu' || this.#disposed || !this.#drawables.size) return;
    const visible = [...this.#drawables].filter((d) => d.visible);
    if (!visible.length) return;
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
    for (const d of visible) d.prepare?.(context, this);
    const pass = this.#pass;
    pass.colorAttachments[0].view = context.color;
    pass.depthStencilAttachment.view = context.depth;
    if (context.descriptor.depthStencil!.format.includes('stencil')) pass.depthStencilAttachment.stencilReadOnly = true;
    else delete pass.depthStencilAttachment.stencilReadOnly;
    const encoder = context.encoder.beginRenderPass(pass);
    applyView(encoder, context);
    encoder.setBindGroup(0, this.frameGroup!);
    const eye = camera.position,
      distance = (d: Drawable) => {
        const c = d.center();
        return Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]);
      };
    for (const d of visible) if (!d.transparent) d.draw(encoder, context, this);
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
