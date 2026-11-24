import type { GLTFDocument } from '../../shared/gltf.js';

/** True for a mesh primitive whose data is Gaussian splats (KHR_gaussian_splatting). */
export const isSplatPrimitive = (primitive: { extensions?: unknown } | undefined): boolean =>
  !!primitive?.extensions && typeof primitive.extensions === 'object' && 'KHR_gaussian_splatting' in primitive.extensions;
/** True when any mesh of the file holds Gaussian splats. */
export const hasSplats = (doc: GLTFDocument): boolean =>
  !!doc.meshes?.some((mesh) => mesh?.primitives?.some(isSplatPrimitive));
