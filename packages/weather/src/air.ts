// One physics for the air and the wind, read from a weather state by every package that draws or moves with it: the
// Beaufort force of a wind speed, the wind's growth with height, the rain rate, and the visibility the air leaves.
import type { WeatherState } from './state.js';

/** Upper speed bound in m/s of each Beaufort force 0 to 11 (World Meteorological Organization table, Manual on Codes, WMO-No. 306). */
const BEAUFORT_LIMITS = [0.3, 1.5, 3.3, 5.4, 7.9, 10.7, 13.8, 17.1, 20.7, 24.4, 28.4, 32.6] as const;

/**
 * The Beaufort force, 0 (calm) to 12 (hurricane), of a wind speed `speed` in m/s at 10 m: the WMO table, which follows
 * Beaufort's law v = 0.836 B^(3/2) m/s within half a force (Beaufort 1805; Wallbrink and Hall 1999 give the law).
 * @throws RangeError for a negative or non-finite speed.
 */
export function beaufort(speed: number): number {
  if (typeof speed !== 'number' || !(speed >= 0) || !Number.isFinite(speed))
    throw new RangeError(
      'Beaufort speed must be a finite number of metres per second, 0 or more; got ' + String(speed),
    );
  let force = 0;
  while (force < 12 && speed >= BEAUFORT_LIMITS[force]!) force++;
  return force;
}

/**
 * The wind speed in m/s at height `z` metres over the ground for the speed `speed10` at 10 m: the 1/7 power law of the
 * neutral boundary layer, U10 (z / 10)^(1/7) (Hsu, Meindl and Gilhousen 1994, "Determining the power-law wind-profile
 * exponent under near-neutral stability conditions at sea", J. Appl. Meteorol. 33(6), 757 to 765, doi:10.1175/1520-0450(1994)033<0757:DTPLWP>2.0.CO;2).
 * 2.05 times the 10 m speed at 1,500 m. Heights under 1 m take the speed at 1 m.
 * @throws RangeError for a negative or non-finite speed or a non-finite height.
 */
export function windProfile(speed10: number, z: number): number {
  if (typeof speed10 !== 'number' || !(speed10 >= 0) || !Number.isFinite(speed10))
    throw new RangeError(
      'Wind profile speed must be a finite number of metres per second, 0 or more; got ' + String(speed10),
    );
  if (typeof z !== 'number' || !Number.isFinite(z))
    throw new RangeError('Wind profile height must be a finite number of metres; got ' + String(z));
  return speed10 * (Math.max(z, 1) / 10) ** (1 / 7);
}

/** The rain rate in mm/h at `rain` 1 (a violent downpour); 0 gives 0 and the rate grows with the cube of `rain`. */
export const RAIN_RATE_AT_FULL = 80;

/**
 * The rain rate R in mm of water per hour a state's `rain` stands for: 80 rain^3, so a drizzle (0.2) is 0.64 mm/h, rain
 * (0.6) 17 mm/h, a storm (0.95) 69 mm/h and 1 is 80 mm/h (a violent downpour; the World Meteorological Organization
 * calls over 50 mm/h violent). Sky's `Weather` takes it as `rainRate` for the drops' size and fall speed.
 */
export function rainRate(state: Pick<WeatherState, 'rain'>): number {
  return RAIN_RATE_AT_FULL * Math.min(1, Math.max(0, state.rain)) ** 3;
}

/** Koschmieder's contrast constant: an object fades to 2 percent contrast at 3.912 / extinction metres (Koschmieder 1924; WMO-No. 8). */
export const KOSCHMIEDER = 3.912;
/** Extinction per metre of clear air: 3.912 / 23,000 m, a 23 km visibility (WMO-No. 8, "clear"). */
export const CLEAR_AIR_EXTINCTION = KOSCHMIEDER / 23000;

// Snow's extinction by intensity: the Federal Meteorological Handbook No. 1 gives the visibility of light (5/8 statute
// mile or more), moderate and heavy snow; the same points as the sky's scene kits (1,600, 750 and 350 m at 0.35, 0.65
// and 1), as extinction by Koschmieder, joined by straight lines from 0.
const SNOW_POINTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.35, KOSCHMIEDER / 1600],
  [0.65, KOSCHMIEDER / 750],
  [1, KOSCHMIEDER / 350],
];

/** Extinction per metre of falling snow of intensity `snow` 0..1 (the Federal Meteorological Handbook No. 1 classes by Koschmieder). */
export function snowExtinction(snow: number): number {
  const s = Math.min(1, Math.max(0, snow));
  for (let i = 1; i < SNOW_POINTS.length; i++) {
    const [x0, y0] = SNOW_POINTS[i - 1]!,
      [x1, y1] = SNOW_POINTS[i]!;
    if (s <= x1) return y0 + ((y1 - y0) * (s - x0)) / (x1 - x0);
  }
  return 0;
}

/**
 * Extinction per metre the air of a state leaves: clear air, plus fog (0.0002 (100^fog - 1), 0.02 at fog 1: 196 m),
 * plus rain (3.65e-4 R^0.63, from the Marshall and Palmer 1948 drop sizes at the rate R of {@link rainRate}; 25 mm/h
 * leaves 1.4 km without the air under it), plus snow (the Federal Meteorological Handbook No. 1 table by Koschmieder). It is what
 * {@link visibility} inverts. Dust adds {@link dustExtinction}, smoke {@link smokeExtinction}, ash {@link ashExtinction} and sea spray
 * {@link sprayExtinction} (a state without them has none, and 0 adds exactly 0).
 */
export function airExtinction(
  state: Pick<WeatherState, 'fog' | 'rain' | 'snow'> & {
    readonly dust?: number;
    readonly smoke?: number;
    readonly ash?: number;
    readonly spray?: number;
  },
): number {
  const fog = 0.0002 * (100 ** Math.min(1, Math.max(0, state.fog)) - 1),
    rain = 3.65e-4 * rainRate(state) ** 0.63,
    snow = snowExtinction(state.snow);
  return (
    CLEAR_AIR_EXTINCTION +
    fog +
    rain +
    snow +
    dustExtinction(state.dust ?? 0) +
    smokeExtinction(state.smoke ?? 0) +
    ashExtinction(state.ash ?? 0) +
    sprayExtinction(state.spray ?? 0)
  );
}

