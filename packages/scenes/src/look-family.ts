// One call that applies a look family by name through each package's own apply function. The families are plain values
// of each package's settings rows, kept in each package's LOOKS table (`SKY_LOOKS.natural`, `SKY_LOOKS.animatedFeature`,
// `WATER_LOOKS.animatedFeature` and so on, and the ground-material multipliers `BIOME_LOOKS` of biomes); this entry only
// picks the entry by name and hands it to the package's apply function, for each part of the scene the caller gives. It
// adds no look values of its own.
import { SKY_LOOKS, applySkySettings } from '@margoengine/sky/settings';
import { WATER_LOOKS, applyWaterSettings } from '@margoengine/water/settings';
import { TERRAIN_LOOKS, applyTerrainSettings } from '@margoengine/terrain/settings';
import { WEATHER_LOOKS, applyWeatherSettings } from '@margoengine/weather/settings';
import { ENVIRONMENT_LOOKS, applyEnvironmentSettings } from '@margoengine/environment/settings';
import {
  FLAME_LOOKS,
  SAND_LOOKS,
  SMOKE_LOOKS,
  applyFlameSettings,
  applySandSettings,
  applySmokeSettings,
} from '@margoengine/vfx/settings';
import { TONEMAP_LOOKS, applyTonemapSettings } from '@margoengine/tonemap/settings';
import { POST_LOOKS, applyPostSettings } from '@margoengine/post/settings';
import { biomeMaterials, type MaterialLook } from '@margoengine/biomes/settings';

/** The look families: `natural` is every package's own defaults, `animatedFeature` the animated-feature picture style. */
export const LOOK_FAMILIES = ['natural', 'animatedFeature'] as const;
/** The name of a look family in {@link LOOK_FAMILIES}. */
export type LookFamilyName = (typeof LOOK_FAMILIES)[number];

/** The parts of a scene a family can look after; each one given is written through its package's apply function. */
export interface LookFamilyTargets {
  /** For `applySkySettings`: the sky, and optionally its tonemap, grade and volumetric clouds. */
  readonly sky?: Parameters<typeof applySkySettings>[0];
  readonly water?: Parameters<typeof applyWaterSettings>[0];
  readonly terrain?: Parameters<typeof applyTerrainSettings>[0];
  readonly weather?: Parameters<typeof applyWeatherSettings>[0];
  readonly environment?: Parameters<typeof applyEnvironmentSettings>[0];
  /** A `BlownSand` (or any target of `applySandSettings`). */
  readonly sand?: Parameters<typeof applySandSettings>[0];
  /** A `Smoke`, or a `FireFront` for its smoke columns (any target of `applySmokeSettings`). */
  readonly smoke?: Parameters<typeof applySmokeSettings>[0];
  /** A `Fire` (or any target of `applyFlameSettings`): its flames and embers. */
  readonly fire?: Parameters<typeof applyFlameSettings>[0];
  readonly tonemap?: Parameters<typeof applyTonemapSettings>[0];
  readonly post?: Parameters<typeof applyPostSettings>[0];
  /**
   * The options of a `BiomeView` before `BiomeView.attach` (the ground materials are read when the view is built): its
   * `materials` becomes `biomeMaterials(name)`, the built-in `MATERIALS` with the family's multipliers.
   */
  readonly biomes?: { materials?: Readonly<Record<string, MaterialLook>> };
}

const FAMILY_NAMES: readonly string[] = LOOK_FAMILIES;

/**
 * Applies the look family `name` to every part of the scene in `targets`: each part gets that family's entry of its own
 * package's LOOKS table (`natural` is every row at its default, so the part draws as it does with no settings), through
 * that package's apply function. A part left out is left alone. The weather part writes the family's state onto the
 * weather target, so give it only when nothing else (a recorded storm, a drive) owns the weather.
 * @throws RangeError for a family not in {@link LOOK_FAMILIES}; whatever an apply function throws for a part that cannot
 * take the family's values (a post look that turns GTAO on needs a GTAO in `post`).
 * @example applyLookFamily('animatedFeature', { sky: { sky }, water, terrain: colors });
 */
export function applyLookFamily(name: LookFamilyName, targets: LookFamilyTargets): void {
  if (!FAMILY_NAMES.includes(name))
    throw new RangeError(`Unknown look family ${String(name)}; use one of ${LOOK_FAMILIES.join(', ')}.`);
  // One family's values from a package's LOOKS table (every table holds both families), typed as the apply function's own values.
  const pick = <V>(table: object): V => (table as Record<string, V>)[name] as V;
  if (targets.sky) applySkySettings(targets.sky, pick(SKY_LOOKS));
  if (targets.water) applyWaterSettings(targets.water, pick(WATER_LOOKS));
  if (targets.terrain) applyTerrainSettings(targets.terrain, pick(TERRAIN_LOOKS));
  if (targets.weather) applyWeatherSettings(targets.weather, pick(WEATHER_LOOKS));
  if (targets.environment) applyEnvironmentSettings(targets.environment, pick(ENVIRONMENT_LOOKS));
  if (targets.sand) applySandSettings(targets.sand, pick(SAND_LOOKS));
  if (targets.smoke) applySmokeSettings(targets.smoke, pick(SMOKE_LOOKS));
  if (targets.fire) applyFlameSettings(targets.fire, pick(FLAME_LOOKS));
  if (targets.tonemap) applyTonemapSettings(targets.tonemap, pick(TONEMAP_LOOKS));
  if (targets.post) applyPostSettings(targets.post, pick(POST_LOOKS));
  if (targets.biomes) targets.biomes.materials = biomeMaterials(name);
}
