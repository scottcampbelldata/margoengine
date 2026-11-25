// The wind of the physics framework (ATMO-01 and ATMO-02 of docs/physics-solvers.md): a neutral atmospheric boundary layer
// with the log-law mean profile and Mann turbulence carried along by the mean wind, as one `Wind` of
// `@margoengine/math/fields` that every solver samples at its own place and time on the world clock (docs/physics-framework.md,
// section 4). Density and temperature come from the standard atmosphere (`@margoengine/math/atmosphere`).
//
// Mean wind: U(h) = (u* / kappa) ln(h / z0) at height h above the ground over roughness z0, with the friction velocity u*
// from the speed given at a reference height and kappa = 0.40 (the logarithmic law of the wall in the neutral surface layer;
// R. B. Stull, "An Introduction to Boundary Layer Meteorology", Kluwer, 1988, section 9.7; H. Tennekes and J. L. Lumley, "A
// First Course in Turbulence", MIT Press, 1972, section 5.2). Below z0 the air is still.
// Turbulence: a {@link MannBox} whose along-wind standard deviation is 2.5 u* (neutral surface layer, Stull 1988, section
// 9.7; J. C. Kaimal and J. J. Finnigan, "Atmospheric Boundary Layer Flows", Oxford, 1994, chapter 1) unless given, advected
// at the reference speed (Taylor's frozen-turbulence hypothesis, G. I. Taylor, "The spectrum of turbulence", Proceedings of
// the Royal Society A 164, 1938), so a gust that reaches a sail reaches the tree downwind of it the right time later.
//
// Accepted differences: neutral stability only (no Monin-Obukhov stability functions yet), flat terrain (no speed-up over
// hills or shelter behind them), one roughness; the turbulence keeps its standard deviation at every height above z0.

import { airDensity, SEA_LEVEL_TEMPERATURE, standardAtmosphere } from '@margoengine/math/atmosphere';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import { cos, ln, sin } from '@margoengine/math/pinned';
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

/** A neutral atmospheric boundary layer: log-law mean wind plus Mann turbulence, sampled anywhere on the world clock. */
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
  private readonly ground: number;
  private readonly altitude: number;
  private readonly seaLevel: number;
  private readonly along: readonly [number, number];
  private readonly fluctuation: [number, number, number] = [0, 0, 0];

  /** @throws RangeError for a speed, height or roughness that is not finite and positive, or a reference height at or below the roughness. */
  constructor(options: BoundaryLayerWindOptions = {}) {
    const {
      speed = 10,
      referenceHeight = 10,
      direction = 0,
      roughness = 0.0002,
      ground = 0,
      altitude = 0,
      seaLevelTemperature = SEA_LEVEL_TEMPERATURE,
      turbulence = {},
    } = options;
    if (!(speed >= 0 && Number.isFinite(speed)))
      throw new RangeError(`A wind speed is 0 or more m/s (got ${speed}); pass a finite speed.`);
    if (!(roughness > 0 && Number.isFinite(roughness)))
      throw new RangeError(
        `A roughness length is a finite number of metres above 0 (got ${roughness}); pass a roughness such as 0.03 for open grass.`,
      );
    if (!(referenceHeight > roughness && Number.isFinite(referenceHeight)))
      throw new RangeError(
        `The reference height (${referenceHeight} m) must be above the roughness length (${roughness} m).`,
      );
    for (const [name, v] of [
      ['direction', direction],
      ['ground', ground],
      ['altitude', altitude],
    ] as const)
      if (!Number.isFinite(v))
        throw new RangeError(`A wind's ${name} is a finite number (got ${v}); pass a finite value.`);
    this.speed = speed;
    this.referenceHeight = referenceHeight;
    this.direction = direction;
    this.roughness = roughness;
    this.ground = ground;
    this.altitude = altitude;
    this.seaLevel = seaLevelTemperature;
    this.frictionVelocity = (VON_KARMAN * speed) / ln(referenceHeight / roughness);
    this.along = [cos(direction), sin(direction)];
    this.turbulence =
      turbulence === false
        ? undefined
        : turbulence instanceof MannBox
          ? turbulence
          : new MannBox({ sigma: 2.5 * this.frictionVelocity, ...turbulence });
  }

  /** The mean wind speed at `h` metres above the ground: (u* / kappa) ln(h / z0), and 0 at or below z0. */
  meanSpeed(h: number): number {
    return h > this.roughness ? (this.frictionVelocity / VON_KARMAN) * ln(h / this.roughness) : 0;
  }

  /** The air at (x, y, z) at time `t` seconds: velocity, density and temperature (the {@link Wind} contract). */
  sample(x: number, y: number, z: number, t: number, out?: FlowSample): FlowSample {
    const sample = out ?? { velocity: [0, 0, 0], density: 0, temperature: 0 },
      h = y - this.ground,
      [ax, az] = this.along,
      mean = this.meanSpeed(h);
    let fu = 0,
      fv = 0,
      fw = 0;
    if (this.turbulence && h > this.roughness) {
      // Into the wind's frame, then back along the wind by the distance the frozen field has travelled.
      const s = x * ax + z * az - this.speed * t,
        c = -x * az + z * ax;
      [fu, fv, fw] = this.turbulence.sample(s, c, h, this.fluctuation);
    }
    const u = mean + fu;
    sample.velocity[0] = u * ax - fv * az;
    sample.velocity[1] = fw;
    sample.velocity[2] = u * az + fv * ax;
    const [temperature, pressure] = standardAtmosphere(this.altitude + h, this.seaLevel);
    sample.temperature = temperature;
    sample.density = airDensity(temperature, pressure);
    return sample;
  }
}
