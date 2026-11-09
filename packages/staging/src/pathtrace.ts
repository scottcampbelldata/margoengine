/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import type {
  MeshPathTracer,
  MeshPathTracerOptions,
  MeshTraceScene,
  MeshTraceImage,
} from '@margoengine/voxel-pathtracer/mesh';
import type { VoxelTraceCaptureOptions, VoxelTraceRenderOptions } from '@margoengine/voxel-pathtracer';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** Existing triangle integrator settings plus an idle interval; the owned renderer runs at order 20. */
export interface ProgressiveStillOptions extends Omit<MeshPathTracerOptions, 'order'> {
  /** Unchanged-camera seconds before the still replaces raster, finite in 0..60. Default 0.25. */
  idleDelay?: number;
}

/** Raster while moving, progressively traced triangle/voxel still while idle. Reuses the optional mesh integrator. */
export class ProgressiveStill implements EnginePlugin {
  readonly name = 'progressive-still';
  /** Validated idle interval in seconds. */
  readonly idleDelay: number;
  private engine?: Engine;
  private key = '';
  private elapsed = 0;
  private disposed = false;
  private constructor(
    private tracer: MeshPathTracer,
    idleDelay: number,
  ) {
    this.idleDelay = idleDelay;
  }

  /** Builds the static scene and attaches its renderer and idle controller. Signal cancels build preparation. */
  static async attach(engine: EngineKernel, options: ProgressiveStillOptions): Promise<ProgressiveStill> {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw typeError('Invalid still options; pass an object with a MeshTraceScene in scene', 'arguments');
    const idleDelay = options?.idleDelay ?? 0.25;
    if (!Number.isFinite(idleDelay) || idleDelay < 0 || idleDelay > 60)
      throw rangeError('Invalid idleDelay; use finite seconds in 0..60', 'arguments');
    const { idleDelay: _delay, signal, scene: input, ...rest } = options;
    signal?.throwIfAborted();
    if (!input || !Array.isArray(input.models))
      throw typeError(
        'ProgressiveStill requires a MeshTraceScene; pass scene with models, instances, materials and meshes arrays',
        'arguments',
      );
    // The lazy import is the first await. Capture now, including non-cloneable
    // content-key identities, so a caller may immediately reuse its source arrays.
    const keys = input.models.map((model) => model.contentKey);
    const snapshot = structuredClone({
      ...rest,
      scene: { ...input, models: input.models.map(({ contentKey: _key, ...model }) => model) },
    });
    keys.forEach((key, index) => {
      if (key !== undefined) snapshot.scene.models[index].contentKey = key;
    });
    const { MeshPathTracer } = await import('@margoengine/voxel-pathtracer/mesh');
    const tracer = await MeshPathTracer.create(engine, { ...snapshot, signal, order: 20 });
    tracer.enabled = false;
    const still = new ProgressiveStill(tracer, idleDelay);
    try {
      engineRuntime(engine).use(still);
    } catch (error) {
      tracer.dispose();
      throw error;
    }
    return still;
  }
  /** Pipeline readiness, including actual device restoration. */
  get ready(): Promise<void> {
    return this.tracer.ready;
  }
  /** Renderer lifecycle state. */
  get status(): MeshPathTracer['status'] {
    return this.tracer.status;
  }
  /** Viewport samples, convergence and owned GPU bytes from the triangle integrator. */
  get stats(): MeshPathTracer['stats'] {
    return this.tracer.stats;
  }
  /** True while the idle controller permits the traced frame to draw. */
  get active(): boolean {
    return !this.disposed && this.tracer.enabled;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'ProgressiveStill is disposed; attach a new still');
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({ name: this.name, order: 19, execute: (c) => this.update(c) });
  }
  /** Rebuilds a static scene atomically; a successful replacement restarts the idle interval and history. */
  async setScene(scene: MeshTraceScene, options: { signal?: AbortSignal } = {}): Promise<void> {
    await this.tracer.setScene(scene, options);
    this.invalidate();
  }
  /** Restarts the interval and accumulation after an external interaction or raster-only edit. */
  invalidate(): void {
    if (this.disposed) throw fault('disposed', 'ProgressiveStill is disposed; attach a new still');
    this.key = '';
    this.elapsed = 0;
    this.tracer.enabled = false;
    this.tracer.reset();
  }
  /** Explicit linear image capture, independent of the viewport's idle timer. */
  renderImage(options: VoxelTraceRenderOptions): Promise<MeshTraceImage> {
    return this.tracer.renderImage(options);
  }
  /** Explicit PNG capture with the integrator's cancellation, tiling and display transform. */
  capture(options: VoxelTraceCaptureOptions): Promise<Blob> {
    return this.tracer.capture(options);
  }
  onDeviceRestored(_engine: Engine): void {
    this.invalidate();
  }
  /** Detaches the controller and its owned integrator, leaving the ordinary raster frame. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tracer.dispose();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  private update(c: PassContext): void {
    if (this.disposed) return;
    if (c.view && c.view.count > 1)
      throw fault('unsupported', 'ProgressiveStill requires one view; use a separate engine for each still');
    if (!Number.isFinite(c.delta) || c.delta < 0)
      throw rangeError('Invalid still frame delta; use finite nonnegative seconds', 'arguments');
    const key = [c.width, c.height, ...c.camera.matrix, ...c.camera.position, ...c.camera.target, ...c.camera.up].join(
      '|',
    );
    if (key !== this.key) {
      this.key = key;
      this.elapsed = 0;
      this.tracer.enabled = false;
      this.tracer.reset();
    } else this.elapsed = Math.min(60, this.elapsed + c.delta);
    this.tracer.enabled = this.elapsed >= this.idleDelay;
  }
}
