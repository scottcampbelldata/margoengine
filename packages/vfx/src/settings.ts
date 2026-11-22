// The live look and motion options of a particle effect as one machine-readable table, for sliders and tools: each row
// names an option, its group, kind, default, range, step, unit and what it does, and every row is `live` (the effect
// reads it each frame, so writing it creates no pipeline, buffer or texture and it can be keyed over a shot). The
// wind rows are `nullable` with `weather: 'wind'`: at null the effect follows the weather (`WeatherDrive` writes its
// wind each frame); a number overrides it. The row shape is shared with every package's settings
// (`packages/shared/settings.js`; the model is `@margoengine/sky/settings`).
//
// Not rows: what is fixed at construction or attach (`capacity`, `initialCount`, `wrap`, `sort`, `texture`, the shape
// of an `emitter` or a `mesh`), the structured options of the feature entries (`curves`, `obstacles`, `fields`,
// `lit` ...) and `position` (the scene places the effect). A `Fire` is applied part by part: `fire.particles.flames`,
// `embers` and `steam` are effects.
import {
  checkSettings,
  colorSetting,
  followsWeather,
  holdFromWeather,
  liveSettings,
  numberSetting,
  sameSettingValue,
  settingDefaults,
  settingIndex,
  type SettingRow,
} from '../../shared/settings.js';
import type { VFXOptions } from './base.js';
import { flameRamp } from './flame-ramp.js';

/** One value of a setting: a number, a colour (linear RGB) or null where `nullable`. */
export type VfxSettingValue = number | readonly [number, number, number] | null;
/** Values by setting name; a name left out takes its default. */
export type VfxSettingValues = Readonly<Record<string, VfxSettingValue>>;
/** The panel a setting sits in. */
export type VfxSettingGroup = 'emission' | 'motion' | 'wind' | 'look';

/** One control: the shared row shape with the effect's groups. Every row is live. */
export interface VfxSetting extends SettingRow {
  readonly name: string;
  readonly group: VfxSettingGroup;
  readonly kind: 'number' | 'color';
  readonly default: VfxSettingValue;
}
const n = (
  name: string,
  group: VfxSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): VfxSetting => numberSetting(name, group, value, min, max, step, unit, about) as VfxSetting;

/** Every particle control, in panel order. Defaults are what an effect does without the option. */
export const VFX_SETTINGS: readonly VfxSetting[] = [
  {
    ...n(
      'rate',
      'emission',
      0,
      0,
      1000000,
      1,
      'births/s',
      'Particles born a second; null is half the capacity a second (the effect fills in about two seconds).',
    ),
    default: null,
    nullable: true,
  },
  n('spread', 'emission', 1, 0, 50, 0.01, 'm/s', 'Random speed added to each birth.'),
  n(
    'emissionExtent.x',
    'emission',
    0,
    0,
    100,
    0.01,
    'm',
    'Half width of the box births are spread over (0 is a point).',
  ),
  n('emissionExtent.y', 'emission', 0, 0, 100, 0.01, 'm', 'Half height of the box births are spread over.'),
  n('emissionExtent.z', 'emission', 0, 0, 100, 0.01, 'm', 'Half depth of the box births are spread over.'),
  n('velocity.x', 'motion', 0, -100, 100, 0.01, 'm/s', 'Launch velocity, east-west.'),
  n('velocity.y', 'motion', 3, -100, 100, 0.01, 'm/s', 'Launch velocity, up: smoke rises at this speed.'),
  n('velocity.z', 'motion', 0, -100, 100, 0.01, 'm/s', 'Launch velocity, north-south.'),
  n('gravity.x', 'motion', 0, -100, 100, 0.01, 'm/s2', 'Acceleration east-west.'),
  n(
    'gravity.y',
    'motion',
    -9.81,
    -100,
    100,
    0.01,
    'm/s2',
    'Acceleration up: -9.81 falls like Earth, a small positive number makes smoke buoyant.',
  ),
  n('gravity.z', 'motion', 0, -100, 100, 0.01, 'm/s2', 'Acceleration north-south.'),
  n('turbulence', 'motion', 0.5, 0, 20, 0.01, 'm/s2', 'Curl-noise acceleration; 0 turns it off.'),
  n('frequency', 'motion', 1, 0, 20, 0.01, '1/m', 'How fine the curl noise is, per metre.'),
  n('bounce', 'motion', 0.3, 0, 1, 0.01, '', 'Share of speed kept after hitting the ground or an obstacle.'),
  n('ground', 'motion', 0, -1000, 1000, 0.1, 'm', 'Height of the collision plane.'),
  n('angularVelocity', 'motion', 0, -50, 50, 0.01, 'rad/s', 'Billboard spin; each particle starts at a random angle.'),
  followsWeather(
    n(
      'wind.x',
      'wind',
      0,
      -100,
      100,
      0.1,
      'm/s',
      'Wind east-west (+X). Particles lean as they relax toward it in 0.25 s; null follows the weather. With wind.z, one given and the other null reads the null one as 0.',
    ),
    'wind',
  ) as VfxSetting,
  followsWeather(
    n('wind.z', 'wind', 0, -100, 100, 0.1, 'm/s', 'Wind north-south (+Z); null follows the weather.'),
    'wind',
  ) as VfxSetting,
  n('size', 'look', 0.1, 0.001, 20, 0.001, 'm', 'Billboard diameter.'),
  n('lifetime.min', 'look', 1, 0.05, 60, 0.01, 's', 'Shortest life of a particle; at most lifetime.max.'),
  n('lifetime.max', 'look', 3, 0.05, 120, 0.01, 's', 'Longest life of a particle.'),
  colorSetting('color', 'look', [1, 0.5, 0.1], 0, 1, 'Colour at birth, linear RGB.') as VfxSetting,
  n('alpha', 'look', 1, 0, 1, 0.01, '', 'Opacity at birth; it fades out over the life.'),
  n('intensity', 'look', 1, 0, 1000, 0.01, '', 'Brightness multiplier for HDR glow (a flame is about 60).'),
];
/** The rows that may change every frame (all of them). */
export const VFX_LIVE_SETTINGS: readonly VfxSetting[] = liveSettings(VFX_SETTINGS) as VfxSetting[];
const BY_NAME = settingIndex(VFX_SETTINGS) as Map<string, VfxSetting>;

/** Every setting at its default, as a fresh object to edit (a slider panel's state). */
export function vfxSettingDefaults(): Record<string, VfxSettingValue> {
  return settingDefaults(VFX_SETTINGS) as Record<string, VfxSettingValue>;
}

/** What {@link applyVfxSettings} writes to: a `VFX`, or anything with options. */
export interface VfxSettingTarget {
  readonly options: object;
}

const vec = (
  o: Record<string, unknown>,
  key: string,
  names: readonly [string, string, string],
  value: (name: string) => unknown,
  fallback: readonly [number, number, number],
) => {
  const v = names.map((name) => value(name) as number) as [number, number, number];
  if (v.every((x, i) => x === fallback[i])) delete o[key];
  else o[key] = v;
};

/**
 * Writes `values` onto the effect (a name left out takes its default), so it shows exactly that state: an option whose
 * values are all at their defaults is left unset, so the effect draws as one that never had it. Null `rate` is the
 * effect's own rate (half its capacity a second). Both wind rows null leave the option unset, which is what the weather
 * drive writes into (and what it leaves alone while a number overrides it); either one given sets the wind `[x, z]`.
 * The options the table does not hold (`position`, `curves`, `emitter` ...) are not touched. To change one value of
 * an effect built with options of its own, start from {@link vfxSettingValues} so the others keep theirs.
 * @throws TypeError for a name not in {@link VFX_SETTINGS}; RangeError for a value outside its row's range or kind, or
 * `lifetime.min` above `lifetime.max`.
 * @example applyVfxSettings(smoke, { ...vfxSettingValues(smoke), 'velocity.y': 5, turbulence: 2 });
 */
