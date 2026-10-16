// Independent numerical spectral integration for the KHR thin-film model.
// Unlike the GPU helper's closed Fourier transform, this reference integrates
// the fitted CIE sensitivities over inverse wavelength using Simpson quadrature.
// The Gaussian fits and interface model are the Khronos/Belcour reference:
// https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_iridescence
const pi = Math.PI,
  intervals = 4096,
  maxFrequency = 4e6,
  step = maxFrequency / intervals;
const fits = [
  [
    [5.4856e-13, 1.681e6, 4.3278e9],
    [9.747e-14, 2.2399e6, 4.5282e9],
  ],
  [[4.4201e-13, 1.7953e6, 9.3046e9]],
  [[5.2481e-13, 2.2084e6, 6.6121e9]],
];
const curves = fits.map((channel) =>
  Float64Array.from({ length: intervals + 1 }, (_, index) => {
    const frequency = index * step,
      weight = index === 0 || index === intervals ? 1 : index % 2 ? 4 : 2;
    return (
      (channel.reduce(
        (sum, [amplitude, center, variance]) =>
          sum + (amplitude / Math.SQRT2) * Math.exp(-((frequency - center) ** 2) / (4 * variance)),
        0,
      ) *
        weight *
        step) /
      3 /
      1.0685e-7
    );
  }),
);
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const rgb = (xyz) => [
  3.2404542 * xyz[0] - 1.5371385 * xyz[1] - 0.4985314 * xyz[2],
  -0.969266 * xyz[0] + 1.8760108 * xyz[1] + 0.041556 * xyz[2],
  0.0556434 * xyz[0] - 0.2040259 * xyz[1] + 1.0572252 * xyz[2],
];
const schlick = (f0, cosine) => f0 + (1 - f0) * (1 - cosine) ** 5;

export function iridescenceReference({
  cosTheta,
  outsideIor = 1,
  filmIor = 1.3,
  thicknessNm = 400,
  baseF0 = [0.04, 0.04, 0.04],
}) {
  const cosine = clamp(cosTheta),
    base = baseF0.map((value) => clamp(value));
  if (thicknessNm <= 0) return base.map((value) => schlick(value, cosine));
  const outside = clamp(outsideIor, 1e-4, 1e8),
    blend = clamp(thicknessNm / 0.03),
    film = outside + (clamp(filmIor, 1e-4, 1e8) - outside) * (blend * blend * (3 - 2 * blend));
  if (film === outside) return base.map((value) => schlick(value, cosine));
  const cosine2Squared = 1 - (outside / film) ** 2 * (1 - cosine * cosine);
  if (cosine2Squared < 0) return [1, 1, 1];
  const cosine2 = Math.sqrt(cosine2Squared),
    r12 = schlick(((film - outside) / (film + outside)) ** 2, cosine),
    transmitted = 1 - r12;
  const substrate = base.map((value) => {
    const root = Math.sqrt(Math.min(value, 0.9999));
    return (1 + root) / (1 - root);
  });
  const r23 = substrate.map((ior) => schlick(((ior - film) / (ior + film)) ** 2, cosine2)),
    products = r23.map((value) => clamp(r12 * value, 1e-5, 0.9999)),
    internal = r23.map((value, channel) => (transmitted * transmitted * value) / (1 - products[channel]));
  const result = internal.map((value) => r12 + value),
    opticalPath = 2 * film * cosine2 * thicknessNm;
  if (opticalPath > 100000) return result.map((value) => clamp(value));
  const phase = substrate.map((ior) => (film < outside ? 0 : pi) + (ior < film ? pi : 0));
  // Integrating cos(m*(2*pi*OPD*sigma + phase)) recovers the two interference
  // harmonics without using the shader's analytic Gaussian Fourier expression.
  for (let order = 1; order <= 2; order++) {
    const xyz = curves.map((curve, channel) => {
        let sum = 0;
        for (let index = 0; index <= intervals; index++)
          sum += curve[index] * Math.cos(order * (2 * pi * opticalPath * 1e-9 * index * step + phase[channel]));
        return sum;
      }),
      sensitivity = rgb(xyz);
    for (let channel = 0; channel < 3; channel++)
      result[channel] +=
        2 * (internal[channel] - transmitted) * products[channel] ** (order / 2) * sensitivity[channel];
  }
  return result.map((value) => clamp(value));
}

export const iridescenceCases = [
  { cosTheta: 1, filmIor: 1.3, thicknessNm: 100, baseF0: [0.04, 0.04, 0.04] },
  { cosTheta: 0.5, filmIor: 1.3, thicknessNm: 250, baseF0: [0.04, 0.04, 0.04] },
  { cosTheta: 0.1, filmIor: 1.3, thicknessNm: 400, baseF0: [0.04, 0.04, 0.04] },
  { cosTheta: 0.5, filmIor: 2, thicknessNm: 400, baseF0: [0.04, 0.04, 0.04] },
  { cosTheta: 0.7, filmIor: 1.3, thicknessNm: 800, baseF0: [0.8, 0.3, 0.05] },
  { cosTheta: 0.3, filmIor: 1.7, thicknessNm: 350, baseF0: [0.8, 0.04, 0.005] },
  { cosTheta: 0.4, filmIor: 1.3, thicknessNm: 0, baseF0: [0.04, 0.2, 1] },
  { cosTheta: 0.2, outsideIor: 1.5, filmIor: 1, thicknessNm: 400, baseF0: [0.04, 0.04, 0.04] },
  { cosTheta: 0.5, filmIor: 1, thicknessNm: 400, baseF0: [0.04, 0.2, 0.8] },
  { cosTheta: 0.4, filmIor: 1.3, thicknessNm: 1e30, baseF0: [0.04, 0.2, 1] },
];