/**
 * Visibility in metres of a state: the distance at which a black object keeps 2 percent contrast, 3.912 over
 * {@link airExtinction} (Koschmieder). 23 km in clear air, about 200 m at `fog` 1, 1.3 km in 25 mm/h rain.
 */
export function visibility(
  state: Pick<WeatherState, 'fog' | 'rain' | 'snow'> & {
    readonly dust?: number;
    readonly smoke?: number;
    readonly ash?: number;
    readonly spray?: number;
  },
): number {
  return KOSCHMIEDER / airExtinction(state);
}

/**
 * The `fog` (0 to 1) that leaves a visibility of `metres` in the rain and snow of `state` (its own fog is ignored): the
 * inverse of {@link visibility} in the fog term, log(1 + (3.912 / V - the extinction of the clear air, rain and snow) / 0.0002) / log(100).
 * 0 when the rain and snow alone leave less than that visibility, 1 when even full fog leaves more (about 196 m in clear air).
 * @throws RangeError for a visibility that is not a positive finite number of metres.
 */
export function fogForVisibility(
  metres: number,
  state: Pick<WeatherState, 'rain' | 'snow'> & {
    readonly dust?: number;
    readonly smoke?: number;
    readonly ash?: number;
    readonly spray?: number;
  },
): number {
  if (typeof metres !== 'number' || !(metres > 0) || !Number.isFinite(metres))
    throw new RangeError('Visibility must be a positive finite number of metres; got ' + String(metres));
  const rest = airExtinction({
      fog: 0,
      rain: state.rain,
      snow: state.snow,
      dust: state.dust,
      smoke: state.smoke,
      ash: state.ash,
      spray: state.spray,
    }),
    fog = KOSCHMIEDER / metres - rest;
  return fog <= 0 ? 0 : Math.min(1, Math.log(1 + fog / 0.0002) / Math.log(100));
}

// ---- Dust ----
//
// Sources (papers read as text; no code):
// - Visibility against PM10: the relation PM10 = 485.67 V^-0.776 (micrograms per cubic metre, V in km) fitted by Jugder
//   et al. (2014) to PM10 and visibility at Zamyn-Uud in the Gobi desert, as tabulated in C. Camino, E. Cuevas, S. Basart,
//   S. Alonso-Perez, J. M. Baldasano, E. Terradellas, B. Marticorena, S. Rodriguez and A. Berjon, "An empirical equation
//   to estimate mineral dust concentrations from visibility observations in Northern Africa", Aeolian Research 16,
//   55-68, 2015, https://doi.org/10.1016/j.aeolia.2014.11.002, Table 1. The same table gives D'Almeida (1986),
//   PM10 = 914.0 V^-0.73 + 19.03; the published relations agree within a factor of 2.5 for visibilities from 0.2 to
//   10 km (the test checks it), and Camino et al. report an RMSE of 32 micrograms per cubic metre for their own
//   equation at Izana. They state the equations cannot be used above 10 km of visibility, where the estimate
//   flattens. R. A. Chepil and N. P. Woodruff, "Sedimentary characteristics of dust storms: II. Visibility and dust
//   concentration", Am. J. Sci. 255, 104-114, 1957, and E. M. Patterson and D. A. Gillette, "Measurements of
//   visibility vs mass-concentration for airborne soil particles", Atmos. Environ. 11, 193-196, 1977, gave the power
//   law form C = A V^-b first.
// - Colour: the single-scattering albedo of desert dust falls toward the blue (hematite absorbs there): about 0.92 at
//   440 nm, 0.94 at 550 nm and 0.96 at 670 nm, with an asymmetry parameter near 0.75 (O. Dubovik, B. Holben, T. F.
//   Eck and others, "Variability of absorption and optical properties of key aerosol types observed in worldwide
//   locations", J. Atmos. Sci. 59, 590-608, 2002). The colour of an optically thick layer is its diffusion albedo
//   (1 - s) / (1 + s), s = sqrt((1 - w) / (1 - g w)) (H. C. van de Hulst, "Multiple Light Scattering", Academic Press,
//   1980), a yellow-brown.
// - Emission: the dust flux of a saltating sand bed follows the saltation flux, which rises as u*^3 (1 - u*t^2 / u*^2)
//   over the threshold u*t (J. F. Kok, E. J. R. Parteli, T. I. Michaels and D. B. Karam, "The physics of wind-blown
//   sand and dust", Rep. Prog. Phys. 75, 106901, 2012, https://doi.org/10.1088/0034-4885/75/10/106901).

/** Dust mass concentration in micrograms per cubic metre at `dust` 1: a violent haboob (visibility about 100 m is 2,900). */
export const DUST_AT_FULL = 3000;
/** PM10 in micrograms per cubic metre at a visibility of 1 km: the 485.67 of Jugder et al. 2014 (Camino et al. 2015, Table 1). */
export const DUST_PM10_AT_1KM = 485.67;
/** The exponent of that relation, PM10 = 485.67 V^-0.776 with V in km. */
export const DUST_PM10_EXPONENT = 0.776;
/** The visibility in metres above which the relation is not valid (Camino et al. 2015): thinner dust adds proportionally less. */
export const DUST_RELATION_LIMIT = 10000;

/** The PM10 mass concentration in micrograms per cubic metre of a state's `dust`: 3,000 dust^2. */
export function dustConcentration(dust: number): number {
  const d = Math.min(1, Math.max(0, dust));
  return DUST_AT_FULL * d * d;
}

/**
 * The visibility in metres dust of mass concentration `pm10` (micrograms per cubic metre, PM10) leaves: the relation
 * PM10 = 485.67 V^-0.776 (V in km) of Jugder et al. 2014 inverted, V = (PM10 / 485.67)^(-1/0.776) km. 10 km at 81
 * micrograms, 1 km at 486, about 100 m at 2,900. Infinity for no dust.
 * @throws RangeError for a negative or non-finite concentration.
 */
