// Inputs for the batch 167 compute comparison. The same formulas are in the NumPy script that lives
// outside this repository (engine-bench batch-167). Values are chosen so a float32 sum is exact in any order:
// matmul entries are small integers whose products stay inside the exact integer range, and the reduction is
// non-negative multiples of 0.25 whose total is 393216.

export const MATMUL_N = 256;
export const FFT_N = 65536;
export const REDUCE_N = 1_048_576;
export const ROUNDS = 7;

/** Integer in -3..3. `salt` 1 is the left matrix, 2 the right. */
export const matmulValue = (index, salt) => ((index * 17 + salt) % 7) - 3;

export function fillMatmul(salt) {
  const out = new Float32Array(MATMUL_N * MATMUL_N);
  for (let i = 0; i < out.length; i++) out[i] = matmulValue(i, salt);
  return out;
}

/** Integer in -2..2. */
export const fftValue = (index) => (index % 5) - 2;

export function fillFft() {
  const out = new Float32Array(FFT_N);
  for (let i = 0; i < out.length; i++) out[i] = fftValue(i);
  return out;
}

/** 0, 0.25, 0.5, 0.75, repeating. */
export const reduceValue = (index) => (index % 4) * 0.25;

export function fillReduce() {
  const out = new Float32Array(REDUCE_N);
  for (let i = 0; i < out.length; i++) out[i] = reduceValue(i);
  return out;
}

/** f64 checksum of a float32 result. */
export function matmulStats(data) {
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sum += v;
    squares += v * v;
  }
  return { sum, squares, first: data[0], last: data[data.length - 1], length: data.length };
}

/**
 * NumPy 2.5.4, float32 matmul and float64 `numpy.fft.fft`, on these inputs.
 * The FFT bins below are the ones the test locks; the full spectrum was compared once while choosing them.
 */
export const NUMPY = {
  matmul: { sum: 519, squares: 8591379379, first: -511, last: 509 },
  reduce: 393216,
  fft: {
    sumRe: -131072,
    sumIm: 0,
    energy: 8590065664,
    re0: -2,
    im0: 0,
    re1: -2.000000009191791,
    im1: 2.0028423364237824e-13,
    reMid: 2,
    imMid: 0,
    peak: 13107,
    peakRe: -49600.360012166086,
    peakIm: 16115.08245984634,
  },
};

/**
 * CPU Stockham against this NumPy float64 spectrum, every bin: max abs 0.008449666085653007,
 * sum of real parts off by 0.00391, imag sum 0, energy off by 2478 (relative 2.9e-7).
 * The locked bins and the three checksums use the next round hundredth and a 5000 energy window.
 */
export const FFT_ABS = 0.01;
export const FFT_SUM_ABS = 0.01;
export const FFT_ENERGY_ABS = 5000;

export function checkMatmul(stats, who) {
  const want = NUMPY.matmul;
  if (stats.length !== MATMUL_N * MATMUL_N) throw new Error(`${who} matmul length ${stats.length}`);
  if (
    stats.sum !== want.sum ||
    stats.squares !== want.squares ||
    stats.first !== want.first ||
    stats.last !== want.last
  )
    throw new Error(`${who} matmul ${JSON.stringify(stats)}`);
}

export function checkReduce(value, who) {
  if (value !== NUMPY.reduce) throw new Error(`${who} reduce ${value}`);
}

export function fftDetails(re, im) {
  const want = NUMPY.fft;
  let sumRe = 0;
  let sumIm = 0;
  let energy = 0;
  for (let i = 0; i < re.length; i++) {
    sumRe += re[i];
    sumIm += im[i];
    energy += re[i] * re[i] + im[i] * im[i];
  }
  const bins = [
    [0, want.re0, want.im0],
    [1, want.re1, want.im1],
    [FFT_N / 2, want.reMid, want.imMid],
    [want.peak, want.peakRe, want.peakIm],
  ].map(([index, expectRe, expectIm]) => ({
    index,
    re: re[index],
    im: im[index],
    dRe: re[index] - expectRe,
    dIm: im[index] - expectIm,
  }));
  return { sumRe, sumIm, energy, bins };
}

/**
 * TensorFlow.js 4.22.0's WebGPU FFT of this signal is the same transform with a wider f32 error:
 * DC bin exact, energy 0.028% high, peak bin off by 16.7 and 153 (magnitude 0.06%).
 * A different transform (wrong length, wrong DC, energy off by 0.1% or more) still fails.
 */
export function checkTfFft(re, im, who) {
  if (re.length !== FFT_N || im.length !== FFT_N) throw new Error(`${who} fft length ${re.length} ${im.length}`);
  const details = fftDetails(re, im);
  const dc = details.bins[0];
  const energyError = Math.abs(details.energy - NUMPY.fft.energy) / NUMPY.fft.energy;
  if (Math.abs(dc.dRe) > FFT_ABS || Math.abs(dc.dIm) > FFT_ABS || energyError > 0.001)
    throw new Error(
      `${who} fft is not the NumPy transform (energy ${(energyError * 100).toFixed(4)}%) ${JSON.stringify(details)}`,
    );
  return details;
}

export function checkFft(re, im, who) {
  if (re.length !== FFT_N || im.length !== FFT_N) throw new Error(`${who} fft length ${re.length} ${im.length}`);
  const want = NUMPY.fft;
  const details = fftDetails(re, im);
  const problems = [];
  for (const bin of details.bins) {
    if (Math.abs(bin.dRe) > FFT_ABS || Math.abs(bin.dIm) > FFT_ABS)
      problems.push(`bin ${bin.index} dRe ${bin.dRe} dIm ${bin.dIm}`);
  }
  if (Math.abs(details.sumRe - want.sumRe) > FFT_SUM_ABS) problems.push(`sumRe ${details.sumRe}`);
  if (Math.abs(details.sumIm - want.sumIm) > FFT_SUM_ABS) problems.push(`sumIm ${details.sumIm}`);
  if (Math.abs(details.energy - want.energy) > FFT_ENERGY_ABS) problems.push(`energy ${details.energy}`);
  if (problems.length) throw new Error(`${who} fft ${problems.join('; ')} | ${JSON.stringify(details)}`);
  return { sumRe: details.sumRe, sumIm: details.sumIm, energy: details.energy };
}
