import type { EngineKernel, Mesh } from '@margoengine/core';
import type { GeometryBuffers } from '@margoengine/core/extension';

/** Root, meshes, and dispose: what a stage feature entry imported. `loadedModel` reads only these fields. */
export interface ImportedModel {
  readonly root: Mesh;
  readonly meshes: readonly Mesh[];
  dispose(): void;
}

/** A draw's buffers; an animated model's deformed vertices start `vertexOffset` bytes into `vertex` (default 0). */
export type RawBuffers = Omit<GeometryBuffers, 'instance'> &
  Partial<Pick<GeometryBuffers, 'instance'>> & { readonly vertexOffset?: number };

/** The imported meshes under one root, moved, rotated and scaled as one (the stage's LoadedModel without its glTF fields). */
export interface PlacedModel extends Pick<Mesh, 'position' | 'rotation' | 'scale'> {
  readonly root: Mesh;
  readonly meshes: readonly Mesh[];
  visible: boolean;
  readonly bounds: Float32Array;
  readonly raw: readonly RawBuffers[] | null;
  destroy(): void;
}

export function worldBounds(
  instance: EngineKernel,
  meshes: Iterable<Mesh>,
  output: Float32Array,
  visibleOnly?: boolean,
): Float32Array;
export function loadedModel(engine: EngineKernel, model: ImportedModel): PlacedModel;
export function loadTarget(url: string | URL, fit: unknown): URL;
export function placeModel(
  stage: { readonly engine: EngineKernel; fit(meshes: Iterable<Mesh>): void },
  model: ImportedModel,
  fit: boolean,
  abort: AbortSignal,
): PlacedModel;
