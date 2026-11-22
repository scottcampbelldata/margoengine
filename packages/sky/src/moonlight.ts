// Moonlight from the moon the sky draws: its illuminance from the phase (Krisciunas and Schaefer 1991) and the air it
// crosses, its colour from the sunlight the moon reflects and the eye's blue shift at night (Jensen et al. 2000).
import { blackbodyChromaticity, chromaticityToLinearSRGB } from '@margoengine/math/color';
export { MOON_PHASES, moonPhase, moonWaning, type MoonPhase, type MoonPhaseName } from './moon-phase.js';

/** What {@link moonlight} writes: the moonlight's illuminance, its colour and the light intensity that gives it. */
export interface Moonlight {
  /** Illuminance on a surface facing the moon, in lux, after the air's extinction. */
  illuminance: number;
  /** Linear sRGB colour, largest channel 1. */
  color: [number, number, number];
  /** `illuminance` over the colour's Rec. 709 luminance: a directional light of this intensity and `color` gives `illuminance` lux. */
  intensity: number;
}

/**
 * V-band extinction in magnitudes per airmass that {@link moonlight} uses by default: 0.172, the coefficient Krisciunas
 * and Schaefer fitted their model with (Mauna Kea). A sea-level site runs higher, about 0.2 to 0.3.
 */
export const MOON_EXTINCTION = 0.172;
// The Moon's colour index B - V = 0.92 (A. N. Cox, ed., "Allen's Astrophysical Quantities", 4th ed., Springer 2000,
// the Moon's photometric table), redder than the Sun's 0.65 because the lunar albedo rises toward the red (Jensen et
// al. 2000, section 2.1: about twice as large for red light as for blue). Ballesteros' formula (EPL 97, 34008, 2012, doi:10.1209/0295-5075/97/34008), which gives the
// Sun 5,778 K from its 0.65, turns 0.92 into the colour temperature of moonlight: 4,943 K.
const MOON_BV = 0.92,
  MOON_KELVIN = 4600 * (1 / (0.92 * MOON_BV + 1.7) + 1 / (0.92 * MOON_BV + 0.62)),
  [MOON_X, MOON_Y] = blackbodyChromaticity(MOON_KELVIN),
  // The night's dominant hue Jensen et al. shift scotopic pixels toward, (0.25, 0.25).
  BLUE = 0.25;
const scratch = [0, 0, 0];

/**
 * Moonlight for a moon of `phase` (-1 new, 0 half, 1 full: the illuminated fraction is (phase + 1) / 2, as `night`'s
 * `moonPhase`) toward `direction` (world space, +Y up, any length), written into `out` (default a new object).
 *
 * Illuminance: Krisciunas and Schaefer, "A model of the brightness of moonlight", PASP 103:1033-1039, 1991,
 * doi:10.1086/132921. The phase angle is a = acos(phase) in degrees; above the air the moon gives
 * 10^(-0.4 (3.84 + 0.026 |a| + 4e-9 a^4)) foot-candles (their eq. 20, the moon at its mean distance), 0.313 lux full;
 * the air passes 10^(-0.4 k X) of it, X = (1 - 0.96 sin^2 z)^(-1/2) the airmass at zenith angle z (their eq. 3) and k
 * `extinction` (default {@link MOON_EXTINCTION}). A moon on or below the horizon gives 0.
 *
 * Colour: moonlight is sunlight reflected by a surface whose albedo rises toward the red, so it is redder than
 * sunlight, about a 4,943 K blackbody (B - V 0.92 by Ballesteros 2012). It looks blue because rods feed the blue
 * mechanism at mesopic and scotopic levels (the Purkinje shift; P. W. Trezona, "Rod participation in the 'blue'
 * mechanism and its effect on color matching", Vision Research 10, 1970). H. W. Jensen, S. Premoze, P. Shirley,
 * W. B. Thompson, J. A. Ferwerda and M. M. Stark, "Night Rendering", University of Utah UUCS-00-016, 2000 (the hue
 * part of its tone reproduction; the basis of Jensen et al., "A Physically-Based Night Sky Model", SIGGRAPH 2001, and of W. B. Thompson,
 * P. Shirley and J. A. Ferwerda, "A Spatial Post-Processing Algorithm for Images of Night Scenes", JGT 7(1), 2002)
 * shift a pixel of luminance Y toward the chromaticity (0.25, 0.25) by 1 - s, the rods' saturation s being 0 below
 * log10 Y = -2 (cd/m^2), 1 above 0.6 and 3 t^2 - 2 t^3 between, t = (log10 Y + 2) / 2.6. The engine tone maps
 * without a scotopic stage, so the moonlight carries the shift for what it lights:
 * Y is the luminance of a white Lambertian surface facing the moon, illuminance / pi. Under the half moon (0.02 lux)
 * that is fully the night's blue; the shift fades out toward a full moon high in the sky.
 * @throws RangeError for a phase outside -1 to 1, a zero or non-finite direction, or an extinction outside 0 to 2.
 * @example
 * const light = moonlight(0.75, [-0.45, 0.42, -1]);
 * // light.illuminance: 0.078 lux; light.color: the night's blue; light.intensity: lux over the colour's luminance
 */
