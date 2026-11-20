// The look controls of a GrassField as one machine-readable table, for sliders, panels and tools (the model is
// @margoengine/sky/settings and the row shape is shared/settings.js): blade height, reach, density, the wind, the blade
// colours and the back-light. GrassField keeps each of these in its frame uniform and rewrites it every frame, so every
// row is live. Not rows: blade count, area and spores (they size GPU buffers at construction).
import {
  checkSettings,
  colorSetting,
  liveSettings,
  numberSetting,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';

/** A colour value: three numbers, linear RGB. */
export type GrassSettingColor = readonly [number, number, number];
/** One value of a setting: a number or a colour. */
export type GrassSettingValue = number | GrassSettingColor;
/** Values by setting name; a name left out takes its default. */
export type GrassSettingValues = Readonly<Record<string, GrassSettingValue>>;
/** The panel a setting sits in. */
export type GrassSettingGroup = 'field' | 'wind' | 'color' | 'translucency';
/** One control: the shared row shape with the grass groups. */
export interface GrassSetting extends SettingRow {
  readonly group: GrassSettingGroup;
  readonly default: GrassSettingValue;
}
/** A `GrassField`: the setters the rows write. */
export interface GrassSettingTarget {
  bladeHeight: number;
  drawDistance: number;
  density: number;
  windSpeed: number;
  windStrength: number;
  windDirection: readonly [number, number];
  rootColor: GrassSettingColor;
  tipColor: GrassSettingColor;
  tipVariantColor: GrassSettingColor;
  translucencyColor: GrassSettingColor;
  translucency: number;
}
const n = (
  name: string,
  group: GrassSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
) => numberSetting(name, group, value, min, max, step, unit, about) as GrassSetting;
const c = (name: string, group: GrassSettingGroup, value: GrassSettingColor, about: string) =>
  colorSetting(name, group, value, 0, 1, about) as GrassSetting;

/** Every grass look control, in panel order. Defaults are the values a GrassField uses without the option. */
export const GRASS_SETTINGS: readonly GrassSetting[] = [
  n('field.bladeHeight', 'field', 1.2, 0.01, 10, 0.01, 'm', 'Blade height in metres; each blade varies 0.7 to 1.25 times this.'),
  n('field.drawDistance', 'field', 100, 1, 1000, 1, 'm', 'Distance beyond which blades are culled; the far third of it draws a quarter of the blades.'),
  n('field.density', 'field', 1, 0, 1, 0.01, '', 'Fraction of the blades drawn. The kept ones are the same blades each time (a hash of the blade number), so lowering it only thins the field.'),
  n('wind.speed', 'wind', 1.2, 0, 100, 0.1, '', 'Speed of the gust noise scrolling over the field and of the spores.'),
  n('wind.strength', 'wind', 0.45, 0, 2, 0.01, '', 'How far the blades bend.'),
  n('wind.directionX', 'wind', 1, -1, 1, 0.01, '', 'X of the wind direction (normalised with directionZ; both 0 is refused).'),
  n('wind.directionZ', 'wind', 0.35, -1, 1, 0.01, '', 'Z of the wind direction.'),
  c('color.root', 'color', [0.025, 0.065, 0.012], 'Blade colour at the root, linear RGB.'),
  c('color.tip', 'color', [0.25, 0.46, 0.045], 'Blade colour at the tip, linear RGB.'),
  c('color.tipVariant', 'color', [0.38, 0.57, 0.085], 'Tip colour of the most varied blades: each blade mixes the tip toward this by its own number.'),
  c('translucency.color', 'translucency', [0.34, 0.5, 0.09], 'Colour of sunlight seen through the blades, linear RGB.'),
  n('translucency.strength', 'translucency', 0.4, 0, 4, 0.01, '', 'Strength of the glow of blades against a low sun; 0 is none.'),
];
/** The rows that can change every frame without a rebuild: all of them. */
export const GRASS_LIVE_SETTINGS: readonly GrassSetting[] = liveSettings(GRASS_SETTINGS) as GrassSetting[];
const BY_NAME = settingIndex(GRASS_SETTINGS) as Map<string, GrassSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function grassSettingDefaults(): Record<string, GrassSettingValue> {
  return settingDefaults(GRASS_SETTINGS) as Record<string, GrassSettingValue>;
}
/** Named looks, each only values of {@link GRASS_SETTINGS}. */
export const GRASS_LOOKS = {
  /** Today's defaults. */
  natural: {},
  /** Dry summer grass, short and thin, with a hot back-light. */
  dry: {
    'field.bladeHeight': 0.7,
    'field.density': 0.7,
    'color.root': [0.08, 0.06, 0.02],
    'color.tip': [0.5, 0.4, 0.12],
    'color.tipVariant': [0.62, 0.5, 0.18],
    'translucency.color': [0.6, 0.45, 0.12],
  },
  /** Tall green meadow grass in a gale. */
  windy: { 'field.bladeHeight': 1.8, 'wind.speed': 3, 'wind.strength': 1.2 },
} as const satisfies Record<string, GrassSettingValues>;
/** The name of a look in {@link GRASS_LOOKS}. */
export type GrassLookName = keyof typeof GRASS_LOOKS;

/**
 * Writes `values` onto the GrassField (a name left out takes its default), read from the next frame.
 * @throws TypeError for a name not in {@link GRASS_SETTINGS}; RangeError for a value outside its row's range, or a wind
 * direction of 0 and 0.
 * @example applyGrassSettings(grass, GRASS_LOOKS.dry);
 */
export function applyGrassSettings(grass: GrassSettingTarget, values: GrassSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'grass', 'GRASS_SETTINGS in @margoengine/creative/grass-settings');
  const v = (name: string) => (name in values ? values[name] : BY_NAME.get(name)!.default);
  const x = v('wind.directionX') as number,
    z = v('wind.directionZ') as number;
  if (!Math.hypot(x, z)) throw new RangeError('Invalid grass setting wind.directionX; use a direction other than 0 and 0');
  grass.bladeHeight = v('field.bladeHeight') as number;
  grass.drawDistance = v('field.drawDistance') as number;
  grass.density = v('field.density') as number;
  grass.windSpeed = v('wind.speed') as number;
  grass.windStrength = v('wind.strength') as number;
  grass.windDirection = [x, z];
  grass.rootColor = v('color.root') as GrassSettingColor;
  grass.tipColor = v('color.tip') as GrassSettingColor;
  grass.tipVariantColor = v('color.tipVariant') as GrassSettingColor;
  grass.translucencyColor = v('translucency.color') as GrassSettingColor;
  grass.translucency = v('translucency.strength') as number;
}
