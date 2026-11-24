// The one wind of a weather, in the settings of the things that bend with it: scatter's rooted wind and the creative
// grass field. Plain functions over the `[x, z]` wind at the camera (`windAt`), so any engine and any test can use them.

/** The 10 m wind in m/s at which grass and foliage bend fully (Beaufort 8, a gale starts at 17 m/s): 20. */
export const WIND_BEND_FULL = 20;

/**
 * The share of a full bend (0 to 1) a wind of `speed` m/s gives: (U / 20)^2, because the force of the air on a blade
 * grows with the square of the speed (drag = 1/2 rho Cd A U^2), capped at 1.
 */
export function windBend(speed: number): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0)
    throw new RangeError('windBend needs a finite speed of 0 or more m/s; got ' + String(speed));
  return Math.min(1, (speed / WIND_BEND_FULL) ** 2);
}

/** Scatter's `wind` option `[directionX, directionZ, strength, speed]`: the speed in m/s makes the plants thrash in a storm. */
export type ScatterWindSetting = [number, number, number, number];

/**
 * Scatter's `wind` option for a wind `[x, z]` in m/s: the direction the wind blows toward, `windBend` of its speed as the
 * strength and the speed itself (at most 100 m/s), from which Scatter runs its sway faster past Beaufort 3 (`windClockRate`
 * of `@margoengine/scatter`), so plants thrash in a gale. Dead calm keeps `previous` direction (default `[1, 0]`;
 * scatter needs a nonzero one) at strength and speed 0.
 */
export function scatterWind(wind: readonly [number, number], previous: readonly [number, number] = [1, 0]): ScatterWindSetting {
  const speed = Math.hypot(wind[0], wind[1]);
  if (!(speed > 1e-6)) return [previous[0], previous[1], 0, 0];
  return [wind[0] / speed, wind[1] / speed, windBend(speed), Math.min(100, speed)];
}

/** The wind settings of a creative `GrassField`. */
export interface GrassWindSetting {
  /** Unit direction the blades lean toward, or the previous one in dead calm. */
  windDirection: [number, number];
  /** Bend, 0 to 2: twice `windBend` (the field's default 0.45 is a 9.5 m/s wind). */
  windStrength: number;
  /** How fast the gust noise scrolls, 0.15 per m/s of wind (the field's default 1.2 is 8 m/s). */
  windSpeed: number;
}

/** A grass field's wind settings for a wind `[x, z]` in m/s, as for {@link scatterWind}. */
export function grassWind(wind: readonly [number, number], previous: readonly [number, number] = [1, 0.35]): GrassWindSetting {
  const speed = Math.hypot(wind[0], wind[1]);
  if (!(speed > 1e-6)) return { windDirection: [previous[0], previous[1]], windStrength: 0, windSpeed: 0 };
  return { windDirection: [wind[0] / speed, wind[1] / speed], windStrength: 2 * windBend(speed), windSpeed: Math.min(100, 0.15 * speed) };
}