export function applyVfxSettings(target: VfxSettingTarget, values: VfxSettingValues = {}): void {
  checkSettings(BY_NAME, values, 'vfx', 'VFX_SETTINGS in @margoengine/vfx/settings');
  const value = (name: string): unknown => (name in values ? values[name] : BY_NAME.get(name)!.default),
    o = target.options as Record<string, unknown>;
  if ((value('lifetime.min') as number) > (value('lifetime.max') as number))
    throw new RangeError('Invalid vfx setting lifetime.min; use a number at most lifetime.max');
  for (const row of VFX_SETTINGS) {
    if (row.group === 'emission' && row.name === 'rate') {
      if (value('rate') === null) delete o.rate;
      else o.rate = value('rate');
    } else if (!row.name.includes('.') && row.name !== 'color' && row.name !== 'alpha') {
      if (sameSettingValue(value(row.name), row.default)) delete o[row.name];
      else o[row.name] = value(row.name);
    }
  }
  vec(o, 'emissionExtent', ['emissionExtent.x', 'emissionExtent.y', 'emissionExtent.z'], value, [0, 0, 0]);
  vec(o, 'velocity', ['velocity.x', 'velocity.y', 'velocity.z'], value, [0, 3, 0]);
  vec(o, 'gravity', ['gravity.x', 'gravity.y', 'gravity.z'], value, [0, -9.81, 0]);
  const wx = value('wind.x') as number | null,
    wz = value('wind.z') as number | null;
  if (wx === null && wz === null) delete o.wind;
  else o.wind = [wx ?? 0, wz ?? 0];
  holdFromWeather(o, 'wind', wx !== null || wz !== null);
  const life = [value('lifetime.min'), value('lifetime.max')] as [number, number];
  if (life[0] === 1 && life[1] === 3) delete o.lifetime;
  else o.lifetime = life;
  const rgb = value('color') as readonly [number, number, number],
    alpha = value('alpha') as number;
  if (sameSettingValue(rgb, [1, 0.5, 0.1]) && alpha === 1) delete o.color;
  else o.color = [rgb[0], rgb[1], rgb[2], alpha];
}

/**
 * The values an effect shows now, as a panel's starting state: each row from the effect's options, or its default
 * where the option is unset (a wind that is not a plain `[x, z]`, such as a sampler, reads as null). Writing them back
 * with {@link applyVfxSettings} leaves the effect's table options as they are.
 */
export function vfxSettingValues(target: VfxSettingTarget): Record<string, VfxSettingValue> {
  const o = target.options as VFXOptions,
    v = vfxSettingDefaults(),
    axes = (key: 'emissionExtent' | 'velocity' | 'gravity') => {
      const a = o[key];
      if (a) (['x', 'y', 'z'] as const).forEach((c, i) => (v[`${key}.${c}`] = a[i]!));
    };
  for (const key of [
    'spread',
    'turbulence',
    'frequency',
    'bounce',
    'ground',
    'angularVelocity',
    'size',
    'intensity',
  ] as const)
    if (o[key] !== undefined) v[key] = o[key]!;
  if (o.rate !== undefined) v.rate = o.rate;
  axes('emissionExtent');
  axes('velocity');
  axes('gravity');
  if (Array.isArray(o.wind)) {
    v['wind.x'] = o.wind[0]!;
    v['wind.z'] = o.wind[1]!;
  }
  if (o.lifetime) {
    v['lifetime.min'] = o.lifetime[0];
    v['lifetime.max'] = o.lifetime[1];
  }
  if (o.color) {
    v.color = [o.color[0], o.color[1], o.color[2]];
    v.alpha = o.color[3];
  }
  return v;
}

// ---- Wind-blown sand (`BlownSand` from `@margoengine/vfx/blown-sand`) ----
//
// The rows of a sand layer in the same shape. The wind rows and `fog` are `nullable`: at null the layer follows the weather
// (`WeatherDrive` writes `wind` from the state's wind and `fog` from the air's extinction, dust included); a number
// overrides it. The rows that lay the particles out again or change the draw (`amount`, `seed`, `limit`, `range`,
// `softness`) are not live. Not rows: `ground`, `mask`, `depth` and `sky` (the scene gives them).

/** The panel a sand setting sits in. */
export type SandSettingGroup = 'wind' | 'grain' | 'look' | 'layout';
/** One sand control: the shared row shape. */
export interface SandSetting extends SettingRow {
  readonly name: string;
  readonly group: SandSettingGroup;
  readonly kind: 'number' | 'color';
  readonly default: VfxSettingValue;
}
const sn = (
  name: string,
  group: SandSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
  live = true,
): SandSetting => numberSetting(name, group, value, min, max, step, unit, about, live) as SandSetting;
const nullableRow = (row: SandSetting, weather?: string): SandSetting =>
  (weather ? followsWeather(row, weather) : { ...row, default: null, nullable: true }) as SandSetting;

/** Every blown-sand control, in panel order. */
export const SAND_SETTINGS: readonly SandSetting[] = [
  nullableRow(
    sn(
      'wind.speed',
      'wind',
      0,
      0,
      60,
      0.1,
      'm/s',
      'Mean wind at windHeight; null follows the weather. Sand moves above the threshold (6.6 m/s for 0.25 mm sand at 10 m).',
    ),
    'wind',
  ),
  nullableRow(
    sn(
      'wind.direction',
      'wind',
      0,
      0,
      360,
      1,
      'degrees',
      'Compass direction the wind blows toward: 0 is +Z, 90 is +X; null follows the weather.',
    ),
    'windDirection',
  ),
  nullableRow(
    sn('wind.gust', 'wind', 0.35, 0, 1, 0.01, '', 'Gustiness of the wind; null follows the weather.'),
    'gust',
  ),
  sn('wind.gustPeriod', 'wind', 8, 0.5, 600, 0.5, 's', 'Seconds between gusts.'),
  nullableRow(sn('gustiness', 'wind', 0.35, 0, 1, 0.01, '', 'How far gusts swing the sand; null takes the wind gust.')),
  nullableRow(
    sn(
      'threshold',
      'grain',
      6.6,
      0.1,
      60,
      0.1,
      'm/s',
      'Wind speed at which dry sand starts to move (Bagnold); null is the one grainSize and windHeight give.',
    ),
  ),
  sn(
    'grainSize',
    'grain',
    0.00025,
    0.00006,
    0.002,
    0.00001,
    'm',
    'Grain diameter: 0.06 mm fine sand to 2 mm coarse; sets the default threshold.',
  ),
  sn('windHeight', 'grain', 10, 0.5, 100, 0.5, 'm', 'Height the wind speed is given at.'),
  colorSetting('color', 'look', [0.5, 0.42, 0.29], 0, 1, 'Grain colour, linear RGB (terrain dry sand).') as SandSetting,
  sn('streak', 'look', 0.6, 0.05, 5, 0.01, 'm', 'Length of a streak of moving sand.'),
  sn(
    'height',
    'look',
    0.3,
    0.02,
    3,
    0.01,
    'm',
    'Height under which most sand moves; crest plumes rise about 4 times it.',
  ),
  sn('opacity', 'look', 0.6, 0, 1, 0.01, '', 'Opacity of the sand.'),
  nullableRow(
    sn(
      'fog',
      'look',
      0,
      0,
      1,
      0.0001,
      '1/m',
      'Fog density the sand fades by with distance; null follows the weather (the air, dust included).',
    ),
    'visibility',
  ),
  sn('amount', 'layout', 1, 0, 1, 0.01, '', 'Density of the blowing sand; lays the particles out again.', false),
  sn('seed', 'layout', 1, 0, 2147483647, 1, '', 'The same seed and time draw the same sand.', false),
  sn('limit', 'layout', 32768, 1, 1048576, 1, 'particles', 'Most particles drawn.', false),
  sn('range', 'layout', 250, 10, 2000, 1, 'm', 'Radius around the camera with blowing sand.', false),
  sn(
    'softness',
    'layout',
    0,
    0,
    100,
    0.1,
    'm',
    'Fade in front of the surface behind (needs the scene depth); 0 is off.',
    false,
  ),
];
/** The sand rows that may change every frame. */
export const SAND_LIVE_SETTINGS: readonly SandSetting[] = liveSettings(SAND_SETTINGS) as SandSetting[];
const SAND_BY_NAME = settingIndex(SAND_SETTINGS) as Map<string, SandSetting>;

