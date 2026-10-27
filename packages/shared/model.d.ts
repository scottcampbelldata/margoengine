import type { Mesh } from '@margoengine/core/extension';

/**
 * Structural view of a gltf-pro `PBRModel` primitive (also what @margoengine/materials meshes are): node-space
 * vertices, 20 floats each (position at 0, normal at 4, TEXCOORD_0 at 12), triangle indices and the material's
 * settings. `buffers` exist while its model is set up on a device; `deformed` replaces the vertices when skinned.
 */
export interface ModelPrimitiveLike {
  readonly node: Mesh;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly material: { readonly settings: ArrayLike<number>; readonly side?: 'front' | 'back' | 'double' };
  readonly nodeIndex?: number;
  /** gltf-pro `PBRInstances`: drawn once per instance (24 floats each, node-space matrix first). */
  readonly instances?: { readonly count: number; readonly data: Float32Array };
  readonly buffers?: { vertex: GPUBuffer; index: GPUBuffer };
  readonly deformed?: GPUBuffer;
  /** Byte offset of the primitive's vertices in `deformed`. Default 0. */
  readonly deformedOffset?: number;
}
/** Structural view of a gltf-pro `PBRModel`: its `root` node and `primitives`. */
export interface ModelLike {
  readonly root: Mesh;
  readonly primitives: readonly ModelPrimitiveLike[];
  readonly disposed?: boolean;
}
/**
 * Structural view of a pick proxy: an object drawn without triangles (an @margoengine/lod imposter level), hit through
 * its local bounding sphere `sphere` (x, y, z, radius) under `anchor`'s world matrix. `model` is reported with the hit.
 */
export interface PickProxy {
  readonly anchor: Mesh;
  readonly sphere: ArrayLike<number>;
  readonly model?: object | null;
}
/** gltf-pro shape: a `root` node and `primitives` with 20-float CPU vertices (the first one is checked). */
export function isModel(value: unknown): value is ModelLike;
/** Proxies from every engine plugin with a `pickProxies()` method (an @margoengine/lod `LODSystem`), in a new array. */
export function engineProxies(engine: object): PickProxy[];