export function dustVisibility(pm10: number): number {
  if (typeof pm10 !== 'number' || !(pm10 >= 0) || !Number.isFinite(pm10))
    throw new RangeError(
      'Dust PM10 must be a finite concentration of 0 or more micrograms per cubic metre; got ' + String(pm10),
    );
  return pm10 === 0 ? Infinity : 1000 * (pm10 / DUST_PM10_AT_1KM) ** (-1 / DUST_PM10_EXPONENT);
}

const DUST_AT_LIMIT = DUST_PM10_AT_1KM * (DUST_RELATION_LIMIT / 1000) ** -DUST_PM10_EXPONENT;

/**
 * Extinction per metre the dust of a state adds: Koschmieder's 3.912 over {@link dustVisibility} of
 * {@link dustConcentration}. Where the relation does not hold (under 81 micrograms, over 10 km of visibility) the
 * extinction falls in proportion to the concentration, so the haze thins to nothing with no step. 0 for `dust` 0.
 */
export function dustExtinction(dust: number): number {
  const c = dustConcentration(dust);
  if (c <= 0) return 0;
  const edge = KOSCHMIEDER / DUST_RELATION_LIMIT;
  return c >= DUST_AT_LIMIT ? KOSCHMIEDER / dustVisibility(c) : (edge * c) / DUST_AT_LIMIT;
}

/** Single-scattering albedo of desert dust at 670, 550 and 440 nm (red, green, blue): Dubovik et al. 2002. */
const DUST_ALBEDO: readonly [number, number, number] = [0.96, 0.94, 0.92];
/** Asymmetry parameter of desert dust (Dubovik et al. 2002). */
const DUST_ASYMMETRY = 0.75;

/**
 * The linear colour of dust-laden air per unit of light, red, green and blue: each channel's diffusion albedo
 * (1 - s) / (1 + s), s = sqrt((1 - w) / (1 - g w)), from the single-scattering albedo w of desert dust at that
 * wavelength. A yellow-brown, red over green over blue (about 0.45, 0.38, 0.33). Multiply by the light on the haze.
 */
export function dustColor(): [number, number, number] {
  return DUST_ALBEDO.map((w) => {
    const s = Math.sqrt((1 - w) / (1 - DUST_ASYMMETRY * w));
    return (1 - s) / (1 + s);
  }) as [number, number, number];
}

/** The most dust (a `dust` value) wind over sand raises: 0.5, a sandstorm of about 570 m visibility. */
export const DUST_FROM_SAND_MAX = 0.5;
/** The wind speed in m/s at 10 m above which medium sand (0.25 mm) moves: Bagnold's threshold, 6.6 (`sandThreshold` in `@margoengine/vfx/blown-sand`). */
export const SAND_THRESHOLD = 6.6;

/**
 * The dust (a `dust` value, 0 to {@link DUST_FROM_SAND_MAX}) a wind of `speed` m/s at 10 m raises over dry sand whose
 * motion starts at `threshold` m/s: the saltation flux over the threshold, 1 - exp(-1.5 (r^3 - r) / 6) with
 * r = speed / threshold (Owen 1964; Kok et al. 2012), times the most it raises. 0 at or below the threshold.
 * @throws RangeError for a negative or non-finite speed or a threshold that is not positive.
 */
export function dustFromWind(speed: number, threshold: number = SAND_THRESHOLD): number {
  if (typeof speed !== 'number' || !(speed >= 0) || !Number.isFinite(speed))
    throw new RangeError(
      'Dust wind speed must be a finite number of metres per second, 0 or more; got ' + String(speed),
    );
  if (typeof threshold !== 'number' || !(threshold > 0) || !Number.isFinite(threshold))
    throw new RangeError(
      'Dust threshold must be a positive finite speed in metres per second; got ' + String(threshold),
    );
  const r = speed / threshold;
  return r <= 1 ? 0 : DUST_FROM_SAND_MAX * (1 - Math.exp((-1.5 * (r * r * r - r)) / 6));
}

// ---- Smoke ----
// Wildfire smoke: the fine aerosol (PM2.5) a fire puts into the air, the visibility it leaves, the sun it dims and reddens
// and the colour of the haze. Written from these, read as text (no code):
// - Extinction: b = alpha C, the mass extinction efficiency alpha times the PM2.5 mass concentration C. Reid et al.,
//   "A review of biomass burning emissions part III: intensive optical properties of biomass burning particles",
//   Atmos. Chem. Phys. 5, 827-849, 2005, https://doi.org/10.5194/acp-5-827-2005: a mass scattering efficiency of 2.8 to
//   4.2 m2/g (mean 3.6 for dry smoke, 3.7 for forest fires; 3.5 to 4.2 for aged smoke) and an absorption efficiency of
//   0.2 to 1.1 m2/g, so about 4 m2/g in all. The visibility is Koschmieder's 3.912 / b (as for fog and dust).
// - Colour: the single-scattering albedo of smoke is 0.84 to 0.94 at 550 nm (Reid 2005, table 3 and its text) and falls
//   toward the blue where the brown carbon absorbs, so the haze is a grey brown; asymmetry g = 0.62 for aged smoke (Reid
//   2005, section 3). The channel albedos 0.89, 0.87, 0.84 at 670, 550 and 440 nm are chosen inside that range.
// - The sun: direct light through a layer is exp(-tau m), the optical depth tau = b H of the layer of depth H and the air
//   mass m = 1 / sin(elevation) of a flat layer; the optical depth follows lambda^-1.8, the Angstrom exponent of biomass
//   burning smoke (Eck et al., "Wavelength dependence of the optical depth of biomass burning, urban, and desert dust
//   aerosols", J. Geophys. Res. 104(D24), 31333-31349, 1999, https://doi.org/10.1029/1999JD900923: the exponents of
//   accumulation-mode smoke are high and vary with wavelength; 1.8 is a representative value), so blue goes first.
// - The fire's share: the fine smoke a kilogram of fuel gives is 15 g (Akagi et al., "Emission factors for open and
//   domestic biomass burning for use in atmospheric models", Atmos. Chem. Phys. 11, 4039-4072, 2011,
//   https://doi.org/10.5194/acp-11-4039-2011, table 1, extratropical forest); the smoke mixes through the layer in a box
//   model C = Q / (U H W).
//
// Chosen here, not from the papers: PM2.5 of 5,000 micrograms per cubic metre at `smoke` 1 (196 m visibility, the same as
// `fog` 1; dense smoke beside a fire) rising as smoke^2 as dust does; the layer depth 2 km (a deep boundary layer, where
// most fire smoke sits at the fire); the elevation floor of 3 degrees on the air mass; the crosswind width 2 km.

