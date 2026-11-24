// The options of erosion (`@margoengine/biomes/erosion`) as one machine-readable table, for sliders, panels and tools (the
// model is @margoengine/sky/settings): each row names an option, its group, kind, default, range, step, unit, what it does
// and `live`. Erosion is a one-shot over a height grid, so every row is `live: false`: a change runs erosion again over
// the first heights (`erodeWithSettings`, `erodeReliefWithSettings`), it does not edit an eroded grid. The named looks in
// `EROSION_LOOKS` are only values of these rows. Same grid and values, same bytes, on every machine.
import {
  checkSettings,
  copySettingValue,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import { rangeError, typeError } from '../../shared/errors.js';
import {
  erode,
  erodeRelief,
  type Erosion,
  type ErodedRelief,
  type ErosionOptions,
  type ReliefErosionOptions,
} from './erosion.js';
// The ground-material look families, so a scene can pick one by name without loading BiomeView.
export { BIOME_LOOKS, MATERIALS, biomeMaterials, type BiomeLookName, type BiomeLookValues, type MaterialLook } from './looks.js';
import type { HeightGrid } from './hydrology.js';
import type { Relief } from './relief.js';

/** One value of a setting: a number, or null where `nullable`. */
export type ErosionSettingValue = number | null;
/** Values by setting name; a name left out takes its default. */
export type ErosionSettingValues = Readonly<Record<string, ErosionSettingValue>>;
/** The panel a setting sits in. */
export type ErosionSettingGroup = 'rounds' | 'slope' | 'water' | 'sea' | 'relief';
/** One control: the shared row shape with erosion's groups; `live` is false for every row. */
export interface ErosionSetting extends SettingRow {
  readonly group: ErosionSettingGroup;
  readonly default: ErosionSettingValue;
}
const n = (
  name: string,
  group: ErosionSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): ErosionSetting => numberSetting(name, group, value, min, max, step, unit, about, false) as ErosionSetting;

/** Every erosion control, in panel order. Defaults are the values `erode` uses without the option. */
export const EROSION_SETTINGS: readonly ErosionSetting[] = [
  n(
    'erosion.iterations',
    'rounds',
    32,
    0,
    1024,
    1,
    'rounds',
    'Rounds of thermal then hydraulic erosion, a whole number. More rounds age the land: 16 is young and sharp, 256 worn and soft. 0 leaves the heights as they are.',
  ),
  n(
    'erosion.talus',
    'slope',
    35,
    0,
    89,
    1,
    'degrees',
    'Angle of repose: thermal erosion slides material down slopes steeper than this. Loose scree rests near 35, rock holds 55 and more.',
  ),
  n(
    'erosion.thermal',
    'slope',
    0.25,
    0,
    0.5,
    0.01,
    '',
    "Share of a cell's steepest excess over the talus slope that slides each round. 0 turns slope erosion off.",
  ),
  n(
    'erosion.capacity',
    'water',
    0.01,
    0,
    1,
    0.001,
    '',
    'What a flow can carry: millimetres of sediment per cell drained, per millimetre of cell side, per unit of slope. It grows with the water. 0 turns river erosion off.',
  ),
  n(
    'erosion.incision',
    'water',
    0.25,
    0,
    1,
    0.01,
    '',
    'Share of the spare carrying capacity a flow cuts from its bed each round: high cuts gullies and canyons, low leaves broad valleys.',
  ),
  n(
    'erosion.deposition',
    'water',
    0.5,
    0,
    1,
    0.01,
    '',
    'Share of the load over capacity a flow drops each round: high builds fans and flood plains, low carries the sediment out of the grid.',
  ),
  {
    ...n('erosion.sea', 'sea', 0, -10000, 10000, 1, 'm', ''),
    default: null,
    nullable: true,
    about: 'Sea level: cells below it are outlets like the border. Null is no sea. Not for a relief, whose sea is 0.',
  },
  {
    ...n('relief.step', 'relief', 0, 1, 1024, 1, 'm', ''),
    default: null,
    nullable: true,
    about:
      "Grid spacing for a relief's erosion. Null is 16 m, doubled until the world is at most 512 cells across. Only for a relief.",
  },
];
/** The rows that can change every frame: none, erosion is run again for each change. */
export const EROSION_LIVE_SETTINGS: readonly ErosionSetting[] = [];
const BY_NAME = settingIndex(EROSION_SETTINGS) as Map<string, ErosionSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function erosionSettingDefaults(): Record<string, ErosionSettingValue> {
  return settingDefaults(EROSION_SETTINGS) as Record<string, ErosionSettingValue>;
}
/**
 * Named looks, each only values of {@link EROSION_SETTINGS} (a name left out keeps its default): pass one to
 * {@link erodeWithSettings}, or spread it under your own values.
 */
export const EROSION_LOOKS = {
  /** Young hills: few rounds, steep sides, little cut. */
  youngHills: {
    'erosion.iterations': 16,
    'erosion.talus': 40,
    'erosion.thermal': 0.15,
    'erosion.capacity': 0.005,
    'erosion.incision': 0.15,
    'erosion.deposition': 0.4,
  },
  /** Old worn hills: many rounds, low repose, rounded ridges and wide valleys. */
  oldWornHills: {
    'erosion.iterations': 256,
    'erosion.talus': 25,
    'erosion.thermal': 0.4,
    'erosion.capacity': 0.01,
    'erosion.incision': 0.3,
    'erosion.deposition': 0.6,
  },
  /** Badlands: hard steep walls cut into gullies, little of the sediment kept. */
  badlands: {
    'erosion.iterations': 96,
    'erosion.talus': 55,
    'erosion.thermal': 0.1,
    'erosion.capacity': 0.05,
    'erosion.incision': 0.7,
    'erosion.deposition': 0.1,
  },
  /** A river valley: a wide bed that fills with deposited silt. */
  riverValley: {
    'erosion.iterations': 128,
    'erosion.talus': 30,
    'erosion.thermal': 0.25,
    'erosion.capacity': 0.02,
    'erosion.incision': 0.5,
    'erosion.deposition': 0.8,
  },
  /** A desert wadi: flash floods that cut deep and drop nearly all they carry on the flat. */
  desertWadi: {
    'erosion.iterations': 64,
    'erosion.talus': 38,
    'erosion.thermal': 0.35,
    'erosion.capacity': 0.08,
    'erosion.incision': 0.6,
    'erosion.deposition': 0.9,
  },
} as const satisfies Record<string, ErosionSettingValues>;
/** The name of a look in {@link EROSION_LOOKS}. */
export type ErosionLookName = keyof typeof EROSION_LOOKS;

function check(values: ErosionSettingValues): (name: string) => ErosionSettingValue {
  checkSettings(BY_NAME, values, 'erosion', 'EROSION_SETTINGS in @margoengine/biomes/settings');
  const iterations = values['erosion.iterations'];
  if (iterations !== undefined && !Number.isInteger(iterations))
    throw rangeError('Invalid erosion setting erosion.iterations; use a whole number from 0 to 1024', 'biomes');
  return (name) =>
    name in values ? values[name] : (copySettingValue(BY_NAME.get(name)!.default) as ErosionSettingValue);
}

/**
 * The options of {@link erode} for these values (a name left out takes its default), checked against the rows. Pass
 * them to `erode` yourself, or use {@link erodeWithSettings}.
 * @throws TypeError for a name not in {@link EROSION_SETTINGS} or `relief.step` (a relief's row); RangeError for a value
 * outside its row's range, or iterations that are not a whole number.
 * @example const options = erosionOptions(EROSION_LOOKS.badlands);
 */
export function erosionOptions(values: ErosionSettingValues = {}): ErosionOptions {
  const v = check(values);
  if (v('relief.step') !== null)
    throw typeError('Setting relief.step is for erodeReliefWithSettings; erode has no grid spacing option', 'biomes');
  const sea = v('erosion.sea');
  return {
    iterations: v('erosion.iterations') as number,
    talus: v('erosion.talus') as number,
    thermal: v('erosion.thermal') as number,
    capacity: v('erosion.capacity') as number,
    incision: v('erosion.incision') as number,
    deposition: v('erosion.deposition') as number,
    ...(sea === null ? {} : { sea: Math.round(sea * 1000) }),
  };
}
/**
 * Runs {@link erode} on `grid` with these values (a name left out takes its default): a change of a value runs it again
 * over the first heights. The defaults give the bytes of `erode(grid)`.
 * @throws what {@link erosionOptions} and `erode` throw.
 * @example const eroded = erodeWithSettings({ height, nx: 257, nz: 257, step: 16000 }, EROSION_LOOKS.riverValley);
 */
export function erodeWithSettings(grid: HeightGrid, values: ErosionSettingValues = {}): Erosion {
  return erode(grid, erosionOptions(values));
}
/**
 * Runs {@link erodeRelief} on `relief` with these values: `relief.step` is the grid spacing (null the default), and
 * `erosion.sea` must be null (a relief's sea is 0).
 * @throws TypeError for an unknown name or `erosion.sea` on a relief; RangeError as {@link erosionOptions}.
 * @example const worn = erodeReliefWithSettings(createRelief({ seed: 7 }), { ...EROSION_LOOKS.oldWornHills, 'relief.step': 32 });
 */
export function erodeReliefWithSettings(relief: Relief, values: ErosionSettingValues = {}): ErodedRelief {
  const v = check(values);
  if (v('erosion.sea') !== null)
    throw typeError('Setting erosion.sea is for a grid; a relief has its sea at 0 m', 'biomes');
  const step = v('relief.step'),
    { sea: _sea, ...options } = erosionOptions({ ...values, 'relief.step': null });
  const run: ReliefErosionOptions = step === null ? options : { ...options, step };
  return erodeRelief(relief, run);
}

/** The panel a disturbance setting sits in. */
export type DisturbanceSettingGroup = 'fire' | 'flood' | 'map';
/** One control of the burnt and flooded plants of `BiomeView`: the shared row shape; `live` is false for every row. */
export interface DisturbanceSetting extends SettingRow {
  readonly group: DisturbanceSettingGroup;
  readonly default: number;
}
const d = (
  name: string,
  group: DisturbanceSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): DisturbanceSetting => numberSetting(name, group, value, min, max, step, unit, about, false) as DisturbanceSetting;

/**
 * The settings of `BiomeView`'s `disturbance` option (and of `disturbanceStates`) as rows, in panel order. All are
 * `live: false`: the marks are made once from the history when the view attaches, so a change builds the view again
 * (a live fire or flood goes through `view.plantStates.setSources` instead).
 */
export const DISTURBANCE_SETTINGS: readonly DisturbanceSetting[] = [
  d('disturbance.intensity', 'fire', 2000, 1, 100000, 1, 'kW/m', 'Fireline intensity of the burns. Sets the scorch height (Van Wagner 1973) and flame length that chars the bark (Byram 1959); a function of position goes through `disturbanceStates` itself.'),
  d('disturbance.ambient', 'fire', 25, -60, 59, 1, 'deg C', 'Air temperature at the fires, for the scorch height.'),
  d('disturbance.wind', 'fire', 2, 0, 40, 0.5, 'm/s', 'Midflame wind at the fires, for the scorch height.'),
  d('disturbance.burnYears', 'fire', 1, 1, 10000, 1, 'years', 'Whole years a burn shows scorched foliage, stripped crowns and ash. 1 means burnt in the history\'s last year.'),
  d('disturbance.charYears', 'fire', 30, 1, 10000, 1, 'years', 'Whole years charred bark stays on the stems after a burn (at least burnYears).'),
  d('disturbance.floodPeriod', 'flood', 10, 2, 65535, 1, 'years', 'Return period of the flood whose mud line shows: cells it reaches carry the mark.'),
  d('disturbance.floodMark', 'flood', 0.5, 0, 100, 0.1, 'm', 'Height of the high-water mark on the plants.'),
  d('disturbance.cell', 'map', 8, 0.5, 1000, 0.5, 'm', 'Size of a plant state map cell. A map is at most 1,024 cells a side.'),
];
/** The rows that can change every frame: none, the marks are made when the view attaches. */
export const DISTURBANCE_LIVE_SETTINGS: readonly DisturbanceSetting[] = [];
const DISTURBANCE_BY_NAME = settingIndex(DISTURBANCE_SETTINGS) as Map<string, DisturbanceSetting>;
/** Every disturbance setting at its default, as a fresh object to edit (a slider panel's state). */
export function disturbanceSettingDefaults(): Record<string, number> {
  return settingDefaults(DISTURBANCE_SETTINGS) as Record<string, number>;
}
/**
 * The options of `BiomeView`'s `disturbance` (minus its `history`) for these values (a name left out takes its default),
 * checked against the rows: `{ intensity, ambient, wind, burnYears, charYears, floodPeriod, floodMark, cell }`.
 * @throws TypeError for a name not in {@link DISTURBANCE_SETTINGS}; RangeError for a value outside its row, a
 * non-whole year count, or `charYears` below `burnYears`.
 * @example const view = await BiomeView.attach(engine, world, { disturbance: { history, ...disturbanceOptions({ 'disturbance.intensity': 6000 }) } });
 */
export function disturbanceOptions(values: Readonly<Record<string, number>> = {}): {
  readonly intensity: number;
  readonly ambient: number;
  readonly wind: number;
  readonly burnYears: number;
  readonly charYears: number;
  readonly floodPeriod: number;
  readonly floodMark: number;
  readonly cell: number;
} {
  checkSettings(DISTURBANCE_BY_NAME, values, 'biomes', 'DISTURBANCE_SETTINGS in @margoengine/biomes/settings');
  const v = (name: string): number => (name in values ? values[name] : DISTURBANCE_BY_NAME.get(name)!.default);
  for (const name of ['burnYears', 'charYears', 'floodPeriod'])
    if (!Number.isInteger(v(`disturbance.${name}`)))
      throw rangeError(`Invalid disturbance setting disturbance.${name}; use a whole number of years`, 'biomes');
  if (v('disturbance.charYears') < v('disturbance.burnYears'))
    throw rangeError('Invalid disturbance setting disturbance.charYears; it must be at least burnYears', 'biomes');
  return {
    intensity: v('disturbance.intensity'),
    ambient: v('disturbance.ambient'),
    wind: v('disturbance.wind'),
    burnYears: v('disturbance.burnYears'),
    charYears: v('disturbance.charYears'),
    floodPeriod: v('disturbance.floodPeriod'),
    floodMark: v('disturbance.floodMark'),
    cell: v('disturbance.cell'),
  };
}
