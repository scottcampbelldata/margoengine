import { requireWebGPU } from '../../shared/require-webgpu.js';
import { borrow, isOptionObject, lend, type BorrowSlot } from '../../shared/borrowed.js';
/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import {
  GLTFAsset,
  PBRModel,
  PBRDrawRun,
  textureTransform,
  textureCoordinates,
  type PreparedGeometry,
  type PBRMaterial,
  type PBRMaterialShading,
  type PBRRenderState,
  type TextureTransform,
  type MaterialSide,
} from '@margoengine/gltf/pbr-model';
import { PBRInstances } from '@margoengine/gltf/pbr-instancing';
import { extendedMaterials } from '@margoengine/gltf/extended-materials';
import { physicalMapsShader } from './physical-maps.js';
import { depthDistanceShader } from './depth-distance.js';
import { featureMaps, featureShader } from './features.js';
import { surfaceFloats } from './surface-features.js';
import { catcherLit } from './catcher.js';
import { toonDeclarations, toonEdits, toonLit } from './toon-shader.js';
import { envFloats, envMapLit, envMapShader, packEnv, type EnvCombine, type EnvironmentMap } from './env-map.js';
import { attenuationPower } from '../../shared/attenuation.js';
import { clusterBrdf } from '../../shared/light-terms.js';
import type { CasterDisplacement } from '../../shared/caster.js';
import { primitiveAfterOpaque } from '../../shared/material-routing.js';
import { SceneSurfaces } from './scene-surfaces.js';
import { MargoError } from '@margoengine/math/errors';
import { hexColor, parseColor, type ColorInput } from '@margoengine/math/color';
import type { CubeTarget } from './texture-kinds.js';
import {
  clipStatement,
  hardwarePlanes,
  markClipDistances,
  planeCapacity,
  sectionShader,
} from '../../shared/section.js';
export type { TextureTransform, MaterialSide } from '@margoengine/gltf/pbr';
/** A `KHR_texture_transform` (offset, rotation, scale, texCoord) with an optional `center`: the UV point the rotation and scale turn around, the usual texture centre pivot (default [0, 0]). */
export type MaterialUVTransform = TextureTransform & { center?: readonly [number, number] };
/** The same mapping without `center`: the pivot folds into the offset, since uv' = offset + R S (uv - c) + c = (offset + c - R S c) + R S uv. */
function foldCenter(t: MaterialUVTransform | null): TextureTransform | null {
  if (!t || t.center === undefined) return t;
  const { center, ...rest } = t;
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite))
    throw new TypeError('UV transform center must be two finite numbers; pass [u, v]');
  const [cx, cy] = center,
    [ox, oy] = rest.offset ?? [0, 0],
    [sx, sy] = rest.scale ?? [1, 1],
    r = rest.rotation ?? 0,
    cos = Math.cos(r),
    sin = Math.sin(r);
  if (!Number.isFinite(r) || ![ox, oy, sx, sy].every(Number.isFinite)) return rest; // the usual validation reports it
  return { ...rest, offset: [ox + cx - (cos * sx * cx + sin * sy * cy), oy + cy - (-sin * sx * cx + cos * sy * cy)] };
}
export {
  packAtlas,
  padTileGrid,
  remapTileUVs,
  transformUVs,
  type Atlas,
  type AtlasOptions,
  type TileGridAtlas,
  type TileGridOptions,
} from './atlas.js';
export type { EnvCombine, EnvironmentMap } from './env-map.js';
export type {
  CubeTarget,
  DataFormat,
  DataImage,
  TextureDimension,
  TranscodedMip,
  TranscodedTexture,
} from './texture-kinds.js';
declare const GPUTextureUsage: {
  TEXTURE_BINDING: number;
  COPY_DST: number;
  COPY_SRC: number;
  RENDER_ATTACHMENT: number;
};
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
export {
  type RawImage,
  type EnvMapSource,
  type ImageSource,
  type CubeSource,
  type TextureSource,
  type Wrap,
  type ParallaxMode,
  type SubsurfaceMode,
  type Filter,
  type TextureOptions,
  type TextureRegion,
  noteEngine,
  Texture,
  type TextureLimits,
  loadTexture,
  type KTX2Transcoder,
  type KTX2LayerReader,
  loadKTX2Texture,
  type CubeTextureOptions,
  CubeTexture,
  loadCubeTexture,
} from './texture-core.js';
import {
  type EnvMapSource,
  type ParallaxMode,
  type SubsurfaceMode,
  noteEngine,
  Texture,
  defaults,
  fallback,
  gpuTexture,
  liveFloats,
  changeStamp,
} from './texture-core.js';

/**
 * `lambert` is diffuse only; `phong` adds a Blinn-Phong highlight (`specular`, `shininess`); `toon` bands the diffuse
 * light through a ramp (`gradientMap` or `steps`); `basic` is unlit.
 */
export type Shading = 'standard' | 'basic' | 'normal' | 'matcap' | 'depth' | 'distance' | 'lambert' | 'phong' | 'toon';
/** How depth and distance materials store their value: `'basic'` (grayscale, default for depth) or `'rgba'` (24-bit fixed point, default for distance). */
export type DepthPacking = 'basic' | 'rgba';
/** How a material combines with what is behind it: `'normal'` (default), `'additive'`, `'multiply'` or `'none'` (opaque write). */
export type Blending = 'normal' | 'additive' | 'multiply' | 'none';
/** Where a transparent material mixes with what is behind it on a display-encoded target (`Material.blendSpace`). */
export type BlendSpace = 'display' | 'linear';
/** How a transmissive material tints what is behind it (`Material.transmissionBlend`). */
export type TransmissionBlend = 'auto' | 'two-draw' | 'dual-source';
/** A live linear colour array (what gltf/pbr reads every frame) whose `set` takes any colour input, like the option. */
type LiveColor = number[] & { set(value: ColorInput): number[] };
/**
 * Physical options (glTF KHR_materials_* meaning; gltf/pbr's physical shader draws
 * them, so a mesh and the same glTF material render alike). Any of them, at construction or set later, makes the
 * material physical (standard shading only); `transmission` and its maps make it transmissive (drawn after opaque
 * meshes). Values stay live.
 */
export interface PhysicalOptions {
  /** KHR_materials_clearcoat: layer strength and roughness, 0-1. */
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** Linear R strength, G roughness, and tangent-space RGB normal, respectively. */
  clearcoatMap?: Texture | null;
  clearcoatRoughnessMap?: Texture | null;
  clearcoatNormalMap?: Texture | null;
  clearcoatNormalScale?: number;
  /** KHR_materials_sheen: sheen colour (default black: none) and roughness 0-1. */
  sheenColor?: ColorInput;
  sheenRoughness?: number;
  /** sRGB RGB colour and linear A roughness. */
  sheenColorMap?: Texture | null;
  sheenRoughnessMap?: Texture | null;
  /** KHR_materials_specular: dielectric specular strength 0-1 and F0 colour. */
  specularIntensity?: number;
  specularColor?: ColorInput;
  /** Linear A intensity and sRGB RGB colour. */
  specularIntensityMap?: Texture | null;
  specularColorMap?: Texture | null;
  /** KHR_materials_anisotropy: strength 0-1, rotation in radians; linear RG direction and B strength. */
  anisotropy?: number;
  anisotropyRotation?: number;
  anisotropyMap?: Texture | null;
  /**
   * KHR_materials_diffuse_roughness: roughness of the diffuse lobe, 0-1 (default 0: Lambert), apart from `roughness`.
   * Shaded with the energy-preserving Oren-Nayar model.
   */
  diffuseRoughness?: number;
  /** Linear R, times `diffuseRoughness`. */
  diffuseRoughnessMap?: Texture | null;
  /** KHR_materials_iridescence: strength 0-1, film IOR >= 1, thickness range in nanometres. */
  iridescence?: number;
  iridescenceIOR?: number;
  iridescenceThicknessRange?: readonly [number, number];
  /** Linear R strength and G thickness within the configured range. */
  iridescenceMap?: Texture | null;
  iridescenceThicknessMap?: Texture | null;
  /**
   * KHR_materials_ior: index of refraction, >= 1 (default 1.5), or exactly 0 for the extension's specular-glossiness
   * mode: an infinite index, Fresnel 1 at every angle (F0 is then `specularColor` x `specularIntensity`), dispersion with
   * no effect. The mode is permanent: once `ior` is 0, later writes are ignored, as the extension requires.
   */
  ior?: number;
  /** KHR_materials_dispersion: chromatic refraction strength, finite and >= 0 (default 0). Needs transmission and volume thickness for a visible effect. */
  dispersion?: number;
  /** KHR_materials_transmission: share of light passing through, 0-1. Refracts the scene with `@margoengine/materials/transmission`; otherwise the background shows through tinted. */
  transmission?: number;
  /** Linear R transmission and G volume thickness. Either makes the material transmissive, even at factor 0. */
  transmissionMap?: Texture | null;
  thicknessMap?: Texture | null;
  /** KHR_materials_volume: thickness in mesh units (0 = thin-walled, no refraction), and the colour white light reaches after `attenuationDistance` world units inside. */
  thickness?: number;
  attenuationColor?: ColorInput;
  attenuationDistance?: number;
}
/** Options for `new Material(options)`. Every field is optional; the default is a white `'standard'` PBR material. Invalid values throw a `TypeError` or `RangeError` that names the fix. */
export interface MaterialOptions extends PhysicalOptions {
  shading?: Shading;
  /** Depth/distance output: grayscale or RGBA-packed normalized depth. Defaults to basic for depth, rgba for distance. */
  depthPacking?: DepthPacking;
  /** World-space origin for distance shading. Copied on assignment; default [0, 0, 0]. */
  referencePosition?: readonly [number, number, number];
  /** Distance normalization bounds, finite as float32: 0 <= nearDistance < farDistance. Defaults to 1 and 1000. */
  nearDistance?: number;
  farDistance?: number;
  /** Phong only: highlight colour (default sRGB `#111111`) and Blinn-Phong exponent, finite and >= 0 (default 30). Live. */
  specular?: ColorInput;
  shininess?: number;
  color?: ColorInput;
  opacity?: number;
  roughness?: number;
  metalness?: number;
  emissive?: ColorInput;
  /** Scales `emissive` (and its map), finite and >= 0 (default 1), so emission can exceed 1 for bloom. Live. */
  emissiveIntensity?: number;
  /** Shades each triangle with its own face normal instead of the interpolated vertex normals; default false. Live. */
  flatShading?: boolean;
  /** Multiplies colour and opacity by the geometry's vertex colours (default true); false ignores them. Live. */
  vertexColors?: boolean;
  /** Lit shadings: false leaves this material out of the scene fog (default true; unlit output is never fogged). Live. */
  fog?: boolean;
  /**
   * Lit shadings: false skips the display tone map (PBR Neutral) and only clamps before sRGB encoding, as unlit
   * output does (default true; unlit, normal, matcap, depth and distance output never tone map). Live.
   */
  toneMapped?: boolean;
  /** A step of per-pixel noise before 8-bit output, which removes banding in dark gradients. Default false. Live. */
  dithering?: boolean;
  map?: Texture | null;
  metalRoughnessMap?: Texture | null;
  normalMap?: Texture | null;
  normalScale?: number;
  aoMap?: Texture | null;
  aoMapIntensity?: number;
  emissiveMap?: Texture | null;
  matcap?: Texture | null;
  /**
   * Toon only: the gradient ramp the diffuse light is read through, its RGB at u = n.l * 0.5 + 0.5 (left
   * texel unlit, right texel facing the light). Linear by default; use `magFilter: 'nearest'` for hard bands. Live.
   */
  gradientMap?: Texture | null;
  /** Toon only, without a gradientMap: the number of flat light bands, an integer 2 through 256 (default 3). Live. */
  steps?: number;
  /**
   * A cube map the material reflects: a `CubeTexture`, an `@margoengine/environment` Environment, a
   * cube render target `{texture, view}` (environment's CubeCamera) or a six-layer GPUTexture. Standard shading lights
   * itself with it in place of its ambient light (specular by roughness from the mip chain, diffuse from coarse mips or
   * the Environment's harmonics); basic, Lambert and Phong shading `combine` its sharp reflection with their colour.
   * Other shadings refuse it. Live.
   */
  envMap?: EnvMapSource | null;
  /** Scales the envMap's light, finite and >= 0 (default 1). Live. */
  envMapIntensity?: number;
  /** Turns the envMap about +Y, in radians (default 0; added to an Environment's own rotation). Live. */
  envMapRotation?: number;
  /** `'reflection'` (default) samples along the mirrored view ray, `'refraction'` along the ray bent by `refractionRatio`. Live. */
  envMapMode?: 'reflection' | 'refraction';
  /** Refraction only: the ratio of the indices of refraction, finite and > 0 (default 1/1.5, about 0.667: from air, index 1, into crown glass, index about 1.5). Live. */
  refractionRatio?: number;
  /** Basic, Lambert and Phong: how the reflection meets the colour (default 'multiply'). Live. */
  combine?: EnvCombine;
  /** Basic, Lambert and Phong: the reflection's weight, 0 through 1 (default 1). Live. */
  reflectivity?: number;
  /** Opacity map: its green channel (linear) multiplies opacity, before `alphaTest` and blending. Live. */
  alphaMap?: Texture | null;
  /** Height map (red, linear) that tilts the shading normal by its screen-space slope, after `normalMap`. Live. */
  bumpMap?: Texture | null;
  /** Height of `bumpMap`'s full range in mesh units, finite (negative inverts); default 1. Live. */
  bumpScale?: number;
  /**
   * Moves each vertex along its normal by red (linear) * `displacementScale` + `displacementBias` mesh units, in every
   * pass that draws the material (beauty, G-buffer, directional and clustered shadow maps). Live.
   */
  displacementMap?: Texture | null;
  /** Finite; defaults 1 and 0. Live. */
  displacementScale?: number;
  displacementBias?: number;
  /**
   * Baked light (sRGB colour by default), on UV1 unless its UV transform names another set: lit shadings add diffuse
   * colour * map * `lightMapIntensity` as indirect light (aoMap applies), unlit ones multiply their colour by it. Live.
   */
  lightMap?: Texture | null;
  /** Finite; default 1. Live. */
  lightMapIntensity?: number;
  /** Multiply by the light map (default), or Lambertian irradiance / pi on lit shadings. Use a linear lightMap texture; physical intensity must be nonnegative. Live. */
  lightMapResponse?: 'multiply' | 'lambertian';
  /**
   * Height map (red, linear: 1 the surface, 0 `parallaxScale` below it) the view ray is marched through, so every map
   * on its UV set (UV0 unless its UV transform names UV1) shifts as if the surface had that relief. Shading only: the
   * silhouette, depth, shadows and picking keep the flat mesh. Live; null for none.
   */
  parallaxMap?: Texture | null;
  /** Depth of `parallaxMap`'s full range in world units, finite and >= 0 (default 0.05). Live. */
  parallaxScale?: number;
  /**
   * `'occlusion'` (default) steps along the ray and interpolates the hit, `'relief'` refines it by bisection (sharper
   * steps), `'offset'` takes one cheap step that flattens at grazing angles. Live.
   */
  parallaxMode?: ParallaxMode;
  /** Steps of the occlusion and relief march, an integer 1 through 64 (default 16). Live. */
  parallaxSteps?: number;
  /**
   * Projects the maps on UV0 from world space along X, Y and Z and blends the three by the normal, so a mesh needs no
   * unwrap and textures meet without seams or stretching; UV1 maps (a lightMap) keep their UVs. Default false. Live.
   */
  triplanar?: boolean;
  /** Texture repeats per world unit of the triplanar projection, finite and > 0 (default 1). Live. */
  triplanarScale?: number;
  /** Exponent of the blend weights |n|^sharpness, finite and >= 1 (default 4): higher gives narrower transitions. Live. */
  triplanarSharpness?: number;
  /**
   * Subsurface scattering weight, 0 through 1 (default 0: off). Standard, Lambert and Phong shading. Light from the
   * engine's directional light enters the surface and leaves elsewhere, tinted by the base colour and
   * `subsurfaceColor`. Live.
   */
  subsurface?: number;
  /**
   * `'thick'` (default): light seen through the object around the light (statues, skin, wax) plus a diffuse that wraps
   * past the terminator; `'thin'`: a sheet lit from behind shows the light through it (leaves, paper, cloth). Live.
   */
  subsurfaceMode?: SubsurfaceMode;
  /** Colour the scattered light picks up, multiplied by the base colour (default white). Live. */
  subsurfaceColor?: ColorInput;
  /** Local thickness 0 through 1 (default 0.5); light passes through 1 - thickness. Times `subsurfaceThicknessMap`. Live. */
  subsurfaceThickness?: number;
  /** Local thickness (red, linear) times `subsurfaceThickness`: white blocks the light, black lets it through. Live. */
  subsurfaceThicknessMap?: Texture | null;
  /** Thick only: how far the surface normal bends the light seen through the object, finite and >= 0 (default 0.2). Live. */
  subsurfaceDistortion?: number;
  /** Thick only: how tightly the light seen through gathers around the light's direction, finite and > 0 (default 4). Live. */
  subsurfacePower?: number;
  /** Thick only: how far diffuse light wraps past the terminator, 0 through 1 (default 0.5). Live. */
  subsurfaceWrap?: number;
  /**
   * Up to 16 world-space planes `[a, b, c, d]`: points with `a x + b y + c z + d < 0` are cut away (the section
   * convention), in every pass that draws the material. Live; default none.
   */
  clippingPlanes?: readonly (readonly number[])[];
  /** The planes clip the material's directional shadows too (default true). Live. */
  clipShadows?: boolean;
  /**
   * false (default): cut away what is behind any plane (the union of their negative sides). true: cut away only what is
   * behind every plane (their intersection), e.g. a wedge out of a solid. Live.
   */
  clipIntersection?: boolean;
  transparent?: boolean;
  alphaTest?: number;
  /** Optional features from this package's entries (`alphaHash()` from `/alpha-hash`, ...). Live; default none. */
  features?: readonly MaterialFeature[];
  /** Faces drawn by triangle meshes. Explicit side takes precedence over doubleSided. */
  side?: MaterialSide;
  doubleSided?: boolean;
  /** Draws triangle edges instead of filled surfaces; defaults to false. Live, like all render state below. */
  wireframe?: boolean;
  blending?: Blending;
  /**
   * Where a transparent material mixes with what is behind it on a display-encoded canvas: 'display' (default, the
   * common WebGL blend) or 'linear' (linear light: 50% red over black reads sRGB(0.25), not half of sRGB(0.5)).
   * Linear costs a pass break and a full-target copy before each such mesh. Live.
   */
  blendSpace?: BlendSpace;
  /**
   * How a `transmission` material without a transmission pass tints what is behind it: 'auto' (default) draws once
   * with dual-source blending (lit colour plus background times the tint) on a device created with
   * `features: ['dual-source-blending']`, and in two draws (tint, then lit) elsewhere; 'two-draw' always draws twice;
   * 'dual-source' draws once or throws MargoError `unsupported` where the device lacks the feature. A value other than
   * 'auto' is explicit render state (the sorted beauty path). Live.
   */
  transmissionBlend?: TransmissionBlend;
  depthWrite?: boolean;
  depthTest?: boolean;
  colorWrite?: boolean;
  /** With `alphaTest` on a multisampled target, cut edges by sample coverage, so they come out smooth; defaults to false. */
  alphaToCoverage?: boolean;
  /** Positive factors/units push polygons away from the camera, including the reverse-Z renderer. */
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
  polygonOffsetClamp?: number;
  /** Enables stencil comparison and operations. Other stencil options are inactive when false. */
  stencilWrite?: boolean;
  stencilRef?: number;
  stencilReadMask?: number;
  stencilWriteMask?: number;
  stencilFunc?: GPUCompareFunction;
  stencilFail?: GPUStencilOperation;
  stencilZFail?: GPUStencilOperation;
  stencilZPass?: GPUStencilOperation;
  /** UV offset/scale/rotation for every map but `matcap` (KHR_texture_transform semantics), e.g. an atlas region. */
  uvTransform?: MaterialUVTransform;
}
/** Every map slot of a material, in the order its physical maps are numbered. */
export const mapSlots = [
  'map',
  'metalRoughnessMap',
  'normalMap',
  'aoMap',
  'emissiveMap',
  'clearcoatMap',
  'clearcoatRoughnessMap',
  'clearcoatNormalMap',
  'transmissionMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularIntensityMap',
  'specularColorMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'anisotropyMap',
  'thicknessMap',
  'diffuseRoughnessMap',
] as const;
/** Names of the texture maps a material can hold, such as `'map'`, `'normalMap'` or `'aoMap'`. */
export type MapSlot = (typeof mapSlots)[number];
/**
 * An optional surface feature from one of this package's entries (`@margoengine/materials/alpha-hash` and the like),
 * assigned through `Material.features`. It costs a material that does not list it nothing: its WGSL lives in its entry.
 */
