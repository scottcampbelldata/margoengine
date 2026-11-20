import { margoError } from '../../shared/errors.js';
import type { GLTFPrimitive } from '../../shared/gltf.js';
import type { GLTFAsset } from './asset.js';

// Decoded Draco topology per asset. It lives apart from compression.ts so the packing code reads it without a static
// import of the Draco decoding module, which loads only for files that use KHR_draco_mesh_compression.
export const decoded = new WeakMap<GLTFAsset, Map<object, Float32Array>>();

/** Whether any mesh primitive of the asset uses KHR_draco_mesh_compression (walked like decompressPrimitives). */
export function hasDraco(asset: GLTFAsset): boolean {
  for (const mesh of asset.doc.meshes ?? [])
    for (const p of mesh.primitives ?? []) if (p.extensions?.KHR_draco_mesh_compression) return true;
  return false;
}

/** Draco topology belongs to the primitive, including when no index accessor is declared. */
export function compressedIndices(asset: GLTFAsset, primitive: GLTFPrimitive): Float32Array | undefined {
  if (!primitive.extensions?.KHR_draco_mesh_compression) return;
  const indices = decoded.get(asset)?.get(primitive);
  if (!indices) throw margoError('state', 'Draco geometry requires parseGLTFAsync or loadGLTF');
  return indices;
}
