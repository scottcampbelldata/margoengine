// Every option of a horse (`@margoengine/horses`) and of its rider seat as slider rows on the shared shape
// (packages/shared/settings.js; the model is @margoengine/sky/settings). Rows marked live change a running horse
// (speed, gait, acceleration, turn rate, fade); the rest rebuild it, so a panel calls `addHorse` again when one moves.
// The row defaults are the package's defaults.
import { checkSettings, choiceSetting, numberSetting, settingDefaults, settingIndex, type SettingRow } from '../../shared/settings.js';
import { HORSE_TYPES, type HorseType } from './anatomy.js';
import { HORSE_COATS, type HorseCoat } from './model.js';
import type { HorseOptions } from './index.js';
import type { Gait } from './gaits.js';
import type { MountOptions } from './seat.js';

/** One value of a setting. */
export type HorseSettingValue = number | string;
/** Values by setting name; a name left out keeps the default. */
export type HorseSettingValues = Readonly<Record<string, HorseSettingValue>>;
/** One control: the shared row shape. */
export interface HorseSetting extends SettingRow {
  readonly default: HorseSettingValue;
}

/** Every horse and seat control, in panel order. */
export const HORSE_SETTINGS: readonly HorseSetting[] = [
  choiceSetting('type', 'horse', [...HORSE_TYPES], 'Breed group: riding (Thoroughbred build), cavalry remount or heavy draft.', false) as HorseSetting,
  numberSetting('withers', 'horse', 0, 0, 2.1, 0.01, 'm', 'Height at the withers; 0 keeps the breed group mean.', false) as HorseSetting,
  numberSetting('condition', 'horse', 1, 0.8, 1.25, 0.01, '', 'Girth and widths: lean below 1, heavy above.', false) as HorseSetting,
  choiceSetting('coat', 'coat', [...HORSE_COATS], 'Coat colour; bay, brown and dun have black points, mane and tail.', false) as HorseSetting,
  choiceSetting('blaze', 'coat', ['no', 'yes'], 'A white blaze down the face.', false) as HorseSetting,
  numberSetting('socks', 'coat', 0, 0, 0.6, 0.01, 'm', 'Height of white socks on the hind legs.', false) as HorseSetting,
  numberSetting('maneLength', 'coat', 0, 0, 0.8, 0.01, 'm', 'Mane hair length; 0 keeps the default (a pulled mane).', false) as HorseSetting,
  numberSetting('tailLength', 'coat', 0, 0, 1.6, 0.01, 'm', 'Tail hair length from the dock; 0 keeps the default (to the hocks).', false) as HorseSetting,
  choiceSetting('detail', 'coat', ['2', '1', '0'], 'Mesh detail: 2 close-up, 1 middle, 0 far crowd.', false) as HorseSetting,
  numberSetting('speed', 'motion', 0, 0, 25, 0.1, 'm/s', 'Ground speed; the gait follows it by Froude number.') as HorseSetting,
  choiceSetting('gait', 'motion', ['auto', 'walk', 'trot', 'canter', 'gallop'], 'Force a gait, or auto to follow the speed.') as HorseSetting,
  numberSetting('acceleration', 'motion', 3, 0.1, 12, 0.1, 'm/s2', 'Most the speed changes per second.') as HorseSetting,
  numberSetting('turnRate', 'motion', 1.2, 0.1, 6, 0.05, 'rad/s', 'Most the heading turns per second.') as HorseSetting,
  numberSetting('fade', 'motion', 0.3, 0, 2, 0.01, 's', 'Cross-fade length of a gait change.') as HorseSetting,
  numberSetting('riderHeight', 'seat', 1.75, 1.4, 2.1, 0.01, 'm', 'Rider standing height: sets thigh and shank length.', false) as HorseSetting,
  numberSetting('thigh', 'seat', 0.7, 0.2, 1.2, 0.01, 'rad', 'Rider thigh angle forward of vertical.', false) as HorseSetting,
  numberSetting('knee', 'seat', 1.92, 1.4, 2.6, 0.01, 'rad', 'Rider knee angle: longer stirrups open it.', false) as HorseSetting,
  numberSetting('followFrequency', 'seat', 9, 1, 60, 0.5, 'Hz', 'How stiffly the rider hip rides the saddle.', false) as HorseSetting,
  numberSetting('followDamping', 'seat', 0.8, 0.2, 3, 0.05, '', 'Damping of the rider hip on the saddle.', false) as HorseSetting,
  numberSetting('pitchShare', 'seat', 0.4, 0, 1, 0.01, '', 'How much of the trunk pitch the rider takes.', false) as HorseSetting,
];
const INDEX = settingIndex(HORSE_SETTINGS);

/** Every horse setting at its default, as a fresh object to edit. */
export function horseSettingDefaults(): Record<string, HorseSettingValue> {
  return settingDefaults(HORSE_SETTINGS) as Record<string, HorseSettingValue>;
}

/**
 * The `addHorse` options, the live motion values and the `mountRider` options the given values make. Only the names
 * given are set.
 * @throws TypeError for an unknown name; RangeError for a value out of range.
 */
export function horseOptionsFromSettings(values: HorseSettingValues): {
  options: HorseOptions;
  motion: { speed?: number; gait?: Gait | 'auto' };
  mount: MountOptions;
} {
  checkSettings(INDEX, values, 'horses', 'the rows in @margoengine/horses/settings');
  const v = values as Record<string, HorseSettingValue>,
    o: Record<string, unknown> = {},
    mount: Record<string, unknown> = {},
    motion: { speed?: number; gait?: Gait | 'auto' } = {};
  if ('type' in v) o.type = v.type as HorseType;
  if ('withers' in v && (v.withers as number) > 0) {
    if ((v.withers as number) < 1.2) throw new RangeError('horses withers must be 0 (the group mean) or 1.2 to 2.1 m');
    o.withers = v.withers;
  }
  if ('condition' in v) o.condition = v.condition;
  if ('coat' in v) o.coat = v.coat as HorseCoat;
  if ('blaze' in v || 'socks' in v) {
    const sock = (v.socks as number | undefined) ?? 0;
    o.markings = { blaze: v.blaze === 'yes', socks: [sock, 0, sock, 0] };
  }
  if ('maneLength' in v && (v.maneLength as number) > 0) o.maneLength = Math.max(0.02, v.maneLength as number);
  if ('tailLength' in v && (v.tailLength as number) > 0) o.tailLength = Math.max(0.1, v.tailLength as number);
  if ('detail' in v) o.detail = Number(v.detail);
  for (const k of ['acceleration', 'turnRate', 'fade'] as const) if (k in v) o[k] = v[k];
  if ('speed' in v) motion.speed = v.speed as number;
  if ('gait' in v) motion.gait = v.gait as Gait | 'auto';
  if ('riderHeight' in v) mount.height = v.riderHeight;
  if ('thigh' in v) mount.thigh = v.thigh;
  if ('knee' in v) mount.knee = v.knee;
  if ('followFrequency' in v) mount.frequency = v.followFrequency;
  if ('followDamping' in v) mount.damping = v.followDamping;
  if ('pitchShare' in v) mount.pitchShare = v.pitchShare;
  return { options: o as HorseOptions, motion, mount: mount as MountOptions };
}