export function moonlight(
  phase: number,
  direction: ArrayLike<number>,
  extinction = MOON_EXTINCTION,
  out: Moonlight = { illuminance: 0, color: [0, 0, 0], intensity: 0 },
): Moonlight {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(phase >= -1 && phase <= 1) || !(length > 0 && Number.isFinite(length)) || !(extinction >= 0 && extinction <= 2))
    throw new RangeError(
      'Invalid moonlight; give a phase from -1 to 1, a finite non-zero direction and an extinction from 0 to 2 magnitudes per airmass.',
    );
  const a = (Math.acos(phase) * 180) / Math.PI,
    above = 10 ** (-0.4 * (3.84 + 0.026 * a + 4e-9 * a ** 4)) * 10.7639,
    up = direction[1] / length,
    illuminance = up > 0 ? above * 10 ** (-0.4 * extinction * moonAirmass(up)) : 0,
    color = moonlightColor(illuminance, out.color);
  out.illuminance = illuminance;
  out.intensity = illuminance / (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]);
  return out;
}

/**
 * The colour of moonlight that gives `illuminance` lux on a surface facing the moon, written into `out` (linear sRGB,
 * largest channel 1): the moon's 4,943 K shifted toward the night's blue as the light falls toward scotopic levels, by
 * the rule {@link moonlight} documents (Jensen et al. 2000). The sky colours its moonlight with it after `brightness`
 * and cloud cover have changed the illuminance, so a dimmer moon is also a bluer one. `source` (linear sRGB, any scale)
 * replaces the moon's own colour as the light the shift starts from, as the red presets of {@link moonLook} do.
 * @throws RangeError for a negative or non-finite illuminance.
 * @example
 * moonlightColor(0.3); // a full moon high up: close to the moon's own 4,943 K
 * moonlightColor(0.002); // under thick cloud: the night's blue
 * @throws RangeError for a black or invalid `source`.
 */
export function moonlightColor(
  illuminance: number,
  out: [number, number, number] = [0, 0, 0],
  source?: ArrayLike<number>,
): [number, number, number] {
  if (!(illuminance >= 0 && Number.isFinite(illuminance)))
    throw new RangeError('Invalid moonlight illuminance; give a finite number of lux, 0 or more.');
  let x = MOON_X,
    y = MOON_Y;
  if (source) {
    // Linear sRGB to CIE XYZ (IEC 61966-2-1), then to its chromaticity.
    const [r, g, b] = [source[0], source[1], source[2]],
      X = 0.4124 * r + 0.3576 * g + 0.1805 * b,
      Y = 0.2126 * r + 0.7152 * g + 0.0722 * b,
      sum = X + Y + 0.0193 * r + 0.1192 * g + 0.9505 * b;
    if (!(sum > 0 && Number.isFinite(sum)))
      throw new RangeError('Invalid moonlight source colour; give non-negative linear RGB, not black.');
    x = X / sum;
    y = Y / sum;
  }
  const t = Math.max(0, Math.min(1, (Math.log10(illuminance / Math.PI) + 2) / 2.6)),
    s = t * t * (3 - 2 * t),
    color = chromaticityToLinearSRGB((1 - s) * BLUE + s * x, (1 - s) * BLUE + s * y, scratch);
  for (let i = 0; i < 3; i++) out[i] = color[i];
  return out;
}

/**
 * The share of a light's illuminance that reaches the ground under `cover` (0 clear to 1 overcast, the fraction of the
 * sky the cloud hides): 1 - 0.75 cover^3.4. F. Kasten and G. Czeplak, "Solar and terrestrial radiation dependent on
 * the amount and type of cloud", Solar Energy 24(2):177-189, 1980, fitted it to ten years of hourly global
 * irradiance at Hamburg (cover N/8, N in oktas): a clear sky passes all of it, a sky
 * half covered 93%, an overcast one a quarter. It is the global (direct plus diffuse) share, so it is the light a
 * scene lit by one moon light should still receive. The cloud scatters it with no colour of its own (droplets far
 * larger than the wavelength scatter all of it alike; C. F. Bohren, "Multiple scattering of light and some of its
 * observable consequences", Am. J. Phys. 55(6):524-533, 1987), so the colour changes only through the dimmer level
 * the eye sees it at ({@link moonlightColor}).
 * @throws RangeError for a cover outside 0 to 1.
 * @example
 * cloudTransmittance(1); // 0.25: an overcast night lets a quarter of the moonlight through
 */
