// Public input and output shapes of @margoengine/voxel-pathtracer. Everything is in Margo's Y-up world coordinates
// (convert MagicaVoxel's Z-up .vox data at the caller's boundary). The names and shapes up to "Compatible additions"
// are the integration contract agreed with the voxel editor; the rest are optional additions.

/** Three components `[x, y, z]` or `[r, g, b]`. Colours are linear RGB (not sRGB). */
export type TraceVec3 = readonly [number, number, number];

/**
 * Surface or volume model of a palette entry:
 * - `diffuse`: Lambertian.
 * - `plastic`: diffuse base under a dielectric GGX coat (Fresnel from `ior`, scaled by `specular`).
 * - `metal`: GGX conductor tinted by `color` (Schlick Fresnel), mixed with plastic by `metalness`.
 * - `glass`: smooth or rough dielectric with refraction by `ior`; `color` tints light entering, `density` adds
 *   Beer-Lambert absorption toward `color`, `scatter` adds interior scattering (random-walk subsurface).
 * - `emit`: diffuse surface that also emits `color * emission`.
 * - `blend`: one surface mixing metal (`metalness`), glass (`transmission`) and plastic (the rest).
 * - `media`: index-matched participating medium (clouds, fog, smoke) with extinction `density` per world unit,
 *   single-scattering albedo `color` and Henyey-Greenstein `anisotropy`.
 */
export type TraceMaterialType = 'diffuse' | 'plastic' | 'metal' | 'glass' | 'emit' | 'blend' | 'media';

/**
 * Rendering material of one palette index. Defaults per type are listed in the package README.
 */
export interface TraceMaterial {
  /** Occupied palette index, 1 to 255 (0 is empty space). */
  id: number;
  /** Linear RGB, each component 0 or more: reflectance, tint and albedo use it clamped to 1, emission does not. */
  color: TraceVec3;
  /** How the palette index scatters light. */
  type: TraceMaterialType;
  /** GGX roughness, 0 (mirror-smooth) to 1. */
  roughness?: number;
  /** Share of the metal lobe, 0 to 1 (`metal` and `blend`). */
  metalness?: number;
  /**
   * Emitted radiance as a multiple of `color` (or `emissionColor`), 0 or more. Any surface type may emit; `emit`
   * defaults to 1. Compatible addition: `media` emit too, `emission x emissionColor` radiance per world unit along a
   * ray (fire, glowing gas), attenuated by the medium itself.
   */
  emission?: number;
  /** Compatible addition: linear RGB of the emission, each component 0 or more. Default `color`. */
  emissionColor?: TraceVec3;
  /**
   * Compatible addition: the radiance multiplier of `emissionColor` that camera rays see on this surface (before they
   * scatter), 0 or more, while lighting keeps `emission`: a light that shows dimmer or brighter than it shines.
   * Default: `emission`. MagicaVoxel's emitter LDR setting l shows 1 + 3 l.
   */
  cameraEmission?: number;
  /**
   * Compatible addition: a medium the sun lights even with `sunInMedia` false. With `transparentShadows` false a
   * shadow ray crosses only the cell it starts in (attenuated), so only cells that see the sun directly are lit:
   * MagicaVoxel's subsurface media. Default false.
   */
  sunlit?: boolean;
  /**
   * Compatible addition: for a `blend` volume, every voxel face inside it picks a lobe again, so light passes straight
   * through the glass share and the rest scatters at that face, as MagicaVoxel renders partly transparent voxels.
   * Default false (the volume is one piece of material).
   */
  voxelwise?: boolean;
  /**
   * Compatible addition: for a `blend` volume, a ray inside it reaches another voxel's surface through the face they
   * share only with the glass share's probability (otherwise the path ends), as MagicaVoxel's partly transparent glass
   * shows what it rests on. Default false.
   */
  contactTransmission?: boolean;
  /**
   * Compatible addition: block textures. An index into `scene.textures` for every face, or one per face in model axes
   * (+x, -x, +y, -y, +z, -z). A face's texel (nearest, the tiling of `@margoengine/voxel`'s renderer: tops by x and z,
   * sides with v running down) multiplies `color` and `metalColor`; emission stays untextured.
   */
  texture?: number | readonly [number, number, number, number, number, number];
  /**
   * Compatible addition: with a `texture`, texels whose alpha is below this (0 to 1, for example 0.5) let rays and
   * shadows through: a ray crossing such a voxel meets the texel where it enters, else the one where it leaves (the
   * voxel's inner face), else goes on (leaves). Default 0 (none).
   */
  cutout?: number;
  /** Index of refraction, 1 to 3 (glass refraction and the plastic coat's Fresnel). Default 1.5. */
  ior?: number;
  /** Share of the glass lobe, 0 to 1 (`blend`; `glass` is 1). */
  transmission?: number;
  /** Media extinction, or glass Beer-Lambert absorption strength, per world unit, 0 or more. */
  density?: number;
  /** Strength of the dielectric coat's reflection, 0 to 1 (0 turns the coat off). Default 1. */
  specular?: number;
  /** Compatible addition: interior scattering coefficient of glass/blend volumes per world unit (subsurface). */
  scatter?: number;
  /** Compatible addition: Henyey-Greenstein anisotropy for media and interior scattering, -0.95 to 0.95. */
  anisotropy?: number;
  /**
   * Compatible addition: Abbe number V_d of the glass lobe, 0 (default: no dispersion) or 5 to 200. The index then
   * follows Cauchy's law through `ior` at 587.6 nm with V_d = (n_d - 1) / (n_F - n_C) (486.1 and 656.3 nm): about 64
   * for crown glass, 30-40 for flint, 55 for diamond, 20 for strongly dispersive glass. Light through it splits into
   * colours (traced per wavelength, 380-780 nm); it is not light-sampled through (README, "Lighting").
   */
  abbe?: number;
  /**
   * Compatible addition: linear RGB reflectance at normal incidence (F0) of the metal lobe, each component 0 to 1.
   * Default `color`; set it when the metal lobe and the diffuse or plastic part of a `blend` differ (MagicaVoxel
   * reflects `min(1, specular x color)` from its metal lobe and `color` from the rest).
   */
  metalColor?: TraceVec3;
  /**
   * Compatible addition: how the dielectric coat of `plastic`, `metal` (below full metalness) and `blend` combines with
   * the diffuse base: 'layered' (default) takes the coat's reflection out of the light reaching the base; 'additive'
   * adds the coat on top of the full diffuse base, as MagicaVoxel does (brighter by up to the coat's Fresnel).
   */
  coat?: 'layered' | 'additive';
  /**
   * Compatible addition: whether `color` tints light entering glass and blend volumes (true, default). false: glass is
   * clear at its faces and `color` acts only through `density` absorption, as in MagicaVoxel.
   */
  tint?: boolean;
}