export interface MaterialFeature {
  /** Portable owner options. Custom features can instead supply a serialization codec. */
  serialization?(): unknown;
  /** Optional private state of this feature's attachment to one material. */
  captureState?(material: Material): unknown;
  /** Restore the state returned by captureState after attachment. */
  restoreState?(material: Material, state: unknown): void;
  /** What it is: a material holds one feature of each name. */
  readonly name: string;
  /** Edits the material's finished shader (`group` is its bind group). The text a feature writes is fixed at creation; assign a new feature to change it. */
  shader(code: string, group: number, material: Material): string;
  /** True when `shader` reads the tangent frame `t` and `b` for a normal map of its own, so the frame points as a normal map's does. */
  tangentFrame?: boolean;
  /** Edits the shader once the scene's lighting effects are composed into it. */
  lit?(code: string, material: Material): string;
  /** Bind group entries of `group`, read on every draw; `owner` keys what it allocates. */
  bindings?(device: GPUDevice, owner: object, material: Material): GPUBindGroupEntry[];
  /**
   * Edits a cut-out shadow caster's depth shader so it cuts by the feature's noise instead of the cutoff (`alphaHash`:
   * its hash, shared/alpha-hash.js `hashedDepth`). The material record hands it to shadow passes as `castHashed`, so a
   * shadow package carries no hash WGSL of its own.
   */
  castHashed?(code: string): string;
  /**
   * What depth passes (shadows, picking, TAA velocity) draw for a feature that moves vertices; `map` is the material's
   * own `displacementMap` record. The first feature that has one speaks for the material, after a subclass's `caster`.
   */
  caster?(device: GPUDevice, material: Material, map: CasterDisplacement | undefined): CasterDisplacement | undefined;
  /** Called when the feature joins a material. */
  attach?(material: Material): void;
  /** Called when the feature leaves a material. */
  detach?(material: Material): void;
  /**
   * True when the shader reads per-instance data of its own by instance index (`materialPlugin` with
   * `instanceAttributes`), so a GPU culler or sorter leaves these instances in their own rows.
   */
  readonly instanceRows?: boolean;
}
const slots = ['map', 'metalRoughnessMap', 'normalMap', 'aoMap', 'emissiveMap', 'matcap'] as const,
  names = ['baseMap', 'mrMap', 'normalMap', 'aoMap', 'emissiveMap', 'matcap'];
const unit = (v: unknown, label: string) => {
  if (typeof v !== 'number' || !(v >= 0 && v <= 1))
    throw new RangeError(`Material ${label} must be in [0, 1]; set a number from 0 to 1.`);
  return v;
};
const rasterMask = (v: number, label: string): number => {
  if (typeof v !== 'number') throw new TypeError(`Material ${label} must be a number; set an unsigned 32-bit integer`);
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff)
    throw new RangeError(`Material ${label} is out of range; set an integer from 0 through 4294967295`);
  return v;
};
const rasterFloat = (v: number, label: string): number => {
  if (typeof v !== 'number') throw new TypeError(`Material ${label} must be a number; set a finite float32 value`);
  if (!Number.isFinite(Math.fround(v)))
    throw new RangeError(`Material ${label} is not finite as float32; set a finite float32 value`);
  return v;
};
const stencilFunctions: readonly string[] = [
  'never',
  'less',
  'equal',
  'less-equal',
  'greater',
  'not-equal',
  'greater-equal',
  'always',
];
const stencilOperations: readonly string[] = [
  'keep',
  'zero',
  'replace',
  'invert',
  'increment-clamp',
  'decrement-clamp',
  'increment-wrap',
  'decrement-wrap',
];
// GPU uniforms are float32: a finite double such as 1e39 would upload as Infinity.
const finiteFloat = (v: unknown, label: string, min = -Infinity): number => {
  if (typeof v !== 'number' || !Number.isFinite(Math.fround(v)) || !(v >= min))
    throw new RangeError(
      `Material ${label} must be finite as float32${min > -Infinity ? ` and >= ${min}` : ''}; set a number in that range.`,
    );
  return v;
};
/** Render state, live: each change selects the matching beauty pipeline on the next draw. */
interface Raster {
  blending: Blending;
  blendSpace: BlendSpace;
  transmissionBlend: TransmissionBlend;
  depthWrite: boolean | undefined;
  depthTest: boolean;
  colorWrite: boolean;
  alphaToCoverage: boolean;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  polygonOffsetClamp: number;
  stencilWrite: boolean;
  stencilRef: number;
  stencilReadMask: number;
  stencilWriteMask: number;
  stencilFunc: GPUCompareFunction;
  stencilFail: GPUStencilOperation;
  stencilZFail: GPUStencilOperation;
  stencilZPass: GPUStencilOperation;
  wireframe: boolean;
}
const rasterDefaults: Raster = {
  blending: 'normal',
  blendSpace: 'display',
  transmissionBlend: 'auto',
  depthWrite: undefined,
  depthTest: true,
  colorWrite: true,
  alphaToCoverage: false,
  polygonOffset: false,
  polygonOffsetFactor: 0,
  polygonOffsetUnits: 0,
  polygonOffsetClamp: 0,
  stencilWrite: false,
  stencilRef: 0,
  stencilReadMask: 255,
  stencilWriteMask: 255,
  stencilFunc: 'always',
  stencilFail: 'keep',
  stencilZFail: 'keep',
  stencilZPass: 'keep',
  wireframe: false,
};
const flag = (v: unknown, label: string): boolean => {
  if (typeof v !== 'boolean') throw new TypeError(`Material ${label} must be a boolean; set true or false`);
  return v;
};
const oneOf = (list: readonly string[], kind: string) => (v: unknown, label: string) => {
  if (!list.includes(v as string)) throw new TypeError(`Material ${label} is invalid; set ${kind}`);
  return v;
};
const rasterChecks: Record<keyof Raster, (v: never, label: string) => unknown> = {
  blending: oneOf(['normal', 'additive', 'multiply', 'none'], "'normal', 'additive', 'multiply' or 'none'"),
  blendSpace: oneOf(['display', 'linear'], "'display' or 'linear'"),
  transmissionBlend: oneOf(['auto', 'two-draw', 'dual-source'], "'auto', 'two-draw' or 'dual-source'"),
  depthWrite: (v, label) => (v === undefined ? v : flag(v, label)),
  depthTest: flag,
  colorWrite: flag,
  alphaToCoverage: flag,
  polygonOffset: flag,
  polygonOffsetFactor: rasterFloat,
  polygonOffsetUnits: (v: number) => {
    if (typeof v !== 'number')
      throw new TypeError(
        'Material polygonOffsetUnits must be a number; set an integer between -2147483647 and 2147483647',
      );
    if (!Number.isInteger(v) || Math.abs(v) > 0x7fffffff)
      throw new RangeError(
        'Material polygonOffsetUnits is out of range; set an integer between -2147483647 and 2147483647',
      );
    return v;
  },
  polygonOffsetClamp: rasterFloat,
  stencilWrite: flag,
  stencilRef: rasterMask,
  stencilReadMask: rasterMask,
  stencilWriteMask: rasterMask,
  stencilFunc: oneOf(stencilFunctions, 'a WebGPU comparison name'),
  stencilFail: oneOf(stencilOperations, 'a WebGPU stencil operation name'),
  stencilZFail: oneOf(stencilOperations, 'a WebGPU stencil operation name'),
  stencilZPass: oneOf(stencilOperations, 'a WebGPU stencil operation name'),
  wireframe: flag,
};
function distanceRange(near: number, far: number): void {
  finiteFloat(near, 'nearDistance');
  finiteFloat(far, 'farDistance');
  if (near < 0 || Math.fround(far) <= Math.fround(near))
    throw new RangeError('Material distance bounds must satisfy 0 <= nearDistance < farDistance as float32');
}
// glTF extension of each physical option (the exported material names them).
const extensions: Record<keyof PhysicalOptions, string> = {
  clearcoat: 'clearcoat',
  clearcoatRoughness: 'clearcoat',
  clearcoatMap: 'clearcoat',
  clearcoatRoughnessMap: 'clearcoat',
  clearcoatNormalMap: 'clearcoat',
  clearcoatNormalScale: 'clearcoat',
  sheenColor: 'sheen',
  sheenRoughness: 'sheen',
  sheenColorMap: 'sheen',
  sheenRoughnessMap: 'sheen',
  specularIntensity: 'specular',
  specularColor: 'specular',
  specularIntensityMap: 'specular',
  specularColorMap: 'specular',
  anisotropy: 'anisotropy',
  anisotropyRotation: 'anisotropy',
  anisotropyMap: 'anisotropy',
  diffuseRoughness: 'diffuse_roughness',
  diffuseRoughnessMap: 'diffuse_roughness',
  iridescence: 'iridescence',
  iridescenceIOR: 'iridescence',
  iridescenceThicknessRange: 'iridescence',
  iridescenceMap: 'iridescence',
  iridescenceThicknessMap: 'iridescence',
  ior: 'ior',
  dispersion: 'dispersion',
  transmission: 'transmission',
  transmissionMap: 'transmission',
  thicknessMap: 'volume',
  thickness: 'volume',
  attenuationColor: 'volume',
  attenuationDistance: 'volume',
};
// '#rrggbb', '#rgb' and 0xrrggbb are sRGB (math's parseColor); arrays are linear [r, g, b] or [r, g, b, a], each 0-1.
const linear = (c: ColorInput, label: string, max = 1): number[] => {
  if (typeof c === 'number' && !(Number.isInteger(c) && c >= 0 && c <= 0xffffff))
    throw new RangeError(`Material ${label} number must be a 0xrrggbb sRGB colour; set 0x000000 through 0xffffff`);
  const v =
    typeof c === 'number' || (typeof c === 'string' && hexColor(c))
      ? (parseColor(c) as number[])
      : Array.isArray(c)
        ? [...c]
        : [];
  if (v.length < 3 || v.length > 4)
    throw new TypeError(
      `Invalid material ${label}; set '#rrggbb', '#rgb', 0xrrggbb or linear [r, g, b] with components 0-1`,
    );
  if (max === 1) v.forEach((x) => unit(x, label));
  else v.forEach((x) => finiteFloat(x, label, 0));
  return v;
};
/** The `set` of live colours by label: one function per label, so all colours of a label keep one hidden class. */
const colorSetters = new Map<string, (this: number[], input: ColorInput) => number[]>();
/** `values` with a `set(input)` that writes the parsed colour into it (opacity only from a four-component array). */
function liveColor(values: number[], label: string): LiveColor {
  let set = colorSetters.get(label);
  if (!set)
    colorSetters.set(
      label,
      (set = function (this: number[], input: ColorInput) {
        const v = linear(input, label);
        for (let k = 0; k < Math.min(v.length, this.length); k++) this[k] = v[k];
        return this;
      }),
    );
  return Object.defineProperty(values, 'set', { value: set }) as LiveColor;
}
// Lambert and Blinn-Phong rewrite gltf/pbr's direct and hemisphere terms in place, so every lighting hook point
// (direct+ambient(s), var color=, fn ambient, the tone-map line) and the shadows, fog and SSAO hooks stay. Radiance is
// scaled as on the standard path: the diffuse BRDF base/pi times n.l times the light's irradiance, the hemisphere times
// base. Blinn-Phong (Blinn 1977) is the microfacet BRDF D*F*G/(4 n.l n.v) with Blinn's distribution normalised over
// projected microfacet area, D = (n+2)/(2 pi) (n.h)^n, the implicit G = n.l n.v and F = the specular colour, which
// leaves (n+2)/(8 pi) (n.h)^n * specular. margoFront and margoAmbientLayers are the layered hook interface
// (shared/pbr-hooks.js): clustered point and spot lights get these same BRDFs (`litShader`); other local-light hooks
// (area lights) shade the surface as a dielectric of the matching microfacet roughness (Walter et al. 2007: Beckmann
// alpha = sqrt(2/(n+2)), roughness = sqrt(alpha); Lambert is roughness 1), and an ambient hook (IBL, probes) keeps only
// its diffuse part, the term on the surface minus the term on a black surface.
// Normalisation (n+2)/(8 pi): Akenine-Moller et al., Real-Time Rendering; Hoffman 2010 SIGGRAPH course notes. The
// hemisphere ambient (ground (0.35, 0.3, 0.25) to sky 1) is a Margo design choice; the margoFront roughness floor 0.045
// is the minimum perceptual roughness of the Filament design document (published engine standard).
const phongLobe = (n: string) => `mat_phong.rgb*(mat_phong.w+2)/25.13274123*pow(max(dot(${n},h),0.0001),mat_phong.w)`;
const litEdits = (phong: boolean): [RegExp | string, string][] => [
  [
    /fn hemisphere_ambient\(s:Surface\)->vec3f \{[^}]*\}/,
    'fn hemisphere_ambient(s:Surface)->vec3f {return s.base.rgb*mix(vec3f(0.35,0.3,0.25),vec3f(1),clamp(s.n.y*0.5+0.5,0.0,1.0))*f.radiance.w*s.occlusion;}',
  ],
  [
    /fn direct_light\(s:Surface,v:vec3f,l:vec3f\)->vec3f \{[^}]*\}/,
    `fn direct_light(s:Surface,v:vec3f,l:vec3f)->vec3f {
  let nl=clamp(dot(s.n,l),0.0,1.0);${phong ? `\n  let h=(v+l)/max(length(v+l),0.0001); let spec=${phongLobe('s.n')};` : ''}
  return (s.base.rgb/3.14159265${phong ? '+spec' : ''})*nl*f.radiance.rgb*f.light.w;
}`,
  ],
  [
    '@fragment fn fragment(',
    `fn margoFront(s:Surface)->Surface {var o=s; o.metal=0; o.roughness=${phong ? 'max(pow(2/(mat_phong.w+2),0.25),0.045)' : '1.0'}; return o;}
fn margoAmbientTerm(i:Out,s:Surface,v:vec3f)->vec3f {return vec3f(0);}
fn margoAmbientLayers(i:Out,s:Surface,v:vec3f)->vec3f {var o=margoFront(s); let d=margoAmbientTerm(i,o,v); o.base=vec4f(vec3f(0),o.base.a); return d-margoAmbientTerm(i,o,v);}
@fragment fn fragment(`,
  ],
  // Auxiliary entries (G-buffer, ambient) keep the beauty bind group layout.
  ...(phong
    ? [
        ['fn surface(i:Out,front:bool)->Surface {', 'fn surface(i:Out,front:bool)->Surface {\n  _=mat_phong;'] as [
          string,
          string,
        ],
      ]
    : []),
];
const outputs: Record<Exclude<Shading, 'standard' | 'depth' | 'distance' | 'lambert' | 'phong' | 'toon'>, string> = {
  basic: 'return vec4f(mat_out(s.base.rgb+s.emissive),alpha);',
  normal: 'return vec4f(normalize((f.view*vec4f(s.n,0)).xyz)*0.5+0.5,alpha);',
  // Lit-sphere lookup (Sloan et al. 2001) by the view-space normal, in a frame facing the eye from the shaded point (so
  // the image does not slide toward the screen edges) with a level right axis: right = +Y x eye, up = eye x right.
  // Eye along +/-Y has no level frame and falls back to the view axes. uv = 0.5 + 0.49 d keeps the disc's rim one
  // percent inside the image, clear of the texture border.
  matcap:
    'let mat_n=normalize((f.view*vec4f(s.n,0)).xyz);let mat_e=normalize(-(f.view*vec4f(i.position,1)).xyz);let mat_x=vec3f(mat_e.z,0.0,-mat_e.x);let mat_level=dot(mat_x,mat_x)>0.0000000001;let mat_r=select(vec3f(1,0,0),mat_x*inverseSqrt(max(dot(mat_x,mat_x),0.0000000001)),mat_level);let mat_u=select(vec3f(0,1,0),cross(mat_e,mat_r),mat_level);return vec4f(mat_out(s.base.rgb*textureSample(mat_matcap,mat_matcapS,vec2f(0.5)+0.49*vec2f(dot(mat_n,mat_r),dot(mat_n,mat_u))).rgb),alpha);',
};
const encode =
  'fn mat_out(c:vec3f)->vec3f {if(f.settings.w>0.5){return c;}let x=clamp(c,vec3f(0),vec3f(1));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}';
const patched = new Map<string, Map<string, string>>();
/** A material's GPU state for one engine: `buffer` its shading's uniform, `features` the feature uniform (features.ts). */
type MapState = {
  refs: number;
  device?: GPUDevice;
  buffer?: GPUBuffer;
  /** The clipping-plane uniform (section layout) and its binding, kept while the buffer lives. */
  clip?: GPUBuffer;
  clipBinding?: GPUBufferBinding;
  clipData?: Float32Array;
  values?: Float32Array;
  features?: GPUBuffer;
  featureData?: Float32Array;
  /** The surface-feature uniform (surface-features.ts MargoSurface) and its values. */
  surface?: GPUBuffer;
  surfaceData?: Float32Array;
  /** The envMap uniform (env-map.ts MargoEnv) and its values. */
  env?: GPUBuffer;
  envData?: Float32Array;
  displacement?: { buffer: GPUBuffer; view: GPUTextureView; sampler: GPUSampler };
  castMask?: CastMask;
  /** The uniforms watched for their device's loss, by field (`watchUniformLost`). */
  lost?: Map<UniformField, LostUniform>;
};
/** gltf/pbr `PBRMaterial.castMask`, kept and refilled per material and owner: read for every caster, every pass. */
type CastMask = {
  view: GPUTextureView;
  sampler: GPUSampler;
  texCoord: 0 | 1;
  transform: Float32Array;
  opacity?: { buffer: GPUBuffer; view: GPUTextureView; sampler: GPUSampler };
};
const mapStates = new WeakMap<Material, Map<object, MapState>>(),
  disposedMaterials = new WeakSet<Material>();
/**
 * `feature` takes `to` as a material of its own, as `from` holds it: its captured attachment state when it has one
 * (alphaHash's raised alphaTest), otherwise its `attach` (an eye counts its users).
 */
function joined(feature: MaterialFeature, to: Material, from: Material): void {
  if (feature.captureState && feature.restoreState) feature.restoreState(to, feature.captureState(from));
  else feature.attach?.(to);
}
/** Throws for a disposed material: meshes may not start drawing one. */
function usable(m: Material): void {
  if (disposedMaterials.has(m))
    throw new MargoError('disposed', 'Material is disposed; create a new Material or clone() it before disposing');
}
/** A field copy for clone/copy: arrays and plain objects are duplicated, everything else (textures, nodes) shared. */
const duplicate = (v: unknown): unknown =>
  Array.isArray(v) ? v.slice() : v && Object.getPrototypeOf(v) === Object.prototype ? { ...v } : v;