/** PM2.5 mass concentration in micrograms per cubic metre at `smoke` 1: the thick smoke beside a fire (196 m of visibility). */
export const SMOKE_AT_FULL = 5000;
/** Mass extinction efficiency of fire smoke at 550 nm in square metres per gram (Reid et al. 2005: 3.6 scattering plus about 0.5 absorbing). */
export const SMOKE_MASS_EXTINCTION = 4;
/** Depth in metres of the smoke layer the sun shines through. */
export const SMOKE_LAYER_DEPTH = 2000;
/** The Angstrom exponent of the smoke's optical depth (Eck et al. 1999). */
export const SMOKE_ANGSTROM = 1.8;

/** The PM2.5 mass concentration in micrograms per cubic metre of a state's `smoke`: 5,000 smoke^2. */
export function smokeConcentration(smoke: number): number {
  const s = Math.min(1, Math.max(0, smoke));
  return SMOKE_AT_FULL * s * s;
}

/**
 * Extinction per metre smoke of PM2.5 concentration `pm25` (micrograms per cubic metre) adds: 4 m2/g times the mass
 * (4e-6 per microgram per cubic metre). 0 for 0.
 * @throws RangeError for a concentration that is not a finite number of 0 or more.
 */
export function smokeExtinctionOf(pm25: number): number {
  if (typeof pm25 !== 'number' || !Number.isFinite(pm25) || pm25 < 0)
    throw new RangeError(
      'Smoke PM2.5 must be a finite concentration of 0 or more micrograms per cubic metre; got ' + String(pm25),
    );
  return SMOKE_MASS_EXTINCTION * 1e-6 * pm25;
}

/** The visibility in metres smoke of PM2.5 concentration `pm25` leaves: Koschmieder's 3.912 over its extinction. Infinity for 0. */
export function smokeVisibility(pm25: number): number {
  const b = smokeExtinctionOf(pm25);
  return b === 0 ? Infinity : KOSCHMIEDER / b;
}

/** Extinction per metre the smoke of a state adds ({@link smokeExtinctionOf} of {@link smokeConcentration}); 0 for `smoke` 0. */
export function smokeExtinction(smoke: number): number {
  return smokeExtinctionOf(smokeConcentration(smoke));
}

/** Single-scattering albedo of fire smoke at 670, 550 and 440 nm (red, green, blue): inside Reid et al. 2005's 0.84 to 0.94. */
const SMOKE_ALBEDO: readonly [number, number, number] = [0.89, 0.87, 0.84];
/** Asymmetry parameter of aged smoke (Reid et al. 2005). */
const SMOKE_ASYMMETRY = 0.62;

/**
 * The linear colour of smoke-laden air per unit of light, red, green and blue: each channel's diffusion albedo
 * (1 - s) / (1 + s), s = sqrt((1 - w) / (1 - g w)) from the single-scattering albedo of smoke at that wavelength (the
 * same form as {@link dustColor}). A grey brown, a little redder than blue. Multiply by the light on the haze.
 */
export function smokeColor(): [number, number, number] {
  return SMOKE_ALBEDO.map((w) => {
    const s = Math.sqrt((1 - w) / (1 - SMOKE_ASYMMETRY * w));
    return (1 - s) / (1 + s);
  }) as [number, number, number];
}

/** The optical depth at 550 nm of the smoke layer of a state: its extinction over {@link SMOKE_LAYER_DEPTH}. 0 for `smoke` 0. */
export function smokeOpticalDepth(smoke: number): number {
  return smokeExtinction(smoke) * SMOKE_LAYER_DEPTH;
}

/**
 * The share of the direct sun that reaches the ground through the smoke of a state, red, green and blue (670, 550 and
 * 440 nm), with the sun `elevation` radians above the horizon: exp(-tau (lambda / 550)^-1.8 / sin(elevation)), the
 * elevation floored at 3 degrees. Exactly [1, 1, 1] for `smoke` 0.
 * @throws RangeError for an elevation that is not a finite number of radians.
 */
export function smokeSunTransmittance(smoke: number, elevation: number): [number, number, number] {
  if (typeof elevation !== 'number' || !Number.isFinite(elevation))
    throw new RangeError('Sun elevation must be a finite number of radians; got ' + String(elevation));
  const tau = smokeOpticalDepth(smoke);
  if (tau === 0) return [1, 1, 1];
  const m = 1 / Math.sin(Math.max(elevation, (3 * Math.PI) / 180));
  return [670, 550, 440].map((nm) => Math.exp(-tau * (nm / 550) ** -SMOKE_ANGSTROM * m)) as [number, number, number];
}

/**
 * The smoke (a `smoke` value, 0 to 1) a fire of `emission` grams of PM2.5 per second makes in a wind of `wind` m/s at 10 m
 * (at least 1) over a crosswind width of `width` metres (default 2,000), mixed through {@link SMOKE_LAYER_DEPTH}: the
 * box model C = Q / (U H W), then the `smoke` that has that concentration. 0 for no emission.
 * @throws RangeError for a negative or non-finite emission or wind, or a width that is not above 0.
 */