/** A dense voxel model, shared by any number of instances. */
export interface TraceModel {
  /** Unique, non-empty id that instances reference. */
  id: string;
  /**
   * Content revision: a model whose id, revision and size match the previous scene's reuses its packed and uploaded
   * data without reading `voxels` again. Change it whenever the voxels change. Ignored for reuse when `contentKey` is
   * set.
   */
  revision: number;
  /**
   * Compatible addition: an identity of the voxel contents that never stands for two different contents (a content
   * hash, a serial given to one immutable buffer, or the buffer object itself). With it, the model reuses the packed
   * and uploaded data of a model of the previous scene, or an earlier model of this scene, with the same key (compared
   * as a Map compares keys) and size, whatever its id or revision; it never reuses a model's data packed under another
   * key or without one. Without it, id, revision and size decide as above, and only among models packed without a key.
   */
  contentKey?: string | number | symbol | object;
  /** Integer dimensions `[x, y, z]`, each 1 to 256 (y is up). */
  size: TraceVec3;
  /** Dense palette indices, `index = x + size[0] * (z + size[2] * y)`; 0 is empty. Read, never kept or changed. */
  voxels: Uint8Array;
}

/** One placement of a model. */
export interface TraceInstance {
  /** Unique, non-empty id. */
  id: string;
  /** Id of a model of the same scene. */
  modelId: string;
  /**
   * 16 finite numbers, column-major, model-local to world affine transform (last row 0, 0, 0, 1; invertible). In model
   * space voxel `(x, y, z)` fills the unit cube from `(x, y, z)` to `(x + 1, y + 1, z + 1)`.
   */
  matrix: readonly number[];
  /** Hidden instances are not traced. Default true. */
  visible?: boolean;
  /**
   * Compatible addition: the transform at shutter open for motion blur (same rules as `matrix`, which is the transform
   * at shutter close). Used when `VoxelPathTracerOptions.shutter` is above 0.
   */
  previousMatrix?: readonly number[];
}