let baseKeys: readonly string[] | undefined;
function mapState(m: Material, owner: object): MapState {
  let states = mapStates.get(m);
  if (!states) mapStates.set(m, (states = new Map()));
  let state = states.get(owner);
  if (!state) states.set(owner, (state = { refs: 0 }));
  return state;
}
function retainMaps(m: Material, engine: Engine): () => void {
  const state = mapState(m, engine);
  state.refs++;
  return () => {
    if (--state.refs) return;
    // Bind groups made with these buffers must not be reused (`MaterialShading.version`).
    m['changes'] = changeStamp();
    state.buffer?.destroy();
    state.features?.destroy();
    state.surface?.destroy();
    state.env?.destroy();
    state.clip?.destroy();
    unwatchUniforms(state);
    mapStates.get(m)?.delete(engine);
  };
}
type UniformField = 'buffer' | 'features' | 'surface' | 'env' | 'clip';
type LostUniform = { state: MapState; field: UniformField; buffer: GPUBuffer; device: GPUDevice };
// The material uniforms on each device, destroyed once when it is lost. One reaction per device over this set, which a
// material's state leaves when its last mesh goes or it is disposed: one reaction per uniform kept every released
// state and its buffers alive as long as the device (docs/known-bugs.md).
const lostUniforms = new WeakMap<GPUDevice, Set<LostUniform>>();
function watchUniformLost(state: MapState, field: UniformField, device: GPUDevice, buffer: GPUBuffer): void {
  let set = lostUniforms.get(device);
  if (!set) {
    const watching = (set = new Set());
    lostUniforms.set(device, watching);
    void device.lost?.then(() => {
      for (const u of watching)
        if (u.state[u.field] === u.buffer) {
          u.buffer.destroy();
          u.state[u.field] = undefined;
        }
      watching.clear();
    });
  }
  const old = state.lost?.get(field);
  if (old) lostUniforms.get(old.device)?.delete(old);
  const entry = { state, field, buffer, device };
  set.add(entry);
  (state.lost ??= new Map()).set(field, entry);
}
/** The state's uniforms go: none is watched for a device loss any more. */
function unwatchUniforms(state: MapState): void {
  for (const u of state.lost?.values() ?? []) lostUniforms.get(u.device)?.delete(u);
  state.lost?.clear();
}
function materialBuffer(
  m: Material,
  device: GPUDevice,
  owner: object,
  size: number,
  field: UniformField = 'buffer',
): GPUBuffer {
  const state = mapState(m, owner);
  // A map added later may need a longer uniform (diffuseRoughnessMap).
  if (state.device !== device || !state[field] || state[field].size < size) {
    state[field]?.destroy();
    state.device = device;
    // A new buffer is a new binding: bind groups made with the old one must be made again (`MaterialShading.version`).
    m['changes'] = changeStamp();
    const buffer = (state[field] = device.createBuffer({
      size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    watchUniformLost(state, field, device, buffer);
  }
  return state[field];
}
const lit: readonly Shading[] = ['standard', 'lambert', 'phong', 'toon'],
  litMaterial = (m: Material) => lit.includes(m.shading);
/** The feature maps `m` draws now; a lightMap means nothing to normal, matcap, depth and distance output. */
function featureMapsUsed(m: Material): boolean[] {
  const maps = m['featureTextures'];
  return [!!maps[0], !!maps[1], !!maps[2], !!maps[3] && (m.shading === 'basic' || lit.includes(m.shading))];
}
/**
 * The feature letters (features.ts) `m` uses now on gltf/pbr shader `code`: its shader variant. An extension lobe
 * sampling a tangent-space map (clearcoat(), materialLobes anisotropy, a node graph's normalMap) calls the shared
 * frame from declarations placed ahead of its definition, so it takes `n` too.
 */
function featureKey(m: Material, code: string): string {
  const [alpha, bump, displacement, light] = featureMapsUsed(m),
    first = code.indexOf('margoCotangentFrame('),
    lobeFrame = first > 2 && !code.startsWith('fn ', first - 3);
  return (
    (alpha ? 'a' : '') +
    (bump ? 'b' : '') +
    (displacement ? 'd' : '') +
    (light ? (m.shading === 'basic' ? 'u' : 'l') : '') +
    (m.flatShading && m.shading !== 'basic' && m.shading !== 'depth' && m.shading !== 'distance' ? 'f' : '') +
    (m.vertexColors ? '' : 'v') +
    (lit.includes(m.shading) ? (m.fog ? '' : 'g') + (m.toneMapped ? '' : 't') : '') +
    (m.normalMap ||
    m.clearcoatNormalMap ||
    m.extensions.includes('anisotropy') ||
    lobeFrame ||
    m['added'].some((v) => v.tangentFrame)
      ? 'n'
      : '') +
    surfaceKey(m) +
    (m.dithering && !unencoded.includes(m.shading) ? 'q' : '')
  );
}
/** Shadings that write data rather than a colour for the screen, so output dithering has nothing to do. */
const unencoded: readonly Shading[] = ['normal', 'depth', 'distance'];
/** The surface maps (surface-features.ts bindings 171-174), in uniform-row order. */
const surfaceMaps = ['parallaxMap', 'subsurfaceThicknessMap'] as const;
const parallaxModes: readonly ParallaxMode[] = ['offset', 'occlusion', 'relief'];
/** Shadings the subsurface terms light (their fragment keeps gltf/pbr's directional-light line). */
const scattering: readonly Shading[] = ['standard', 'lambert', 'phong'];
/** The surface features (surface-features.ts) `m` uses now: parallax, triplanar, subsurface and its thickness map. */
function surfaceUsed(m: Material): readonly [boolean, boolean, boolean, boolean] {
  const maps = m['surfaceTextures'],
    subsurface = m.subsurface > 0 && scattering.includes(m.shading);
  return [!!maps[0], m.triplanar, subsurface, subsurface && !!maps[1]];
}
/** The feature letters of the surface features `m` uses: `p` parallax, `x` triplanar, `s` subsurface, `k` its map. */
function surfaceKey(m: Material): string {
  const [parallax, triplanar, subsurface, thickness] = surfaceUsed(m);
  return (parallax ? 'p' : '') + (triplanar ? 'x' : '') + (subsurface ? 's' : '') + (thickness ? 'k' : '');
}
/** The surface uniform of `m` for `owner`, written with its current values. */
function surfaceUniform(m: Material, device: GPUDevice, owner: object): GPUBuffer {
  const buffer = materialBuffer(m, device, owner, surfaceFloats * 4, 'surface'),
    data = (mapState(m, owner).surfaceData ??= new Float32Array(surfaceFloats));
  data.set(m['surfaceValues']);
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
/** Surface map `k`'s view and sampler (0 parallax, 1 thickness); one still loading reads white (no relief, full thickness). */
const surfaceTexture = (m: Material, k: number, device: GPUDevice) =>
  m['surfaceTextures'][k]!.sampled(device, false, surfaceMaps[k], projected(m, m['surfaceValues'], 4 + k * 24)) ??
  fallback(device, 0);
/**
 * True when triplanar replaces the UVs of the map whose UV transform starts at `rows[at]`: the map reads UV0 (the
 * transform's texCoord flag, row 3, is 0) and triplanar is on.
 */
const projected = (m: Material, rows: ArrayLike<number>, at: number) => m.triplanar && !(rows[at + 3] > 0.5);
/** The feature uniform of `m` for `owner`, written with its current values. */
function featureUniform(m: Material, device: GPUDevice, owner: object): GPUBuffer {
  const buffer = materialBuffer(m, device, owner, 144, 'features'),
    data = (mapState(m, owner).featureData ??= new Float32Array(36));
  data.set(m['featureValues']);
  // Lambertian response: radiance = irradiance / pi (Lambert).
  if (m.lightMapResponse === 'lambertian') data[3] = m.lightMapIntensity / Math.PI;
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}
/** Feature map `k`'s view and sampler; a map still loading reads white (alpha, bump) or black (displacement, light). */
const featureTexture = (m: Material, k: number, device: GPUDevice) =>
  // The displacement map moves vertices by the mesh's own UVs, which no projection replaces.
  m['featureTextures'][k]!.sampled(
    device,
    k === 3,
    featureMaps[k],
    k !== 2 && projected(m, m['featureValues'], 4 + k * 8),
  ) ?? fallback(device, k < 2 ? 0 : 3);
/** `entries` plus the feature uniform and maps `m` uses now (none for a material without features). */
function featureBindings(m: Material, device: GPUDevice, owner: object, entries: GPUBindGroupEntry[]) {
  const maps = featureMapsUsed(m),
    [parallax, triplanar, subsurface, thickness] = surfaceUsed(m),
    mapped = maps.some(Boolean);
  if (!mapped && !parallax && !triplanar && !subsurface) return entries;
  const out = [...entries];
  if (mapped) out.push({ binding: 198, resource: { buffer: featureUniform(m, device, owner) } });
  maps.forEach((used, k) => {
    if (!used) return;
    const [view, sampler] = featureTexture(m, k, device);
    out.push({ binding: 180 + k * 2, resource: view }, { binding: 181 + k * 2, resource: sampler });
  });
  if (parallax || triplanar || subsurface)
    out.push({ binding: 170, resource: { buffer: surfaceUniform(m, device, owner) } });
  for (const [used, k] of [
    [parallax, 0],
    [thickness, 1],
  ] as const)
    if (used) {
      const [view, sampler] = surfaceTexture(m, k, device);
      out.push({ binding: 171 + k * 2, resource: view }, { binding: 172 + k * 2, resource: sampler });
    }
  return out;
}
/** What shadow casters bind to displace `m` like its beauty shader (gltf/pbr `PBRMaterial.displacement`), kept while the same. */
function displacementOf(m: Material, device: GPUDevice | null | undefined, owner: object) {
  if (!m.displacementMap || !device) return undefined;
  const state = mapState(m, owner),
    buffer = featureUniform(m, device, owner),
    [view, sampler] = featureTexture(m, 2, device),
    last = state.displacement;
  return last?.buffer === buffer && last.view === view && last.sampler === sampler
    ? last
    : (state.displacement = { buffer, view, sampler });
}
/**
 * The map and alphaMap of `m` as a pass other than its colour pass binds them. Triplanar projects the map from world
 * space, which such a pass's UVs cannot follow: it keeps its whole surface (README).
 */
function surfaceMask(m: Material, device: GPUDevice | null | undefined, owner: object): CastMask | undefined {
  if (!device || m.triplanar || (!m.map && !m.alphaMap)) return undefined;
  const state = mapState(m, owner),
    [view, sampler] = m.map?.sampled(device, true, 'map') ?? fallback(device, 0),
    mask = (state.castMask ??= { view, sampler, texCoord: 0, transform: new Float32Array(8) }),
    rows = m.uvt.length >= 8 ? m.uvt : m['uvDefault'];
  mask.view = view;
  mask.sampler = sampler;
  for (let k = 0; k < 8; k++) mask.transform[k] = rows[k];
  mask.texCoord = rows[3] > 0.5 ? 1 : 0;
  if (m.alphaMap) {
    const buffer = featureUniform(m, device, owner),
      [view, sampler] = featureTexture(m, 0, device),
      last = mask.opacity;
    if (last?.buffer !== buffer || last.view !== view || last.sampler !== sampler)
      mask.opacity = { buffer, view, sampler };
  } else delete mask.opacity;
  return mask;
}
/** What shadow casters cut `m` out with: only `alphaTest` cuts, so an opaque or blended caster's draw does not change. */
const castMaskOf = (m: Material, device: GPUDevice | null | undefined, owner: object): CastMask | undefined =>
  m.settings[0] === 1 ? surfaceMask(m, device, owner) : undefined;
/** What picking tests `m` with: a blended material has holes too, where its coverage is 0. */
const pickMaskOf = (m: Material, device: GPUDevice | null | undefined, owner: object): CastMask | undefined =>
  m.settings[0] !== 0 ? surfaceMask(m, device, owner) : undefined;
/** Planes a material holds: the uniform's room (shared/section.js). */
const maxPlanes = planeCapacity('materialClip');
/** The clipping-plane uniform of `m` for `owner` (section layout: 16 planes, count in settings.x), written now. */
function clipUniform(m: Material, device: GPUDevice, owner: object): GPUBufferBinding {
  const buffer = materialBuffer(m, device, owner, maxPlanes * 16 + 16, 'clip'),
    state = mapState(m, owner),
    data = (state.clipData ??= new Float32Array(maxPlanes * 4 + 4)),
    planes = m['clipping'];
  data.fill(0);
  data.set(planes);
  data[maxPlanes * 4] = planes.length / 4;
  data[maxPlanes * 4 + 1] = +m.clipIntersection;
  device.queue.writeBuffer(buffer, 0, data);
  if (state.clipBinding?.buffer !== buffer) state.clipBinding = { buffer };
  return state.clipBinding;
}
/** What shadow casters bind to clip `m` like its beauty shader (gltf/pbr `PBRMaterial.clip`), or undefined. */
function clipOf(m: Material, device: GPUDevice | null | undefined, owner: object) {
  return device && m['clipping'].length && m.clipShadows ? clipUniform(m, device, owner) : undefined;
}
/** What passes that follow the surface bind to clip `m`, whether or not its shadows are clipped (gltf/pbr `surfaceClip`). */
function surfaceClipOf(m: Material, device: GPUDevice | null | undefined, owner: object) {
  return device && m['clipping'].length ? clipUniform(m, device, owner) : undefined;
}
const surfaceAnchor = 'if(!facing&&f.settings.z<0.5){discard;}';
/**
 * `code` discarding what the material's planes cut away: in every fragment entry, and in gltf/pbr's `surface()` so
 * fragments appended later (the SSAO occlusion output) clip too.
 */
/**
 * Whether `m`'s planes may cut in the rasterizer on `device`. Clip distances cut a union of at most `hardwarePlanes`;
 * an intersection, or more planes, stays on discard.
 */
const hardwareClip = (m: Material, device: GPUDevice | null | undefined): boolean =>
  !m.clipIntersection && m['clipping'].length <= hardwarePlanes * 4 && !!device?.features?.has('clip-distances');
/**
 * Whether the vertex stage of `code` has room for clip distances: eight take two of the device's inter-stage slots, and
 * instanced drawing passes one more variable. Otherwise, as with an eye's three, the planes stay on discard.
 */
function roomForDistances(code: string, device: GPUDevice): boolean {
  const fields = /struct Out \{[^}]*\}/.exec(code)?.[0];
  if (!fields || !code.includes('var o:Out;')) return false;
  const top = Math.max(...[...fields.matchAll(/@location\((\d+)\)/g)].map((match) => +match[1]));
  return top + 4 <= device.limits.maxInterStageShaderVariables;
}
function clipShader(code: string, group: number): string {
  const out = sectionShader(code, group, 199, 'materialClip');
  return out.replace(surfaceAnchor, clipStatement('materialClip') + surfaceAnchor);
}
/**
 * Whether `m` takes the physical-maps shader. A transmissive material also takes it when a base map or a feature can
 * vary its colour across the surface: that shader's tint draw reads the surface, since KHR_materials_transmission tints
 * the transmitted light by the whole base colour, baseColorTexture included (KB-MAT-TINTMAP1). The plain tint draw
 * multiplies by one constant colour.
 */
function mapped(m: Material): boolean {
  return (
    !!m.physical &&
    (m.physical.length > 12 ||
      mapSlots.slice(5).some((k) => m[k] != null) ||
      (!!m.volume && (mapSlots.slice(0, 5).some((k) => m[k] != null) || m['added'].length > 0)))
  );
}
function mapPlan(m: Material) {
  const textures: { texture: Texture; srgb: boolean; fallback: number }[] = [],
    samplers: Texture[] = [];
  const slots = mapSlots.map((k, i): readonly [number, number] | null => {
    const texture = m[k];
    if (!texture) return null;
    if (!(texture instanceof Texture)) throw new TypeError(`Material ${k} must be a Texture; pass a Texture instance.`);
    const srgb = texture.options.colorSpace ? texture.options.colorSpace === 'srgb' : [0, 4, 9, 12].includes(i);
    const fallback = i === 2 || i === 7 ? 1 : i === 15 ? 2 : 0,
      pending = !texture.width || !texture.height || ('readyState' in texture.source && texture.source.readyState < 2);
    let t = textures.findIndex(
        (v) => v.texture === texture && v.srgb === srgb && (!pending || v.fallback === fallback),
      ),
      s = samplers.indexOf(texture);
    if (t < 0) {
      t = textures.length;
      textures.push({ texture, srgb, fallback });
    }
    if (s < 0) {
      s = samplers.length;
      samplers.push(texture);
    }
    return [t, s];
  });
  return { textures, samplers, slots };
}
/** True for a standard material with no texture at all: it draws {@link bareShader} and binds no textures. */
function bare(m: Material): boolean {
  return (
    !m.physical &&
    m.shading === 'standard' &&
    slots.every((k) => m[k] == null) &&
    !featureMapsUsed(m).some(Boolean) &&
    !m.envMap
  );
}
const bareCode = new Map<string, string>();
/**
 * gltf/pbr's shader for a standard material without maps: each texture read becomes the value of the texture a missing
 * map stands for (white; the flat normal (0.5, 0.5, 1), exactly what the defaults hold), and gltf/pbr's group-1
 * textures are dropped. Without it such a material read ten textures per fragment (gltf/pbr's white defaults times
 * this package's). The tangent frame stays: extension lobes on the primitive may still use it.
 */
function bareShader(source: string): string {
  let out = bareCode.get(source);
  if (out !== undefined) return out;
  const dropped: string[] = [];
  out = source.replace(/@group\(1\) @binding\(\d+\) var (\w+):[^;]+;\n?/g, (_, name: string) => {
    dropped.push(name);
    return '';
  });
  let count = 0;
  const edit = (from: string | RegExp, to: string) => {
    const next = out!.replace(from, () => to);
    if (next !== out) count++;
    out = next;
  };
  for (const map of ['base', 'mr', 'ao', 'emissive'])
    edit(new RegExp(`textureSample\\(${map}Map,${map}Sampler,uv\\(i,f\\.coords[AB]\\.[xyzw]\\)\\)`, 'g'), 'vec4f(1)');
  edit(/textureSample\(normalMap,normalSampler,uv\(i,f\.coordsA\.z\)\)/g, 'vec4f(0.5,0.5,1,1)');
  // gltf/pbr's KHR physical and extended variants read their extension maps (slots 5-17) from group 1 too; a missing
  // one holds white, the clearcoat normal map a flat normal (gltf/pbr's normalMaps).
  out = out.replace(/textureSample\((\w+)Map,\1Sampler,uv\(i,\d+\)\)/g, (_, name: string) =>
    name === 'clearcoatNormal' ? 'vec4f(0.5,0.5,1,1)' : 'vec4f(1)',
  );
  if (count !== 5 || dropped.some((name) => new RegExp(`\\b${name}\\b`).test(out!)))
    throw new MargoError('unsupported', 'Materials require the standard gltf/pbr shader; draw the mesh with gltf/pbr');
  if (bareCode.size >= 64) bareCode.clear();
  bareCode.set(source, out);
  return out;
}
/** Rewrites gltf/pbr's beauty shader to multiply in this package's maps (group 2, bindings 32-43) and, for non-standard shading, return early. */
export function materialShader(source: string, group: number, shading: Shading): string {
  let cache = patched.get(source);
  const key = shading + group,
    cached = cache?.get(key);
  if (cached) return cached;
  if (shading === 'depth' || shading === 'distance') {
    const output = depthDistanceShader(materialShader(source, group, 'standard'), group, shading);
    patched.get(source)!.set(key, output);
    return output;
  }
  let count = 0;
  let code = source
    .replace(
      /textureSample\((baseMap|mrMap|aoMap|emissiveMap),(\w+),(uv\(i,f\.coords[AB]\.[xyzw]\))\)/g,
      (_, map, sampler, uv) => {
        count++;
        return `(textureSample(mat_${map},mat_${map}S,${uv})*textureSample(${map},${sampler},${uv}))`;
      },
    )
    .replace(/textureSample\(normalMap,normalSampler,(uv\(i,f\.coordsA\.z\))\)\.xyz\*2-1/, (_, uv) => {
      count++;
      return `textureSample(mat_normalMap,mat_normalMapS,${uv}).xyz*2-1+0*textureSample(normalMap,normalSampler,${uv}).xyz`;
    });
  const lit = shading === 'lambert' || shading === 'phong' || shading === 'toon',
    edits = shading === 'toon' ? toonEdits : lit ? litEdits(shading === 'phong') : [];
  if (shading !== 'standard' && !lit)
    code = code.replace(/@fragment fn fragment\([^{]*\{\s*let s=surface\(i,front\);/, (head) => {
      count++;
      return `${head}\n  let alpha=select(1.0,s.base.a,f.settings.x>1.5);\n  if(f.coordsB.w<0.5){${outputs[shading]}}`;
    });
  for (const [from, to] of edits)
    code = code.replace(from, () => {
      count++;
      return to;
    });
  if (shading === 'matcap')
    // Auxiliary entries call surface() but not the beauty fragment. Retain the same bind group layout there.
    code = code.replace('fn surface(i:Out,front:bool)->Surface {', '$&\n  _=mat_matcap;_=mat_matcapS;');
  if (count !== (shading === 'standard' ? 5 : lit ? 5 + edits.length : 6))
    throw new MargoError(
      'state',
      'Materials require the standard gltf/pbr shader; update @margoengine/gltf/pbr to a version that matches this package.',
    );
  const declarations = names
    .slice(0, shading === 'matcap' ? 6 : 5)
    .map(
      (name, i) =>
        `@group(${group}) @binding(${32 + i * 2}) var mat_${name}:texture_2d<f32>;\n@group(${group}) @binding(${33 + i * 2}) var mat_${name}S:sampler;`,
    )
    .join('\n');
  const output =
    declarations +
    '\n' +
    (shading === 'phong' ? `@group(${group}) @binding(197) var<uniform> mat_phong:vec4f;\n` : '') +
    (shading === 'toon' ? toonDeclarations(group) : '') +
    (shading === 'basic' || shading === 'matcap' ? encode + '\n' : '') +
    code;
  if (!cache) patched.set(source, (cache = new Map()));
  cache.set(key, output);
  return output;
}
const localTerm = 'result+=' + clusterBrdf + '*nl*',
  composed = { lambert: new Map<string, string>(), phong: new Map<string, string>() };
/**
 * `code` with its lighting effects composed in (gltf/pbr's `lit` hook): Lambert and Phong put their own BRDF in place of
 * clustered's per-light GGX term, so point and spot lights shade them exactly as the directional light does; a shadow
 * catcher then measures its shadows (catcher.ts). Other materials, and code without clustered lights, come back
 * unchanged.
 */
function litShader(m: Material, code: string): string {
  if (m.shading === 'toon') return toonLit(code);
  const phong = m.shading === 'phong';
  if (!phong && m.shading !== 'lambert') return code;
  const cache = composed[m.shading as 'lambert' | 'phong'];
  let out = cache.get(code);
  if (out === undefined) {
    if (cache.size >= 64) cache.clear();
    out = code.includes(localTerm)
      ? code.split(localTerm).join('result+=margoLocalBrdf(n,v,l,base)*nl*') +
        `\nfn margoLocalBrdf(n:vec3f,v:vec3f,l:vec3f,base:vec3f)->vec3f {${phong ? `let h=(v+l)/max(length(v+l),0.0001);return base/3.14159265+${phongLobe('n')};` : 'return base/3.14159265;'}}\n`
      : code;
    cache.set(code, out);
  }
  return phong ? out : catcherLit(out);
}
/** Live values: colours, scalar setters, map assignments and render state apply on the next frame to every mesh using the material. Shading is fixed. */
export class Material {
  readonly shading: Shading;
  private readonly raster: Raster = { ...rasterDefaults };
  private packing: DepthPacking = 'basic';
  private reference: readonly [number, number, number] = [0, 0, 0];
  private near = 1;
  private far = 1000;
  private readonly rgba: LiveColor;
  private readonly glow: LiveColor;
  private readonly highlight: LiveColor;
  private gloss = 30;
  /** Toon: the band count and gradient ramp. */
  private toonSteps = 3;
  private toonMap: Texture | null = null;
  /** The environment map and how it is read (env-map.ts). */
  private readonly env: {
    map: EnvMapSource | null;
    /** Holds `map` by the borrowed-object rule when it is a function, a GPUTexture or a plain object; null for live objects. */
    slot: BorrowSlot<Exclude<EnvMapSource, (device: GPUDevice) => unknown>, EnvMapSource> | null;
    intensity: number;
    rotation: number;
    mode: 'reflection' | 'refraction';
    ratio: number;
    combine: EnvCombine;
    reflectivity: number;
  } = {
    map: null,
    slot: null,
    intensity: 1,
    rotation: 0,
    mode: 'reflection',
    ratio: 1 / 1.5,
    combine: 'multiply',
    reflectivity: 1,
  };
  private glowScale = 1;
  /** On/off features (features.ts letters f...). */
  /** Optional features and the stamp of their last assignment (their shader text is fixed, so it names the variant). */
  private added: readonly MaterialFeature[] = [];
  private addedStamp = 0;
  private readonly switches = { flatShading: false, vertexColors: true, fog: true, toneMapped: true, dithering: false };
  /** gltf\/pbr layout: [roughness, metalness, normalScale, aoMapIntensity] and [alphaMode, alphaTest, side (front 0, double 1, back 2), 0]. */
  readonly factors: number[];
  readonly settings: number[];
  private blend: boolean;
  /** gltf\/pbr layout: two rows per map slot (offset*rotation*scale), in `MapSlot` order. */
  readonly uvt: number[] = [];
  private uvDefault = textureTransform({}, 0);
  /** The base maps in `slots` order: map, metalRoughnessMap, normalMap, aoMap, emissiveMap, matcap. */
  private readonly baseMaps: (Texture | null)[] = [null, null, null, null, null, null];
  /**
   * The change stamp (`changeStamp`) of this material's last edit: every setter, `setUVTransform` and `copy` take a
   * new one once meshes draw it (`trackChanges`), and an in-place colour write is found by `liveStamp`.
   */
  private changes = changeStamp();
  private setBaseMap(i: number, v: Texture | null): void {
    if (v != null && !(v instanceof Texture))
      throw new TypeError(`Material ${slots[i]} must be a Texture; pass a Texture instance or null.`);
    this.baseMaps[i] = v ?? null;
  }
  /** Base colour map (sRGB unless its colorSpace says otherwise), live; null for none. */
  get map(): Texture | null {
    return this.baseMaps[0];
  }
  set map(v: Texture | null) {
    this.setBaseMap(0, v);
  }
  /** glTF metallic-roughness map (G roughness, B metalness, linear), live; null for none. */
  get metalRoughnessMap(): Texture | null {
    return this.baseMaps[1];
  }
  set metalRoughnessMap(v: Texture | null) {
    this.setBaseMap(1, v);
  }
  /** Tangent-space normal map (linear), live; null for none. */
  get normalMap(): Texture | null {
    return this.baseMaps[2];
  }
  set normalMap(v: Texture | null) {
    this.setBaseMap(2, v);
  }
  /** Ambient occlusion map (R, linear), live; null for none. */
  get aoMap(): Texture | null {
    return this.baseMaps[3];
  }
  set aoMap(v: Texture | null) {
    this.setBaseMap(3, v);
  }
  /** Emissive map (sRGB), live; null for none. */
  get emissiveMap(): Texture | null {
    return this.baseMaps[4];
  }
  set emissiveMap(v: Texture | null) {
    this.setBaseMap(4, v);
  }
  /** Matcap texture (matcap shading), live; null for none. */
  get matcap(): Texture | null {
    return this.baseMaps[5];
  }
  set matcap(v: Texture | null) {
    this.setBaseMap(5, v);
  }
  /** The feature maps (features.ts `featureMaps` order). */
  private readonly featureTextures: (Texture | null)[] = [null, null, null, null];
  /** The feature uniform (features.ts): four values, then two UV rows per feature map (lightMap's on UV1). */
  private readonly featureValues: number[] = [
    1,
    1,
    0,
    1,
    ...Array(3).fill(textureTransform({}, 0)).flat(),
    ...textureTransform({}, 1),
  ];
  private lightResponse: 'multiply' | 'lambertian' = 'multiply';
  /** Clipping planes, four normalised numbers each (at most 64), and whether they clip shadows. */
  private clipping: number[] = [];
  private clipShadow = true;
  private clipAll = false;
  /**
   * Up to 16 world-space planes `[a, b, c, d]`; points with `a x + b y + c z + d < 0` are cut away in every pass that
   * draws the material (beauty, G-buffer and, with `clipShadows`, directional shadows). Reading gives normalised copies;
   * assign a new list to change them (live). Throws TypeError for a malformed plane, RangeError for more than 16.
   */
  get clippingPlanes(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < this.clipping.length; i += 4) out.push(this.clipping.slice(i, i + 4));
    return out;
  }
  set clippingPlanes(v: readonly (readonly number[])[]) {
    if (!Array.isArray(v)) throw new TypeError('Material clippingPlanes must be an array of [a, b, c, d] planes');
    if (v.length > maxPlanes)
      throw new RangeError(`Material clippingPlanes holds at most ${maxPlanes} planes; pass fewer`);
    const flat: number[] = [];
    for (const p of v) {
      if (
        !Array.isArray(p) ||
        p.length !== 4 ||
        !p.every((x) => typeof x === 'number' && Number.isFinite(Math.fround(x)))
      )
        throw new TypeError('Material clipping plane must be four finite numbers [a, b, c, d]');
      const length = Math.hypot(p[0], p[1], p[2]);
      if (!length) throw new TypeError('Material clipping plane needs a non-zero normal [a, b, c]');
      // A tiny normal makes d / |n| overflow float32 (the uniform would hold Infinity).
      if (!Number.isFinite(Math.fround(p[3] / length)))
        throw new RangeError(
          'Material clipping plane distance d / |[a, b, c]| must be finite as float32; scale the plane up',
        );
      flat.push(p[0] / length, p[1] / length, p[2] / length, p[3] / length);
    }
    this.clipping = flat;
  }
  /**
   * false (default): `clippingPlanes` cut away what is behind any plane (their union). true: only what is behind every
   * plane (their intersection). Live; shadows follow.
   */
  get clipIntersection(): boolean {
    return this.clipAll;
  }
  set clipIntersection(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Material clipIntersection must be a boolean; pass true or false');
    this.clipAll = v;
  }
  /** Whether `clippingPlanes` clip this material's directional shadows too (default true), live. */
  get clipShadows(): boolean {
    return this.clipShadow;
  }
  set clipShadows(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Material clipShadows must be a boolean; pass true or false');
    this.clipShadow = v;
  }
  private setFeatureMap(k: number, v: Texture | null): void {
    if (v != null && !(v instanceof Texture))
      throw new TypeError(`Material ${featureMaps[k]} must be a Texture; pass a Texture or null`);
    this.featureTextures[k] = v ?? null;
  }
  get alphaMap(): Texture | null {
    return this.featureTextures[0];
  }
  set alphaMap(v: Texture | null) {
    this.setFeatureMap(0, v);
  }
  get bumpMap(): Texture | null {
    return this.featureTextures[1];
  }
  set bumpMap(v: Texture | null) {
    this.setFeatureMap(1, v);
  }
  get bumpScale(): number {
    return this.featureValues[0];
  }
  set bumpScale(v: number) {
    this.featureValues[0] = rasterFloat(v, 'bumpScale');
  }
  get displacementMap(): Texture | null {
    return this.featureTextures[2];
  }
  set displacementMap(v: Texture | null) {
    this.setFeatureMap(2, v);
  }
  get displacementScale(): number {
    return this.featureValues[1];
  }
  set displacementScale(v: number) {
    this.featureValues[1] = rasterFloat(v, 'displacementScale');
  }
  get displacementBias(): number {
    return this.featureValues[2];
  }
  set displacementBias(v: number) {
    this.featureValues[2] = rasterFloat(v, 'displacementBias');
  }
  get lightMap(): Texture | null {
    return this.featureTextures[3];
  }
  set lightMap(v: Texture | null) {
    this.setFeatureMap(3, v);
  }
  get lightMapIntensity(): number {
    return this.featureValues[3];
  }
  set lightMapIntensity(v: number) {
    const value = rasterFloat(v, 'lightMapIntensity');
    if (this.lightResponse === 'lambertian' && value < 0)
      throw new RangeError('Material Lambertian lightMapIntensity must be nonnegative; use physical irradiance');
    this.featureValues[3] = value;
  }
  /** The live baked-light response; Lambertian requires lit shading, a linear irradiance texture and nonnegative intensity. */
  get lightMapResponse(): 'multiply' | 'lambertian' {
    return this.lightResponse;
  }
  set lightMapResponse(v: 'multiply' | 'lambertian') {
    if (v !== 'multiply' && v !== 'lambertian')
      throw new TypeError("Material lightMapResponse must be 'multiply' or 'lambertian'; choose a supported response");
    if (v === 'lambertian') {
      if (!lit.includes(this.shading))
        throw new TypeError('Material Lambertian lightMapResponse needs lit shading; use standard, lambert or phong');
      if (this.featureValues[3] < 0)
        throw new RangeError('Material Lambertian lightMapIntensity must be nonnegative; use physical irradiance');
    }
    this.lightResponse = v;
  }
  /** The surface maps (`surfaceMaps` order): parallaxMap, subsurfaceThicknessMap. */
  private readonly surfaceTextures: (Texture | null)[] = [null, null];
  /** The surface uniform (surface-features.ts MargoSurface), at its defaults: every feature off. */
  private readonly surfaceValues: number[] = [
    0.05,
    16,
    1,
    0,
    ...textureTransform({}, 0),
    1,
    4,
    0,
    0,
    0,
    0,
    0.2,
    4,
    1,
    1,
    1,
    0.5,
    0.5,
    0,
    0,
    0,
    ...textureTransform({}, 0),
  ];
  private triplanarOn = false;
  private setSurfaceMap(k: number, v: Texture | null): void {
    if (v != null && !(v instanceof Texture))
      throw new TypeError(`Material ${surfaceMaps[k]} must be a Texture; pass a Texture or null`);
    this.surfaceTextures[k] = v ?? null;
  }
  /** Sets surface uniform value `k` to the already checked `v`. */
  private setSurface(k: number, v: number): void {
    this.surfaceValues[k] = v;
  }
  /** Height map the view ray is marched through (red, linear; 1 the surface), live; null for none. */
  get parallaxMap(): Texture | null {
    return this.surfaceTextures[0];
  }
  set parallaxMap(v: Texture | null) {
    this.setSurfaceMap(0, v);
  }
  /** Depth of `parallaxMap`'s full range in world units, finite and >= 0 (default 0.05), live. */
  get parallaxScale(): number {
    return this.surfaceValues[0];
  }
  set parallaxScale(v: number) {
    if (rasterFloat(v, 'parallaxScale') < 0)
      throw new RangeError('Material parallaxScale must be >= 0; set a depth in world units');
    this.setSurface(0, v);
  }
  /** Steps of the occlusion and relief march, an integer 1 through 64 (default 16), live. */
  get parallaxSteps(): number {
    return this.surfaceValues[1];
  }
  set parallaxSteps(v: number) {
    if (typeof v !== 'number') throw new TypeError('Material parallaxSteps must be a number; set an integer 1 to 64');
    if (!Number.isInteger(v) || v < 1 || v > 64)
      throw new RangeError('Material parallaxSteps must be an integer from 1 through 64; set one in that range');
    this.setSurface(1, v);
  }
  /** `'occlusion'` (default), `'relief'` or `'offset'`, live. */
  get parallaxMode(): ParallaxMode {
    return parallaxModes[this.surfaceValues[2]];
  }
  set parallaxMode(v: ParallaxMode) {
    const mode = parallaxModes.indexOf(v);
    if (mode < 0)
      throw new TypeError("Material parallaxMode must be 'occlusion', 'relief' or 'offset'; set one of them");
    this.setSurface(2, mode);
  }
  /** World-space triplanar projection of the UV0 maps (default false), live. */
  get triplanar(): boolean {
    return this.triplanarOn;
  }
  set triplanar(v: boolean) {
    this.triplanarOn = flag(v, 'triplanar');
  }
  /** Texture repeats per world unit of the triplanar projection, finite and > 0 (default 1), live. */
  get triplanarScale(): number {
    return this.surfaceValues[12];
  }
  set triplanarScale(v: number) {
    if (!(rasterFloat(v, 'triplanarScale') > 0))
      throw new RangeError('Material triplanarScale must be > 0; set texture repeats per world unit');
    this.setSurface(12, v);
  }
  /** Exponent of the triplanar blend weights, finite and >= 1 (default 4), live. */
  get triplanarSharpness(): number {
    return this.surfaceValues[13];
  }
  set triplanarSharpness(v: number) {
    if (rasterFloat(v, 'triplanarSharpness') < 1)
      throw new RangeError('Material triplanarSharpness must be >= 1; set 1 (soft) or more (sharper)');
    this.setSurface(13, v);
  }
  /** Subsurface scattering weight 0 through 1 (default 0: off); standard, Lambert and Phong shading. Live. */
  get subsurface(): number {
    return this.surfaceValues[16];
  }
  set subsurface(v: number) {
    unit(v, 'subsurface');
    if (v > 0 && !scattering.includes(this.shading))
      throw new TypeError('Material subsurface needs standard, lambert or phong shading; use one of those materials');
    this.setSurface(16, v);
  }
  /** `'thick'` (default) or `'thin'`, live. */
  get subsurfaceMode(): SubsurfaceMode {
    return this.surfaceValues[17] ? 'thin' : 'thick';
  }
  set subsurfaceMode(v: SubsurfaceMode) {
    if (v !== 'thick' && v !== 'thin')
      throw new TypeError("Material subsurfaceMode must be 'thick' or 'thin'; set one");
    this.setSurface(17, +(v === 'thin'));
  }
  /** Linear colour the scattered light picks up (default white); assign any colour input. Live. */
  get subsurfaceColor(): number[] {
    return this.surfaceValues.slice(20, 23);
  }
  set subsurfaceColor(c: ColorInput) {
    const v = linear(c, 'subsurfaceColor');
    this.surfaceValues.splice(20, 3, v[0], v[1], v[2]);
  }
  /** Local thickness 0 through 1 (default 0.5), times `subsurfaceThicknessMap`. Live. */
  get subsurfaceThickness(): number {
    return this.surfaceValues[23];
  }
  set subsurfaceThickness(v: number) {
    this.setSurface(23, unit(v, 'subsurfaceThickness'));
  }
  /** Local thickness map (red, linear), live; null for none. */
  get subsurfaceThicknessMap(): Texture | null {
    return this.surfaceTextures[1];
  }
  set subsurfaceThicknessMap(v: Texture | null) {
    this.setSurfaceMap(1, v);
  }
  /** Thick only: normal distortion of the light seen through, finite and >= 0 (default 0.2). Live. */
  get subsurfaceDistortion(): number {
    return this.surfaceValues[18];
  }
  set subsurfaceDistortion(v: number) {
    if (rasterFloat(v, 'subsurfaceDistortion') < 0)
      throw new RangeError('Material subsurfaceDistortion must be >= 0; set 0 for none');
    this.setSurface(18, v);
  }
  /** Thick only: exponent of the light seen through, finite and > 0 (default 4). Live. */
  get subsurfacePower(): number {
    return this.surfaceValues[19];
  }
  set subsurfacePower(v: number) {
    if (!(rasterFloat(v, 'subsurfacePower') > 0))
      throw new RangeError('Material subsurfacePower must be > 0; set 1 (broad) or more (tight)');
    this.setSurface(19, v);
  }
  /** Thick only: diffuse wrap past the terminator, 0 through 1 (default 0.5). Live. */
  get subsurfaceWrap(): number {
    return this.surfaceValues[24];
  }
  set subsurfaceWrap(v: number) {
    this.setSurface(24, unit(v, 'subsurfaceWrap'));
  }
  private readonly physicalTextures: (Texture | null)[] = Array(13).fill(null);
  private setMap(i: number, value: Texture | null): void {
    const key = mapSlots[i + 5] as keyof PhysicalOptions;
    if (value != null) {
      if (!(value instanceof Texture))
        throw new TypeError(`Material ${key} must be a Texture; pass a Texture instance.`);
      this.enable(key);
      // The last slot (diffuseRoughnessMap) takes UV rows only when used.
      while (this.uvt.length < (i === 12 ? 18 : 17) * 8) this.uvt.push(...this.uvDefault);
    }
    this.physicalTextures[i] = value ?? null;
  }
  get clearcoatMap(): Texture | null {
    return this.physicalTextures[0];
  }
  set clearcoatMap(v: Texture | null) {
    this.setMap(0, v);
  }
  get clearcoatRoughnessMap(): Texture | null {
    return this.physicalTextures[1];
  }
  set clearcoatRoughnessMap(v: Texture | null) {
    this.setMap(1, v);
  }
  get clearcoatNormalMap(): Texture | null {
    return this.physicalTextures[2];
  }
  set clearcoatNormalMap(v: Texture | null) {
    this.setMap(2, v);
  }
  get transmissionMap(): Texture | null {
    return this.physicalTextures[3];
  }
  set transmissionMap(v: Texture | null) {
    this.setMap(3, v);
  }
  get sheenColorMap(): Texture | null {
    return this.physicalTextures[4];
  }
  set sheenColorMap(v: Texture | null) {
    this.setMap(4, v);
  }
  get sheenRoughnessMap(): Texture | null {
    return this.physicalTextures[5];
  }
  set sheenRoughnessMap(v: Texture | null) {
    this.setMap(5, v);
  }
  get specularIntensityMap(): Texture | null {
    return this.physicalTextures[6];
  }
  set specularIntensityMap(v: Texture | null) {
    this.setMap(6, v);
  }
  get specularColorMap(): Texture | null {
    return this.physicalTextures[7];
  }
  set specularColorMap(v: Texture | null) {
    this.setMap(7, v);
  }
  get iridescenceMap(): Texture | null {
    return this.physicalTextures[8];
  }
  set iridescenceMap(v: Texture | null) {
    this.setMap(8, v);
  }
  get iridescenceThicknessMap(): Texture | null {
    return this.physicalTextures[9];
  }
  set iridescenceThicknessMap(v: Texture | null) {
    this.setMap(9, v);
  }
  get anisotropyMap(): Texture | null {
    return this.physicalTextures[10];
  }
  set anisotropyMap(v: Texture | null) {
    this.setMap(10, v);
  }
  get thicknessMap(): Texture | null {
    return this.physicalTextures[11];
  }
  set thicknessMap(v: Texture | null) {
    this.setMap(11, v);
  }
  private rotation = 0;
  /**
   * Physical materials only (set once any physical option is), gltf/pbr layout: [clearcoat, clearcoatRoughness, 1,
   * transmission, specularColor rgb, specularIntensity, sheenColor rgb, sheenRoughness], and [0, ior, 0, dispersion].
   */
  readonly physical?: number[];
  readonly ext?: number[];
  /** Transmissive materials only (set once transmission or its maps are), gltf\/pbr layout: [thickness, transmittance per world unit rgb]. */
  readonly volume?: number[];
  /** glTF extensions (`KHR_materials_<name>`) the physical options use, in the order they were first set. */
  readonly extensions: readonly string[] = [];
  private attenuation = [1, 1, 1, Infinity];
  private readonly tinted = [0, 0, 0];
  constructor(o: MaterialOptions = {}) {
    const shading = o.shading ?? 'standard';
    for (const key of Object.keys(rasterDefaults) as (keyof Raster)[])
      if (o[key] !== undefined) this.setRaster(key, o[key]);
    if (
      !['standard', 'basic', 'normal', 'matcap', 'depth', 'distance', 'lambert', 'phong', 'toon'].includes(shading) ||
      (o.side !== undefined && !['front', 'back', 'double'].includes(o.side)) ||
      [o.transparent, o.doubleSided].some((v) => v !== undefined && typeof v !== 'boolean') ||
      (o.normalScale !== undefined &&
        (typeof o.normalScale !== 'number' || !Number.isFinite(Math.fround(o.normalScale))))
    )
      throw new TypeError('Invalid material options; check shading, side, transparent, doubleSided and normalScale.');
    for (const slot of [...mapSlots, 'matcap'] as const)
      if (o[slot] != null && !(o[slot] instanceof Texture))
        throw new TypeError(`Material ${slot} must be a Texture; pass a Texture instance.`);
    this.shading = shading;
    this.switches.toneMapped = lit.includes(shading);
    this.depthPacking = o.depthPacking === undefined ? (shading === 'distance' ? 'rgba' : 'basic') : o.depthPacking;
    if (o.referencePosition !== undefined) this.referencePosition = o.referencePosition;
    const near = o.nearDistance === undefined ? 1 : o.nearDistance,
      far = o.farDistance === undefined ? 1000 : o.farDistance;
    distanceRange(near, far);
    this.near = near;
    this.far = far;
    this.blend = o.transparent ?? false;
    const rgba = linear(o.color ?? [1, 1, 1], 'color');
    if (rgba.length === 3) rgba.push(unit(o.opacity ?? 1, 'opacity'));
    this.rgba = liveColor(rgba, 'color');
    this.glow = liveColor(linear(o.emissive ?? [0, 0, 0], 'emissive').slice(0, 3), 'emissive');
    if ((o.specular !== undefined || o.shininess !== undefined) && shading !== 'phong')
      throw new TypeError("Material specular and shininess need phong shading; set shading: 'phong'");
    this.highlight = liveColor(linear(o.specular ?? '#111111', 'specular').slice(0, 3), 'specular');
    // 30 (Margo's): the exponent whose Walter et al. 2007 GGX roughness (2/(n+2))^(1/4) is 0.5, core's default.
    this.shininess = o.shininess ?? 30;
    if ((o.steps !== undefined || o.gradientMap != null) && shading !== 'toon')
      throw new TypeError("Material steps and gradientMap need toon shading; set shading: 'toon'");
    if (o.steps !== undefined) this.steps = o.steps;
    if (o.gradientMap != null) this.gradientMap = o.gradientMap;
    for (const key of [
      'envMapIntensity',
      'envMapRotation',
      'envMapMode',
      'refractionRatio',
      'combine',
      'reflectivity',
      'envMap',
    ] as const)
      if (o[key] !== undefined) this[key] = o[key] as never;
    this.factors = [
      unit(o.roughness ?? 1, 'roughness'),
      unit(o.metalness ?? 0, 'metalness'),
      o.normalScale ?? 1,
      unit(o.aoMapIntensity ?? 1, 'aoMapIntensity'),
    ];
    this.settings = [0, unit(o.alphaTest ?? 0, 'alphaTest'), +(o.doubleSided ?? false), 0];
    if (o.side !== undefined) this.side = o.side;
    this.sync();
    this.setUVTransform(o.uvTransform ?? null);
    this.map = o.map ?? null;
    this.metalRoughnessMap = o.metalRoughnessMap ?? null;
    this.normalMap = o.normalMap ?? null;
    this.aoMap = o.aoMap ?? null;
    this.emissiveMap = o.emissiveMap ?? null;
    this.matcap = o.matcap ?? null;
    for (const key of [
      'alphaMap',
      'bumpMap',
      'bumpScale',
      'displacementMap',
      'displacementScale',
      'displacementBias',
      'lightMap',
      'lightMapIntensity',
      'lightMapResponse',
      'emissiveIntensity',
      'flatShading',
      'vertexColors',
      'fog',
      'toneMapped',
      'dithering',
      'clippingPlanes',
      'clipShadows',
      'clipIntersection',
      'parallaxMap',
      'parallaxScale',
      'parallaxMode',
      'parallaxSteps',
      'triplanar',
      'triplanarScale',
      'triplanarSharpness',
      'subsurface',
      'subsurfaceMode',
      'subsurfaceColor',
      'subsurfaceThickness',
      'subsurfaceThicknessMap',
      'subsurfaceDistortion',
      'subsurfacePower',
      'subsurfaceWrap',
      'features',
    ] as const)
      if (o[key] !== undefined) this[key] = o[key] as never;
    // Physical options enable their lobes as they are set (transmission before the volume values that need it); the
    // constructor names every extension its options use.
    const used = (Object.keys(extensions) as (keyof PhysicalOptions)[]).filter((k) => o[k] != null);
    if (o.dispersion === null) throw new RangeError('Material dispersion must be a finite number >= 0');
    if (used.length && shading !== 'standard') throw new TypeError('Physical options need standard shading');
    this.extensions = [
      ...new Set([...used.map((k) => extensions[k]), ...(o.thicknessMap != null ? ['transmission'] : [])]),
    ];
    Object.assign(this, Object.fromEntries(used.map((k) => [k, o[k]])));
  }
  /** Beauty-pass blending (default 'normal'). It and the depth, colour-write, polygon-offset and stencil state below are live: a change selects the matching pipeline on the next draw. */
  get blending(): Blending {
    return this.raster.blending;
  }
  set blending(v: Blending) {
    this.setRaster('blending', v);
  }
  /**
   * Where a transparent ('normal' blending) material mixes with what is behind it on a display-encoded canvas
   * (default 'display'). 'linear' mixes in linear light, at the cost of a pass break and a full-target copy per mesh;
   * an HDR target (Bloom, tonemapping) is linear either way.
   */
  get blendSpace(): BlendSpace {
    return this.raster.blendSpace;
  }
  set blendSpace(v: BlendSpace) {
    this.setRaster('blendSpace', v);
  }
  /** How a transmissive material tints what is behind it (default 'auto': one dual-source draw where the device has the feature). */
  get transmissionBlend(): TransmissionBlend {
    return this.raster.transmissionBlend;
  }
  set transmissionBlend(v: TransmissionBlend) {
    this.setRaster('transmissionBlend', v);
  }
  get depthWrite(): boolean | undefined {
    return this.raster.depthWrite;
  }
  set depthWrite(v: boolean | undefined) {
    this.setRaster('depthWrite', v);
  }
  get depthTest(): boolean {
    return this.raster.depthTest;
  }
  set depthTest(v: boolean) {
    this.setRaster('depthTest', v);
  }
  get alphaToCoverage(): boolean {
    return this.raster.alphaToCoverage;
  }
  set alphaToCoverage(v: boolean) {
    this.setRaster('alphaToCoverage', v);
  }
  get colorWrite(): boolean {
    return this.raster.colorWrite;
  }
  set colorWrite(v: boolean) {
    this.setRaster('colorWrite', v);
  }
  get polygonOffset(): boolean {
    return this.raster.polygonOffset;
  }
  set polygonOffset(v: boolean) {
    this.setRaster('polygonOffset', v);
  }
  get polygonOffsetFactor(): number {
    return this.raster.polygonOffsetFactor;
  }
  set polygonOffsetFactor(v: number) {
    this.setRaster('polygonOffsetFactor', v);
  }
  get polygonOffsetUnits(): number {
    return this.raster.polygonOffsetUnits;
  }
  set polygonOffsetUnits(v: number) {
    this.setRaster('polygonOffsetUnits', v);
  }
  get polygonOffsetClamp(): number {
    return this.raster.polygonOffsetClamp;
  }
  set polygonOffsetClamp(v: number) {
    this.setRaster('polygonOffsetClamp', v);
  }
  get stencilWrite(): boolean {
    return this.raster.stencilWrite;
  }
  set stencilWrite(v: boolean) {
    this.setRaster('stencilWrite', v);
  }
  get stencilRef(): number {
    return this.raster.stencilRef;
  }
  set stencilRef(v: number) {
    this.setRaster('stencilRef', v);
  }
  get stencilReadMask(): number {
    return this.raster.stencilReadMask;
  }
  set stencilReadMask(v: number) {
    this.setRaster('stencilReadMask', v);
  }
  get stencilWriteMask(): number {
    return this.raster.stencilWriteMask;
  }
  set stencilWriteMask(v: number) {
    this.setRaster('stencilWriteMask', v);
  }
  get stencilFunc(): GPUCompareFunction {
    return this.raster.stencilFunc;
  }
  set stencilFunc(v: GPUCompareFunction) {
    this.setRaster('stencilFunc', v);
  }
  get stencilFail(): GPUStencilOperation {
    return this.raster.stencilFail;
  }
  set stencilFail(v: GPUStencilOperation) {
    this.setRaster('stencilFail', v);
  }
  get stencilZFail(): GPUStencilOperation {
    return this.raster.stencilZFail;
  }
  set stencilZFail(v: GPUStencilOperation) {
    this.setRaster('stencilZFail', v);
  }
  get stencilZPass(): GPUStencilOperation {
    return this.raster.stencilZPass;
  }
  set stencilZPass(v: GPUStencilOperation) {
    this.setRaster('stencilZPass', v);
  }
  /** Draws triangle edges instead of filled surfaces (default false), live. */
  get wireframe(): boolean {
    return this.raster.wireframe;
  }
  set wireframe(v: boolean) {
    this.setRaster('wireframe', v);
  }
  private setRaster<K extends keyof Raster>(key: K, v: unknown): void {
    this.raster[key] = rasterChecks[key](v as never, key) as Raster[K];
    renderStates.delete(this);
  }
  /**
   * Base colour, linear RGBA with opacity in [3]: the live array every mesh reads. `color.set(input)` and
   * `color = input` take '#rrggbb', '#rgb', 0xrrggbb (sRGB) or linear [r, g, b] (keeping opacity) or [r, g, b, a];
   * writing elements in place also works.
   */
  get color(): LiveColor {
    return this.rgba;
  }
  set color(v: ColorInput) {
    this.rgba.set(v);
  }
  /** Emissive colour, linear RGB, live like `color`. */
  get emissive(): LiveColor {
    return this.glow;
  }
  set emissive(v: ColorInput) {
    this.glow.set(v);
  }
  /** Face normals instead of interpolated ones (default false), for lit, normal and matcap shading. */
  /** The optional features this material uses, in the order their shader edits apply. Assign a new list to change them (live). */
  get features(): readonly MaterialFeature[] {
    return this.added;
  }
  set features(list: readonly MaterialFeature[]) {
    if (!Array.isArray(list) || list.some((v) => typeof v?.name !== 'string' || typeof v.shader !== 'function'))
      throw new TypeError('Material features must be an array of features; pass entries such as [alphaHash()]');
    if (new Set(list.map((v) => v.name)).size !== list.length)
      throw new TypeError('Material features must have different names; pass each kind of feature once');
    const before = this.added;
    this.added = Object.freeze(list.slice());
    this.addedStamp = changeStamp();
    for (const v of before) if (!list.includes(v)) v.detach?.(this);
    for (const v of list) if (!before.includes(v)) v.attach?.(this);
  }
  get flatShading(): boolean {
    return this.switches.flatShading;
  }
  set flatShading(v: boolean) {
    this.switches.flatShading = flag(v, 'flatShading');
  }
  /** Geometry vertex colours (RGBA) multiply colour and opacity while true (default); instance tints still apply. */
  get vertexColors(): boolean {
    return this.switches.vertexColors;
  }
  set vertexColors(v: boolean) {
    this.switches.vertexColors = flag(v, 'vertexColors');
  }
  /** Scene fog (`@margoengine/environment` Fog) mixes into this lit material while true (default). */
  get fog(): boolean {
    return this.switches.fog;
  }
  set fog(v: boolean) {
    this.switches.fog = flag(v, 'fog');
  }
  /** The display tone map, while true (the default for lit shadings, false for the others, which never tone map). */
  /** A step of per-pixel noise before 8-bit output while true (default false), compiled in only then. Live. */
  get dithering(): boolean {
    return this.switches.dithering;
  }
  set dithering(v: boolean) {
    this.switches.dithering = flag(v, 'dithering');
  }
  get toneMapped(): boolean {
    return this.switches.toneMapped;
  }
  set toneMapped(v: boolean) {
    this.switches.toneMapped = flag(v, 'toneMapped');
  }
  /** Scales `emissive` (default 1, finite, >= 0): the emission drawn is emissive x emissiveMap x emissiveIntensity. */
  get emissiveIntensity(): number {
    return this.glowScale;
  }
  set emissiveIntensity(v: number) {
    if (typeof v !== 'number')
      throw new TypeError('Material emissiveIntensity must be a number; set a finite number >= 0');
    if (!(v >= 0 && Number.isFinite(Math.fround(v))))
      throw new RangeError('Material emissiveIntensity is out of range; set a finite number >= 0');
    this.glowScale = v;
  }
  /** Phong highlight colour, linear RGB, live like `color`. */
  get specular(): LiveColor {
    return this.highlight;
  }
  set specular(v: ColorInput) {
    this.highlight.set(v);
  }
  get depthPacking(): DepthPacking {
    return this.packing;
  }
  set depthPacking(v: DepthPacking) {
    if (v !== 'basic' && v !== 'rgba') throw new TypeError("Invalid material depthPacking; use 'basic' or 'rgba'.");
    this.packing = v;
  }
  get referencePosition(): readonly [number, number, number] {
    return [...this.reference];
  }
  set referencePosition(v: readonly [number, number, number]) {
    if (!Array.isArray(v) || v.length !== 3)
      throw new RangeError('Material referencePosition must have three finite float32 components');
    const x = finiteFloat(v[0], 'referencePosition'),
      y = finiteFloat(v[1], 'referencePosition'),
      z = finiteFloat(v[2], 'referencePosition');
    this.reference = [x, y, z];
  }
  get nearDistance(): number {
    return this.near;
  }
  set nearDistance(v: number) {
    distanceRange(v, this.far);
    this.near = v;
  }
  get farDistance(): number {
    return this.far;
  }
  set farDistance(v: number) {
    distanceRange(this.near, v);
    this.far = v;
  }
  /**
   * Makes this a physical material with `key`'s lobe, on first use: gltf/pbr then draws it with the matching physical
   * shader variant (by pipeline key), while materials that never set a physical option keep the plain one.
   */
  private enable(key: keyof PhysicalOptions): number[] {
    if (this.shading !== 'standard')
      throw new TypeError(`Material ${key} needs standard shading; use PbrMaterial or shading: 'standard'`);
    // `extensions` gains a name only with a capability: the first physical option, a thin-film or anisotropy lobe,
    // transmission. Other live edits of a physical material leave it as constructed (exporters read it).
    const self = this as { physical?: number[]; ext?: number[]; volume?: number[] },
      list = this.extensions as string[],
      add = (name: string) => list.includes(name) || list.push(name),
      name = extensions[key];
    if (!self.physical) add(name);
    const physical = (self.physical ??= [0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0]);
    self.ext ??= [0, 1.5, 0, 0];
    if (name === 'anisotropy' || name === 'iridescence' || name === 'diffuse_roughness') {
      if (physical.length <= 12) physical.push(0, 1.3, 100, 400, 0, 1, 0, 0, 0, 1, 1, 1);
      add(name);
    }
    if (!this.volume && (key === 'transmission' || key === 'transmissionMap' || key === 'thicknessMap')) {
      self.volume = [0, 1, 1, 1];
      add(name);
      add('transmission');
    }
    if (mapped(this)) while (this.uvt.length < 17 * 8) this.uvt.push(...this.uvDefault);
    return physical;
  }
  private set(i: number, v: number, label: keyof PhysicalOptions): void {
    const x = unit(v, label);
    this.enable(label)[i] = x;
  }
  private setColor(i: number, c: ColorInput, label: keyof PhysicalOptions): void {
    const v = linear(c, label);
    for (let k = 0; k < 3; k++) this.set(i + k, v[k], label);
  }
  private setVolume(i: number, v: number, label: 'thickness' | 'attenuationColor' | 'attenuationDistance'): void {
    if (!this.volume)
      throw new TypeError(
        `Material ${label} is part of transmission; set transmission (or a transmission or thickness map) first`,
      );
    if (!(v >= 0 && (v < Infinity || i === 4))) throw new RangeError(`Material ${label} must be a finite number >= 0`);
    if (i === 0) finiteFloat(v, label);
    if (i) this.attenuation[i - 1] = v;
    else this.volume[0] = v;
    const [r, g, b, d] = this.attenuation;
    this.volume[1] = attenuationPower(r, 1 / d);
    this.volume[2] = attenuationPower(g, 1 / d);
    this.volume[3] = attenuationPower(b, 1 / d);
  }
  get clearcoat(): number {
    return this.physical?.[0] ?? 0;
  }
  set clearcoat(v: number) {
    this.set(0, v, 'clearcoat');
  }
  get clearcoatRoughness(): number {
    return this.physical?.[1] ?? 0;
  }
  set clearcoatRoughness(v: number) {
    this.set(1, v, 'clearcoatRoughness');
  }
  get clearcoatNormalScale(): number {
    return this.physical?.[2] ?? 1;
  }
  set clearcoatNormalScale(v: number) {
    this.enable('clearcoatNormalScale')[2] = finiteFloat(v, 'clearcoatNormalScale');
  }
  get anisotropy(): number {
    return this.physical?.[16] ?? 0;
  }
  set anisotropy(v: number) {
    this.set(16, v, 'anisotropy');
  }
  get anisotropyRotation(): number {
    return this.rotation;
  }
  set anisotropyRotation(v: number) {
    if (!Number.isFinite(v)) throw new RangeError('Invalid anisotropyRotation; set a finite angle in radians.');
    const p = this.enable('anisotropyRotation');
    this.rotation = v;
    p[17] = Math.cos(v);
    p[18] = Math.sin(v);
  }
  get diffuseRoughness(): number {
    return this.physical?.[19] ?? 0;
  }
  set diffuseRoughness(v: number) {
    this.set(19, v, 'diffuseRoughness');
  }
  get diffuseRoughnessMap(): Texture | null {
    return this.physicalTextures[12] ?? null; // snapshots taken before this slot hold 12
  }
  set diffuseRoughnessMap(v: Texture | null) {
    this.setMap(12, v);
  }
  get iridescence(): number {
    return this.physical?.[12] ?? 0;
  }
  set iridescence(v: number) {
    this.set(12, v, 'iridescence');
  }
  get iridescenceIOR(): number {
    return this.physical?.[13] ?? 1.3;
  }
  set iridescenceIOR(v: number) {
    this.enable('iridescenceIOR')[13] = finiteFloat(v, 'iridescenceIOR', 1);
  }
  get iridescenceThicknessRange(): readonly [number, number] {
    return [this.physical?.[14] ?? 100, this.physical?.[15] ?? 400];
  }
  set iridescenceThicknessRange(v: readonly [number, number]) {
    if (!Array.isArray(v) || v.length !== 2)
      throw new RangeError('Material iridescenceThicknessRange must be [min, max] nanometres');
    // KHR_materials_iridescence: the minimum MAY be greater than the maximum (the map then runs thick to thin).
    finiteFloat(v[0], 'iridescenceThicknessRange', 0);
    finiteFloat(v[1], 'iridescenceThicknessRange', 0);
    const p = this.enable('iridescenceThicknessRange');
    p[14] = v[0];
    p[15] = v[1];
  }
  get transmission(): number {
    return this.physical?.[3] ?? 0;
  }
  set transmission(v: number) {
    this.set(3, v, 'transmission');
  }
  get specularColor(): number[] {
    return this.physical?.slice(4, 7) ?? [1, 1, 1];
  }
  /** KHR_materials_specular allows components above 1 (F0 past what the IOR gives); the shader clamps F0 to 1. */
  set specularColor(c: ColorInput) {
    const v = linear(c, 'specularColor', Infinity),
      p = this.enable('specularColor');
    for (let k = 0; k < 3; k++) p[4 + k] = v[k];
  }
  get specularIntensity(): number {
    return this.physical?.[7] ?? 1;
  }
  set specularIntensity(v: number) {
    this.set(7, v, 'specularIntensity');
  }
  get sheenColor(): number[] {
    return this.physical?.slice(8, 11) ?? [0, 0, 0];
  }
  set sheenColor(c: ColorInput) {
    this.setColor(8, c, 'sheenColor');
  }
  get sheenRoughness(): number {
    return this.physical?.[11] ?? 0;
  }
  set sheenRoughness(v: number) {
    this.set(11, v, 'sheenRoughness');
  }
  get ior(): number {
    return this.ext?.[1] ?? 1.5;
  }
  set ior(v: number) {
    // KHR_materials_ior: 0 switches to the specular-glossiness mode for good; "updates of it MUST be ignored".
    if (this.ext?.[1] === 0 && this.extensions.includes('ior')) return;
    if (v !== 0) finiteFloat(v, 'ior', 1);
    this.enable('ior');
    this.ext![1] = v;
  }
  get dispersion(): number {
    return this.ext?.[3] ?? 0;
  }
  set dispersion(v: number) {
    if (typeof v !== 'number' || !Number.isFinite(Math.fround(v)) || v < 0)
      throw new RangeError('Material dispersion must be a finite number >= 0');
    this.enable('dispersion');
    this.ext![3] = v;
  }
  get thickness(): number {
    return this.volume?.[0] ?? 0;
  }
  set thickness(v: number) {
    this.setVolume(0, v, 'thickness');
  }
  get attenuationColor(): number[] {
    return this.attenuation.slice(0, 3);
  }
  set attenuationColor(c: ColorInput) {
    const v = linear(c, 'attenuationColor');
    for (let k = 0; k < 3; k++) this.setVolume(k + 1, v[k], 'attenuationColor');
  }
  get attenuationDistance(): number {
    return this.attenuation[3];
  }
  set attenuationDistance(v: number) {
    if (!(v > 0)) throw new RangeError('Material attenuationDistance must be > 0');
    this.setVolume(4, v, 'attenuationDistance');
  }
  get transmissive(): boolean {
    return !!this.volume;
  }
  /** @internal gltf\/pbr's tinted-blend constant when no transmission pass refracts: color x transmission x volume attenuation. */
  get tint(): number[] | undefined {
    if (!this.volume) return undefined;
    for (let k = 0; k < 3; k++)
      this.tinted[k] = this.color[k] * this.physical![3] * this.volume[k + 1] ** this.volume[0];
    return this.tinted;
  }
  get roughness(): number {
    return this.factors[0];
  }
  set roughness(v: number) {
    this.factors[0] = unit(v, 'roughness');
  }
  get metalness(): number {
    return this.factors[1];
  }
  set metalness(v: number) {
    this.factors[1] = unit(v, 'metalness');
  }
  get normalScale(): number {
    return this.factors[2];
  }
  set normalScale(v: number) {
    this.factors[2] = finiteFloat(v, 'normalScale');
  }
  get aoMapIntensity(): number {
    return this.factors[3];
  }
  set aoMapIntensity(v: number) {
    this.factors[3] = unit(v, 'aoMapIntensity');
  }
  /** Toon's band count without a gradientMap, an integer 2 through 256 (default 3); band k of n is k / (n - 1). */
  get steps(): number {
    return this.toonSteps;
  }
  set steps(v: number) {
    if (typeof v !== 'number') throw new TypeError('Material steps must be a number; set an integer 2 through 256');
    if (!Number.isInteger(v) || v < 2 || v > 256)
      throw new RangeError('Material steps is out of range; set an integer 2 through 256');
    this.toonSteps = v;
  }
  /** Toon's ramp texture, or null for `steps` bands. */
  get gradientMap(): Texture | null {
    return this.toonMap;
  }
  set gradientMap(v: Texture | null) {
    if (v != null && !(v instanceof Texture))
      throw new TypeError('Material gradientMap must be a Texture; pass a Texture or null');
    if (v != null && this.shading !== 'toon')
      throw new TypeError("Material gradientMap needs toon shading; set shading: 'toon'");
    this.toonMap = v ?? null;
  }
  /** The environment map, or null (default): see `MaterialOptions.envMap`. */
  get envMap(): EnvMapSource | null {
    return this.env.map;
  }
  set envMap(v: EnvMapSource | null) {
    if (v != null && !['standard', 'basic', 'lambert', 'phong'].includes(this.shading))
      throw new TypeError(`Material envMap needs standard, basic, lambert or phong shading, not '${this.shading}'`);
    const map = v == null ? null : envSource(v);
    this.env.map = map;
    // A Texture, an Environment and a CubeCamera are live objects; the rest belongs to one device.
    this.env.slot =
      map && (typeof map === 'function' || gpuTexture(map) || isOptionObject(map))
        ? borrow(map, 'Material envMap', 'set material.envMap')
        : null;
  }
  /** Scales the envMap's light, finite and >= 0 (default 1). */
  get envMapIntensity(): number {
    return this.env.intensity;
  }
  set envMapIntensity(v: number) {
    if (typeof v !== 'number' || !(v >= 0 && Number.isFinite(Math.fround(v))))
      throw new RangeError('Material envMapIntensity must be a finite number >= 0; set one (default 1)');
    this.env.intensity = v;
  }
  /** Turns the envMap about +Y, in radians (default 0). */
  get envMapRotation(): number {
    return this.env.rotation;
  }
  set envMapRotation(v: number) {
    this.env.rotation = finiteFloat(v, 'envMapRotation');
  }
  /** Samples the envMap along the mirrored (`'reflection'`, default) or bent (`'refraction'`) view ray. */
  get envMapMode(): 'reflection' | 'refraction' {
    return this.env.mode;
  }
  set envMapMode(v: 'reflection' | 'refraction') {
    this.env.mode = oneOf(['reflection', 'refraction'], "'reflection' or 'refraction'")(v, 'envMapMode') as
      | 'reflection'
      | 'refraction';
  }
  /** The ratio of indices of refraction for `envMapMode: 'refraction'`, finite and > 0 (default 1/1.5: air into crown glass). */
  get refractionRatio(): number {
    return this.env.ratio;
  }
  set refractionRatio(v: number) {
    if (typeof v !== 'number' || !(v > 0 && Number.isFinite(Math.fround(v))))
      throw new RangeError(
        'Material refractionRatio must be a finite number > 0; set one (default 1/1.5, air into glass)',
      );
    this.env.ratio = v;
  }
  /** Basic, Lambert and Phong: how the reflection meets the colour (default 'multiply'). */
  get combine(): EnvCombine {
    return this.env.combine;
  }
  set combine(v: EnvCombine) {
    this.env.combine = oneOf(['multiply', 'mix', 'add'], "'multiply', 'mix' or 'add'")(v, 'combine') as EnvCombine;
  }
  /** Basic, Lambert and Phong: the reflection's weight, 0 through 1 (default 1). */
  get reflectivity(): number {
    return this.env.reflectivity;
  }
  set reflectivity(v: number) {
    this.env.reflectivity = unit(v, 'reflectivity');
  }
  /** Phong's Blinn-Phong exponent, finite and >= 0: higher is a smaller, sharper highlight. */
  get shininess(): number {
    return this.gloss;
  }
  set shininess(v: number) {
    this.gloss = finiteFloat(v, 'shininess', 0);
  }
  get opacity(): number {
    return this.color[3];
  }
  set opacity(v: number) {
    this.color[3] = unit(v, 'opacity');
  }
  get alphaTest(): number {
    return this.settings[1];
  }
  set alphaTest(v: number) {
    this.settings[1] = unit(v, 'alphaTest');
    this.sync();
  }
  get transparent(): boolean {
    return this.blend;
  }
  set transparent(v: boolean) {
    this.blend = !!v;
    this.sync();
  }
  get side(): MaterialSide {
    return this.settings[2] === 1 ? 'double' : this.settings[2] === 2 ? 'back' : 'front';
  }
  set side(v: MaterialSide) {
    if (!['front', 'back', 'double'].includes(v))
      throw new TypeError("Invalid material side; use 'front', 'back' or 'double'.");
    this.settings[2] = v === 'double' ? 1 : v === 'back' ? 2 : 0;
  }
  get doubleSided(): boolean {
    return this.settings[2] === 1;
  }
  set doubleSided(v: boolean) {
    this.settings[2] = +!!v;
  }
  /**
   * Live: sets one map slot's UV transform, or every slot's without `slot` (but `lightMap`'s, which stays on its own
   * UV set); null restores the identity (UV1 for `lightMap`, unless the transform names a `texCoord`).
   */
  setUVTransform(
    transformWithCenter: MaterialUVTransform | null,
    slot?: MapSlot | (typeof featureMaps)[number] | (typeof surfaceMaps)[number],
  ): this {
    const t = foldCenter(transformWithCenter),
      f = featureMaps.indexOf(slot as (typeof featureMaps)[number]),
      g = surfaceMaps.indexOf(slot as (typeof surfaceMaps)[number]),
      i = slot === undefined || f >= 0 || g >= 0 ? -1 : mapSlots.indexOf(slot as MapSlot);
    if (slot !== undefined && f < 0 && g < 0 && i < 0)
      throw new TypeError('Invalid UV transform slot; pass a map name such as map or normalMap, or omit it.');
    const transform: TextureTransform = f === 3 ? { texCoord: 1, ...t } : (t ?? {}),
      { texCoord } = textureCoordinates({ extensions: { KHR_texture_transform: transform } });
    if (texCoord > 1) throw new RangeError('Material meshes have two UV sets; pass texCoord 0 or 1.');
    const rows = textureTransform(transform, texCoord);
    if (f >= 0) {
      this.featureValues.splice(4 + f * 8, 8, ...rows);
      return this;
    }
    if (g >= 0) {
      this.surfaceValues.splice(4 + g * 24, 8, ...rows);
      return this;
    }
    if (i < 0) {
      this.uvDefault = rows;
      for (let k = 0; k < 3; k++) this.featureValues.splice(4 + k * 8, 8, ...rows);
      for (let k = 0; k < 2; k++) this.surfaceValues.splice(4 + k * 24, 8, ...rows);
    }
    while (this.uvt.length < Math.max(40, (i + 1) * 8)) this.uvt.push(...this.uvDefault);
    for (let k = 0; k < this.uvt.length / 8; k++) if (i < 0 || k === i) this.uvt.splice(k * 8, 8, ...rows);
    return this;
  }
  /** True when the beauty pipeline needs explicit render controls. */
  get customState(): boolean {
    return (
      this.blending !== 'normal' ||
      this.blendSpace !== 'display' ||
      this.transmissionBlend !== 'auto' ||
      this.depthWrite !== undefined ||
      !this.depthTest ||
      !this.colorWrite ||
      this.alphaToCoverage ||
      this.polygonOffset ||
      this.stencilWrite
    );
  }
  private sync(): void {
    this.settings[0] = this.blend ? 2 : this.settings[1] > 0 ? 1 : 0;
  }
  /**
   * A new material of the same class with this one's values; it shares the textures (and a NodeMaterial's nodes) and
   * nothing else, so editing either leaves the other alone.
   */
  clone(): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    for (const [key, value] of Object.entries(this)) (c as Record<string, unknown>)[key] = duplicate(value);
    Object.assign(c, {
      rgba: liveColor(this.rgba.slice(), 'color'),
      glow: liveColor(this.glow.slice(), 'emissive'),
      highlight: liveColor(this.highlight.slice(), 'specular'),
    });
    // The clone joins each feature as a material of its own: a feature that counts or marks its materials (an eye's
    // buffers, alphaHash's raised alphaTest) would otherwise free or undo for the original when the clone leaves it.
    for (const v of c.added) joined(v, c, this);
    return c;
  }
  /**
   * Copies every Material value of `source` (same shading) into this material in place, textures shared: meshes using
   * this material show them next frame. Fields a subclass adds (a NodeMaterial's nodes) stay this material's.
   */
  copy(source: Material): this {
    usable(this);
    if (!(source instanceof Material)) throw new TypeError('Material copy needs a source Material; pass one');
    if (source.shading !== this.shading)
      throw new TypeError(
        `Material copy needs the same shading ('${this.shading}', not '${source.shading}'); clone() the source instead`,
      );
    const before = this.added;
    // Features this material leaves let go of it first (their undo is then overwritten by source's values below).
    for (const v of before) if (!source.added.includes(v)) v.detach?.(this);
    const to = this as unknown as Record<string, unknown>,
      from = source as unknown as Record<string, unknown>;
    for (const key of (baseKeys ??= Object.keys(new Material()))) {
      const a = to[key],
        b = from[key];
      // Arrays copy into the existing ones: live colours and gltf/pbr rows keep their identity. The feature list is
      // frozen (it is replaced, never edited) and takes source's list.
      if (key === 'added') to[key] = Object.freeze((b as MaterialFeature[]).slice());
      else if (Array.isArray(a) && Array.isArray(b)) a.splice(0, a.length, ...b);
      else to[key] = duplicate(b);
    }
    for (const v of this.added) if (!before.includes(v) || v.captureState) joined(v, this, source);
    renderStates.delete(this);
    return this;
  }
  /**
   * Frees what this material owns that no live mesh uses (uniform buffers it made outside a mesh); meshes still
   * drawing it keep theirs until they go. Afterwards `createMesh` and `mesh.material = ` refuse it (MargoError
   * 'disposed'); `clone()` still works. Textures stay the caller's.
   */
  dispose(): void {
    disposedMaterials.add(this);
    const states = mapStates.get(this);
    this.changes = changeStamp();
    for (const [owner, state] of states ?? [])
      if (!state.refs) {
        state.buffer?.destroy();
        state.features?.destroy();
        state.surface?.destroy();
        state.env?.destroy();
        state.clip?.destroy();
        unwatchUniforms(state);
        states!.delete(owner);
      }
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** gltf\/pbr beauty shader patch; subclasses (such as `@margoengine/shader`'s NodeMaterial) may extend it. */
  shader(source: string, group: number): string {
    if (mapped(this)) return physicalMapsShader(source, group, mapPlan(this).slots);
    if (bare(this)) return bareShader(source);
    return materialShader(source, group, this.shading);
  }
  /**
   * @internal What depth passes draw in place of the displacement map, for a subclass that moves vertices its own way.
   * `map` is this material's own `displacementMap` record, when it has one, for a subclass that moves on top of it.
   */
  caster(
    _device: GPUDevice,
    _engine?: Engine,
    _map?: CasterDisplacement,
    _data?: MaterialMeshData,
  ): CasterDisplacement | undefined {
    return undefined;
  }
  /**
   * @internal What this material reads of a mesh's `geometry` beyond the packed vertex (NodeMaterial's `attribute()`),
   * held per mesh and passed back to `bindings` and `caster`; undefined for none. Throws when the geometry lacks it.
   */
  meshData(_geometry: MeshGeometry): MaterialMeshData | undefined {
    return undefined;
  }
  /** @internal A subclass's edit of `code` once the scene's lighting effects are composed into it. */
  relight(code: string): string {
    return code;
  }
  /** @internal gltf\/pbr LightingEffect bindings for one device; `engine` draws, `_data` is the mesh's `meshData`. */
  bindings(device: GPUDevice, engine?: Engine, _data?: MaterialMeshData): GPUBindGroupEntry[] {
    if (mapped(this)) {
      const plan = mapPlan(this),
        rows = this.diffuseRoughnessMap ? 18 : 17,
        buffer = materialBuffer(this, device, engine ?? device, rows * 32 + 16);
      const values = new Float32Array(rows * 8 + 4);
      for (let k = 0; k < rows; k++)
        values.set(this.uvt.length > k * 8 ? this.uvt.slice(k * 8, k * 8 + 8) : this.uvDefault, k * 8);
      values.set(this.volume ?? [0, 1, 1, 1], rows * 8);
      device.queue.writeBuffer(buffer, 0, values);
      const entries: GPUBindGroupEntry[] = [{ binding: 200, resource: { buffer } }];
      // One sampler per texture: it repeats under triplanar when any UV0 slot reads the texture.
      const tiled = (texture: Texture) =>
        mapSlots.some(
          (k, i) =>
            this[k] === texture &&
            projected(this, this.uvt.length > i * 8 ? this.uvt : this.uvDefault, this.uvt.length > i * 8 ? i * 8 : 0),
        );
      const bound = plan.textures.map(({ texture, srgb, fallback: role }) => {
        const pair = texture.sampled(device, srgb, 'map', tiled(texture));
        if (pair) return pair;
        return fallback(device, role);
      });
      bound.forEach((pair, i) => entries.push({ binding: 201 + i, resource: pair[0] }));
      plan.samplers.forEach((texture, i) =>
        entries.push({ binding: 240 + i, resource: bound[plan.textures.findIndex((t) => t.texture === texture)][1] }),
      );
      return entries;
    }
    const d = defaults(device),
      entries: GPUBindGroupEntry[] = [];
    if (bare(this)) return entries;
    for (let i = 0; i < (this.shading === 'matcap' ? 6 : 5); i++) {
      const texture = this[slots[i]],
        // The matcap is read by the view normal, never by the UVs.
        tile =
          i < 5 &&
          projected(this, this.uvt.length > i * 8 ? this.uvt : this.uvDefault, this.uvt.length > i * 8 ? i * 8 : 0),
        bound = texture?.sampled(device, i === 0 || i >= 4, slots[i], tile) ?? [
          i === 2 ? d.normal : d.white,
          d.sampler,
        ];
      entries.push({ binding: 32 + i * 2, resource: bound[0] }, { binding: 33 + i * 2, resource: bound[1] });
    }
    if (this.shading === 'depth' || this.shading === 'distance') {
      const owner = engine ?? device,
        state = mapState(this, owner),
        buffer = materialBuffer(this, device, owner, 32),
        values = (state.values ??= new Float32Array(8));
      values.set(this.reference, 0);
      values[4] = this.near;
      values[5] = this.far;
      values[6] = +(this.packing === 'rgba');
      device.queue.writeBuffer(buffer, 0, values);
      entries.push({ binding: 196, resource: { buffer } });
    }
    if (this.shading === 'toon') {
      const owner = engine ?? device,
        state = mapState(this, owner),
        buffer = materialBuffer(this, device, owner, 16),
        values = (state.values ??= new Float32Array(4)),
        [view, sampler] = this.toonMap?.sampled(device, false, 'gradientMap') ?? fallback(device, 0);
      values.set([+!!this.toonMap, this.toonSteps, 0, 0]);
      device.queue.writeBuffer(buffer, 0, values);
      entries.push(
        { binding: 191, resource: { buffer } },
        { binding: 192, resource: view },
        { binding: 193, resource: sampler },
      );
    }
    if (this.shading === 'phong') {
      const owner = engine ?? device,
        state = mapState(this, owner),
        buffer = materialBuffer(this, device, owner, 16),
        values = (state.values ??= new Float32Array(4));
      values.set(this.specular, 0);
      values[3] = this.gloss;
      device.queue.writeBuffer(buffer, 0, values);
      entries.push({ binding: 197, resource: { buffer } });
    }
    return entries;
  }
}

/** Any CPU geometry with a bottom-left UV origin (v increases up the image); `@margoengine/geometry` output fits directly. Colors are RGB or RGBA: floats 0-1, or a Uint8Array (0-255) or Uint16Array (0-65535), normalised as glTF's COLOR_0. */
export interface MeshGeometry {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  /** Independent UV1 coordinates. Omitted UV1 duplicates UV0 for compatibility. */
  uvs1?: ArrayLike<number>;
  indices?: ArrayLike<number>;
  tangents?: ArrayLike<number>;
  colors?: ArrayLike<number>;
  /** Triangle ranges in index units (vertex units without indices). Used with a material array. */
  groups?: readonly { start: number; count: number; materialIndex: number }[];
  /**
   * Your own per-vertex values by name, read by a node material's `attribute(name, type)` (`@margoengine/shader`).
   * `setGeometry` uploads them again, a ranged one only its vertices. A bare array is one `f32` per vertex, as the
   * loaders give their extra scalars (PCD `intensity`, VTK point scalars, COLLADA channels).
   */
  attributes?: Readonly<Record<string, VertexAttribute | ArrayLike<number>>>;
}
/** The WGSL type of a per-vertex attribute: one to four 32-bit floats, signed or unsigned integers. */
export type VertexAttributeType =
  | 'f32'
  | 'vec2f'
  | 'vec3f'
  | 'vec4f'
  | 'i32'
  | 'vec2i'
  | 'vec3i'
  | 'vec4i'
  | 'u32'
  | 'vec2u'
  | 'vec3u'
  | 'vec4u';
/** One named per-vertex attribute: `data` holds one `type` value per vertex, component after component. */
export interface VertexAttribute {
  data: ArrayLike<number>;
  type: VertexAttributeType;
}
/** What a material holds for one mesh it draws (`Material.meshData`). */
export interface MaterialMeshData {
  /**
   * Checks `geometry` (all its vertices, or `range`) and returns the commit that takes it; throws, changing nothing,
   * when it does not fit.
   */
  prepare(geometry: MeshGeometry, range?: GeometryRange): () => void;
  /** Releases the GPU buffers: the mesh was disposed or draws another material. */
  dispose(): void;
}
const packed = new WeakMap<object, PreparedGeometry>();
/** Packs once per geometry object into gltf/pbr's 80-byte vertex (position, normal, tangent, UV0, UV1, color). Later edits to the object are not seen; `mesh.setGeometry` repacks. */
export function packGeometry(g: MeshGeometry): PreparedGeometry {
  let out = packed.get(g);
  if (!out) packed.set(g, (out = pack(g)));
  return out;
}
function vertexCount(g: MeshGeometry): number {
  const { positions: p, normals: n, uvs, uvs1, tangents: t, colors: c } = g ?? ({} as MeshGeometry),
    count = p?.length / 3,
    width = c ? c.length / count : 0;
  if (
    !Number.isInteger(count) ||
    count < 3 ||
    count > 1_000_000 ||
    n?.length !== count * 3 ||
    (uvs && uvs.length !== count * 2) ||
    (uvs1 && uvs1.length !== count * 2) ||
    (t && t.length !== count * 4) ||
    (c && width !== 3 && width !== 4)
  )
    throw new RangeError(
      'Mesh geometry attributes do not match; give 3 to 1,000,000 vertices, each with a normal, and size the other attributes to match.',
    );
  return count;
}
/** Packed vertices `from` to `to` (exclusive) of validated geometry, in a new array. */
function packVertices(g: MeshGeometry, from: number, to: number): Float32Array {
  const { positions: p, normals: n, uvs, uvs1, tangents: t, colors: c } = g,
    width = c ? c.length / (p.length / 3) : 0,
    // glTF COLOR_n is float, or unsigned byte or short normalised: integer arrays map their full range to 0-1.
    scale =
      c instanceof Uint8Array || c instanceof Uint8ClampedArray ? 1 / 255 : c instanceof Uint16Array ? 1 / 65535 : 1;
  const v = new Float32Array((to - from) * 20);
  for (let i = from, o = 0; i < to; i++, o += 20) {
    const length = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]),
      tl = t ? Math.hypot(t[i * 4], t[i * 4 + 1], t[i * 4 + 2]) : 0;
    if (!length) throw new RangeError('Mesh normals must be non-zero');
    // A NaN tangent has no length and would pass as "no tangent"; zeros are the way to give none.
    if (t && (Number.isNaN(tl) || Number.isNaN(t[i * 4 + 3])))
      throw new RangeError('Mesh geometry attributes must be finite; remove NaN and Infinity values.');
    for (let k = 0; k < 3; k++) {
      v[o + k] = p[i * 3 + k];
      v[o + 4 + k] = n[i * 3 + k] / length;
      if (tl) v[o + 8 + k] = t![i * 4 + k] / tl;
    }
    v[o + 3] = 1;
    if (tl) v[o + 11] = t![i * 4 + 3] < 0 ? -1 : 1;
    if (uvs) {
      v[o + 12] = uvs[i * 2];
      v[o + 13] = uvs[i * 2 + 1];
    }
    const second = uvs1 ?? uvs;
    if (second) {
      v[o + 14] = second[i * 2];
      v[o + 15] = second[i * 2 + 1];
    }
    for (let k = 0; k < 4; k++) v[o + 16 + k] = c && k < width ? c[i * width + k] * scale : 1;
  }
  if (v.some((value) => !Number.isFinite(value)))
    throw new RangeError('Mesh geometry attributes must be finite; remove NaN and Infinity values.');
  return v;
}
function pack(g: MeshGeometry): PreparedGeometry {
  const count = vertexCount(g),
    v = packVertices(g, 0, count);
  const indexCount = g.indices?.length ?? count;
  if (!Number.isSafeInteger(indexCount) || indexCount < 3 || indexCount % 3)
    throw new RangeError('Mesh indices must contain complete triangles');
  if (g.indices)
    for (let i = 0; i < indexCount; i++)
      if (!Number.isSafeInteger(g.indices[i]) || g.indices[i] < 0 || g.indices[i] >= count)
        throw new RangeError(
          'Mesh geometry index is out of range; use whole numbers from 0 to the vertex count minus 1.',
        );
  return {
    vertices: v,
    indices: g.indices ? Uint32Array.from(g.indices) : Uint32Array.from({ length: count }, (_, i) => i),
  };
}
type Group = { start: number; count: number; materialIndex: number };
/** The validated triangle groups `createMesh` turns into primitives, in primitive order. */
function meshGroups(geometry: MeshGeometry, indexCount: number, materials: readonly Material[], array: boolean) {
  const groups: readonly Group[] | undefined = array
    ? geometry.groups
    : [{ start: 0, count: indexCount, materialIndex: 0 }];
  if (!Array.isArray(groups) || !groups.length) throw new RangeError('Material arrays require geometry groups');
  for (const g of groups)
    if (
      !g ||
      !Number.isSafeInteger(g.start) ||
      !Number.isSafeInteger(g.count) ||
      !Number.isSafeInteger(g.materialIndex) ||
      g.start < 0 ||
      g.count <= 0 ||
      g.start % 3 ||
      g.count % 3 ||
      g.start + g.count > indexCount ||
      g.materialIndex < 0 ||
      g.materialIndex >= materials.length
    )
      throw new RangeError(
        'Mesh geometry group is invalid; use a start and count that are multiples of 3 within the indices, and an existing materialIndex.',
      );
  const ranges = [...groups].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i].start < ranges[i - 1].start + ranges[i - 1].count)
      throw new RangeError('Mesh geometry groups must not overlap');
  return groups;
}
const groupIndices = (indices: Uint32Array, g: Group) =>
  g.start === 0 && g.count === indices.length ? indices : indices.slice(g.start, g.start + g.count);
/** Vertex range of a `setGeometry` update: `count` vertices from vertex `start`. */
export interface GeometryRange {
  start: number;
  count: number;
}
interface Entry {
  model: PBRModel;
  /** The material each primitive draws with, in primitive order. */
  materials: Material[];
  order: number;
  opaque: boolean;
  blend: boolean;
  /** Squared camera distance this frame, for the late phase's back-to-front sort. */
  distance: number;
  /** The mesh's `sceneSurfaces`: it joins its scene's surface hooks (scene-surfaces.ts). */
  surfaces: boolean;
}
interface Phase {
  entry: Entry;
  /** The entry's model, read once per draw without going through the entry. */
  model: PBRModel;
  blend: boolean;
  phase: 'all' | 'opaque' | 'blend';
}
const blends: Record<Blending, GPUBlendState | null | undefined> = {
  normal: undefined,
  none: null,
  additive: { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } },
  multiply: { color: { srcFactor: 'zero', dstFactor: 'src' }, alpha: { srcFactor: 'zero', dstFactor: 'src-alpha' } },
};
/** How a phase of the material draw queue orders meshes (PlayCanvas layer sort modes): `manual` is `renderOrder` alone. */
export type MaterialSortMode = 'manual' | 'front-to-back' | 'back-to-front';
/** Sort modes of the material draw queue; each falls back to its default when left out. */
export interface MaterialSortModes {
  /** Opaque meshes. Default `'manual'`; `'front-to-back'` cuts overdraw on pixel-heavy scenes. */
  opaque?: MaterialSortMode;
  /** Transparent meshes. Default `'back-to-front'`. */
  transparent?: MaterialSortMode;
}
interface MaterialDraws {
  sortModes: { opaque: MaterialSortMode; transparent: MaterialSortMode };
  add(entry: Entry): void;
  delete(entry: Entry): void;
  /** Re-sorts on the next frame (a render order changed). */
  reorder(): void;
}
const modes = new WeakMap<Engine['frameGraph'], MaterialDraws['sortModes']>();
/** @internal The engine's material sort modes (`setMaterialSortModes`), read live by `BatchedMesh` item sorting. */
export function sortSettings(graph: Engine['frameGraph']): MaterialDraws['sortModes'] {
  let m = modes.get(graph);
  if (!m) modes.set(graph, (m = { opaque: 'manual', transparent: 'back-to-front' }));
  return m;
}
/**
 * Sets how this engine's material meshes (plain, instanced and batched) are ordered for drawing, live and for every
 * mesh: `opaque` (default `'manual'`) and `transparent` (default `'back-to-front'`) each take `'manual'` (by
 * `mesh.renderOrder` alone), `'front-to-back'` or `'back-to-front'` (by `renderOrder`, then by squared distance from the
 * camera to the mesh origin). Leave a field out to keep it; pass `{}` to change nothing.
 * @example
 * setMaterialSortModes(engine, { opaque: 'front-to-back' }); // less overdraw on pixel-heavy scenes
 */
export function setMaterialSortModes(engine: EngineKernel, next: MaterialSortModes): void {
  const ok = (v: unknown) => v === undefined || v === 'manual' || v === 'front-to-back' || v === 'back-to-front';
  if (!next || !ok(next.opaque) || !ok(next.transparent))
    throw new TypeError("Material sort modes take 'manual', 'front-to-back' or 'back-to-front'; pass one of those");
  const m = sortSettings(engineRuntime(engine).frameGraph);
  if (next.opaque) m.opaque = next.opaque;
  if (next.transparent) m.transparent = next.transparent;
}
const queues = new WeakMap<Engine['frameGraph'], MaterialDraws>(),
  late = (m: Material) => m.transparent || m.transmissive;
function lateEntry(entry: Entry, index: number): boolean {
  return late(entry.materials[index]) || primitiveAfterOpaque(entry.model.primitives[index]);
}
/** Bit 1: some slot of the mesh draws in the opaque phase; bit 2: some slot draws in the blend phase. No allocation: it runs for every mesh every frame. */
function lateFlags(entry: Entry): number {
  let flags = 0;
  for (let i = 0; i < entry.materials.length; i++) flags |= lateEntry(entry, i) ? 2 : 1;
  return flags;
}
let serial = 0;
/** One pass per engine draws every material mesh: opaque then transparent, each by renderOrder; transparent meshes back to front. */
function queue(runtime: Engine): MaterialDraws {
  const graph = runtime.frameGraph;
  let draws = queues.get(graph);
  if (draws) return draws;
  const members: Entry[] = [],
    tail: Phase[] = [],
    sortModes = sortSettings(graph),
    name = 'materials:' + serial++,
    // One run, reused every frame: it keeps its batch records (gltf/pbr draw-batch.ts) instead of making new ones.
    run = new PBRDrawRun(),
    surfaces = new SceneSurfaces(runtime);
  /** Joins or leaves the scene's surface hooks (wet ground, snow) before the entry draws: lit meshes only. */
  const join = (entry: Entry) => surfaces.sync(entry.model, entry.surfaces && entry.materials.some(litMaterial));
  // Each arrange() makes a new list, so a loop that is drawing one keeps it while a draw re-arranges the queue.
  let phases: Phase[] = [],
    opaqueEnd = 0,
    arranged = false,
    running = false,
    epoch = 0;
  /** True when the entry's slots still draw in the phases it was arranged into. */
  const current = (entry: Entry): boolean => {
    const flags = lateFlags(entry);
    return ((flags & 1) !== 0) === entry.opaque && ((flags & 2) !== 0) === entry.blend;
  };
  // Opaque order is stable until membership or a transparent flag changes. Distance sorts only the late phase.
  const arrange = () => {
    const next: Phase[] = [];
    for (let i = 0; i < members.length; i++) {
      const entry = members[i],
        flags = lateFlags(entry),
        opaque = (flags & 1) !== 0,
        blend = (flags & 2) !== 0;
      entry.opaque = opaque;
      entry.blend = blend;
      if (opaque) next.push({ entry, model: entry.model, blend: false, phase: blend ? 'opaque' : 'all' });
      if (blend) next.push({ entry, model: entry.model, blend: true, phase: opaque ? 'blend' : 'all' });
    }
    next.sort((a, b) => +a.blend - +b.blend || a.entry.order - b.entry.order);
    opaqueEnd = 0;
    while (opaqueEnd < next.length && !next[opaqueEnd].blend) opaqueEnd++;
    phases = next;
    arranged = true;
    epoch++;
  };
  /** Sorts phases[from, to) by renderOrder, then by distance from `eye` as `mode` says (`manual` keeps the arranged order). With `check`, returns false (unsorted) when one of its entries changed phase. */
  const sortRange = (
    eye: ArrayLike<number>,
    from: number,
    to: number,
    mode: MaterialSortMode,
    check: boolean,
  ): boolean => {
    if (from === to) return true;
    for (let i = from; i < to; i++) {
      const entry = phases[i].entry;
      if (check && !current(entry)) return false;
      if (mode === 'manual') continue;
      const matrix = entry.model.primitives[0].node.matrix;
      // The squared distance sorts alike and needs no square root (2,000 blended meshes a frame).
      const x = eye[0] - matrix[12],
        y = eye[1] - matrix[13],
        z = eye[2] - matrix[14];
      entry.distance = x * x + y * y + z * z;
    }
    if (mode === 'manual') return true;
    const count = to - from,
      sign = mode === 'back-to-front' ? -1 : 1;
    for (let i = 0; i < count; i++) tail[i] = phases[from + i];
    tail.length = count;
    tail.sort((a, b) => a.entry.order - b.entry.order || sign * (a.entry.distance - b.entry.distance));
    for (let i = 0; i < count; i++) phases[from + i] = tail[i];
    return true;
  };
  const sortLate = (eye: ArrayLike<number>, check: boolean): boolean =>
    sortRange(eye, opaqueEnd, phases.length, sortModes.transparent, check);
  const plugin: EnginePlugin = {
    name,
    setup(engine) {
      requireWebGPU(engine, 'Material draw queue');
    },
    dispose() {
      queues.delete(graph);
    },
    registerPasses(graph) {
      graph.add({
        name,
        order: 1,
        joins: true,
        execute: (c) => {
          if (c.backend !== 'webgpu') return;
          if (!arranged) arrange();
          surfaces.next();
          // The late phase's entries are checked before anything draws, so one that turned opaque draws with the
          // opaque phase this frame.
          const eye = c.camera.position;
          while (!sortLate(eye, true)) arrange();
          sortRange(eye, 0, opaqueEnd, sortModes.opaque, false);
          // One render pass for every mesh: a pass per mesh stores and reloads the multisampled colour and depth each
          // time and costs a begin, an end and a command-buffer flush (10,000 meshes: 168 ms of CPU a frame).
          // A frame drawn inside this one (a draw callback rendering a probe) takes a run of its own.
          const own = running ? new PBRDrawRun() : run,
            color = c.color,
            depth = c.depth,
            first = epoch;
          running = true;
          try {
            // Each opaque entry is checked beside its draw rather than in a pass of its own over every mesh first
            // (10,000 meshes: one more trip through memory a frame). An entry that changed phase re-arranges the queue,
            // and so may a frame drawn inside a draw; the loop then continues on the new list, skipping what drew.
            let list = phases,
              end = opaqueEnd,
              at = epoch,
              drawn: Set<Entry> | undefined;
            for (let i = 0; i < end; i++) {
              const item = list[i],
                entry = item.entry;
              if (drawn?.has(entry)) continue;
              let done = 0;
              if (current(entry)) {
                join(entry);
                item.model.draw(c, 'beauty', color, depth, item.phase, undefined, own);
                if (at === epoch) continue;
                done = 1;
              } else arrange();
              drawn ??= new Set();
              for (let k = 0; k < i + done; k++) drawn.add(list[k].entry);
              list = phases;
              end = opaqueEnd;
              at = epoch;
              i = -1;
            }
            // Re-arranged while drawing: the late phase is sorted again (a change from here on shows next frame).
            if (epoch !== first) sortLate(eye, false);
            list = phases;
            end = list.length;
            for (let i = opaqueEnd; i < end; i++) {
              const item = list[i];
              join(item.entry);
              item.model.draw(c, 'beauty', color, depth, item.phase, undefined, own);
            }
          } finally {
            if (own === run) running = false;
            own.end();
          }
        },
      });
    },
  };
  runtime.use(plugin);
  draws = {
    sortModes,
    add(entry) {
      members.push(entry);
      arranged = false;
    },
    delete(entry) {
      const index = members.indexOf(entry);
      if (index >= 0) members.splice(index, 1);
      arranged = false;
      // The scene's last material mesh is gone: the queue and its pass leave with it; the next mesh makes a new one.
      if (!members.length) {
        queues.delete(graph);
        runtime.sceneOf(plugin)?.removePlugin(name);
      }
    },
    reorder() {
      arranged = false;
    },
  };
  queues.set(graph, draws);
  return draws;
}
const renderStates = new WeakMap<Material, PBRRenderState>(),
  features = new WeakMap<Material, NonNullable<PBRMaterial['extended']>>(),
  named = new WeakMap<Material, { key: string; value: Record<string, object> }>();
/** gltf/pbr's beauty pipeline overrides for `m`, or undefined for the default pipeline. */
function renderStateOf(m: Material): PBRRenderState | undefined {
  if (!m.customState) return undefined;
  let state = renderStates.get(m);
  if (state) return state;
  const stencil: GPUStencilFaceState = {
    compare: m.stencilFunc,
    failOp: m.stencilFail,
    depthFailOp: m.stencilZFail,
    passOp: m.stencilZPass,
  };
  state = {
    blend: blends[m.blending],
    ...(m.blendSpace === 'linear' ? { blendSpace: 'linear' as const } : {}),
    ...(m.transmissionBlend !== 'auto' ? { transmissionBlend: m.transmissionBlend } : {}),
    depthWrite: m.depthWrite,
    depthCompare: m.depthTest ? undefined : 'always',
    ...(m.colorWrite ? {} : { colorWrite: false }),
    ...(m.alphaToCoverage ? { alphaToCoverage: true } : {}),
    ...(m.polygonOffset
      ? {
          depthBiasMode: 'away' as const,
          depthBias: m.polygonOffsetUnits,
          depthBiasSlopeScale: m.polygonOffsetFactor,
          depthBiasClamp: m.polygonOffsetClamp,
        }
      : {}),
    ...(m.stencilWrite
      ? {
          stencilFront: stencil,
          stencilBack: { ...stencil },
          stencilReference: m.stencilRef,
          stencilReadMask: m.stencilReadMask,
          stencilWriteMask: m.stencilWriteMask,
        }
      : {}),
  };
  renderStates.set(m, state);
  return state;
}
const scaledEmission = new WeakMap<Material, number[]>();
/** gltf/pbr's emission row: the live emissive colour itself, or (emissiveIntensity not 1) it scaled. */
function emissionOf(m: Material): number[] {
  const k = m.emissiveIntensity;
  if (k === 1) return m.emissive;
  let out = scaledEmission.get(m);
  if (!out) scaledEmission.set(m, (out = [0, 0, 0]));
  for (let i = 0; i < 3; i++) out[i] = m.emissive[i] * k;
  return out;
}
/** gltf/pbr's extended-material features (iridescence, anisotropy rows) for `m`, kept while they stay the same. */
function extendedOf(m: Material): PBRMaterial['extended'] {
  if (!m.physical || m.physical.length <= 12) return undefined;
  const iridescence = m.extensions.includes('iridescence'),
    anisotropy = m.extensions.includes('anisotropy'),
    diffuseRoughness = m.extensions.includes('diffuse_roughness');
  let f = features.get(m);
  if (f?.iridescence !== iridescence || f.anisotropy !== anisotropy || f.diffuseRoughness !== diffuseRoughness)
    features.set(m, (f = { iridescence, anisotropy, diffuseTransmission: false, diffuseRoughness }));
  return f;
}
/** The glTF `extensions` record @margoengine/exporters reads to name the KHR_materials_* in use; one object per list. */
function extensionsOf(m: Material): Record<string, object> | undefined {
  if (!m.physical) return undefined;
  const key = m.extensions.join();
  let record = named.get(m);
  if (record?.key !== key)
    named.set(m, (record = { key, value: Object.fromEntries(m.extensions.map((e) => ['KHR_materials_' + e, {}])) }));
  return record.value;
}
/** Which envMap shader `m` takes: standard image-based light, basic output, or Lambert and Phong lit colour. */
const envKind = (m: Material) => (m.shading === 'standard' ? 'standard' : m.shading === 'basic' ? 'basic' : 'lit');
const envSamplers = new WeakMap<GPUDevice, GPUSampler>(),
  envViews = new WeakMap<GPUTexture, GPUTextureView>(),
  blackCubes = new WeakMap<GPUDevice, GPUTextureView>();
/** Checks an envMap value: a cube Texture, an Environment, a cube render target or a six-layer GPUTexture. */
function envSource(v: unknown): EnvMapSource {
  if (typeof v === 'function') return v as EnvMapSource;
  if (v instanceof Texture) {
    if (v.dimension !== 'cube')
      throw new TypeError(`Material envMap must be a cube Texture, not a ${v.dimension} one; use a CubeTexture`);
    return v;
  }
  const o = v as Partial<EnvironmentMap & CubeTarget & GPUTexture> | null;
  if (o && typeof o === 'object') {
    if (o.specularView && typeof o.specularMips === 'number' && o.sampler && o.sh) return o as EnvironmentMap;
    if (o.texture && o.view && o.texture.depthOrArrayLayers === 6) return o as CubeTarget;
    if (typeof o.createView === 'function' && o.depthOrArrayLayers === 6 && o.dimension === '2d')
      return o as GPUTexture;
  }
  throw new TypeError(
    'Material envMap must be a CubeTexture, an Environment, a cube render target {texture, view} or a six-layer GPUTexture; pass one of those or null',
  );
}
/** A 1 x 1 black cube: what a cube whose images are still loading, or whose plain object was lost, reflects. */
function blackCube(device: GPUDevice): GPUTextureView {
  let black = blackCubes.get(device);
  if (!black) {
    const texture = device.createTexture({
      size: [1, 1, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, new Uint8Array(24), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 6]);
    blackCubes.set(device, (black = texture.createView({ dimension: 'cube' })));
  }
  return black;
}
/** The envMap's cube, sampler and uniform for `m` on `device` (188-190). */
function envBindings(m: Material, device: GPUDevice, owner: object): GPUBindGroupEntry[] {
  const e = m['env'];
  let map: Exclude<EnvMapSource, (device: GPUDevice) => unknown> | undefined;
  if (e.slot) {
    const made = lend(e.slot, device, owner as Engine);
    map = made === undefined ? undefined : (envSource(made) as typeof map);
  } else map = e.map as typeof map;
  let view: GPUTextureView,
    sampler: GPUSampler | undefined,
    levels = 1,
    sh: ArrayLike<number> | undefined,
    rotation = e.rotation,
    intensity = e.intensity;
  if (!map) view = blackCube(device);
  else if (map instanceof Texture) {
    // After the bind: a borrowed texture made by a function has no format until its first bind.
    const pair = map.bind(device, true);
    if (map.unfilterable && !device.features.has('float32-filterable'))
      throw new MargoError(
        'unsupported',
        'Material envMap samples 32-bit float texels, which needs the device feature float32-filterable; request it in Engine.create features, use a 16-bit float format, or pass the cube through prefilterCube',
      );
    levels = map.gpuTexture(device)?.mipLevelCount ?? 1;
    if (pair) [view, sampler] = pair;
    else {
      view = blackCube(device);
    }
  } else if ('specularView' in map) {
    view = map.specularView;
    sampler = map.sampler;
    levels = map.specularMips;
    sh = map.sh.irradiance;
    rotation += map.rotation;
    intensity *= map.intensity * (map.radianceScale ?? 1);
  } else {
    const texture = 'view' in map ? map.texture : (map as GPUTexture);
    levels = texture.mipLevelCount;
    if ('view' in map) view = map.view;
    else {
      let cached = envViews.get(texture);
      if (!cached) envViews.set(texture, (cached = texture.createView({ dimension: 'cube' })));
      view = cached;
    }
  }
  if (!sampler) {
    sampler = envSamplers.get(device);
    if (!sampler)
      envSamplers.set(
        device,
        (sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })),
      );
  }
  const state = mapState(m, owner),
    buffer = materialBuffer(m, device, owner, envFloats * 4, 'env'),
    values = packEnv(
      (state.envData ??= new Float32Array(envFloats)),
      rotation,
      levels,
      intensity,
      sh,
      e.mode === 'refraction' ? e.ratio : 0,
      e.reflectivity,
      e.combine,
    );
  device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
  return [
    { binding: 188, resource: view },
    { binding: 189, resource: sampler },
    { binding: 190, resource: { buffer } },
  ];
}
/** A record's material, engine, mesh data and placeholder ext row: not enumerable, so `{...record}` copies skip them. */
const recordMaterial = Symbol('material'),
  recordRuntime = Symbol('runtime'),
  recordExt = Symbol('ext'),
  recordState = Symbol('renderState'),
  recordData = Symbol('meshData');
