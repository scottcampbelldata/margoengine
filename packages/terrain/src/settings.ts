// Every live look control of TerrainColors as one machine-readable table, for sliders, panels and tools (the model is
// @margoengine/sky/settings): each row names an option, its group, kind, default, range, step, unit, what it does and
// `live`. Every row here is live: TerrainColors reads them from one small uniform, so `applyTerrainSettings` changes any
// of them each frame (keyed over a shot) without creating a pipeline, buffer or texture. What was compiled in at
// construction (`detail`, `variation`, `wetness`, whether `sandSurface` is on) is not a row. The named looks in
// `TERRAIN_LOOKS` are only values of these rows.
import {
  checkSettings,
  colorSetting,
  followsWeather,
  liveSettings,
  numberSetting,
  sameSettingValue,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import type { TerrainColors, TerrainLookUpdate } from './colors.js';

/** A colour value: linear RGB. */
export type TerrainSettingColor = readonly [number, number, number];
/** One value of a setting: a number, a colour, or null where `nullable`. */
export type TerrainSettingValue = number | TerrainSettingColor | null;
/** Values by setting name; a name left out takes its default. */
export type TerrainSettingValues = Readonly<Record<string, TerrainSettingValue>>;
/** The panel a setting sits in. */
export type TerrainSettingGroup = 'sand' | 'ripples' | 'colors' | 'bands' | 'wet';
/** One control: the shared row shape with the terrain's groups. */
export interface TerrainSetting extends SettingRow {
  readonly group: TerrainSettingGroup;
  readonly default: TerrainSettingValue;
}
const n = (
  name: string,
  group: TerrainSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): TerrainSetting => numberSetting(name, group, value, min, max, step, unit, about) as TerrainSetting;
const c = (name: string, group: TerrainSettingGroup, value: TerrainSettingColor, about: string): TerrainSetting =>
  colorSetting(name, group, value, 0, 1, about) as TerrainSetting;
// A height or slope bound that is the mesh's own range until given: null puts it back.
const own = (row: TerrainSetting, about: string): TerrainSetting => ({
  ...row,
  default: null,
  nullable: true,
  about,
});

/** Every terrain look control, in panel order. Defaults are the values TerrainColors uses without the option. */
export const TERRAIN_SETTINGS: readonly TerrainSetting[] = [
  c('sand.color', 'sand', [0.5, 0.42, 0.29], 'Beach and dune sand colour: dry sand has an albedo of about 0.4.'),
  {
    ...followsWeather(
      n(
        'sand.windDirection',
        'sand',
        0,
        0,
        360,
        1,
        'degrees',
        'The way the wind blows over the sand: 0 toward +x, 90 toward +z. Null follows the weather.',
      ),
      'windDirection',
    ),
  } as TerrainSetting,
  n(
    'sand.ripples',
    'ripples',
    1,
    0,
    2,
    0.01,
    '',
    'Ripple relief: 0 flat, 1 the real shape (height 1/15 of the spacing), 2 twice as steep.',
  ),
  n(
    'sand.ripple',
    'ripples',
    0.1,
    0.02,
    1,
    0.005,
    'm',
    'Ripple spacing: impact ripples of fine to medium sand are 5 to 20 cm apart.',
  ),
  n(
    'sand.streaks',
    'ripples',
    1,
    0,
    1,
    0.01,
    '',
    'Streak contrast along the wind: albedo varies by up to 8% either way at 1.',
  ),
  n('sand.sorting', 'ripples', 1, 0, 1, 0.01, '', 'Sorting by slope: lee slip faces paler, windward faces darker.'),
  n(
    'sand.broad',
    'ripples',
    0,
    0,
    1,
    0.01,
    '',
    'Broad scour bands along the wind (8 to 15 m wide) that stay at every distance.',
  ),
  c('meadow.low', 'colors', [0.133, 0.263, 0.033], 'Meadow colour at its lowest.'),
  c('meadow.high', 'colors', [0.274, 0.342, 0.064], 'Meadow colour at its highest.'),
  c('stone.color', 'colors', [0.253, 0.223, 0.187], 'Rock colour, above the stone height and on steep slopes.'),
  n('shore.start', 'bands', 0.3, -1000, 10000, 0.01, 'm', 'World height where the beach starts to give way to meadow.'),
  n(
    'shore.end',
    'bands',
    1.5,
    -1000,
    10000,
    0.01,
    'm',
    'World height above which there is no sand. Keep it above shore.start.',
  ),
  own(
    n('meadow.heightStart', 'bands', 0, -1000, 10000, 0.01, 'm', ''),
    "World height where the low meadow colour starts to give way to the high one; null is the mesh's lowest point.",
  ),
  own(
    n('meadow.heightEnd', 'bands', 0, -1000, 10000, 0.01, 'm', ''),
    "World height of the high meadow colour; null is the mesh's highest point. Keep it above meadow.heightStart.",
  ),
  own(
    n('stone.heightStart', 'bands', 0, -1000, 10000, 0.01, 'm', ''),
    "World height where meadow starts to give way to rock; null is above the mesh's highest point (only slopes are stone).",
  ),
  own(
    n('stone.heightEnd', 'bands', 0, -1000, 10000, 0.01, 'm', ''),
    'World height above which all is rock; null as stone.heightStart. Keep it above stone.heightStart.',
  ),
  n(
    'stone.normalStart',
    'bands',
    0.75,
    0,
    1,
    0.005,
    '',
    'Surface normal Y (0 vertical, 1 flat) below which steep ground starts to turn to rock: 0.75 is 41 degrees.',
  ),
  n(
    'stone.normalEnd',
    'bands',
    0.85,
    0,
    1,
    0.005,
    '',
    'Surface normal Y above which ground is meadow again: 0.85 is 32 degrees. Keep it above stone.normalStart.',
  ),
  n(
    'wet.darkening',
    'wet',
    0.6,
    0,
    1,
    0.01,
    '',
    'Albedo of fully wet ground (1 is no darkening); wet ground is also up to 40% smoother.',
  ),
  n(
    'wet.heightStart',
    'wet',
    -0.1,
    -1000,
    10000,
    0.01,
    'm',
    'World height where the wet band starts to dry, just above sea level.',
  ),
  n(
    'wet.heightEnd',
    'wet',
    0.4,
    -1000,
    10000,
    0.01,
    'm',
    'World height above which the ground is dry. Keep it above wet.heightStart.',
  ),
  n(
    'wet.dryTime',
    'wet',
    900,
    1,
    604800,
    1,
    's',
    'With a wetness map: seconds over which sand the water has left dries to 1/e of its moisture.',
  ),
  n(
    'wet.glossTime',
    'wet',
    20,
    0.1,
    3600,
    0.1,
    's',
    'With a wetness map: seconds over which the glossy water film on sand the water has left drains to 1/e.',
  ),
];
/** The rows that can change every frame (all of them). */
export const TERRAIN_LIVE_SETTINGS: readonly TerrainSetting[] = liveSettings(TERRAIN_SETTINGS) as TerrainSetting[];
const BY_NAME = settingIndex(TERRAIN_SETTINGS) as Map<string, TerrainSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function terrainSettingDefaults(): Record<string, TerrainSettingValue> {
  return settingDefaults(TERRAIN_SETTINGS) as Record<string, TerrainSettingValue>;
}
/**
 * Named looks, each only values of {@link TERRAIN_SETTINGS} (a name left out keeps its default): pass one to
 * {@link applyTerrainSettings}, or spread it under your own values.
 */
export const TERRAIN_LOOKS = {
  /** Today's defaults: every row at its default, as the terrain draws with no settings. */
  natural: {},
  /** Pale desert sand with sharp ripples and strong streaks. */
  paleDesert: { 'sand.color': [0.62, 0.52, 0.36], 'sand.ripples': 1.3, 'sand.streaks': 1, 'sand.broad': 0.6 },
  /** Red desert sand with long scour bands. */
  redDesert: { 'sand.color': [0.55, 0.3, 0.18], 'sand.ripples': 1, 'sand.broad': 1 },
  /** Dark volcanic beach sand, wetter and darker at the waterline. */
  volcanicBeach: { 'sand.color': [0.08, 0.08, 0.09], 'wet.darkening': 0.45, 'sand.ripples': 0.5, 'sand.streaks': 0.3 },
  /** A salt flat: pale, nearly flat, no ripples to speak of. */
  saltFlat: {
    'sand.color': [0.8, 0.78, 0.72],
    'sand.ripples': 0.2,
    'sand.streaks': 0.2,
    'sand.sorting': 0.2,
    'wet.darkening': 0.8,
  },
  /** The animatedFeature family: larger colour masses, softer fine detail, a clean wet band at the waterline. */
  animatedFeature: {
    'sand.color': [0.62, 0.5, 0.34],
    'sand.ripples': 0.6,
    'sand.streaks': 0.5,
    'sand.broad': 0.8,
    'meadow.low': [0.16, 0.33, 0.05],
    'meadow.high': [0.3, 0.42, 0.09],
    'stone.color': [0.3, 0.26, 0.21],
    'wet.darkening': 0.5,
    'wet.heightStart': -0.05,
    'wet.heightEnd': 0.3,
  },
} as const satisfies Record<string, TerrainSettingValues>;
/** The name of a look in {@link TERRAIN_LOOKS}. */
export type TerrainLookName = keyof typeof TERRAIN_LOOKS;

/**
 * Writes `values` onto a {@link TerrainColors} (a name left out takes its default) with one `setLook` call, so the
 * terrain shows exactly that state. A row at its default draws as TerrainColors does without the option. A null
 * `sand.windDirection` leaves the wind to whatever last set it (the weather drive, or the +x default).
 * @throws TypeError for a name not in {@link TERRAIN_SETTINGS}, or a sand row moved on a TerrainColors built without a
 * sand surface; RangeError for a value outside its row's range or kind, or a range whose start is not below its end.
 * @example applyTerrainSettings(colors, { ...TERRAIN_LOOKS.paleDesert, 'sand.windDirection': 45 });
 */
export function applyTerrainSettings(colors: TerrainColors, values: TerrainSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'terrain', 'TERRAIN_SETTINGS in @margoengine/terrain/settings');
  const v = (name: string) => (name in values ? values[name] : BY_NAME.get(name)!.default);
  const pair = (a: string, b: string) => (v(a) === null && v(b) === null ? null : ([v(a), v(b)] as [number, number]));
  const sandMoved = TERRAIN_SETTINGS.some(
    (s) =>
      s.name.startsWith('sand.') &&
      s.name !== 'sand.color' &&
      s.name in values &&
      !sameSettingValue(values[s.name], s.default),
  );
  const angle = v('sand.windDirection') as number | null,
    look: TerrainLookUpdate = {
      sand: v('sand.color') as TerrainSettingColor as [number, number, number],
      meadow: [v('meadow.low') as [number, number, number], v('meadow.high') as [number, number, number]],
      stone: v('stone.color') as [number, number, number],
      shore: [v('shore.start'), v('shore.end')] as [number, number],
      meadowHeight: pair('meadow.heightStart', 'meadow.heightEnd'),
      stoneHeight: pair('stone.heightStart', 'stone.heightEnd'),
      stoneNormal: [v('stone.normalStart'), v('stone.normalEnd')] as [number, number],
      wetHeight: [v('wet.heightStart'), v('wet.heightEnd')] as [number, number],
      wetDarkening: v('wet.darkening') as number,
      wetDryTime: v('wet.dryTime') as number,
      wetGlossTime: v('wet.glossTime') as number,
    };
  if (sandMoved || angle !== null || colors.sandSurfaceOn) {
    const rad = ((angle ?? 0) * Math.PI) / 180;
    look.sandSurface = {
      ...(angle === null ? {} : { wind: [Math.cos(rad), Math.sin(rad)] as [number, number] }),
      ripple: v('sand.ripple') as number,
      ripples: v('sand.ripples') as number,
      streaks: v('sand.streaks') as number,
      sorting: v('sand.sorting') as number,
      broad: v('sand.broad') as number,
    };
  }
  colors.setLook(look);
}