/** Compatible addition: an equirectangular high-dynamic-range environment image. */
export interface TraceEnvironmentMap {
  /** Width in texels, 1 to 8192. */
  width: number;
  /** Height in texels, 1 to 4096. */
  height: number;
  /**
   * Linear RGB or RGBA float texels, row by row from the top (straight up) to the bottom (straight down); length
   * `width * height * 3` or `* 4` (alpha ignored). The centre column faces -Z and the column at three quarters +X.
   */
  data: Float32Array;
  /** Radiance multiplier, 0 or more. Default 1. */
  intensity?: number;
  /** Rotation about +Y in radians. Default 0. */
  rotation?: number;
}

/** Lighting around the voxels. Every field is optional. */
export interface TraceEnvironment {
  /** Constant sky radiance colour, linear RGB. Default [1, 1, 1]. Ignored when `map` is set. */
  skyColor?: TraceVec3;
  /** Sky radiance multiplier, 0 or more. Default 1. */
  skyIntensity?: number;
  /** Direction from a surface toward the sun (normalised internally). Default [0.4, 0.8, 0.3]. */
  sunDirection?: TraceVec3;
  /** Sun colour, linear RGB. Default [1, 1, 1]. */
  sunColor?: TraceVec3;
  /** Sun irradiance on a surface facing it (independent of its angular size), 0 or more. Default 0 (no sun). */
  sunIntensity?: number;
  /** Sun's apparent diameter in radians, 0 (sharp shadows, invisible) to 0.5. Default 0.0093 (the real sun). */
  sunAngularSize?: number;
  /** Albedo of an infinite diffuse ground plane at `groundHeight`; no ground when omitted. */
  groundColor?: TraceVec3;
  /** Height of the ground plane in world units. Default 0. */
  groundHeight?: number;
  /** Compatible addition: an HDR environment image replacing the constant sky, importance sampled. */
  map?: TraceEnvironmentMap;
  /**
   * Compatible addition: a physical daylight sky replacing the constant sky (not together with `map`): Preetham et
   * al.'s analytic model for `sunDirection` and `turbidity`, importance sampled. The sun disk itself stays the `sun*`
   * light.
   */
  physicalSky?: TracePhysicalSky;
  /**
   * Compatible addition: uniform fog filling the space outside volumes. Rays fade over distance d toward the fog's glow
   * by 1 - exp(-density d); the glow is the sky and sun light the fog scatters (Henyey-Greenstein, no shadows), rays
   * leaving the scene see only it, and the sun reaches surfaces only through it, as in MagicaVoxel's uniform fog.
   */
  fog?: TraceFog;
  /**
   * Compatible addition: whether camera rays see the sun disk (true, default). Reflections and lighting are unchanged;
   * false is MagicaVoxel's default (sun disk off).
   */
  sunVisible?: boolean;
  /**
   * Compatible addition: camera rays fade the ground into the sky with distance: where a camera ray meets the ground at
   * distance D, the sky behind it (the environment in the ray's direction, without the sun disk) replaces the share
   * 1 - e^(-(D - groundFadeStart) / groundFade) of it (world units). 0 or absent: no fade; uniform `fog` replaces it.
   * MagicaVoxel's horizon setting h is about 2030 / h from the camera.
   */
  groundFade?: number;
  /** Compatible addition: camera distance at which `groundFade` starts (world units; default 0). */
  groundFadeStart?: number;
  /**
   * Compatible addition: `groundFade` fades models as well as the ground (a game world's far edge into a clear sky, as
   * its distance fog does). Default false.
   */
  fadeModels?: boolean;
  /**
   * Compatible addition: linear radiance camera rays show where they leave the scene, in place of the sky and the sun
   * disk; lighting is unchanged (MagicaVoxel's background colour). Absent: the sky.
   */
  background?: TraceVec3;
}

/** Compatible addition: the uniform fog of {@link TraceEnvironment.fog}. */
export interface TraceFog {
  /** Extinction per world unit, above 0. MagicaVoxel's density d is about 0.001 d per voxel. */
  density: number;
  /** Linear RGB single-scattering colour, each 0 to 1. Default [1, 1, 1]. */
  color?: TraceVec3;
  /** Henyey-Greenstein anisotropy, -0.95 to 0.95. Default 0. */
  anisotropy?: number;
}

