// One class per shading model: a `Material` with its `shading` fixed and its options typed to what that model reads.
import { Material, type MaterialOptions, type PhysicalOptions } from './built-material.js';

type DistanceKeys = 'depthPacking' | 'referencePosition' | 'nearDistance' | 'farDistance';
/** Options no model but its own reads: shading itself, matcap, Phong, depth/distance output and physical lobes. */
type ModelKeys = 'shading' | 'matcap' | 'specular' | 'shininess' | DistanceKeys | keyof PhysicalOptions;
type MetalKeys = 'roughness' | 'metalness' | 'metalRoughnessMap';
type LightKeys = 'emissive' | 'emissiveMap' | 'aoMap' | 'aoMapIntensity';

/** Unlit (`shading: 'basic'`, three.js MeshBasicMaterial): colour, maps and emissive, no lighting. */
export class UnlitMaterial extends Material {
  constructor(
    options: Omit<
      MaterialOptions,
      ModelKeys | MetalKeys | 'normalMap' | 'normalScale' | 'aoMap' | 'aoMapIntensity'
    > = {},
  ) {
    super({ ...options, shading: 'basic' });
  }
}
/** Diffuse-only lighting (`shading: 'lambert'`): no highlight, no environment specular. */
export class LambertMaterial extends Material {
  constructor(options: Omit<MaterialOptions, ModelKeys | MetalKeys> = {}) {
    super({ ...options, shading: 'lambert' });
  }
}
/** Lambert plus a Blinn-Phong highlight (`shading: 'phong'`): `specular` colour and `shininess` exponent, both live. */
export class PhongMaterial extends Material {
  constructor(options: Omit<MaterialOptions, Exclude<ModelKeys, 'specular' | 'shininess'> | MetalKeys> = {}) {
    super({ ...options, shading: 'phong' });
  }
}
/**
 * Metallic-roughness PBR (`shading: 'standard'`), with maps and the physical options. Takes every option of core's
 * `PbrMaterial` (`color`, `roughness`, `metalness`, `doubleSided`) with the same meaning. Defaults are a textured
 * material's (white, roughness 1, metalness 0, front side), so a `map` shows its own colours; core's colour-only
 * placeholder defaults (indigo, double-sided) would tint it.
 */
export class PbrMaterial extends Material {
  constructor(options: Omit<MaterialOptions, Exclude<ModelKeys, keyof PhysicalOptions>> = {}) {
    super({ ...options, shading: 'standard' });
  }
}
/** View-space normals as colour (`shading: 'normal'`); normal maps apply, colour alpha and map alpha cut out. */
export class NormalMaterial extends Material {
  constructor(options: Omit<MaterialOptions, ModelKeys | MetalKeys | LightKeys> = {}) {
    super({ ...options, shading: 'normal' });
  }
}
/** Lit by a matcap image (`shading: 'matcap'`, the `matcap` texture) looked up by the view-space normal. */
export class MatcapMaterial extends Material {
  constructor(options: Omit<MaterialOptions, Exclude<ModelKeys, 'matcap'> | MetalKeys | LightKeys> = {}) {
    super({ ...options, shading: 'matcap' });
  }
}
/** Projected depth as colour (`shading: 'depth'`), grayscale or RGBA-packed (`depthPacking`). */
export class DepthMaterial extends Material {
  constructor(
    options: Omit<
      MaterialOptions,
      Exclude<ModelKeys, 'depthPacking'> | MetalKeys | LightKeys | 'normalMap' | 'normalScale'
    > = {},
  ) {
    super({ ...options, shading: 'depth' });
  }
}
/** World distance from `referencePosition` as colour (`shading: 'distance'`), normalised by near/far distance. */
export class DistanceMaterial extends Material {
  constructor(
    options: Omit<
      MaterialOptions,
      Exclude<ModelKeys, DistanceKeys> | MetalKeys | LightKeys | 'normalMap' | 'normalScale'
    > = {},
  ) {
    super({ ...options, shading: 'distance' });
  }
}
