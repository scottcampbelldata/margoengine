/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type FramePass,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { ViewStates } from '../../shared/view-rect.js';
import { TAA, type TAAVelocity } from './index.js';
import { TAAUpscale, type TAAUpscaleOptions } from './upscale.js';
export type { TAAUpscaleOptions } from './upscale.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

// Yang, Liu & Salvi (2020): reproject with surface motion, rectify history with current samples.
// AMD FSR2 specification: dilate motion from the nearest depth and remove projection jitter.
function velocityResolve(code: string): string {
  return code
    .replace(
      'fn cubic(',
      `@group(0) @binding(7) var velocity:texture_2d<f32>;
@group(0) @binding(8) var expectedDepth:texture_2d<f32>;
@group(0) @binding(9) var<uniform> jitter:vec4f;
fn cubic(`,
    )
    .replace('var near=0.0;', 'var near=0.0;var nearest=clamp(base,vec2i(0),top);')
    .replace('near=max(near,textureLoad(depth,q,0));', 'let z=textureLoad(depth,q,0);if(z>near){near=z;nearest=q;}')
    .replace(
      'if(all(back>=',
      `if(near>0){back=uv-textureLoad(velocity,nearest,0).xy+jitter.xy;expected=textureLoad(expectedDepth,nearest,0).r;}
  if(expected>=0&&all(back>=`,
    );
}

class UpscaleView extends TAAUpscale {
  private outer?: { width: number; height: number; view: Context['view']; camera: Context['camera'] };
  private jitterBuffer?: GPUBuffer;
  private readonly jitter = new Float32Array(4);
  private readonly previousJitter = new Float32Array(2);
  private projection = '';

  constructor(
    options: TAAUpscaleOptions,
    private readonly motion: TAA,
  ) {
    super(options);
  }

  override setup(engine: Engine): void {
    super.setup(engine);
    this.jitterBuffer = engine.gpu!.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  get sceneDepth(): GPUTexture | undefined {
    return this.depth;
  }
  copyJitter(into: Float32Array): void {
    into[0] = this.jitter[0];
    into[1] = this.jitter[1];
  }
  override reset(): void {
    super.reset();
    this.previousJitter.fill(0);
  }
  protected override resolveCode(code: string): string {
    return velocityResolve(code);
  }
  protected override resolveEntries(): GPUBindGroupEntry[] {
    const motion = this.motion.velocity!;
    return [
      { binding: 7, resource: motion.texture.createView() },
      { binding: 8, resource: motion.expectedDepth.createView() },
      { binding: 9, resource: { buffer: this.jitterBuffer! } },
    ];
  }

  begin(c: Context): void {
    this.outer = { width: c.width, height: c.height, view: c.view, camera: c.camera };
    this.outputView = c.view;
    const rect = c.view?.viewport;
    if (rect) {
      c.width = rect[2];
      c.height = rect[3];
    }
    c.view = undefined;
    const projection = [c.camera.fov, c.camera.near, c.camera.far, ...(rect ?? [])].join(':');
    if (projection !== this.projection) {
      this.reset();
      this.motion.reset(this.outputView?.id);
      this.projection = projection;
    }
    try {
      super.capture(c);
      if (!this.valid || this.options.temporal === false) this.motion.reset(this.outputView?.id);
      const x = this.values[52] / c.width,
        y = this.values[53] / c.height;
      this.jitter[0] = this.valid ? x - this.previousJitter[0] : 0;
      this.jitter[1] = this.valid ? y - this.previousJitter[1] : 0;
      this.previousJitter.set([x, y]);
      c.device.queue.writeBuffer(this.jitterBuffer!, 0, this.jitter);
      if (this.outputView) {
        // Capture the whole view; apply the caller's exact (possibly disjoint) scissor only at presentation.
        c.view = {
          ...this.outputView,
          viewport: [0, 0, c.width, c.height],
          index: 0,
          count: 1,
          target: undefined,
          scissor: undefined,
        };
      }
    } catch (error) {
      this.abort(c);
      throw error;
    }
  }

  end(c: Context): void {
    try {
      super.finish(c);
    } catch (error) {
      this.reset();
      this.motion.reset();
      throw error;
    } finally {
      this.restore(c);
    }
  }

  abort(c: Context): void {
    this.cancelCapture(c);
    this.motion.reset(this.outputView?.id);
    this.restore(c);
  }

  private restore(c: Context): void {
    if (this.outer) {
      Object.assign(c, this.outer);
      this.outer = undefined;
    }
  }

  free(): void {
    this.release();
    this.jitterBuffer?.destroy();
    this.jitterBuffer = undefined;
  }
}

/**
 * Temporal upscaling with TAA's per-object motion and independent histories for engine views, including offset
 * viewports and XR targets. Runs instead of TAA or TAAUpscale. Options and defaults match TAAUpscale.
 * Opaque core and animated PBR meshes are discovered automatically; add raw or custom velocity sources with add().
 * Transparent surfaces without motion retain depth/colour rejection. Reset after a camera cut.
 * @throws RangeError for invalid options; MargoError 'unsupported' without a GPU device or with TAA attached,
 * or 'disposed' after disposal. Use a fresh effect on a WebGPU or full WebGL2 compatibility engine.
 */
export class TAAUpscaleVelocity implements EnginePlugin {
  readonly name = 'taa-upscale';
  private engine?: Engine;
  private disposed = false;
  private active?: UpscaleView;
  private readonly motion = new TAA({ velocityOnly: true, depth: () => this.active?.sceneDepth });
  private readonly views = new ViewStates<UpscaleView>(
    () => {
      const state = new UpscaleView(this.options, this.motion);
      try {
        state.setup(this.engine!);
      } catch (error) {
        state.free();
        throw error;
      }
      return state;
    },
    (state) => state.free(),
  );

