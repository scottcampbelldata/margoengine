import {
  captureMaterialLibrary,
  restoreMaterialLibrary,
  type MaterialCaptureOptions,
  type MaterialRestoreOptions,
  type MaterialLibrary,
} from '@margoengine/materials/serialization';
export type {
  MaterialLibrary,
  MaterialCaptureOptions,
  MaterialRestoreOptions,
} from '@margoengine/materials/serialization';
/** Lossless material library: kind, all factors, maps, per-slot UVs, render state and shader parameters. */
export function captureMaterials(
  materials: Readonly<Record<string, object>>,
  options: MaterialCaptureOptions = {},
): Promise<MaterialLibrary> {
  return captureMaterialLibrary(materials, {
    ...options,
    loadCodecs:
      options.loadCodecs ?? (async () => (await import('@margoengine/shader/serialization')).shaderMaterialCodecs),
  });
}
/** Recreate materials and shared textures; install returned objects on the loaded scene's meshes. */
export function restoreMaterials(
  library: MaterialLibrary,
  options: MaterialRestoreOptions = {},
): Promise<Record<string, object>> {
  return restoreMaterialLibrary(library, {
    ...options,
    loadCodecs:
      options.loadCodecs ?? (async () => (await import('@margoengine/shader/serialization')).shaderMaterialCodecs),
  });
}
