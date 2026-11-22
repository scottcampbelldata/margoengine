// The slider rows of an avalanche on the shared shape (`packages/shared/settings.js`): `AVALANCHE_SETTINGS` for
// `Avalanche`. The wind rows follow the weather (null), a value overrides it until set back to null. Rows marked not
// live start the avalanche again when changed (the grid, the release, the step and the densities).
import {
  checkSettings,
  followsWeather,
  holdFromWeather,
  liveSettings,
  numberSetting,
  settingDefaults,
  settingIndex,
} from '../../shared/settings.js';
import type { SnowSetting, SnowSettingTarget, SnowSettingValue, SnowSettingValues } from './snow-settings.js';

const n = (
  name: string,
  group: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
  live = true,
) => numberSetting(name, group, value, min, max, step, unit, about, live) as SnowSetting;
const follows = (row: SnowSetting, weather: string) => followsWeather(row, weather) as SnowSetting;

/** Every `Avalanche` control, in panel order. */
export const AVALANCHE_SETTINGS: readonly SnowSetting[] = [
  follows(
    n('wind', 'weather', 0, 0, 60, 0.1, 'm/s', 'Wind at 10 m drifting the powder cloud; null follows the weather.'),
    'wind',
  ),
  follows(
    n(
      'windDirection',
      'weather',
      0,
      -360,
      360,
      1,
      'degrees',
      'Direction the wind blows toward: 0 is +Z, 90 is +X; null follows the weather.',
    ),
    'windDirection',
  ),
  n('releaseTime', 'release', 0, 0, 3600, 0.1, 's', 'Film second the slab breaks away.'),
  n(
    'releaseDepth',
    'release',
    1,
    0.05,
    10,
    0.01,
    'm',
    'Slab depth of a rectangle release; changing it starts again.',
    false,
  ),
  n('timeScale', 'release', 1, 0, 100, 0.01, 's/s', 'Simulated seconds per film second: 0.5 is slow motion.'),
  n('step', 'release', 0.05, 0.005, 0.5, 0.005, 's', 'Simulated seconds per step; changing it starts again.', false),
  n(
    'friction',
    'flow',
    0.2,
    0.05,
    1,
    0.005,
    '',
    'Voellmy dry friction mu; large dry avalanches 0.155 to 0.3 (Bartelt et al. 1999). Lower runs farther.',
  ),
  n(
    'turbulence',
    'flow',
    2000,
    100,
    10000,
    10,
    'm/s2',
    'Voellmy turbulent friction xi, 1000 to 3000 for large avalanches. Higher runs faster.',
  ),
  n(
    'pressure',
    'flow',
    1,
    0,
    3,
    0.01,
    '',
    'Earth pressure coefficient k: how much the flow spreads under its own weight (1 as in RAMMS).',
  ),
  n('density', 'flow', 300, 50, 600, 1, 'kg/m3', 'Density of the flowing snow; changing it starts again.', false),
  n('coverDensity', 'flow', 200, 50, 600, 1, 'kg/m3', 'Density of the snow cover; changing it starts again.', false),
  n(
    'entrainment',
    'flow',
    0.005,
    0,
    0.1,
    0.0005,
    '',
    'Cover taken, metres a second per m/s of speed: the avalanche grows as it runs (Sovilla et al. 2006).',
  ),
  n(
    'stopMomentum',
    'flow',
    0.05,
    0,
    0.5,
    0.005,
    '',
    'The flow stops as deposit under this share of its highest momentum (RAMMS).',
  ),
  n(
    'suspension',
    'cloud',
    0.25,
    0,
    1,
    0.01,
    '',
    'Share of the entrained snow a fast front throws up into the powder cloud.',
  ),
  n(
    'cloudGrowth',
    'cloud',
    0.06,
    0,
    0.5,
    0.005,
    '',
    'Growth of the cloud height per metre it runs (Beghin et al. 1981).',
  ),
  n('cloudAspect', 'cloud', 1.6, 0.5, 6, 0.05, '', 'Cloud length and width over its height.'),
  n(
    'cloudThreshold',
    'cloud',
    12,
    1,
    60,
    0.5,
    'm/s',
    'Above it the cloud picks up snow, below it its snow settles (Rastello and Hopfinger 2004).',
  ),
  n(
    'cloudPickup',
    'cloud',
    0.001,
    0,
    0.01,
    0.0001,
    '',
    'Cover the cloud picks up, metres a second per m/s above the threshold.',
  ),
  n('settling', 'cloud', 0.5, 0, 5, 0.05, 'm/s', 'Fall speed of the cloud grains: how fast it settles once slow.'),
  n(
    'grain',
    'cloud',
    0.0001,
    0.00001,
    0.01,
    0.00001,
    'm',
    'Grain radius: smaller grains make a denser looking cloud (extinction 3 C / (2 rho r)).',
  ),
  n(
    'breakPressure',
    'damage',
    100000,
    1000,
    2000000,
    1000,
    'Pa',
    'Pressure that breaks trees (McClung and Schaerer 2006: 100 kPa size 3).',
  ),
  n(
    'bendPressure',
    'damage',
    1000,
    100,
    1000000,
    100,
    'Pa',
    'Pressure that starts to bend plants along the flow (McClung and Schaerer 2006: 1 kPa size 1); flat at half breakPressure.',
  ),
  n('buryDepth', 'damage', 2, 0.01, 100, 0.01, 'm', 'Deposit that buries plants.'),
];

