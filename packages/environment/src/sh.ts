// Real L2 spherical harmonics: basis, evaluation and CPU projection.
import type {FloatImage} from './hdr.js';

/** Basis constants, in coefficient order (l,m) = (0,0), (1,-1), (1,0), (1,1), (2,-2), (2,-1), (2,0), (2,1), (2,2). */
export const SH_BASIS = [0.282094792, 0.488602512, 0.488602512, 0.488602512, 1.092548431, 1.092548431, 0.315391565, 1.092548431, 0.546274215] as const;
/** Lambert convolution per band divided by PI (Ramamoorthi and Hanrahan 2001): 1, 2/3, 1/4. */
export const SH_IRRADIANCE_BANDS = [1, 2 / 3, 2 / 3, 2 / 3, 0.25, 0.25, 0.25, 0.25, 0.25] as const;

/** Writes the 9 basis values Y_k(d) for a unit direction into `out`. */
export function shBasis(x: number, y: number, z: number, out: Float64Array | Float32Array | number[] = new Float64Array(9)) {
  out[0] = SH_BASIS[0];
  out[1] = SH_BASIS[1] * y; out[2] = SH_BASIS[2] * z; out[3] = SH_BASIS[3] * x;
  out[4] = SH_BASIS[4] * x * y; out[5] = SH_BASIS[5] * y * z; out[6] = SH_BASIS[6] * (3 * z * z - 1);
  out[7] = SH_BASIS[7] * x * z; out[8] = SH_BASIS[8] * (x * x - y * y);
  return out;
}

/** Evaluates 9 RGB coefficients (27 floats, coefficient-major: k*3 + channel) in direction `d`. */
export function evaluateSH(coefficients: ArrayLike<number>, d: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(d[0], d[1], d[2]) || 1;
  const basis = shBasis(d[0] / length, d[1] / length, d[2] / length);
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) out[c] += coefficients[k * 3 + c] * basis[k];
  return out;
}

/**
 * Projects an equirectangular image (same convention as the GPU path) onto L2 SH on the CPU with exact
 * per-row solid angles. Returns 27 radiance coefficients. Useful without a GPU and as a test reference.
 */
export function projectEquirectSH(image: FloatImage): Float64Array {
  const {width, height, data} = image, out = new Float64Array(27), basis = new Float64Array(9);
  // Each pixel row is split into 4 sub-rows with exact solid angles, so latitude error stays negligible.
  for (let row = 0; row < height * 4; row++) {
    const y = row >> 2, theta0 = Math.PI * row / (height * 4), theta1 = Math.PI * (row + 1) / (height * 4), theta = (theta0 + theta1) / 2;
    const solidAngle = (2 * Math.PI / width) * (Math.cos(theta0) - Math.cos(theta1));
    const dy = Math.cos(theta), ring = Math.sin(theta);
    for (let x = 0; x < width; x++) {
      const phi = 2 * Math.PI * ((x + 0.5) / width - 0.5);
      shBasis(ring * Math.sin(phi), dy, -ring * Math.cos(phi), basis);
      const o = (y * width + x) * 4;
      for (let k = 0; k < 9; k++) {
        const w = basis[k] * solidAngle;
        out[k * 3] += data[o] * w; out[k * 3 + 1] += data[o + 1] * w; out[k * 3 + 2] += data[o + 2] * w;
      }
    }
  }
  return out;
}

/** Converts radiance coefficients to diffuse-ready irradiance / PI coefficients. */
export function radianceToIrradianceSH(radiance: ArrayLike<number>): Float32Array {
  const out = new Float32Array(27);
  for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) out[k * 3 + c] = radiance[k * 3 + c] * SH_IRRADIANCE_BANDS[k];
  return out;
}
