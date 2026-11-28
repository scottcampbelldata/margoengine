// Material presets: plain option objects for `new PbrMaterial({...preset, map})`, so a look is one import and every
// value stays editable. The library (measured.ts) holds metals as F0 from measured complex indices, clear dielectrics
// as measured refractive indices and everyday surfaces as albedo from measured reflectance spectra; every row names
// its source and its provenance. The few looks no measurement covers are art defaults and are marked so.

import { DIELECTRIC_DATA, METAL_DATA, SOURCES, SURFACE_DATA } from './measured.js';
import type { DielectricName, MetalName, SurfaceName } from './measured.js';

export type { DielectricName, MetalName, SurfaceName } from './measured.js';
import type { MeasuredDielectric, MeasuredMetal, MeasuredSurface, Provenance } from './measured-types.js';

export type { MeasuredDielectric, MeasuredMetal, MeasuredSurface, Provenance } from './measured-types.js';
export { SOURCES };

/**
 * What a preset holds: the PbrMaterial options it sets. `color` is linear [r, g, b], which both core's and this
 * package's `PbrMaterial` take (core's accepts exactly three values).
 */
export interface MaterialPreset {
  readonly color: readonly [number, number, number];
  readonly roughness: number;
  readonly metalness: number;
  /** Index of refraction, set by dielectric and surface presets (PbrMaterial's default is 1.5). */
  readonly ior?: number;
}
/** Options of {@link metal}, {@link dielectric} and {@link surface}. */
export interface PresetOptions {
  /** Perceptual roughness 0 to 1. Default: the row's art default. */
  readonly roughness?: number;
}
/** Any material of the library. */
export type MaterialName = MetalName | DielectricName | SurfaceName;

/** Metals by name: F0, n and k, art roughness, provenance and source. */
export const METALS: Readonly<Record<MetalName, MeasuredMetal>> = METAL_DATA;
/** Clear dielectrics by name: IOR, Abbe number, provenance and source. */
export const DIELECTRICS: Readonly<Record<DielectricName, MeasuredDielectric>> = DIELECTRIC_DATA;
/** Everyday surfaces by name: albedo, roughness range, IOR, provenance, samples and source. */
export const SURFACES: Readonly<Record<SurfaceName, MeasuredSurface>> = SURFACE_DATA;

const preset = (r: number, g: number, b: number, roughness: number, metalness: number, ior?: number): MaterialPreset =>
  Object.freeze(
    ior === undefined
      ? { color: Object.freeze([r, g, b] as const), roughness, metalness }
      : { color: Object.freeze([r, g, b] as const), roughness, metalness, ior },
  );
function row<T>(table: Readonly<Record<string, T>>, kind: string, name: string): T {
  if (!Object.prototype.hasOwnProperty.call(table, name))
    throw new RangeError(`Unknown ${kind} '${name}'; expected one of ${Object.keys(table).join(', ')}`);
  return table[name];
}
function roughnessOf(options: PresetOptions | undefined, fallback: number): number {
  const r = options?.roughness ?? fallback;
  if (!(r >= 0 && r <= 1)) throw new RangeError(`roughness must be 0 to 1, got ${r}`);
  return r;
}

/**
 * A metal preset: `color` is its linear F0, `metalness` 1.
 * @throws RangeError for a name not in {@link METALS} or a roughness outside 0 to 1.
 * @example new PbrMaterial(metal('gold', { roughness: 0.15 }))
 */
export function metal(name: MetalName, options?: PresetOptions): MaterialPreset {
  const m = row(METALS, 'metal', name);
  return preset(m.color[0], m.color[1], m.color[2], roughnessOf(options, m.roughness), 1);
}
/**
 * A clear dielectric preset: white, `metalness` 0, the measured `ior`. Add transmission for glass and water.
 * @throws RangeError for a name not in {@link DIELECTRICS} or a roughness outside 0 to 1.
 * @example new PbrMaterial({ ...dielectric('windowGlass'), transmission: { factor: 1 } })
 */
export function dielectric(name: DielectricName, options?: PresetOptions): MaterialPreset {
  const d = row(DIELECTRICS, 'dielectric', name);
  return preset(1, 1, 1, roughnessOf(options, d.roughness), 0, d.ior);
}
/**
 * An everyday surface preset: its measured albedo, `metalness` 0, its IOR.
 * @throws RangeError for a name not in {@link SURFACES} or a roughness outside 0 to 1.
 * @example new PbrMaterial(surface('limestone'))
 */
