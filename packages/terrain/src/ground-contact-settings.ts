// Every live look control of TerrainGroundContact (`@margoengine/terrain/ground-contact`) as one machine-readable table
// on the shared row shape (packages/shared/settings.js; the model is @margoengine/sky/settings). Every row is live: the
// look is one small uniform, so `applyGroundContactSettings` can key any of them over a shot without rebuilding
// anything. Not rows: `texel`, `resolution` and `binding` (fixed at attach) and the footprints (scene data). How grass
// opens around the same feet is the `clearing.*` rows of @margoengine/scatter/settings.
import {
  checkSettings,
  colorSetting,
  liveSettings,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import type { GroundContactLook, TerrainGroundContact } from './ground-contact.js';

/** A colour value: linear RGB. */
export type GroundContactSettingColor = readonly [number, number, number];
/** One value of a setting: a number or a colour. */
export type GroundContactSettingValue = number | GroundContactSettingColor;
/** Values by setting name; a name left out keeps the effect's current value. */
export type GroundContactSettingValues = Readonly<Record<string, GroundContactSettingValue>>;
/** The panel a setting sits in. */
export type GroundContactSettingGroup = 'contact';
/** One control: the shared row shape with the ground contact's group. */
export interface GroundContactSetting extends SettingRow {
  readonly group: GroundContactSettingGroup;
  readonly default: GroundContactSettingValue;
}
const n = (name: string, about: string): GroundContactSetting =>
  numberSetting(name, 'contact', 1, 0, 1, 0.01, '', about) as GroundContactSetting;

/** Every ground contact look control, in panel order. Defaults are the values the effect uses without the option. */
export const GROUND_CONTACT_SETTINGS: readonly GroundContactSetting[] = [
  colorSetting(
    'contact.color',
    'contact',
    [0.1, 0.08, 0.055],
    0,
    1,
    'Linear RGB albedo of the soil and litter at the feet of trunks and stones.',
  ) as GroundContactSetting,
  n('contact.soil', 'How far the ground turns to the soil colour where the soil weight is full (0 leaves it).'),
  n('contact.occlusion', 'How much of the sky light lost at a foot is taken (0 takes none).'),
];
/** The rows that can change every frame (all of them). */
export const GROUND_CONTACT_LIVE_SETTINGS: readonly GroundContactSetting[] = liveSettings(
  GROUND_CONTACT_SETTINGS,
) as GroundContactSetting[];
const BY_NAME = settingIndex(GROUND_CONTACT_SETTINGS) as Map<string, GroundContactSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function groundContactSettingDefaults(): Record<string, GroundContactSettingValue> {
  return settingDefaults(GROUND_CONTACT_SETTINGS) as Record<string, GroundContactSettingValue>;
}
/**
 * Sets the given rows on `contact` (names left out keep their current value). Nothing is rebuilt.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 * @example applyGroundContactSettings(view.groundContact, { 'contact.soil': 0.6 });
 */
export function applyGroundContactSettings(
  contact: TerrainGroundContact,
  values: GroundContactSettingValues = {},
): void {
  checkSettings(BY_NAME, values, 'ground contact', 'the rows in @margoengine/terrain/ground-contact-settings');
  const look: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(values)) look[name.slice(8)] = v;
  contact.setLook(look as GroundContactLook);
}
