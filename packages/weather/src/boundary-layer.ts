// Dyer (1974) and Paulson (1970): the integrated Monin-Obukhov surface-layer profile.
// Mann fluctuations use Taylor's hypothesis at the mean speed of their own layer.
import { airDensity, SEA_LEVEL_TEMPERATURE, standardAtmosphere } from '@margoengine/math/atmosphere';
import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import { atan, cos, ln, sin } from '@margoengine/math/pinned';
import { MannBox, type MannBoxOptions } from './turbulence.js';

/** The von Karman constant of the log law. */
export const VON_KARMAN = 0.4;

/** Settings of a {@link BoundaryLayerWind}; each has a default. */
export interface BoundaryLayerWindOptions {
  /** Mean wind speed at `referenceHeight`, m/s (default 10). */
  speed?: number;
  /** The height the speed is given at, m (default 10, the meteorological standard). */
  referenceHeight?: number;
  /** Where the wind blows toward, radians in the ground plane from +x toward +z (default 0: along +x). */
  direction?: number;
  /** Azimuth zero axis. 'cartesian' starts at +x (default). 'heading' starts at +z toward +x. */
  directionConvention?: 'cartesian' | 'heading';
  /** Monin-Obukhov length in metres. Positive is stable, negative unstable, and +Infinity is neutral (default). */
  obukhovLength?: number;
  /** Roughness length z0, m (default 0.0002, open sea; 0.03 short grass, 0.5 to 1 forest and town). */
  roughness?: number;
  /** The ground's height, y metres, that heights are measured from (default 0). */
  ground?: number;
  /** The ground's height above sea level, m, for the standard atmosphere (default 0). */
  altitude?: number;
  /** Sea-level temperature of the standard atmosphere, K (default 288.15). */
  seaLevelTemperature?: number;
  /**
   * The turbulence: a {@link MannBox}, the options of one (its `sigma` defaults to 2.5 u*), or `false` for the mean wind
   * alone (default a box with the IEC 61400-1 shape).
   */
  turbulence?: MannBox | MannBoxOptions | false;
}

/** A resolved boundary-layer profile for sampling on a native world grid. */
export interface BoundaryLayerProfile {
  /** Aerodynamic roughness length in metres. */
  readonly roughness: number;
  /** Signed Monin-Obukhov length in metres. Positive infinity represents neutral air. */
  readonly obukhovLength: number;
  /** Friction velocity divided by the von Karman constant in m/s. */
  readonly meanScale: number;
  /** Unstable momentum correction evaluated at the roughness height. */
  readonly psiAtRoughness: number;
  /** Ground height in the field's origin cell, in metres. */
  readonly ground: number;
  /** Ground altitude above sea level, in metres. */
  readonly altitude: number;
  /** Sea-level temperature in kelvin. */
  readonly seaLevelTemperature: number;
  /** Unit wind direction [x, z] on the world axes. */
  readonly along: readonly [number, number];
  /** Optional precomputed Mann fluctuations in the wind frame. */
  readonly turbulence?: MannBox;
}

function instability(zeta: number): number {
  const q = Math.sqrt(Math.sqrt(1 - 16 * zeta));
  return 2 * ln((1 + q) / 2) + ln((1 + q * q) / 2) - 2 * atan(q) + Math.PI / 2;
}

function potential(h: number, roughness: number, length: number, psiAtRoughness: number): number {
  const ratio = h / roughness;
  const log = Number.isFinite(ratio) ? ln(ratio) : ln(h) - ln(roughness);
  if (length === Infinity) return log;
  if (length > 0) return log + 5 * ((h - roughness) / length);
  return log - instability(h / length) + psiAtRoughness;
}

function ramp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Samples the surface-layer mean, optional finite-height Mann gusts and standard-atmosphere state on the world clock. */
export class BoundaryLayerWind implements Wind {
  readonly medium = 'air' as const;
  readonly cell = [0, 0, 0] as const;
  readonly speed: number;
  readonly referenceHeight: number;
  readonly direction: number;
  readonly roughness: number;
  /** The friction velocity u*, m/s. */
  readonly frictionVelocity: number;
  readonly turbulence: MannBox | undefined;
  /** Resolved profile parameters in world coordinates for a native grid sampler. */
  readonly profile: BoundaryLayerProfile;
  private readonly fluctuation: [number, number, number] = [0, 0, 0];

