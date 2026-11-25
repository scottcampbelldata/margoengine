// Every control of the rocks (`@margoengine/terrain/rocks` and `/rock-surface`) as one machine-readable table on the
// shared row shape (packages/shared/settings.js; the model is @margoengine/sky/settings). The look rows are live: they
// are one small buffer write, so `applyRockSettings` can key them over a shot. The shape rows rebuild the meshes
// (`live` false): `rockShapeOf` turns them into the options of `buildCliff` and `buildSeaRock`. `wet.rain` is null by
// default: it follows the weather's rain (a `WeatherDrive` writes it) until a value is set.
import {
  checkSettings,
  colorSetting,
  followsWeather,
  holdFromWeather,
  liveSettings,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import type { RockLook, RockSurface } from './rock-surface.js';
import type { CliffOptions, SeaRockOptions } from './rocks.js';

/** A colour value: linear RGB. */
export type RockSettingColor = readonly [number, number, number];
/** One value of a setting: a number, a colour, or null where `nullable`. */
export type RockSettingValue = number | RockSettingColor | null;
/** Values by setting name; a name left out takes its default. */
export type RockSettingValues = Readonly<Record<string, RockSettingValue>>;
/** The panel a setting sits in. */
export type RockSettingGroup = 'detail' | 'moss' | 'tide' | 'wet' | 'cliff' | 'sea';
/** One control: the shared row shape with the rocks' groups. */
export interface RockSetting extends SettingRow {
  readonly group: RockSettingGroup;
  readonly default: RockSettingValue;
}
const n = (
  name: string,
  group: RockSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
  live = true,
): RockSetting => numberSetting(name, group, value, min, max, step, unit, about, live) as RockSetting;
const c = (name: string, group: RockSettingGroup, value: RockSettingColor, about: string): RockSetting =>
  colorSetting(name, group, value, 0, 1, about) as RockSetting;
const shape = (
  name: string,
  group: RockSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
) => n(name, group, value, min, max, step, unit, about + ' Rebuilds the meshes.', false);

/** Every rock control, in panel order. Defaults are the values the rocks use without the option. */
export const ROCK_SETTINGS: readonly RockSetting[] = [
  n('detail.bump', 'detail', 1, 0, 3, 0.01, '', 'Strength of the fine relief that holds the rock up close.'),
  n(
    'detail.scale',
    'detail',
    1.6,
    0.05,
    50,
    0.05,
    'm',
    'Wavelength of the largest fine relief; five finer octaves follow.',
  ),
  n('detail.cracks', 'detail', 0.6, 0, 1, 0.01, '', 'How many dark joint cracks show.'),
  n('detail.variation', 'detail', 0.5, 0, 1, 0.01, '', 'Broad tone variation over the rock.'),
  n('detail.strata', 'detail', 0.6, 0, 1, 0.01, '', 'How strongly the beds differ in tone and the bedding lines show.'),
  n('detail.roughness', 'detail', 0.85, 0.3, 1, 0.01, '', 'Surface roughness of dry rock.'),
  n('moss.amount', 'moss', 0.35, 0, 1, 0.01, '', 'Moss or lichen on rock faces that look up.'),
  c('moss.color', 'moss', [0.07, 0.1, 0.03], 'Moss colour (grey-green lichen is about [0.2, 0.22, 0.16]).'),
  n('tide.height', 'tide', 1.5, 0, 30, 0.05, 'm', "Top of the wet tide band over each rock's sea level."),
  n('tide.algae', 'tide', 0.6, 0, 1, 0.01, '', 'Dark algae and weed over the lower tide band.'),
  c('tide.color', 'tide', [0.035, 0.045, 0.02], 'Algae colour.'),
  n('wet.darkening', 'wet', 0.6, 0, 1, 0.01, '', 'Albedo of fully wet rock against dry (1 is no darkening).'),
  n('wet.gloss', 'wet', 0.4, 0, 1, 0.01, '', 'Share by which wet rock is smoother (shinier).'),
  {
    ...followsWeather(
      n('wet.rain', 'wet', 0, 0, 1, 0.01, '', 'Wetness from rain, 0 dry to 1 soaked. Null follows the weather.'),
      'rainRate',
    ),
  } as RockSetting,
  shape('cliff.overhang', 'cliff', 2.5, 0, 100, 0.1, 'm', 'How far the top of a cliff face leans out past its foot.'),
  shape('cliff.proud', 'cliff', 0.6, 0, 20, 0.05, 'm', 'How far a cliff face stands in front of the heightfield.'),
  shape('cliff.strata', 'cliff', 1.4, 0, 100, 0.05, 'm', 'Bed thickness of the cliff strata (0 massive rock).'),
  shape('cliff.ledges', 'cliff', 0.5, 0, 20, 0.05, 'm', 'How far hard beds stand out of soft ones.'),
  shape('cliff.dip', 'cliff', 0, -60, 60, 1, 'degrees', 'Tilt of the beds along the face.'),
  shape('cliff.joints', 'cliff', 3, 0, 200, 0.1, 'm', 'Spacing of the vertical joints (0 none).'),
  shape('cliff.crackDepth', 'cliff', 0.35, 0, 20, 0.05, 'm', 'Depth of a joint crack.'),
  shape('cliff.roughness', 'cliff', 0.35, 0, 20, 0.05, 'm', 'Size of the rough bumps over the face.'),
  shape('cliff.cell', 'cliff', 0.5, 0.05, 20, 0.05, 'm', 'Polygonizer grid spacing (smaller is finer and slower).'),
  shape('sea.notchDepth', 'sea', 0.6, 0, 20, 0.05, 'm', 'Depth of the wave-cut notch at the sea surface.'),
  shape('sea.notchHeight', 'sea', 1.2, 0.1, 20, 0.05, 'm', 'Height of the notch (the wave and tide band).'),
  shape('sea.lobes', 'sea', 0.22, 0, 1, 0.01, '', "Lumpiness of a stack's outline, as a share of its radius."),
  shape('sea.strata', 'sea', 0.9, 0, 100, 0.05, 'm', 'Bed thickness of the sea rocks.'),
  shape('sea.joints', 'sea', 7, 0, 64, 1, '', 'Vertical joints around a sea rock.'),
  shape('sea.roughness', 'sea', 0.25, 0, 20, 0.05, 'm', 'Size of the rough bumps over a sea rock.'),
];
/** The rows that can change every frame (the look). */
export const ROCK_LIVE_SETTINGS: readonly RockSetting[] = liveSettings(ROCK_SETTINGS) as RockSetting[];
const BY_NAME = settingIndex(ROCK_SETTINGS) as Map<string, RockSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function rockSettingDefaults(): Record<string, RockSettingValue> {
  return settingDefaults(ROCK_SETTINGS) as Record<string, RockSettingValue>;
}
const LOOK: Record<string, keyof RockLook> = {
  'detail.bump': 'bump',
  'detail.scale': 'scale',
  'detail.cracks': 'cracks',
  'detail.variation': 'variation',
  'detail.strata': 'strata',
  'detail.roughness': 'roughness',
  'moss.amount': 'moss',
  'moss.color': 'mossColor',
  'tide.height': 'tideHeight',
  'tide.algae': 'algae',
  'tide.color': 'algaeColor',
  'wet.darkening': 'wetDarkening',
  'wet.gloss': 'wetGloss',
  'wet.rain': 'rain',
};
const check = (values: RockSettingValues) =>
  checkSettings(BY_NAME, values, 'rock', 'ROCK_SETTINGS in @margoengine/terrain/rock-settings');
/** The look the given live rows make (names left out, and shape rows, are not in it). */
export function rockLookOf(values: RockSettingValues): RockLook {
  check(values);
  const look: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(values)) if (name in LOOK) look[LOOK[name]] = Array.isArray(v) ? [...v] : v;
  return look as RockLook;
}
/**
 * The options of `buildCliff` and `buildSeaRock` the given shape rows make (names left out keep the builders'
 * defaults; look rows are not in them).
 */
export function rockShapeOf(values: RockSettingValues): { cliff: CliffOptions; seaRock: SeaRockOptions } {
  check(values);
  const cliff: Record<string, number> = {},
    seaRock: Record<string, number> = {};
  for (const [name, v] of Object.entries(values)) {
    const [group, key] = name.split('.');
    if (group === 'cliff') cliff[key] = v as number;
    else if (group === 'sea') seaRock[key] = v as number;
  }
  return { cliff, seaRock };
}
/**
 * Sets the given look rows on `surface` (names left out keep their current value); a number for `wet.rain` holds it
 * against the weather, null hands it back. Nothing is rebuilt; shape rows are checked and left for `rockShapeOf`.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 * @example applyRockSettings(surface, { 'detail.bump': 1.4, 'wet.rain': null });
 */
export function applyRockSettings(surface: RockSurface, values: RockSettingValues = {}): void {
  const look = rockLookOf(values);
  surface.setLook(look);
  if ('rain' in look) holdFromWeather(surface.look, 'rain', look.rain !== null);
}