type MaterialRecord = PBRMaterial & {
  [recordMaterial]: Material;
  [recordRuntime]: Engine;
  [recordData]?: MaterialMeshData;
  [recordExt]: number[];
  [recordState]?: PBRRenderState;
};
/**
 * A live record field, read from the record's material on every access. Enumerable and configurable like the data
 * properties they replace (`{...record}` copies still work). The getters are made once and shared by every record, so
 * all records have one shape and gltf/pbr's per-draw reads of them stay fast with thousands of materials.
 */
const live = (read: (m: Material, g: MaterialRecord) => unknown): PropertyDescriptor => ({
  get(this: MaterialRecord) {
    return read(this[recordMaterial], this);
  },
  enumerable: true,
  configurable: true,
});
const surfaceFields: PropertyDescriptorMap = {
  extendedFrame: { value: true, enumerable: true },
  // gltf/pbr's placeholder record makes its own `side` accessor per record, which gave every record a hidden class
  // of its own (gltf/pbr's reads of thousands of records then missed every inline cache).
  side: {
    get(this: MaterialRecord) {
      return this[recordMaterial].side;
    },
    set(this: MaterialRecord, v: MaterialSide) {
      this[recordMaterial].side = v;
    },
    enumerable: true,
    configurable: true,
  },
  base: live((m) => m.color),
  emission: live(emissionOf),
  factors: live((m) => m.factors),
  settings: live((m) => m.settings),
  // The native frame holds 13 slots; the sparse map uniform owns all 17 slots.
  uvt: live((m) => m.uvt.slice(0, extendedOf(m) ? 144 : 104)),
  // Physical: gltf/pbr's factor-only variant (five maps), live arrays, and the tinted-blend constant.
  physical: live((m) => m.physical),
  ext: live((m, g) => m.ext ?? g[recordExt]),
  volume: live((m) => m.volume),
  dispersion: live((m) => m.dispersion),
  tint: live((m) => m.tint),
  extended: live(extendedOf),
  extensions: live(extensionsOf),
  // Read from the material, unless this primitive was given a native state of its own (undefined gives it back).
  renderState: {
    ...live((m, g) => g[recordState] ?? renderStateOf(m)),
    set(this: MaterialRecord, v: PBRRenderState | undefined) {
      this[recordState] = v;
      // A steady material's draws are not looked at again, so the next frame has to see a change.
      this[recordMaterial]['changes'] = changeStamp();
    },
  },
  displacement: live((m, g) => {
    const device = g[recordRuntime].gpu;
    const map = displacementOf(m, device, g[recordRuntime]);
    return (
      (device &&
        (m.caster(device, g[recordRuntime], map, g[recordData]) ??
          m['added'].find((v) => v.caster)?.caster!(device, m, map))) ??
      map
    );
  }),
  clip: live((m, g) => clipOf(m, g[recordRuntime].gpu, g[recordRuntime])),
  clipHardware: live((m, g) => hardwareClip(m, g[recordRuntime].gpu)),
  surfaceClip: live((m, g) => surfaceClipOf(m, g[recordRuntime].gpu, g[recordRuntime])),
  castMask: live((m, g) => castMaskOf(m, g[recordRuntime].gpu, g[recordRuntime])),
  // alphaHash() cuts the colour pass by noise; its shadows cut by the same hash, through the feature's own caster edit
  // (shared/alpha-hash.js hashedDepth), so only an app that imports alphaHash bundles that WGSL.
  castHashed: live((m) => m.features.find((f) => f.castHashed)?.castHashed),
  pickMask: live((m, g) => pickMaskOf(m, g[recordRuntime].gpu, g[recordRuntime])),
  vertexAlpha: live((m) => m.vertexColors),
  wireframe: {
    ...live((m) => m.wireframe),
    set(this: MaterialRecord, v: boolean) {
      this[recordMaterial].wireframe = v;
    },
  },
};
/** gltf/pbr's shading hook for a record of `m` (see `surface`). */
class MaterialShading implements PBRMaterialShading {
  /** What `liveStamp` last saw of the arrays a caller may write in place (colour, emissive, specular, factors, settings). */
  private readonly seen = new Float64Array(liveFloats).fill(Number.NaN);
  constructor(
    private readonly m: Material,
    private readonly runtime: Engine,
    private readonly data?: MaterialMeshData,
  ) {}
  get replacesTextures(): boolean {
    return mapped(this.m) || bare(this.m);
  }
  get texturedTint(): boolean {
    return mapped(this.m) && this.m.transmissive;
  }
  get shaderRevision(): number {
    return shaderRevision(this.m);
  }
  get instanceRows(): boolean {
    const added = this.m['added'];
    for (let k = 0; k < added.length; k++) if (added[k].instanceRows) return true;
    return false;
  }
  /**
   * gltf/pbr `PBRMaterialShading.version`: the largest change stamp of the material and of every texture its bindings
   * read, so it grows whenever anything this record, `shader()`, `lit()` or `bindings()` reads changes. NaN where that
   * cannot be known: a material with its own `shader` or `bindings` (NodeMaterial, WgslMaterial), physical maps, an
   * envMap that is not a Texture, or a texture that is not steady (`Texture.steady`).
   */
  get version(): number {
    const m = this.m,
      device = this.runtime.gpu;
    if (
      !device ||
      m.shader !== Material.prototype.shader ||
      m.bindings !== Material.prototype.bindings ||
      mapped(m) ||
      m['added'].some((v) => v.bindings)
    )
      return Number.NaN;
    let v = liveStamp(m, this.seen);
    const base = m['baseMaps'],
      features = m['featureTextures'],
      surface = m['surfaceTextures'],
      toon = m['toonMap'],
      env = m['env'].map;
    for (let i = 0; i < base.length; i++) {
      const s = base[i]?.steady(device) ?? 0;
      if (s !== s) return s;
      if (s > v) v = s;
    }
    for (let i = 0; i < features.length; i++) {
      const s = features[i]?.steady(device) ?? 0;
      if (s !== s) return s;
      if (s > v) v = s;
    }
    for (let i = 0; i < surface.length; i++) {
      const s = surface[i]?.steady(device) ?? 0;
      if (s !== s) return s;
      if (s > v) v = s;
    }
    if (toon) {
      const s = toon.steady(device);
      if (s !== s) return s;
      if (s > v) v = s;
    }
    if (env) {
      const s = env instanceof Texture ? env.steady(device) : Number.NaN;
      if (s !== s) return s;
      if (s > v) v = s;
    }
    return v;
  }
  shader(code: string, group: number): string {
    const m = this.m,
      key = featureKey(m, code),
      own = m.shader(code, group),
      out = key ? featureShader(own, group, key) : own,
      env = m.envMap ? envMapShader(out, group, envKind(m)) : out;
    const feed = (from: string) => {
      let text = from;
      for (const v of m['added']) text = v.shader(text, group, m);
      return text;
    };
    if (!m['clipping'].length) return feed(env);
    const device = this.runtime.gpu;
    if (device && hardwareClip(m, device)) {
      const text = feed(env);
      if (roomForDistances(text, device)) return markClipDistances(text, group, 199, 'materialClip');
    }
    return feed(clipShader(env, group));
  }
  lit(code: string): string {
    const m = this.m,
      out = litShader(m, code);
    let text = m.relight(m.envMap ? envMapLit(out, envKind(m)) : out);
    for (const v of m['added']) if (v.lit) text = v.lit(text, m);
    return text;
  }
  bindings(): GPUBindGroupEntry[] {
    const m = this.m,
      runtime = this.runtime;
    noteEngine(runtime);
    const entries = featureBindings(m, runtime.gpu!, runtime, m.bindings(runtime.gpu!, runtime, this.data)),
      all = m.envMap ? [...entries, ...envBindings(m, runtime.gpu!, runtime)] : entries,
      out = m['clipping'].length ? [...all, { binding: 199, resource: clipUniform(m, runtime.gpu!, runtime) }] : all;
    if (!m['added'].length) return out;
    return [...out, ...m['added'].flatMap((v) => v.bindings?.(runtime.gpu!, runtime, m) ?? [])];
  }
}
/**
 * A gltf/pbr material record for `m` from the placeholder record's fields `blank`, read on every draw: values, maps
 * (through the shading hook), physical rows, render state and wireframe all follow a live edit from the next frame.
 * It is made in one `defineProperties` call from shared descriptors (redefining data properties as accessors would
 * leave each record a dictionary of its own).
 */