/** Every sand setting at its default, as a fresh object to edit. */
export function sandSettingDefaults(): Record<string, VfxSettingValue> {
  return settingDefaults(SAND_SETTINGS) as Record<string, VfxSettingValue>;
}

/** Named looks, values of {@link SAND_SETTINGS}: pass one to {@link applySandSettings}. A wind row left out is null and follows the weather. */
export const SAND_LOOKS = {
  /** Today's defaults: every row at its default, as the blown sand draws with no settings. */
  natural: {},
  /** The animatedFeature family: soft, wide, pale drifts, not a hard streak. */
  animatedFeature: { 'wind.speed': 8, 'wind.gust': 0.25, streak: 0.5, height: 0.35, opacity: 0.45 },
  /** Fine sand in a light wind: a pale low drift. */
  drift: { 'wind.speed': 8, 'wind.direction': 90, 'wind.gust': 0.3, streak: 0.5, height: 0.2, opacity: 0.5 },
  /** Sand in a gale: long streaks, thick and high. */
  sandstorm: { 'wind.speed': 18, 'wind.direction': 90, 'wind.gust': 0.7, streak: 1.2, height: 0.8, opacity: 0.8 },
  /** Sand of any weather: every wind row null, so the weather's wind blows it. */
  weather: {},
} as const satisfies Record<string, VfxSettingValues>;

/**
 * Writes `values` onto a `BlownSand` (a name left out takes its default), so it shows exactly that state. A null
 * `wind.speed` leaves the wind `{speed: 0}`, which `WeatherDrive` then fills from the weather; a null `fog`,
 * `threshold` or `gustiness` leaves the option unset. Options the table does not hold are not touched.
 * @throws TypeError for a name not in {@link SAND_SETTINGS}; RangeError for a value outside its row's range.
 * @example applySandSettings(sand, SAND_LOOKS.sandstorm);
 */
export function applySandSettings(target: VfxSettingTarget, values: VfxSettingValues = {}): void {
  checkSettings(SAND_BY_NAME, values, 'vfx', 'SAND_SETTINGS in @margoengine/vfx/settings');
  const value = (name: string): unknown => (name in values ? values[name] : SAND_BY_NAME.get(name)!.default),
    o = target.options as Record<string, unknown>;
  const speed = value('wind.speed') as number | null,
    direction = value('wind.direction') as number | null,
    gust = value('wind.gust') as number | null;
  o.wind =
    speed === null
      ? { speed: 0 }
      : {
          speed,
          direction: ((direction ?? 0) * Math.PI) / 180,
          ...(gust === null ? {} : { gust }),
          gustPeriod: value('wind.gustPeriod') as number,
        };
  holdFromWeather(o, 'wind', speed !== null);
  holdFromWeather(o, 'fog', value('fog') !== null);
  for (const key of ['gustiness', 'threshold', 'fog'] as const) {
    if (value(key) === null) delete o[key];
    else o[key] = value(key);
  }
  for (const key of [
    'grainSize',
    'windHeight',
    'streak',
    'height',
    'opacity',
    'amount',
    'seed',
    'limit',
    'range',
    'softness',
  ])
    o[key] = value(key);
  o.color = [...(value('color') as readonly number[])];
}

/**
 * The values a sand layer shows now, as a panel's starting state: each row from its options, or its default where
 * the option is unset (a wind that is a `WindField`, or a speed of 0, reads as null: it follows the weather).
 */
export function sandSettingValues(target: VfxSettingTarget): Record<string, VfxSettingValue> {
  const o = target.options as Record<string, unknown>,
    v = sandSettingDefaults();
  const wind = o.wind as { speed?: number; direction?: number; gust?: number; gustPeriod?: number } | undefined;
  if (wind && !('options' in wind) && typeof wind.speed === 'number' && wind.speed > 0) {
    v['wind.speed'] = wind.speed;
    v['wind.direction'] = (((((wind.direction ?? 0) * 180) / Math.PI) % 360) + 360) % 360;
    if (wind.gust !== undefined) v['wind.gust'] = wind.gust;
    if (wind.gustPeriod !== undefined) v['wind.gustPeriod'] = wind.gustPeriod;
  }
  for (const key of [
    'gustiness',
    'threshold',
    'fog',
    'grainSize',
    'windHeight',
    'streak',
    'height',
    'opacity',
    'amount',
    'seed',
    'limit',
    'range',
    'softness',
  ])
    if (typeof o[key] === 'number') v[key] = o[key] as number;
  if (Array.isArray(o.color)) v.color = [o.color[0], o.color[1], o.color[2]];
  return v;
}

// ---- Smoke columns (`Smoke` from `@margoengine/vfx/smoke`) ----
//
// The rows of a smoke column in the same shape. Every row but `lifetime` is live (the column reads it each frame and
// rewrites its curves in place). The wind rows are `nullable` with `weather: 'wind'`: at null the column follows the
// fire it stands on or the weather (`WeatherDrive` writes its wind each frame); a number overrides it. Not rows:
// `position` and `fire` (the scene places it), `prewarm`, `texture`, `lights`, `shadows` and `depth` (read at attach).

/** The panel a smoke setting sits in. */
export type SmokeSettingGroup = 'source' | 'air' | 'wind' | 'look';
/** One smoke control: the shared row shape. */
export interface SmokeSetting extends SettingRow {
  readonly name: string;
  readonly group: SmokeSettingGroup;
  readonly kind: 'number' | 'color';
  readonly default: VfxSettingValue;
}
const mn = (
  name: string,
  group: SmokeSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
  live = true,
): SmokeSetting => numberSetting(name, group, value, min, max, step, unit, about, live) as SmokeSetting;

/** Every smoke column control, in panel order. Defaults are what `Smoke.attach({position})` does. */
export const SMOKE_SETTINGS: readonly SmokeSetting[] = [
  mn(
    'heat',
    'source',
    5e6,
    0,
    1e11,
    1000,
    'W',
    'Convective heat release: it sets the rise (Briggs buoyancy flux). 20 kW a hearth, 5 MW a house, 1 GW a wildfire head.',
  ),
  mn('radius', 'source', 2, 0.05, 2000, 0.05, 'm', 'Radius of the source; the column starts this wide.'),
  mn(
    'rate',
    'source',
    20,
    0.1,
    10000,
    0.1,
    'puffs/s',
    'Puffs born a second (at most the capacity attach made, rate x lifetime).',
  ),
  mn(
    'lifetime',
    'source',
    60,
    1,
    3600,
    1,
    's',
    'Seconds a puff lives: the column is its rise at this age. Sets the capacity.',
    false,
  ),
  mn('airTemperature', 'air', 288.15, 200, 330, 0.1, 'K', 'Air temperature, for the buoyancy flux.'),
  mn(
    'stability',
    'air',
    0,
    0,
    0.01,
    0.00001,
    '1/s2',
    'Air stability (g/T) dtheta/dz: above 0 the column levels off and spreads (Briggs final rise). 0 is neutral.',
  ),
  followsWeather(
    mn('wind.x', 'wind', 0, -100, 100, 0.1, 'm/s', 'Wind east-west; null follows the fire or the weather.'),
    'wind',
  ) as SmokeSetting,
  followsWeather(
    mn('wind.z', 'wind', 0, -100, 100, 0.1, 'm/s', 'Wind north-south; null follows the fire or the weather.'),
    'wind',
  ) as SmokeSetting,
  colorSetting('color', 'look', [0.3, 0.29, 0.28], 0, 1, 'Smoke colour, linear RGB.') as SmokeSetting,
  mn('opacity', 'look', 0.5, 0, 1, 0.01, '', 'Opacity of a puff.'),
  mn('turbulence', 'look', 0.4, 0, 20, 0.01, 'm/s2', 'Curl-noise churn; 0 is a smooth column.'),
  mn(
    'glow',
    'look',
    1,
    0,
    10,
    0.01,
    '',
    'Glow of the fire on the column from below: a multiple of its radiated power (0.3 of the release, Drysdale 2011). 0 turns it off.',
  ),
];
/** The smoke rows that may change every frame. */
export const SMOKE_LIVE_SETTINGS: readonly SmokeSetting[] = liveSettings(SMOKE_SETTINGS) as SmokeSetting[];
const SMOKE_BY_NAME = settingIndex(SMOKE_SETTINGS) as Map<string, SmokeSetting>;