/** Compatible addition: the Preetham daylight sky of {@link TraceEnvironment.physicalSky}. */
export interface TracePhysicalSky {
  /** Atmospheric turbidity, 1.7 (very clear) to 10 (hazy). Default 3. */
  turbidity?: number;
  /** Radiance per kcd/m^2 of the model's luminance, 0 or more. Default 0.1 (a clear noon zenith is then about 0.6). */
  intensity?: number;
  /**
   * Below the horizon the sky keeps its horizon colour in each direction (true: a world with no ground under it, such as
   * a game's loaded area, fades into it) instead of black (false, default).
   */
  horizonBelow?: boolean;
}

/** Compatible addition: a block texture for {@link TraceMaterial.texture}. */
export interface TraceTexture {
  /** Width in texels, 1 to 1024. */
  width: number;
  /** Height in texels, 1 to 1024. */
  height: number;
  /** RGBA, 4 bytes per texel, rows from the top; colour sRGB-encoded, alpha linear. */
  data: Uint8Array | Uint8ClampedArray;
}

/** Compatible addition: a rectangular area light. */
export interface TraceAreaLight {
  /** Unique, non-empty id. */
  id: string;
  /** One corner of the rectangle, world units. */
  position: TraceVec3;
  /** First edge from `position` (the rectangle is `position + s * edgeU + t * edgeV`, s and t in 0..1). */
  edgeU: TraceVec3;
  /** Second edge; must not be parallel to `edgeU`. The light faces `cross(edgeU, edgeV)`. */
  edgeV: TraceVec3;
  /** Emitted colour, linear RGB. Default [1, 1, 1]. */
  color?: TraceVec3;
  /** Emitted radiance multiplier, 0 or more. Default 1. */
  intensity?: number;
  /** Emit from both faces. Default false (the back face is dark). */
  twoSided?: boolean;
  /**
   * Compatible addition: the light is a solid panel: it casts shadows (blocks shadow rays and paths from both faces)
   * and a one-sided light shows a black back face. Default true. false restores the earlier behaviour: no shadows,
   * and the back face of a one-sided light is invisible (rays pass through it).
   */
  opaque?: boolean;
  /** Hidden lights neither emit nor show. Default true. */
  visible?: boolean;
}

/** Everything {@link VoxelPathTracer} draws. Validated and copied as a whole by `setScene`. */
export interface VoxelTraceScene {
  /** Caller's revision of the whole scene, reported back in stats. */
  revision: number;
  /** Models; ids unique. */
  models: readonly TraceModel[];
  /** Instances of the models; ids unique. */
  instances: readonly TraceInstance[];
  /** One material per palette index that any instanced model uses; ids unique. */
  materials: readonly TraceMaterial[];
  /** Sky, sun and ground. */
  environment?: TraceEnvironment;
  /** Compatible addition: rectangular area lights (at most 256). */
  lights?: readonly TraceAreaLight[];
  /** Compatible addition: block textures that materials index (at most 4096). */
  textures?: readonly TraceTexture[];
}