function surface(
  blank: PropertyDescriptorMap,
  m: Material,
  runtime: Engine,
  data: MaterialMeshData | undefined,
): PBRMaterial {
  const fields: PropertyDescriptorMap = {};
  for (const key of Object.keys(blank)) if (!(key in surfaceFields) && key !== 'shading') fields[key] = blank[key];
  Object.assign(fields, surfaceFields);
  fields.shading = { enumerable: true, value: new MaterialShading(m, runtime, data) };
  fields[recordMaterial] = { value: m };
  fields[recordRuntime] = { value: runtime };
  fields[recordData] = { value: data };
  fields[recordExt] = { value: blank.ext?.value };
  fields[recordState] = { value: undefined, writable: true };
  return Object.defineProperties({}, fields) as PBRMaterial;
}
const shaderRevisions = new WeakMap<Material, { key: number; revision: number }>();
let nextShaderRevision = 1;
/**
 * gltf/pbr `PBRMaterialShading.shaderRevision` for `m`: a number that changes whenever what `shader()` and `lit()` read
 * of `m` changes, so gltf/pbr composes a material's shader again only then. Their text depends on the shading (fixed),
 * whether the material is bare, the feature maps in use, the feature switches, the normal maps and anisotropy (the
 * tangent frame), the envMap, the clipping planes and the optional features. Materials with physical maps (their plan follows texture loading)
 * and classes or instances with their own `shader` give NaN: composed on every frame, as before.
 */