/** Every smoke setting at its default, as a fresh object to edit. */
export function smokeSettingDefaults(): Record<string, VfxSettingValue> {
  return settingDefaults(SMOKE_SETTINGS) as Record<string, VfxSettingValue>;
}

/** Named looks, values of {@link SMOKE_SETTINGS}: pass one to {@link applySmokeSettings}. Wind rows left out follow the weather. */
export const SMOKE_LOOKS = {
  /** Today's defaults: every row at its default, as the smoke draws with no settings. */
  natural: {},
  /** A wood hearth or camp fire: a thin pale column. */
  campfire: { heat: 20000, radius: 0.3, rate: 12, color: [0.42, 0.41, 0.4], opacity: 0.35, turbulence: 0.6 },
  /** A burning house: a thick grey-brown column. */
  houseFire: { heat: 5e6, radius: 3, rate: 20, color: [0.22, 0.2, 0.18], opacity: 0.6 },
  /** A wildfire head: a broad column that tops out in the stable air above the mixed layer. */
  wildfire: {
    heat: 1e9,
    radius: 40,
    rate: 30,
    lifetime: 240,
    stability: 0.0003,
    color: [0.33, 0.29, 0.25],
    opacity: 0.6,
    turbulence: 1,
  },
  /** Burning oil or tyres: black. */
  oil: { heat: 2e7, radius: 4, rate: 25, color: [0.03, 0.03, 0.03], opacity: 0.8 },
  /** The animatedFeature family: a soft lit column in one large shape, little small-scale turbulence. */
  animatedFeature: { heat: 5e5, radius: 1.5, rate: 18, color: [0.35, 0.33, 0.31], opacity: 0.5, turbulence: 0.5 },
} as const satisfies Record<string, VfxSettingValues>;

/**
 * A `FireFront` of `@margoengine/vfx/fire-front` (or anything that owns a pool of smoke columns): the front sets each
 * column's heat and source radius from its segment every step, so a look writes the other rows onto every column it has
 * and every column it makes later, through `setSmokeLook`.
 */
export interface SmokeColumnsTarget {
  readonly smokeColumns: readonly VfxSettingTarget[];
  /** Keeps `write` and calls it on every column now and on each one made later. */
  setSmokeLook(write: (column: VfxSettingTarget) => void): unknown;
}
/** What {@link applySmokeSettings} writes to: a `Smoke`, or a `FireFront`'s smoke columns. */
export type SmokeSettingTarget = VfxSettingTarget | SmokeColumnsTarget;

const SMOKE_NUMBERS = [
  'heat',
  'radius',
  'rate',
  'lifetime',
  'airTemperature',
  'stability',
  'opacity',
  'turbulence',
  'glow',
] as const;
// The rows a fire front owns on each of its columns: the heat and the radius of the burning ground of its segment.
const FRONT_OWNED = new Set<string>(['heat', 'radius']);
// What each front column was built with, taken the first time a look writes it, so a row left out gives it back.
const columnBases = new WeakMap<object, Record<string, unknown>>();

function writeSmoke(target: VfxSettingTarget, values: VfxSettingValues, column: boolean): void {
  const o = target.options as Record<string, unknown>;
  let base: Record<string, unknown> | undefined;
  if (column) {
    base = columnBases.get(o);
    if (!base) {
      base = {};
      for (const key of SMOKE_NUMBERS) base[key] = o[key];
      base.color = Array.isArray(o.color) ? [...(o.color as number[])] : undefined;
      columnBases.set(o, base);
    }
  }
  const value = (name: string): unknown =>
    name in values ? values[name] : (base?.[name] ?? SMOKE_BY_NAME.get(name)!.default);
  for (const key of SMOKE_NUMBERS) if (!column || !FRONT_OWNED.has(key)) o[key] = value(key);
  o.color = [...(value('color') as readonly number[])];
  const wx = value('wind.x') as number | null,
    wz = value('wind.z') as number | null;
  if (wx === null && wz === null) delete o.wind;
  else o.wind = [wx ?? 0, wz ?? 0];
  holdFromWeather(o, 'wind', wx !== null || wz !== null);
}

/**
 * Writes `values` onto a `Smoke` (a name left out takes its default), so it shows exactly that state. Both wind rows
 * null leave the column's own wind unset (it follows its fire or the weather); either one given sets `[x, z]`.
 * `lifetime` is read at attach: write it before `Smoke.attach` (onto the options object) or it waits for the next.
 * A `FireFront` takes the values on every smoke column it has and makes later, except `heat` and `radius`, which the
 * front sets per column from its segments; there a name left out gives back what the front built the column with
 * (its 300 s life, 16 puffs a second, wood smoke and its `smoke` options) and `lifetime` reaches columns made later.
 * @throws TypeError for a name not in {@link SMOKE_SETTINGS}; RangeError for a value outside its row's range.
 * @example applySmokeSettings(smoke, SMOKE_LOOKS.houseFire);
 */
export function applySmokeSettings(target: SmokeSettingTarget, values: VfxSettingValues = {}): void {
  checkSettings(SMOKE_BY_NAME, values, 'vfx', 'SMOKE_SETTINGS in @margoengine/vfx/settings');
  if ('setSmokeLook' in target && typeof target.setSmokeLook === 'function') {
    const own = { ...values };
    target.setSmokeLook((column) => writeSmoke(column, own, true));
  } else writeSmoke(target as VfxSettingTarget, values, false);
}

/**
 * The values a smoke column shows now, as a panel's starting state: each row from its options, or its default where
 * the option is unset (a wind that is a sampler reads as null).
 */
export function smokeSettingValues(target: VfxSettingTarget): Record<string, VfxSettingValue> {
  const o = target.options as Record<string, unknown>,
    v = smokeSettingDefaults();
  for (const key of [
    'heat',
    'radius',
    'rate',
    'lifetime',
    'airTemperature',
    'stability',
    'opacity',
    'turbulence',
    'glow',
  ])
    if (typeof o[key] === 'number') v[key] = o[key] as number;
  if (Array.isArray(o.color)) v.color = [o.color[0], o.color[1], o.color[2]];
  if (Array.isArray(o.wind)) {
    v['wind.x'] = o.wind[0];
    v['wind.z'] = o.wind[1];
  }
  return v;
}

// ---- Wildfire fronts (`FireFront` from `@margoengine/vfx/fire-front`) ----
//
// The rows of a fire front in the same shape. Every row is live (the fire reads it each step). The wind rows are
// `nullable` with `weather: 'wind'`: at null the front follows the weather (`WeatherDrive` writes its 10 m wind each
// frame); a number overrides it. Not rows: the grid (`size`, `cell`, `origin`), `ground`, `fuel`, `structures`,
// `ignitions`, `step`, `seed`, `segment` and `columns` (what a scene builds the fire from, read at construction or attach).

/** The panel a fire setting sits in. */
export type FireSettingGroup = 'fuel' | 'wind' | 'embers' | 'structures' | 'smoke';
/** One fire control: the shared row shape. */
export interface FireSetting extends SettingRow {
  readonly name: string;
  readonly group: FireSettingGroup;
  readonly kind: 'number';
  readonly default: VfxSettingValue;
}
const fn = (
  name: string,
  group: FireSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): FireSetting => numberSetting(name, group, value, min, max, step, unit, about, true) as FireSetting;

