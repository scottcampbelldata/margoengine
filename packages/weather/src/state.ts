// The weather state: nine numbers that describe the sky and the air, a table of named presets, and the checks and
// maths that keep a state valid. Presets are authoring defaults for looks that read well in games, not meteorology.

/** The weather at one moment. Every field is a plain number so materials, sky, fog and sound can follow it. */
export interface WeatherState {
  /** Rain intensity, 0 (none) to 1 (downpour). */
  rain: number;
  /** Snowfall intensity, 0 to 1. */
  snow: number;
  /** Hail intensity, 0 to 1. */
  hail: number;
  /** Mean wind speed in metres per second, 0 to 60. */
  wind: number;
  /** How gusty the wind is, 0 (steady) to 1 (strong gusts and shifts). */
  gust: number;
  /** Direction the wind blows toward in radians; 0 is +Z and pi/2 is +X, like lightning azimuth in `@margoengine/sky`. */
  windDirection: number;
  /** Cloud cover, 0 (clear) to 1 (overcast). */
  cloud: number;
  /** Fog thickness, 0 (none) to 1 (very dense). */
  fog: number;
  /** Lightning activity, 0 (none) to 1 (constant). */
  lightning: number;
}

/** Names of the built-in presets. */
export type WeatherPresetName =
  | 'clear'
  | 'partlyCloudy'
  | 'overcast'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'storm'
  | 'thunderstorm'
  | 'hail'
  | 'sleet'
  | 'snow'
  | 'blizzard';

/** Every field of a state, in order, with its allowed range. */
export const STATE_FIELDS: Readonly<Record<keyof WeatherState, readonly [min: number, max: number]>> = {
  rain: [0, 1],
  snow: [0, 1],
  hail: [0, 1],
  wind: [0, 60],
  gust: [0, 1],
  windDirection: [-1000, 1000],
  cloud: [0, 1],
  fog: [0, 1],
  lightning: [0, 1],
};

const KEYS = Object.keys(STATE_FIELDS) as (keyof WeatherState)[];

const preset = (p: Partial<WeatherState>): Readonly<WeatherState> =>
  Object.freeze({
    rain: 0,
    snow: 0,
    hail: 0,
    wind: 2,
    gust: 0.1,
    windDirection: 0,
    cloud: 0,
    fog: 0,
    lightning: 0,
    ...p,
  });

/** The built-in presets. Frozen: copy one (`{...WEATHER_PRESETS.rain, wind: 12}`) to change it. */
export const WEATHER_PRESETS: Readonly<Record<WeatherPresetName, Readonly<WeatherState>>> = Object.freeze({
  clear: preset({ wind: 2, gust: 0.1, cloud: 0.05 }),
  partlyCloudy: preset({ wind: 5, gust: 0.25, cloud: 0.45 }),
  overcast: preset({ wind: 6, gust: 0.2, cloud: 0.9, fog: 0.1 }),
  fog: preset({ wind: 1, gust: 0.05, cloud: 0.7, fog: 0.85 }),
  drizzle: preset({ rain: 0.2, wind: 4, gust: 0.15, cloud: 0.85, fog: 0.15 }),
  rain: preset({ rain: 0.6, wind: 8, gust: 0.35, cloud: 0.95, fog: 0.2 }),
  storm: preset({ rain: 0.95, wind: 18, gust: 0.7, cloud: 1, fog: 0.3 }),
  thunderstorm: preset({ rain: 0.9, wind: 16, gust: 0.8, cloud: 1, fog: 0.25, lightning: 0.9 }),
  hail: preset({ rain: 0.3, hail: 0.8, wind: 14, gust: 0.6, cloud: 1, fog: 0.15, lightning: 0.4 }),
  sleet: preset({ rain: 0.4, snow: 0.4, wind: 7, gust: 0.3, cloud: 0.95, fog: 0.25 }),
  snow: preset({ snow: 0.5, wind: 3, gust: 0.15, cloud: 0.9, fog: 0.2 }),
  blizzard: preset({ snow: 1, wind: 25, gust: 0.8, cloud: 1, fog: 0.6 }),
});

/** True when `name` is one of the built-in presets. */
export const isPresetName = (name: unknown): name is WeatherPresetName =>
  typeof name === 'string' && Object.hasOwn(WEATHER_PRESETS, name);

/**
 * Checks a complete state: every field a finite number inside its range. Throws TypeError for a missing or non-numeric
 * field and RangeError for a value out of range, naming the field and the allowed range.
 */
export function assertState(state: WeatherState, label = 'Weather state'): void {
  if (typeof state !== 'object' || state === null)
    throw new TypeError(`${label} must be an object; pass {rain, snow, ...} or a preset name`);
  for (const key of KEYS) {
    const value = state[key];
    if (typeof value !== 'number') throw new TypeError(`${label}.${key} must be a number; got ${String(value)}`);
    const [min, max] = STATE_FIELDS[key];
    if (!Number.isFinite(value) || value < min || value > max)
      throw new RangeError(`${label}.${key} must be a finite number from ${min} to ${max}; got ${value}`);
  }
}

/**
 * Turns a preset name or a partial state into a complete one: missing fields come from `base` (default `clear`).
 * Throws a TypeError for an unknown preset name and the errors of {@link assertState} for bad values.
 */
export function resolveState(
  input: WeatherPresetName | Partial<WeatherState>,
  base: Readonly<WeatherState> = WEATHER_PRESETS.clear,
): WeatherState {
  if (typeof input === 'string') {
    if (!isPresetName(input))
      throw new TypeError(`Unknown weather preset "${input}"; use one of ${Object.keys(WEATHER_PRESETS).join(', ')}`);
    return { ...WEATHER_PRESETS[input] };
  }
  if (typeof input !== 'object' || input === null)
    throw new TypeError('Weather target must be a preset name or an object such as {rain: 0.5}; pass one of them');
  for (const key of Object.keys(input))
    if (!KEYS.includes(key as keyof WeatherState))
      throw new TypeError(`Unknown weather field "${key}"; use ${KEYS.join(', ')}`);
  const state = { ...base, ...input } as WeatherState;
  assertState(state);
  state.windDirection = wrapAngle(state.windDirection);
  return state;
}

/** An angle in radians turned into the range (-pi, pi]. */
export function wrapAngle(angle: number): number {
  const full = Math.PI * 2,
    r = ((((angle + Math.PI) % full) + full) % full) - Math.PI;
  return r === -Math.PI ? Math.PI : r;
}

/** Easing curves for {@link blend}: linear, or smoothstep (zero speed at both ends, the default). */
export type BlendEase = 'linear' | 'smoothstep';

/**
 * Component-wise blend of two states at `t` (0 gives `a`, 1 gives `b`). Wind direction takes the shortest way round the
 * circle. `t` is clamped to 0..1.
 */
export function blendStates(a: WeatherState, b: WeatherState, t: number, ease: BlendEase = 'smoothstep'): WeatherState {
  const x = Number.isNaN(t) ? 0 : Math.min(1, Math.max(0, t)),
    k = ease === 'linear' ? x : x * x * (3 - 2 * x);
  const out = {} as WeatherState;
  for (const key of KEYS) out[key] = a[key] + (b[key] - a[key]) * k;
  // Shortest arc between the two wind directions.
  const full = Math.PI * 2;
  let turn = (((b.windDirection - a.windDirection) % full) + full) % full;
  if (turn > Math.PI) turn -= full;
  out.windDirection = a.windDirection + turn * k;
  return out;
}
