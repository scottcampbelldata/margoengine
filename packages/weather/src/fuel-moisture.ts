// Dead fuel moisture from the weather: the equilibrium moisture of dead wood in the air of a state, and the 1, 10 and
// 100 hour timelag fuels that move toward it, wet in the rain and dry after it. A fire front (`FireFront` from
// `@margoengine/vfx/fire-front`) reads them as its dead fuel moisture through `WeatherDrive`. Sources (reports, read as
// text; no code):
// - J. D. Cohen and J. E. Deeming, "The National Fire-Danger Rating System: basic equations", USDA Forest Service General
//   Technical Report PSW-82, 1985, https://research.fs.usda.gov/treesearch/27298: Simard's (1968) regressions of the
//   equilibrium moisture content of wood on temperature (F) and relative humidity (percent) in three humidity bands
//   (equations 1a to 1c); the fuel-level temperature and humidity under sun (state of weather 0 to 3: add 25, 19, 12
//   or 5 F, multiply the humidity by 0.75, 0.83, 0.92 or 1); a 1-hour fuel moisture of 35 percent while it rains; the
//   100-hour boundary condition 0.5 d + 41 percent for d hours of rain.
// - L. S. Bradshaw, J. E. Deeming, R. E. Burgan and J. D. Cohen, "The 1978 National Fire-Danger Rating System: technical
//   documentation", USDA Forest Service General Technical Report INT-169, 1983, https://www.fs.usda.gov/rm/pubs_int/int_gtr169.pdf:
//   the sky cover of each state of weather (0 to 0.1 clear, 0.1 to 0.5 scattered, 0.6 to 0.9 broken, 0.9 to 1
//   overcast, table 6) and Fosberg's timelag response mc = mc0 + (EMC - mc0)(1 - exp(-t / tau)) (equation 25).
// - M. A. Fosberg and J. E. Deeming, "Derivation of the 1- and 10-hour timelag fuel moisture calculations for
//   fire-danger rating", USDA Forest Service Research Note RM-207, 1971: the timelag classes, tau of 1, 10 and 100 hours.
// - A. J. Simard, "The moisture content of forest fuels I: a review of the basic concepts", Canadian Department of
//   Forestry and Rural Development, Forest Fire Research Institute Information Report FF-X-14, 1968: the regressions.
// Chosen here, not from the reports: the 10-hour class wets toward the 35 percent of the 1-hour class (the reports set it
// from fuel sticks or a day's boundary); rain is falling when the state's `rain` is above 0; the sun correction applies in
// daylight only (a drive with a sky reads its sun; without one it is day).
import type { WeatherState } from './state.js';

/** The dead fuel moisture of the three timelag classes, each a fraction of dry weight (0.08 is 8 percent). */
export interface DeadFuelMoisture {
  /** 1-hour timelag fuel (under a quarter inch: grass, needles, twigs). */
  moisture: number;
  /** 10-hour timelag fuel (a quarter to one inch). */
  moisture10: number;
  /** 100-hour timelag fuel (one to three inches). */
  moisture100: number;
}

/** Moisture of the 1 and 10 hour fuels while rain falls, a fraction (Cohen and Deeming 1985: MC1 = 35 percent). */
export const RAIN_FUEL_MOISTURE = 0.35;
/** Timelags of the three dead classes, hours (Fosberg and Deeming 1971). */
export const FUEL_TIMELAGS: readonly [number, number, number] = [1, 10, 100];

/**
 * The equilibrium moisture content of dead wood, a fraction of dry weight, in air of relative humidity `humidity` (0 to
 * 1) at `temperature` degrees Celsius: Simard's (1968) regressions as the NFDRS gives them (Cohen and Deeming 1985,
 * equations 1a to 1c). 0.25 is near saturated air, 0.03 to 0.05 a hot dry afternoon.
 * @example equilibriumMoisture(0.3, 30) // 0.0576
 */
export function equilibriumMoisture(humidity: number, temperature: number): number {
  const h = Math.min(100, Math.max(0, humidity * 100)),
    t = (temperature * 9) / 5 + 32,
    emc =
      h < 10
        ? 0.03229 + 0.281073 * h - 0.000578 * t * h
        : h < 50
          ? 2.22749 + 0.160107 * h - 0.014784 * t
          : 21.0606 + 0.005565 * h * h - 0.00035 * h * t - 0.483199 * h;
  return Math.max(0, emc) / 100;
}

