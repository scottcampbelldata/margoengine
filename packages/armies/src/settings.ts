// Every option of an army's drawing (`@margoengine/armies`) as slider rows on the shared shape (packages/shared/
// settings.js; the model is @margoengine/sky/settings). Rows marked live change a running army's next update (the
// budget and level switch points, the gait numbers, step, stature, facing, seed, how riders sit); the bake rows
// (fps, farTriangles) rebuild it. No row follows the weather. The formation itself has its own rows in
// `@margoengine/navmesh/formation-settings`.
import { checkSettings, choiceSetting, numberSetting, settingDefaults, settingIndex, type SettingRow } from '../../shared/settings.js';
import type { AddArmyOptions } from './index.js';
import type { PersonBakeOptions } from './bake.js';

/** One value of a setting. */
export type ArmySettingValue = number | string;
/** Values by setting name; a name left out keeps the default. */
export type ArmySettingValues = Readonly<Record<string, ArmySettingValue>>;
/** One control: the shared row shape. */
export interface ArmySetting extends SettingRow {
  readonly default: ArmySettingValue;
}

/** Every army control, in panel order. */
export const ARMY_SETTINGS: readonly ArmySetting[] = [
  numberSetting('near', 'budget', 128, 0, 65536, 1, '', 'Most members skinned near (full mesh, two clips blended).') as ArmySetting,
  numberSetting('far', 'budget', 16384, 0, 1048576, 1, '', 'Most members drawn far (simplified mesh, vertex animation).') as ArmySetting,
  numberSetting('vertices', 'budget', 8_000_000, 0, 100_000_000, 1000, '', 'Most vertices posed a frame, near and far together.') as ArmySetting,
  numberSetting('nearScreen', 'levels', 0.08, 0.001, 10, 0.001, '', 'A member at least this fraction of the view tall is skinned near.') as ArmySetting,
  numberSetting('cullScreen', 'levels', 0.002, 0, 0.5, 0.0005, '', 'A member smaller than this fraction of the view is not drawn.') as ArmySetting,
  numberSetting('hysteresis', 'levels', 0, 0, 0.9, 0.01, '', 'A near member stays near down to nearScreen times one less this; 0 seeks exactly.') as ArmySetting,
  numberSetting('walkStride', 'gait', 1.524, 0.2, 5, 0.001, 'm', 'Ground the walk clip covers in one cycle (two 30 inch steps).') as ArmySetting,
  numberSetting('runStride', 'gait', 1.829, 0.2, 6, 0.001, 'm', 'Ground the run clip covers in one cycle (two 36 inch steps).') as ArmySetting,
  numberSetting('runAbove', 'gait', 2, 0.5, 10, 0.05, 'm/s', 'Speed of the walk-run change.') as ArmySetting,
  numberSetting('blendBand', 'gait', 0.4, 0, 2, 0.05, 'm/s', 'Speed band the walk and run blend across.') as ArmySetting,
  numberSetting('standBelow', 'gait', 0.1, 0, 0.5, 0.01, 'm/s', 'Below this a man stands.') as ArmySetting,
  choiceSetting('step', 'gait', ['cadence', 'route'], 'Cadence: the men keep step. Route: each his own.') as ArmySetting,
  numberSetting('stature', 'people', 0.04, 0, 0.3, 0.005, '', 'Spread of heights, one standard deviation as a fraction of the mean.') as ArmySetting,
  numberSetting('facing', 'people', 0, -3.1416, 3.1416, 0.01, 'rad', 'The person model\'s facing about +Y from +Z.') as ArmySetting,
  numberSetting('seed', 'people', 1, 0, 1_000_000, 1, '', 'Seed of heights, outfits and route-step phases.') as ArmySetting,
  numberSetting('riderPitchShare', 'riders', 0.4, 0, 1, 0.01, '', 'Share of the horse trunk\'s pitch a rider takes.') as ArmySetting,
  numberSetting('riderHipHeight', 'riders', 0, 0, 2, 0.01, 'm', 'The rider model\'s hip above its feet; 0 for 0.53 of its height.') as ArmySetting,
  numberSetting('fps', 'bake', 30, 10, 120, 1, '1/s', 'Bake rows a second.', false) as ArmySetting,
  numberSetting('farTriangles', 'bake', 3000, 12, 1_000_000, 1, '', 'Triangles the far mesh keeps, at most.', false) as ArmySetting,
];
const INDEX = settingIndex(ARMY_SETTINGS);

/** Every army setting at its default, as a fresh object to edit. */
export function armySettingDefaults(): Record<string, ArmySettingValue> {
  return settingDefaults(ARMY_SETTINGS) as Record<string, ArmySettingValue>;
}

/**
 * The `addArmy` options (less the person) and the `bakePerson` options the given values make. Only the names given
 * are set.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function armyOptionsFromSettings(values: ArmySettingValues): { options: Omit<AddArmyOptions, 'person'>; bake: PersonBakeOptions } {
  checkSettings(INDEX, values, 'armies', 'the rows in @margoengine/armies/settings');
  const v = values as Record<string, ArmySettingValue>,
    o: Record<string, unknown> = {},
    bake: Record<string, unknown> = {},
    rider: Record<string, unknown> = {};
  for (const k of ['near', 'far', 'vertices', 'nearScreen', 'cullScreen', 'hysteresis', 'runAbove', 'blendBand', 'standBelow', 'stature', 'facing', 'seed'] as const)
    if (k in v) o[k] = v[k];
  if ('walkStride' in v || 'runStride' in v) o.strides = { ...('walkStride' in v ? { walk: v.walkStride } : {}), ...('runStride' in v ? { run: v.runStride } : {}) };
  if ('step' in v) o.step = v.step;
  if ('riderPitchShare' in v) rider.pitchShare = v.riderPitchShare;
  if ('riderHipHeight' in v && (v.riderHipHeight as number) > 0) rider.hipHeight = v.riderHipHeight;
  if (Object.keys(rider).length) o.rider = rider;
  if ('fps' in v) bake.fps = v.fps;
  if ('farTriangles' in v) bake.farTriangles = v.farTriangles;
  return { options: o as Omit<AddArmyOptions, 'person'>, bake: bake as PersonBakeOptions };
}