/** Options of {@link VoxelPathTracer.attach}; all but `scene` can change later with `setOptions`. */
export interface VoxelPathTracerOptions {
  /** The scene to trace. */
  scene: VoxelTraceScene;
  /**
   * Paths per pixel traced each frame, 1 to 64, or (compatible addition) 'auto': as many as keep frames at the
   * display's pace, adjusted every frame (the viewport converges several times faster on a light scene). Default 1.
   */
  samplesPerFrame?: number | 'auto';
  /** Scattering events per path, 1 to 64 (Russian roulette may end paths earlier after 3). Default 8. */
  maxBounces?: number;
  /** Samples per pixel after which the viewport stops tracing (`stats.converged`), 1 or more or Infinity. Default 1024. */
  maxSamples?: number;
  /** Seed of the sample sequence, an integer 0 to 4294967295: equal seeds give equal images. Default 0. */
  seed?: number;
  /** Traced pixels per drawn pixel along each axis, 0.1 to 2. Default 1. */
  resolutionScale?: number;
  /** Exposure in EV stops (the image is multiplied by 2^exposure before tone mapping), -20 to 20. Default 0. */
  exposure?: number;
  /** Thin-lens aperture diameter in world units, 0 or more; 0 is a pinhole. Default 0. */
  aperture?: number;
  /**
   * Distance from the camera to the plane in focus, world units, above 0. Default: camera position to target
   * (automatic). Compatible addition: null returns to automatic focus (leaving it out of `setOptions` keeps the
   * current distance).
   */
  focusDistance?: number | null;
  /**
   * Edge-avoiding wavelet denoising of the viewport and captures. Default false. Compatible addition: 'auto' denoises
   * the viewport every frame below 32 samples, then each time its samples grow by a quarter and at convergence
   * (clean while moving, at a fraction of the cost); captures denoise.
   */
  denoise?: boolean | 'auto';
  /** Compatible addition: aperture polygon blades, 0 (round) or 3 to 16. Default 0. */
  lensBlades?: number;
  /** Compatible addition: rotation of the aperture polygon in radians. Default 0. */
  lensRotation?: number;
  /**
   * Compatible addition: motion blur, 0 to 1: the share of each instance's move from `previousMatrix` to `matrix` (and
   * of the camera's from `previousCamera` to the engine camera) the shutter stays open for, ending at the current pose.
   * Default 0 (off).
   */
  shutter?: number;
  /**
   * Compatible addition: the camera pose at shutter open, for camera motion blur with `shutter` above 0; the engine
   * camera is the pose at shutter close. Projection, near and far are the engine camera's. null or absent: no camera
   * motion.
   */
  previousCamera?: TracePreviousCamera | null;
  /**
   * Compatible addition: how pixels map to rays. 'camera' (default) uses the engine camera's projection; 'panorama'
   * is an equirectangular 360 x 180 degree view around the camera (azimuth across, elevation down the image, the view
   * direction at the centre); 'fisheye' follows `fisheye`. Both ignore the camera's projection and depth of field.
   */
  projection?: 'camera' | 'panorama' | 'fisheye';
  /** Compatible addition: the fisheye of `projection: 'fisheye'`. */
  fisheye?: TraceFisheye;
  /**
   * Compatible addition: Brown-Conrady lens distortion of the 'camera' projection; null or absent: none. Coordinates
   * are measured from the image centre in units of half the image height (y up).
   */
  distortion?: TraceLensDistortion | null;
  /** Compatible addition: largest luminance one path may add (firefly clamp; biased), above 0 or Infinity. Default Infinity. */
  clamp?: number;
  /**
   * Compatible addition: 'neutral' (Khronos PBR Neutral, Margo's display transform), 'linear' (clipped) or
   * 'aces-narkowicz' (Krzysztof Narkowicz's per-channel fit of the ACES film curve after a 0.6 pre-scale, MagicaVoxel's
   * film). Default 'neutral'.
   */
  toneMapping?: 'neutral' | 'linear' | 'aces-narkowicz';
  /**
   * Compatible addition: display encoding after tone mapping: undefined (default) encodes sRGB; a number from 1 to 5
   * raises to the power 1 / gamma (MagicaVoxel encodes with 2.2).
   */
  gamma?: number;
  /**
   * Compatible addition: caps on scattering events of each kind along a path, on top of `maxBounces`: diffuse lobes,
   * specular ones (metal, coats, glass) and media. A path reaching a capped kind's next event ends there, after adding
   * the light it met. null or absent: no caps. MagicaVoxel's defaults are 2, 5 and 5.
   */
  bounceLimits?: TraceBounceLimits | null;
  /**
   * Compatible addition: whether shadow rays toward the sun, emissive voxels and area lights pass through glass
   * (refracted, tinted) and media (attenuated): true (default); false: any voxel blocks them, as with MagicaVoxel's
   * TR-Shadow off. Paths that find a light through glass by scattering still count it.
   */
  transparentShadows?: boolean;
  /**
   * Compatible addition: whether the sun lights glossy and specular lobes (highlights on metal, coats and glass) and is
   * seen in reflections: true (default); false: only diffuse lobes receive the sun, as with MagicaVoxel's MIS-Reflect
   * off. The sky and other lights are unchanged.
   */
  sunSpecular?: boolean;
  /**
   * Compatible addition: whether the sun lights media directly: true (default); false: media are lit by the sky and
   * other surfaces only, as with MagicaVoxel's MIS-Scatter off.
   */
  sunInMedia?: boolean;
  /**
   * Compatible addition: whether rough metal and rough glass get back the energy their single-scattering microfacet
   * model loses (Kulla-Conty and albedo normalisation): true (default); false: they darken with roughness, as in
   * MagicaVoxel.
   */
  energyCompensation?: boolean;
  /**
   * Compatible addition: darkens the image away from its centre by 1 / (1 + t^2)^2, t = vignette x r / (0.2238 x
   * image height), r the distance from the centre in pixels (a cos^4 falloff, MagicaVoxel's `_vig`), in the viewport
   * and in captures. 0 (default) is off.
   */
  vignette?: number;
  /**
   * Compatible addition: camera rays see a band `width` (voxels) wide along voxel edges where the shape turns
   * (outer and inner corners), in `color` lit as a diffuse surface (MagicaVoxel's edges). null (default) is off.
   */
  edges?: TraceEdges | null;
  /**
   * Compatible addition: camera rays see lines every `spacing` world units on the ground, and with `onVoxels` on
   * voxel faces too, `2 x width` wide, in `color` lit as a diffuse surface (MagicaVoxel's grid). null (default) is
   * off.
   */
  grid?: TraceGrid | null;
  /** Compatible addition: frame-graph order of the pass that draws the traced image. Default 20. */
  order?: number;
}

