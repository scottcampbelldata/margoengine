// Turning a weather state into the settings of the pieces that draw and sound it: `@margoengine/sky`'s Weather (rain,
// snow, lightning), this package's Hail, and a fog density. Plain functions over plain objects, so they work with any
// engine and are easy to test.
import type { WeatherState } from './state.js';
import type { WindField } from './wind.js';

/** The part of `@margoengine/sky`'s `WeatherOptions` that a state decides. */
export interface SkyWeatherSettings {
  /** Rain or snow, `'sleet'` while both fall, or `'none'`. */
  precipitation: 'rain' | 'snow' | 'sleet' | 'none';
  /** Intensity of that precipitation, 0..1: for sleet, rain and snow together. */
  intensity: number;
  /** Share of the precipitation that is snow, 0..1: what the sky Weather draws as snow in sleet. */
  snowShare: number;
  /** Always 0: the machine already blends, so the sky's own easing is switched off. */
  fadeSeconds: number;
  /** Horizontal wind `[x, z]` in metres per second. */
  wind: [number, number];
  /** Lightning settings, or `undefined` when the state has no lightning (assign it to remove storms). */
  lightning: { rate: number; threshold: number } | undefined;
}

/**
 * Settings for `@margoengine/sky`'s Weather from a state: assign them with `Object.assign(weather.options, skyWeather(state))`.
 * While rain and snow both fall (a rain-to-snow blend, or the sleet preset) it is `'sleet'`: the sky Weather draws each
 * kind with its own share, so the rain thins as the snow thickens. `wind` is the horizontal wind at the camera from `field`, or the state's mean
 * wind when no field is given. Lightning needs `state.lightning` above 0; its rate is up to 12 strikes a minute.
 */
export function skyWeather(state: WeatherState, wind?: readonly [number, number]): SkyWeatherSettings {
  const heavier = state.snow > state.rain ? 'snow' : 'rain',
    both = state.rain > 0.001 && state.snow > 0.001,
    total = state.rain + state.snow,
    amount = both ? Math.min(1, total) : Math.max(state.rain, state.snow);
  const w: [number, number] = wind
    ? [wind[0], wind[1]]
    : [Math.sin(state.windDirection) * state.wind, Math.cos(state.windDirection) * state.wind];
  return {
    precipitation: amount > 0.001 ? (both ? 'sleet' : heavier) : 'none',
    intensity: amount,
    snowShare: total > 0 ? state.snow / total : 0,
    fadeSeconds: 0,
    wind: w,
    // The storm threshold is set to 0 so any intensity can produce lightning; the state's activity sets the rate.
    lightning: state.lightning > 0.001 && state.rain > 0.05 ? { rate: 12 * state.lightning, threshold: 0 } : undefined,
  };
}

/** The part of {@link HailOptions} that a state decides. */
export interface HailSettings {
  /** Hail intensity, 0..1. */
  intensity: number;
  /** Horizontal wind `[x, z]` in metres per second. */
  wind: [number, number];
}

/** Settings for a Hail from a state; `wind` as for {@link skyWeather}. */
export function hailSettings(state: WeatherState, wind?: readonly [number, number]): HailSettings {
  return { intensity: state.hail, wind: skyWeather(state, wind).wind };
}

/**
 * Fog density (per metre) for a state, for `@margoengine/sky`'s fog or any exponential fog: from 0.0002 (clear, visible to
 * about 10 km) at fog 0 to 0.02 (visible to about 150 m) at fog 1, interpolated in log space so each step of `fog` feels
 * like the same change. Rain and snow thicken it a little.
 */
export function fogDensity(state: WeatherState): number {
  const thickness = Math.min(1, state.fog + 0.15 * Math.max(state.rain, state.snow, state.hail));
  return 0.0002 * (0.02 / 0.0002) ** thickness;
}

/** Horizontal wind `[x, z]` at world position `(x, z)` and time `t` from a field, for {@link skyWeather}. */
export function windAt(field: WindField, x: number, y: number, z: number, t: number): [number, number] {
  const v = field.sample(x, y, z, t);
  return [v[0], v[2]];
}
