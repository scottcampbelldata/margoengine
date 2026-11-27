// Every option of the building rules (`@margoengine/procedural/building-rules`), the harbour pieces
// (`@margoengine/procedural/harbour`) and the city generator (`@margoengine/procedural/city`) as slider rows on the shared shape (packages/shared/settings.js; the model is
// @margoengine/sky/settings). None is live: each one rebuilds geometry, so a panel calls the generator again when one
// moves. The row defaults are the defaults of the generators (the building rows the `japan-2011-house` style); the
// option builders map only the values given, so a style's own defaults hold for every row left out.
import {
  checkSettings,
  choiceSetting,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import {
  BUILDING_STYLES,
  BUILDING_STYLE_SETS,
  type BuildingRuleOptions,
  type BuildingStyle,
} from './building-rules.js';
import type { BuildingPlanOptions } from './building-plans.js';
import type { CityOptions } from './city.js';
import type {
  BreakwaterOptions,
  FishingBoatOptions,
  QuayOptions,
  SeaWallOptions,
  SlipwayOptions,
  TetrapodArmourOptions,
} from './harbour.js';

/** One value of a setting. */
export type BuildingSettingValue = number | string;
/** Values by setting name; a name left out keeps the generator's (or the style's) default. */
export type BuildingSettingValues = Readonly<Record<string, BuildingSettingValue>>;
/** One control: the shared row shape. */
export interface BuildingSetting extends SettingRow {
  readonly default: BuildingSettingValue;
}
const n = (
  name: string,
  group: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
) => numberSetting(name, group, value, min, max, step, unit, about, false) as BuildingSetting;
const c = (name: string, group: string, choices: readonly string[], about: string) =>
  choiceSetting(name, group, choices, about, false) as BuildingSetting;
const onOff = ['on', 'off'] as const,
  offOn = ['off', 'on'] as const;

/** Every building control, in panel order. All rebuild (live false). */
export const BUILDING_SETTINGS: readonly BuildingSetting[] = [
  c('style', 'mass', BUILDING_STYLES, 'The style set every other default comes from.'),
  n('width', 'mass', 9.1, 3, 120, 0.1, 'm', 'Footprint along the front.'),
  n('depth', 'mass', 7.28, 3, 120, 0.1, 'm', 'Footprint from front to back.'),
  n('storeys', 'mass', 2, 1, 60, 1, '', 'Number of storeys.'),
  n('storeyHeight', 'mass', 2.9, 2.2, 8, 0.05, 'm', 'Floor to floor height of every storey (with storeys).'),
  n('plinth', 'mass', 0.5, 0, 2, 0.01, 'm', 'Ground floor height above the ground.'),
  c('roof', 'roof', ['hip', 'gable', 'hip-gable', 'shed', 'flat'], 'Roof shape; hip-gable is the irimoya.'),
  n('pitch', 'roof', 24.2, 2, 60, 0.1, 'deg', 'Roof pitch.'),
  c(
    'ridge',
    'roof',
    ['auto', 'x', 'z'],
    'Ridge direction: auto along the longer side, x along the front, z front to back.',
  ),
  n(
    'gableInset',
    'roof',
    0.5,
    0.1,
    0.9,
    0.01,
    '',
    'Hip-gable: how far in the small gable sits, as a share of half the depth.',
  ),
  n('overhang', 'roof', 0.6, 0, 3, 0.01, 'm', 'Eaves and verge overhang.'),
  c('roofing', 'roof', ['tile', 'shingle', 'metal', 'membrane'], 'Roof covering and its courses.'),
  n('parapet', 'roof', 0, 0, 3, 0.05, 'm', 'Flat roofs: parapet height.'),
  n('falseFront', 'roof', 0, 0, 8, 0.05, 'm', 'False front height over the eaves (0 none); it always clears the roof.'),
  c('falseFrontShape', 'roof', ['square', 'stepped'], 'False front outline.'),
  c('cladding', 'walls', ['siding', 'clapboard', 'brick', 'concrete', 'plaster', 'metal'], 'Outer wall finish.'),
  n('wall', 'walls', 0.15, 0.08, 1, 0.01, 'm', 'Wall thickness.'),
  n('reveal', 'walls', 0.08, 0.02, 0.5, 0.01, 'm', 'How far glass and doors sit back from the wall face.'),
  n('bayWidth', 'openings', 2.73, 1, 12, 0.01, 'm', 'Target bay width; each side holds a whole number of bays.'),
  n('windowWidth', 'openings', 1.69, 0.3, 6, 0.01, 'm', 'Window width.'),
  n('windowHeight', 'openings', 1.17, 0.3, 6, 0.01, 'm', 'Window height.'),
  n('sill', 'openings', 0.9, 0, 3, 0.01, 'm', 'Window sill height above its floor.'),
  c('windowKind', 'openings', ['sliding', 'double-hung', 'strip'], 'Window type.'),
  c('sideWindows', 'openings', onOff, 'Windows on the two end sides.'),
  n('doorWidth', 'openings', 0.9, 0.6, 8, 0.01, 'm', 'Door width.'),
  n('doorHeight', 'openings', 2.1, 0.6, 8, 0.01, 'm', 'Door height.'),
  c('storefront', 'frontage', offOn, 'Shop windows on the front ground floor.'),
  c('awning', 'frontage', offOn, 'A canvas awning over the storefront.'),
  n('porch', 'frontage', 0, 0, 5, 0.05, 'm', 'Front porch depth (0 none).'),
  n('porchWidth', 'frontage', 1, 0.2, 1, 0.01, '', 'Porch width as a share of the front.'),
  n('balcony', 'frontage', 0.91, 0, 3, 0.01, 'm', 'Front balcony depth (0 none).'),
  n('balconyFloor', 'frontage', 1, 1, 59, 1, '', 'Storey the balcony is on (1 is the second).'),
  n('balconyWidth', 'frontage', 0.6, 0.2, 1, 0.01, '', 'Balcony width as a share of the front.'),
  c('chimney', 'trim', offOn, 'A chimney (pitched roofs).'),
  c('gutters', 'trim', onOff, 'Gutters and downspouts.'),
  c('cornerBoards', 'trim', offOn, 'Corner boards.'),
  c('casings', 'trim', offOn, 'Trim boards round windows and doors.'),
  c('bands', 'trim', offOn, 'A band at each upper floor line.'),
  c('cornice', 'trim', offOn, 'A cornice at the wall or false front top.'),
  c('brackets', 'trim', offOn, 'Knee braces under the eaves.'),
  c('detail', 'detail', ['mid', 'far', 'near'], 'How much small geometry.'),
  c(
    'interior',
    'detail',
    ['rooms', 'cells', 'none'],
    'Behind the windows: furnished rooms, one room cell per window, or nothing.',
  ),
  c('stairs', 'detail', onOff, 'Stairs between the storeys of furnished rooms.'),
  c('fixtures', 'detail', onOff, 'Kitchen, bathroom and toilet rooms with their fixtures.'),
  c('softFurnishings', 'detail', onOff, 'Tatami, rugs, curtains, bedding and cushions in homes.'),
  n('seed', 'detail', 1, 0, 1_000_000, 1, '', 'Seed for small differences.'),
];
const BUILDING_INDEX = settingIndex(BUILDING_SETTINGS);
const FLAGS = [
  'sideWindows',
  'storefront',
  'awning',
  'chimney',
  'gutters',
  'cornerBoards',
  'casings',
  'bands',
  'cornice',
  'brackets',
  'stairs',
  'fixtures',
  'softFurnishings',
];
/** Every building setting at its default, as a fresh object to edit. */
export function buildingSettingDefaults(): Record<string, BuildingSettingValue> {
  return settingDefaults(BUILDING_SETTINGS) as Record<string, BuildingSettingValue>;
}
/**
 * The building options the given setting values make, for `generateBuilding`. Only the names given are set, so the
 * style's defaults hold for the rest; `storeys` and `storeyHeight`, `windowWidth` and `windowHeight`, `doorWidth` and
 * `doorHeight` fill in each other from the style when only one is given.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function buildingOptionsFromSettings(values: BuildingSettingValues): BuildingRuleOptions {
  checkSettings(BUILDING_INDEX, values, 'building', 'the rows in @margoengine/procedural/building-settings');
  const out: Record<string, unknown> = {},
    v = values as Record<string, BuildingSettingValue>;
  for (const [name, value] of Object.entries(v)) {
    if (['storeys', 'storeyHeight', 'windowWidth', 'windowHeight', 'doorWidth', 'doorHeight'].includes(name)) continue;
    out[name] = FLAGS.includes(name) ? value === 'on' : value;
  }
  const set = BUILDING_STYLE_SETS[(v.style as BuildingStyle | undefined) ?? 'japan-2011-house'];
  return {
    ...out,
    ...pair(v, 'storeys', 'storeyHeight', [set.storeys.length, set.storeys[0]], (count, h) => ({
      storeys: Array(count).fill(h),
    })),
    ...pair(v, 'windowWidth', 'windowHeight', set.window, (w, h) => ({
      window: [w, h],
    })),
    ...pair(v, 'doorWidth', 'doorHeight', set.door, (w, h) => ({
      door: [w, h],
    })),
  } as BuildingRuleOptions;
}
// Two rows that make one option: the one not given comes from the style set.
function pair(
  v: Record<string, BuildingSettingValue>,
  a: string,
  b: string,
  style: readonly number[],
  make: (x: number, y: number) => Record<string, unknown>,
): Record<string, unknown> {
  if (!(a in v) && !(b in v)) return {};
  return make((a in v ? v[a] : style[0]) as number, (b in v ? v[b] : style[1]) as number);
}

/** Every harbour control, in panel order, named `<piece>.<option>`. All rebuild (live false). */
export const HARBOUR_SETTINGS: readonly BuildingSetting[] = [
  n('seaWall.crest', 'sea wall', 6, 1, 20, 0.1, 'm', 'Sea wall crest above sea level.'),
  n('seaWall.toe', 'sea wall', -1.5, -10, 19, 0.1, 'm', 'Foot of the seaward face.'),
  n('seaWall.land', 'sea wall', 2, -10, 19.5, 0.1, 'm', 'Ground height on the land side.'),
  n('seaWall.crown', 'sea wall', 1, 0.3, 10, 0.05, 'm', 'Crown width.'),
  n('seaWall.batter', 'sea wall', 0.5, 0, 3, 0.01, '', 'Seaward face batter, horizontal per vertical.'),
  c('seaWall.recurve', 'sea wall', onOff, 'A recurved wave return.'),
  n('seaWall.stairs', 'sea wall', 50, 0, 2000, 1, 'm', 'Stair spacing on the land side (0 none).'),
  n('seaWall.toeTetrapods', 'sea wall', 0, 0, 100, 0.5, 't', 'Mass of the toe tetrapods (0 none).'),
  n('tetrapod.mass', 'tetrapods', 10, 0.5, 100, 0.5, 't', 'Tetrapod mass (sets the size).'),
  n('tetrapod.slope', 'tetrapods', 1.5, 0, 4, 0.05, 'cot', 'Armour slope, run over rise.'),
  n('tetrapod.layers', 'tetrapods', 2, 1, 3, 1, '', 'Armour layers.'),
  c(
    'tetrapod.placement',
    'tetrapods',
    ['settled', 'pattern'],
    'Settled: each unit lowered until it rests, none overlapping; pattern: on layer lines.',
  ),
  n('quay.crest', 'quay', 2, 0.5, 6, 0.05, 'm', 'Quay crown above sea level.'),
  n('quay.bottom', 'quay', -4, -30, -0.5, 0.1, 'm', 'Sea bed at the quay face.'),
  n('quay.bollards', 'quay', 15, 0, 50, 0.5, 'm', 'Bollard spacing (0 none).'),
  n('quay.fenders', 'quay', 6, 0, 30, 0.5, 'm', 'Fender spacing (0 none).'),
  n('breakwater.crest', 'breakwater', 4, 0.5, 20, 0.1, 'm', 'Breakwater crest above sea level.'),
  n('breakwater.bottom', 'breakwater', -8, -40, -1, 0.1, 'm', 'Sea bed under the breakwater.'),
  n('breakwater.slope', 'breakwater', 1.5, 1.25, 4, 0.05, 'cot', 'Seaward slope, run over rise.'),
  n('breakwater.armour', 'breakwater', 16, 0.5, 100, 0.5, 't', 'Armour tetrapod mass.'),
  n('breakwater.crownWall', 'breakwater', 1.5, 0, 5, 0.05, 'm', 'Crown wall height (0 none).'),
  n('slipway.gradient', 'slipway', 8, 4, 20, 0.1, '', 'Slipway gradient, run over rise.'),
  n('boat.length', 'fishing boat', 14.5, 5, 40, 0.1, 'm', 'Fishing boat length overall.'),
  n('boat.beamRatio', 'fishing boat', 0.245, 0.2, 0.33, 0.005, '', 'Beam over length.'),
  n(
    'boat.wheelhouse',
    'fishing boat',
    0.42,
    0.15,
    0.7,
    0.01,
    '',
    'Wheelhouse position from the stern, as a share of the length.',
  ),
  c('boat.mast', 'fishing boat', onOff, 'A mast.'),
  c('boat.lamps', 'fishing boat', offOn, 'A row of fishing lamps.'),
];
const HARBOUR_INDEX = settingIndex(HARBOUR_SETTINGS);
/** Every harbour setting at its default. */
export function harbourSettingDefaults(): Record<string, BuildingSettingValue> {
  return settingDefaults(HARBOUR_SETTINGS) as Record<string, BuildingSettingValue>;
}
/** The options per harbour piece the given values make (only the names given are set). */
export function harbourOptionsFromSettings(values: BuildingSettingValues): {
  seaWall: SeaWallOptions;
  tetrapods: TetrapodArmourOptions;
  quay: QuayOptions;
  breakwater: BreakwaterOptions;
  slipway: SlipwayOptions;
  boat: FishingBoatOptions;
} {
  checkSettings(HARBOUR_INDEX, values, 'harbour', 'the rows in @margoengine/procedural/building-settings');
  const out = {
    seaWall: {},
    tetrapod: {},
    quay: {},
    breakwater: {},
    slipway: {},
    boat: {},
  } as Record<string, Record<string, unknown>>;
  for (const [name, value] of Object.entries(values)) {
    const [piece, key] = name.split('.');
    out[piece][key] = value === 'on' ? true : value === 'off' ? false : value;
  }
  return {
    seaWall: out.seaWall,
    tetrapods: out.tetrapod,
    quay: out.quay,
    breakwater: out.breakwater,
    slipway: out.slipway,
    boat: out.boat,
  };
}

/** Every plan control (procedural/building-plans), in panel order. All rebuild (live false). */
export const BUILDING_PLAN_SETTINGS: readonly BuildingSetting[] = [
  c('plan', 'plan', ['L', 'rect', 'T', 'U', 'cross'], 'Plan of the whole: wings at the left end, middle or both ends.'),
  c('wingSide', 'plan', ['front', 'back'], 'Which side the wings stand out from.'),
  n('wingWidth', 'plan', 4.1, 3, 120, 0.1, 'm', 'Wing width (default the smaller of 0.75 depth and 0.45 width).'),
  n('wingLength', 'plan', 4.37, 1, 120, 0.1, 'm', 'How far each wing stands out past the main block.'),
  n('dormers', 'dormers', 0, 0, 12, 1, '', 'Dormers on each long slope of the main roof.'),
  c('dormerKind', 'dormers', ['gable', 'shed', 'hip'], 'Dormer roof.'),
  n('dormerWidth', 'dormers', 1.8, 1.2, 4, 0.05, 'm', 'Dormer outer width.'),
  c('dormerSides', 'dormers', ['front', 'both'], 'Dormers on the front slope only, or both long slopes.'),
  c('tower', 'tower', ['none', 'front-left', 'front-right', 'back-left', 'back-right'], 'A corner tower.'),
  n('towerSize', 'tower', 3.6, 2.5, 12, 0.05, 'm', 'Tower footprint side.'),
  n('towerStoreys', 'tower', 1, 0, 6, 1, '', 'Storeys the tower rises above the main block.'),
  n('towerPitch', 'tower', 50, 20, 70, 0.5, 'deg', 'Tower roof pitch (a pyramid on its square).'),
];
const PLAN_INDEX = settingIndex(BUILDING_PLAN_SETTINGS);
/** Every plan setting at its default. */
export function buildingPlanSettingDefaults(): Record<string, BuildingSettingValue> {
  return settingDefaults(BUILDING_PLAN_SETTINGS) as Record<string, BuildingSettingValue>;
}
/**
 * The options for `generateBuildingPlan` that building and plan rows make together: plan rows by their names, the
 * rest through {@link buildingOptionsFromSettings}. Only the names given are set.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function buildingPlanOptionsFromSettings(values: BuildingSettingValues): BuildingPlanOptions {
  const plan: Record<string, BuildingSettingValue> = {},
    rest: Record<string, BuildingSettingValue> = {};
  for (const [name, value] of Object.entries(values)) (PLAN_INDEX.has(name) ? plan : rest)[name] = value;
  checkSettings(PLAN_INDEX, plan, 'building plan', 'the rows in @margoengine/procedural/building-settings');
  return {
    ...buildingOptionsFromSettings(rest),
    ...plan,
  } as BuildingPlanOptions;
}

/** Every city control, in panel order. All rebuild (live false). */
export const CITY_SETTINGS: readonly BuildingSetting[] = [
  c('layout', 'streets', ['grid', 'organic', 'radial'], 'The street pattern.'),
  n('width', 'streets', 400, 60, 4000, 10, 'm', 'Town size along x.'),
  n('depth', 'streets', 400, 60, 4000, 10, 'm', 'Town size along z.'),
  n('blockWidth', 'streets', 90, 30, 500, 1, 'm', 'Target block length.'),
  n('blockDepth', 'streets', 60, 30, 500, 1, 'm', 'Target block depth.'),
  n('angle', 'streets', 0, -6.28, 6.28, 0.01, 'rad', 'Turn of the grid or of the first spoke.'),
  n('irregularity', 'streets', 0.25, 0, 1, 0.01, '', 'How uneven the streets and lots are.'),
  n('streetWidth', 'streets', 8, 4, 30, 0.5, 'm', 'Street width, kerb to kerb.'),
  n('avenueWidth', 'streets', 16, 4, 60, 0.5, 'm', 'Avenue width (at least the street width).'),
  n('avenueEvery', 'streets', 4, 0, 100, 1, '', 'Every this many streets is an avenue (0 none).'),
  n('spokes', 'streets', 8, 3, 24, 1, '', 'Spoke streets of the radial layout.'),
  n('sidewalk', 'streets', 2.5, 0, 8, 0.1, 'm', 'Pavement width.'),
  n('curb', 'streets', 0.15, 0, 0.5, 0.01, 'm', 'Pavement height over the road.'),
  n('lotFrontage', 'lots', 18, 6, 200, 1, 'm', 'Target lot width on the street.'),
  n('lotDepth', 'lots', 26, 8, 120, 1, 'm', 'Target lot depth.'),
  c('era', 'town', ['modern', 'western-1910'], 'The building styles.'),
  n('downtownRadius', 'town', 88, 0, 4000, 1, 'm', 'Downtown radius (0 none).'),
  n('minStoreys', 'town', 2, 1, 60, 1, '', 'Fewest storeys downtown.'),
  n('maxStoreys', 'town', 24, 1, 60, 1, '', 'Most storeys downtown (at least the fewest).'),
  n('parks', 'town', 0.08, 0, 1, 0.01, '', 'Share of blocks that are parks.'),
  n('industry', 'town', 0.15, 0, 1, 0.01, '', 'Share of the outer ring that is industry.'),
  n('seed', 'town', 1, 1, 9999, 1, '', 'The town drawn from these rules.'),
  n('treeSpacing', 'street furniture', 11, 0, 100, 1, 'm', 'Space between street trees (0 none).'),
  n('lampSpacing', 'street furniture', 30, 0, 200, 1, 'm', 'Space between street lamps (0 none).'),
];
const CITY_INDEX = settingIndex(CITY_SETTINGS);
/** Every city setting at its default. */
export function citySettingDefaults(): Record<string, BuildingSettingValue> {
  return settingDefaults(CITY_SETTINGS) as Record<string, BuildingSettingValue>;
}
/**
 * The options for `generateCity` that the given setting values make. Only the names given are set, so the era's own
 * defaults (such as the most storeys) hold for the rest.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function cityOptionsFromSettings(values: BuildingSettingValues): CityOptions {
  checkSettings(CITY_INDEX, values, 'city', 'the rows in @margoengine/procedural/building-settings');
  return { ...values } as CityOptions;
}
