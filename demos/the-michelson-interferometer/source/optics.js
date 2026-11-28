import { michelsonFringes, michelsonIntensity, michelsonTilt } from '@margoengine/optics/interference';

// The bench: a helium-neon laser, four half-wave steps of travel, and tilt fringes 26 mm apart on the screen.
export const wavelengthNm = 632.8, mirrorPeriodNm = wavelengthNm / 2, travelNm = 4 * mirrorPeriodNm;
export const carrierMeters = .026, visibility = .96, mirrorTilt = michelsonTilt(wavelengthNm, carrierMeters);
const fringes = { wavelength: wavelengthNm, fringeSpacing: carrierMeters, visibility };
export const opticalPathNm = (mirrorNm) => 2 * mirrorNm;
export const fringeCount = (mirrorNm) => michelsonFringes(mirrorNm, wavelengthNm);
export const fringeIntensity = (x, mirrorNm) => michelsonIntensity(x, mirrorNm, fringes);
