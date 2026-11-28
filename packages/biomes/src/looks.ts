// The ground-material looks of BiomeView (`MATERIALS`) and the look families over them (`BIOME_LOOKS`,
// `biomeMaterials`), apart from the view so a page or the scenes look family can pick a family without loading the view.
// `@margoengine/biomes/view` and `@margoengine/biomes/settings` both export them.
import { rangeError } from '../../shared/errors.js';

/** The look of a ground material: sRGB colour 0..1, the contrast of its generated detail 0..1 and its relief. */
export interface MaterialLook {
  readonly color: readonly [number, number, number];
  /** Default 0.25. */
  readonly detail?: number;
  /**
   * Relief from the generated detail, 0 to 1: the terrain's `TerrainLayer.bump` (the shading normal follows the
   * texture's light and dark, up to 2 m of relief at 1). Default 0.
   */
  readonly bump?: number;
  /**
   * Large-scale light and dark, 0 to 1: the terrain's `TerrainLayer.macro` (a second sample of the texture at 96 m
   * scales the colour, so far slopes are not one flat tone). Default 0.
   */
  readonly macro?: number;
  /**
   * A photographed ground texture (a CC0 scan such as Poly Haven's `leafy_grass`) in place of the generated detail:
   * RGBA8 sRGB pixels, square, 64 to 4,096 texels a side. The view draws its pattern with its mean brought to `color`
   * (each channel scaled), so one scan serves a green summer field or a dun winter one; `detail` is then unused. Every
   * view layer is redrawn at 1,024 texels a side when any material has an image. Default none (generated detail).
   */
  readonly image?: GroundImage;
  /** Metres of ground one repeat of the texture covers, 0.5 to 64. Default 4. */
  readonly repeat?: number;
}

/** A material after a look family: its colour, detail, relief and macro set; its image and repeat as given. */
export type LookedMaterial = MaterialLook & Required<Pick<MaterialLook, 'color' | 'detail' | 'bump' | 'macro'>>;

/** A ground texture's pixels for {@link MaterialLook.image}: RGBA8 sRGB, `width` = `height`, rows top first. */
export interface GroundImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** Built-in material looks, by key (the materials the presets use). Unknown keys get a neutral grey-brown. */
export const MATERIALS: Readonly<Record<string, MaterialLook>> = Object.freeze({
  grass: { color: [0.4, 0.55, 0.2], detail: 0.4, bump: 0.3, macro: 0.35 },
  meadow: { color: [0.56, 0.62, 0.28], detail: 0.4, bump: 0.3, macro: 0.35 },
  'leaf-litter': { color: [0.52, 0.37, 0.2], detail: 0.4, bump: 0.3, macro: 0.2 },
  // Conifer needle litter: white fir (Abies concolor) dry needles, ECOSTRESS Spectral Library 1.0 (Meerdink et al.,
  // "The ECOSTRESS spectral library version 1.0", Remote Sensing of Environment 230, 2019,
  // https://speclib.jpl.nasa.gov), samples VH325, VH326 and VH327 (UCSB, ASD bidirectional reflectance, Sierra Nevada,
  // 2014). Each spectrum through @margoengine/optics SpectralIntegrator (CIE 1931 fit of Wyman, Sloan and Shirley, JCGT
  // 2(2), 2013, under a 6504 K black body, 5 nm steps), then averaged: linear (0.2025, 0.1356, 0.0805), sRGB below.
  // Until 2026-11-28 it was (0.46, 0.32, 0.18), blue at a sixth of red in linear light against 0.40 measured, so the
  // forest floor read orange from the air.
  needles: { color: [0.487, 0.404, 0.314], detail: 0.35, bump: 0.3, macro: 0.2 },
  moss: { color: [0.32, 0.5, 0.2], detail: 0.4, bump: 0.3, macro: 0.2 },
  mud: { color: [0.4, 0.31, 0.21], detail: 0.25, bump: 0.3, macro: 0.2 },
  sand: { color: [0.9, 0.8, 0.58], detail: 0.15, bump: 0.25, macro: 0.3 },
  'red-sand': { color: [0.82, 0.5, 0.3], detail: 0.2, bump: 0.3, macro: 0.2 },
  // Cured grass: wild oat (Avena fatua) litter, ECOSTRESS Spectral Library 1.0 samples VH354 and VH355, the same path as
  // needles: linear (0.3476, 0.2394, 0.0983). Until 2026-11-28 it was (0.78, 0.67, 0.38), twice the measured brightness.
  'dry-grass': { color: [0.624, 0.527, 0.346], detail: 0.35, bump: 0.3, macro: 0.2 },
  laterite: { color: [0.68, 0.38, 0.22], detail: 0.25, bump: 0.3, macro: 0.2 },
  rock: { color: [0.54, 0.51, 0.47], detail: 0.45, bump: 1, macro: 0.5 },
  scree: { color: [0.64, 0.61, 0.57], detail: 0.4, bump: 0.8, macro: 0.6 },
  gravel: { color: [0.6, 0.57, 0.52], detail: 0.4, bump: 0.6, macro: 0.5 },
  snow: { color: [0.95, 0.96, 0.99], detail: 0.1, bump: 0.35, macro: 0.15 },
  tundra: { color: [0.54, 0.5, 0.34], detail: 0.35, bump: 0.3, macro: 0.2 },
  heather: { color: [0.52, 0.36, 0.4], detail: 0.35, bump: 0.3, macro: 0.2 },
  canopy: { color: [0.12, 0.2, 0.08], detail: 0.3, bump: 0.2, macro: 0.4 },
  // Ground under river and lake water: the dark blue-green a stream reads as from afar, where the terrain's coarse rings
  // cover the water itself (the view paints it on every texel under a river's or lake's surface).
  riverbed: { color: [0.1, 0.19, 0.2], detail: 0.15, bump: 0.05, macro: 0.2 },
});

