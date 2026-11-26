// Every live Water control as one machine-readable table, for sliders, panels and tools, on the row shape every package's
// `/settings` shares (packages/shared/settings.js): each row names an option, its group, kind, default, range, step, unit
// and what it does, plus `live` and, where the weather drives it, `nullable` (null = follow the weather). The named looks
// in `WATER_LOOKS` are only values of these rows. `applyWaterSettings` writes a set of values onto a `Water`.
//
// Only what can move every frame is a row: the wind, the foam, the chop, the wave height, the sea level, the deep colour
// and the shoreline foam width. What a Water is built from (its size, segments, `waves`, terrain, `spray`, `horizon` and
// the capture hooks) is chosen when it is made.
//
// The wind rows follow the Beaufort scale and the sea state of the WMO (Douglas scale) as public tables; the whitecaps
// and glitter they drive are cited in index.ts and sea-state.ts.
import {
  checkSettings,
  colorSetting,
  followsWeather,
  heldFromWeather,
  holdFromWeather,
  liveSettings,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import type { Water, WaterWind } from './index.js';
import { SEA_DIRECTION } from './sea-state.js';
import type { Flood } from './flood.js';
import type { ShipWakes } from './ships.js';
import type { BergFoam, BergSpray, IceMaterial, SeaIce } from './ice.js';

/** A colour value: linear RGB. */
export type WaterSettingColor = readonly [number, number, number];
/** One value of a setting: a number, a colour, or null where `nullable`. */
export type WaterSettingValue = number | WaterSettingColor | null;
/** Values by setting name; a name left out takes its default. */
export type WaterSettingValues = Readonly<Record<string, WaterSettingValue>>;
/** The panel a setting sits in. */
export type WaterSettingGroup = 'wind' | 'surface' | 'look';
/** One control. */
export interface WaterSetting extends SettingRow {
  readonly group: WaterSettingGroup;
  readonly kind: 'number' | 'color';
  readonly default: WaterSettingValue;
}
const n = (
  name: string,
  group: WaterSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): WaterSetting => numberSetting(name, group, value, min, max, step, unit, about) as WaterSetting;
const follows = (row: WaterSetting, weather: string): WaterSetting => followsWeather(row, weather) as WaterSetting;
const DEFAULT_FETCH = 100000;

/**
 * Every Water control that can change every frame, in panel order. Defaults are what a Water made without the option
 * does. A null default follows the weather: a `WeatherDrive` sets the wind, and a null row leaves what it set.
 */
export const WATER_SETTINGS: readonly WaterSetting[] = [
  follows(
    n(
      'windSpeed',
      'wind',
      6,
      0,
      100,
      0.1,
      'm/s',
      'Wind at 10 m that raises the sea: its height, steepness, foam and glitter. Beaufort 3 from 3.4 m/s, 8 (gale) from 17.2, 12 (hurricane) from 32.7. Null follows the weather. Not for a Water made with `waves`.',
    ),
    'wind',
  ),
  follows(
    n(
      'windDirection',
      'wind',
      0,
      0,
      360,
      1,
      'degrees',
      'Compass direction the waves travel: 0 is +Z, 90 is +X. Null follows the weather.',
    ),
    'windDirection',
  ),
  n(
    'fetch',
    'wind',
    DEFAULT_FETCH,
    1,
    1e7,
    100,
    'm',
    'Distance the wind has blown over open water: a short fetch is a small sea, a long one a full one.',
  ),
  follows(
    n(
      'whitecaps',
      'surface',
      0,
      0,
      1,
      0.01,
      '',
      'Breaking crests, 0 none to 1 a gale with long streaks. Null lets the wind decide (3.84e-6 U^3.41 of the sea).',
    ),
    'wind',
  ),
  follows(
    n(
      'chop',
      'surface',
      0,
      0,
      1,
      0.01,
      '',
      'Wind chop: stronger ripples and a short wind-sea layer. Null leaves the value the weather or the options gave.',
    ),
    'wind',
  ),
  {
    ...n(
      'waveHeight',
      'surface',
      0.3,
      0,
      100,
      0.01,
      'm',
      'Amplitude of the largest swell train: scales the whole sea. Null is the height the wind raises. Too large for the wind folds the surface and throws.',
    ),
    default: null,
    nullable: true,
  },
  {
    ...n(
      'seaLevel',
      'surface',
      0,
      -1000,
      1000,
      0.01,
      'm',
      'Mean sea level, world Y: raise it slowly for a storm surge or a tide and the flow floods the land below it, lower it and it drains. Null keeps the level the Water was made with (`height`) or last given.',
    ),
    default: null,
    nullable: true,
  },
  colorSetting(
    'color',
    'look',
    [0.01, 0.18, 0.25],
    0,
    1,
    'Deep-water colour, linear RGB: green for a shallow sea, near black for night or ice, brown for a flood.',
  ) as WaterSetting,
  n('foamDistance', 'look', 1, 0.01, 100, 0.01, 'm', 'Width of the foam along a shore and round things in the water.'),
  n(
    'glitterRoughness',
    'look',
    0.12,
    0.02,
    0.6,
    0.01,
    '',
    'Lowest roughness of the sun glitter: 0.12 is the floor of the real sea; higher widens and smooths the glints.',
  ),
  n(
    'foamSoftness',
    'look',
    0,
    0,
    1,
    0.01,
    '',
    'Softness of the foam edge: 0 is the physical foam with its fine pattern, 1 fades the pattern and widens the edge into large soft shapes.',
  ),
  colorSetting(
    'shallowColor',
    'look',
    [0.0, 0.28, 0.3],
    0,
    1,
    'Colour of water over a shallow bed, linear RGB: the band between it and the deep colour (see shallowDepth).',
  ) as WaterSetting,
  n(
    'shallowDepth',
    'look',
    0,
    0,
    100,
    0.1,
    'm',
    'Depth over which the shallow colour fades into the deep one; 0 turns the colour band off.',
  ),
];
/** The rows that can change every frame (all of them: none builds a pipeline, buffer or texture). */
export const WATER_LIVE_SETTINGS: readonly WaterSetting[] = liveSettings(WATER_SETTINGS) as WaterSetting[];
const BY_NAME = settingIndex(WATER_SETTINGS) as Map<string, WaterSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function waterSettingDefaults(): Record<string, WaterSettingValue> {
  return settingDefaults(WATER_SETTINGS) as Record<string, WaterSettingValue>;
}

/**
 * Named looks, each only values of {@link WATER_SETTINGS} (a name left out keeps its default, so the wind stays what the
 * weather says): pass one to {@link applyWaterSettings}, or spread it under your own values. Those with a `windSpeed`
 * raise their own sea, so use them on a Water made without `waves`.
 */
export const WATER_LOOKS = {
  /** Today's defaults: every row at its default, as the water draws with no settings. */
  natural: {},
  /** A glassy sea: almost no wind, no foam. */
  glassy: { windSpeed: 0.3, chop: 0 },
  /** A calm sea: a light air, ripples only. */
  calm: { windSpeed: 2, chop: 0.05 },
  /** A gentle breeze: the default sea, some small crests. */
  breeze: { windSpeed: 6, chop: 0.2 },
  /** A fresh breeze on a clear tropical shallow: pale turquoise water. */
  tropical: { windSpeed: 5, chop: 0.15, color: [0.0, 0.28, 0.3] },
  /** A grey cold sea under a fresh wind. */
  arctic: { windSpeed: 10, chop: 0.4, color: [0.015, 0.08, 0.1] },
  /** A sheltered harbour: a light breeze over green-brown water, foam kept close to the quay. */
  harbour: { windSpeed: 3, chop: 0.1, color: [0.025, 0.11, 0.1], foamDistance: 2 },
  /** A gale (Beaufort 8): breaking crests with streaks down the wind. */
  gale: { windSpeed: 18, chop: 0.6 },
  /** A storm (Beaufort 10): high steep seas, white foam over much of the surface. */
  storm: { windSpeed: 26, chop: 0.85, color: [0.01, 0.1, 0.14] },
  /** A hurricane (Beaufort 12): the whole sea streaked and white. */
  hurricane: { windSpeed: 40, chop: 1, color: [0.01, 0.07, 0.09] },
  /** A brown flood: muddy water, a moderate wind, foam gathering round whatever stands in it. */
  flood: { windSpeed: 4, chop: 0.15, color: [0.16, 0.11, 0.06], foamDistance: 3 },
  /** A night sea: dark water under a fresh breeze (the sky's low light is what it mirrors). */
  nightSea: { windSpeed: 8, chop: 0.3, color: [0.002, 0.012, 0.02] },
  /** The animatedFeature family: clear blue-green water in a light breeze, less small chop, foam in wide soft shapes. */
  animatedFeature: {
    windSpeed: 6,
    chop: 0.12,
    color: [0.02, 0.32, 0.42],
    foamDistance: 3,
    glitterRoughness: 0.24,
    foamSoftness: 0.7,
    shallowColor: [0.04, 0.5, 0.5],
    shallowDepth: 4,
  },
} as const satisfies Record<string, WaterSettingValues>;
/** The name of a look in {@link WATER_LOOKS}. */
export type WaterLookName = keyof typeof WATER_LOOKS;

// The wind a Water had before these rows first set it, for a later null to hand back.
const WIND_BEFORE = new WeakMap<Water, Readonly<WaterWind>>();

/**
 * Writes `values` onto the Water (a name left out takes its default), in the order wind, foam, chop, wave height, sea
 * level, colour, foam width, glitter roughness, foam softness, shallow band. A null `seaLevel` leaves the level as it is. A null `windSpeed` or `windDirection` leaves that part of the wind as it is (the weather drive's); both null hand back
 * a wind these rows set to the one the Water had before they set it. A null
 * `whitecaps` hands the foam to the wind, a null `waveHeight` gives the trains the wind's own amplitudes, and a null
 * `chop` leaves the chop alone (a chop these rows set goes back to the options' `chop`, default 0). Every write is a number into the frame's uniform: nothing is created, so it can run every
 * frame of a shot. The values are checked before anything is written.
 * @throws TypeError for a name not in {@link WATER_SETTINGS}, or a wind value on a Water made with `waves`; RangeError
 * for a value outside its row's range, or a `waveHeight` that would fold the surface.
 * @example applyWaterSettings(water, WATER_LOOKS.gale);
 */
export function applyWaterSettings(water: Water, values: WaterSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'water', 'WATER_SETTINGS in @margoengine/water/settings');
  const value = (name: string) => (name in values ? values[name] : BY_NAME.get(name)!.default) as number | null;
  const speed = value('windSpeed'),
    angle = value('windDirection'),
    fetch = value('fetch') as number,
    holds = speed !== null || angle !== null;
  // Null hands the wind back: a wind these rows set gives way to the one the Water had before they took it (the
  // options' or the weather drive's, which writes it again from then on), not the rows' last value.
  if (water.wind && holds && !heldFromWeather(water, 'wind')) WIND_BEFORE.set(water, water.wind);
  const before = holds ? undefined : WIND_BEFORE.get(water);
  if (!holds) WIND_BEFORE.delete(water);
  const now = water.wind,
    held = before ?? now;
  if (!held || !now) {
    if (speed !== null || angle !== null || fetch !== DEFAULT_FETCH)
      throw new TypeError(
        'Water settings windSpeed, windDirection and fetch need a Water made without options.waves; set them to null (and fetch 100000) or build the Water with a wind',
      );
  } else {
    // A wind given back without a direction had the sea's own (setWind keeps the present one when none is given).
    const direction =
      angle === null
        ? (held.direction ?? (before ? SEA_DIRECTION : undefined))
        : ([Math.sin((angle * Math.PI) / 180), Math.cos((angle * Math.PI) / 180)] as const);
    const wanted = speed ?? held.speed;
    if (
      wanted !== now.speed ||
      fetch !== (now.fetch ?? DEFAULT_FETCH) ||
      direction?.[0] !== now.direction?.[0] ||
      direction?.[1] !== now.direction?.[1]
    )
      water.setWind({ speed: wanted, fetch, direction });
  }
  holdFromWeather(water, 'wind', holds);
  water.setWhitecaps(value('whitecaps'));
  const chop = value('chop');
  if (chop !== null) water.setChop(chop);
  // Null leaves the chop the options gave: a chop these rows set is taken back to it.
  else if (heldFromWeather(water, 'chop')) water.setChop(water.options.chop ?? 0);
  holdFromWeather(water, 'chop', chop !== null);
  water.setWaveHeight(value('waveHeight'));
  const sea = value('seaLevel');
  if (sea !== null) water.setSeaLevel(sea);
  water.setColor(value('color') as unknown as WaterSettingColor);
  water.setFoamDistance(value('foamDistance') as number);
  water.setGlitterRoughness(value('glitterRoughness') as number);
  water.setFoamSoftness(value('foamSoftness') as number);
  water.setShallow(value('shallowColor') as unknown as WaterSettingColor, value('shallowDepth') as number);
}

