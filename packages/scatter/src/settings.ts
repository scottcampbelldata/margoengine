// The look controls of a GPU Scatter as one machine-readable table, for sliders, panels and tools (the model is
// @margoengine/sky/settings and the row shape is shared/settings.js): how many candidates are kept, the diffuse colour,
// the rooted wind, the blade root shade and width, and the variation, clusters and translucency stages. Scatter reads the
// first rows from its frame uniform every frame (live). Translucency, variation and clusters are read from the material
// uniform every frame too, but turning one on from 0 (or off to 0) changes the lit shader, so Scatter picks another
// pipeline (built once on the next frame): those four rows are `live: false`. Not rows: everything placed at
// construction (count, area, lod, rules, paths, heightmap).
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
export type ScatterSettingColor = readonly [number, number, number];
/** One value of a setting: a number or a colour. */
export type ScatterSettingValue = number | ScatterSettingColor;
/** Values by setting name; a name left out takes its default. */
export type ScatterSettingValues = Readonly<Record<string, ScatterSettingValue>>;
/** The panel a setting sits in. */
export type ScatterSettingGroup = 'scatter' | 'wind' | 'blades' | 'variation';
/** One control: the shared row shape with the scatter groups. */
export interface ScatterSetting extends SettingRow {
  readonly group: ScatterSettingGroup;
  readonly default: ScatterSettingValue;
}
/** A `Scatter` (or a `ScatterTiles`): the setters the rows write. */
export interface ScatterSettingTarget {
  density: number;
  color: readonly [number, number, number];
  wind: readonly [number, number, number] | readonly [number, number, number, number] | undefined;
  sway: { readonly stiffness?: number; readonly height?: number } | undefined;
  /** Needs a Scatter built with `blades`. */
  rootShade: number;
  /** Need a Scatter built with `blades`. */
  widen: number;
  translucencyAmount: number;
  /** Need a Scatter built with a `material`. */
  variationHue: number;
  variationValue: number;
  clusters: number;
  readonly options: { readonly blades?: object; readonly material?: object };
}
const n = (
  name: string,
  group: ScatterSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
  live = true,
) => numberSetting(name, group, value, min, max, step, unit, about, live) as ScatterSetting;

/** Every scatter look control, in panel order. Defaults are the values a Scatter uses without the option. */
export const SCATTER_SETTINGS: readonly ScatterSetting[] = [
  n(
    'scatter.density',
    'scatter',
    1,
    0,
    1,
    0.01,
    '',
    'Fraction of the candidate instances kept. The kept ones are the same instances each time (a hash of the candidate), so lowering it only thins the field.',
  ),
  colorSetting(
    'scatter.color',
    'scatter',
    [0.12, 0.35, 0.08],
    0,
    1,
    'Diffuse colour in linear RGB, used when the Scatter has no PBR material.',
  ) as ScatterSetting,
  n(
    'wind.directionX',
    'wind',
    1,
    -1,
    1,
    0.01,
    '',
    'X of the wind direction (it is normalised with directionZ; both 0 is refused).',
  ),
  n('wind.directionZ', 'wind', 0, -1, 1, 0.01, '', 'Z of the wind direction.'),
  n(
    'wind.strength',
    'wind',
    0,
    0,
    1,
    0.01,
    '',
    'Rooted bend strength. 0 removes the wind (the cull reach is then not doubled), as a Scatter built with no wind.',
  ),
  n(
    'wind.speed',
    'wind',
    0,
    0,
    100,
    0.1,
    'm/s',
    'Mean wind at 10 m: from 5.4 m/s (the top of Beaufort 3) the sway and leaf flutter run speed / 5.4 times faster, so a gale (17.2 m/s, force 8) thrashes the plants 3.2 times as fast. 0 keeps their own sway.',
  ),
  n(
    'wind.stiffness',
    'wind',
    1,
    0.1,
    10,
    0.1,
    '',
    "How stiff the plants are: the most a tall plant's top moves at full strength is 1.2 m / stiffness. Short plants bend as before; a trunk keeps its own sway frequency whatever the stiffness.",
  ),
  n(
    'blades.rootShade',
    'blades',
    0.5,
    0,
    1,
    0.01,
    '',
    'Albedo lost at the blade root: blades darken from the tip (1) to the root (1 minus this). Needs a Scatter built with `blades`.',
  ),
  n(
    'blades.widen',
    'blades',
    1,
    0,
    10,
    0.05,
    '',
    'Extra blade width at the last LOD distance as a fraction (1 is twice as wide), growing with distance from the camera; the cull reach follows. Needs a Scatter built with `blades`.',
  ),
  n(
    'blades.translucency',
    'blades',
    0,
    0,
    1,
    0.01,
    '',
    'Sunlight seen through the blades (wrapped back-light, Barre-Brisebois and Bouchard 2011). Moving it off 0 or back to 0 builds another lit pipeline once; between nonzero values it is live. Needs a Scatter built with `blades`.',
    false,
  ),
  n(
    'variation.hue',
    'variation',
    0,
    0,
    0.5,
    0.005,
    'turn',
    'Hue turn of up to this either way, from a hash of each instance position. Moving it off 0 builds another lit pipeline once. Needs a Scatter built with a `material`.',
    false,
  ),
  n(
    'variation.value',
    'variation',
    0,
    0,
    1,
    0.01,
    '',
    'Brightness change of up to this either way per instance (and per cluster). Moving it off 0 builds another lit pipeline once. Needs a Scatter built with a `material`.',
    false,
  ),
  n(
    'variation.clusters',
    'variation',
    0,
    0,
    100000,
    0.1,
    'mesh units',
    'Leaf-cluster cell size: the mesh shades as clumps (0 is off). Turning it on from 0 builds another lit pipeline once. Needs a Scatter built with a `material`.',
    false,
  ),
];
/** The rows that can change every frame without building anything. */
export const SCATTER_LIVE_SETTINGS: readonly ScatterSetting[] = liveSettings(SCATTER_SETTINGS) as ScatterSetting[];
const BY_NAME = settingIndex(SCATTER_SETTINGS) as Map<string, ScatterSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function scatterSettingDefaults(): Record<string, ScatterSettingValue> {
  return settingDefaults(SCATTER_SETTINGS) as Record<string, ScatterSettingValue>;
}
/** Named looks, each only values of {@link SCATTER_SETTINGS}. */
export const SCATTER_LOOKS = {
  /** Today's defaults. */
  natural: {},
  /** A half-thinned meadow in a steady breeze. */
  thinMeadow: { 'scatter.density': 0.5, 'wind.strength': 0.4 },
  /** Blades that glow against a low sun, a little wider far away. */
  backlit: { 'blades.translucency': 0.6, 'blades.widen': 2 },
  /** A dry grass colour in a strong wind. */
  dryWindy: { 'scatter.color': [0.35, 0.3, 0.1], 'wind.strength': 0.9, 'blades.rootShade': 0.35 },
} as const satisfies Record<string, ScatterSettingValues>;
/** The name of a look in {@link SCATTER_LOOKS}. */
export type ScatterLookName = keyof typeof SCATTER_LOOKS;

