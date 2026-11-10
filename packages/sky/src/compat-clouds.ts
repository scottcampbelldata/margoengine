/**
 * Clouds and weather for the full WebGL2 compatibility layer and native WebGPU.
 * Install `@margoengine/webgl2-compat` before creating an engine on browsers without WebGPU, then attach these
 * plugins as usual. They share the original implementations, options, depth handling and resource lifecycle.
 * Importing this entry does not install the layer or change browser globals. The small WebGL2 preview is unsupported.
 */
export { VolumetricClouds } from './volumetric-clouds.js';
export type { VolumetricCloudOptions, VolumetricCloudSky } from './volumetric-clouds.js';
export { Weather, lightningFlash, speedOfSound, thunderDelay } from './weather.js';
export type {
  LightningStrike,
  StrikeOptions,
  WeatherLightningOptions,
  WeatherOcclusion,
  WeatherOptions,
} from './weather.js';
export { WeatherFX } from './weather-fx.js';
export type { OccluderPrimitive, RainOccluder, WeatherFxOptions, WeatherFxSource } from './weather-fx.js';
