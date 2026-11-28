// Default screen-space transmission (KB4000): loadGLTF, parseGLTFAsync and the worker and progressive loaders give a
// file whose materials declare KHR_materials_transmission the pass of @margoengine/gltf/transmission without the caller
// passing it. Internal: not a package entry. Kept apart from default-materials.ts, which the parsing workers bundle:
// a worker draws nothing, so the pass must not be inlined there.
import type { GLTFDocument } from '../../shared/gltf.js';
import type { GLTFAsset, GLTFDecoderHooks } from './asset.js';

const declares = (doc: GLTFDocument, name: string): boolean =>
  !!doc.materials?.some((m) => !!m?.extensions && typeof m.extensions === 'object' && name in m.extensions);
/**
 * `decoders` with `transmission` added when the caller did not choose (undefined), the physical shader reads the file
 * (`materials` set) and a material declares KHR_materials_transmission (factor 0 included, for pointer animation).
 * A file with KHR_materials_volume takes the pass too: on a display target the tint's multiply blend reads encoded light,
 * so its Beer-Lambert was up to 20 levels off where the pass is exact (KB-VOL-TINT-DISPLAY1).
 * `transmission: false` stays false (the tinted blend; gltf/pbr attaches only a pass), so a second call on the same
 * hooks adds nothing either. The entry is imported on first need.
 */
export async function withTransmission<T extends Pick<GLTFDecoderHooks, 'materials' | 'transmission'>>(
  doc: GLTFDocument,
  decoders: T,
): Promise<T> {
  if (decoders.transmission !== undefined || !decoders.materials || !declares(doc, 'KHR_materials_transmission'))
    return decoders;
  return { ...decoders, transmission: (await import('./transmission.js')).screenTransmission };
}
/** `withTransmission` on a loaded asset's hooks, before its model is made. */
export async function addTransmission(asset: GLTFAsset): Promise<void> {
  const hooks = await withTransmission(asset.doc, asset.hooks);
  if (hooks !== asset.hooks) (asset as { hooks: GLTFDecoderHooks }).hooks = hooks;
}