// The Flood (`@margoengine/water/flood`) has its own rows on the same shape: what can change every frame of a disaster
// shot is the storm surge, its rise, the rain, the bed roughness, the inflows, the continental shelf the wind sets the
// sea up over, the swell let in at the sea sides and the height of the wave makers. What a Flood is built from (its Water, sources, walls, obstacles, boundaries, step limits) is chosen when it
// is made. The surge law (stress x shelf length / (rho g shelf depth)) is Resio and Westerink 2008,
// https://doi.org/10.1063/1.2982120; the bed friction is Manning's n (Chow 1959).
/** The panel a flood setting sits in. */
export type FloodSettingGroup = 'sea' | 'flow';
/** One flood control. */
export interface FloodSetting extends SettingRow {
  readonly group: FloodSettingGroup;
  readonly kind: 'number';
  readonly default: number | null;
}
/** Values by flood setting name; a name left out takes its default. */
export type FloodSettingValues = Readonly<Record<string, number | null>>;
const fn = (
  name: string,
  group: FloodSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): FloodSetting => numberSetting(name, group, value, min, max, step, unit, about) as FloodSetting;
/** Every Flood control that can change every frame, in panel order. */
export const FLOOD_SETTINGS: readonly FloodSetting[] = [
  {
    ...fn(
      'surge',
      'sea',
      0,
      -50,
      50,
      0.01,
      'm',
      'Storm surge at the sea sides, metres above the sea level, eased in over `surgeRise`. Null is the wind set-up: wind stress x shelf length / (rho g shelf depth), about 0.2 m at 18 m/s and 1.2 m at 40 m/s on the default shelf.',
    ),
    default: null,
    nullable: true,
  },
  fn(
    'surgeRise',
    'sea',
    600,
    0,
    86400,
    1,
    's',
    'Seconds a change of the surge takes to arrive: 600 is a surge building over ten minutes; 0 is a step.',
  ),
  fn(
    'shelfLength',
    'sea',
    50000,
    1,
    1e7,
    100,
    'm',
    'Length of the shallow shelf the wind pushes the sea up over; a long shelf gives a bigger wind set-up.',
  ),
  fn('shelfDepth', 'sea', 20, 0.1, 1e4, 0.1, 'm', 'Depth of that shelf; a shallow one gives a bigger wind set-up.'),
  fn(
    'swell',
    'sea',
    1,
    0,
    10,
    0.01,
    '',
    "Multiplier of the Water's swell coming in through the sea sides: 0 keeps it out, 1 is the Water's own sea, 2 doubles it.",
  ),
  fn(
    'waveMaker',
    'sea',
    1,
    0,
    10,
    0.01,
    '',
    'Multiplier of every wave maker amplitude: 0 stills them, 1 is as given, 2 doubles the waves.',
  ),
  followsWeather(
    fn(
      'rain',
      'flow',
      0,
      0,
      2000,
      1,
      'mm/h',
      'Rain on the whole map as depth. Null follows the weather drive (its rain rate); a number overrides it, 0 is none, 100 is a cloudburst.',
    ),
    'storm',
  ) as FloodSetting,
  fn(
    'roughness',
    'flow',
    0.03,
    0,
    0.2,
    0.001,
    's/m^(1/3)',
    "Manning's n of the bed: 0.012 smooth concrete, 0.03 earth, 0.1 thick brush; higher slows a flood and deepens it.",
  ),
  fn(
    'inflow',
    'flow',
    1,
    0,
    100,
    0.01,
    '',
    'Multiplier of every inflow discharge: 0 shuts the sources, 1 is as given, 2 doubles them.',
  ),
];
/** The flood rows that can change every frame (all of them). */
export const FLOOD_LIVE_SETTINGS: readonly FloodSetting[] = liveSettings(FLOOD_SETTINGS) as FloodSetting[];
const FLOOD_BY_NAME = settingIndex(FLOOD_SETTINGS) as Map<string, FloodSetting>;
/** Every flood setting at its default, as a fresh object to edit. */
export function floodSettingDefaults(): Record<string, number | null> {
  return settingDefaults(FLOOD_SETTINGS) as Record<string, number | null>;
}
/** Named looks of a flood, each only values of {@link FLOOD_SETTINGS}. */
export const FLOOD_LOOKS = {
  /** A hurricane's surge: the wind sets the sea up (null surge), built over ten minutes, heavy rain. */
  stormSurge: { surge: null, surgeRise: 600, rain: 30, roughness: 0.03 },
  /** A cloudburst on hard ground: 120 mm/h, a smooth bed, rivers running fast and the sources doubled. */
  flashFlood: { rain: 120, roughness: 0.02, inflow: 2, surgeRise: 60 },
  /** A flood through brush and fields: a rough bed that slows and deepens the water. */
  muddy: { roughness: 0.08, rain: 10 },
} as const satisfies Record<string, FloodSettingValues>;
/** The name of a look in {@link FLOOD_LOOKS}. */
export type FloodLookName = keyof typeof FLOOD_LOOKS;
/**
 * Writes `values` onto the Flood's options (a name left out takes its default), every one read from the next tick, so it
 * can run every frame of a shot and creates nothing. A null `surge` is the wind set-up; a null `rain` follows the weather
 * drive, which then owns it (a number holds it against the weather).
 * @throws TypeError for a name not in {@link FLOOD_SETTINGS}; RangeError for a value outside its row's range.
 * @example applyFloodSettings(flood, FLOOD_LOOKS.stormSurge);
 */