function shaderRevision(m: Material): number {
  if (m.shader !== Material.prototype.shader || mapped(m)) return Number.NaN;
  const used = featureMapsUsed(m),
    surface = surfaceUsed(m),
    key =
      +bare(m) |
      (+used[0] << 1) |
      (+used[1] << 2) |
      (+used[2] << 3) |
      (+used[3] << 4) |
      (+m.flatShading << 5) |
      (+m.vertexColors << 6) |
      (+m.fog << 7) |
      (+m.toneMapped << 8) |
      (+(m.normalMap != null) << 9) |
      (+(m.clearcoatNormalMap != null) << 10) |
      (+m.extensions.includes('anisotropy') << 11) |
      (+(m.envMap != null) << 12) |
      (+(m['clipping'].length > 0) << 13) |
      (+surface[0] << 14) |
      (+surface[1] << 15) |
      (+surface[2] << 16) |
      (+surface[3] << 17) |
      (+m.dithering << 18) |
      (+m.clipIntersection << 19) |
      (+(m['clipping'].length > hardwarePlanes * 4) << 20),
    variant = key + m['addedStamp'] * 2097152;
  let state = shaderRevisions.get(m);
  if (!state) shaderRevisions.set(m, (state = { key: variant, revision: nextShaderRevision++ }));
  else if (state.key !== variant) {
    state.key = variant;
    state.revision = nextShaderRevision++;
  }
  return state.revision;
}
/**
 * `m`'s change stamp, after a look at the arrays a caller may write element by element (`color[0] = 1`; gltf/pbr's
 * factor and settings rows): a difference from `seen` (what one record last saw of them) takes a new stamp.
 */