/** Compatible addition: edge bands (VoxelPathTracerOptions.edges). */
export interface TraceEdges {
  /** Linear RGB. */
  color: TraceVec3;
  /** Band width from the edge, in voxels (0 to 0.5). */
  width: number;
}

/** Compatible addition: grid lines (VoxelPathTracerOptions.grid). */
export interface TraceGrid {
  /** Linear RGB. */
  color: TraceVec3;
  /** Distance between lines, world units. */
  spacing: number;
  /** Half the line width, world units. */
  width: number;
  /** Lines on voxel faces as well as the ground. Default false. */
  onVoxels?: boolean;
}

/** Compatible addition: per-kind caps of {@link VoxelPathTracerOptions.bounceLimits}, each 1 to 64; absent: no cap. */
export interface TraceBounceLimits {
  /** Diffuse scattering events (Lambert lobes, the ground). */
  diffuse?: number;
  /** Specular and glossy events: metal and coat reflections, glass reflection and refraction. */
  specular?: number;
  /** Scattering events in media and interior scattering. */
  scatter?: number;
}

/**
 * Compatible addition: a circular fisheye centred in the image, its circle the image height. A ray at angle theta from
 * the view direction lands at radius r (in half image heights): theta = r fov / 2 (equidistant) or
 * sin(theta / 2) = r sin(fov / 4) (equisolid, equal area). Pixels outside the circle are black.
 */
export interface TraceFisheye {
  /** 'equidistant' (default) or 'equisolid'. */
  mapping?: 'equidistant' | 'equisolid';
  /** Field of view across the circle in degrees, above 0 to 360. Default 180. */
  fov?: number;
}

/**
 * Compatible addition: Brown-Conrady distortion: an undistorted point (x, y), r^2 = x^2 + y^2, is seen at
 * x (1 + k1 r^2 + k2 r^4) + 2 p1 x y + p2 (r^2 + 2 x^2), y (1 + k1 r^2 + k2 r^4) + p1 (r^2 + 2 y^2) + 2 p2 x y.
 * Negative k1 is barrel distortion, positive pincushion. Each coefficient -1 to 1, default 0.
 */
export interface TraceLensDistortion {
  /** Radial r^2 coefficient. */
  k1?: number;
  /** Radial r^4 coefficient. */
  k2?: number;
  /** First tangential (decentring) coefficient. */
  p1?: number;
  /** Second tangential coefficient. */
  p2?: number;
}

/** Compatible addition: a camera pose for {@link VoxelPathTracerOptions.previousCamera}. */
export interface TracePreviousCamera {
  /** Eye position, world units. */
  position: TraceVec3;
  /** Look-at point, world units; must differ from `position`. */
  target: TraceVec3;
  /** Screen-up direction, not parallel to the view. Default: the engine camera's `up`. */
  up?: TraceVec3;
  /** Vertical field of view in degrees, in (0, 180), for perspective cameras. Default: the engine camera's. */
  fov?: number;
}

