// The slider rows of lying snow on the shared shape (`packages/shared/settings.js`): `SNOW_SETTINGS` for `Snow` (the
// look on every mesh) and `SNOW_DRIFT_SETTINGS` for `SnowDrift` (the wind drifting, cornices, sloughing and the slide
// state). Weather-driven rows are `nullable` with the master slider they follow in `weather`: null follows the weather,
// a value overrides it (marked with `holdFromWeather`, so `WeatherDrive` leaves it alone) until it is set back to null.
import {
  checkSettings,
  choiceSetting,
  colorSetting,
  followsWeather,
  holdFromWeather,
  liveSettings,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import { SNOW_COLOR, SNOW_ROUGHNESS } from './surface.js';

/** One value of a snow setting. */
export type SnowSettingValue = number | string | readonly [number, number, number] | null;
/** Values by setting name; a name left out takes its default. */
export type SnowSettingValues = Readonly<Record<string, SnowSettingValue>>;
/** A `Snow` or a `SnowDrift`: anything with `options`. */
export interface SnowSettingTarget {
  readonly options: object;
}
/** One control on the shared row shape. */
export interface SnowSetting extends SettingRow {
  readonly name: string;
  readonly group: string;
}

const n = (name: string, group: string, value: number, min: number, max: number, step: number, unit: string, about: string, live = true) =>
  numberSetting(name, group, value, min, max, step, unit, about, live) as SnowSetting;
const follows = (row: SnowSetting, weather: string) => followsWeather(row, weather) as SnowSetting;
const nullable = (row: SnowSetting) => ({ ...row, default: null, nullable: true }) as SnowSetting;

/** Every `Snow` control, in panel order. */
export const SNOW_SETTINGS: readonly SnowSetting[] = [
  follows(n('cover', 'cover', 0, 0, 1, 0.01, '', 'Snow on the ground, 0 none to 1 full; null follows the weather (its snow cover builds in about 2 minutes of snowfall).'), 'snow'),
  n('depth', 'cover', 0.12, 0, 2, 0.01, 'm', 'Thickness on flat ground at full cover; surfaces are lifted by it.'),
  n('variation', 'cover', 0.4, 0, 1, 0.01, '', 'How much the thickness varies in drifts, 0 even to 1 from none to double.'),
  n('drift', 'cover', 4, 0.25, 100, 0.25, 'm', 'Width of a drift of the variation.'),
  n('grain', 'look', 0.3, 0, 1, 0.01, '', 'Strength of the snow grain in the normal.'),
  n('roughness', 'look', SNOW_ROUGHNESS, 0, 1, 0.01, '', 'Snow roughness.'),
  colorSetting('color', 'look', [...SNOW_COLOR] as [number, number, number], 0, 2, 'Snow colour, linear RGB.') as SnowSetting,
  n('band', 'field', 0.05, 0, 10, 0.01, 'm', 'With a SnowDrift field: how far above its ground a surface still takes its depth.'),
];

/** Every `SnowDrift` control, in panel order. `step`, `initialDepth` and `initialDensity` start the snow again. */
export const SNOW_DRIFT_SETTINGS: readonly SnowSetting[] = [
  follows(n('wind', 'weather', 0, 0, 60, 0.1, 'm/s', 'Wind at 10 m; null follows the weather. Snow moves above the threshold (about 7 to 10 m/s, Li and Pomeroy 1997).'), 'wind'),
  follows(n('windDirection', 'weather', 0, -360, 360, 1, 'degrees', 'Direction the wind blows toward: 0 is +Z, 90 is +X; null follows the weather.'), 'windDirection'),
  follows(n('snowfall', 'weather', 0, 0, 50, 0.1, 'mm/h', 'Snowfall as water; null follows the weather snow by Rasmussen 1999 (0.35 light about 0.9 mm/h, 1 about 4).'), 'snow'),
  follows(n('temperature', 'weather', -5, -60, 20, 0.5, 'C', 'Air temperature; sets the new snow density, the threshold and the snow share (none from 2 C). Null follows the weather.'), 'temperature'),
  follows(n('humidity', 'weather', 0.8, 0, 1, 0.01, '', 'Relative humidity; dry air sublimates blowing snow. Null follows the weather.'), 'humidity'),
  n('timeScale', 'time', 1, 0, 100000, 1, 's/s', 'Simulated seconds per second of film: 600 grows an hour of drifting in 6 s of film.'),
  n('step', 'time', 10, 0.5, 600, 0.5, 's', 'Simulated seconds per step; changing it replays from 0.', false),
  n('initialDepth', 'time', 0, 0, 100, 0.01, 'm', 'Snow lying at time 0 (the old snow under the first weak layer); changing it replays.', false),
  n('initialDensity', 'time', 250, 50, 600, 1, 'kg/m3', 'Density of that snow; changing it replays.', false),
  nullable(n('threshold', 'wind', 8.6, 2, 30, 0.1, 'm/s', 'Wind at 10 m at which snow starts to move; null is Li and Pomeroy 1997 at the temperature.')),
  n('transport', 'wind', 1, 0, 10, 0.01, '', 'Multiplies the snow the wind carries (Pomeroy and Gray 1990 saltation, PBSM total).'),
  n('roughness', 'wind', 0.0005, 0.00001, 0.01, 0.00001, 'm', 'Roughness length of the snow surface (the friction velocity of the wind).'),
  n('fetch', 'wind', 100, 1, 2000, 1, 'm', 'Fetch over which blowing snow grows to the wind capacity (Takeuchi 1980).'),
  n('settle', 'wind', 5, 0.1, 500, 0.1, 'm', 'Distance over which blowing snow lands where the wind slows.'),
  n('slopeWeight', 'wind', 0.5, 0, 2, 0.01, '', 'How much a windward slope speeds the wind up and a lee slope slows it (MicroMet).'),
  n('curvatureWeight', 'wind', 0.5, 0, 2, 0.01, '', 'How much ridges speed the wind up and hollows slow it (MicroMet).'),
  n('curvatureLength', 'wind', 20, 1, 500, 1, 'm', 'Length the curvature is measured over.'),
  n('shelter', 'wind', 0.8, 0, 1, 0.01, '', 'How much a sheltered lee cell loses of the wind (Winstral Sx).'),
  n('shelterAngle', 'wind', 15, 1, 60, 0.5, 'degrees', 'Upwind horizon angle of full shelter.'),
  n('shelterDistance', 'wind', 60, 0, 1000, 1, 'm', 'How far upwind the shelter looks.'),
  n('windDensity', 'wind', 300, 100, 600, 1, 'kg/m3', 'Density of wind-packed snow (the wind slab).'),
  n('sublimation', 'wind', 0.02, 0, 1, 0.001, '', 'Share of blowing snow lost per 100 m in dry air.'),
  choiceSetting('inflow', 'wind', ['snowfield', 'bare'], 'Snow blows in at the upwind edge as from a snowfield, or the edge is bare.') as SnowSetting,
  n('repose', 'slope', 45, 20, 90, 0.5, 'degrees', 'Angle of repose: snow on steeper ground sloughs down; 90 never.'),
  n('corniceAngle', 'cornice', 35, 15, 89, 0.5, 'degrees', 'A lee drop steeper than this grows a cornice on the edge above it.'),
  n('corniceCapture', 'cornice', 0.25, 0, 1, 0.01, '', 'Share of the blowing snow a cornice edge catches.'),
  n('corniceDensity', 'cornice', 400, 200, 600, 1, 'kg/m3', 'Density of cornice snow.'),
  n('corniceMax', 'cornice', 3, 0.1, 20, 0.1, 'm', 'Overhang at which a cornice breaks off onto the slope below.'),
  n('weakLayer', 'slide', 500, 50, 10000, 10, 'Pa', 'Shear strength of a fresh buried weak layer (Jamieson and Johnston 2001: 0.2 to 2 kPa).'),
  n('weakFriction', 'slide', 0.2, 0, 2, 0.01, '', 'Strength the weak layer gains per Pa of slab weight on it.'),
  n('sintering', 'slide', 15, 0, 1000, 1, 'Pa/h', 'Strength the weak layer gains per hour.'),
  n('burial', 'slide', 21600, 60, 1000000, 60, 's', 'Fair weather after which the surface becomes the next weak layer.'),
  n('trigger', 'slide', 0, 0, 10000, 10, 'Pa', 'Stress a trigger adds to the weak layer (a skier about 150 to 500 Pa); 0 is natural release.'),
];

/** The rows that may change every frame. */
export const SNOW_LIVE_SETTINGS: readonly SnowSetting[] = liveSettings(SNOW_SETTINGS) as SnowSetting[];
/** The `SnowDrift` rows that may change every frame (all but `step`, `initialDepth` and `initialDensity`). */
export const SNOW_DRIFT_LIVE_SETTINGS: readonly SnowSetting[] = liveSettings(SNOW_DRIFT_SETTINGS) as SnowSetting[];
const SNOW_BY_NAME = settingIndex(SNOW_SETTINGS) as Map<string, SnowSetting>;
const DRIFT_BY_NAME = settingIndex(SNOW_DRIFT_SETTINGS) as Map<string, SnowSetting>;

/** Every `Snow` setting at its default, as a fresh object to edit. */
export function snowSettingDefaults(): Record<string, SnowSettingValue> {
  return settingDefaults(SNOW_SETTINGS) as Record<string, SnowSettingValue>;
}
/** Every `SnowDrift` setting at its default, as a fresh object to edit. */
export function snowDriftSettingDefaults(): Record<string, SnowSettingValue> {
  return settingDefaults(SNOW_DRIFT_SETTINGS) as Record<string, SnowSettingValue>;
}

/** Named drift looks, values of {@link SNOW_DRIFT_SETTINGS}: pass one to {@link applySnowDriftSettings}. */
export const SNOW_DRIFT_LOOKS = {
  /** Every weather row null: the weather's wind, snow, temperature and humidity drive it, one second a second. */
  weather: {},
  /** A day of drifting in a minute of film: the weather drives it at 1,440 simulated seconds a second. */
  filmDay: { timeScale: 1440, step: 30 },
  /** Cold, light powder in a moderate wind: low threshold, long fetch, little sublimation in moist air. */
  powder: { wind: 9, snowfall: 1.5, temperature: -15, humidity: 0.9, timeScale: 600, step: 20 },
  /** A wind slab building on a lee slope: no snowfall, a strong wind over old snow, a weak layer under it. */
  windSlab: { wind: 16, snowfall: 0, temperature: -8, initialDepth: 0.4, timeScale: 1200, step: 30, corniceCapture: 0.3 },
  /** A blizzard: heavy snow in a gale, big cornices that break. */
  blizzard: { wind: 24, snowfall: 4, temperature: -12, humidity: 0.7, timeScale: 900, step: 20, corniceMax: 2.5 },
} as const satisfies Record<string, SnowSettingValues>;

function write(rows: Map<string, SnowSetting>, target: SnowSettingTarget, values: SnowSettingValues, label: string, entry: string, map?: (name: string, v: SnowSettingValue) => unknown) {
  checkSettings(rows, values, label, entry);
  const o = target.options as Record<string, unknown>;
  for (const row of rows.values()) {
    const v = row.name in values ? values[row.name]! : (row.default as SnowSettingValue);
    const key = row.name;
    if (row.nullable) holdFromWeather(o, key, v !== null);
    if (v === null) delete o[key];
    else o[key] = map ? map(key, v) : Array.isArray(v) ? [...v] : v;
  }
}

/**
 * Writes `values` onto a `Snow` (a name left out takes its default). A null `cover` hands the cover back to the
 * weather; a value holds it (it wins over the weather until set back to null).
 * @throws TypeError for a name not in {@link SNOW_SETTINGS}; RangeError for a value outside its row's range.
 * @example applySnowSettings(snow, { depth: 0.3, cover: null });
 */
export function applySnowSettings(target: SnowSettingTarget, values: SnowSettingValues = {}): void {
  write(SNOW_BY_NAME, target, values, 'snow', 'SNOW_SETTINGS in @margoengine/weather/settings');
}

/**
 * Writes `values` onto a `SnowDrift` (a name left out takes its default). A null weather row follows the drift's
 * `weather`; a value overrides it. `inflow` 'snowfield' is true, 'bare' false.
 * @throws TypeError for a name not in {@link SNOW_DRIFT_SETTINGS}; RangeError for a value outside its row's range.
 * @example applySnowDriftSettings(drift, SNOW_DRIFT_LOOKS.blizzard);
 */
export function applySnowDriftSettings(target: SnowSettingTarget, values: SnowSettingValues = {}): void {
  write(DRIFT_BY_NAME, target, values, 'snow drift', 'SNOW_DRIFT_SETTINGS in @margoengine/weather/settings', (name, v) =>
    name === 'inflow' ? v === 'snowfield' : v,
  );
}

/** The values a `Snow` or `SnowDrift` shows now, as a panel's starting state (unset options at their defaults). */
export function snowSettingValues(target: SnowSettingTarget, drift = false): Record<string, SnowSettingValue> {
  const o = target.options as Record<string, unknown>,
    v = drift ? snowDriftSettingDefaults() : snowSettingDefaults();
  for (const name of Object.keys(v)) {
    const x = o[name];
    if (name === 'inflow' && typeof x === 'boolean') v[name] = x ? 'snowfield' : 'bare';
    else if (typeof x === 'number') v[name] = x;
    else if (Array.isArray(x) && x.length === 3) v[name] = [x[0], x[1], x[2]];
  }
  return v;
}