export function cloudTransmittance(cover: number): number {
  if (!(cover >= 0 && cover <= 1)) throw new RangeError('Invalid cloud cover; give a fraction of the sky from 0 to 1.');
  return 1 - 0.75 * cover ** 3.4;
}

/**
 * The Krisciunas and Schaefer airmass of a moon `up` (the sine of its altitude) above the horizon:
 * (1 - 0.96 sin^2 z)^(-1/2), z the zenith angle (their eq. 3), as {@link moonlight} uses it.
 */
export function moonAirmass(up: number): number {
  return 1 / Math.sqrt(1 - 0.96 * (1 - up * up));
}

/** `lighting.moon.brightness` presets: see {@link moonLook}. */
export type MoonBrightnessName = 'bright' | 'dim';
/** `lighting.moon.color` presets, the red moons: see {@link moonLook}. */
export type MoonColorName = 'blood' | 'reddened';

/** What {@link moonLook} returns: the factors a preset applies to the moon's light and to its drawn disc. */
export interface MoonLook {
  /** Factor on the moonlight's illuminance. */
  light: number;
  /** Factor on the drawn disc's angular radius. */
  size: number;
  /** Factor on the drawn disc's linear RGB colour. */
  disc: [number, number, number];
  /** The linear sRGB colour the moonlight starts from before the night's blue shift; undefined for the moon's own. */
  source: [number, number, number] | undefined;
}

// Mean and closest perigee distances of the Moon, km (Meeus 1998, ch. 50: 384,400 and 356,375).
const PERIGEE = 384400 / 356375;
// Thin cloud before the moon halves its illuminance: P. M. Janiczek and J. A. DeYoung, "Computer programs for sun and
// moon illuminance with contingent tables and diagrams", U.S. Naval Observatory Circular 171, 1987 (illuminance divided
// by 1 for a clear sky, 2 for thin clouds, 3 for average clouds, 10 for dark stratus).
const THIN_CLOUD = 0.5;
// The totally eclipsed moon at mid-totality: about V = -2.8, the mean of observers' estimates for the central eclipses
// of 2007 March 3 (-2.3 to -2.5) and 2008 February 21 (-3.2 to -3.4) reported by Sky and Telescope; the full moon is
// V = -12.74 (Allen's Astrophysical Quantities, 4th ed., 2000). 10^(-0.4 x 9.94) = 1.06e-4 of the full moon's light.
const ECLIPSE = 10 ** (-0.4 * (12.74 - 2.8));
// The sky's air (Hillaire 2020 Table 1, the ozone tent from Bruneton 2017, as atmosphere-luts.ts): Rayleigh per km at
// sea level with an 8 km scale height, ozone per km at its 25 km peak falling to 0 at 15 km either side; Earth 6,360 km.
const RAYLEIGH = [0.005802, 0.013558, 0.0331],
  OZONE = [0.00065, 0.001881, 0.000085];
// The moon at 5 degrees, where it rises orange: Kasten and Young's airmass (F. Kasten and A. T. Young, "Revised optical
// air mass tables and approximation formula", Applied Optics 28(22):4735-4738, 1989), 10.3; the Krisciunas and
// Schaefer fit of moonAirmass reads 4.6 there, as it is fitted for the sky away from the horizon.
const LOW = 5,
  LOW_AIRMASS = 1 / (Math.sin((LOW * Math.PI) / 180) + 0.50572 * (LOW + 6.07995) ** -1.6364),
  // Sunlight reaching the umbra's middle is refracted through the limb's lower stratosphere, above the cloud tops
  // (A. Garcia Munoz and E. Palle, "Lunar eclipse theory revisited: scattered sunlight in both the quiescent and the
  // volcanically perturbed atmosphere", JQSRT 112(10):1609-1621, 2011): a chord grazing 12 km up, through the whole
  // limb. Its column of air is e^(-12/8) sqrt(2 pi R H) = 126 km at sea-level density.
  LIMB = 12;