export function surface(name: SurfaceName, options?: PresetOptions): MaterialPreset {
  const s = row(SURFACES, 'surface', name);
  return preset(s.color[0], s.color[1], s.color[2], roughnessOf(options, s.roughness), 0, s.ior);
}

/** What {@link materialInfo} returns: the row, its kind and its citation. */
export interface MaterialInfo {
  readonly kind: 'metal' | 'dielectric' | 'surface';
  readonly provenance: Provenance;
  readonly citation: string;
  readonly row: MeasuredMetal | MeasuredDielectric | MeasuredSurface;
}
/**
 * The row of a library material, with its kind, provenance and citation.
 * @throws RangeError for a name the library does not hold.
 */
export function materialInfo(name: MaterialName): MaterialInfo {
  const tables = [
    ['metal', METALS],
    ['dielectric', DIELECTRICS],
    ['surface', SURFACES],
  ] as const;
  for (const [kind, table] of tables)
    if (Object.prototype.hasOwnProperty.call(table, name)) {
      const r = (table as Readonly<Record<string, MeasuredMetal | MeasuredDielectric | MeasuredSurface>>)[name];
      return Object.freeze({ kind, provenance: r.provenance, citation: SOURCES[r.source], row: r });
    }
  throw new RangeError(`Unknown material '${name}'`);
}

/** Every library material as a preset at its default roughness, by name: `materials.gold`, `materials.limestone`. */
export const materials: Readonly<Record<MaterialName, MaterialPreset>> = /* @__PURE__ */ (() => {
  const out: Record<string, MaterialPreset> = {};
  for (const name of Object.keys(METALS)) out[name] = metal(name as MetalName);
  for (const name of Object.keys(DIELECTRICS)) out[name] = dielectric(name as DielectricName);
  for (const name of Object.keys(SURFACES)) out[name] = surface(name as SurfaceName);
  return Object.freeze(out) as Record<MaterialName, MaterialPreset>;
})();

/** Polished copper: measured F0 (Johnson and Christy 1972), roughness 0.3. */
export const copper = /* @__PURE__ */ metal('copper');
/** Copper under an oxide film and smoke: copper's F0 at 0.6 of its value, rougher (0.55). An art default. */
export const tarnishedCopper = /* @__PURE__ */ preset(
  METAL_DATA.copper.color[0] * 0.6,
  METAL_DATA.copper.color[1] * 0.6,
  METAL_DATA.copper.color[2] * 0.6,
  0.55,
  1,
);
/** Bare iron: measured F0 (Johnson and Christy 1974), roughness 0.6. */
export const iron = /* @__PURE__ */ metal('iron');
/** Blackened cast iron (stove, fire dogs, kettle): iron's F0 at 0.35, roughness 0.75. An art default. */
export const castIron = /* @__PURE__ */ preset(
  METAL_DATA.iron.color[0] * 0.35,
  METAL_DATA.iron.color[1] * 0.35,
  METAL_DATA.iron.color[2] * 0.35,
  0.75,
  1,
);
/** Soot and charcoal: linear albedo 0.03, matte (0.95). An art default (measured cinders are 0.04: `surface('cinders')`). */
export const soot = preset(0.03, 0.028, 0.026, 0.95, 0);
/** Stone darkened by years of smoke (hearthstone): linear albedo about 0.04, roughness 0.85. An art default. */
export const hearthstone = preset(0.042, 0.036, 0.03, 0.85, 0);
/**
 * Grey, sun-bleached wood (logs, beams): linear albedo about 0.2 (sRGB #8b7d6b), roughness 0.82. An art default: at
 * about 0.13 a moonlit log wall (Cabin Hearth) read black in every outside shot, as the fresh, dark wood (0.06) did.
 * No weathered-wood spectrum is in the library yet.
 */
export const weatheredWood = preset(0.258, 0.205, 0.147, 0.82, 0);
/** Fired red clay brick: measured albedo (ECOSTRESS, three bricks), roughness 0.85. */
export const brick = /* @__PURE__ */ surface('brick');
