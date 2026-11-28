import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { exp, hypot, pow } from '@margoengine/math/pinned';
import type { SynopticWeather } from '@margoengine/physics/synoptic';
import { RAIN_RATE_AT_FULL } from './air.js';
import type { DriveSource } from './drive.js';
import { snowFraction } from './precipitation.js';
import { type WeatherState, WEATHER_PRESETS } from './state.js';

/** Rendering conversions for an observer in the synoptic solver's world cell. */
export interface SynopticDriveOptions {
  /** Effective cloud droplet radius in metres. Default 10 μm. */
  readonly dropletRadius?: number;
  /** Moisture scale height for relative humidity in metres. Default 2400. */
  readonly moistureHeight?: number;
}

const unit = (value: number) => Math.min(1, Math.max(0, value));

/** A WeatherDrive state source using the present physics frame. The caller advances the PhysicsWorld. */
export function synopticDrive(
  weather: SynopticWeather,
  position: () => Vec3,
  options: SynopticDriveOptions = {},
): DriveSource {
  const radius = options.dropletRadius ?? 1e-5;
  const scale = options.moistureHeight ?? 2400;
  if (!(radius > 0 && scale > 0 && Number.isFinite(radius) && Number.isFinite(scale)))
    throw new MargoError(
      'state',
      'Use finite positive cloud radii and moisture heights in metres. See https://margoengine.com/errors#synoptic',
    );
  return {
    get state(): WeatherState {
      const [x, y, z] = position();
      const cell = weather.sample(x, z);
      const air = weather.wind.sample(x, y, z, 0);
      const temperature = air.temperature;
      const snow = snowFraction(temperature);
      const rainRate = cell.precipitation * 3600;
      const saturationPressure = 611.2 * exp((2.5e6 / 461.5) * (1 / 273.15 - 1 / temperature));
      const saturation = (scale * saturationPressure) / (461.5 * temperature);
      // Extinction area per liquid mass for large spherical droplets, Qext = 2.
      const cloud = 1 - exp((-3 * cell.cloud) / (2 * 1000 * radius));
      return {
        ...WEATHER_PRESETS.clear,
        gust: 0,
        cloud: unit(cloud),
        humidity: unit(cell.vapour / saturation),
        rain: pow(unit((rainRate * (1 - snow)) / RAIN_RATE_AT_FULL), 1 / 3),
        snow: pow(unit((rainRate * snow) / RAIN_RATE_AT_FULL), 1 / 3),
        temperature: Math.min(60, Math.max(-80, temperature - 273.15)),
        wind: Math.min(60, hypot(cell.wind[0], cell.wind[1])),
        windDirection: Math.atan2(cell.wind[0], cell.wind[1]),
      };
    },
  };
}