  constructor(readonly options: TAAUpscaleOptions = {}) {
    new TAAUpscale(options);
  }

  /** Attaches velocity-driven temporal upscaling to the engine. */
  static attach(engine: EngineKernel, options: TAAUpscaleOptions = {}): TAAUpscaleVelocity {
    const effect = new TAAUpscaleVelocity(options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'TAAUpscaleVelocity is disposed; create a new effect');
    if (!engine.gpu || engine.hasPlugin('taa'))
      throw new MargoError(
        'unsupported',
        'TAAUpscaleVelocity replaces TAA; use a GPU engine without TAA; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.motion.setup(engine);
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'taa-upscale:capture',
      order: -70,
      execute: (c) => {
        if (c.backend === 'webgpu') {
          this.active = this.views.get(c);
          this.active.begin(c);
        }
      },
    });
    // Adapt TAA's three public passes, keeping its velocity resources and previous animation snapshots intact.
    const adapter = Object.create(graph) as FrameGraph;
    adapter.add = (pass: FramePass) =>
      graph.add({
        ...pass,
        name: `upscale-${pass.name}`,
        order: pass.order === -70 ? -69 : pass.order === 40 ? 38 : pass.order,
        execute: (c) => {
          if (this.options.temporal !== false) {
            try {
              pass.execute(c);
            } catch (error) {
              if (c.backend === 'webgpu') this.active!.abort(c);
              throw error;
            }
          }
        },
      });
    this.motion.registerPasses(adapter);
    graph.add({
      name: 'taa-upscale:resolve',
      order: 39,
      execute: (c) => {
        if (c.backend === 'webgpu') this.active!.end(c);
      },
    });
  }

  /** Adds a custom motion source using the same contract as TAA.add; returns its unregister function. */
  add(source: Parameters<TAA['add']>[0]): () => void {
    return this.motion.add(source);
  }
  /** The active view's low-resolution motion vectors, available after its first render. */
  get velocity(): TAAVelocity | undefined {
    const velocity = this.motion.velocity;
    if (velocity) this.active?.copyJitter(velocity.jitter);
    return velocity;
  }
  /** Discards every view's history and motion snapshots after a camera cut or scene replacement. */
  reset(): void {
    for (const state of this.views.values()) state.reset();
    this.motion.reset();
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) this.views.prune();
    this.motion.onPreUpdate(delta);
  }
  onDeviceRestored(engine: Engine): void {
    this.views.clear();
    this.active = undefined;
    this.motion.onDeviceRestored(engine);
    this.engine = engine;
  }
  /** Detaches the effect and releases all per-view resources. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.views.clear();
    this.motion.dispose();
    this.active = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