/** Every fire front control, in panel order. Defaults are what `FireFront.attach()` does. */
export const FIRE_SETTINGS: readonly FireSetting[] = [
  followsWeather(
    fn(
      'moisture',
      'fuel',
      0.06,
      0,
      1,
      0.005,
      '',
      'Dead 1-hour fuel moisture, a fraction of dry weight (Rothermel 1972). 0.03 is a red-flag day, 0.12 the edge of grass spreading, 0.3 rain-soaked. Null follows the weather (a WeatherDrive dries and wets it from the humidity, temperature and rain), 0.06 without one.',
    ),
    'humidity',
  ) as FireSetting,
  followsWeather(
    fn(
      'moisture10',
      'fuel',
      0.07,
      0,
      4,
      0.005,
      '',
      'Dead 10-hour fuel moisture (a quarter to one inch). Null follows the weather, or the 1-hour value plus 0.01 without one.',
    ),
    'humidity',
  ) as FireSetting,
  followsWeather(
    fn(
      'moisture100',
      'fuel',
      0.08,
      0,
      4,
      0.005,
      '',
      'Dead 100-hour fuel moisture (one to three inches). Null follows the weather, or the 1-hour value plus 0.02 without one.',
    ),
    'humidity',
  ) as FireSetting,
  fn(
    'liveMoisture',
    'fuel',
    0.9,
    0,
    4,
    0.05,
    '',
    'Live fuel moisture, a fraction of dry weight. Late-season chaparral is 0.6 to 0.9, green growth 1.5 and more.',
  ),
  fn(
    'foliarMoisture',
    'fuel',
    1,
    0.3,
    4,
    0.05,
    '',
    'Foliar moisture of the tree crowns, a fraction of dry weight (Van Wagner 1977): 1 is 100 percent, 0.8 late-summer drought (crowns catch from a weaker surface fire), 1.3 new growth.',
  ),
  followsWeather(
    fn('wind.x', 'wind', 0, -100, 100, 0.1, 'm/s', 'Wind 10 m up, east-west; null follows the weather.'),
    'wind',
  ) as FireSetting,
  followsWeather(
    fn('wind.z', 'wind', 0, -100, 100, 0.1, 'm/s', 'Wind 10 m up, north-south; null follows the weather.'),
    'wind',
  ) as FireSetting,
  fn(
    'windReduction',
    'wind',
    0.4,
    0,
    1,
    0.01,
    '',
    'Midflame wind as a fraction of the 10 m wind (Albini and Baughman 1979): 0.4 under a canopy, 0.6 in open brush, 1 in open grass.',
  ),
  fn(
    'spotting',
    'embers',
    0.02,
    0,
    100,
    0.001,
    '1/s',
    'Embers a second from each 64 m2 of burning ground (an 8 m cell) per 1,000 kW/m of fireline intensity over 1,000, whatever the cell size. 0 turns spotting off.',
  ),
  fn(
    'spotSpread',
    'embers',
    0.7,
    0,
    3,
    0.01,
    '',
    'Spread of the landing distance (lognormal sigma): larger throws more embers far and near.',
  ),
  fn(
    'emberIgnition',
    'embers',
    0.3,
    0,
    1,
    0.01,
    '',
    'Chance an ember that lands on dry fuel starts a fire (scaled by how far the fuel is from its moisture of extinction).',
  ),
  fn(
    'smokeYield',
    'smoke',
    15,
    0,
    1000,
    0.5,
    'g/kg',
    'Fine smoke (PM2.5) a kilogram of fuel gives: 15 is the extratropical forest value of Akagi et al. 2011 (it varies by 7.5). A WeatherDrive raises the weather smoke from it.',
  ),
  fn(
    'structureExposure',
    'structures',
    90,
    1,
    86400,
    1,
    's',
    'Seconds of flame within 1.5 flame lengths before a building ignites (Cohen and Butler 1998).',
  ),
  fn('structureBurnTime', 'structures', 1800, 1, 86400, 1, 's', 'Seconds a building burns once alight.'),
];
/** The fire rows that may change every step (all of them). */
export const FIRE_LIVE_SETTINGS: readonly FireSetting[] = liveSettings(FIRE_SETTINGS) as FireSetting[];
const FIRE_BY_NAME = settingIndex(FIRE_SETTINGS) as Map<string, FireSetting>;

/** Every fire setting at its default, as a fresh object to edit. */
export function fireSettingDefaults(): Record<string, VfxSettingValue> {
  return settingDefaults(FIRE_SETTINGS) as Record<string, VfxSettingValue>;
}

/** Named fire looks: only values of the rows. */
export const FIRE_LOOKS: Readonly<Record<string, VfxSettingValues>> = {
  /** A mild day: damp fuel, no spotting. */
  mild: { moisture: 0.12, liveMoisture: 1.4, spotting: 0 },
  /** A red-flag day in chaparral: 4 percent dead fuel, brittle live fuel, embers carried far. */
  redFlag: { moisture: 0.04, liveMoisture: 0.7, spotting: 0.04, windReduction: 0.5 },
  /** A Santa Ana wind: dry fuel, a 15 m/s wind from the north east and heavy spotting. */
  santaAna: { moisture: 0.03, liveMoisture: 0.6, 'wind.x': -10.6, 'wind.z': 10.6, spotting: 0.06, windReduction: 0.5 },
};

/**
 * Writes `values` onto a `FireFront` (a name left out takes its default), so it shows exactly that state. Both wind
 * rows null leave the wind unset, which `WeatherDrive` then fills; either one given sets the 10 m wind `[x, z]`.
 * @throws TypeError for a name not in {@link FIRE_SETTINGS}; RangeError for a value outside its row's range.
 * @example applyFireSettings(front, FIRE_LOOKS.santaAna);
 */
export function applyFireSettings(target: VfxSettingTarget, values: VfxSettingValues = {}): void {
  checkSettings(FIRE_BY_NAME, values, 'vfx', 'FIRE_SETTINGS in @margoengine/vfx/settings');
  const value = (name: string): unknown => (name in values ? values[name] : FIRE_BY_NAME.get(name)!.default),
    o = target.options as Record<string, unknown>;
  for (const row of FIRE_SETTINGS) if (!row.name.includes('.')) o[row.name] = value(row.name);
  // A moisture row at null leaves the option unset (0.06 and +0.01, +0.02 with no weather), which a WeatherDrive fills.
  for (const key of ['moisture', 'moisture10', 'moisture100']) {
    if (o[key] === null) delete o[key];
    holdFromWeather(o, key, o[key] !== undefined);
  }
  const wx = value('wind.x') as number | null,
    wz = value('wind.z') as number | null;
  if (wx === null && wz === null) delete o.wind;
  else o.wind = [wx ?? 0, wz ?? 0];
  holdFromWeather(o, 'wind', wx !== null || wz !== null);
}

/** The values a fire front shows now, as a panel's starting state (a wind that is a sampler reads as null). */
export function fireSettingValues(target: VfxSettingTarget): Record<string, VfxSettingValue> {
  const o = target.options as Record<string, unknown>,
    v = fireSettingDefaults();
  for (const row of FIRE_SETTINGS)
    if (!row.name.includes('.') && typeof o[row.name] === 'number') v[row.name] = o[row.name] as number;
  if (Array.isArray(o.wind)) {
    v['wind.x'] = o.wind[0];
    v['wind.z'] = o.wind[1];
  }
  return v;
}

// ---- Hearth and wildfire flames (`Fire` from `@margoengine/vfx/fire`) ----
//
// The look of a fire's flames and embers as rows, KB-LOOK-VFX-FIRE1. A `Fire` is built from its kit's data (the hearth), so
// every row is a multiplier of what the kit gave (1 is the kit as it is) or an amount (0 leaves the kit's colour curve),
// and a value at its default restores the kit's own number. Flames are alpha-over billboards that fade soft against the
// logs (the `depth` option), so a fire reads as one lit soft volume, not as additive sprites that sum to white: the
// radiance rows lower or raise the brightest colour they can show, and the ramp row pulls the colour curve from the core
// (born, hot) toward an edge colour (late in life) so the fire has a clear core-to-edge ramp, as the lit volumes of an
// animated feature do (the roadmap's section 3: fire as lit soft volumes in big shapes, a clear ramp, no blowout, fewer
// larger embers). A `FireFront` takes the flame rows on its flame volumes and the smoke look (`SMOKE_LOOKS`, through
// `applySmokeSettings`) on its smoke columns.

