import type { EngineKernel } from '@margoengine/core';
import type { MeshPathTracerOptions } from '@margoengine/voxel-pathtracer/mesh';
import type { ComposedVoxelPathTracer } from '@margoengine/voxel-pathtracer/compose';
import type { PBRMeshTraceScene, TraceLoadedGLTF, TraceGLTFOptions } from '@margoengine/voxel-pathtracer/mesh-pbr';
import { ProgressiveStill, type ProgressiveStillOptions } from './pathtrace.js';

/** Full mesh materials with the ordinary still's idle, capture and restoration defaults. */
export interface TexturedStillOptions extends Omit<ProgressiveStillOptions, 'scene'> {
  /** Owned PBR snapshot, for example from texturedSceneFromGLTF(). */
  scene: PBRMeshTraceScene;
}

/** Convert a loaded glTF to an owned still scene; decoded images and deformed geometry are retained. */
export async function texturedSceneFromGLTF(model: TraceLoadedGLTF, options: TraceGLTFOptions = {}): Promise<PBRMeshTraceScene> {
  options.signal?.throwIfAborted();
  const { traceSceneFromGLTF } = await import('@margoengine/voxel-pathtracer/mesh-pbr');
  return traceSceneFromGLTF(model, options);
}

/** Raster during interaction, textured PBR path tracing at rest. Transport is loaded only on attachment. */
export class TexturedStill extends ProgressiveStill {
  /** Snapshot the scene before awaiting a lazy import, then attach the PBR transport and idle controller. */
  static override async attach(engine: EngineKernel, options: TexturedStillOptions): Promise<TexturedStill> {
    return super.attach(engine, options);
  }
  protected static override async createTracer(engine: EngineKernel, options: MeshPathTracerOptions): Promise<ComposedVoxelPathTracer> {
    const [{ ComposedVoxelPathTracer }, { meshPBR }] = await Promise.all([
      import('@margoengine/voxel-pathtracer/compose'),
      import('@margoengine/voxel-pathtracer/mesh-pbr'),
    ]);
    return ComposedVoxelPathTracer.create(engine, { ...options, features: [meshPBR()] });
  }
  /** Atomically replace the PBR snapshot; successful replacement restarts the idle interval. */
  override async setScene(scene: PBRMeshTraceScene, options: { signal?: AbortSignal } = {}): Promise<void> {
    await super.setScene(scene, options);
  }
}