  /** Sets up a height profile. Invalid settings throw a coded error with a correction. */
  constructor(options: BoundaryLayerWindOptions = {}) {
    if (options === null || typeof options !== 'object')
      throw new MargoError('state', 'Invalid wind options. Pass a boundary-layer options object or omit it.');
    const {
      speed = 10,
      referenceHeight = 10,
      direction = 0,
      directionConvention = 'cartesian',
      obukhovLength = Infinity,
      roughness = 0.0002,
      ground = 0,
      altitude = 0,
      seaLevelTemperature = SEA_LEVEL_TEMPERATURE,
      turbulence = {},
    } = options;
    if (!(speed >= 0 && Number.isFinite(speed)))
      throw new MargoError('state', `A wind speed is 0 or more m/s (got ${speed}); pass a finite speed.`);
    if (!(roughness > 0 && Number.isFinite(roughness)))
      throw new MargoError(
        'state',
        `A roughness length is a finite number of metres above 0 (got ${roughness}); pass a roughness such as 0.03 for open grass.`,
      );
    if (!(referenceHeight > roughness && Number.isFinite(referenceHeight)))
      throw new MargoError(
        'state',
        `The reference height (${referenceHeight} m) is too low. Set it above the roughness length (${roughness} m).`,
      );
    for (const [name, v] of [
      ['direction', direction],
      ['ground', ground],
      ['altitude', altitude],
      ['sea-level temperature', seaLevelTemperature],
    ] as const)
      if (!Number.isFinite(v))
        throw new MargoError('state', `A wind's ${name} is a finite number (got ${v}); pass a finite value.`);
    if (!(seaLevelTemperature > 0.0065 * 11000))
      throw new MargoError(
        'state',
        'Sea-level temperature is too low for a positive tropopause temperature. Use kelvin above 71.5.',
      );
    if (directionConvention !== 'cartesian' && directionConvention !== 'heading')
      throw new MargoError('state', 'Unknown wind direction convention. Choose cartesian or heading.');
    if (!(obukhovLength === Infinity || (Number.isFinite(obukhovLength) && obukhovLength !== 0)))
      throw new MargoError(
        'state',
        'Invalid Monin-Obukhov length. Use signed nonzero metres or positive Infinity for neutral air.',
      );
    this.speed = speed;
    this.referenceHeight = referenceHeight;
    this.direction = direction;
    this.roughness = roughness;
    const psiAtRoughness = obukhovLength < 0 ? instability(roughness / obukhovLength) : 0;
    const heightFactor = potential(referenceHeight, roughness, obukhovLength, psiAtRoughness);
    if (!(heightFactor > 0 && Number.isFinite(heightFactor)))
      throw new MargoError(
        'state',
        'Wind profile exceeds numeric range. Use a representable reference height or stability.',
      );
    this.frictionVelocity = (VON_KARMAN * speed) / heightFactor;
    const meanScale = this.frictionVelocity / VON_KARMAN;
    if (!Number.isFinite(meanScale))
      throw new MargoError(
        'state',
        'Wind friction velocity exceeds numeric range. Reduce the speed or raise the reference height.',
      );
    const along =
      directionConvention === 'heading'
        ? ([sin(direction), cos(direction)] as const)
        : ([cos(direction), sin(direction)] as const);
    try {
      this.turbulence =
        turbulence === false
          ? undefined
          : turbulence instanceof MannBox
            ? turbulence
            : new MannBox({ sigma: 2.5 * this.frictionVelocity, ...turbulence });
    } catch (cause) {
      if (!(cause instanceof TypeError || cause instanceof RangeError)) throw cause;
      throw Object.assign(
        new MargoError(
          'state',
          'Invalid Mann turbulence settings. Choose positive box dimensions and supported cell counts.',
        ),
        { cause },
      );
    }
    this.profile = Object.freeze({
      roughness,
      obukhovLength,
      meanScale,
      psiAtRoughness,
      ground,
      altitude,
      seaLevelTemperature,
      along: Object.freeze(along),
      turbulence: this.turbulence,
    });
  }

  /** Mean wind speed at h metres above the ground. It is zero at or below the roughness height. */
  meanSpeed(h: number): number {
    if (!Number.isFinite(h))
      throw new MargoError('state', 'Invalid wind height. Use a finite height above the ground.');
    const { roughness, obukhovLength, meanScale, psiAtRoughness } = this.profile;
    if (h <= roughness || meanScale === 0) return 0;
    const speed = meanScale * potential(h, roughness, obukhovLength, psiAtRoughness);
    if (!(speed >= 0 && Number.isFinite(speed)))
      throw new MargoError(
        'state',
        'Wind profile exceeds numeric range at this height. Reduce the height or change the stability length.',
      );
    return speed;
  }

  /** The air at (x, y, z) at time `t` seconds: velocity, density and temperature (the {@link Wind} contract). */
  sample(x: number, y: number, z: number, t: number, out?: FlowSample): FlowSample {
    if (![x, y, z, t].every(Number.isFinite))
      throw new MargoError('state', 'Invalid wind sample coordinates or time. Use finite local metres and seconds.');
    const {
      ground,
      altitude,
      seaLevelTemperature,
      along: [ax, az],
      turbulence,
    } = this.profile;
    const h = y - ground;
    const mean = this.meanSpeed(h);
    let fu = 0;
    let fv = 0;
    let fw = 0;
    if (turbulence && h > this.roughness && h < turbulence.size[2]) {
      const s = x * ax + z * az - mean * t;
      const c = -x * az + z * ax;
      if (!Number.isFinite(s) || !Number.isFinite(c))
        throw new MargoError(
          'state',
          'Wind advection is outside numeric range. Use a local origin and a shorter time.',
        );
      const top = turbulence.size[2];
      const step = top / turbulence.cells[2];
      const weight = ramp((h - this.roughness) / step) * ramp((top - h) / step);
      [fu, fv, fw] = turbulence.sample(s, c, Math.min(h, top - step), this.fluctuation);
      fu *= weight;
      fv *= weight;
      fw *= weight;
    }
    const u = mean + fu;
    const vx = u * ax - fv * az;
    const vz = u * az + fv * ax;
    const elevation = altitude + h;
    if (!Number.isFinite(elevation))
      throw new MargoError(
        'state',
        'Wind altitude exceeds numeric range. Use a representable altitude and local height.',
      );
    const [temperature, pressure] = standardAtmosphere(elevation, seaLevelTemperature);
    const density = airDensity(temperature, pressure);
    if (
      !(
        Number.isFinite(vx) &&
        Number.isFinite(fw) &&
        Number.isFinite(vz) &&
        temperature > 0 &&
        Number.isFinite(temperature) &&
        density >= 0 &&
        Number.isFinite(density)
      )
    )
      throw new MargoError(
        'state',
        'Wind sample exceeds numeric range. Use a smaller local extent, speed or altitude.',
      );
    const sample = out ?? { velocity: [0, 0, 0], density: 0, temperature: 0 };
    sample.velocity[0] = vx;
    sample.velocity[1] = fw;
    sample.velocity[2] = vz;
    sample.temperature = temperature;
    sample.density = density;
    return sample;
  }
}