/** The panel a flame setting sits in. */
export type FlameSettingGroup = 'flames' | 'embers';
/** One flame control: the shared row shape. */
export interface FlameSetting extends SettingRow {
  readonly name: string;
  readonly group: FlameSettingGroup;
  readonly kind: 'number' | 'color';
  readonly default: VfxSettingValue;
}
const fl = (
  name: string,
  group: FlameSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): FlameSetting => numberSetting(name, group, value, min, max, step, unit, about, true) as FlameSetting;

/** Every flame control, in panel order. Defaults leave the fire as its kit built it. */
export const FLAME_SETTINGS: readonly FlameSetting[] = [
  fl(
    'flames.size',
    'flames',
    1,
    0.1,
    8,
    0.01,
    'x',
    "Flame billboard size as a multiple of the kit's: larger flames read as big soft shapes.",
  ),
  fl(
    'flames.radiance',
    'flames',
    1,
    0,
    4,
    0.01,
    'x',
    "Brightness of the flames as a multiple of the kit's; under 1 keeps the core from blowing out to white.",
  ),
  fl('flames.opacity', 'flames', 1, 0, 1, 0.01, 'x', "Opacity at birth as a multiple of the kit's."),
  fl(
    'flames.ramp',
    'flames',
    0,
    0,
    1,
    0.01,
    '',
    "How far the colour curve is pulled toward the edge colour by the end of a flame's life: 0 keeps the kit's curve, 1 ends at the edge colour (a clear core-to-edge ramp).",
  ),
  colorSetting(
    'flames.edgeColor',
    'flames',
    [0.55, 0.12, 0.04],
    0,
    1,
    'The colour the flame edge ramps to (linear RGB), used while flames.ramp is above 0.',
  ) as FlameSetting,
  fl(
    'flames.core',
    'flames',
    2200,
    1200,
    3000,
    10,
    'K',
    'Temperature of the hot core (its blackbody colour, through the camera shoulder, sets the yellow-white of the core). At 2200 a hearth keeps its own colours.',
  ),
  fl(
    'flames.edge',
    'flames',
    1000,
    600,
    2000,
    10,
    'K',
    'Temperature of the cool edge and the tips (deep orange to red). At 1000 a hearth keeps its own colours.',
  ),
  fl(
    'flames.peak',
    'flames',
    1,
    0.05,
    16,
    0.01,
    '',
    'The brightest channel a flame pixel may show, scene-linear: 1 is display white on an 8-bit target; raise it under a tonemap so the core blooms.',
  ),
  fl(
    'flames.flicker',
    'flames',
    1,
    0,
    3,
    0.01,
    'x',
    'Puffing of the flames and flicker of their light as a multiple of the physical (Cetegen and Ahmed 1993); 0 holds them steady.',
  ),
  fl(
    'flames.tongues',
    'flames',
    1,
    0.25,
    4,
    0.01,
    'x',
    'Size of the flame tongues as a multiple of the default (0.22 of the flame length across): smaller is busier.',
  ),
  fl(
    'flames.glow',
    'flames',
    1,
    0,
    8,
    0.01,
    'x',
    'Light a flame volume throws into the smoky air and onto the ground around it, as a multiple of the physical (Sun et al. 2005); 0 turns it off. Hearth flames have none.',
  ),
  fl(
    'flames.haze',
    'flames',
    1,
    0,
    20,
    0.01,
    'x',
    "Haze of the air around a flame volume as a multiple of its own (a Flame 0.0005 per metre, a FireFront's flames 0.003): thicker haze glows more round the fire.",
  ),
  fl(
    'embers.size',
    'embers',
    1,
    0.1,
    8,
    0.01,
    'x',
    "Ember size as a multiple of the kit's: fewer, larger embers read better at a distance.",
  ),
  fl('embers.count', 'embers', 1, 0, 4, 0.01, 'x', "Embers born a second as a multiple of the kit's rate."),
  fl('embers.radiance', 'embers', 1, 0, 4, 0.01, 'x', "Ember brightness as a multiple of the kit's."),
];
/** The flame rows that may change every frame (all of them). */
export const FLAME_LIVE_SETTINGS: readonly FlameSetting[] = liveSettings(FLAME_SETTINGS) as FlameSetting[];
const FLAME_BY_NAME = settingIndex(FLAME_SETTINGS) as Map<string, FlameSetting>;

/** Every flame setting at its default, as a fresh object to edit. */
export function flameSettingDefaults(): Record<string, VfxSettingValue> {
  return settingDefaults(FLAME_SETTINGS) as Record<string, VfxSettingValue>;
}

/** Named flame looks: only values of the rows. */
export const FLAME_LOOKS = {
  /** The kit as it is (every row at its default). */
  natural: {},
  /** The animatedFeature family: larger softer flames, a lower peak radiance, a core-to-edge ramp, fewer larger embers. */
  animatedFeature: {
    'flames.size': 1.5,
    'flames.radiance': 0.75,
    'flames.opacity': 0.85,
    'flames.ramp': 0.6,
    'flames.edgeColor': [0.55, 0.12, 0.04],
    'embers.size': 2.2,
    'embers.count': 0.5,
    'embers.radiance': 0.8,
  },
} as const satisfies Record<string, VfxSettingValues>;

/** What {@link applyFlameSettings} writes to: a `Fire`, or anything with `particles` holding VFX-like targets. */
export interface FlameSettingTarget {
  /** Hearth flames (a `Fire` without `flameLength`) and embers. */
  readonly particles?: { readonly flames?: VfxSettingTarget; readonly embers?: VfxSettingTarget };
  /** A `Fire` with a `flameLength` draws its flames as this volume; the flame rows go to it. */
  readonly flame?: { setFlameLook(values: Readonly<Record<string, unknown>>): unknown };
  /**
   * A target that owns its flame values (a `Flame` of `@margoengine/vfx/flame`, which derives its size and radiance from
   * its length every frame) takes the resolved rows here instead of having its options written.
   */
  setFlameLook?(values: Readonly<Record<string, unknown>>): unknown;
}
// What each effect was built with, taken the first time it is written, so a row at its default gives it back.
interface FlameBase {
  size: number | undefined;
  intensity: number | undefined;
  rate: number | undefined;
  turbulence: number | undefined;
  frequency: number | undefined;
  color: number[] | undefined;
  stops: { at: number; color: [number, number, number] }[] | undefined;
}
const flameBases = new WeakMap<object, FlameBase>();
function baseOf(o: Record<string, unknown>): FlameBase {
  let base = flameBases.get(o);
  if (!base) {
    const curves = o.curves as { color?: { at: number; color: readonly number[] }[] } | undefined;
    base = {
      size: o.size as number | undefined,
      intensity: o.intensity as number | undefined,
      rate: o.rate as number | undefined,
      turbulence: o.turbulence as number | undefined,
      frequency: o.frequency as number | undefined,
      color: Array.isArray(o.color) ? [...(o.color as number[])] : undefined,
      stops: curves?.color?.map((s) => ({ at: s.at, color: [s.color[0], s.color[1], s.color[2]] })),
    };
    flameBases.set(o, base);
  }
  return base;
}
// A numeric option as a multiple of what it was built with; at 1 with nothing built in, the option is left unset.
function scaled(
  o: Record<string, unknown>,
  key: string,
  base: number | undefined,
  factor: number,
  fallback: number,
): void {
  if (factor === 1 && base === undefined) delete o[key];
  else o[key] = (base ?? fallback) * factor;
}

