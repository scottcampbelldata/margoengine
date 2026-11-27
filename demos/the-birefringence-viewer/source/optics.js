export const radians = Math.PI / 180;
export const specimenRadius = .143;
export const stressOptic = 67e-12; // Illustrative photoelastic polymer, per pascal.
export const lutLength = 2048;
export const maxRetardationNm = 6400;

export function centerRetardationNm(force) {
  return 4e9 * stressOptic * force / (Math.PI * specimenRadius);
}

/** Dimensionless tensor difference and twice the shear, for diametric point loads. */
export function stressDifference(x, y) {
  const top = y - 1, bottom = y + 1;
  const rTop2 = x * x + top * top, rBottom2 = x * x + bottom * bottom;
  const first = 2 * top / (rTop2 * rTop2), second = -2 * bottom / (rBottom2 * rBottom2);
  return [
    first * (x * x - top * top) + second * (x * x - bottom * bottom),
    2 * x * (first * top + second * bottom),
  ];
}

export function transmission(wavelength, delay, axisFactor, parallel) {
  const crossed = axisFactor * Math.sin(Math.PI * delay / wavelength) ** 2;
  return parallel ? 1 - crossed : crossed;
}

function lobe(w, center, left, right) {
  const dx = w - center;
  return Math.exp(-.5 * (dx * (dx < 0 ? left : right)) ** 2);
}

// Piecewise Gaussian fits to the 1931 observer from Wyman, Sloan, and Shirley, Table 1.
function matching(w) {
  return [
    .362 * lobe(w,442,.0624,.0374) + 1.056 * lobe(w,599.8,.0264,.0323) - .065 * lobe(w,501.1,.049,.0382),
    .821 * lobe(w,568.8,.0213,.0247) + .286 * lobe(w,530.9,.0613,.0322),
    1.217 * lobe(w,437,.0845,.0278) + .681 * lobe(w,459,.0385,.0725),
  ];
}

function rgb(x, y, z) {
  return [
    3.2406 * x - 1.5372 * y - .4986 * z,
    -.9689 * x + 1.8758 * y + .0415 * z,
    .0557 * x - .2040 * y + 1.057 * z,
  ];
}

export function createSpectrum() {
  const samples = Array.from({ length: 91 }, (_, i) => {
    const w = 380 + i * 4;
    const lamp = (550 / w) ** 5 / Math.expm1(1.438776877e7 / (6504 * w));
    const edge = i === 0 || i === 90 ? .5 : 1;
    return [w, ...matching(w).map((value) => value * lamp * edge)];
  });
  const white = rgb(...samples.reduce(([x,y,z],[,a,b,c]) => [x + a, y + b, z + c], [0,0,0]));
  const data = new Uint8Array(lutLength * 4);
  for (let i = 0; i < lutLength; i++) {
    const delay = maxRetardationNm * i / (lutLength - 1);
    let x = 0, y = 0, z = 0;
    for (const [w, a, b, c] of samples) {
      const t = transmission(w, delay, 1, false);
      x += a * t;
      y += b * t;
      z += c * t;
    }
    const color = rgb(x,y,z);
    // Keep a little signed out-of-gamut range so complementary channels can be reconstructed before clipping.
    for (let k = 0; k < 3; k++) data[4 * i + k] = Math.round(255 * Math.max(0, Math.min(1, (color[k] / white[k] + .15) / 1.30)));
    data[4 * i + 3] = 255;
  }
  return data;
}
