// Run after building Physics: node packages/physics/scripts/sea03-flume-crests-measured.mjs
// G. Dematteis, T. Grafke, M. Onorato & E. Vanden-Eijnden (2019), Experimental Evidence of
// Hydrodynamic Instantons: The Universal Route to Rogue Waves, Phys. Rev. X 9, 041057,
// https://doi.org/10.1103/PhysRevX.9.041057, Eq. 3 and §§II–III, CC BY 4.0.
// https://creativecommons.org/licenses/by/4.0/
// Upstream wavemaker spectrum only. Each case has five independent synthetic 25 min records.
// The three measured 45 m crest totals are held out. Lab phase realizations and per-run counts
// were not published. This comparison uses count rates, with no time-series phase matching.
import { NonlinearSea } from '../dist/rogue.js';

const gravity = 9.81;
const peak = 4.19;
const phillips = 0.012;
const gauge = 45;
const sampleRate = 40;
const seconds = 1500;
const records = [0, 1, 2, 3, 4];
const cases = [
  { regime: 'quasilinear', gamma: 1, printedHeight: 0.11, thresholdFactor: 1, observed: 78 },
  { regime: 'intermediate', gamma: 3.3, printedHeight: 0.13, thresholdFactor: 1.1, observed: 99 },
  { regime: 'highly nonlinear', gamma: 6, printedHeight: 0.15, thresholdFactor: 1.2, observed: 88 },
];

// For the first 85 m, the same MARINTEK flume's reported bed depth is 10 m.
// Mori, Onorato, Janssen, Osborne & Serio (2007),
// On the extreme statistics of long-crested deep water waves: Theory and experiments, §2.
// https://doi.org/10.1029/2006JC004024. k_p h is about 17.9 at these probes.
const depth = 10;

function wavemakerDensity(omega, gamma) {
  const width = omega <= peak ? 0.07 : 0.09;
  const shape = Math.exp(-0.5 * ((omega - peak) / (width * peak)) ** 2);
  return ((phillips * gravity ** 2) / omega ** 5) * Math.exp(-1.25 * (peak / omega) ** 4) * gamma ** shape;
}

function targetHeight(gamma) {
  // Eq. 4 uses the full prescribed spectrum. Its tail above 16ωp has the ω^-5 integral.
  const step = peak / 1024;
  const end = 16 * 1024;
  let variance = 0;
  for (let i = 0; i < end; i++) variance += step * wavemakerDensity((i + 0.5) * step, gamma);
  variance += (phillips * gravity ** 2) / (4 * (end * step) ** 4);
  return 4 * Math.sqrt(variance);
}

function spectrumFor(gamma, count, cutoff, varianceScale) {
  const dtheta = (2 * Math.PI) / count;
  const directions = Float64Array.from({ length: count }, (_, i) => (i - count / 2) * dtheta);
  const df = peak / (2 * Math.PI) / 256;
  const frequencies = Float64Array.from({ length: Math.floor((cutoff + 0.05) * 256) - 59 }, (_, i) => (i + 60) * df);
  const energy = new Float64Array(frequencies.length * count);
  // The production sampler chooses a random angle within an occupied bin. Occupy the narrow bin
  // centered exactly along the flume, and refine its angular spread with the spectral discretization.
  for (let i = 0; i < frequencies.length; i++) {
    energy[i * count + count / 2] =
      (varianceScale * wavemakerDensity(frequencies[i] * 2 * Math.PI, gamma) * 2 * Math.PI) / dtheta;
  }
  return { frequencies, directions, energy, depth, density: 1000 };
}

function localMaxima(signal, stride, thresholds) {
  const counts = thresholds.map(() => 0);
  let total = 0;
  for (let i = stride; i + stride < signal.length; i += stride) {
    if (!(signal[i] >= signal[i - stride] && signal[i] > signal[i + stride])) continue;
    total++;
    for (let j = 0; j < thresholds.length; j++) if (signal[i] >= thresholds[j]) counts[j]++;
  }
  return { counts, total };
}

function sample(gamma, components, angularBins, cutoff, thresholds, varianceScale) {
  const spectrum = spectrumFor(gamma, angularBins, cutoff, varianceScale);
  const signal = new Float64Array(seconds * sampleRate);
  const perRecord40Hz = [];
  const perRecord20Hz = [];
  let spectralHeight = 0;
  for (const seed of records) {
    const sea = new NonlinearSea({ spectrum, seed, components, cutoff, gravity, rogues: false });
    spectralHeight = 4 * Math.sqrt(sea.variance);
    for (let i = 0; i < signal.length; i++) signal[i] = sea.elevation(gauge, 0, i / sampleRate);
    perRecord40Hz.push(localMaxima(signal, 1, thresholds));
    perRecord20Hz.push(localMaxima(signal, 2, thresholds));
  }
  const tally = (runs) => thresholds.map((_, i) => runs.reduce((sum, { counts }) => sum + counts[i], 0));
  const total = (runs) => runs.reduce((sum, run) => sum + run.total, 0);
  return {
    components,
    cutoff,
    angularBins,
    spectralHeight,
    counts40Hz: tally(perRecord40Hz),
    counts20Hz: tally(perRecord20Hz),
    totalLocalMaxima40Hz: total(perRecord40Hz),
    totalLocalMaxima20Hz: total(perRecord20Hz),
    atNominalThresholdPerRecord: perRecord40Hz.map(({ counts }) => counts[1]),
  };
}

for (const setup of cases) {
  const heightFromEquation = targetHeight(setup.gamma);
  // Eq. 3 and Table I differ slightly beyond 0.005 m rounding at γ=3.3 and 6. Run both published
  // upstream specifications. Table I rescaling is from the imposed wavemaker input, never test outcomes.
  for (const [forcing, height] of [
    ['equation-3', heightFromEquation],
    ['table-1', setup.printedHeight],
  ]) {
    const varianceScale = (height / heightFromEquation) ** 2;
    // Count arrays report [lower printed bound, nominal, upper printed bound] in that order.
    const thresholdHeights = [setup.printedHeight - 0.005, height, setup.printedHeight + 0.005];
    const thresholds = thresholdHeights.map((heightM) => heightM * setup.thresholdFactor);
    for (const [components, angularBins, cutoff] of [
      [48, 128, 4],
      [96, 256, 5],
    ]) {
      const model = sample(setup.gamma, components, angularBins, cutoff, thresholds, varianceScale);
      // Diagnostic sampling scale assuming independent rare maxima. The reported aggregate experiment
      // supplies no cluster covariance or per-run counts for a measured confidence interval.
      const independentCountingScale = Math.sqrt(setup.observed);
      console.log(
        JSON.stringify({
          ...setup,
          gauge,
          secondsPerRecord: seconds,
          forcing,
          height,
          heightFromEquation,
          thresholds,
          independentCountingScale,
          model,
        }),
      );
    }
  }
}