/** What {@link VoxelPathTracer.stats} reports. */
export interface VoxelPathTracerStats {
  /** Samples per pixel accumulated in the viewport image. */
  samples: number;
  /** Wall-clock milliseconds between the last two traced viewport frames (includes waiting for the display). */
  frameMs: number;
  /** Bytes of GPU buffers and textures the tracer holds (scene, accumulation, denoiser, captures in progress). */
  gpuBytes: number;
  /** True once `samples` reached `maxSamples`; tracing pauses until something changes. */
  converged: boolean;
  /** Compatible addition: traced viewport width in pixels (0 before the first frame). */
  width: number;
  /** Compatible addition: traced viewport height in pixels. */
  height: number;
  /** Compatible addition: the width `resolutionScale` asked for (drawing buffer x scale; 0 before the first frame). */
  requestedWidth: number;
  /** Compatible addition: the height it asked for. */
  requestedHeight: number;
  /**
   * Compatible addition: why `width` x `height` is below the requested size: 'storage-binding' (an image of 16 bytes
   * per pixel would not fit the device's `maxStorageBufferBindingSize`) or 'texture-dimension' (the denoiser's history
   * textures would exceed `maxTextureDimension2D`). Absent at the requested size. See `traceViewportSize`.
   */
  limitedBy?: 'storage-binding' | 'texture-dimension';
  /** Compatible addition: revision of the scene being traced. */
  sceneRevision: number;
  /** Compatible addition: models the last `attach` or `setScene` packed from their voxels. */
  packedModels: number;
  /** Compatible addition: models it reused already packed (by `contentKey`, or by id, revision and size). */
  reusedModels: number;
  /** Compatible addition: captures and `renderImage` calls queued or running (see `whenIdle`). */
  renders: number;
}

/** Compatible addition: options of {@link VoxelPathTracer.renderImage} (and the base of `capture`). */
export interface VoxelTraceRenderOptions {
  /** Output width in pixels, 1 to 16384. */
  width: number;
  /** Output height in pixels, 1 to 16384. */
  height: number;
  /** Samples per pixel, 1 to 1048576. */
  samples: number;
  /** Cancels the render; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Denoise the result. Default: the tracer's `denoise` option. */
  denoise?: boolean;
  /** Jitter each sample inside its pixel (anti-aliasing). false traces pixel centres only. Default true. */
  jitter?: boolean;
  /** Also return albedo, normal, depth and instance/palette ids of the first hits. Default false. */
  aovs?: boolean;
  /** Seed for this render. Default: the tracer's `seed`. */
  seed?: number;
  /**
   * Trace dispersive glass at this one wavelength (nanometres, 380 to 780) with weight 1 instead of over the spectrum:
   * a monochromatic image for checking refraction per wavelength. Default: the whole spectrum.
   */
  wavelength?: number;
  /**
   * A transparent background: camera rays that leave the scene add nothing (rays that bounce still see the sky and
   * are lit by it), and `alpha` gives each pixel's share of camera rays that hit the scene. `color` is then
   * premultiplied by it. Default false.
   */
  transparent?: boolean;
}

/** Compatible addition: a rendered linear image from {@link VoxelPathTracer.renderImage}. */
export interface VoxelTraceImage {
  /** Width in pixels. */
  readonly width: number;
  /** Height in pixels. */
  readonly height: number;
  /** Samples per pixel. */
  readonly samples: number;
  /** Linear RGB radiance, 3 floats per pixel, rows from the top, before exposure and tone mapping. */
  readonly color: Float32Array;
  /** With `aovs`: mean first non-mirror-hit albedo, 3 floats per pixel (1 for sky). */
  readonly albedo?: Float32Array;
  /** With `aovs`: mean first non-mirror-hit world normal, 3 floats per pixel. */
  readonly normal?: Float32Array;
  /** With `aovs`: distance from the camera to the first hit along the pixel's ray, Infinity for sky. */
  readonly depth?: Float32Array;
  /** With `aovs`: index into `scene.instances` hit by the pixel-centre ray; -1 sky, -2 ground, -3 area light. */
  readonly instance?: Int32Array;
  /** With `aovs`: palette index hit by the pixel-centre ray, 0 when no voxel was hit. */
  readonly palette?: Uint8Array;
  /**
   * With `transparent`: the share of the pixel's camera rays (8 x 8 strata, through the lens) that hit a voxel, the
   * ground or an area light, 0 to 1.
   */
  readonly alpha?: Float32Array;
}