/** The `Avalanche` rows that may change every frame. */
export const AVALANCHE_LIVE_SETTINGS: readonly SnowSetting[] = liveSettings(AVALANCHE_SETTINGS) as SnowSetting[];
const BY_NAME = settingIndex(AVALANCHE_SETTINGS) as Map<string, SnowSetting>;

/** Every `Avalanche` setting at its default, as a fresh object to edit. */
export function avalancheSettingDefaults(): Record<string, SnowSettingValue> {
  return settingDefaults(AVALANCHE_SETTINGS) as Record<string, SnowSettingValue>;
}

/** Named avalanche looks, values of {@link AVALANCHE_SETTINGS}: pass one to {@link applyAvalancheSettings}. */
export const AVALANCHE_LOOKS = {
  /** Every weather row null: the weather's wind drifts the cloud. */
  weather: {},
  /** A large dry powder avalanche: low friction, fast, a big cloud. */
  dryPowder: { friction: 0.16, turbulence: 2500, suspension: 0.4, cloudGrowth: 0.08, cloudThreshold: 10 },
  /** A wet slide: slow and heavy, high friction, little cloud, a deep deposit. */
  wetSlide: { friction: 0.3, turbulence: 1000, density: 450, coverDensity: 400, suspension: 0.02, cloudThreshold: 30 },
  /** Slow motion of the dry powder avalanche, a quarter speed. */
  slowMotion: {
    friction: 0.16,
    turbulence: 2500,
    suspension: 0.4,
    cloudGrowth: 0.08,
    cloudThreshold: 10,
    timeScale: 0.25,
  },
} as const satisfies Record<string, SnowSettingValues>;

/**
 * Writes `values` onto an `Avalanche` (a name left out takes its default). A null wind row follows the avalanche's
 * `weather`; a value overrides it.
 * @throws TypeError for a name not in {@link AVALANCHE_SETTINGS}; RangeError for a value outside its row's range.
 * @example applyAvalancheSettings(slide, AVALANCHE_LOOKS.dryPowder);
 */
export function applyAvalancheSettings(target: SnowSettingTarget, values: SnowSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'avalanche', 'AVALANCHE_SETTINGS in @margoengine/weather/settings');
  const o = target.options as Record<string, unknown>;
  for (const row of BY_NAME.values()) {
    const v = row.name in values ? values[row.name]! : (row.default as SnowSettingValue);
    if (row.nullable) holdFromWeather(o, row.name, v !== null);
    if (v === null) delete o[row.name];
    else o[row.name] = v;
  }
}

/** The values an `Avalanche` shows now, as a panel's starting state (unset options at their defaults). */
export function avalancheSettingValues(target: SnowSettingTarget): Record<string, SnowSettingValue> {
  const o = target.options as Record<string, unknown>,
    v = avalancheSettingDefaults();
  for (const name of Object.keys(v)) if (typeof o[name] === 'number') v[name] = o[name] as number;
  return v;
}
