// The look controls of the environment package as one machine-readable table, for sliders, panels and tools (the model is
// @margoengine/sky/settings): each row names an option, its group, kind, default, range, step, unit, what it does and
// `live`. VolumetricFog, Fog, Environment and EnvironmentBackground read every row but the three grid sizes each frame
// (VolumetricFog from its options into one uniform, the others from setters that write a uniform), so
// `applyEnvironmentSettings` changes them every frame, keyed over a shot, without creating a pipeline, buffer or texture.
// A change of the grid size reallocates the froxel grid on the next frame (`live: false`). The named looks in
// `ENVIRONMENT_LOOKS` are only values of these rows. The air's visibility is a row that follows the weather: null
// leaves it to a `WeatherDrive`, which writes the density of every fog it finds.
import {
  checkSettings,
  choiceSetting,
  colorSetting,
  followsWeather,
  heldFromWeather,
  holdFromWeather,
  liveSettings,
  numberSetting,
  sameSettingValue,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import type { EnvironmentBackground } from './background.js';
import type { Environment } from './environment.js';
import type { Fog } from './lighting.js';
import type { VolumetricFog } from './volumetric.js';

/** A colour value: linear RGB. */
export type EnvironmentSettingColor = readonly [number, number, number];
/** One value of a setting: a number, a colour, a choice, or null where `nullable`. */
export type EnvironmentSettingValue = number | string | EnvironmentSettingColor | null;
/** Values by setting name; a name left out takes its default. */
export type EnvironmentSettingValues = Readonly<Record<string, EnvironmentSettingValue>>;
/** The panel a setting sits in. */
export type EnvironmentSettingGroup = 'air' | 'noise' | 'grid' | 'sceneFog' | 'environment' | 'background';
/** One control: the shared row shape with the environment's groups. */
export interface EnvironmentSetting extends SettingRow {
  readonly group: EnvironmentSettingGroup;
  readonly default: EnvironmentSettingValue;
}
/** The objects the rows write: each row needs the one named by its prefix (air, noise and grid: `air`; sceneFog: `fog`). */
export interface EnvironmentSettingTargets {
  /** A `VolumetricFog`: the rows named `air.*`, `noise.*` and `grid.*`. */
  air?: VolumetricFog;
  /** A `Fog` (scene distance fog): the rows named `sceneFog.*`. */
  fog?: Fog;
  /** An `Environment`: the rows named `environment.*`. */
  environment?: Environment;
  /** An `EnvironmentBackground`: the rows named `background.*`. */
  background?: EnvironmentBackground;
}

const n = (
  name: string,
  group: EnvironmentSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
  live = true,
): EnvironmentSetting => numberSetting(name, group, value, min, max, step, unit, about, live) as EnvironmentSetting;
const c = (name: string, group: EnvironmentSettingGroup, value: EnvironmentSettingColor, max: number, about: string) =>
  colorSetting(name, group, value, 0, max, about) as EnvironmentSetting;
const nullable = (row: EnvironmentSetting, about: string): EnvironmentSetting => ({
  ...row,
  default: null,
  nullable: true,
  about,
});
const onOff = (name: string, group: EnvironmentSettingGroup, about: string) =>
  choiceSetting(name, group, ['on', 'off'], about) as EnvironmentSetting;

/** Every environment look control, in panel order. Defaults are the values the objects use without the option. */
export const ENVIRONMENT_SETTINGS: readonly EnvironmentSetting[] = [
  onOff(
    'air.enabled',
    'air',
    'Whether the volumetric fog draws. Off skips its pass from the next frame and keeps its grid.',
  ),
  {
    ...followsWeather(
      n(
        'air.visibility',
        'air',
        23000,
        1,
        100000,
        1,
        'm',
        'How far a dark object stays visible in the air at and below air.height: 2% contrast (Koschmieder), extinction 3.912 / visibility per metre. Clear air is 23,000, haze 5,000, mist 1,000, fog 200 and less. Null follows the weather (clear air without a drive). While a WeatherDrive is attached it writes the density each frame and a value here is an override that the drive leaves alone, and null hands the air back to it.',
      ),
      'visibility',
    ),
  } as EnvironmentSetting,
  nullable(
    n('air.heightFalloff', 'air', 0, 0, 0.1, 0.0001, '1/m', ''),
    'Height fog: the density falls by exp(-heightFalloff (y - height)) above air.height; 0 is uniform fog. Null is the haze scale height, 1 in 1,200 per metre (0 once a weather drive writes a density).',
  ),
  n('air.height', 'air', 0, -1000, 10000, 1, 'm', 'World height below which the air has its full density.'),
  {
    ...followsWeather(
      c(
        'air.color',
        'air',
        [1, 1, 1],
        1,
        'Scattering albedo of the fog, linear RGB: 1 scatters all light, lower values absorb (smoke is dark). Null follows the weather: white without a drive, and while a WeatherDrive is attached the colour of its dust, smoke, ash and sea spray by their share of the air; a value here is an override the drive leaves alone, and null hands the colour back to it.',
      ),
      'visibility',
    ),
  } as EnvironmentSetting,
  nullable(
    c('air.ambient', 'air', [1, 1, 1], 100, ''),
    "Light the fog scatters from all sides, linear RGB. Null is the sky's horizon light in each view direction (the engine's ambient without a sky).",
  ),
  n(
    'air.anisotropy',
    'air',
    0.5,
    -0.95,
    0.95,
    0.01,
    '',
    'Henyey-Greenstein anisotropy: positive scatters forward and brightens shafts toward the light, 0 evenly, negative back.',
  ),
  n(
    'air.multipleScattering',
    'air',
    0,
    0,
    10000,
    1,
    'm',
    'Distance over which scattered light can scatter again: about the size of the fog bank. 0 is single scattering. Leaving 0 compiles one program, and returning to 0 another.',
  ),
  n(
    'air.range',
    'air',
    100,
    1,
    10000,
    1,
    'm',
    'Metres beyond the near plane the froxel grid covers (shafts, local lights, noise); past it the same fog is applied analytically out to the surface or the sky.',
  ),
  n(
    'air.temporal',
    'air',
    0.9,
    0,
    0.98,
    0.01,
    '',
    'Weight of the reprojected previous frame; 0 turns reprojection and jitter off.',
  ),
  n('noise.amount', 'noise', 0, 0, 1, 0.01, '', 'Density noise: 0 smooth fog, 1 patchy.'),
  n('noise.scale', 'noise', 8, 0.1, 1000, 0.1, 'm', 'Noise feature size.'),
  nullable(
    n('noise.windX', 'noise', 0, -50, 50, 0.1, 'm/s', ''),
    'Drift of the noise toward +x. Null on both noise.windX and noise.windZ leaves the drift as the weather drive set it.',
  ),
  nullable(n('noise.windZ', 'noise', 0, -50, 50, 0.1, 'm/s', ''), 'Drift of the noise toward +z; see noise.windX.'),
  n('grid.width', 'grid', 160, 2, 512, 1, 'froxels', 'Froxels across. A change rebuilds the grid.', false),
  n('grid.height', 'grid', 90, 2, 512, 1, 'froxels', 'Froxels down. A change rebuilds the grid.', false),
  n(
    'grid.depth',
    'grid',
    64,
    2,
    256,
    1,
    'froxels',
    'Froxels in depth, spaced quadratically. A change rebuilds the grid.',
    false,
  ),
  onOff('sceneFog.enabled', 'sceneFog', 'Whether the scene fog draws. Switching only rewrites its uniform.'),
  c('sceneFog.color', 'sceneFog', [1, 1, 1], 1, 'Fog colour, linear RGB; fully fogged pixels show exactly this.'),
  n('sceneFog.near', 'sceneFog', 1, 0, 100000, 1, 'm', 'Linear fog start distance (used while sceneFog.density is 0).'),
  n('sceneFog.far', 'sceneFog', 1000, 0, 100000, 1, 'm', 'Linear fog end distance, where fog is full.'),
  nullable(
    n('sceneFog.density', 'sceneFog', 0, 0, 0.1, 0.0001, '1/m', ''),
    'Above 0, exponential-squared fog 1 - exp(-(density distance)^2) in place of the linear one. Null leaves it to the weather drive.',
  ),
  n(
    'sceneFog.heightFalloff',
    'sceneFog',
    0,
    0,
    1,
    0.001,
    '1/m',
    'Height fog: the fog thins by exp(-falloff (y - height)) above sceneFog.height; 0 is off.',
  ),
  n(
    'sceneFog.height',
    'sceneFog',
    0,
    -1000,
    10000,
    1,
    'm',
    'World height below which the scene fog is at full strength.',
  ),
  n('environment.intensity', 'environment', 1, 0, 10, 0.01, '', 'Multiplier of image-based lighting.'),
  n(
    'environment.rotation',
    'environment',
    0,
    0,
    360,
    1,
    'degrees',
    'Rotation of the environment about +Y, shared by lighting and the background.',
  ),
  n(
    'background.exposure',
    'background',
    1,
    0,
    10,
    0.01,
    '',
    'Linear multiplier of the background before tone mapping.',
  ),
  n('background.blur', 'background', 0, 0, 1, 0.01, '', '0 sharp, 1 the roughest prefiltered mip.'),
  n(
    'background.rotation',
    'background',
    0,
    0,
    360,
    1,
    'degrees',
    'Extra rotation of the background about +Y, added to the environment rotation.',
  ),
];
/** The rows that can change every frame (all but the three grid sizes). */
export const ENVIRONMENT_LIVE_SETTINGS: readonly EnvironmentSetting[] = liveSettings(
  ENVIRONMENT_SETTINGS,
) as EnvironmentSetting[];
const BY_NAME = settingIndex(ENVIRONMENT_SETTINGS) as Map<string, EnvironmentSetting>;
/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function environmentSettingDefaults(): Record<string, EnvironmentSettingValue> {
  return settingDefaults(ENVIRONMENT_SETTINGS) as Record<string, EnvironmentSettingValue>;
}
/**
 * Named looks of the air, each only values of {@link ENVIRONMENT_SETTINGS} (a name left out keeps its default): pass one
 * to {@link applyEnvironmentSettings}, or spread it under your own values. Each sets a visibility, so with a weather
 * drive attached use them on a scene the weather does not drive.
 */
export const ENVIRONMENT_LOOKS = {
  /** Today's defaults: every row at its default, as the air and fog draws with no settings. */
  natural: {},
  /** Clear air: 23 km visibility with the haze's own scale height. */
  clear: { 'air.visibility': 23000 },
  /** Dry haze: 5 km. */
  haze: { 'air.visibility': 5000, 'air.anisotropy': 0.4 },
  /** Mist lying low: 1 km, thick in the lowest 100 m. */
  mist: { 'air.visibility': 1000, 'air.heightFalloff': 0.01, 'air.multipleScattering': 50 },
  /** Fog: 200 m, patchy, glowing in its own scatter. */
  fog: {
    'air.visibility': 200,
    'air.heightFalloff': 0.002,
    'air.multipleScattering': 200,
    'noise.amount': 0.2,
    'noise.scale': 30,
  },
  /** A smoke pall: 150 m of dark, drifting smoke, scattering little forward. */
  smokePall: {
    'air.visibility': 150,
    'air.color': [0.35, 0.32, 0.3],
    'air.anisotropy': 0.3,
    'air.heightFalloff': 0.002,
    'air.multipleScattering': 100,
    'noise.amount': 0.5,
    'noise.scale': 25,
    'noise.windX': 3,
    'noise.windZ': 0,
  },
  /** Dust haze: 800 m of tan air that scatters forward toward the sun. */
  dustHaze: {
    'air.visibility': 800,
    'air.color': [0.9, 0.7, 0.45],
    'air.anisotropy': 0.65,
    'air.heightFalloff': 0.003,
    'noise.amount': 0.3,
    'noise.scale': 40,
  },
  /** The animatedFeature family: 0.6 of the clear-air visibility so depth layers read, light scattering forward on the sun side. */
  animatedFeature: { 'air.visibility': 13800, 'air.anisotropy': 0.7, 'air.multipleScattering': 60 },
} as const satisfies Record<string, EnvironmentSettingValues>;
/** The name of a look in {@link ENVIRONMENT_LOOKS}. */
export type EnvironmentLookName = keyof typeof ENVIRONMENT_LOOKS;

const TARGET: Record<string, keyof EnvironmentSettingTargets> = {
  air: 'air',
  noise: 'air',
  grid: 'air',
  sceneFog: 'fog',
  environment: 'environment',
  background: 'background',
};
const RADIANS = Math.PI / 180;

/**
 * Writes `values` onto the given objects (a name left out takes its default), so each shows exactly that state: the
 * air's options, the scene fog's setters, the environment's and the background's. A row at its default draws as the
 * object does without the option. A null visibility, wind or scene fog density leaves it to whatever last set it (the
 * weather drive, or the default). A grid size change takes effect on the next frame.
 * @throws TypeError for a name not in {@link ENVIRONMENT_SETTINGS}, or a value moved off its default whose object is not in
 * `targets`; RangeError for a value outside its row's range or kind, or a grid size that is not a whole number.
 * @example applyEnvironmentSettings({ air: fog }, ENVIRONMENT_LOOKS.mist);
 */
export function applyEnvironmentSettings(
  targets: EnvironmentSettingTargets,
  values: EnvironmentSettingValues = {},
): void {
  checkSettings(BY_NAME, values, 'environment', 'ENVIRONMENT_SETTINGS in @margoengine/environment/settings');
  const v = (name: string) => (name in values ? values[name] : BY_NAME.get(name)!.default);
  for (const s of ENVIRONMENT_SETTINGS) {
    const key = TARGET[s.name.slice(0, s.name.indexOf('.'))];
    if (!targets[key] && s.name in values && !sameSettingValue(values[s.name], s.default))
      throw new TypeError(`Setting ${s.name} needs targets.${key}; pass it to applyEnvironmentSettings`);
    if (s.name.startsWith('grid.') && s.name in values && !Number.isInteger(values[s.name]))
      throw new RangeError(`Invalid environment setting ${s.name}; use a whole number from ${s.min} to ${s.max}`);
  }
  const num = (name: string) => v(name) as number;
  const air = targets.air;
  if (air) {
    const o = air.options as Record<string, unknown>,
      put = (key: string, value: unknown, fallback: unknown) =>
        sameSettingValue(value, fallback) ? delete o[key] : (o[key] = Array.isArray(value) ? [...value] : value);
    if (v('air.enabled') === 'off') o.enabled = false;
    else delete o.enabled;
    const visibility = v('air.visibility') as number | null;
    if (visibility === null) delete o.visibility;
    else (o.visibility = visibility), delete o.density;
    const falloff = v('air.heightFalloff') as number | null;
    if (falloff === null) delete o.heightFalloff;
    else o.heightFalloff = falloff;
    put('height', num('air.height'), 0);
    const color = v('air.color') as EnvironmentSettingColor | null;
    // Null keeps what the weather drive wrote; only a colour this table set (held) is taken back.
    if (color !== null) o.color = [...color];
    else if (heldFromWeather(o, 'color')) delete o.color;
    holdFromWeather(o, 'color', color !== null);
    const ambient = v('air.ambient');
    if (ambient === null) delete o.ambient;
    else o.ambient = [...(ambient as EnvironmentSettingColor)];
    put('anisotropy', num('air.anisotropy'), 0.5);
    put('multipleScattering', num('air.multipleScattering'), 0);
    put('range', num('air.range'), 100);
    put('temporal', num('air.temporal'), 0.9);
    put('noise', num('noise.amount'), 0);
    put('noiseScale', num('noise.scale'), 8);
    const x = v('noise.windX') as number | null,
      z = v('noise.windZ') as number | null;
    if (x !== null || z !== null) put('wind', [x ?? 0, 0, z ?? 0], [0, 0, 0]);
    holdFromWeather(o, 'wind', x !== null || z !== null);
    put('grid', [num('grid.width'), num('grid.height'), num('grid.depth')], [160, 90, 64]);
  }
  const fog = targets.fog;
  if (fog) {
    fog.enabled = v('sceneFog.enabled') !== 'off';
    fog.color = [...(v('sceneFog.color') as EnvironmentSettingColor)] as [number, number, number];
    fog.near = num('sceneFog.near');
    fog.far = num('sceneFog.far');
    const density = v('sceneFog.density') as number | null;
    if (density !== null) fog.density = density;
    holdFromWeather(fog, 'density', density !== null);
    fog.heightFalloff = num('sceneFog.heightFalloff');
    fog.height = num('sceneFog.height');
  }
  if (targets.environment) {
    targets.environment.intensity = num('environment.intensity');
    targets.environment.rotation = num('environment.rotation') * RADIANS;
  }
  if (targets.background) {
    targets.background.exposure = num('background.exposure');
    targets.background.blur = num('background.blur');
    targets.background.rotation = num('background.rotation') * RADIANS;
  }
}