/**
 * Writes `values` onto the Scatter (a name left out takes its default): the density and colour, the wind (removed at
 * strength 0) and the blade root shade, read from the next frame.
 * @throws TypeError for a name not in {@link SCATTER_SETTINGS}, or `blades.rootShade` moved off its default on a Scatter
 * built without `blades`; RangeError for a value outside its row's range, or a wind direction of 0 and 0 at strength above 0.
 * @example applyScatterSettings(scatter, SCATTER_LOOKS.thinMeadow);
 */
export function applyScatterSettings(scatter: ScatterSettingTarget, values: ScatterSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'scatter', 'SCATTER_SETTINGS in @margoengine/scatter/settings');
  const v = (name: string) => (name in values ? values[name] : BY_NAME.get(name)!.default);
  const x = v('wind.directionX') as number,
    z = v('wind.directionZ') as number,
    strength = v('wind.strength') as number,
    speed = v('wind.speed') as number,
    stiffness = v('wind.stiffness') as number;
  if (strength > 0 && !Math.hypot(x, z))
    throw new RangeError(
      'Invalid scatter setting wind.directionX; use a direction other than 0 and 0 while wind.strength is above 0',
    );
  const shade = v('blades.rootShade') as number;
  if (
    scatter.options.blades === undefined &&
    'blades.rootShade' in values &&
    shade !== BY_NAME.get('blades.rootShade')!.default
  )
    throw new TypeError('Setting blades.rootShade needs a Scatter built with the blades option');
  const bladed = scatter.options.blades !== undefined,
    widen = v('blades.widen') as number,
    translucency = v('blades.translucency') as number;
  for (const [name, value] of [
    ['blades.widen', widen],
    ['blades.translucency', translucency],
  ] as const)
    if (!bladed && name in values && value !== BY_NAME.get(name)!.default)
      throw new TypeError(`Setting ${name} needs a Scatter built with the blades option`);
  const look = ['variation.hue', 'variation.value', 'variation.clusters'].map((name) => v(name) as number);
  if (scatter.options.material === undefined)
    ['variation.hue', 'variation.value', 'variation.clusters'].forEach((name, i) => {
      if (name in values && look[i] !== BY_NAME.get(name)!.default)
        throw new TypeError(`Setting ${name} needs a Scatter built with the material option`);
    });
  scatter.density = v('scatter.density') as number;
  scatter.color = v('scatter.color') as ScatterSettingColor;
  scatter.wind = strength > 0 ? (speed > 0 ? [x, z, strength, speed] : [x, z, strength]) : undefined;
  scatter.sway = { ...scatter.sway, stiffness };
  if (bladed) {
    scatter.rootShade = shade;
    scatter.widen = widen;
    scatter.translucencyAmount = translucency;
  }
  if (scatter.options.material !== undefined) {
    scatter.variationHue = look[0];
    scatter.variationValue = look[1];
    scatter.clusters = look[2];
  }
}