/**
 * The air at the fuel bed: the 2 m air of a state warmed and dried by the sun by its cloud cover (Cohen and Deeming
 * 1985, after Byram and Jemison 1943: add 25, 19, 12 or 5 F and multiply the humidity by 0.75, 0.83, 0.92 or 1 for
 * clear, scattered, broken and overcast skies, the sky covers of Bradshaw et al. 1983 table 6). At night (`day` false)
 * the fuel sees the air as it is.
 */
export function fuelLevelAir(state: Pick<WeatherState, 'humidity' | 'temperature' | 'cloud'>, day = true): { humidity: number; temperature: number } {
  if (!day) return { humidity: state.humidity, temperature: state.temperature };
  const c = state.cloud,
    [addF, times] = c <= 0.1 ? [25, 0.75] : c <= 0.5 ? [19, 0.83] : c <= 0.9 ? [12, 0.92] : [5, 1];
  return { humidity: Math.min(1, state.humidity * times), temperature: state.temperature + (addF * 5) / 9 };
}

/**
 * The moisture each dead class moves toward in a state: the equilibrium moisture of the air at the fuel bed, or while it
 * rains 35 percent for the 1 and 10 hour fuels and 0.5 d + 41 percent for the 100-hour fuel after `rainHours` d of rain
 * (Cohen and Deeming 1985).
 */
export function fuelMoistureTarget(
  state: Pick<WeatherState, 'humidity' | 'temperature' | 'cloud' | 'rain'>,
  rainHours = 0,
  day = true,
): DeadFuelMoisture {
  if (state.rain > 0) {
    const d = Math.min(24, Math.max(0, rainHours));
    return { moisture: RAIN_FUEL_MOISTURE, moisture10: RAIN_FUEL_MOISTURE, moisture100: (0.5 * d + 41) / 100 };
  }
  const air = fuelLevelAir(state, day),
    emc = equilibriumMoisture(air.humidity, air.temperature);
  return { moisture: emc, moisture10: emc, moisture100: emc };
}

/**
 * Dead fuel moisture that follows the weather in time: each class moves toward {@link fuelMoistureTarget} by Fosberg's
 * timelag response, m += (target - m)(1 - exp(-dt / tau)), tau 1, 10 and 100 hours. It starts at the target of the first
 * state it is stepped with unless given a start. `timeScale` runs the fuel's clock faster than the weather's (a film
 * that shows an afternoon in a minute).
 * @example
 * const fuel = new FuelMoistureModel();
 * fuel.step(machine.state, 3600); // one hour of weather
 * front.options.moisture = fuel.moisture.moisture;
 */
export class FuelMoistureModel {
  private now?: DeadFuelMoisture;
  private rainHours = 0;
  /** Fuel time over weather time. Default 1. */
  timeScale: number;

  constructor(options: { start?: DeadFuelMoisture; timeScale?: number } = {}) {
    if (options.start !== undefined) {
      for (const k of ['moisture', 'moisture10', 'moisture100'] as const) {
        const v = options.start[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 4)
          throw new RangeError(`Invalid fuel moisture start.${k}; pass a finite fraction from 0 to 4.`);
      }
      this.now = { ...options.start };
    }
    this.timeScale = checkScale(options.timeScale ?? 1);
  }

  /** The moisture now (a copy), or undefined before the first step without a start. */
  get moisture(): DeadFuelMoisture | undefined {
    return this.now && { ...this.now };
  }
  /** Hours of rain in the current spell (0 when it is dry). */
  get rainSpell(): number {
    return this.rainHours;
  }

  /** Steps `seconds` of weather time in `state` (in daylight unless `day` is false); returns the moisture now. */
  step(state: Pick<WeatherState, 'humidity' | 'temperature' | 'cloud' | 'rain'>, seconds: number, day = true): DeadFuelMoisture {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
      throw new RangeError('Invalid fuel moisture step; pass a finite number of seconds of 0 or more.');
    const hours = (seconds * checkScale(this.timeScale)) / 3600;
    this.rainHours = state.rain > 0 ? this.rainHours + hours : 0;
    const target = fuelMoistureTarget(state, this.rainHours, day);
    if (this.now === undefined) this.now = { ...target };
    else
      for (const [i, k] of (['moisture', 'moisture10', 'moisture100'] as const).entries())
        this.now[k] += (target[k] - this.now[k]) * -Math.expm1(-hours / FUEL_TIMELAGS[i]!);
    return { ...this.now };
  }
}

function checkScale(v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e6)
    throw new RangeError('Invalid fuel moisture timeScale; pass a finite number from 0 to 1,000,000.');
  return v;
}