export function applyFloodSettings(flood: Flood, values: FloodSettingValues = {}): void {
  checkSettings(FLOOD_BY_NAME, values, 'water flood', 'FLOOD_SETTINGS in @margoengine/water/settings');
  const value = (name: string) => (name in values ? values[name] : FLOOD_BY_NAME.get(name)!.default) as number | null;
  const o = flood.options;
  o.surge = value('surge');
  o.surgeRise = value('surgeRise') as number;
  o.shelf = { length: value('shelfLength') as number, depth: value('shelfDepth') as number };
  o.rain = value('rain');
  o.roughness = value('roughness') as number;
  o.swell = value('swell') as number;
  o.waveMaker = value('waveMaker') as number;
  o.inflow = value('inflow') as number;
  holdFromWeather(flood, 'rain', o.rain !== null);
}

// Ships (`@margoengine/water/ships`) have their own rows on the same shape: what can change every frame of a shot is the
// wake's height and life, the bow wave, the foam along the waterline and in the turbulent wake, and the lamps' glints. The
// hull, the path and the lamps themselves are chosen when the ship is added. The laws are cited in ships.ts (Kelvin 1887,
// Rabaud and Moisy 2013, Noblesse et al. 2008, Cox and Munk 1954, Ochi 1964).
/** The panel a ship setting sits in. */
export type ShipSettingGroup = 'wake' | 'foam' | 'lamps' | 'splash';
/** One ship control. */
export interface ShipSetting extends SettingRow {
  readonly group: ShipSettingGroup;
  readonly kind: 'number';
  readonly default: number | null;
}
/** Values by ship setting name; a name left out takes its default. */
export type ShipSettingValues = Readonly<Record<string, number | null>>;
const sn = (
  name: string,
  group: ShipSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): ShipSetting => numberSetting(name, group, value, min, max, step, unit, about) as ShipSetting;
