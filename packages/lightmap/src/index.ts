// @margoengine/lightmap: bakes lighting and material textures for quad meshes into one padded UV atlas, on the CPU.
import type { BakeLight } from '@margoengine/bvh/bake';
import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import { bake } from './bake.js';

/** The quads to bake: world-space parallelograms, each its own chart. */
export interface LightmapQuads {
  /** 12 floats per quad: corners p0, p1, p2, p3 counterclockwise, with p2 = p1 + p3 - p0 (a parallelogram). */
  positions: Float32Array;
  /** Linear RGBA per quad, each 0 to 1. Default white. */
  albedo?: Float32Array;
  /** Linear RGB radiance per quad, 0 or more. Default black. */
  emission?: Float32Array;
  /** Roughness and metalness per quad, each 0 to 1. Default 0.5 and 0. */
  roughnessMetalness?: Float32Array;
}

/** A texel centre handed to {@link LightmapOptions.surface}, in the same world space as the quads. */
export interface LightmapTexel {
  position: MutableVec3;
  /** The quad's unit normal. */
  normal: MutableVec3;
  /** Position inside the quad, 0 to 1 along p0 -> p1 and p0 -> p3. */
  uv: MutableVec2;
  /** Index of the quad. */
  quad: number;
}

/** Material values a {@link LightmapOptions.surface} callback returns for one texel; each overrides the quad's own. */
export interface LightmapSurface {
  /** Linear RGBA, each 0 or more; with physical radiometry the RGB must be 0 to 1. */
  albedo?: readonly number[];
  /** Linear RGB radiance, each 0 or more. With `emissiveLights` each emitting texel lights the other quads. */
  emission?: readonly number[];
  /** World-space shading normal; written into the normal texture in the quad's tangent frame. */
  normal?: readonly number[];
  roughness?: number;
  metalness?: number;
  /** Alpha written to the albedo texture, 0 to 1. Default the albedo's alpha. */
  opacity?: number;
}

/** Options of {@link bakeLightmap}. Every budget is checked before any texture is allocated or ray traced. */
export interface LightmapOptions {
  /**
   * 'legacy' (default) stores direct irradiance times AO. 'physical' stores irradiance without AO; the consumer applies
   * albedo * (1 - metalness) / pi, and surface albedo RGB must be 0 to 1.
   */
  radiometry?: 'legacy' | 'physical';
  /** Texels per world unit along each quad edge, 0.125 to 16. Default 1. */
  texelsPerUnit?: number;
  /** Gutter texels around each chart, filled from its edge, 1 to 16. Default 2. */
  padding?: number;
  /** Largest atlas side, 8 to 2,048. Default 1,024. */
  maxAtlasSize?: number;
  /** Ambient-occlusion rays per texel, 1 to 128. Default 32. */
  aoRays?: number;
  /** Ambient-occlusion ray length in world units. Default 4. */
  aoDistance?: number;
  /** Unsigned 32-bit seed of the ray directions; the same seed gives the same textures. Default 0. */
  seed?: number;
  /** Direct lights (ambient, directional, point, spot), traced with shadows. Default none. */
  lights?: readonly BakeLight[];
  /** Most quads, 1 to 32,768. Default 32,768. */
  maxCharts?: number;
  /** Most texels, 1 to 1,048,576. Default 262,144. */
  maxSamples?: number;
  /** Most rays, 1 to 67,108,864. Default 16,777,216. */
  maxRays?: number;
  /** Most bytes of textures and working buffers, estimated, 1 to 268,435,456. Default 201,326,592. */
  maxBytes?: number;
  /** Cancels the bake (checked every 256 texels). */
  signal?: AbortSignal;
  /** Called with texels done and texels in all, every 256 texels. */
  onProgress?: (done: number, total: number) => void;
  /** Material at each texel centre, for procedural surfaces; defaults to the quad's own values. */
  surface?: (texel: LightmapTexel) => LightmapSurface;
}

