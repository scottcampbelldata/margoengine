import { multilayerReflectance, quarterWaveStack } from '@margoengine/optics/interference';
import { SpectralIntegrator } from '@margoengine/optics/spectrum';

export const radians = Math.PI / 180;
export const designWavelength = 526;

// Sixteen quarter-wave layers, titania-like H = 2.20 and silica-like L = 1.47, on crown glass.
const stack = { layers: quarterWaveStack(2.20, 1.47, 8, designWavelength).slice(0, 16), substrateIndex: 1.52 };
// A 6504 K black body sampled every 4 nm from 380 to 740 nm.
const integrator = new SpectralIntegrator({ min: 380, max: 740, step: 4 });

export function reflectance(wavelength, degrees) {
  return multilayerReflectance(stack, wavelength, degrees * radians);
}

export function reflectionDirection(degrees) {
  return [Math.sin(2*degrees*radians),0,Math.cos(2*degrees*radians)];
}

const clamp01 = (rgb) => rgb.map((value) => Math.max(0, Math.min(1, value)));

export function splitSpectrum(degrees) {
  const reflected = (nm) => reflectance(nm, degrees);
  return {
    reflected: clamp01(integrator.color(reflected)),
    transmitted: clamp01(integrator.color((nm) => 1 - reflected(nm))),
    fraction: integrator.luminance(reflected),
  };
}