/** The values of a ground-material look family: each multiplies the material's own number (1 keeps it). */
export interface BiomeLookValues {
  /** Colour saturation about its Rec. 709 luma, 0 or more. 1 keeps the colour. */
  readonly saturation: number;
  /** Contrast of the generated detail. */
  readonly detail: number;
  /** Relief from that detail. */
  readonly bump: number;
  /** Large-scale light and dark. */
  readonly macro: number;
}
/**
 * Look families for ground materials, only multipliers of `MATERIALS` (or your own table). `natural` keeps every
 * material. `animatedFeature` is derived from the animated-feature aims of the film roadmap (larger colour masses, lower
 * fine-detail contrast, more macro variation, saturation up 10 to 15 percent): saturation 1.12, fine detail at 0.6 and
 * relief at 0.8 of the material's, large-scale variation 1.4 times, so ground reads as broad soft colour fields.
 */
export const BIOME_LOOKS = {
  natural: { saturation: 1, detail: 1, bump: 1, macro: 1 },
  animatedFeature: { saturation: 1.12, detail: 0.6, bump: 0.8, macro: 1.4 },
} as const satisfies Record<string, BiomeLookValues>;
/** The name of a family in {@link BIOME_LOOKS}. */
export type BiomeLookName = keyof typeof BIOME_LOOKS;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/**
 * A table of material looks with a family applied, for `BiomeViewOptions.materials`: every key of `base` (default
 * `MATERIALS`) with its colour's saturation and its detail, bump and macro scaled by the family's values, each kept in 0 to 1.
 * @throws RangeError for a family not in {@link BIOME_LOOKS}, or a multiplier that is negative or not finite.
 * @example await BiomeView.attach(engine, world, { materials: biomeMaterials('animatedFeature') });
 */
export function biomeMaterials(
  look: BiomeLookName | BiomeLookValues,
  base: Readonly<Record<string, MaterialLook>> = MATERIALS,
): Record<string, LookedMaterial> {
  const v: BiomeLookValues | undefined =
    typeof look === 'string' ? (BIOME_LOOKS as Record<string, BiomeLookValues>)[look] : look;
  if (!v)
    throw rangeError(`Unknown biome look ${String(look)}; use one of ${Object.keys(BIOME_LOOKS).join(', ')}`, 'biomes');
  for (const key of ['saturation', 'detail', 'bump', 'macro'] as const)
    if (!(v[key] >= 0 && Number.isFinite(v[key])))
      throw rangeError(`Invalid biome look ${key}; use a finite number of 0 or more`, 'biomes');
  const out: Record<string, LookedMaterial> = {};
  for (const [key, m] of Object.entries(base)) {
    const luma = 0.2126 * m.color[0] + 0.7152 * m.color[1] + 0.0722 * m.color[2];
    out[key] = {
      color: m.color.map((c) => clamp01(luma + (c - luma) * v.saturation)) as unknown as [number, number, number],
      detail: clamp01((m.detail ?? 0.25) * v.detail),
      bump: clamp01((m.bump ?? 0) * v.bump),
      macro: clamp01((m.macro ?? 0) * v.macro),
      ...(m.image ? { image: m.image } : {}),
      ...(m.repeat !== undefined ? { repeat: m.repeat } : {}),
    };
  }
  return out;
}
