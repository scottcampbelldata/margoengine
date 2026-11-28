// UsdPreviewSurface's clearcoat, clearcoatRoughness and ior as glTF material extensions, for the default importer and
// previewSurface(). Names and fallbacks are the UsdPreviewSurface specification's (Pixar,
// https://openusd.org/release/spec_usdpreviewsurface.html); glTF's are KHR_materials_clearcoat and KHR_materials_ior.
import type { GLTFMaterial } from '../../shared/gltf.js';
import type { SurfaceRead } from './extension.js';

/** The UsdUVTexture feeding one input: its file, the output channel read and the node's scale, bias and colour space. */
export interface PhysicalMap {
  path: string;
  channel: number;
  scale: readonly number[];
  bias: readonly number[];
  srgb: boolean;
  where: Parameters<SurfaceRead['image']>[1];
  /** The primvar it samples. */
  uv?: string;
}
/** One input: its authored value, or the texture it reads. */
export interface PhysicalInput {
  value: unknown;
  map?: PhysicalMap;
}

/**
 * The extensions of a surface with a coat or an ior other than 1.5, or nothing. A value outside glTF's range takes the
 * nearest one glTF holds. A map read plainly from the channel glTF samples (red for the coat, green for its roughness)
 * keeps its file and its scale becomes the factor; any other is converted to that channel when the model is created.
 */
export function physicalExtensions(
  coat: PhysicalInput,
  roughness: PhysicalInput,
  ior: unknown,
  image: (source: Parameters<SurfaceRead['image']>[0], map: PhysicalMap) => ReturnType<SurfaceRead['image']>,
  bad: (message: string) => never,
): NonNullable<GLTFMaterial['extensions']> | undefined {
  const number = (value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) bad('invalid material factor');
    return value as number;
  };
  const unit = (value: number): number => Math.min(1, Math.max(0, value));
  const slot = (input: PhysicalInput, channel: number, fallback: number) => {
    const map = input.map;
    if (!map) return { factor: unit(number(input.value, fallback)) };
    const scale = map.scale[map.channel],
      bias = map.bias[map.channel];
    if (map.channel === channel && !map.srgb && !bias && scale >= 0 && scale <= 1)
      return { factor: scale, texture: image({ path: map.path }, map) };
    return {
      factor: 1,
      texture: image({ path: map.path, scalar: { channel: map.channel, scale, bias, srgb: map.srgb } }, map),
    };
  };
  const clear = slot(coat, 0, 0),
    refraction = number(ior, 1.5),
    out: Record<string, unknown> = {};
  if (clear.factor || clear.texture) {
    const rough = slot(roughness, 1, 0.01);
    out.KHR_materials_clearcoat = {
      clearcoatFactor: clear.factor,
      clearcoatRoughnessFactor: rough.factor,
      ...(clear.texture ? { clearcoatTexture: clear.texture } : {}),
      ...(rough.texture ? { clearcoatRoughnessTexture: rough.texture } : {}),
    };
  }
  // glTF holds 0 (the specular-glossiness case) or 1 and up.
  if (refraction !== 1.5) out.KHR_materials_ior = { ior: refraction && Math.max(1, refraction) };
  return Object.keys(out).length ? (out as NonNullable<GLTFMaterial['extensions']>) : undefined;
}
