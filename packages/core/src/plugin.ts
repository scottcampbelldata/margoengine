import type { Engine, Mesh } from './engine.js';
import type { Camera } from './camera.js';
import type { Batch } from './renderer.js';

/** Options for `PassContext.draw`, which draws every batch in one render pass. The WebGPU fields apply to WebGPU only. */
export interface DrawOptions {
  /** Pipeline to draw with. Default core's pipeline, or one built from the context's `shader`/`format`/`descriptor`. */
  pipeline?: GPURenderPipeline;
  /** Extra bind group 0 entries after core's uniform at binding 0. Default the context's `bindings`. */
  bindings?: GPUBindGroupEntry[];
  /** Clear the whole color/depth attachments before drawing instead of loading them, regardless of rectangles. Default true. */
  clear?: boolean;
  /** Viewport [x, y, width, height] in top-left drawing-buffer pixels. Integer origin >= 0 and size > 0, within context dimensions. Does not change camera aspect. */
  viewport?: readonly [number, number, number, number];
  /** Independent clipping rectangle, in the same pixels/bounds as viewport. Omitted means the full target. Custom target owners must report their dimensions. */
  scissor?: readonly [number, number, number, number];
  /** Stencil clear value when the depth format has stencil; setting it clears stencil even with `clear: false`. Default 0. */
  stencilClear?: number;
  /** Draw with drawIndexedIndirect. Default the context's `indirect`. */
  indirect?: boolean;
  /** Extra color attachments after the main color target. */
  colorAttachments?: GPURenderPassColorAttachment[];
  /** Marks a draw that writes per-mesh ids (factors.w) into an extra attachment. Core ignores it; a package drawing claimed batches' meshes from its own buffers draws them one mesh at a time so each writes its own id. Default false. */
  partIds?: boolean;
}
/**
 * What a {@link FramePass} receives each frame: `delta` in seconds, the drawing-buffer `width`/`height` in pixels,
 * the camera, `draw`, and the backend-specific device handles.
 */
export type PassContext = {
  delta: number;
  width: number;
  height: number;
  camera: Camera;
  draw(options?: DrawOptions): void;
} & (
  | {
      backend: 'webgpu';
      /** This frame's drawn batches in draw order (read-only except Batch.redirect); absent in pick passes. */
      batches?: readonly Batch[];
      device: GPUDevice;
      encoder: GPUCommandEncoder;
      color: GPUTextureView;
      depth: GPUTextureView;
      format: GPUTextureFormat;
      shader: string;
      bindings: GPUBindGroupEntry[];
      indirect: boolean;
      descriptor: GPURenderPipelineDescriptor;
    }
  | { backend: 'webgl2'; gl: WebGL2RenderingContext }
);
/**
 * A frame graph step. `name` must be non-empty and unique in the graph; passes run by ascending finite `order` (the
 * built-in 'main' pass has order 0). Optional `prepare` runs on WebGPU picks, before the pick pipeline is built from the
 * context's `shader`.
 */
export interface FramePass {
  name: string;
  order: number;
  execute(context: PassContext): void;
  prepare?(context: PassContext): void;
}
/**
 * Runtime plugin attached with `engine.use(plugin)`. `name` must be non-empty and unique per engine. `setup` and
 * `registerPasses` run once on attach (passes are removed with the plugin), `onPreUpdate` receives each frame's delta in
 * seconds, `onPick` replaces the built-in pick, and `dispose` runs on removal or engine disposal.
 */
export interface EnginePlugin {
  name: string;
  setup(engine: Engine): void;
  onPreUpdate?(delta: number): void;
  registerPasses?(graph: FrameGraph): void;
  onDeviceRestored?(engine: Engine): void;
  onPick?(x: number, y: number): Promise<Mesh | null>;
  dispose?(): void;
}

/**
 * Ordered render passes, starting with the built-in 'main' pass (order 0). `add` returns a remover. `add` and removal
 * throw Error 'Graph executing' during a frame, `add` throws TypeError for an invalid or duplicate pass, and nested
 * `execute`/`prepare` throws Error 'Graph recursion'.
 */
export class FrameGraph {
  revision = 0;
  private passes: Array<FramePass & { owner?: string }> = [
    { name: 'main', order: 0, execute: (context) => context.draw() },
  ];
  private owner?: string;
  private executing = false;
  add(pass: FramePass): () => void {
    if (this.executing) throw new Error('Graph executing');
    if (
      !pass.name ||
      !Number.isFinite(pass.order) ||
      typeof pass.execute !== 'function' ||
      this.passes.some((p) => p.name === pass.name)
    )
      throw new TypeError('Invalid pass');
    const record = { ...pass, owner: this.owner };
    this.passes.push(record);
    this.passes.sort((a, b) => a.order - b.order);
    this.revision++;
    return () => {
      if (this.executing) throw new Error('Graph executing');
      this.passes = this.passes.filter((p) => p !== record);
      this.revision++;
    };
  }
  withOwner(owner: string, register: () => void): void {
    const previous = this.owner;
    this.owner = owner;
    try {
      register();
    } finally {
      this.owner = previous;
    }
  }
  removeOwner(owner: string): void {
    if (this.executing) throw new Error('Graph executing');
    this.passes = this.passes.filter((p) => p.owner !== owner);
    this.revision++;
  }
  execute(context: PassContext): void {
    if (this.executing) throw new Error('Graph recursion');
    this.executing = true;
    try {
      for (const pass of this.passes) pass.execute(context);
    } finally {
      this.executing = false;
    }
  }
  prepare(context: PassContext): void {
    if (this.executing) throw new Error('Graph recursion');
    this.executing = true;
    try {
      for (const pass of this.passes) pass.prepare?.(context);
    } finally {
      this.executing = false;
    }
  }
}