// The flame rows on hearth billboards: size, radiance and opacity scale the kit's numbers; core, edge and peak away from
// their defaults give the billboards the blackbody ramp of `flameRamp` (so a fire changes its ramp after attach);
// flicker scales the turbulence and tongues its scale. Every row at its default gives the kit's own values back.
function applyHearthFlames(flames: VfxSettingTarget, value: (name: string) => unknown): void {
  const ramp = value('flames.ramp') as number,
    edge = value('flames.edgeColor') as readonly [number, number, number],
    alpha = value('flames.opacity') as number,
    fo = flames.options as Record<string, unknown>,
    fb = baseOf(fo),
    core = value('flames.core') as number,
    cool = value('flames.edge') as number,
    peak = value('flames.peak') as number,
    blackbody = core !== 2200 || cool !== 1000 || peak !== 1;
  if (ramp > 0 && !fb.stops)
    throw new TypeError('Flame setting flames.ramp needs flames with a colour curve (curves.color); use 0');
  if (blackbody && !fb.stops)
    throw new TypeError('Flame settings flames.core, edge and peak need flames with a colour curve (curves.color)');
  scaled(fo, 'size', fb.size, value('flames.size') as number, 0.1);
  scaled(fo, 'intensity', fb.intensity, value('flames.radiance') as number, 1);
  scaled(fo, 'turbulence', fb.turbulence, value('flames.flicker') as number, 0);
  scaled(fo, 'frequency', fb.frequency, 1 / (value('flames.tongues') as number), 1);
  if (alpha === 1) {
    if (fb.color) fo.color = [...fb.color];
    else delete fo.color;
  } else {
    const c = fb.color ? [...fb.color] : [1, 1, 1, 1];
    c[3] = (c[3] ?? 1) * alpha;
    fo.color = c;
  }
  if (fb.stops) {
    const curves = fo.curves as { color: { at: number; color: [number, number, number] }[] },
      stops = blackbody ? flameRamp({ core: Math.max(core, cool + 1), edge: cool, peak }) : undefined;
    curves.color = fb.stops.map((s, k) => {
      const at = stops ? stops[Math.min(k, stops.length - 1)]!.at : s.at,
        from = stops ? stops[Math.min(k, stops.length - 1)]!.color : s.color;
      return { at, color: from.map((v, i) => v + (edge[i] - v) * ramp * at) as [number, number, number] };
    });
  }
}

/**
 * Writes `values` onto a fire's flames and embers (a name left out takes its default, which gives the kit's own number
 * back), so it shows exactly that state. Every write is a number into an option the effect reads each frame, so it can
 * run every frame of a shot; nothing is created.
 * @throws TypeError for a name not in {@link FLAME_SETTINGS}, or `flames.ramp` above 0 on flames with no colour curve;
 * RangeError for a value outside its row's range or kind.
 * @example applyFlameSettings(fire, FLAME_LOOKS.animatedFeature);
 */
export function applyFlameSettings(target: FlameSettingTarget, values: VfxSettingValues = {}): void {
  checkSettings(FLAME_BY_NAME, values, 'vfx', 'FLAME_SETTINGS in @margoengine/vfx/settings');
  const value = (name: string): unknown => (name in values ? values[name] : FLAME_BY_NAME.get(name)!.default);
  const volume = typeof target.setFlameLook === 'function' ? target : target.flame;
  if (volume) volume.setFlameLook!(Object.fromEntries(FLAME_SETTINGS.map((row) => [row.name, value(row.name)])));
  const flames = volume ? undefined : target.particles?.flames;
  if (flames) applyHearthFlames(flames, value);
  const embers = target.particles?.embers;
  if (embers) {
    const eo = embers.options as Record<string, unknown>,
      eb = baseOf(eo),
      capacity = typeof eo.capacity === 'number' ? eo.capacity : 1000;
    scaled(eo, 'size', eb.size, value('embers.size') as number, 0.1);
    scaled(eo, 'intensity', eb.intensity, value('embers.radiance') as number, 1);
    scaled(eo, 'rate', eb.rate, value('embers.count') as number, capacity / 2);
  }
}

// ---- Gunfire (`Battery` and `HullFire` from `@margoengine/vfx/gunfire`) ----
//
// A battery's and a burning hull's live controls in the shared row shape. Each row name is the option it writes (the
// battery and the hull read every one each frame, so all are live and can be keyed over a shot; a battery's air rows
// take effect at the next shot, whose puff law they set). The wind rows are `nullable` with `weather: 'wind'`: at null
// the battery or hull follows the weather (`WeatherDrive` writes its wind on their particles); a number overrides it.
// Not rows: the guns, the shots, the ship, the targets, the ports, the masts, the mask, the pool sizes (`banks`, `puffs`, `flames`, `columns`) and the
// lights (what a scene builds the battery from, read at attach).

/** The panel a gunfire setting sits in. */
export type GunfireSettingGroup = 'flash' | 'smoke' | 'air' | 'wind' | 'fire' | 'hits';
/** One gunfire or hull fire control: the shared row shape. */
export interface GunfireSetting extends SettingRow {
  readonly name: string;
  readonly group: GunfireSettingGroup;
  readonly kind: 'number' | 'color';
  readonly default: number | readonly [number, number, number] | null;
}
const gn = (
  name: string,
  group: GunfireSettingGroup,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
): GunfireSetting => numberSetting(name, group, value, min, max, step, unit, about) as GunfireSetting;
const windRows = (who: string): GunfireSetting[] => [
  followsWeather(
    gn('wind.x', 'wind', 0, -100, 100, 0.1, 'm/s', `Wind east-west on the ${who}; null follows the weather.`),
    'wind',
  ) as GunfireSetting,
  followsWeather(
    gn('wind.z', 'wind', 0, -100, 100, 0.1, 'm/s', `Wind north-south on the ${who}; null follows the weather.`),
    'wind',
  ) as GunfireSetting,
];

/** The battery's rows (all live). */
export const GUNFIRE_SETTINGS: readonly GunfireSetting[] = [
  gn(
    'flashSize',
    'flash',
    1,
    0,
    10,
    0.01,
    '',
    'Flash size, a multiple of the fireball of the gas of the charge at its explosion temperature (Noble and Abel 1875).',
  ),
  gn(
    'flashRadiance',
    'flash',
    40,
    0,
    3000,
    0.1,
    '',
    'Peak radiance of the flash (HDR); averaged over the shutter, so a flash shorter than a frame still shows.',
  ),
  gn(
    'flashDuration',
    'flash',
    0.04,
    0.001,
    1,
    0.001,
    's',
    'Fade time of the secondary flash: tens of milliseconds for large guns (Klingenberg and Heimerl 1992).',
  ),
  gn(
    'flashLight',
    'flash',
    1,
    0,
    100,
    0.01,
    '',
    'The light of the flash on the scene, a multiple of a sphere light as bright as the flash.',
  ),
  gn(
    'shutter',
    'flash',
    0.5,
    0,
    1,
    0.01,
    'frame',
    'Shutter open time as a share of the frame (0.5 a 180 degree shutter).',
  ),
  gn(
    'extinction',
    'smoke',
    3,
    0,
    100,
    0.01,
    'm2/g',
    'Mass extinction of the white salt smoke (56% of the powder burns to solids): how thick a bank looks.',
  ),
  colorSetting(
    'smokeColor',
    'smoke',
    [0.97, 0.95545, 0.9312],
    0,
    1,
    'Colour of the powder smoke, linear RGB (smokeColor(0)).',
  ) as GunfireSetting,
  gn(
    'dispersion',
    'smoke',
    0.5,
    0,
    5,
    0.01,
    '',
    'Richardson constant: how fast the turbulence of the air spreads and thins a bank (Batchelor 1952).',
  ),
  gn('smokeLife', 'smoke', 600, 1, 7200, 1, 's', 'Seconds a bank lives at most.'),
  gn(
    'stability',
    'air',
    1e-4,
    0,
    0.01,
    0.00001,
    '1/s2',
    'Air stability N^2: the warm rise of a bank levels off (from the next shot).',
  ),
  gn(
    'heatFraction',
    'air',
    0.4,
    0,
    1,
    0.01,
    '',
    'Share of the heat of explosion still in the gas at the muzzle: the buoyancy of a bank (from the next shot).',
  ),
  gn(
    'entrainment',
    'air',
    0.25,
    0.05,
    1,
    0.01,
    '',
    'Puff radius over distance travelled (Richards 1965, Scorer 1957): how soon the jet stops (from the next shot).',
  ),
  gn(
    'sparks',
    'flash',
    1,
    0,
    10,
    0.01,
    '',
    'Burning powder grains thrown out with the flash, a multiple of the 2% of the charge that leaves the bore alight.',
  ),
  gn('sparkRadiance', 'flash', 30, 0, 3000, 0.1, '', 'Radiance of a burning grain (HDR).'),
  gn(
    'sparkSize',
    'flash',
    0.3,
    0.01,
    2,
    0.01,
    'm',
    'Drawn width of a burning grain streak: its flame and the halation round it.',
  ),
  gn(
    'grain',
    'flash',
    0.003,
    0.0005,
    0.02,
    0.0001,
    'm',
    'Powder grain size: a grain burns d / (2 x 1 cm/s) and its drag stops it (from the next shot).',
  ),
  gn(
    'splinters',
    'hits',
    1,
    0,
    10,
    0.01,
    '',
    'Splinters a strike on a ship throws, a multiple of the hole timber in hand-sized pieces.',
  ),
  ...windRows('banks'),
];
/** The hull fire's rows (all live). */
export const HULL_FIRE_SETTINGS: readonly GunfireSetting[] = [
  gn('spread', 'fire', 0.03, 0, 10, 0.001, 'm/s', 'How fast the fire runs along the hull.'),
  gn('burnTime', 'fire', 2400, 1, 1e6, 1, 's', 'Seconds a stretch of hull burns at full before it dies down.'),
  gn(
    'deckHeat',
    'fire',
    250000,
    0,
    5e6,
    1000,
    'W/m2',
    'Heat release of the burning deck: the flames stand at the Heskestad height of it.',
  ),
  gn(
    'soot',
    'smoke',
    0.35,
    0,
    1,
    0.01,
    '',
    'Soot share of the smoke (Mulholland and Croarkin 2000): 0 white, 0.35 wood and tar, 1 black.',
  ),
  gn('opacity', 'smoke', 0.7, 0, 1, 0.01, '', 'Opacity of a smoke puff.'),
  gn(
    'charRate',
    'fire',
    0.5,
    0,
    5,
    0.01,
    'mm/min',
    'Char rate of the hull timber under the flames: 0.5 hardwood, 0.65 softwood (EN 1995-1-2).',
  ),
  gn(
    'mastFall',
    'fire',
    600,
    0,
    1e6,
    1,
    's',
    'Seconds after the fire reaches a mast that its burnt stays let it fall.',
  ),
  ...windRows('fire'),
];
const GUNFIRE_BY_NAME = settingIndex(GUNFIRE_SETTINGS) as Map<string, GunfireSetting>,
  HULL_BY_NAME = settingIndex(HULL_FIRE_SETTINGS) as Map<string, GunfireSetting>;