/** Every ShipWakes control, in panel order; all are live. */
export const SHIP_SETTINGS: readonly ShipSetting[] = [
  sn(
    'wakeHeight',
    'wake',
    1,
    0,
    5,
    0.01,
    '',
    'Height of the Kelvin wake waves: 1 is a quarter of the bow wave at one hull length out, 0 none.',
  ),
  sn(
    'sternWaves',
    'wake',
    0.5,
    0,
    1,
    0.01,
    '',
    "The stern's wave system against the bow's (opposite in sign): 0 the bow's alone, 1 as strong.",
  ),
  sn(
    'wakeLife',
    'wake',
    120,
    1,
    3600,
    1,
    's',
    'Seconds a wave left on the trail takes to fade to a third: 30 a choppy sea, 600 a glassy calm.',
  ),
  sn(
    'bowWave',
    'wake',
    1,
    0,
    3,
    0.01,
    '',
    'Bow wave height multiplier: 1 is Noblesse et al. (2008) for the hull and speed.',
  ),
  sn(
    'waterlineFoam',
    'foam',
    0.8,
    0,
    10,
    0.01,
    'm',
    'Width of the foam band along the waterline at Froude 0.5; it widens with speed.',
  ),
  sn('foamLife', 'foam', 40, 1, 600, 1, 's', "Seconds the turbulent wake's foam takes to fade to a third."),
  sn('turbulentWake', 'foam', 1, 0, 3, 0.01, '', 'Strength of the white propeller wash behind the stern: 0 none.'),
  followsWeather(
    sn(
      'lampRoughness',
      'lamps',
      0.2,
      0.02,
      1,
      0.01,
      '',
      "Roughness of the lamps' glints, perceptual like the Water's glitter (GGX alpha = roughness^2, widened by the waves' slope variance): 0.2 a long thin glitter path on glassy water, 0.7 a wide smear. Null follows the Water's glitter, which follows the wind (Cox and Munk 1954).",
    ),
    'wind',
  ) as ShipSetting,
  sn('lampIntensity', 'lamps', 1, 0, 100, 0.01, '', "Multiplier of every lamp's intensity."),
  sn('sprayRate', 'splash', 2000, 0, 1e6, 10, '1/s', 'Bow spray particles a second where the bow wave breaks fully.'),
  sn(
    'slamBurst',
    'splash',
    400,
    0,
    1e6,
    1,
    '',
    'Particles a slam throws at its threshold; grows with the square of the excess.',
  ),
  sn(
    'slamThreshold',
    'splash',
    1,
    0.1,
    10,
    0.01,
    '',
    "Slam threshold as a multiple of Ochi's 0.093 sqrt(g L) re-entry speed.",
  ),
];
/** The ship rows that can change every frame (all of them). */
export const SHIP_LIVE_SETTINGS: readonly ShipSetting[] = liveSettings(SHIP_SETTINGS) as ShipSetting[];
const SHIP_BY_NAME = settingIndex(SHIP_SETTINGS) as Map<string, ShipSetting>;
/** Every ship setting at its default, as a fresh object to edit. */
export function shipSettingDefaults(): Record<string, number | null> {
  return settingDefaults(SHIP_SETTINGS) as Record<string, number | null>;
}
/** Named looks of ships, each only values of {@link SHIP_SETTINGS}. */
export const SHIP_LOOKS = {
  /** A glassy harbour at night: long-lived wakes, little foam, sharp lamp paths. */
  calmNight: { wakeLife: 600, foamLife: 60, turbulentWake: 0.6, lampRoughness: 0.25, lampIntensity: 2 },
  /** A ship driving into a storm: short-lived wakes torn up by the sea, heavy foam and spray. */
  heavyWeather: {
    wakeLife: 30,
    wakeHeight: 1.2,
    waterlineFoam: 2,
    turbulentWake: 1.5,
    sprayRate: 6000,
    slamBurst: 1200,
  },
} as const satisfies Record<string, ShipSettingValues>;
/** The name of a look in {@link SHIP_LOOKS}. */
export type ShipLookName = keyof typeof SHIP_LOOKS;
/**
 * Writes `values` (a name left out takes its default) onto ShipWakes' look and, when given, a ShipSplash; every one is read
 * from the next frame, so it can run every frame of a shot and creates nothing. A null `lampRoughness` follows the Water's
 * glitter (the weather's wind); a number holds it.
 * @throws TypeError for a name not in {@link SHIP_SETTINGS}; RangeError for a value outside its row's range.
 * @example applyShipSettings(wakes, SHIP_LOOKS.calmNight);
 */
