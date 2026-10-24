import type { Engine, Mesh } from './engine.js';
import type { Camera } from './camera.js';
import type { Batch, RenderView } from './renderer.js';
import { fault, typeError } from '../../shared/errors.js';

/** Options for `PassContext.draw`, which draws every batch in one render pass. The WebGPU fields apply to WebGPU only. */
export interface DrawOptions {
  /** Pipeline to draw with. Default core's pipeline, or one built from the context's `shader`/`format`/`descriptor`. */
  pipeline?: GPURenderPipeline;
  /** Extra bind group 0 entries after core's uniform at binding 0. Default the context's `bindings`. */
  bindings?: GPUBindGroupEntry[];
  /**
   * Clear colour before drawing instead of loading it. Default true, except in a later view of a multi-view frame
   * (which loads, so earlier views stay) or when the view's `clear.color` is false. Inside a view rectangle only the
   * rectangle is cleared.
   */
  clear?: boolean;
  /** Clear depth before drawing. Default `clear` when set, else the view's `clear.depth`, else true. */
  clearDepth?: boolean;
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
  /**
   * The view being drawn; absent for a plain full-canvas frame. `viewport` and `scissor` are drawing-buffer pixels from
   * the top left, and `draw()` uses them by default. `id` is stable across frames, so effects key per-view history on
   * it. `index` is the view's place among the frame's views into the same canvas or target (later views load
   * colour), `count` their number.
   * `layers` is the layer mask in use (absent: every layer); packages that draw their own meshes test it with
   * `inView`. `target` is the view's target textures; absent for the canvas.
   */
  view?: {
    id: string;
    camera: Camera;
    viewport: readonly [number, number, number, number];
    scissor?: readonly [number, number, number, number];
    index: number;
    count: number;
    clear?: { color?: string | false; depth?: boolean };
    layers?: number;
    target?: { color: GPUTexture; depth?: GPUTexture };
  };
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
 * Runtime plugin attached with `engine.use(plugin)` or `scene.use(plugin)`. `name` must be non-empty and unique per scene. `setup` and
 * `registerPasses` run once on attach (passes are removed with the plugin), `onPreUpdate` receives each frame's delta in
 * seconds, `onPick` replaces the built-in pick, and `dispose` runs on removal or engine disposal.
 */
export interface EnginePlugin {
  name: string;
  setup(engine: Engine): void;
  onPreUpdate?(delta: number): void;
  registerPasses?(graph: FrameGraph): void;
  onDeviceRestored?(engine: Engine): void;
  /**
   * Replaces the built-in pick. `view` is the view picked through, rectangles in drawing-buffer pixels; absent for the
   * engine camera. Read the camera synchronously: the engine restores its primary state when the hook returns.
   */
  onPick?(x: number, y: number, view?: RenderView & { pixels: true }): Promise<Mesh | null>;
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
  private idle(): void {
    if (this.executing) throw fault('state', 'Graph executing', 'reentrancy');
  }
  add(pass: FramePass): () => void {
    this.idle();
    if (
      !pass.name ||
      !Number.isFinite(pass.order) ||
      typeof pass.execute !== 'function' ||
      this.passes.some((p) => p.name === pass.name)
    )
      throw typeError('Invalid pass', 'arguments');
    const record = { ...pass, owner: this.owner };
    this.passes.push(record);
    this.passes.sort((a, b) => a.order - b.order);
    this.revision++;
    return () => {
      this.idle();
      this.passes = this.passes.filter((p) => p !== record);
      this.revision++;
    };
  }
  withOwner(owner: string, register: () => void): void {
    this.idle();
    const previous = this.owner;
    this.owner = owner;
    try {
      register();
    } finally {
      this.owner = previous;
    }
  }
  removeOwner(owner: string): void {
    this.idle();
    this.passes = this.passes.filter((p) => p.owner !== owner);
    this.revision++;
  }
  execute(context: PassContext): void {
    if (this.executing) throw fault('state', 'Graph recursion', 'reentrancy');
    this.executing = true;
    try {
      for (const pass of this.passes) pass.execute(context);
    } finally {
      this.executing = false;
    }
  }
  prepare(context: PassContext): void {
    if (this.executing) throw fault('state', 'Graph recursion', 'reentrancy');
    this.executing = true;
    try {
      for (const pass of this.passes) pass.prepare?.(context);
    } finally {
      this.executing = false;
    }
  }
}