/** The battery rows that may change every frame (all of them). */
export const GUNFIRE_LIVE_SETTINGS: readonly GunfireSetting[] = liveSettings(GUNFIRE_SETTINGS) as GunfireSetting[];
/** The hull fire rows that may change every frame (all of them). */
export const HULL_FIRE_LIVE_SETTINGS: readonly GunfireSetting[] = liveSettings(HULL_FIRE_SETTINGS) as GunfireSetting[];
/** Every battery setting at its default, as a fresh object to edit. */
export function gunfireSettingDefaults(): Record<string, VfxSettingValue> {
  return settingDefaults(GUNFIRE_SETTINGS) as Record<string, VfxSettingValue>;
}
/** Every hull fire setting at its default. */
export function hullFireSettingDefaults(): Record<string, VfxSettingValue> {
  return settingDefaults(HULL_FIRE_SETTINGS) as Record<string, VfxSettingValue>;
}
/** Named looks of a battery, values of {@link GUNFIRE_SETTINGS}. Wind rows left out follow the weather. */
export const GUNFIRE_LOOKS = {
  /** A calm humid day of a fleet action: banks that hang low and thick over the line (the light airs of Trafalgar). */
  trafalgar: { stability: 4e-4, dispersion: 0.3, extinction: 4, smokeLife: 1200 },
  /** A fresh breeze: banks that thin and blow clear within a minute or two. */
  breezy: { stability: 0, dispersion: 1, extinction: 2.5, smokeLife: 300 },
  /** The animatedFeature family: bigger, softer flashes and a creamy bank, little fine detail. */
  animatedFeature: {
    flashSize: 1.4,
    flashRadiance: 60,
    flashDuration: 0.06,
    smokeColor: [0.95, 0.92, 0.86],
    extinction: 3.5,
  },
} as const satisfies Record<string, VfxSettingValues>;
/** Named looks of a burning hull, values of {@link HULL_FIRE_SETTINGS}. */
export const HULL_FIRE_LOOKS = {
  /** Fresh fire in tarred timber and cordage: fast and black. */
  tarred: { spread: 0.08, soot: 0.6, deckHeat: 400000 },
  /** A slow fire smouldering below decks. */
  smouldering: { spread: 0.01, soot: 0.25, deckHeat: 120000, opacity: 0.55 },
  /** The animatedFeature family: one large soft column, dark but not black. */
  animatedFeature: { soot: 0.45, opacity: 0.6 },
} as const satisfies Record<string, VfxSettingValues>;

const applyRows = (
  rows: Map<string, GunfireSetting>,
  list: readonly GunfireSetting[],
  target: VfxSettingTarget,
  values: VfxSettingValues,
  entry: string,
): void => {
  checkSettings(rows, values, 'vfx', `${entry} in @margoengine/vfx/settings`);
  const o = target.options as Record<string, unknown>;
  for (const row of list) {
    if (row.group === 'wind') continue;
    const v = row.name in values ? values[row.name] : row.default;
    o[row.name] = Array.isArray(v) ? [...v] : v;
  }
  const wx = (values['wind.x'] ?? null) as number | null,
    wz = (values['wind.z'] ?? null) as number | null;
  if (wx === null && wz === null) delete o.wind;
  else o.wind = [wx ?? 0, wz ?? 0];
  holdFromWeather(o, 'wind', wx !== null || wz !== null);
};
const valuesOf = (
  list: readonly GunfireSetting[],
  defaults: Record<string, VfxSettingValue>,
  target: VfxSettingTarget,
): Record<string, VfxSettingValue> => {
  const o = target.options as Record<string, unknown>;
  for (const row of list) {
    const v = o[row.name];
    if (row.kind === 'number' && typeof v === 'number') defaults[row.name] = v;
    if (row.kind === 'color' && Array.isArray(v)) defaults[row.name] = [v[0], v[1], v[2]];
  }
  if (Array.isArray(o.wind)) {
    defaults['wind.x'] = o.wind[0];
    defaults['wind.z'] = o.wind[1];
  }
  return defaults;
};
/**
 * Writes `values` onto a `Battery` (a name left out takes its default), so it shows exactly that state. Both wind rows
 * null leave its wind unset (it follows the weather); either one given sets `[x, z]`.
 * @throws TypeError for a name not in {@link GUNFIRE_SETTINGS}; RangeError for a value outside its row's range.
 * @example applyGunfireSettings(battery, GUNFIRE_LOOKS.trafalgar);
 */
export function applyGunfireSettings(target: VfxSettingTarget, values: VfxSettingValues = {}): void {
  applyRows(GUNFIRE_BY_NAME, GUNFIRE_SETTINGS, target, values, 'GUNFIRE_SETTINGS');
}
/** The values a battery shows now, as a panel's starting state. */
export function gunfireSettingValues(target: VfxSettingTarget): Record<string, VfxSettingValue> {
  return valuesOf(GUNFIRE_SETTINGS, gunfireSettingDefaults(), target);
}
/**
 * Writes `values` onto a `HullFire` (a name left out takes its default), with the wind rule of {@link applyGunfireSettings}.
 * @throws TypeError for a name not in {@link HULL_FIRE_SETTINGS}; RangeError for a value outside its row's range.
 */
export function applyHullFireSettings(target: VfxSettingTarget, values: VfxSettingValues = {}): void {
  applyRows(HULL_BY_NAME, HULL_FIRE_SETTINGS, target, values, 'HULL_FIRE_SETTINGS');
}
/** The values a hull fire shows now, as a panel's starting state. */
export function hullFireSettingValues(target: VfxSettingTarget): Record<string, VfxSettingValue> {
  return valuesOf(HULL_FIRE_SETTINGS, hullFireSettingDefaults(), target);
}