export function smokeFromEmission(emission: number, wind: number, width = 2000): number {
  if (typeof emission !== 'number' || !Number.isFinite(emission) || emission < 0)
    throw new RangeError(
      'Smoke emission must be a finite number of grams per second, 0 or more; got ' + String(emission),
    );
  if (typeof wind !== 'number' || !Number.isFinite(wind) || wind < 0)
    throw new RangeError('Smoke wind must be a finite speed in metres per second, 0 or more; got ' + String(wind));
  if (typeof width !== 'number' || !Number.isFinite(width) || !(width > 0))
    throw new RangeError('Smoke width must be a finite number of metres above 0; got ' + String(width));
  const c = (emission * 1e6) / (Math.max(wind, 1) * SMOKE_LAYER_DEPTH * width);
  return Math.min(1, Math.sqrt(c / SMOKE_AT_FULL));
}

// ---- Coarse particles: volcanic ash and sea spray ----
// Grains much larger than the wavelength of light scatter and absorb twice their geometric cross section at every
// wavelength (the extinction paradox, Q_ext = 2: H. C. van de Hulst, "Light Scattering by Small Particles", Wiley,
// 1957, chapter 8), so spheres of density rho and effective radius r_eff = <r^3> / <r^2> at mass concentration C have
// extinction b = 3 C / (2 rho r_eff) (the same law `Eruption.visibility` uses per grain class), an Angstrom exponent of
// 0 and a grey dimming of the sun: ash and spray dim it without reddening it.
//
// Ash. Written from these, read as text (no code):
// - Size: the coarse mode of the fresh 2010 Eyjafjallajokull plume had an effective radius of about 1.75 micrometres,
//   non-spherical, with an Angstrom exponent close to 0 and a single-scattering albedo of 0.92 to 0.98 (F. Waquet,
//   F. Peers, P. Goloub, F. Ducos, F. Thieuleux, Y. Derimian, J. Riedi, M. Chami and D. Tanre, "Retrieval of the
//   Eyjafjallajokull volcanic aerosol optical and microphysical properties from POLDER/PARASOL measurements", Atmos.
//   Chem. Phys. 14, 1755-1768, 2014, https://doi.org/10.5194/acp-14-1755-2014).
// - Colour: sun photometers under the ash over Spain gave a single-scattering albedo of about 0.95 at 440 nm, nearly flat
//   with wavelength and a little lower toward the red (C. Toledano and others, with A. M. de Frutos, "Aerosol
//   properties of the Eyjafjallajokull ash derived from sun photometer and satellite observations over the Iberian
//   Peninsula", Atmos. Environ. 48, 22-32, 2012, https://doi.org/10.1016/j.atmosenv.2011.09.072): 0.94, 0.945 and 0.95 at 670, 550 and 440 nm here, a neutral grey.
// - Scale: lidar and photometer over Leipzig and Munich found ash up to about 1,500 micrograms per cubic metre in the
//   distal cloud of 16 and 17 April 2010, with an assumed grain density of 2.6 g/cm3 (A. Ansmann and others, "Ash and
//   fine-mode particle mass profiles from EARLINET-AERONET observations over central Europe after the eruptions of the
//   Eyjafjallajokull volcano in 2010", J. Geophys. Res. 116, D00U02, 2011, https://doi.org/10.1029/2010JD015567).
// Chosen here, not from the papers: 100,000 micrograms per cubic metre at `ash` 1 (falling ash near a vent, about 114 m of
// visibility; Ansmann's distal peak is `ash` 0.12), rising as ash^2 as dust and smoke do; the grain density 2,500 kg/m3
// (`Eruption`'s default `ashDensity`); the asymmetry 0.7; the ash layer the sun shines through, 3 km.
//
// Sea spray. Written from these, read as text (no code):
// - Load: the sea salt over the open ocean rises with the wind as ln m = 0.16 U + 1.45 (m in micrograms per cubic metre,
//   U the 10 m wind in m/s), from 1,821 samples at 5 to 15 m on North Atlantic weather ships (R. F. Lovett,
//   "Quantitative measurement of airborne sea-salt in the North Atlantic", Tellus 30(4), 358-364, 1978,
//   https://doi.org/10.3402/tellusa.v30i4.10354); the fit scatters by up to a factor of 10.
// - Breaking water: downwind of the surf zone the spray of 1 to 10 micrometres is one to two orders of magnitude above
//   the upwind air at winds up to 9 m/s, and it reaches fetches of at least 25 km (G. de Leeuw, F. P. Neele, M. Hill,
//   M. H. Smith and E. Vignati, "Production of sea spray aerosol in the surf zone", J. Geophys. Res. 105(D24),
//   29397-29409, 2000, https://doi.org/10.1029/2000JD900549). The surf factor here is 30, the geometric middle of 10 and
//   100, falling to 1 with the distance from the breakers over a 2 km e-folding reach (a model choice inside that 25 km).
// - Size: a sea-salt particle at 80 percent humidity has about twice its dry radius, and dry sea salt has a density of
//   2,165 kg/m3 (E. R. Lewis and S. E. Schwartz, "Sea Salt Aerosol Production: Mechanisms, Methods, Measurements and
//   Models", AGU Geophysical Monograph 152, 2004). The cross section per dry mass is then 4 times the dry one; the
//   effective dry radius 1.5 micrometres is chosen here inside the 1 to 10 micrometre spray of de Leeuw.
// - Colour: sea salt does not absorb (single-scattering albedo 0.999 here), so the haze is white.

/** Extinction efficiency of particles much larger than the wavelength (van de Hulst 1957). */
const LARGE_PARTICLE_EFFICIENCY = 2;

/** Ash mass concentration in micrograms per cubic metre at `ash` 1: falling ash near a vent (about 114 m of visibility). */
export const ASH_AT_FULL = 100000;
/** Effective radius in metres of airborne ash: the coarse mode of the Eyjafjallajokull plume (Waquet et al. 2014). */
export const ASH_RADIUS = 1.75e-6;
/** Density of ash grains in kg/m3 (`Eruption`'s default `ashDensity`). */
export const ASH_DENSITY = 2500;
/** Depth in metres of the ash layer the sun shines through. */
export const ASH_LAYER_DEPTH = 3000;

