export const radians = Math.PI / 180;
export const filmIndex = 2.32;
export const glassIndex = 1.52;
const daylight = 6504;
const secondRadiationConstant = 1.438776877e7;

function lobe(wavelength, center, lower, upper) {
  const distance = wavelength - center;
  return Math.exp(-.5 * (distance * (distance < 0 ? lower : upper)) ** 2);
}

// The standard-observer approximations use the published parameters in Wyman et al., Table 1.
function observer(w) {
  return [
    .362 * lobe(w, 442, .0624, .0374) + 1.056 * lobe(w, 599.8, .0264, .0323) - .065 * lobe(w, 501.1, .049, .0382),
    .821 * lobe(w, 568.8, .0213, .0247) + .286 * lobe(w, 530.9, .0613, .0322),
    1.217 * lobe(w, 437, .0845, .0278) + .681 * lobe(w, 459, .0385, .0725),
  ];
}

function toRgb(x, y, z) {
  return [
    3.2406 * x - 1.5372 * y - .4986 * z,
    -.9689 * x + 1.8758 * y + .0415 * z,
    .0557 * x - .2040 * y + 1.0570 * z,
  ];
}

const samples = Array.from({ length: 91 }, (_, index) => {
  const wavelength = 380 + 4 * index;
  const illumination = (550 / wavelength) ** 5 / Math.expm1(secondRadiationConstant / (wavelength * daylight));
  const endpoint = index === 0 || index === 90 ? .5 : 1;
  return { wavelength, weight: observer(wavelength).map((value) => value * illumination * endpoint) };
});
const white = toRgb(...samples.reduce((total, { weight }) =>
  total.map((value, channel) => value + weight[channel]), [0, 0, 0]));

function fresnelParameters(angle) {
  const sin = Math.sin(angle);
  const c0 = Math.cos(angle), c1 = Math.sqrt(1 - (sin / filmIndex) ** 2), c2 = Math.sqrt(1 - (sin / glassIndex) ** 2);
  const rs01 = (c0 - filmIndex * c1) / (c0 + filmIndex * c1);
  const rs12 = (filmIndex * c1 - glassIndex * c2) / (filmIndex * c1 + glassIndex * c2);
  const rp01 = (filmIndex * c0 - c1) / (filmIndex * c0 + c1);
  const rp12 = (glassIndex * c1 - filmIndex * c2) / (glassIndex * c1 + filmIndex * c2);
  return { rs01, rs12, rp01, rp12, opticalPhase: 4 * Math.PI * filmIndex * c1 };
}

function power(a, b, phaseCosine) {
  const cross = 2 * a * b * phaseCosine;
  return (a * a + b * b + cross) / (1 + (a * b) ** 2 + cross);
}

function atWavelength(wavelength, thickness, model) {
  const phase = Math.cos(model.opticalPhase * thickness / wavelength);
  return .5 * (power(model.rs01, model.rs12, phase) + power(model.rp01, model.rp12, phase));
}

export function reflectance(wavelength, thickness, angle) {
  return atWavelength(wavelength, thickness, fresnelParameters(angle * radians));
}

export function reflectedColor(thickness, angleRadians) {
  const model = fresnelParameters(angleRadians);
  let x = 0, y = 0, z = 0;
  for (const { wavelength, weight } of samples) {
    const value = atWavelength(wavelength, thickness, model);
    x += value * weight[0];
    y += value * weight[1];
    z += value * weight[2];
  }
  return toRgb(x, y, z).map((value, index) => Math.max(0, Math.min(1, value / white[index])));
}
