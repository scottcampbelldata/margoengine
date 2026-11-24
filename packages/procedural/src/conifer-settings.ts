// Every option of the northern Rockies conifers (`@margoengine/procedural/conifers`) as slider rows on the shared shape
// (packages/shared/settings.js; the model is @margoengine/sky/settings). None is live: each one rebuilds the mesh, so a
// panel calls `generateConiferMesh` or `coniferLevels` again when one moves. The row defaults are the generator's.
import { checkSettings, choiceSetting, numberSetting, settingDefaults, settingIndex, type SettingRow } from '../../shared/settings.js';
import { CONIFER_SPECIES_IDS, type ConiferSpecies } from './conifer-species.js';
import type { ConiferCondition, ConiferLevelsOptions } from './conifers.js';

/** One value of a setting. */
export type ConiferSettingValue = number | string;
/** Values by setting name; a name left out keeps the generator's default. */
export type ConiferSettingValues = Readonly<Record<string, ConiferSettingValue>>;
/** One control: the shared row shape. */
export interface ConiferSetting extends SettingRow {
  readonly default: ConiferSettingValue;
}

/** Every conifer control, in panel order. All rebuild (live false). */
export const CONIFER_SETTINGS: readonly ConiferSetting[] = [
  choiceSetting('species', 'tree', ['douglas-fir', ...CONIFER_SPECIES_IDS.filter((id) => id !== 'douglas-fir')], 'The species: its growth, crown, branching, bark and needles.', false) as ConiferSetting,
  numberSetting('age', 'tree', 100, 1, 600, 1, 'years', 'Age; sets height, diameter, crown ratio, width and whorls.', false) as ConiferSetting,
  numberSetting('basalArea', 'tree', 34.4, 1, 120, 0.1, 'm2/ha', 'Stand basal area: crowns narrow in a crowded stand.', false) as ConiferSetting,
  choiceSetting('condition', 'tree', ['live', 'snag', 'burnt'], 'Live, a dead snag with a broken top, or fire-killed and charred.', false) as ConiferSetting,
  numberSetting('seed', 'tree', 1, 0, 4294967295, 1, '', 'Branch phase and jitter, and where a snag breaks.', false) as ConiferSetting,
  choiceSetting('imposterSize', 'levels', ['256', '64', '128', '512', '1024'], 'Side of the far imposter image, pixels.', false) as ConiferSetting,
];
const INDEX = settingIndex(CONIFER_SETTINGS);

/** Every conifer setting at its default, as a fresh object to edit. */
export function coniferSettingDefaults(): Record<string, ConiferSettingValue> {
  return settingDefaults(CONIFER_SETTINGS) as Record<string, ConiferSettingValue>;
}

/**
 * The species and the `coniferLevels` (or `generateConiferMesh`) options the given values make. Only the names given
 * are set; the species defaults to Douglas-fir.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function coniferOptionsFromSettings(values: ConiferSettingValues): { species: ConiferSpecies; options: ConiferLevelsOptions } {
  checkSettings(INDEX, values, 'conifer', 'the rows in @margoengine/procedural/conifer-settings');
  const v = values as Record<string, ConiferSettingValue>,
    options: { -readonly [K in keyof ConiferLevelsOptions]: ConiferLevelsOptions[K] } = {};
  if ('age' in v) options.age = v.age as number;
  if ('basalArea' in v) options.basalArea = v.basalArea as number;
  if ('condition' in v) options.condition = v.condition as ConiferCondition;
  if ('seed' in v) options.seed = v.seed as number;
  if ('imposterSize' in v) options.imposterSize = Number(v.imposterSize);
  return { species: (v.species as ConiferSpecies | undefined) ?? 'douglas-fir', options };
}