/** Compatible addition: options of {@link VoxelPathTracer.capture}. */
export interface VoxelTraceCaptureOptions {
  /** PNG width in pixels, 1 to 16384. */
  width: number;
  /** PNG height in pixels, 1 to 16384 (width x height at most 67,108,864). */
  height: number;
  /** Samples per pixel, 1 to 1048576. */
  samples: number;
  /** Cancels the capture; the promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Compatible addition: denoise the capture. Default: the tracer's `denoise` option. */
  denoise?: boolean;
  /**
   * Compatible addition: a transparent background. The PNG gets an alpha channel, the share of each pixel's camera
   * rays that hit the scene (voxels, the ground, area lights); camera rays that leave it add nothing, and colours are
   * stored unpremultiplied. Rays that bounce still see the sky and are lit by it. Default false.
   */
  transparent?: boolean;
}

/** Compatible addition: a voxel found by {@link VoxelPathTracer.raycast}. */
export interface VoxelTraceHit {
  /** Id of the instance hit. */
  readonly instanceId: string;
  /** Id of its model. */
  readonly modelId: string;
  /** Model-local voxel cell hit. */
  readonly cell: TraceVec3;
  /** Model-local unit normal of the face hit (one axis, toward the ray's origin). */
  readonly normal: TraceVec3;
  /** The empty cell in front of the face (`cell + normal`; may lie outside the model). */
  readonly adjacent: TraceVec3;
  /** Palette index of the cell. */
  readonly paletteIndex: number;
  /** World distance from the ray origin along the normalised direction. */
  readonly distance: number;
  /** World point hit. */
  readonly point: TraceVec3;
}

/**
 * Compatible addition: the options a tracer runs with, every default filled in: {@link VoxelPathTracer.options},
 * `resolveTraceOptions` and `VOXEL_PATHTRACER_DEFAULTS`. Fields that may be absent are off (`previousCamera`,
 * `distortion`, `bounceLimits`, `edges`, `grid`), automatic (`focusDistance`) or sRGB (`gamma`) when absent.
 */
export type ResolvedTraceOptions = Omit<
  Required<VoxelPathTracerOptions>,
  'scene' | 'focusDistance' | 'previousCamera' | 'distortion' | 'fisheye' | 'gamma' | 'bounceLimits' | 'edges' | 'grid'
> & {
  focusDistance?: number;
  previousCamera?: TracePreviousCamera;
  fisheye: Required<TraceFisheye>;
  distortion?: Required<TraceLensDistortion>;
  gamma?: number;
  bounceLimits?: TraceBounceLimits;
  edges?: TraceEdges;
  grid?: Required<TraceGrid>;
};

/**
 * Compatible addition: a material with every field resolved by `resolveTraceMaterial`: the defaults of its type filled
 * in (`emissionColor` and `metalColor` default to `color`, `cameraEmission` to `emission`), `texture` as six face
 * indices when set.
 */
export type ResolvedTraceMaterial = Required<Omit<TraceMaterial, 'texture'>> & {
  texture?: readonly [number, number, number, number, number, number];
};

/** Compatible addition: one invalid field found by `validateTraceOptions` or `validateTraceMaterial`. */
export interface TraceProblem {
  /** The option or material field (empty for the object as a whole). */
  readonly field: string;
  /** The error the tracer would throw for it, naming the fix. */
  readonly error: TypeError | RangeError;
}

/** Compatible addition: what `validateTraceOptions` and `validateTraceMaterial` report. */
export interface TraceValidation {
  /** True exactly when the tracer would accept the input. */
  readonly ok: boolean;
  /** Every invalid field, in the input's order. */
  readonly problems: readonly TraceProblem[];
  /** Fields the tracer does not know (it ignores them; they do not make `ok` false). */
  readonly unknown: readonly string[];
}

/** Compatible addition: the device limits `traceViewportSize` reads (a `GPUSupportedLimits` has them). */
export interface TraceViewportLimits {
  /** Bytes one storage buffer binding may span. */
  readonly maxStorageBufferBindingSize: number;
  /** Largest texture side in texels. Default 8192 (WebGPU's default). */
  readonly maxTextureDimension2D?: number;
}

/** Compatible addition: the viewport size `traceViewportSize` returns (and `stats` reports). */
export interface TraceViewportSize {
  /** Traced width in pixels. */
  readonly width: number;
  /** Traced height in pixels. */
  readonly height: number;
  /** Width the drawing buffer and `resolutionScale` asked for. */
  readonly requestedWidth: number;
  /** Height they asked for. */
  readonly requestedHeight: number;
  /** The device limit that reduced the size; absent at the requested size. */
  readonly limitedBy?: 'storage-binding' | 'texture-dimension';
}
