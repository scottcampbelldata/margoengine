// The slider rows of a volcanic eruption on the shared shape (`packages/shared/settings.js`): `ERUPTION_SETTINGS` for
// `Eruption`. The wind rows follow the weather (null), a value overrides it until set back to null; `height` null
// takes `massRate`, a value takes Mastin et al.'s (2009) rate for that column height. Every row is live: the column,
// the umbrella, the fall and the lightning are functions of the film time and the options, read anew each frame.
import { checkSettings, followsWeather, holdFromWeather, liveSettings, numberSetting, settingDefaults, settingIndex } from '../../shared/settings.js';
import type { SnowSetting, SnowSettingTarget, SnowSettingValue, SnowSettingValues } from './snow-settings.js';

const n = (name: string, group: string, value: number, min: number, max: number, step: number, unit: string, about: string) =>
  numberSetting(name, group, value, min, max, step, unit, about, true) as SnowSetting;
const follows = (row: SnowSetting, weather: string) => followsWeather(row, weather) as SnowSetting;

/** Every `Eruption` control, in panel order. */
export const ERUPTION_SETTINGS: readonly SnowSetting[] = [
  follows(n('wind', 'weather', 0, 0, 60, 0.1, 'm/s', 'Wind at 10 m bending the column and carrying the umbrella and the ash; null follows the weather.'), 'wind'),
  follows(n('windDirection', 'weather', 0, -360, 360, 1, 'degrees', 'Direction the wind blows toward: 0 is +Z, 90 is +X; null follows the weather.'), 'windDirection'),
  n('start', 'timing', 0, 0, 86400, 0.1, 's', 'Film second the eruption starts.'),
  n('rise', 'timing', 60, 1, 86400, 1, 's', 'Seconds to reach the full rate.'),
  n('duration', 'timing', 3600, 0, 1000000, 1, 's', 'Seconds at the full rate.'),
  n('wane', 'timing', 300, 1, 86400, 1, 's', 'Seconds to stop.'),
  n('massRate', 'vent', 1e7, 1e3, 1e10, 1e3, 'kg/s', 'Mass eruption rate at the full rate.'),
  { ...n('height', 'vent', 10000, 500, 50000, 10, 'm', 'Column top above the vent; null takes massRate, a value takes Mastin et al. 2009 rate for it.'), default: null, nullable: true } as SnowSetting,
  n('exitVelocity', 'vent', 200, 10, 600, 1, 'm/s', 'Speed of the mixture leaving the vent.'),
  n('exitTemperature', 'vent', 1200, 600, 1600, 1, 'K', 'Temperature of the mixture leaving the vent.'),
  n('gasFraction', 'vent', 0.04, 0.005, 0.2, 0.001, '', 'Mass fraction of magmatic water at the vent; too little collapses the column.'),
  n('entrainment', 'column', 0.09, 0.02, 0.2, 0.001, '', 'Radial entrainment alpha (Morton et al. 1956).'),
  n('windEntrainment', 'column', 0.5, 0, 1.5, 0.01, '', 'Wind entrainment beta (Woodhouse et al. 2013).'),
  n('frontSpeed', 'column', 0.5, 0.1, 1, 0.01, '', "Speed of the rising top as a share of the steady column's."),
  n('airTemperature', 'air', 288.15, 220, 320, 0.1, 'K', 'Air temperature at sea level (ICAO 288.15).'),
  n('tropopause', 'air', 11000, 6000, 20000, 10, 'm', 'Height of the tropopause above sea level.'),
  n('umbrellaSpread', 'umbrella', 0.2, 0.05, 1, 0.01, '', 'Umbrella front coefficient lambda (Suzuki and Koyaguchi 2009).'),
  n('grainSize', 'ash', 2, -4, 8, 0.1, 'phi', 'Mean grain size (phi 2 is 0.25 mm).'),
  n('grainSorting', 'ash', 2.5, 0.5, 4, 0.1, 'phi', 'Spread of the grain sizes.'),
  n('ashDensity', 'ash', 2500, 500, 3000, 10, 'kg/m^3', 'Density of the ash grains.'),
  n('depositDensity', 'ash', 1000, 300, 2000, 10, 'kg/m^3', 'Bulk density of the fallen ash.'),
  n('diffusion', 'ash', 2000, 0, 100000, 10, 'm^2/s', 'Horizontal diffusion of the falling ash.'),
  n('lightningRate', 'lightning', 6, 0, 600, 0.1, 'per min', 'Plume lightning strikes per minute at 1e7 kg/s, in proportion to the rate.'),
  n('ventLightning', 'lightning', 0.3, 0, 1, 0.01, '', 'Share of the strikes at the vent; the rest are in the plume.'),
  n('timeScale', 'timing', 1, 0, 100, 0.01, '', 'Film seconds per real second.'),
];

