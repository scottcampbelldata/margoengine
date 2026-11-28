// Every option of the temperate broadleaves (`@margoengine/procedural/broadleaves`) as slider rows on the shared shape
// (packages/shared/settings.js; the model is @margoengine/sky/settings). None is live: each one rebuilds the mesh, so a
// panel calls `generateBroadleafMesh` or `broadleafLevels` again when one moves. The row defaults are the generator's.
import {
  checkSettings,
  choiceSetting,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import { BROADLEAF_SPECIES_IDS, type BroadleafSpecies } from './broadleaf-species.js';
import type { BroadleafCondition, BroadleafLevelsOptions } from './broadleaves.js';

/** One value of a setting. */
export type BroadleafSettingValue = number | string;
/** Values by setting name; a name left out keeps the generator's default. */
export type BroadleafSettingValues = Readonly<Record<string, BroadleafSettingValue>>;
/** One control: the shared row shape. */
export interface BroadleafSetting extends SettingRow {
  readonly default: BroadleafSettingValue;
}

/** Every broadleaf control, in panel order. All rebuild (live false). */
export const BROADLEAF_SETTINGS: readonly BroadleafSetting[] = [
  choiceSetting(
    'species',
    'tree',
    ['english-oak', ...BROADLEAF_SPECIES_IDS.filter((id) => id !== 'english-oak')],
    'The species: its growth, crown, branching, bark and leaves.',
    false,
  ) as BroadleafSetting,
  numberSetting(
    'age',
    'tree',
    120,
    1,
    600,
    1,
    'years',
    'Age; sets height, diameter, crown and width.',
    false,
  ) as BroadleafSetting,
  numberSetting(
    'open',
    'tree',
    0.8,
    0,
    1,
    0.01,
    '',
    'Forest grown (0: high bole, slender) to open grown (1: low limbs, stout).',
    false,
  ) as BroadleafSetting,
  choiceSetting('condition', 'tree', ['live', 'bare'], 'Leafed, or leafless wood.', false) as BroadleafSetting,
  numberSetting(
    'seed',
    'tree',
    1,
    0,
    4294967295,
    1,
    '',
    'Limb directions, foliage masses, twigs and cards.',
    false,
  ) as BroadleafSetting,
  choiceSetting(
    'imposterSize',
    'levels',
    ['512', '128', '256', '1024'],
    'Side of the leaf atlas and far imposter image, pixels.',
    false,
  ) as BroadleafSetting,
];
const INDEX = settingIndex(BROADLEAF_SETTINGS);

/** Every broadleaf setting at its default, as a fresh object to edit. */
export function broadleafSettingDefaults(): Record<string, BroadleafSettingValue> {
  return settingDefaults(BROADLEAF_SETTINGS) as Record<string, BroadleafSettingValue>;
}

/**
 * The species and the `broadleafLevels` (or `generateBroadleafMesh`) options the given values make. Only the names
 * given are set; the species defaults to English oak.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function broadleafOptionsFromSettings(values: BroadleafSettingValues): {
  species: BroadleafSpecies;
  options: BroadleafLevelsOptions;
} {
  checkSettings(INDEX, values, 'broadleaf', 'the rows in @margoengine/procedural/broadleaf-settings');
  const v = values as Record<string, BroadleafSettingValue>,
    options: { -readonly [K in keyof BroadleafLevelsOptions]: BroadleafLevelsOptions[K] } = {};
  if ('age' in v) options.age = v.age as number;
  if ('open' in v) options.open = v.open as number;
  if ('condition' in v) options.condition = v.condition as BroadleafCondition;
  if ('seed' in v) options.seed = v.seed as number;
  if ('imposterSize' in v) options.imposterSize = Number(v.imposterSize);
  return { species: (v.species as BroadleafSpecies | undefined) ?? 'english-oak', options };
}
