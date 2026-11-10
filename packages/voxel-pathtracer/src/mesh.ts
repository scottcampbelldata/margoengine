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
import { MeshLightingBuilder } from './mesh-light-build.js';
import type { TraceSpotLight } from './mesh-lights.js';
export type { TraceSpotLight } from './mesh-lights.js';
export { parseTraceIES } from './mesh-ies.js';
export type { TraceIESProfile, TraceIESParseOptions } from './mesh-ies.js';
import { meshSource } from './mesh-shader.js';
import { traceMeshStats, type TraceMeshStats, type VoxelTraceFeature } from './compose-types.js';
export type { TraceMeshStats } from './compose-types.js';

/** Mixed triangle geometry for a composed tracer. Wasm loads only during create/setScene. */
export function triangleMeshes(): VoxelTraceFeature {
  return Object.freeze({
    id: 'mesh',
    source: meshSource,
    geometry: () => new MeshLightingBuilder(),
  });
}

/** Indexed triangles. All vertex arrays are copied before the asynchronous build. */
export interface TraceTriangleMesh {
  /** Unique nonempty id within scene.meshes. */
  id: string;
  /** Object-space xyz triplets with meshInstances; otherwise world-space. finite within +/-1e8 world units. */
  positions: Float32Array;
  /** Three indices per triangle, counterclockwise from outside. Exactly zero-area triangles are counted and skipped. */
  indices: Uint32Array;
  /** Optional xyz shading normals, one per position; finite and nonzero. Default geometric normals. */
  normals?: Float32Array;
  /** Optional UV pairs, one per position. Required for textured materials. Repeat wrapping, nearest sampling. */
  uvs?: Float32Array;
  /** Scene palette id, 1..255. Surface materials; a texture index uses interpolated UVs. */
  material: number;
}

/** A placement of shared triangle geometry. */
export interface TraceMeshInstance {
  /** Unique nonempty id within meshInstances. */
  id: string;
  /** An id in scene.meshes. */
  mesh: string;
  /** Column-major affine 4x4, finite/invertible in Float32. Default identity. Reflections preserve outside orientation. */
  transform?: readonly number[] | Float32Array;
}

/** Triangles and voxels share all paths, lights and the environment. */
export interface MeshTraceScene extends VoxelTraceScene {
  /** Delta spot/IES lights, sampled once per scattering vertex. Default empty. */
  spotLights?: readonly TraceSpotLight[];
  /** Geometry definitions. Without meshInstances, each is drawn once in world space. */
  meshes: readonly TraceTriangleMesh[];
  /** Explicit placements over shared object-space BLAS. Default undefined draws each mesh once; [] draws none.
   * Exact geometry/attribute/material content reuses BLAS across setScene; transforms rebuild only the TLAS. */
  meshInstances?: readonly TraceMeshInstance[];
}

/** Root tracer settings, with triangle geometry and an optional build cancellation signal. */
export interface MeshPathTracerOptions extends Omit<VoxelPathTracerOptions, 'scene'> {
  /** The complete mixed scene. */
  scene: MeshTraceScene;
  /** Cancels Wasm loading/build preparation. Default undefined. */
  signal?: AbortSignal;
}

/** Root image with triangle ids retained in the optional instance AOV. */
export interface MeshTraceImage extends VoxelTraceImage {
  /** With aovs: voxel instance index, -1 sky, -2 ground, -3 area light, or -(4 + triangle ordinal).
   * Triangle ordinals follow mesh order, or explicit instance order, then original index-triplet order. Palette remains 0 for a triangle. */
  readonly instance?: Int32Array;
}

interface PreparedOptions extends VoxelPathTracerOptions {
  geometry: Uint32Array;
}

// Async geometry preparation must not extend the caller-array lifetime of the
// root snapshot contract. Content keys deliberately retain Map identity.
function copyScene(scene: MeshTraceScene): MeshTraceScene {
  if (!scene || !Array.isArray(scene.models)) throw new TypeError('MeshPathTracer scene.models must be an array');
  const { models, ...rest } = scene;
  return {
    ...structuredClone(rest),
    models: models.map((model) => {
      const { contentKey, ...data } = model;
      return { ...structuredClone(data), ...(contentKey === undefined ? {} : { contentKey }) };
    }),
  };
}

class TriangleTracer extends VoxelPathTracer {
  #geometry: Uint32Array;
  protected constructor(options: PreparedOptions) {
    const { geometry, ...rest } = options;
    super(rest);
    this.#geometry = geometry;
  }
  static override attach(engine: EngineKernel, options: PreparedOptions): TriangleTracer {
    return super.attach(engine, options) as TriangleTracer;
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
  override get stats(): VoxelPathTracer['stats'] & TraceMeshStats {
    return { ...super.stats, ...traceMeshStats(this.#geometry) };
  }
  protected override sceneStorage(base: Uint32Array): Uint32Array {
    const words = new Uint32Array(base.length + this.#geometry.length);
    words.set(base);
    words[2] = base.length;
    words.set(this.#geometry, base.length);
    return words;
  }
  protected override tracingSource(): string {
    return meshSource(super.tracingSource());
  }
  protected override imageInstance(id: number): number {
    return id <= -4 ? id : super.imageInstance(id);
  }
}

/** Mixed triangle/voxel path tracing; Rust/Wasm builds a stackless BVH, loaded only by create/setScene. */
export class MeshPathTracer {
  #tracer: TriangleTracer;
  #updates: Promise<unknown> = Promise.resolve();
  #builder: MeshLightingBuilder;
  private constructor(tracer: TriangleTracer, builder: MeshLightingBuilder) {
    this.#tracer = tracer;
    this.#builder = builder;
  }

  /** Build the geometry and attach. The returned tracer's ready promise also waits for GPU pipelines. */
  static async create(engine: EngineKernel, options: MeshPathTracerOptions): Promise<MeshPathTracer> {
    if (!options || typeof options !== 'object')
      throw new TypeError('MeshPathTracer.create expects engine and {scene}');
    const { signal, scene: input, ...rest } = options;
    signal?.throwIfAborted();
    const scene = copyScene(input);
    const builder = new MeshLightingBuilder();
    const geometry = await builder.build(scene, signal);
    signal?.throwIfAborted();
    return new MeshPathTracer(TriangleTracer.attach(engine, { ...rest, scene, geometry }), builder);
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
  get stats(): VoxelPathTracer['stats'] & TraceMeshStats {
    return this.#tracer.stats;
  }
  /** Resolved rendering defaults. */
  get options(): VoxelPathTracer['options'] {
    return this.#tracer.options;
  }

  /** Prepare geometry and atomically replace the whole scene in call order, reusing unchanged explicit-instance BLAS. */
  setScene(scene: MeshTraceScene, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.status === 'disposed')
      return Promise.reject(
        new MargoError('disposed', 'MeshPathTracer is disposed; https://margoengine.com/errors#voxel-pathtracer'),
      );
    let snapshot: MeshTraceScene;
    try {
      options.signal?.throwIfAborted();
      snapshot = copyScene(scene);
    } catch (error) {
      return Promise.reject(error);
    }
    const update = this.#updates.then(async () => {
      const geometry = await this.#builder.build(snapshot, options.signal);
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
  renderImage(options: VoxelTraceRenderOptions): Promise<MeshTraceImage> {
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
    this.#builder.dispose();
    this.#tracer.dispose();
  }
  /** Deterministic using cleanup. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
