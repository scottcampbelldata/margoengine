// One class per shading model: a `Material` with its `shading` fixed and its options typed to what that model reads.
import { Material, type MaterialOptions, type PhysicalOptions } from './built-material.js';
import { catcherShader } from './catcher.js';
import type { ColorInput } from '@margoengine/math/color';

type DistanceKeys = 'depthPacking' | 'referencePosition' | 'nearDistance' | 'farDistance';
/** Options no model but its own reads: shading itself, matcap, Phong, toon, depth/distance output and physical lobes. */
type ModelKeys =
  | 'shading'
  | 'matcap'
  | 'specular'
  | 'shininess'
  | 'steps'
  | 'gradientMap'
  | DistanceKeys
  | keyof PhysicalOptions;
/** The environment map options: standard shading lights with the map, basic, Lambert and Phong combine it. */
type EnvKeys =
  | 'envMap'
  | 'envMapIntensity'
  | 'envMapRotation'
  | 'envMapMode'
  | 'refractionRatio'
  | 'combine'
  | 'reflectivity';
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
 * Toon shading (`shading: 'toon'`): Lambert's diffuse light read through a ramp, the
 * `gradientMap` texture (its RGB at u = n.l * 0.5 + 0.5) or `steps` flat bands (default 3), both live. The sun,
 * clustered point, spot and directional lights and shadows go through the ramp; the hemisphere, scene IBL and light maps
 * light it as Lambert. No highlight and no environment map. For a loaded glTF-pro model, use `toonModel`.
 */
export class ToonMaterial extends Material {
  constructor(options: Omit<MaterialOptions, Exclude<ModelKeys, 'steps' | 'gradientMap'> | MetalKeys | EnvKeys> = {}) {
    super({ ...options, shading: 'toon' });
  }
}
/**
 * Metallic-roughness PBR (`shading: 'standard'`), with maps and the physical options. Takes every option of core's
 * `PbrMaterial` (`color`, `roughness`, `metalness`, `doubleSided`) with the same meaning. Defaults are a textured
 * material's (white, roughness 1, metalness 0, front side), so a `map` shows its own colours; core's colour-only
 * placeholder defaults (indigo, double-sided) would tint it.
 */
export class PbrMaterial extends Material {
  constructor(
    options: Omit<MaterialOptions, Exclude<ModelKeys, keyof PhysicalOptions> | 'combine' | 'reflectivity'> = {},
  ) {
    super({ ...options, shading: 'standard' });
  }
}
/** View-space normals as colour (`shading: 'normal'`); normal maps apply, colour alpha and map alpha cut out. */
export class NormalMaterial extends Material {
  constructor(options: Omit<MaterialOptions, ModelKeys | MetalKeys | LightKeys | EnvKeys> = {}) {
    super({ ...options, shading: 'normal' });
  }
}
/** Lit by a matcap image (`shading: 'matcap'`, the `matcap` texture) looked up by the view-space normal. */
export class MatcapMaterial extends Material {
  constructor(options: Omit<MaterialOptions, Exclude<ModelKeys, 'matcap'> | MetalKeys | LightKeys | EnvKeys> = {}) {
    super({ ...options, shading: 'matcap' });
  }
}
/** Projected depth as colour (`shading: 'depth'`), grayscale or RGBA-packed (`depthPacking`). */
export class DepthMaterial extends Material {
  constructor(
    options: Omit<
      MaterialOptions,
      Exclude<ModelKeys, 'depthPacking'> | MetalKeys | LightKeys | EnvKeys | 'normalMap' | 'normalScale'
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
      Exclude<ModelKeys, DistanceKeys> | MetalKeys | LightKeys | EnvKeys | 'normalMap' | 'normalScale'
    > = {},
  ) {
    super({ ...options, shading: 'distance' });
  }
}
/**
 * Invisible except for the shadows it receives: a ground plane for product shots. Where a
 * shadow falls it draws `color` (default black) with alpha `opacity` (default 1) times the share of light the shadow
 * takes, over the sun (`@margoengine/shadows`) and clustered point, spot, directional and area lights (integrated
 * maps or `LocalShadows`, castShadow directional and area lights included); elsewhere nothing. Register it with those effects (`shadows.add(mesh)`, `lights.add(mesh)`) like
 * any receiver; it is transparent, so it casts no shadow and writes no depth. `color` and `opacity` stay live.
 */
export class ShadowCatcherMaterial extends Material {
  constructor(options: { color?: ColorInput; opacity?: number } = {}) {
    super({ color: options.color ?? [0, 0, 0], opacity: options.opacity ?? 1, shading: 'lambert', transparent: true });
  }
  override shader(source: string, group: number): string {
    return catcherShader(super.shader(source, group));
  }
}