/** The mass concentration in micrograms per cubic metre of a state's `ash`: 100,000 ash^2. */
export function ashConcentration(ash: number): number {
  const a = Math.min(1, Math.max(0, ash));
  return ASH_AT_FULL * a * a;
}

/**
 * Extinction per metre of coarse grains (Q_ext = 2) of mass concentration `micrograms` per cubic metre, effective radius
 * `radius` metres and density `density` kg/m3: 3 C / (2 rho r). 0 for 0.
 * @throws RangeError for a negative or non-finite concentration, or a radius or density that is not above 0.
 */
export function coarseExtinction(micrograms: number, radius: number, density: number): number {
  if (typeof micrograms !== 'number' || !Number.isFinite(micrograms) || micrograms < 0)
    throw new RangeError(
      'Particle concentration must be a finite number of 0 or more micrograms per cubic metre; got ' +
        String(micrograms),
    );
  if (typeof radius !== 'number' || !Number.isFinite(radius) || !(radius > 0))
    throw new RangeError('Particle radius must be a finite number of metres above 0; got ' + String(radius));
  if (typeof density !== 'number' || !Number.isFinite(density) || !(density > 0))
    throw new RangeError('Particle density must be a finite number of kg/m3 above 0; got ' + String(density));
  return (LARGE_PARTICLE_EFFICIENCY * 0.75 * micrograms * 1e-9) / (density * radius);
}

/** Extinction per metre the ash of a state adds ({@link coarseExtinction} of {@link ashConcentration}); 0 for `ash` 0. */
export function ashExtinction(ash: number): number {
  return coarseExtinction(ashConcentration(ash), ASH_RADIUS, ASH_DENSITY);
}

/**
 * The `ash` (0 to 1) whose extinction is `extinction` per metre: the inverse of {@link ashExtinction}, 1 past ash 1.
 * `WeatherDrive` turns an eruption's falling ash at the camera into the state's `ash` with it.
 * @throws RangeError for an extinction that is not a finite number of 0 or more.
 */
export function ashForExtinction(extinction: number): number {
  if (typeof extinction !== 'number' || !Number.isFinite(extinction) || extinction < 0)
    throw new RangeError('Ash extinction must be a finite number of 0 or more per metre; got ' + String(extinction));
  return Math.min(1, Math.sqrt(extinction / ashExtinction(1)));
}

/** Single-scattering albedo of volcanic ash at 670, 550 and 440 nm (Toledano et al. 2012; Waquet et al. 2014). */
const ASH_ALBEDO: readonly [number, number, number] = [0.94, 0.945, 0.95];
/** Asymmetry parameter of ash (a model choice). */
const ASH_ASYMMETRY = 0.7;

/** Most dust, smoke and spray colours: the diffusion albedo (1 - s) / (1 + s), s = sqrt((1 - w) / (1 - g w)) (van de Hulst 1980). */
const diffusionColor = (albedo: readonly [number, number, number], g: number): [number, number, number] =>
  albedo.map((w) => {
    const s = Math.sqrt((1 - w) / (1 - g * w));
    return (1 - s) / (1 + s);
  }) as [number, number, number];

/** The linear colour of ash-laden air per unit of light (the diffusion albedo of ash, as {@link dustColor}): a neutral grey. */
export function ashColor(): [number, number, number] {
  return diffusionColor(ASH_ALBEDO, ASH_ASYMMETRY);
}

/** Dry sea-salt mass concentration in micrograms per cubic metre at `spray` 1: the surf zone in a gale (about 420 m of visibility). */
export const SPRAY_AT_FULL = 5000;
/** Effective dry radius in metres of sea spray. */
export const SPRAY_DRY_RADIUS = 1.5e-6;
/** Density of dry sea salt in kg/m3 (Lewis and Schwartz 2004). */
export const SPRAY_DRY_DENSITY = 2165;
/** Growth of a sea-salt particle's radius from dry to 80 percent humidity (Lewis and Schwartz 2004). */
export const SPRAY_GROWTH = 2;
/** How many times the open-sea spray load the air downwind of breaking surf holds (de Leeuw et al. 2000: 10 to 100). */
export const SURF_ENHANCEMENT = 30;
/** E-folding distance in metres over which the surf's extra spray falls back to the open sea's. */
export const SURF_REACH = 2000;
/** Depth in metres of the spray layer the sun shines through (the marine surface layer). */
export const SPRAY_LAYER_DEPTH = 500;

/** The dry sea-salt mass concentration in micrograms per cubic metre of a state's `spray`: 5,000 spray^2. */
export function sprayConcentration(spray: number): number {
  const s = Math.min(1, Math.max(0, spray));
  return SPRAY_AT_FULL * s * s;
}

/** Extinction per metre the sea spray of a state adds: coarse grains at the wet radius, 2 x the dry, per dry mass; 0 for 0. */
export function sprayExtinction(spray: number): number {
  return coarseExtinction(sprayConcentration(spray), SPRAY_DRY_RADIUS, SPRAY_DRY_DENSITY) * SPRAY_GROWTH * SPRAY_GROWTH;
}

/**
 * The dry sea-salt load in micrograms per cubic metre over a sea in a wind of `wind` m/s at 10 m, `distance` metres
 * downwind of breaking surf (Infinity for the open sea, the default): Lovett's exp(0.16 U + 1.45) times
 * 1 + 29 exp(-distance / 2,000) (de Leeuw et al. 2000).
 * @throws RangeError for a negative or non-finite wind, or a distance that is negative or NaN.
 */
export function seaSalt(wind: number, distance = Infinity): number {
  if (typeof wind !== 'number' || !Number.isFinite(wind) || wind < 0)
    throw new RangeError('Sea spray wind must be a finite speed of 0 or more metres per second; got ' + String(wind));
  if (typeof distance !== 'number' || !(distance >= 0))
    throw new RangeError('Surf distance must be 0 or more metres (Infinity for the open sea); got ' + String(distance));
  return Math.exp(0.16 * wind + 1.45) * (1 + (SURF_ENHANCEMENT - 1) * Math.exp(-distance / SURF_REACH));
}

