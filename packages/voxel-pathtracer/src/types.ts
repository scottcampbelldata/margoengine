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
  /** Emitted radiance as a multiple of `color`, 0 or more. Any surface type may emit; `emit` defaults to 1. */
  emission?: number;
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
}

/** A dense voxel model, shared by any number of instances. */
export interface TraceModel {
  /** Unique, non-empty id that instances reference. */
  id: string;
  /**
   * Content revision: a model whose id, revision and size match the previous scene's reuses its packed and uploaded
   * data without reading `voxels` again. Change it whenever the voxels change.
   */
  revision: number;
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
  /** Emit from both faces. Default false (the back face is invisible and dark). */
  twoSided?: boolean;
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
}

/** Options of {@link VoxelPathTracer.attach}; all but `scene` can change later with `setOptions`. */
export interface VoxelPathTracerOptions {
  /** The scene to trace. */
  scene: VoxelTraceScene;
  /** Paths per pixel traced each frame, 1 to 64. Default 1. */
  samplesPerFrame?: number;
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
  /** Distance from the camera to the plane in focus, world units, above 0. Default: camera position to target. */
  focusDistance?: number;
  /** Edge-avoiding wavelet denoising of the viewport and captures. Default false. */
  denoise?: boolean;
  /** Compatible addition: aperture polygon blades, 0 (round) or 3 to 16. Default 0. */
  lensBlades?: number;
  /** Compatible addition: rotation of the aperture polygon in radians. Default 0. */
  lensRotation?: number;
  /**
   * Compatible addition: motion blur, 0 to 1: the share of each instance's move from `previousMatrix` to `matrix` the
   * shutter stays open for (ending at `matrix`). Default 0 (off).
   */
  shutter?: number;
  /** Compatible addition: largest luminance one path may add (firefly clamp; biased), above 0 or Infinity. Default Infinity. */
  clamp?: number;
  /** Compatible addition: 'neutral' (Khronos PBR Neutral, Margo's display transform) or 'linear' (clipped). Default 'neutral'. */
  toneMapping?: 'neutral' | 'linear';
  /** Compatible addition: frame-graph order of the pass that draws the traced image. Default 20. */
  order?: number;
}

/** What {@link VoxelPathTracer.stats} reports. */
export interface VoxelPathTracerStats {
  /** Samples per pixel accumulated in the viewport image. */
  samples: number;
  /** Wall-clock milliseconds between the last two traced viewport frames (includes waiting for the display). */
  frameMs: number;
  /** Bytes of GPU buffers the tracer holds (scene, accumulation, denoiser, captures in progress). */
  gpuBytes: number;
  /** True once `samples` reached `maxSamples`; tracing pauses until something changes. */
  converged: boolean;
  /** Compatible addition: traced viewport width in pixels (0 before the first frame). */
  width: number;
  /** Compatible addition: traced viewport height in pixels. */
  height: number;
  /** Compatible addition: revision of the scene being traced. */
  sceneRevision: number;
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
