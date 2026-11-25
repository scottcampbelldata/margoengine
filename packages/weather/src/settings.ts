// The master weather panel as one machine-readable table, for sliders and tools: wind speed, direction and gust, the
// storm level, visibility, rain rate and the other numbers of a `WeatherState`. Every row is live (it only writes the
// state, so it can be keyed over a shot). `applyWeatherSettings` writes the state into a `WeatherMachine`, and
// `WeatherDrive` pushes it into every package it finds each frame; a package's own settings row that is `nullable` with
// a `weather` name follows these rows until it is given a value. The row shape is shared with every package's settings
// (`packages/shared/settings.js`; the model is `@margoengine/sky/settings`).
//
// Sources: the Beaufort table is the WMO's (Manual on Codes, WMO-No. 306), the visibility is Koschmieder's (1924) with the
// WMO-No. 8 classes, and rain rate is the WMO's mm/h; each is cited at the function that implements it in air.ts.
import {
  checkSettings,
  followsWeather,
  liveSettings,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import { ASH_AT_FULL, DUST_AT_FULL, RAIN_RATE_AT_FULL, SMOKE_AT_FULL, SPRAY_AT_FULL, fogForVisibility } from './air.js';
import { WEATHER_PRESETS, blendStates, resolveState, wrapAngle, type WeatherState } from './state.js';
export * from './snow-settings.js';
export * from './avalanche-settings.js';
export * from './eruption-settings.js';

/** One value of a weather setting: a number, or null where the row follows the storm level. */
export type WeatherSettingValue = number | null;
/** Values by setting name; a name left out takes its default. */
export type WeatherSettingValues = Readonly<Record<string, WeatherSettingValue>>;
/** The panel a setting sits in. */
export type WeatherSettingGroup = 'storm' | 'wind' | 'rain' | 'air' | 'sky';

/**
 * One control: the shared row shape with the weather's groups. `live` is true for every row (writing one only changes
 * the weather state); a row with `nullable` follows the storm level while it is null.
 */
export interface WeatherSetting extends SettingRow {
  readonly name: string;
  readonly group: WeatherSettingGroup;
  readonly kind: 'number';
  readonly default: WeatherSettingValue;
}
const n = (
  name: string,
  group: WeatherSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): WeatherSetting => numberSetting(name, group, value, min, max, step, unit, about) as WeatherSetting;
const follows = (row: WeatherSetting): WeatherSetting => followsWeather(row, 'storm') as WeatherSetting;

/** Every weather control, in panel order. `storm` 0 with every other row at null is the `clear` preset. */
export const WEATHER_SETTINGS: readonly WeatherSetting[] = [
  n(
    'storm',
    'storm',
    0,
    0,
    1,
    0.01,
    '',
    'Storm level: 0 is the clear preset, 0.5 the rain preset, 1 the storm preset; every row left at null follows it.',
  ),
  follows(
    n(
      'wind',
      'wind',
      0,
      0,
      60,
      0.1,
      'm/s',
      'Mean wind at 10 m. Beaufort force: 3 gentle breeze from 3.4 m/s, 5 fresh breeze from 8.0, 8 gale from 17.2, 10 storm from 24.5, 12 hurricane from 32.7.',
    ),
  ),
  n('windDirection', 'wind', 0, 0, 360, 1, 'degrees', 'Compass direction the wind blows toward: 0 is +Z, 90 is +X.'),
  follows(n('gust', 'wind', 0, 0, 1, 0.01, '', 'How gusty: 0 steady, 1 strong gusts and shifts.')),
  follows(
    n(
      'rainRate',
      'rain',
      0,
      0,
      RAIN_RATE_AT_FULL,
      0.1,
      'mm/h',
      'Rain rate: 0.6 drizzle, 17 rain, 69 a storm, 80 a violent downpour (the state holds it as rain = (R / 80)^(1/3)).',
    ),
  ),
  follows(n('snow', 'rain', 0, 0, 1, 0.01, '', 'Snowfall intensity, 0 none to 1 a blizzard (350 m visibility).')),
  follows(n('hail', 'rain', 0, 0, 1, 0.01, '', 'Hail intensity, 0 none to 1 a hail storm.')),
  follows(
    n(
      'visibility',
      'air',
      0,
      200,
      23000,
      10,
      'm',
      'How far a dark object stays visible (Koschmieder: 2 percent contrast). Sets the fog that leaves it, in the rain and snow set; wins over fog. 23,000 is clear air, about 200 m the thickest fog; rain and snow can leave less than the value asked.',
    ),
  ),
  follows(
    n(
      'fog',
      'air',
      0,
      0,
      1,
      0.01,
      '',
      'Fog thickness, 0 none to 1 very dense (about 200 m); ignored while visibility is set.',
    ),
  ),
  follows(n('cloud', 'sky', 0, 0, 1, 0.01, '', 'Cloud cover, 0 clear to 1 overcast.')),
  follows(n('lightning', 'sky', 0, 0, 1, 0.01, '', 'Lightning activity, 0 none to 1 constant.')),
  follows(
    n(
      'dust',
      'air',
      0,
      0,
      1,
      0.01,
      '',
      `Dust in the air, 0 none to 1 a haboob (PM10 = ${DUST_AT_FULL} dust^2 micrograms per cubic metre; the visibility is 485.67 V^-0.776 inverted: 0.2 leaves about 6 km, 0.5 about 570 m, 1 about 100 m) and a yellow-brown haze. A wind over sand above its threshold raises it by itself while a BlownSand is in the scene and this row is null.`,
    ),
  ),
  follows(
    n(
      'smoke',
      'air',
      0,
      0,
      1,
      0.01,
      '',
      `Smoke in the air, 0 none to 1 thick smoke beside a fire (PM2.5 = ${SMOKE_AT_FULL} smoke^2 micrograms per cubic metre, 4 m2/g of extinction: 0.2 leaves about 4 km, 0.5 about 760 m, 1 about 190 m). It dims and reddens the sun and gives the fog a grey brown. A fire front in the scene raises it by itself while this row is null.`,
    ),
  ),
  follows(
    n(
      'ash',
      'air',
      0,
      0,
      1,
      0.01,
      '',
      `Volcanic ash in the air, 0 none to 1 falling ash near a vent (${ASH_AT_FULL} ash^2 micrograms per cubic metre of 1.75 micrometre grains, twice their cross section of extinction: 0.12 is the distal 2010 Eyjafjallajokull cloud, about 7 km; 0.35 about 930 m; 1 about 114 m). It dims the sun grey, without reddening it, and gives the fog a neutral grey. An eruption in the scene raises it at the camera by itself while this row is null.`,
    ),
  ),
  follows(
    n(
      'spray',
      'air',
      0,
      0,
      1,
      0.01,
      '',
      `Sea spray in the air, 0 none to 1 the surf zone in a gale (${SPRAY_AT_FULL} spray^2 micrograms per cubic metre of dry sea salt, the wet particles twice the dry radius: the open sea at 10 m/s is about 0.07, 19 km; 0.35 about 3 km; 1 about 420 m). A white haze. A sea in the scene raises it with the wind (Lovett 1978), thicker near the drive's surf line (de Leeuw et al. 2000), while this row is null.`,
    ),
  ),
  follows(
    n(
      'humidity',
      'air',
      0,
      0,
      1,
      0.01,
      '',
      'Relative humidity at 2 m, 0 bone dry to 1 saturated (fog). With the temperature it sets the dead fuel moisture of a fire front (Simard 1968 as the NFDRS gives it): 0.15 at 32 C is a red-flag afternoon (about 2 percent fuel moisture in the sun), 0.5 at 15 C a fair day (about 7 percent), 0.95 under rain.',
    ),
  ),
  follows(
    n(
      'temperature',
      'air',
      0,
      -80,
      60,
      0.5,
      'C',
      'Air temperature at 2 m. 15 C is the ICAO standard atmosphere at sea level; snow falls mostly below about 1 C (Dai 2008). Warmer air dries fuel faster.',
    ),
  ),
];
/** The rows that may change every frame (all of them). */
export const WEATHER_LIVE_SETTINGS: readonly WeatherSetting[] = liveSettings(WEATHER_SETTINGS) as WeatherSetting[];
const BY_NAME = settingIndex(WEATHER_SETTINGS) as Map<string, WeatherSetting>;

/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function weatherSettingDefaults(): Record<string, WeatherSettingValue> {
  return settingDefaults(WEATHER_SETTINGS) as Record<string, WeatherSettingValue>;
}

/**
 * Named looks, each only values of {@link WEATHER_SETTINGS} (a name left out keeps its default, which follows the storm
 * level): pass one to {@link applyWeatherSettings}, or spread it under your own values.
 */
export const WEATHER_LOOKS = {
  /** Today's defaults: every row at its default, as the weather draws with no settings. */
  natural: {},
  /** Still air under a clear sky. */
  calm: { storm: 0, wind: 0.2, gust: 0 },
  /** A gentle breeze, Beaufort 3. */
  breeze: { storm: 0, wind: 5, gust: 0.2 },
  /** A gale, Beaufort 8, under a heavy sky and no rain. */
  gale: { storm: 0.5, wind: 18, gust: 0.6, rainRate: 0, cloud: 0.8 },
  /** The storm preset: heavy rain, 18 m/s, thunder-dark cloud. */
  storm: { storm: 1 },
  /** A hurricane, Beaufort 12 and over, with lightning. */
  hurricane: { storm: 1, wind: 40, gust: 0.9, lightning: 0.5 },
  /** The fog preset: thick fog under low cloud and nearly still air. */
  fog: { storm: 0, wind: 1, gust: 0.05, cloud: 0.7, fog: 0.85 },
  /** A fine drizzle, 0.64 mm/h. */
  drizzle: { storm: 0, wind: 4, gust: 0.15, rainRate: 0.64, cloud: 0.85, fog: 0.15 },
  /** A downpour, 50 mm/h. */
  downpour: { storm: 0.5, rainRate: 50, cloud: 1 },
  /** A dust haze: a light breeze and 0.2 dust, about 6 km of visibility under a clear sky. */
  dustHaze: { storm: 0, wind: 6, gust: 0.3, dust: 0.2, cloud: 0.1 },
  /** A sandstorm: an 18 m/s wind raising dust to about 570 m of visibility. */
  sandstorm: { storm: 0, wind: 18, gust: 0.7, dust: 0.5, cloud: 0.2 },
  /** A haboob: a 25 m/s wall of dust, about 130 m of visibility, the sky closed over. */
  haboob: { storm: 0, wind: 25, gust: 0.9, dust: 0.9, cloud: 0.6 },
  /** A smoke haze: a light breeze and 0.15 smoke, about 6 km of visibility and a reddened sun. */
  smokeHaze: { storm: 0, wind: 4, gust: 0.2, smoke: 0.15, cloud: 0.1 },
  /** Wildfire smoke: 0.35 smoke, about 1.5 km of visibility and a sun that is a dim red disc. */
  wildfireSmoke: { storm: 0, wind: 7, gust: 0.4, smoke: 0.35, cloud: 0.2 },
  /** A black day: thick smoke, about 300 m of visibility and no no direct sun at noon. */
  blackDay: { storm: 0, wind: 12, gust: 0.6, smoke: 0.8, cloud: 0.5 },
  /** Ash falling from an eruption's cloud: 0.35 ash, about 930 m of visibility; the 3 km of ash takes the direct sun, so the light is diffuse. */
  ashfall: { storm: 0, wind: 6, gust: 0.3, ash: 0.35, cloud: 0.6 },
  /** Darkness at noon under a thick ash fall: 0.8 ash, under 200 m of visibility and almost no direct sun. */
  ashDarkness: { storm: 0, wind: 8, gust: 0.4, ash: 0.8, cloud: 0.9 },
  /** A fresh wind over the open sea: 0.12 spray, a white haze of about 13 km. */
  seaSpray: { storm: 0, wind: 12, gust: 0.4, spray: 0.12, cloud: 0.3 },
  /** The air beside breaking surf in a strong wind: 0.35 spray, about 3 km of white haze. */
  surfHaze: { storm: 0, wind: 15, gust: 0.5, spray: 0.35, cloud: 0.4 },
  /** A blizzard: full snowfall in a 25 m/s wind, with no rain. */
  blizzard: { storm: 1, rainRate: 0, snow: 1, wind: 25, gust: 0.8, cloud: 1, fog: 0.6, lightning: 0 },
  /**
   * A red-flag afternoon: 32 C, 15 percent humidity and a 9 m/s wind under a clear sky, where a fire front's dead fuel dries
   * to about 2 percent in the sun. US National Weather Service offices issue red flag warnings on criteria of this kind
   * (each office sets its own; humidity of 15 percent or less with a sustained 20 mi/h wind is a common pairing).
   */
  redFlag: { storm: 0, wind: 9, gust: 0.5, humidity: 0.15, temperature: 32, cloud: 0.05 },
  /** The animatedFeature family: a fair day, a light breeze, part cloud and a thin haze for depth. */
  animatedFeature: { storm: 0, wind: 4, gust: 0.2, cloud: 0.45, fog: 0.05 },
} as const satisfies Record<string, WeatherSettingValues>;
/** The name of a look in {@link WEATHER_LOOKS}. */
export type WeatherLookName = keyof typeof WEATHER_LOOKS;

/** The state at storm level `level`: clear at 0, the rain preset at 0.5, the storm preset at 1, linear between. */
function stormState(level: number): WeatherState {
  return level <= 0.5
    ? blendStates(WEATHER_PRESETS.clear, WEATHER_PRESETS.rain, level * 2, 'linear')
    : blendStates(WEATHER_PRESETS.rain, WEATHER_PRESETS.storm, level * 2 - 1, 'linear');
}

/**
 * The weather state `values` stand for (a name left out takes its default): the storm level's state, then each row
 * that is not null in its place. A visibility sets the fog that leaves it in the rain and snow of that state.
 * @throws TypeError for a name not in {@link WEATHER_SETTINGS}; RangeError for a value outside its row's range.
 */
export function weatherStateOf(values: WeatherSettingValues = {}): WeatherState {
  checkSettings(BY_NAME, values, 'weather', 'WEATHER_SETTINGS in @margoengine/weather/settings');
  const v = (name: string) => (name in values ? values[name]! : BY_NAME.get(name)!.default),
    state = stormState(v('storm') as number);
  for (const key of [
    'wind',
    'gust',
    'snow',
    'hail',
    'cloud',
    'lightning',
    'fog',
    'dust',
    'smoke',
    'ash',
    'spray',
    'humidity',
    'temperature',
  ] as const) {
    const x = v(key);
    if (x !== null) state[key] = x;
  }
  const rate = v('rainRate');
  if (rate !== null) state.rain = (rate / RAIN_RATE_AT_FULL) ** (1 / 3);
  const sight = v('visibility');
  if (sight !== null) state.fog = fogForVisibility(sight, state);
  state.windDirection = wrapAngle(((v('windDirection') as number) * Math.PI) / 180);
  return resolveState(state);
}

/** What {@link applyWeatherSettings} writes to: a `WeatherMachine`, or anything with a `set(state)`. */
export interface WeatherSettingTarget {
  set(state: WeatherState): unknown;
}
/**
 * Writes `values` into the weather so it shows exactly that state (a name left out takes its default): the machine
 * jumps to it at once, ending any transition. Call it every frame to key a slider over a shot: it creates nothing. A
 * `WeatherDrive` on the same machine pushes the state into the sky, the sea, the rain, the fog, the fire and smoke, the
 * scatter and the grass.
 * @throws TypeError for a name not in {@link WEATHER_SETTINGS}; RangeError for a value outside its row's range.
 * @example applyWeatherSettings(machine, WEATHER_LOOKS.gale);
 */
export function applyWeatherSettings(target: WeatherSettingTarget, values: WeatherSettingValues = {}): WeatherState {
  const state = weatherStateOf(values);
  target.set(state);
  return state;
}
