// @margoengine/weather: a weather state machine with presets and timed blends, a deterministic wind field, ground
// wetness and snow-cover hooks (JavaScript and WGSL) and helpers that drive `@margoengine/sky`'s Weather. The hail
// that draws on a WebGPU engine is in `@margoengine/weather/hail`.
export {
  STATE_FIELDS,
  WEATHER_PRESETS,
  assertState,
  blendStates,
  isPresetName,
  resolveState,
  wrapAngle,
  type BlendEase,
  type WeatherPresetName,
  type WeatherState,
} from './state.js';
export { WindField, valueNoise, type WindOptions } from './wind.js';
export {
  TEMPERATE,
  WeatherMachine,
  type MachineOptions,
  type RandomWalkOptions,
  type ScheduleStep,
  type TransitionOptions,
  type WeatherEvent,
  type WeatherTarget,
} from './machine.js';
export {
  SNOW_COLOR,
  SNOW_ROUGHNESS,
  applyWetness,
  settledGround,
  snowWeight,
  surfaceResponse,
  surfaceWGSL,
  wetColor,
  wetRoughness,
  type SurfaceResponse,
} from './surface.js';
export { fogDensity, hailSettings, skyWeather, windAt, type HailSettings, type SkyWeatherSettings } from './sky-settings.js';