let transmissions: { low: number[]; limb: number[] } | undefined;
const transmission = () => {
  if (transmissions) return transmissions;
  // The ozone tent along the limb chord, at height 12 + s^2 / 2R a distance s from the grazing point, in 1 km steps.
  let limbOzone = 0;
  for (let s = 0.5; s < 700; s++) limbOzone += 2 * Math.max(0, 1 - Math.abs(LIMB + (s * s) / 12720 - 25) / 15);
  const limbAir = Math.exp(-LIMB / 8) * Math.sqrt(2 * Math.PI * 6360 * 8);
  return (transmissions = {
    low: RAYLEIGH.map((r, i) => Math.exp(-(r * 8 + OZONE[i] * 15) * LOW_AIRMASS)),
    limb: RAYLEIGH.map((r, i) => Math.exp(-(r * limbAir + OZONE[i] * limbOzone))),
  });
};

/**
 * The moon presets of `lighting.moon`: what `brightness` and `color` do to the moon's light and to the disc the sky
 * draws. A number `brightness` scales both. The presets, each from measurements:
 *
 * - `'bright'`, the perigee supermoon: the Moon at its closest, 356,375 km against a mean 384,400 km (Meeus 1998,
 *   ch. 50), gives (384,400 / 356,375)^2 = 1.164 times the light, and its disc is 1.079 times as wide. Its surface is as
 *   bright as ever: only the disc grows.
 * - `'dim'`, the moon behind a thin veil of cloud: half the light (USNO Circular 171, Janiczek and DeYoung 1987) and a
 *   disc half as bright.
 * - `'blood'`, the moon in a total lunar eclipse: lit only by sunlight refracted through the Earth's limb, reddened by
 *   the air along a chord grazing 12 km up (Garcia Munoz and Palle 2011; Rayleigh and ozone as the sky's own air), with
 *   1.06e-4 of the full moon's light (V = -2.8 at mid-totality against -12.74).
 * - `'reddened'`, the orange moon low on the horizon: seen through the air of a moon 5 degrees up (Kasten and Young
 *   1989 airmass 10.3, Rayleigh and ozone as the sky's own), its light dimmed by `extinction` over that airmass instead
 *   of over the moon's own altitude (`up`, the sine of it).
 *
 * The light is photometric, so it takes the factor whole; a red moon's light is then dim enough that the night's blue
 * shift ({@link moonlightColor}) takes most of its red, as the eye does. The disc is the stylized night's, drawn in
 * display terms, so it takes the change as the eye judges it: Stevens' power law, brightness as luminance^0.33 for a
 * dark-adapted eye (S. S. Stevens, "To honor Fechner and repeal his law", Science 133(3446):80-86, 1961), and the red
 * presets' colour at that luminance.
 * @throws RangeError for an unknown preset or an invalid number.
 * @example
 * const look = moonLook('bright', 'blood'); // a supermoon in eclipse
 */
export function moonLook(
  brightness: number | MoonBrightnessName = 1,
  color?: MoonColorName | ArrayLike<number>,
  up = 1,
  extinction = MOON_EXTINCTION,
): MoonLook {
  let light = 1,
    size = 1,
    tint: number[] | undefined;
  if (brightness === 'bright') {
    light = PERIGEE * PERIGEE;
    size = PERIGEE;
  } else if (brightness === 'dim') light = THIN_CLOUD;
  else if (typeof brightness === 'number' && brightness >= 0 && Number.isFinite(brightness)) light = brightness;
  else
    throw new RangeError(
      `Invalid moon brightness ${String(brightness)}; give a number of 0 or more, 'bright' or 'dim'.`,
    );
  // The disc's surface brightness changes with everything but the distance.
  let surface = light / (size * size);
  if (color === 'blood') {
    tint = transmission().limb;
    light *= ECLIPSE;
    surface *= ECLIPSE;
  } else if (color === 'reddened') {
    tint = transmission().low;
    const f = Math.min(1, 10 ** (-0.4 * extinction * (LOW_AIRMASS - moonAirmass(Math.max(0, Math.min(1, up))))));
    light *= f;
    surface *= f;
  } else if (typeof color === 'string')
    throw new RangeError(`Invalid moon color ${color}; give linear RGB, 'blood' or 'reddened'.`);
  const k = surface ** (1 / 3),
    t = tint ?? [1, 1, 1],
    y = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  let source: [number, number, number] | undefined;
  if (tint) {
    const own = chromaticityToLinearSRGB(MOON_X, MOON_Y, [0, 0, 0]);
    source = [own[0] * tint[0], own[1] * tint[1], own[2] * tint[2]];
  }
  return { light, size, disc: [(k * t[0]) / y, (k * t[1]) / y, (k * t[2]) / y], source };
}
