import { photoelasticColors, photoelasticRetardation } from '@margoengine/optics/polarization';

export const radians = Math.PI / 180;
export const specimenRadius = .143;
export const stressOptic = 67e-12; // Illustrative photoelastic polymer, per pascal.
export const lutLength = 2048;
export const maxRetardationNm = 6400;

/** Retardation at the centre of the squeezed disc, where sigma1 - sigma2 = 4 F / (pi R t); the thickness cancels. */
export const centerRetardationNm = (force) =>
  photoelasticRetardation(stressOptic, 1, 4 * force / (Math.PI * specimenRadius));

/** Michel-Levy colours for 0..maxRetardationNm between crossed polarisers, as an RGBA8 strip. */
export function createSpectrum() {
  const colors = photoelasticColors(maxRetardationNm, lutLength, { min: 380, max: 740, step: 4, illuminant: 6504 });
  const data = new Uint8Array(lutLength * 4);
  for (let i = 0; i < lutLength; i++) {
    // Keep a little signed out-of-gamut range so complementary channels can be reconstructed before clipping.
    for (let k = 0; k < 3; k++) data[4 * i + k] = Math.round(255 * Math.max(0, Math.min(1, (colors[3 * i + k] + .15) / 1.30)));
    data[4 * i + 3] = 255;
  }
  return data;
}