export function applyShipSettings(
  wakes: ShipWakes | null,
  values: ShipSettingValues = {},
  splash?: { sprayRate: number; slamBurst: number; slamThreshold: number },
): void {
  checkSettings(SHIP_BY_NAME, values, 'water ships', 'SHIP_SETTINGS in @margoengine/water/settings');
  const value = (name: string) => (name in values ? values[name] : SHIP_BY_NAME.get(name)!.default) as number | null;
  if (wakes) {
    wakes.setLook({
      wakeHeight: value('wakeHeight') as number,
      sternWaves: value('sternWaves') as number,
      wakeLife: value('wakeLife') as number,
      bowWave: value('bowWave') as number,
      waterlineFoam: value('waterlineFoam') as number,
      foamLife: value('foamLife') as number,
      turbulentWake: value('turbulentWake') as number,
      lampRoughness: value('lampRoughness'),
      lampIntensity: value('lampIntensity') as number,
    });
    holdFromWeather(wakes, 'lampRoughness', value('lampRoughness') !== null);
  }
  if (splash) {
    splash.sprayRate = value('sprayRate') as number;
    splash.slamBurst = value('slamBurst') as number;
    splash.slamThreshold = value('slamThreshold') as number;
  }
}

// --- Ice ---
// The live rows of @margoengine/water/ice: the IceMaterial's look (blue bands, bubbles, light through the ice, the wet
// band, the notch and the scallops), the sea ice drift, the foam at the berg and the spray off its weather face. The
// densities and the meshes are chosen when the berg and the field are made. The laws are cited in ice.ts (Warren and
// Brandt 2008, Mullen and Warren 1988, Lekner and Dorf 1988, Nansen 1902, Doble et al. 2015, Pierson and Moskowitz 1964).
/** The panel an ice setting sits in. */
export type IceSettingGroup = 'ice' | 'waterline' | 'drift' | 'foam' | 'spray';
/** One ice control. */
export interface IceSetting extends SettingRow {
  readonly group: IceSettingGroup;
  readonly kind: 'number';
  readonly default: number | null;
}
/** Values by ice setting name; a name left out takes its default. */
export type IceSettingValues = Readonly<Record<string, number | null>>;
const ice = (
  name: string,
  group: IceSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): IceSetting => numberSetting(name, group, value, min, max, step, unit, about) as IceSetting;
