import { circularPointSpread, fresnelNumber as apertureFresnelNumber } from '@margoengine/optics/diffraction';
import { pinholeImage } from '@margoengine/optics/imaging';

// The array: green light, a target 880 mm away, a sensor 280 mm behind three pinholes of 0.31, 0.60 and 1.32 mm.
export const wavelength = 532e-9;
export const sourceDistance = .88;
export const sensorDistance = .28;
export const diameterMm = [.31, .60, 1.32];
export const profileLength = 256;
export const profileRadius = .003;
export const magnification = -sensorDistance / sourceDistance;
export const target = [
  [-.00348, -.00242], [-.00115, -.00242],
  [.00112, .00187], [.00271, .00187], [.00403, -.00062],
];

export const imagePosition = ([x, y]) => pinholeImage(x, y, sourceDistance, sensorDistance);
export const fresnelNumber = (radius) => apertureFresnelNumber(radius, wavelength, sourceDistance, sensorDistance);

export const pointSpread = (mm, conjugateFresnel = fresnelNumber(mm * .0005)) => circularPointSpread({
  radius: mm * .0005, wavelength, distance: sensorDistance, fresnelNumber: conjugateFresnel,
  maxRadius: profileRadius, samples: profileLength,
});

export function sampleArray(scale) {
  const mm = diameterMm.map((size) => size * scale);
  const profiles = mm.map((diameter) => pointSpread(diameter));
  const column = new Uint8Array(profileLength * 4);
  for (let i = 0; i < profileLength; i++) {
    for (let channel = 0; channel < 3; channel++) {
      const { values, peak } = profiles[channel];
      column[4 * i + channel] = Math.round(Math.sqrt(values[i] / peak) * 255);
    }
    column[4 * i + 3] = 255;
  }
  return { mm, profiles, column };
}
