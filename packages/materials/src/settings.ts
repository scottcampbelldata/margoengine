// The look controls of the skin and eye features as one machine-readable table, for sliders, panels and tools (the model
// is @margoengine/sky/settings and the row shape is shared/settings.js). Skin's rows are what the skin is made of (Donner
// and Jensen 2006) and the depth light passes through; they are `live: false`, as a new profile is fitted and its table
// built, so `skinFromSettings` makes a new feature. The eye's pupil, iris colour and tear film are read into its uniform
// each frame, so `applyEyeSettings` writes them on a live feature; its shape rows are fixed at construction
// (`eyeFromSettings`). Interior mapping's looks are all uniforms, so every interior row is live
// (`interiorOptionsFromSettings`, `applyInteriorSettings`). Not rows: room colours' textures and the room grid, `unitsPerMeter` (the model's units, not a look) and the iris map (a texture).
import {
  checkSettings,
  colorSetting,
  liveSettings,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import { eye, type EyeFeature, type EyeOptions } from './eye.js';
import { skin, type SkinOptions } from './skin.js';
import type { InteriorMappingOptions } from './interior-mapping.js';
import type { WgslMaterial } from './wgsl-material.js';
import type { MaterialFeature } from './built-material.js';

/** A colour value: three numbers, linear RGB. */
export type MaterialSettingColor = readonly [number, number, number];
/** One value of a setting: a number, a colour, or null (skin's physiology rows: the published profile). */
export type MaterialSettingValue = number | MaterialSettingColor | null;
/** Values by setting name; a name left out takes its default. */
export type MaterialSettingValues = Readonly<Record<string, MaterialSettingValue>>;
/** The panel a setting sits in. */
export type MaterialSettingGroup = 'skin' | 'eye' | 'interior';
/** One control: the shared row shape with the material groups. */
export interface MaterialSetting extends SettingRow {
  readonly group: MaterialSettingGroup;
  readonly default: MaterialSettingValue;
}
const number = (...args: Parameters<typeof numberSetting>): MaterialSetting =>
  numberSetting(...args) as MaterialSetting;
const color = (...args: Parameters<typeof colorSetting>): MaterialSetting => colorSetting(...args) as MaterialSetting;
const physiology = (name: string, low: number, high: number, step: number, about: string): MaterialSetting =>
  ({
    ...numberSetting(`skin.${name}`, 'skin', low, low, high, step, 'fraction', about, false),
    default: null,
    nullable: true,
  }) as MaterialSetting;
const REBUILDS = ' A new value builds a new skin() feature (a profile fitted in about 10 ms and its table).';
/** Every skin and eye control. */
export const MATERIAL_SETTINGS: readonly MaterialSetting[] = [
  physiology(
    'melanin',
    0,
    0.5,
    0.001,
    `Volume fraction of melanin in the epidermis (0.002 very fair, about 0.3 dark); null keeps the published profile.${REBUILDS}`,
  ),
  physiology(
    'melaninBlend',
    0,
    1,
    0.01,
    `Share of the melanin that is eumelanin (brown-black), the rest pheomelanin.${REBUILDS}`,
  ),
  physiology('hemoglobin', 0.001, 0.2, 0.001, `Volume fraction of blood in the dermis.${REBUILDS}`),
  physiology('oxygenation', 0, 1, 0.01, `Share of the hemoglobin carrying oxygen.${REBUILDS}`),
  number(
    'skin.thickness',
    'skin',
    0.004,
    0.0005,
    0.02,
    0.0005,
    'scene units',
    `With subsurface: the depth of skin that subsurfaceThickness 1 stands for.${REBUILDS}`,
    false,
  ) as MaterialSetting,
  number('eye.pupil', 'eye', 0.3, 0.05, 0.95, 0.01, 'share of iris radius', 'Pupil radius.') as MaterialSetting,
  color('eye.irisColor', 'eye', [0.16, 0.3, 0.42], 0, 1, 'Linear colour of the iris.') as MaterialSetting,
  number(
    'eye.wetness',
    'eye',
    1,
    0,
    1,
    0.01,
    '',
    "How much of the tear film's reflection shows: 1 a healthy wet eye, 0 a dry one.",
  ) as MaterialSetting,
  number(
    'eye.corneaRadius',
    'eye',
    0.65,
    0.4,
    1,
    0.01,
    'share of eyeball radius',
    "Radius of the cornea's front (7.8 mm of 12 by default). Fixed at construction.",
    false,
  ) as MaterialSetting,
  number(
    'eye.depth',
    'eye',
    0.3,
    0.05,
    0.6,
    0.01,
    'share of eyeball radius',
    'How far the iris sits behind the front (3.6 mm of 12). Fixed at construction.',
    false,
  ) as MaterialSetting,
  number(
    'eye.irisRadius',
    'eye',
    0.49,
    0.3,
    0.6,
    0.01,
    'share of eyeball radius',
    'Iris radius. Fixed at construction.',
    false,
  ) as MaterialSetting,
  number('interior.daylight', 'interior', 0.35, 0, 4, 0.01, '', 'Radiance of rooms from daylight.') as MaterialSetting,
  number('interior.lit', 'interior', 0.15, 0, 1, 0.01, 'share', 'Rooms with a lamp on.') as MaterialSetting,
  number('interior.lamp', 'interior', 1.4, 0, 10, 0.05, '', 'Radiance of a lamp.') as MaterialSetting,
  color('interior.lampColor', 'interior', [1, 0.78, 0.52], 0, 1, 'Linear colour of the lamps.') as MaterialSetting,
  number('interior.variation', 'interior', 0.5, 0, 1, 0.01, '', 'How far rooms differ.') as MaterialSetting,
  number('interior.furniture', 'interior', 0.7, 0, 1, 0.01, 'share', 'Furnished rooms.') as MaterialSetting,
  number('interior.curtains', 'interior', 0.35, 0, 1, 0.01, 'share', 'Windows with curtains.') as MaterialSetting,
  number('interior.blinds', 'interior', 0.2, 0, 1, 0.01, 'share', 'Windows with a blind.') as MaterialSetting,
];
/** The rows that may change every frame without a rebuild. */
export const MATERIAL_LIVE_SETTINGS: readonly MaterialSetting[] = liveSettings(MATERIAL_SETTINGS) as MaterialSetting[];
const BY_NAME = settingIndex(MATERIAL_SETTINGS);
/** A fresh object holding every row at its default. */
export function materialSettingDefaults(): Record<string, MaterialSettingValue> {
  return settingDefaults(MATERIAL_SETTINGS) as Record<string, MaterialSettingValue>;
}
const pick = (values: MaterialSettingValues, group: MaterialSettingGroup, only?: (row: SettingRow) => boolean) => {
  checkSettings(BY_NAME, values, 'material settings', '@margoengine/materials/settings');
  const out: Record<string, unknown> = {};
  for (const row of MATERIAL_SETTINGS) {
    if (row.group !== group || (only && !only(row))) continue;
    const v = row.name in values ? values[row.name] : row.default;
    if (v !== null) out[row.name.slice(group.length + 1)] = Array.isArray(v) ? [...v] : v;
  }
  return out;
};
/** A `skin()` feature from the skin rows (`unitsPerMeter` comes from `base`). */
export function skinFromSettings(values: MaterialSettingValues = {}, base: SkinOptions = {}): MaterialFeature {
  return skin({ ...base, ...(pick(values, 'skin') as SkinOptions) });
}
/** An `eye()` feature from the eye rows (the iris map, axis and centre come from `base`). */
export function eyeFromSettings(values: MaterialSettingValues = {}, base: EyeOptions = {}): EyeFeature {
  return eye({ ...base, ...(pick(values, 'eye') as EyeOptions) });
}
/**
 * `interiorMapping()` options from the interior rows (the room grid, colours and map come from `base`):
 * `interiorMapping(interiorOptionsFromSettings(values, grid))`.
 */
export function interiorOptionsFromSettings(
  values: MaterialSettingValues = {},
  base: InteriorMappingOptions = {},
): InteriorMappingOptions {
  return { ...base, ...(pick(values, 'interior') as InteriorMappingOptions) };
}
/** Writes the interior rows on an `interiorMapping()` material; a row left out takes its default. */
export function applyInteriorSettings(material: WgslMaterial, values: MaterialSettingValues = {}): void {
  Object.assign(material.uniforms, pick(values, 'interior'));
}
/** Writes the live eye rows (pupil, iris colour, wetness) on an eye feature; the next frame draws them. */
export function applyEyeSettings(feature: EyeFeature, values: MaterialSettingValues = {}): void {
  for (const key of Object.keys(values)) {
    const row = BY_NAME.get(key);
    if (row && row.group === 'eye' && !row.live)
      throw new RangeError(`${key} is fixed at construction; build a new feature with eyeFromSettings`);
  }
  const live = pick(values, 'eye', (row) => row.live);
  feature.pupil = live.pupil as number;
  feature.irisColor = live.irisColor as [number, number, number];
  feature.wetness = live.wetness as number;
}
