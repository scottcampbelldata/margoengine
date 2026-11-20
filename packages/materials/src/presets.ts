// Material presets: plain option objects for `new PbrMaterial({...preset, map})`, so a look is one import and every
// value stays editable. Metal colours are linear F0 at normal incidence from Hoffman, "Background: Physics and Math of
// Shading", SIGGRAPH 2013 course (copper 0.955, 0.638, 0.538; iron 0.562, 0.565, 0.578). Other values are art defaults
// stated as such in the README; none claims a measurement it does not have.

/** What a preset holds: the PbrMaterial options it sets. */
export interface MaterialPreset {
  readonly color: readonly [number, number, number, number];
  readonly roughness: number;
  readonly metalness: number;
}
const preset = (r: number, g: number, b: number, roughness: number, metalness: number): MaterialPreset =>
  Object.freeze({ color: Object.freeze([r, g, b, 1] as const), roughness, metalness });

/** Polished copper: F0 (0.955, 0.638, 0.538), roughness 0.3. */
export const copper = preset(0.955, 0.638, 0.538, 0.3, 1);
/** Copper under an oxide film and smoke: copper's F0 at 0.6 of its value, rougher (0.55). An art default. */
export const tarnishedCopper = preset(0.573, 0.383, 0.323, 0.55, 1);
/** Bare iron: F0 (0.562, 0.565, 0.578), roughness 0.6. */
export const iron = preset(0.562, 0.565, 0.578, 0.6, 1);
/** Blackened cast iron (stove, fire dogs, kettle): iron's F0 at 0.35, roughness 0.75. An art default. */
export const castIron = preset(0.197, 0.198, 0.202, 0.75, 1);
/** Soot and charcoal: linear albedo 0.03, matte (0.95). */
export const soot = preset(0.03, 0.028, 0.026, 0.95, 0);
/** Stone darkened by years of smoke (hearthstone): linear albedo about 0.04, roughness 0.85. An art default. */
export const hearthstone = preset(0.042, 0.036, 0.03, 0.85, 0);
/**
 * Grey, sun-bleached wood (logs, beams): linear albedo about 0.2 (sRGB #8b7d6b), roughness 0.82. An art default: at
 * about 0.13 a moonlit log wall (Cabin Hearth) read black in every outside shot, as the fresh, dark wood (0.06) did.
 */
export const weatheredWood = preset(0.258, 0.205, 0.147, 0.82, 0);
/** Fired clay brick: linear albedo (0.3, 0.1, 0.05), roughness 0.85. An art default. */
export const brick = preset(0.3, 0.1, 0.05, 0.85, 0);