/** The `spray` (0 to 1) a sea in a wind of `wind` m/s raises `distance` metres from breaking surf ({@link seaSalt}). */
export function sprayFromWind(wind: number, distance = Infinity): number {
  return Math.min(1, Math.sqrt(seaSalt(wind, distance) / SPRAY_AT_FULL));
}

/** Single-scattering albedo of sea salt (it does not absorb). */
const SPRAY_ALBEDO: readonly [number, number, number] = [0.999, 0.999, 0.999];
/** Asymmetry parameter of wet sea salt. */
const SPRAY_ASYMMETRY = 0.75;
/** The linear colour of spray-laden air per unit of light: the diffusion albedo of sea salt (asymmetry 0.75), a white. */
export function sprayColor(): [number, number, number] {
  return diffusionColor(SPRAY_ALBEDO, SPRAY_ASYMMETRY);
}

/**
 * The share of the direct sun that reaches the ground through the smoke, ash and spray of a state, red, green and blue,
 * with the sun `elevation` radians up: {@link smokeSunTransmittance} times the grey exp(-tau m) of the ash over
 * {@link ASH_LAYER_DEPTH} and the spray over {@link SPRAY_LAYER_DEPTH} (Angstrom exponent 0), the elevation floored at 3
 * degrees. Exactly [1, 1, 1] with no smoke, ash or spray.
 * @throws RangeError for an elevation that is not a finite number of radians.
 */
export function sunTransmittance(
  state: { readonly smoke?: number; readonly ash?: number; readonly spray?: number },
  elevation: number,
): [number, number, number] {
  const t = smokeSunTransmittance(state.smoke ?? 0, elevation),
    tau = ashExtinction(state.ash ?? 0) * ASH_LAYER_DEPTH + sprayExtinction(state.spray ?? 0) * SPRAY_LAYER_DEPTH;
  if (tau === 0) return t;
  const grey = Math.exp(-tau / Math.sin(Math.max(elevation, (3 * Math.PI) / 180)));
  return [t[0] * grey, t[1] * grey, t[2] * grey];
}

/**
 * Two-stream diffuse transmission of a slab of optical depth `tau`, single-scattering albedo `w` and asymmetry `g` over
 * a black ground (hemispheric mean closure, Meador and Weaver 1980): 2k / ((k + g1) e^(k tau) + (k - g1) e^(-k tau)),
 * g1 = 2 - w (1 + g), g2 = w (1 - g), k = sqrt(g1^2 - g2^2); 1 / (1 + g1 tau) for conservative scattering (k = 0).
 */
function slabTransmission(tau: number, w: number, g: number): number {
  const g1 = 2 - w * (1 + g),
    g2 = w * (1 - g),
    k = Math.sqrt(Math.max(0, (g1 - g2) * (g1 + g2)));
  if (k === 0) return 1 / (1 + g1 * tau);
  const e = Math.exp(-k * tau);
  return (2 * k * e) / (k + g1 + (k - g1) * e * e);
}

/**
 * Two-stream diffuse reflectance of the same slab (hemispheric mean closure, Meador and Weaver 1980):
 * g2 (1 - e^(-2 k tau)) / (k + g1 + (k - g1) e^(-2 k tau)); g2 tau / (1 + g1 tau) for conservative scattering, so R + T
 * is 1 when nothing is absorbed.
 */
function slabReflection(tau: number, w: number, g: number): number {
  const g1 = 2 - w * (1 + g),
    g2 = w * (1 - g),
    k = Math.sqrt(Math.max(0, (g1 - g2) * (g1 + g2)));
  if (k === 0) return (g2 * tau) / (1 + g1 * tau);
  const e = Math.exp(-2 * k * tau);
  return (g2 * (1 - e)) / (k + g1 + (k - g1) * e);
}

// The two-stream `slab` of the smoke, ash and spray of a state at 670, 550 and 440 nm, their optical depths, albedos
// and asymmetries mixed by optical depth. Undefined with no smoke, ash or spray.
function mixedSlab(
  state: { readonly smoke?: number; readonly ash?: number; readonly spray?: number },
  slab: (tau: number, w: number, g: number) => number,
): [number, number, number] | undefined {
  const smoke = smokeOpticalDepth(state.smoke ?? 0),
    ash = ashExtinction(state.ash ?? 0) * ASH_LAYER_DEPTH,
    spray = sprayExtinction(state.spray ?? 0) * SPRAY_LAYER_DEPTH;
  if (smoke + ash + spray === 0) return undefined;
  return [670, 550, 440].map((nm, i) => {
    const s = smoke * (nm / 550) ** -SMOKE_ANGSTROM,
      tau = s + ash + spray,
      scatter = s * SMOKE_ALBEDO[i]! + ash * ASH_ALBEDO[i]! + spray * SPRAY_ALBEDO[i]!,
      g =
        (s * SMOKE_ALBEDO[i]! * SMOKE_ASYMMETRY +
          ash * ASH_ALBEDO[i]! * ASH_ASYMMETRY +
          spray * SPRAY_ALBEDO[i]! * SPRAY_ASYMMETRY) /
        scatter;
    return slab(tau, scatter / tau, g);
  }) as [number, number, number];
}

/**
 * The share of the diffuse light falling on the smoke, ash and spray of a state from below that they send back down,
 * red, green and blue (670, 550 and 440 nm): the two-stream reflectance of the layers (`slabReflection`, the optical
 * depths, albedos and asymmetries mixed by optical depth as in {@link hazeLight}). A pall lit by fires under it shines
 * this share of their light back down at night (KB-SKY-NIGHTPALL1). Exactly [0, 0, 0] with no smoke, ash or spray.
 */
export function hazeReflectance(state: {
  readonly smoke?: number;
  readonly ash?: number;
  readonly spray?: number;
}): [number, number, number] {
  return mixedSlab(state, slabReflection) ?? [0, 0, 0];
}