function liveStamp(m: Material, seen: Float64Array): number {
  const a = m['rgba'],
    b = m['glow'],
    c = m['highlight'],
    d = m.factors,
    e = m.settings;
  if (
    seen[0] !== a[0] ||
    seen[1] !== a[1] ||
    seen[2] !== a[2] ||
    seen[3] !== a[3] ||
    seen[4] !== b[0] ||
    seen[5] !== b[1] ||
    seen[6] !== b[2] ||
    seen[7] !== c[0] ||
    seen[8] !== c[1] ||
    seen[9] !== c[2] ||
    seen[10] !== d[0] ||
    seen[11] !== d[1] ||
    seen[12] !== d[2] ||
    seen[13] !== d[3] ||
    seen[14] !== e[0] ||
    seen[15] !== e[1] ||
    seen[16] !== e[2] ||
    seen[17] !== e[3]
  ) {
    for (let i = 0; i < 4; i++) {
      seen[i] = a[i];
      seen[10 + i] = d[i];
      seen[14 + i] = e[i];
    }
    for (let i = 0; i < 3; i++) {
      seen[4 + i] = b[i];
      seen[7 + i] = c[i];
    }
    m['changes'] = changeStamp();
  }
  return m['changes'];
}
let tracking = false;
/**
 * Makes every Material setter, `setUVTransform` and `copy` take a new change stamp (`Material.changes`), from the first
 * mesh record on: a record's `version` (gltf/pbr `PBRMaterialShading.version`) then lets gltf/pbr skip reading a steady
 * material's rows and bindings. Edits before that need no stamp, as gltf/pbr has derived nothing yet.
 */
