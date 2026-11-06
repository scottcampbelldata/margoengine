// KHR_mesh_quantization for the light loader: integer positions and normalized integer normals, read as floats.
import { entry, readAccessor } from './accessor.js';
import type { GLTFExtension } from './index.js';

const BYTE = 5120,
  UNSIGNED_BYTE = 5121,
  SHORT = 5122,
  UNSIGNED_SHORT = 5123;

/**
 * Lets the light loader read quantized meshes: POSITION as signed or unsigned 8 or 16 bit integers, normalized or not,
 * and NORMAL as normalized signed 8 or 16 bit integers. Values turn into floats on load, so a mesh takes the same memory
 * on the GPU as a float one. Float attributes read as before. Other forms stay refused.
 * @example const model = await loadGLTF(engine, '/packed.glb', { extensions: [quantized] });
 */
export const quantized: GLTFExtension = {
  handles: ['KHR_mesh_quantization'],
  attribute(file, semantic, id) {
    const { componentType: type, normalized } = entry(file.doc.accessors, id, 'accessor');
    return (
      semantic === 'POSITION'
        ? type === BYTE || type === UNSIGNED_BYTE || type === SHORT || type === UNSIGNED_SHORT
        : (type === BYTE || type === SHORT) && normalized === true
    )
      ? (readAccessor(file, id, 3, (a) => a.type === 'VEC3') as Float32Array)
      : undefined;
  },
};