/** The linear colour of a flame's light (the `GLOW_COLOR` a fire's glow lights its smoke columns with in `@margoengine/vfx/lit`). */
export const FIRE_LIGHT_COLOR: readonly [number, number, number] = [1, 0.42, 0.12];
/** The noon sun's irradiance on level ground, W/m^2: the light the haze colours are referred to (share 1). */
export const NOON_IRRADIANCE = 1000;

/**
 * The share of the noon sun's light ({@link NOON_IRRADIANCE}) that fires radiating `radiantPower` watts (a fire front's
 * `radiantPower`: the radiant 0.3 of its release, Drysdale 2011) put on the smoke haze over them, red, green and blue,
 * the flames' colour ({@link FIRE_LIGHT_COLOR}) times E / 1,000 W/m^2. E is the box model's light as
 * {@link smokeFromEmission} is its smoke: the upward half of the radiant power, the share of it an isotropic source
 * on the ground sends through a disc of the box's area (`width` squared, radius rho = width / sqrt(pi)) at the middle
 * of the smoke layer (h = {@link SMOKE_LAYER_DEPTH} / 2), 1 - h / sqrt(h^2 + rho^2) (the point-to-disc view factor,
 * M. F. Modest, "Radiative Heat Transfer", 3rd ed., Academic Press, 2013, ch. 4), spread over that area. The haze's
 * airlight is its diffusion colour times the light on it (Koschmieder 1924), so a valley burning under a smoke pall
 * at night glows orange from below (the night fire light that VIIRS's day/night band images, J. Wang, Y. Zhou and
 * others, "Detecting nighttime fire combustion phase by hybrid application of visible and infrared radiation from
 * Suomi NPP VIIRS", Remote Sens. Environ. 237, 111466, 2020, https://doi.org/10.1016/j.rse.2019.111466). Exactly
 * [0, 0, 0] for no radiant power.
 * @throws RangeError for a negative or non-finite power, or a width that is not above 0.
 */
export function fireHazeLight(radiantPower: number, width = 2000): [number, number, number] {
  if (typeof radiantPower !== 'number' || !Number.isFinite(radiantPower) || radiantPower < 0)
    throw new RangeError('Fire radiant power must be a finite number of watts, 0 or more; got ' + String(radiantPower));
  if (typeof width !== 'number' || !Number.isFinite(width) || !(width > 0))
    throw new RangeError('Smoke width must be a finite number of metres above 0; got ' + String(width));
  if (radiantPower === 0) return [0, 0, 0];
  const h = SMOKE_LAYER_DEPTH / 2,
    rho2 = (width * width) / Math.PI,
    through = 1 - h / Math.sqrt(h * h + rho2),
    e = (0.5 * radiantPower * through) / (width * width),
    share = e / NOON_IRRADIANCE;
  return [FIRE_LIGHT_COLOR[0] * share, FIRE_LIGHT_COLOR[1] * share, FIRE_LIGHT_COLOR[2] * share];
}

/**
 * The share of the noon sun's light ({@link NOON_IRRADIANCE}) that fires radiating `radiantPower` watts put on the smoke
 * layer at a point `distance` metres across from straight over them, red, green and blue in the flames' colour
 * ({@link FIRE_LIGHT_COLOR}) (KB-SKY-PALLFALLOFF1). The upward half of the power leaves the fire as an isotropic source
 * of intensity P / (4 pi) W/sr, and a horizontal plane h = {@link SMOKE_LAYER_DEPTH} / 2 above it takes
 * E = P h / (4 pi (h^2 + s^2 + r^2)^1.5) (the cosine law over the squared distance, M. F. Modest, "Radiative Heat
 * Transfer", 3rd ed., Academic Press, 2013, ch. 1 and 4), the source softened by the fire's `spread` s (its RMS radius).
 * Over the whole plane it gives P / 2, and with no spread its mean over the box of {@link fireHazeLight} is that
 * function's value, so the pall glows brightest over each fire and falls off with distance from it. Several fires, or
 * the clusters of one front (`FireFront.radiantSources`), add. Exactly [0, 0, 0] for no power.
 * @throws RangeError for a negative or non-finite power, spread or distance.
 */
export function fireLayerLight(radiantPower: number, spread = 0, distance = 0): [number, number, number] {
  for (const [v, name] of [
    [radiantPower, 'Fire radiant power'],
    [spread, 'Fire spread'],
    [distance, 'Distance'],
  ] as const)
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      throw new RangeError(name + ' must be a finite number, 0 or more; got ' + String(v));
  if (radiantPower === 0) return [0, 0, 0];
  const h = SMOKE_LAYER_DEPTH / 2,
    share = (radiantPower * h) / (4 * Math.PI * (h * h + spread * spread + distance * distance) ** 1.5) / NOON_IRRADIANCE;
  return [FIRE_LIGHT_COLOR[0] * share, FIRE_LIGHT_COLOR[1] * share, FIRE_LIGHT_COLOR[2] * share];
}

/**
 * The share of the light on clean air that still lights the air under the smoke, ash and spray of a state, red, green
 * and blue, with the sun `elevation` radians up: the direct sun the layers let through, t ({@link sunTransmittance}),
 * plus the sunlight they scatter, 1 - t, times the share of it a two-stream slab of the layers passes down
 * (`slabTransmission`, the optical depths, albedos and asymmetries mixed by optical depth): t + (1 - t) T. The haze's
 * in-scattered light (Koschmieder's horizon brightness, the airlight) is the diffusion colour times this, so the air in
 * front of the ground darkens as the load thickens. Exactly [1, 1, 1] with no smoke, ash or spray. Dust is not in it,
 * as it is not in {@link sunTransmittance}.
 * @throws RangeError for an elevation that is not a finite number of radians.
 */
export function hazeLight(
  state: { readonly smoke?: number; readonly ash?: number; readonly spray?: number },
  elevation: number,
): [number, number, number] {
  const t = sunTransmittance(state, elevation),
    slab = mixedSlab(state, slabTransmission);
  if (!slab) return [1, 1, 1];
  return [t[0] + (1 - t[0]) * slab[0], t[1] + (1 - t[1]) * slab[1], t[2] + (1 - t[2]) * slab[2]];
}