function trackChanges(): void {
  if (tracking) return;
  tracking = true;
  const proto = Material.prototype as unknown as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
    const set = descriptor.set;
    if (set)
      Object.defineProperty(proto, key, {
        ...descriptor,
        set(this: Material, v: unknown) {
          set.call(this, v);
          this['changes'] = changeStamp();
        },
      });
  }
  for (const key of ['setUVTransform', 'copy']) {
    const method = proto[key] as (this: Material, ...args: unknown[]) => unknown;
    Object.defineProperty(proto, key, {
      ...Object.getOwnPropertyDescriptor(proto, key),
      value(this: Material, ...args: unknown[]) {
        const out = method.apply(this, args);
        this['changes'] = changeStamp();
        return out;
      },
    });
  }
}
const records = new WeakMap<Material | MaterialMeshData, WeakMap<Engine, PBRMaterial>>();
/**
 * The gltf/pbr material record the meshes of `runtime` draw `m` with: one per material, as glTF primitives that use one
 * material share one record, so gltf/pbr derives a material's shader, pipeline and uniform rows once per frame for
 * all of its meshes instead of once per mesh. `blank` is gltf/pbr's record for the placeholder material (`{}`).
 */
function recordOf(m: Material, runtime: Engine, blank: PropertyDescriptorMap, data?: MaterialMeshData): PBRMaterial {
  // A material that reads a mesh's own data takes a record per mesh, as its bindings differ.
  const owner = data ?? m;
  let byEngine = records.get(owner);
  if (!byEngine) records.set(owner, (byEngine = new WeakMap()));
  let record = byEngine.get(runtime);
  if (!record) {
    trackChanges();
    record = surface(blank, m, runtime, data);
    byEngine.set(runtime, record);
  }
  return record;
}
/** A materials mesh: the gltf/pbr model plus the live `material` it draws with (read by @margoengine/exporters `exportModel`). */
export type MaterialMesh<M extends Material | readonly Material[] = Material> = PBRModel & {
  /**
   * The material it draws with, or a frozen snapshot of the material array (one per slot that `groups` index).
   * Assigning swaps it live from the next frame: one Material for a single-material mesh, an array of the same length
   * for a grouped one. Transform, geometry, render order, skin and shadow, clustered, fog, IBL, SSAO, OIT and
   * selection registrations stay; transparent sorting and picking follow the new material.
   */
  material: M extends Material ? Material : readonly Material[];
  /**
   * Live edit: repacks `geometry` (the same object edited in place, or a new one) into this mesh's buffers, reusing
   * the GPU buffers while the data fits (gltf/pbr `writeGeometry`). Groups may move and resize but keep their number
   * and material slots. With `range`, only those vertices are repacked and uploaded and the vertex count must stay;
   * indices and groups are not read, so a per-frame UV animation uploads just its vertices. Raycasts,
   * `worldTriangles`, bounds and exports see the new data at once.
   */
  setGeometry(geometry: MeshGeometry, range?: GeometryRange): MaterialMesh<M>;
  /** Draw order among materials meshes, lower first within the opaque and the transparent phase; live. */
  renderOrder: number;
  /**
   * Takes the surface hooks of its scene (`@margoengine/weather`'s `Puddles`, `Snow` and `PrecipitationCover`): wet
   * ground, standing water and snow change its colour, roughness, metalness and normal before lighting, as they change
   * core meshes, from the next frame, with no call per mesh. Only a mesh with a lit material (standard, Lambert, Phong
   * or toon shading) joins them. Set false to keep this mesh out of the weather (a sign under a roof). A mesh given to
   * a `GLTFWeather` (`add`) takes its weather from that alone. Live; default true.
   */
  sceneSurfaces: boolean;
};
/**
 * Creates one gltf/pbr `PBRModel`. A material array draws the geometry's nonempty, nonoverlapping triangle groups;
 * uncovered indices are omitted. A scalar material draws the entire geometry, ignoring groups.
 * Move it with `model.root`, edit it with `model.setGeometry(geometry, range?)`, remove it with `model.destroy()`.
 * It works with `shadows.add`, `clustered.add` and `ssao.add` like a loaded glTF. Textures are not disposed with the model.
 */
export function createMesh<M extends Material | readonly Material[]>(
  engine: EngineKernel,
  geometry: MeshGeometry,
  material: M,
  { renderOrder = 0 }: { renderOrder?: number } = {},
): MaterialMesh<M> {
  const array = Array.isArray(material),
    // The current material of each slot (`groups[i].materialIndex`); a swap replaces the contents.
    assigned: Material[] = array ? [...(material as readonly Material[])] : [material as Material];
  if (!assigned.length || assigned.some((m) => !(m instanceof Material)) || !Number.isFinite(renderOrder))
    throw new TypeError(
      'Material mesh needs a Material or a non-empty array of them and a finite renderOrder; pass those.',
    );
  assigned.forEach(usable);
  const data = packGeometry(geometry),
    groups = meshGroups(geometry, data.indices.length, assigned, array);
  // What each material reads of this mesh beyond the packed vertex; a swapped-in one reads the `latest` geometry.
  const own = new Map<Material, MaterialMeshData>();
  let latest = geometry;
  const read = (list: readonly Material[]) => {
    for (const m of list) {
      const found = own.has(m) ? undefined : m.meshData(latest);
      if (found) own.set(m, found);
    }
  };
  read(assigned);
  const prepared = groups.map((g) => ({ vertices: data.vertices, indices: groupIndices(data.indices, g) }));
  const runtime = engineRuntime(engine);
  // Placeholder glTF materials: every value gltf/pbr draws comes from the slot's current Material (`surface`).
  const doc = {
    asset: { version: '2.0' },
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: groups.map((g) => ({ material: g.materialIndex })) }],
    materials: assigned.map(() => ({})),
  };
  const asset = new GLTFAsset(doc, [], undefined, { materials: extendedMaterials });
  // One primitive per group: the mesh's material slots, geometry writes and BatchedMesh ranges index primitives by
  // group, so a group must never split into glTF load parts (validatePreparedGeometry still caps the vertex count).
  asset.partVertices = Math.max(asset.partVertices, data.vertices.length / 20);
  const model = new PBRModel(engine, asset, [], [prepared]);
  // Per-engine uniform buffers are retained once per material in use and released when the last use goes.
  const held = new Map<Material, () => void>(),
    hold = () => {
      const used = new Set(groups.map((g) => assigned[g.materialIndex]));
      for (const m of used) if (!held.has(m)) held.set(m, retainMaps(m, runtime));
      for (const [m, release] of held)
        if (!used.has(m)) {
          held.delete(m);
          release();
        }
    };
  hold();
  model.onDispose(() => {
    for (const release of held.values()) release();
    held.clear();
    for (const mine of own.values()) mine.dispose();
    own.clear();
  });
  // gltf/pbr's record for the placeholder material, copied for each material's shared record (own arrays each).
  const fresh = model.primitives[0].material,
    blank = Object.getOwnPropertyDescriptors(fresh);
  for (const key of Object.keys(blank)) {
    const value = blank[key].value;
    if (Array.isArray(value)) blank[key].value = [...value];
  }
  // Own and writable, so the per-frame routing check (primitiveAfterOpaque) reads it without a prototype-chain miss.
  blank.extension ??= { value: undefined, writable: true, configurable: true, enumerable: false };
  const point = () => {
    for (const primitive of model.primitives) {
      const m = assigned[primitive.definition.material!];
      primitive.material = recordOf(m, runtime, blank, own.get(m));
    }
  };
  point();
  const entry: Entry = {
    model,
    materials: groups.map((g) => assigned[g.materialIndex]),
    order: renderOrder,
    opaque: false,
    blend: false,
    distance: 0,
    surfaces: true,
  };
  let snapshot = array ? Object.freeze([...assigned]) : undefined;
  const swap = (next: Material | readonly Material[]) => {
    if (model.disposed) throw new MargoError('disposed', 'Material mesh is disposed; create a new mesh');
    const list: readonly unknown[] = Array.isArray(next) ? next : [next];
    if (Array.isArray(next) !== array || list.length !== assigned.length || list.some((m) => !(m instanceof Material)))
      throw new TypeError(
        array
          ? `Material mesh material must be an array of ${assigned.length} Materials, one per slot; pass one for each`
          : 'Material mesh material must be one Material; pass a Material (a material array needs a grouped mesh)',
      );
    (list as Material[]).forEach(usable);
    read(list as Material[]);
    assigned.splice(0, assigned.length, ...(list as Material[]));
    point();
    for (const [m, mine] of own)
      if (!assigned.includes(m)) {
        mine.dispose();
        own.delete(m);
      }
    for (let i = 0; i < groups.length; i++) entry.materials[i] = assigned[groups[i].materialIndex];
    if (array) snapshot = Object.freeze([...assigned]);
    hold();
  };
  model.registerPasses = () => {};
  let set: MaterialDraws | undefined;
  try {
    set = queue(runtime);
    runtime.use(model);
  } catch (error) {
    // The scene's first material mesh failed: its new, empty draw queue leaves with it (delete drops an empty queue).
    set?.delete(entry);
    model.dispose();
    throw error;
  }
  const draws = set;
  draws.add(entry);
  model.onDispose(() => draws.delete(entry));
  let current = groups,
    owned = false; // false while the primitives still draw packGeometry's cached (shareable) arrays
  const setGeometry = (next: MeshGeometry, range?: GeometryRange): MaterialMesh<M> => {
    if (model.disposed) throw new MargoError('disposed', 'Material mesh is disposed; create a new mesh');
    const mesh = model as MaterialMesh<M>;
    if (range === undefined) {
      const data = pack(next),
        list = meshGroups(next, data.indices.length, assigned, array);
      if (list.length !== current.length || list.some((g, i) => g.materialIndex !== current[i].materialIndex))
        throw new RangeError('Mesh geometry groups must keep their number and material slots; create a new mesh');
      const commits = Array.from(own.values(), (mine) => mine.prepare(next));
      model.writeGeometry(list.map((g) => ({ vertices: data.vertices, indices: groupIndices(data.indices, g) })));
      for (const commit of commits) commit();
      current = list;
    } else {
      const vertices = model.primitives[0].vertices,
        total = vertices.length / 20,
        { start, count } = range;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(count) ||
        start < 0 ||
        count < 1 ||
        start + count > total
      )
        throw new RangeError(
          'Mesh geometry range must be whole vertices inside the mesh; pass start >= 0 and count >= 1',
        );
      if (vertexCount(next) !== total)
        throw new RangeError('A ranged mesh geometry update keeps the vertex count; omit the range to resize');
      const chunk = packVertices(next, start, start + count);
      let moved = false;
      for (let i = 0; i < chunk.length && !moved; i += 20)
        for (let k = 0; k < 3; k++) moved ||= chunk[i + k] !== vertices[start * 20 + i + k];
      const commits = Array.from(own.values(), (mine) => mine.prepare(next, range));
      // Moved positions need new array identities: BVH and selection caches key on them.
      const target = owned && !moved ? vertices : vertices.slice();
      target.set(chunk, start * 20);
      model.writeGeometry(
        model.primitives.map((p) => ({ vertices: target, indices: moved ? p.indices.slice() : p.indices })),
        range,
      );
      for (const commit of commits) commit();
    }
    latest = next;
    owned = true;
    packed.delete(next);
    return mesh;
  };
  return Object.defineProperties(model, {
    material: { get: () => snapshot ?? assigned[0], set: swap },
    renderOrder: {
      get: () => entry.order,
      set: (v: number) => {
        if (typeof v !== 'number')
          throw new TypeError('Material mesh renderOrder must be a number; set a finite number');
        if (!Number.isFinite(v)) throw new RangeError('Material mesh renderOrder must be finite; set a finite number');
        entry.order = v;
        draws.reorder();
      },
    },
    sceneSurfaces: {
      get: () => entry.surfaces,
      set: (v: boolean) => {
        if (typeof v !== 'boolean')
          throw new TypeError('Material mesh sceneSurfaces must be true or false; set a boolean');
        entry.surfaces = v;
      },
    },
    setGeometry: { value: setGeometry },
  }) as MaterialMesh<M>;
}
/** A materials mesh drawn as `instances.count` instances in one draw call; `instances` holds each one's matrix, tint and UV transform. */
export type InstancedMesh<M extends Material | readonly Material[] = Material> = MaterialMesh<M> & {
  readonly instances: PBRInstances;
};
/**
 * `createMesh` for `capacity` copies in one instanced draw: `mesh.instances.setMatrixAt(i, m)`, `setColorAt`, `setUVTransformAt`
 * (an atlas region), `count`. Instance matrices are relative to `mesh.root`. Works with shadows, clustered, IBL, fog and SSAO.
 */
export function createInstancedMesh<M extends Material | readonly Material[]>(
  engine: EngineKernel,
  geometry: MeshGeometry,
  material: M,
  capacity: number,
  options: { renderOrder?: number } = {},
): InstancedMesh<M> {
  const instances = new PBRInstances(capacity),
    model = createMesh(engine, geometry, material, options);
  for (const primitive of model.primitives) primitive.instances = instances;
  return Object.defineProperty(model, 'instances', { value: instances }) as InstancedMesh<M>;
}