/** Where one quad's texels sit in the atlas, in pixels from the top-left; the gutter lies outside this box. */
export interface LightmapChart {
  x: number;
  y: number;
  width: number;
  height: number;
  padding: number;
}

/** What {@link bakeLightmap} returns: RGBA8 textures of one atlas and the UVs that address it. */
export interface Lightmap {
  width: number;
  height: number;
  /** 8 floats per quad: the UV of p0, p1, p2, p3, origin top-left (as glTF and PNG rows). */
  uv: Float32Array;
  charts: LightmapChart[];
  textures: {
    /** sRGB albedo, alpha the opacity. */
    albedo: Uint8Array;
    /** Linear emission divided by `emissionScale`. */
    emission: Uint8Array;
    /** Tangent-space normal, 0.5-biased. */
    normal: Uint8Array;
    /** Linear occlusion, roughness, metalness (glTF ORM). */
    orm: Uint8Array;
    /** Linear ambient occlusion, grey. */
    ao: Uint8Array;
    /** Linear baked lighting divided by `lightmapScale`; physical irradiance excludes AO. */
    lightmap: Uint8Array;
  };
  /** Multiply the lightmap's RGB (0 to 1) by this to get irradiance; at least 1. */
  lightmapScale: number;
  /** Multiply the emission texture's RGB (0 to 1) by this to get radiance; at least 1. */
  emissionScale: number;
  /** Set when the lightmap holds physical irradiance; consumers apply diffuse reflectance divided by pi. */
  radiometry?: 'physical';
  /** Texels baked. */
  samples: number;
  /** Rays reserved (an upper bound of those traced). */
  rays: number;
}

/**
 * Bakes a quad mesh's lighting and materials into one atlas: one padded chart per quad, then at each texel centre the
 * material (albedo, emission, normal, ORM), cosine-weighted ambient occlusion and shadowed direct light, traced through
 * @margoengine/bvh. Point and spot shadows test the segment to the light, skipping the receiving quad. No GPU or DOM
 * is needed. By default the lightmap holds direct irradiance times AO; `radiometry: 'physical'` stores irradiance
 * alone, for a consumer that applies albedo * (1 - metalness) / pi and the AO texture itself. Area lights, emissive
 * quads, bounces and glass come from `bakeGlobalLightmap` (`@margoengine/lightmap/global`). Inputs are copied before
 * the first await; the bake yields every 256 texels for `signal` and `onProgress`.
 */
export function bakeLightmap(quads: LightmapQuads, options: LightmapOptions = {}): Promise<Lightmap> {
  return bake(quads, options);
}

/**
 * A small record of a finished bake for a game asset: its scales, size, radiometry and which terms it holds. Store it
 * with the textures (for example in glTF extras) so a consumer can decode and apply them. `terms` says what the bake
 * included beyond direct light.
 */
export function lightingAsset(
  lightmap: Lightmap,
  terms: { indirect?: boolean; emissive?: boolean; area?: boolean; transmission?: boolean } = {},
): {
  lightmapScale: number;
  emissionScale: number;
  width: number;
  height: number;
  radiometry?: 'physical';
  response?: 'lambertian';
  terms: {
    direct: true;
    occlusion: boolean;
    indirect: boolean;
    emissive: boolean;
    area: boolean;
    transmission: boolean;
  };
} {
  return {
    lightmapScale: lightmap.lightmapScale,
    emissionScale: lightmap.emissionScale,
    width: lightmap.width,
    height: lightmap.height,
    ...(lightmap.radiometry === 'physical' ? { radiometry: 'physical' as const, response: 'lambertian' as const } : {}),
    terms: {
      direct: true,
      occlusion: lightmap.radiometry !== 'physical',
      indirect: terms.indirect ?? false,
      emissive: terms.emissive ?? false,
      area: terms.area ?? false,
      transmission: terms.transmission ?? false,
    },
  };
}

export type { BakeLight } from '@margoengine/bvh/bake';
