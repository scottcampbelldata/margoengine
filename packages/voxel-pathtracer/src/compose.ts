import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { VoxelPathTracer } from '@margoengine/voxel-pathtracer';
import type {
  VoxelPathTracerOptions,
  VoxelTraceScene,
  VoxelTraceCaptureOptions,
  VoxelTraceRenderOptions,
  VoxelTraceImage,
  TraceVec3,
} from '@margoengine/voxel-pathtracer';
import type { VoxelTraceFeature, VoxelTraceFeatureId } from './compose-types.js';
export type { VoxelTraceFeature, VoxelTraceFeatureId } from './compose-types.js';

/** Root settings and explicitly imported optional features. */
export interface ComposedVoxelPathTracerOptions<Scene extends VoxelTraceScene = VoxelTraceScene>
  extends Omit<VoxelPathTracerOptions, 'scene'> {
  /** Complete scene, including the fields required by selected features. */
  scene: Scene;
  /** Any subset of the five optional features. Default [] (root transport). */
  features?: readonly VoxelTraceFeature[];
  /** Cancels geometry preparation. Default undefined. */
  signal?: AbortSignal;
}

interface PreparedOptions extends VoxelPathTracerOptions {
  geometry: Uint32Array;
  features: readonly VoxelTraceFeature[];
}

const ORDER: readonly VoxelTraceFeatureId[] = ['resampling', 'mesh', 'media', 'guiding', 'spectral'];
function features(input: readonly VoxelTraceFeature[]): readonly VoxelTraceFeature[] {
  if (!Array.isArray(input)) throw new TypeError('ComposedVoxelPathTracer features must be an array');
  const seen = new Set<VoxelTraceFeatureId>();
  const result = input.map((f) => {
    if (
      !f ||
      !ORDER.includes(f.id) ||
      typeof f.source !== 'function' ||
      (f.scene !== undefined && typeof f.scene !== 'function') ||
      (f.geometry !== undefined && (f.id !== 'mesh' || typeof f.geometry !== 'function'))
    )
      throw new TypeError('ComposedVoxelPathTracer expects features from the optional tracer entries');
    if (seen.has(f.id))
      throw new TypeError('ComposedVoxelPathTracer features must contain each identity once; duplicate: ' + f.id);
    seen.add(f.id);
    return Object.freeze({ ...f });
  });
  return Object.freeze(result.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)));
}

// Preserve content-key identity while snapshotting all caller-owned arrays before awaiting a build.
function copyScene(input: VoxelTraceScene, selected: readonly VoxelTraceFeature[]): VoxelTraceScene {
  if (!input || !Array.isArray(input.models))
    throw new TypeError('ComposedVoxelPathTracer scene.models must be an array');
  const { models, ...rest } = input;
  let scene: VoxelTraceScene = {
    ...structuredClone(rest),
    models: models.map((model) => {
      const { contentKey, ...data } = model;
      return { ...structuredClone(data), ...(contentKey === undefined ? {} : { contentKey }) };
    }),
  };
  for (const feature of selected) if (feature.scene) scene = feature.scene(scene);
  return scene;
}

async function geometry(
  scene: VoxelTraceScene,
  selected: readonly VoxelTraceFeature[],
  signal?: AbortSignal,
): Promise<Uint32Array> {
  signal?.throwIfAborted();
  const mesh = selected.find((f) => f.geometry);
  const words = mesh ? await mesh.geometry!(scene, signal) : new Uint32Array(0);
  signal?.throwIfAborted();
  return words;
}