/** Every ice control, in panel order; all are live. */
export const ICE_SETTINGS: readonly IceSetting[] = [
  ice(
    'blueIce',
    'ice',
    0.25,
    0,
    1,
    0.01,
    '',
    'Share of blue, clear ice in bands through the white bubbly ice: 0 all white, 1 all blue.',
  ),
  ice('bandScale', 'ice', 0.06, 0.005, 2, 0.005, '1/m', 'Blue bands per metre: 0.02 broad layers, 0.5 thin veins.'),
  ice(
    'bubbles',
    'ice',
    0.05,
    0.001,
    0.3,
    0.001,
    '',
    'Air bubble volume share of the white ice (1 - density / 917): more is whiter.',
  ),
  ice(
    'bubbleRadius',
    'ice',
    0.5,
    0.05,
    5,
    0.05,
    'mm',
    'Bubble radius of the white ice: smaller bubbles scatter more and whiten it.',
  ),
  ice(
    'subsurface',
    'ice',
    0.7,
    0,
    1,
    0.01,
    '',
    'Light seen through the ice: 0 opaque, 1 glowing where the moon or sun is behind it.',
  ),
  ice(
    'scatterDepth',
    'ice',
    5,
    0,
    50,
    0.1,
    'm',
    'Clear ice the light crosses for the tint of that glow: deeper is bluer (Warren and Brandt 2008).',
  ),
  ice('roughness', 'ice', 0.35, 0.02, 1, 0.01, '', 'Roughness of dry ice.'),
  ice('scallopSize', 'ice', 0.3, 0.02, 5, 0.01, 'm', 'Size of the melt scallops dimpling the walls.'),
  ice('scallopDepth', 'ice', 0.35, 0, 2, 0.01, '', 'Depth of the melt scallops: 0 smooth walls.'),
  ice('wetHeight', 'waterline', 1.5, 0, 20, 0.05, 'm', 'Height above the water the waves wet: about the wave height.'),
  ice('wetDarkening', 'waterline', 0.35, 0, 0.9, 0.01, '', 'How much darker wet ice is (Lekner and Dorf 1988).'),
  ice('wetRoughness', 'waterline', 0.06, 0.02, 1, 0.01, '', 'Roughness of wet ice: a water film is glossy.'),
  ice(
    'notchDepth',
    'waterline',
    0.8,
    0,
    10,
    0.05,
    'm',
    'Depth the waves have cut into the waterline (waveErosion gives metres a day).',
  ),
  ice('notchHeight', 'waterline', 1.2, 0.05, 10, 0.05, 'm', 'Height of the wave-cut notch: about the wave height.'),
  followsWeather(
    ice(
      'driftWind',
      'drift',
      0,
      0,
      60,
      0.1,
      'm/s',
      'Wind speed driving the sea ice. Null follows the wind of the Water (speed and direction).',
    ),
    'wind',
  ) as IceSetting,
  ice('windFactor', 'drift', 0.02, 0, 0.1, 0.001, '', 'Sea ice drift as a share of the wind: 0.02 (Nansen 1902).'),
  ice(
    'turning',
    'drift',
    25,
    -90,
    90,
    1,
    'deg',
    'Degrees the drift turns to the right of the wind: 20 to 40 in the north, negative in the south.',
  ),
  ice(
    'attenuation',
    'drift',
    1,
    0,
    20,
    0.1,
    '',
    'How fast the swell dies into the ice field: 1 is Doble et al. (2015), 0 none.',
  ),
  ice('foamWidth', 'foam', 3, 0, 50, 0.1, 'm', 'Width of the foam ring round the berg; it widens with the waves.'),
  ice('breakFoam', 'foam', 1, 0, 3, 0.01, '', 'Breaking white water on the weather side: 0 none.'),
  ice('foamTrail', 'foam', 60, 0, 1000, 1, 'm', 'Length of the foam streaks the swell carries past the berg.'),
  followsWeather(
    ice(
      'waveHeight',
      'foam',
      2,
      0,
      20,
      0.05,
      'm',
      'Significant wave height breaking on the berg. Null follows the wind of the Water (Pierson and Moskowitz, 0.21 U^2 / g).',
    ),
    'wind',
  ) as IceSetting,
  ice(
    'sprayRate',
    'spray',
    1500,
    0,
    1e6,
    10,
    '1/s',
    'Spray particles a second while the water climbs the weather face.',
  ),
  ice(
    'surgeBurst',
    'spray',
    300,
    0,
    1e6,
    1,
    '',
    'Particles a surge throws at its threshold; grows with the square of the excess.',
  ),
  ice('surgeThreshold', 'spray', 0.8, 0.05, 20, 0.01, 'm/s', 'Rise speed of the water at the face that throws spray.'),
];
/** The ice rows that can change every frame (all of them). */
export const ICE_LIVE_SETTINGS: readonly IceSetting[] = liveSettings(ICE_SETTINGS) as IceSetting[];
const ICE_BY_NAME = settingIndex(ICE_SETTINGS) as Map<string, IceSetting>;
/** Every ice setting at its default, as a fresh object to edit. */
export function iceSettingDefaults(): Record<string, number | null> {
  return settingDefaults(ICE_SETTINGS) as Record<string, number | null>;
}
/** Named looks of ice, each only values of {@link ICE_SETTINGS}. */
export const ICE_LOOKS = {
  /** A glacier berg on a calm night: much blue ice, a strong glow, a deep old notch. */
  calmNight: {
    blueIce: 0.4,
    subsurface: 0.85,
    scatterDepth: 8,
    wetHeight: 0.6,
    notchDepth: 1.5,
    breakFoam: 0.3,
    waveHeight: 0.5,
  },
  /** A berg in a North Atlantic gale: wet high up its face, heavy white water and spray. */
  gale: {
    wetHeight: 6,
    notchHeight: 3,
    breakFoam: 2.5,
    foamWidth: 8,
    foamTrail: 200,
    waveHeight: 7,
    sprayRate: 8000,
    surgeBurst: 1500,
    driftWind: 20,
  },
} as const satisfies Record<string, IceSettingValues>;
/** The name of a look in {@link ICE_LOOKS}. */
export type IceLookName = keyof typeof ICE_LOOKS;
/** What `applyIceSettings` writes to; each is optional. */
export interface IceSettingTargets {
  material?: IceMaterial | null;
  seaIce?: SeaIce | null;
  foam?: BergFoam | null;
  spray?: BergSpray | null;
  /** The Water a null `driftWind` follows. */
  water?: Water | null;
}
/**
 * Writes `values` (a name left out takes its default) onto an IceMaterial, a SeaIce field, BergFoam and BergSpray; each
 * is read from the next frame, so it can run every frame of a shot and creates nothing. A null `waveHeight` follows the
 * Water's wind; a null `driftWind` takes the wind of `targets.water` (left as it is without one).
 * @throws TypeError for a name not in {@link ICE_SETTINGS}; RangeError for a value outside its row's range.
 * @example applyIceSettings({ material, foam }, ICE_LOOKS.gale);
 */
