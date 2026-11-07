import { EARTH_ATMOSPHERE, atmosphereParameters, type AtmosphereParameters } from './atmosphere-luts.js';
import type { Vec3 } from '@margoengine/math';
/** A world's air and the sunlight at its distance: spread it into `HillaireSky` or `AerialPerspective` options. */
export interface PlanetPreset {
  /** The atmosphere, kilometres, every field filled. */
  readonly atmosphere: Readonly<Required<AtmosphereParameters>>;
  /** Sun illuminance at the top of the air in the sky's units: 20 at Earth, times the sunlight's share elsewhere. */
  readonly sunIlluminance: number;
}
// Earth: Hillaire 2020 Table 1, the default of every Hillaire entry, with its default sun.
/** Earth: the Hillaire entries' defaults (Hillaire 2020 Table 1, ozone from Bruneton 2017). */
export const EARTH: PlanetPreset = Object.freeze({ atmosphere: EARTH_ATMOSPHERE, sunIlluminance: 20 });
// Mars, from NASA's Mars Fact Sheet (Williams, NSSDCA): mean radius 3389.5 km, 6.36 mb and about 214 K at the mean
// radius, scale height 11.0 km, 95.1% CO2, Bond albedo 0.250, sunlight 586.2 / 1361.0 = 0.431 of Earth's.
// Rayleigh: CO2's cross section 12.4e-27 cm^2 at 532 nm (Sneep and Ubachs 2005) scaled as 1 / lambda^4 to Hillaire's
// 680, 550 and 440 nm, times the number density p / (k T) = 636 Pa / (1.380649e-23 J/K x 214 K) = 2.153e23 /m^3.
const k = 1.380649e-23,
  density = 636 / (k * 214),
  cross = 12.4e-31,
  rayleigh = [680, 550, 440].map((l) => cross * (532 / l) ** 4 * density * 1000) as unknown as Vec3;
// Dust: well mixed with the gas (scale height 11 km), extinction grey across the visible (particles of about 1.5 um),
// single scattering albedo 0.975 in the red (Wolff et al. 2009), 0.94 in the green (the MGS/TES solar band value of
// 0.93 to 0.94 quoted by Wolff et al. 2008) and 0.90 in the blue (Margo's reading of the
// fall toward 440 nm in Wolff et al. 2009, inside the published solar band range 0.86 to 0.94); asymmetry 0.67
// (Chen-Chen et al. 2019, MSL sky radiance, 0.673 +- 0.081).
const albedo = [0.975, 0.94, 0.9];
/**
 * Mars's atmosphere with `opticalDepth` of dust (vertical, visible): about 0.5 on a clear day at the rover sites
 * (Lemmon et al. 2015), 1 to 2 in a regional storm, 4 and more in a global one. The dust absorbs blue more than red,
 * which gives the butterscotch day sky. 0 to 10.
 * @throws RangeError when `opticalDepth` is out of range.
 */
export function marsAtmosphere(opticalDepth = 0.5): Readonly<Required<AtmosphereParameters>> {
  if (!(Number.isFinite(opticalDepth) && opticalDepth >= 0 && opticalDepth <= 10))
    throw new RangeError('Invalid Mars dust optical depth; use a number from 0 to 10');
  const extinction = opticalDepth / 11;
  return Object.freeze(
    atmosphereParameters({
      bottomRadius: 3389.5,
      topRadius: 3489.5,
      rayleigh,
      rayleighHeight: 11,
      mie: albedo.map((w) => extinction * w) as unknown as Vec3,
      mieAbsorption: albedo.map((w) => extinction * (1 - w)) as unknown as Vec3,
      mieHeight: 11,
      mieG: 0.67,
      ozone: [0, 0, 0],
      groundAlbedo: [0.25, 0.25, 0.25],
    }),
  );
}
/** Mars on a clear day (dust optical depth 0.5), with 0.431 of Earth's sunlight. */
export const MARS: PlanetPreset = Object.freeze({ atmosphere: marsAtmosphere(), sunIlluminance: 20 * 0.431 });
