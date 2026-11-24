// Every live look control of GroundChange (`@margoengine/terrain/ground-change`) as one machine-readable table on the
// shared row shape (packages/shared/settings.js; the model is @margoengine/sky/settings). Every row is live: the look is
// one small uniform, so `applyGroundChangeSettings` can key any of them over a shot without rebuilding anything.
// `wet.rain` is null by default: it follows the weather's rain (a `WeatherDrive` writes it) until a value is set.
// The events themselves (what cuts, falls or flows, and when) are scene data, not sliders.
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
import type { GroundChange, GroundLook } from './ground-change.js';

/** A colour value: linear RGB. */
export type GroundSettingColor = readonly [number, number, number];
/** One value of a setting: a number, a colour, or null where `nullable`. */
export type GroundSettingValue = number | GroundSettingColor | null;
/** Values by setting name; a name left out takes its default. */
export type GroundSettingValues = Readonly<Record<string, GroundSettingValue>>;
/** The panel a setting sits in. */
export type GroundSettingGroup = 'colors' | 'lava' | 'wet';
/** One control: the shared row shape with the ground change's groups. */
export interface GroundSetting extends SettingRow {
  readonly group: GroundSettingGroup;
  readonly default: GroundSettingValue;
}
const c = (name: string, value: GroundSettingColor, about: string): GroundSetting =>
  colorSetting(name, 'colors', value, 0, 1, about) as GroundSetting;
const n = (
  name: string,
  group: GroundSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): GroundSetting => numberSetting(name, group, value, min, max, step, unit, about) as GroundSetting;

/** Every ground change look control, in panel order. Defaults are the values GroundChange uses without the option. */
export const GROUND_CHANGE_SETTINGS: readonly GroundSetting[] = [
  c('soil.color', [0.3, 0.21, 0.13], 'Freshly cut soil in gullies, cut banks, scour holes and slide scars.'),
  c('mud.color', [0.24, 0.2, 0.15], 'Flood mud before wet darkening.'),
  c('ash.color', [0.36, 0.35, 0.34], 'Fallen volcanic ash.'),
  c('char.color', [0.025, 0.022, 0.02], 'Fresh char on burned ground (albedo about 0.02 to 0.04).'),
  c('ashen.color', [0.5, 0.49, 0.47], 'White ash that char ages into after a hot burn.'),
  c('lava.color', [0.04, 0.036, 0.034], 'Cooled lava rock (dark basalt).'),
  n('lava.glow', 'lava', 12, 0, 100, 0.1, '', 'Brightness of glowing lava at full heat, as linear radiance (the sun is about 1).'),
  n('lava.cracks', 'lava', 0.7, 0, 1, 0.01, '', 'How much a cooling flow glows only through the cracks of its crust: 0 evenly, 1 cracks only.'),
  n('lava.crackSize', 'lava', 0.8, 0.05, 100, 0.05, 'm', 'Width of the crust plates between the glowing cracks.'),
  n('wet.darkening', 'wet', 0.55, 0, 1, 0.01, '', 'Albedo of fully wet mud, soil or ash (1 is no darkening).'),
  n('wet.gloss', 'wet', 0.5, 0, 1, 0.01, '', 'Share by which wet ground is smoother (shinier).'),
  {
    ...followsWeather(
      n('wet.rain', 'wet', 0, 0, 1, 0.01, '', 'Wetness from rain on all cut soil, mud and ash, 0 dry to 1 soaked. Null follows the weather.'),
      'rainRate',
    ),
  } as GroundSetting,
];
/** The rows that can change every frame (all of them). */
export const GROUND_CHANGE_LIVE_SETTINGS: readonly GroundSetting[] = liveSettings(GROUND_CHANGE_SETTINGS) as GroundSetting[];
const BY_NAME = settingIndex(GROUND_CHANGE_SETTINGS) as Map<string, GroundSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function groundChangeSettingDefaults(): Record<string, GroundSettingValue> {
  return settingDefaults(GROUND_CHANGE_SETTINGS) as Record<string, GroundSettingValue>;
}
const KEYS: Record<string, keyof GroundLook> = {
  'soil.color': 'soil',
  'mud.color': 'mud',
  'ash.color': 'ash',
  'char.color': 'char',
  'ashen.color': 'ashen',
  'lava.color': 'lava',
  'lava.glow': 'glow',
  'lava.cracks': 'cracks',
  'lava.crackSize': 'crackSize',
  'wet.darkening': 'wetDarkening',
  'wet.gloss': 'wetGloss',
  'wet.rain': 'rain',
};
/** The look the given setting values make (names left out keep the change's current look). */
export function groundLookOf(values: GroundSettingValues): GroundLook {
  checkSettings(BY_NAME, values, 'ground change', 'the rows in @margoengine/terrain/ground-change-settings');
  const look: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(values)) look[KEYS[name]] = Array.isArray(v) ? [...v] : v;
  return look as GroundLook;
}
/**
 * Sets the given rows on `change` (names left out keep their current value); a number for `wet.rain` holds it against
 * the weather, null hands it back. Nothing is rebuilt.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function applyGroundChangeSettings(change: GroundChange, values: GroundSettingValues = {}): void {
  const look = groundLookOf(values);
  change.setLook(look);
  if ('rain' in look) holdFromWeather(change.look, 'rain', look.rain !== null);
}