export function applyIceSettings(targets: IceSettingTargets, values: IceSettingValues = {}): void {
  checkSettings(ICE_BY_NAME, values, 'water ice', 'ICE_SETTINGS in @margoengine/water/settings');
  const value = (name: string) => (name in values ? values[name] : ICE_BY_NAME.get(name)!.default) as number | null;
  const num = (name: string) => value(name) as number;
  const { material, seaIce, foam, spray, water } = targets ?? {};
  if (material)
    material.setLook({
      blueIce: num('blueIce'),
      bandScale: num('bandScale'),
      bubbles: num('bubbles'),
      bubbleRadius: num('bubbleRadius'),
      subsurface: num('subsurface'),
      scatterDepth: num('scatterDepth'),
      roughness: num('roughness'),
      scallopSize: num('scallopSize'),
      scallopDepth: num('scallopDepth'),
      wetHeight: num('wetHeight'),
      wetDarkening: num('wetDarkening'),
      wetRoughness: num('wetRoughness'),
      notchDepth: num('notchDepth'),
      notchHeight: num('notchHeight'),
    });
  if (seaIce) {
    const wind = value('driftWind');
    if (wind !== null) seaIce.setDrift({ wind: { speed: wind } });
    else if (water?.wind)
      seaIce.setDrift({ wind: { speed: water.wind.speed, direction: water.wind.direction ?? [1, 0.3] } });
    holdFromWeather(seaIce, 'wind', wind !== null);
    seaIce.setDrift({ windFactor: num('windFactor'), turning: num('turning'), attenuation: num('attenuation') });
  }
  if (foam) {
    foam.setLook({
      foamWidth: num('foamWidth'),
      breakFoam: num('breakFoam'),
      foamTrail: num('foamTrail'),
      waveHeight: value('waveHeight'),
    });
    holdFromWeather(foam, 'waveHeight', value('waveHeight') !== null);
  }
  if (spray) {
    spray.sprayRate = num('sprayRate');
    spray.surgeBurst = num('surgeBurst');
    spray.surgeThreshold = num('surgeThreshold');
  }
}

