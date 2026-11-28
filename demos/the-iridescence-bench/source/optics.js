import { thinFilmColor, thinFilmReflectance } from '@margoengine/optics/interference';
import { SpectralIntegrator } from '@margoengine/optics/spectrum';

export const radians = Math.PI / 180;
// The bench film: titanium dioxide (n 2.32) on crown glass (n 1.52), lit by daylight.
export const filmIndex = 2.32;
export const glassIndex = 1.52;
const daylight = new SpectralIntegrator({ min: 380, max: 740, step: 4, illuminant: 6504 });
const film = (thickness) => ({ filmIndex, thickness, substrateIndex: glassIndex });
const rgb = [0, 0, 0];

export const reflectance = (wavelength, thickness, angle) => thinFilmReflectance(film(thickness), wavelength, angle * radians);

export function reflectedColor(thickness, angleRadians) {
  thinFilmColor(film(thickness), angleRadians, daylight, rgb);
  return rgb.map((value) => Math.max(0, Math.min(1, value)));
}
