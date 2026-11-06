// Default physical materials: loadGLTF and parseGLTFAsync give a file that uses a physical material extension the
// extended shader (extended.ts) without the caller passing it. Internal: not a package entry.
import type { GLTFDocument } from '../../shared/gltf.js';
import type { GLTFDecoderHooks } from './asset.js';
import { hasSplats } from './splat-state.js';

// Material extensions only the physical shader (extended.ts) reads.
const physical = [
  'KHR_materials_clearcoat',
  'KHR_materials_transmission',
  'KHR_materials_ior',
  'KHR_materials_dispersion',
  'KHR_materials_volume',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_iridescence',
  'KHR_materials_anisotropy',
  'KHR_materials_diffuse_transmission',
  'EXT_materials_bump',
  'KHR_materials_volume_scatter',
];
/**
 * Decoders with the physical material shader added when the file uses a physical material extension and the caller
 * did not choose (`materials` undefined): imported on first need, so apps that never load such a file ship none of its
 * WGSL. `materials: false` is kept as no shader. The same goes for `splats`, added when the file holds Gaussian splats.
 */
export async function withMaterials(doc: GLTFDocument, decoders: GLTFDecoderHooks = {}): Promise<GLTFDecoderHooks> {
  if (decoders.splats === undefined && hasSplats(doc))
    decoders = { ...decoders, splats: (await import('./splats.js')).gaussianSplats };
  else if (decoders.splats === false) decoders = { ...decoders, splats: undefined };
  if (decoders.materials !== undefined) return decoders.materials ? decoders : { ...decoders, materials: undefined };
  const uses = (doc.materials ?? []).some(
    (m) => !!m?.extensions && typeof m.extensions === 'object' && physical.some((name) => name in m.extensions!),
  );
  return uses ? { ...decoders, materials: (await import('./extended.js')).extendedMaterials } : decoders;
}