/** The `Eruption` rows that may change every frame (all of them). */
export const ERUPTION_LIVE_SETTINGS: readonly SnowSetting[] = liveSettings(ERUPTION_SETTINGS) as SnowSetting[];
const BY_NAME = settingIndex(ERUPTION_SETTINGS) as Map<string, SnowSetting>;

/** Every `Eruption` setting at its default, as a fresh object to edit. */
export function eruptionSettingDefaults(): Record<string, SnowSettingValue> {
  return settingDefaults(ERUPTION_SETTINGS) as Record<string, SnowSettingValue>;
}

/** Named eruption looks, values of {@link ERUPTION_SETTINGS}: pass one to {@link applyEruptionSettings}. */
export const ERUPTION_LOOKS = {
  /** Every weather row null: the weather's wind bends the column. */
  weather: {},
  /** A Plinian column near 23 km in calm air. */
  plinian: { massRate: 1e8, exitVelocity: 250, gasFraction: 0.05, duration: 32400 },
  /** Costa et al. (2016)'s weak plume (Shinmoe-dake 2011): 1.5e6 kg/s, near 6 km, bent by the wind. */
  weakPlume: { massRate: 1.5e6, exitVelocity: 135, exitTemperature: 1273, gasFraction: 0.03, duration: 720 },
  /** Costa et al. (2016)'s strong plume (Pinatubo 1991): 1.5e9 kg/s, near 37 km. */
  strongPlume: { massRate: 1.5e9, exitVelocity: 275, exitTemperature: 1053, gasFraction: 0.05, duration: 9000 },
  /** A dense, slow, gas-poor jet that collapses as a fountain. */
  collapsing: { massRate: 1e8, exitVelocity: 60, gasFraction: 0.01 },
  /** The Plinian column at a twentieth speed. */
  slowMotion: { massRate: 1e8, exitVelocity: 250, gasFraction: 0.05, duration: 32400, timeScale: 0.05 },
} as const satisfies Record<string, SnowSettingValues>;

/**
 * Writes `values` onto an `Eruption` (a name left out takes its default). A null wind row follows the eruption's
 * `weather`; a value overrides it. A null `height` takes `massRate`.
 * @throws TypeError for a name not in {@link ERUPTION_SETTINGS}; RangeError for a value outside its row's range.
 * @example applyEruptionSettings(eruption, ERUPTION_LOOKS.plinian);
 */
export function applyEruptionSettings(target: SnowSettingTarget, values: SnowSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'eruption', 'ERUPTION_SETTINGS in @margoengine/weather/settings');
  const o = target.options as Record<string, unknown>;
  for (const row of BY_NAME.values()) {
    const v = row.name in values ? values[row.name]! : (row.default as SnowSettingValue);
    if (row.nullable && row.name !== 'height') holdFromWeather(o, row.name, v !== null);
    if (v === null) delete o[row.name];
    else o[row.name] = v;
  }
}

/** The values an `Eruption` shows now, as a panel's starting state (unset options at their defaults). */
export function eruptionSettingValues(target: SnowSettingTarget): Record<string, SnowSettingValue> {
  const o = target.options as Record<string, unknown>,
    v = eruptionSettingDefaults();
  for (const name of Object.keys(v)) if (typeof o[name] === 'number') v[name] = o[name] as number;
  return v;
}
