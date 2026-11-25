// Every option of a formation (`@margoengine/navmesh/formations`) as slider rows on the shared shape
// (packages/shared/settings.js; the model is @margoengine/sky/settings). None is live: each one rebuilds the army, so a
// panel makes the Army again (and seeks it to the film time) when one moves. 0 keeps the kind's drill default. The
// charge rows give the options of `Formation.charge` (chargeOptionsFromSettings), an order kept on the film timeline.
import {
  checkSettings,
  choiceSetting,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import {
  FORMATION_SHAPES,
  SKIRMISH_GAP,
  type ChargeOptions,
  type FormationKind,
  type FormationOptions,
  type FormationShape,
} from './formations.js';

/** One value of a setting. */
export type FormationSettingValue = number | string;
/** Values by setting name; a name left out keeps the default. */
export type FormationSettingValues = Readonly<Record<string, FormationSettingValue>>;
/** One control: the shared row shape. */
export interface FormationSetting extends SettingRow {
  readonly default: FormationSettingValue;
}

/** Every formation control, in panel order. All rebuild (live false). */
export const FORMATION_SETTINGS: readonly FormationSetting[] = [
  choiceSetting(
    'kind',
    'formation',
    ['infantry', 'cavalry'],
    'Men on foot (discs) or horses (capsules that cannot step sideways).',
    false,
  ) as FormationSetting,
  choiceSetting(
    'shape',
    'formation',
    [...FORMATION_SHAPES],
    'Line, column, hollow square, wedge or skirmish line (extended order).',
    false,
  ) as FormationSetting,
  numberSetting('count', 'formation', 80, 1, 4096, 1, '', 'Members.', false) as FormationSetting,
  numberSetting(
    'files',
    'formation',
    0,
    0,
    4096,
    1,
    '',
    'Members a rank (a face of a square); 0 for the shape default.',
    false,
  ) as FormationSetting,
  numberSetting(
    'ranks',
    'formation',
    0,
    0,
    64,
    1,
    '',
    'Ranks deep; 0 for the shape default (2 a line, 4 a square).',
    false,
  ) as FormationSetting,
  numberSetting(
    'interval',
    'spacing',
    0,
    0,
    5,
    0.01,
    'm',
    'File spacing centre to centre; 0 for the drill default.',
    false,
  ) as FormationSetting,
  numberSetting(
    'distance',
    'spacing',
    0,
    0,
    10,
    0.01,
    'm',
    'Rank spacing centre to centre; 0 for the drill default.',
    false,
  ) as FormationSetting,
  numberSetting(
    'gap',
    'spacing',
    SKIRMISH_GAP,
    0,
    50,
    0.01,
    'm',
    'Open space between skirmishers on top of the file interval (two paces).',
    false,
  ) as FormationSetting,
  numberSetting(
    'speed',
    'march',
    0,
    0,
    25,
    0.01,
    'm/s',
    'Marching speed; 0 for quick time (cavalry: the walk).',
    false,
  ) as FormationSetting,
  numberSetting(
    'maxSpeed',
    'march',
    0,
    0,
    25,
    0.01,
    'm/s',
    'Catch-up speed; 0 for double time (cavalry: 7 m/s).',
    false,
  ) as FormationSetting,
  numberSetting(
    'turnRate',
    'march',
    0,
    0,
    10,
    0.05,
    'rad/s',
    'Fastest a member turns; 0 for the kind default.',
    false,
  ) as FormationSetting,
  numberSetting(
    'chargeSpeed',
    'charge',
    0,
    0,
    25,
    0.01,
    'm/s',
    'Speed a charge builds to; 0 for the catch-up speed (double time, mounted a gallop).',
    false,
  ) as FormationSetting,
  numberSetting(
    'chargeAcceleration',
    'charge',
    0,
    0,
    20,
    0.01,
    'm/s2',
    'How fast a charge builds; 0 for the kind default (1 on foot, 0.6 mounted).',
    false,
  ) as FormationSetting,
];
const INDEX = settingIndex(FORMATION_SETTINGS);

/** Every formation setting at its default, as a fresh object to edit. */
export function formationSettingDefaults(): Record<string, FormationSettingValue> {
  return settingDefaults(FORMATION_SETTINGS) as Record<string, FormationSettingValue>;
}

/**
 * The `Army.add` options the given values make. Only the names given are set; 0 leaves a drill default in place.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function formationOptionsFromSettings(values: FormationSettingValues): FormationOptions {
  checkSettings(INDEX, values, 'formation', 'the rows in @margoengine/navmesh/formation-settings');
  const v = values as Record<string, FormationSettingValue>,
    o: Record<string, unknown> = { count: (v.count as number | undefined) ?? 80 };
  if ('kind' in v) o.kind = v.kind as FormationKind;
  if ('shape' in v) o.shape = v.shape as FormationShape;
  for (const k of ['files', 'ranks', 'interval', 'distance', 'speed', 'maxSpeed', 'turnRate'] as const)
    if (k in v && (v[k] as number) > 0) o[k] = v[k];
  if ('gap' in v) o.gap = v.gap;
  return o as unknown as FormationOptions;
}

/**
 * The `Formation.charge` options the charge rows make; 0 leaves the kind's default in place.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function chargeOptionsFromSettings(values: FormationSettingValues): ChargeOptions {
  checkSettings(INDEX, values, 'formation', 'the rows in @margoengine/navmesh/formation-settings');
  const o: { speed?: number; acceleration?: number } = {};
  if ((values.chargeSpeed as number) > 0) o.speed = values.chargeSpeed as number;
  if ((values.chargeAcceleration as number) > 0) o.acceleration = values.chargeAcceleration as number;
  return o;
}
