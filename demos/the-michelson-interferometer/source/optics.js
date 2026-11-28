import { michelsonFringes, michelsonIntensity, michelsonTilt } from '@margoengine/optics/interference';

// The bench: a helium-neon laser, one micrometre of travel (3.16 fringes, so no two slider stops show the same
// bands), and tilt fringes 26 mm apart on the screen. The stage is drawn moving travelScale times its real distance.
export const wavelengthNm = 632.8, mirrorPeriodNm = wavelengthNm / 2, travelNm = 1000, travelScale = 40000;
export const carrierMeters = .026, visibility = .96, mirrorTilt = michelsonTilt(wavelengthNm, carrierMeters);
const fringes = { wavelength: wavelengthNm, fringeSpacing: carrierMeters, visibility };
export const opticalPathNm = (mirrorNm) => 2 * mirrorNm;
export const fringeCount = (mirrorNm) => michelsonFringes(mirrorNm, wavelengthNm);
export const fringeIntensity = (x, mirrorNm) => michelsonIntensity(x, mirrorNm, fringes);
