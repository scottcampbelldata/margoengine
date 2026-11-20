// Twilight: the light the sky still gives after the sun has set, from the U.S. Naval Observatory's measured
// illuminance against the sun's altitude and the colour of sunlight scattered down from the air above the shadow.
import { moonlightColor } from './moonlight.js';

/**
 * The sun's illuminance in lux on a surface facing it, the sun at the zenith under a clear sky: 133,775 lux above the
 * air times e^-0.21 through it, 108,437 lux (Janiczek and DeYoung, USNO Circular 171, 1987). The sky's sun light is 1
 * at noon times `lighting.intensity`; give `intensity: SUN_ILLUMINANCE` for a scene lit in lux, as the moon is.
 */
export const SUN_ILLUMINANCE = 133775 * Math.exp(-0.21);

/**
 * Horizontal illuminance in lux from the twilight sky under a clear sky, for the sun `elevation` radians above the
 * horizon (negative below), with no direct sunlight: the sky term of P. M. Janiczek and J. A. DeYoung, "Computer
 * programs for sun and moon illuminance with contingent tables and diagrams", U.S. Naval Observatory Circular 171,
 * 1987. With X = 753.66156, U = sin h, S = asin(X cos h / (X + 1)) and M = X (cos S - U) + cos S, it is
 * 133,775 x 0.0289 e^(-0.042 M) (1 + (h + 90) U / 57.29578), h in degrees: 756 lux at sunset, 2.99 lux at the end of
 * civil twilight (-6 degrees), 0.0043 at the end of nautical twilight (-12), 7e-6 at astronomical (-18).
 * @throws RangeError for a non-finite elevation.
 * @example twilightIlluminance((-6 * Math.PI) / 180); // 2.99 lux
 */
export function twilightIlluminance(elevation: number): number {
  if (!Number.isFinite(elevation)) throw new RangeError('Invalid sun elevation; give finite radians.');
  const h = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, elevation)),
    u = Math.sin(h),
    x = 753.66156,
    c = Math.cos(Math.asin((x * Math.cos(h)) / (x + 1))),
    m = x * (c - u) + c;
  return 133775 * 0.0289 * Math.exp(-0.042 * m) * (1 + (((h * 180) / Math.PI + 90) * u) / 57.29578);
}

// The sky's air (Hillaire 2020 Table 1, the ozone tent of Bruneton 2017, as atmosphere-luts.ts): Rayleigh per km at sea
// level, 8 km scale height; ozone per km at its 25 km peak, falling to 0 15 km either side; Earth 6,360 km.
const RAYLEIGH = [0.005802, 0.013558, 0.0331],
  OZONE = [0.00065, 0.001881, 0.000085],
  R = 6360;
const ozone = (h: number) => Math.max(0, 1 - Math.abs(h - 25) / 15);
let cached = NaN;
const CIVIL = (6 * Math.PI) / 180;
const color: [number, number, number] = [0, 0, 0],
  sum = [0, 0, 0];
/**
 * The colour of the twilight sky's light (linear sRGB, largest channel 1) for the sun `depression` radians below the
 * horizon, before the eye's night shift: sunlight scattered once by the air over the observer. Each height
 * of the zenith column the sun still reaches scatters by Rayleigh's law the sunlight left after its grazing path
 * through the air and the ozone layer, which then crosses the column below. The ozone's Chappuis band takes the
 * orange out of the long grazing path, which is why the twilight sky is blue, not yellow (E. O. Hulburt,
 * "Explanation of the brightness and color of the sky, particularly the twilight sky", JOSA 43(2):113-118, 1953).
 * Past the end of civil twilight (6 degrees) the colour holds: the shadow then stands 35 km over the observer, the
 * single-scattered light comes from thin air reached only by grazing, reddened beams, and multiply scattered light
 * takes over, which single scattering cannot follow; there the light is dim enough that the eye's night shift
 * (twilightLightColor) makes it the night's blue, as measured: bluest in nautical twilight (M. Spitschan, G. K.
 * Aguirre, D. H. Brainard and A. M. Sweeney, "Variation of outdoor illumination as a function of solar elevation and
 * light pollution", Scientific Reports 6:26756, 2016). Recomputed only when the depression changes.
 * @throws RangeError for a non-finite depression.
 */
export function twilightColor(depression: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  if (!Number.isFinite(depression)) throw new RangeError('Invalid sun depression; give finite radians.');
  const d = Math.max(0, Math.min(CIVIL, depression));
  if (d !== cached) {
    const sin = Math.sin(d);
    sum.fill(0);
    let below = 0;
    for (let z = 0.5; z < 100; z++) {
      const r = R + z;
      below += ozone(z - 0.5);
      // The sunbeam to this height passes below the ground: the Earth's shadow.
      if (r * Math.cos(d) < R) continue;
      // Along the beam from the point toward the sun, down to its lowest point and out of the air, in 4 km steps.
      let air = 0,
        layer = 0;
      for (let s = 2; s < 2400; s += 4) {
        const h = Math.sqrt(r * r + s * s - 2 * r * s * sin) - R;
        if (h > 100) break;
        air += Math.exp(-h / 8) * 4;
        layer += ozone(h) * 4;
      }
      // Scattered at z and carried down the column below (8 (1 - e^(-z/8)) km of sea-level air).
      const down = 8 * (1 - Math.exp(-z / 8));
      for (let i = 0; i < 3; i++)
        sum[i] += RAYLEIGH[i] * Math.exp(-z / 8 - RAYLEIGH[i] * (air + down) - OZONE[i] * (layer + below));
    }
    const peak = Math.max(sum[0], sum[1], sum[2]) || 1;
    for (let i = 0; i < 3; i++) color[i] = sum[i] / peak;
    cached = d;
  }
  out[0] = color[0];
  out[1] = color[1];
  out[2] = color[2];
  return out;
}

/**
 * The colour of twilight as the eye sees it at `illuminance` lux: {@link twilightColor} shifted toward the night's
 * blue by the rule moonlight follows (Jensen et al. 2000, {@link moonlightColor}).
 */
export function twilightLightColor(
  depression: number,
  illuminance: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  return moonlightColor(illuminance, out, twilightColor(depression, out));
}