class ComposedKernel extends VoxelPathTracer {
  #geometry: Uint32Array;
  #features: readonly VoxelTraceFeature[];
  protected constructor(options: PreparedOptions) {
    const { geometry, features, ...rest } = options;
    super(rest);
    this.#geometry = geometry;
    this.#features = features;
  }
  static override attach(engine: EngineKernel, options: PreparedOptions): ComposedKernel {
    return super.attach(engine, options) as ComposedKernel;
  }
  replace(scene: VoxelTraceScene, data: Uint32Array): void {
    const old = this.#geometry;
    this.#geometry = data;
    try {
      super.setScene(scene);
    } catch (error) {
      this.#geometry = old;
      throw error;
    }
  }
  protected override sceneWordReserve(): number {
    return this.#geometry.length;
  }
  protected override sceneStorage(base: Uint32Array): Uint32Array {
    if (this.#geometry.length === 0) return base;
    const words = new Uint32Array(base.length + this.#geometry.length);
    words.set(base);
    words[2] = base.length;
    words.set(this.#geometry, base.length);
    return words;
  }
  protected override tracingSource(): string {
    let source = super.tracingSource();
    for (const feature of this.#features) source = feature.source(source);
    return source;
  }
  protected override imageInstance(id: number): number {
    return id <= -4 && this.#features.some((f) => f.id === 'mesh') ? id : super.imageInstance(id);
  }
}

/** One tracer with any subset of optional features, one scene snapshot and the root lifecycle. */
export class ComposedVoxelPathTracer {
  #tracer: ComposedKernel;
  #updates: Promise<unknown> = Promise.resolve();
  #features: readonly VoxelTraceFeature[];
  private constructor(tracer: ComposedKernel, selected: readonly VoxelTraceFeature[]) {
    this.#tracer = tracer;
    this.#features = selected;
  }

  /** Build the geometry and attach. The returned tracer's ready promise also waits for GPU pipelines. */
  static async create<Scene extends VoxelTraceScene>(
    engine: EngineKernel,
    options: ComposedVoxelPathTracerOptions<Scene>,
  ): Promise<ComposedVoxelPathTracer> {
    if (!options || typeof options !== 'object')
      throw new TypeError('ComposedVoxelPathTracer.create expects engine and {scene}');
    const { signal, scene: input, features: requested = [], ...rest } = options;
    const selected = features(requested);
    signal?.throwIfAborted();
    const scene = copyScene(input, selected);
    const words = await geometry(scene, selected, signal);
    signal?.throwIfAborted();
    return new ComposedVoxelPathTracer(
      ComposedKernel.attach(engine, { ...rest, scene, geometry: words, features: selected }),
      selected,
    );
  }

  /** Whether the tracer replaces the raster image. Default true. */
  get enabled(): boolean {
    return this.#tracer.enabled;
  }
  set enabled(value: boolean) {
    this.#tracer.enabled = value;
  }
  /** Pipeline readiness, including device restoration. */
  get ready(): Promise<void> {
    return this.#tracer.ready;
  }
  /** Current lifecycle state. */
  get status(): VoxelPathTracer['status'] {
    return this.#tracer.status;
  }
  /** The underlying pipeline error, if any. */
  get error(): unknown {
    return this.#tracer.error;
  }
  /** Viewport samples and allocated GPU bytes, including triangle storage. */
  get stats(): VoxelPathTracer['stats'] {
    return this.#tracer.stats;
  }
  /** Resolved rendering defaults. */
  get options(): VoxelPathTracer['options'] {
    return this.#tracer.options;
  }

  /** Prepare selected features and atomically replace the whole scene, in call order. */
  setScene<Scene extends VoxelTraceScene>(scene: Scene, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.status === 'disposed')
      return Promise.reject(
        new MargoError(
          'disposed',
          'ComposedVoxelPathTracer is disposed; https://margoengine.com/errors#voxel-pathtracer',
        ),
      );
    let snapshot: VoxelTraceScene;
    try {
      options.signal?.throwIfAborted();
      snapshot = copyScene(scene, this.#features);
    } catch (error) {
      return Promise.reject(error);
    }
    const data = geometry(snapshot, this.#features, options.signal);
    // Observe an early build rejection even while an earlier update is pending.
    data.catch(() => {});
    const update = this.#updates.then(async () => {
      const geometry = await data;
      options.signal?.throwIfAborted();
      this.#tracer.replace(snapshot, geometry);
    });
    this.#updates = update.catch(() => {});
    return update;
  }
  /** Apply root rendering options atomically. */
  setOptions(options: Partial<Omit<VoxelPathTracerOptions, 'scene'>>): void {
    this.#tracer.setOptions(options);
  }
  /** Restore named root defaults, or all of them. */
  resetOptions(names?: Iterable<keyof Omit<VoxelPathTracerOptions, 'scene'>>): void {
    this.#tracer.resetOptions(names);
  }
  /** Forget cached voxel packing; triangles are rebuilt by setScene. */
  invalidateModels(ids?: Iterable<string>): void {
    this.#tracer.invalidateModels(ids);
  }
  /** Reset progressive accumulation. */
  reset(): void {
    this.#tracer.reset();
  }
  /** Wait for scene updates and queued captures. */
  async whenIdle(): Promise<void> {
    await this.#updates;
    await this.#tracer.whenIdle();
  }
  /** Float image, including mixed shadows and secondary rays. */
  renderImage(options: VoxelTraceRenderOptions): Promise<VoxelTraceImage> {
    return this.#tracer.renderImage(options);
  }
  /** PNG capture, using the root capture cancellation and tiling contract. */
  capture(options: VoxelTraceCaptureOptions): Promise<Blob> {
    return this.#tracer.capture(options);
  }
  /** CPU voxel picking. Triangle geometry is rendered on the GPU and is not included in this query. */
  raycast(origin: TraceVec3, direction: TraceVec3, maxDistance = Infinity): ReturnType<VoxelPathTracer['raycast']> {
    return this.#tracer.raycast(origin, direction, maxDistance);
  }
  /** Release all owned GPU state. Idempotent; pending updates cannot resurrect it. */
  dispose(): void {
    this.#tracer.dispose();
  }
  /** Deterministic using cleanup. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