// Shot splashes (`@margoengine/water/splash`) have rows on the same shape: the counts of the crown, the column and the
// mist, the drawn height against the laws, the foam ring, how far a splash rides the waves, and the wind the spray and mist drift in. The laws are cited in
// splash.ts (Birkhoff et al. 1944, Johnson and Reid 1975, May 1975, Glasheen and McMahon 1996, Gunn and Kinzer 1949).
/** The panel a splash setting sits in. */
export type SplashSettingGroup = 'spray' | 'foam' | 'wind';
/** One splash control. */
export interface SplashSetting extends SettingRow {
  readonly group: SplashSettingGroup;
  readonly kind: 'number';
  readonly default: number | null;
}
const spn = (
  name: string,
  group: SplashSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): SplashSetting => numberSetting(name, group, value, min, max, step, unit, about) as SplashSetting;
/** Every ShotSplash control, in panel order; all are live. */
export const SPLASH_SETTINGS: readonly SplashSetting[] = [
  spn(
    'crown',
    'spray',
    1,
    0,
    10,
    0.01,
    '',
    'Particles of the crown of spray thrown up round each graze and entry (a multiple).',
  ),
  spn(
    'column',
    'spray',
    1,
    0,
    10,
    0.01,
    '',
    'Particles of the column that rises when the cavity behind an entering shot seals (a multiple; 0 none).',
  ),
  spn('mist', 'spray', 1, 0, 10, 0.01, '', 'Particles of the fine mist that hangs over a splash (a multiple).'),
  spn(
    'height',
    'spray',
    1,
    0,
    5,
    0.01,
    '',
    'Drawn heights against the laws (drop-limited crown and Worthington jet): 1 is the law.',
  ),
  spn('foamWidth', 'foam', 1, 0, 10, 0.01, '', 'Width of the foam ring each splash leaves (a multiple; 0 none).'),
  spn('foamLife', 'foam', 25, 0.5, 600, 0.5, 's', 'Seconds the foam ring takes to fade to a third.'),
  spn(
    'waveLift',
    'spray',
    1,
    0,
    1,
    0.01,
    '',
    'How far a splash rides the waves: 1 rises from the surface and throws its velocity (a WaveQuery as water), 0 the impact at rest.',
  ),
  followsWeather(
    spn('wind.x', 'wind', 0, -100, 100, 0.1, 'm/s', 'Wind east-west on the spray and mist; null follows the weather.'),
    'wind',
  ) as SplashSetting,
  followsWeather(
    spn(
      'wind.z',
      'wind',
      0,
      -100,
      100,
      0.1,
      'm/s',
      'Wind north-south on the spray and mist; null follows the weather.',
    ),
    'wind',
  ) as SplashSetting,
];
const SPLASH_BY_NAME = settingIndex(SPLASH_SETTINGS) as Map<string, SplashSetting>;
/** The splash rows that may change every frame (all of them). */
export const SPLASH_LIVE_SETTINGS: readonly SplashSetting[] = liveSettings(SPLASH_SETTINGS) as SplashSetting[];
/** Every splash setting at its default, as a fresh object to edit. */
export function splashSettingDefaults(): Record<string, number | null> {
  return settingDefaults(SPLASH_SETTINGS) as Record<string, number | null>;
}
/** Named looks, values of {@link SPLASH_SETTINGS}. */
export const SPLASH_LOOKS = {
  /** A calm sea: tall clean columns and long-lived foam. */
  calm: { mist: 0.6, foamLife: 45 },
  /** A gale: the mist and spray torn away, foam lost in the whitecaps. */
  gale: { mist: 1.6, column: 0.8, foamLife: 10 },
  /** The animatedFeature family: bigger, softer splashes. */
  animatedFeature: { crown: 1.3, column: 1.3, mist: 1.4, height: 1.25, foamWidth: 1.3 },
} as const satisfies Record<string, Readonly<Record<string, number | null>>>;
/** What applySplashSettings writes: a ShotSplash's look and its slots' emitters. */
export interface SplashSettingTarget {
  setLook(look: Record<string, number>): unknown;
  readonly slots: readonly {
    readonly crown: { options: object };
    readonly column: { options: object };
    readonly mist: { options: object };
  }[];
}
/**
 * Writes `values` onto a ShotSplash (a name left out takes its default); everything is read from the next frame. Both
 * wind rows null hand the spray and mist back to the weather (a `WeatherDrive` writes their wind); either one given sets
 * `[x, z]` on every slot's emitters and holds it.
 * @throws TypeError for a name not in {@link SPLASH_SETTINGS}; RangeError for a value outside its row's range.
 * @example applySplashSettings(splash, SPLASH_LOOKS.gale);
 */
export function applySplashSettings(
  target: SplashSettingTarget,
  values: Readonly<Record<string, number | null>> = {},
): void {
  checkSettings(SPLASH_BY_NAME, values, 'water splash', 'SPLASH_SETTINGS in @margoengine/water/settings');
  const value = (name: string) => (name in values ? values[name] : SPLASH_BY_NAME.get(name)!.default) as number | null;
  target.setLook(
    Object.fromEntries(
      ['crown', 'column', 'mist', 'height', 'foamWidth', 'foamLife', 'waveLift'].map((k) => [k, value(k) as number]),
    ),
  );
  const wx = value('wind.x'),
    wz = value('wind.z');
  for (const slot of target.slots)
    for (const e of [slot.crown, slot.column, slot.mist]) {
      const o = e.options as Record<string, unknown>;
      if (wx === null && wz === null) delete o.wind;
      else o.wind = [wx ?? 0, wz ?? 0];
      holdFromWeather(o, 'wind', wx !== null || wz !== null);
    }
}
