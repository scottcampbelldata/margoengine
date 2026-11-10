import type { VoxelTraceFeature } from './compose-types.js';
import { PBRMeshBuilder } from './mesh-pbr-build.js';
import { meshPBRSource } from './mesh-pbr-shader.js';
export type { TracePBRTexture, TracePBRMaterial, TracePBRMesh, PBRMeshTraceScene } from './mesh-pbr-types.js';
export { traceSceneFromGLTF } from './mesh-pbr-gltf.js';
export type { TraceGLTFOptions, TraceGLTFGeometry, TraceLoadedGLTF } from './mesh-pbr-gltf.js';

/** Full mesh material channels for ComposedVoxelPathTracer; replaces triangleMeshes(). */
export function meshPBR(): VoxelTraceFeature {
  return Object.freeze({id: 'mesh', source: meshPBRSource, geometry: () => new PBRMeshBuilder()});
}
