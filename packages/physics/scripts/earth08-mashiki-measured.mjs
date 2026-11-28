import assert from 'node:assert/strict';
import { SeismicGround } from '@margoengine/physics/seismic';
import { PhysicsWorld } from '@margoengine/physics/world';

// Reproduce after building Physics with node packages/physics/scripts/earth08-mashiki-measured.mjs.
// Append --spectrum to resolve the longer, denser production transfer traces.
// The NIED KiK-net KMMH16 P–S log (doi:10.17598/NIED.0004) is reported in
// Japan's National Institute for Land and Infrastructure Management,
// Technical Note 1247 (2023), p. 75, Fig. 4.34 inset, and in Fukutake et al.,
// Quantitative strong motion simulations at three locations in downtown
// Mashiki … (2023), doi:10.1186/s40623-023-01821-8, Table 1.
// https://www.nilim.go.jp/lab/bcg/siryou/tnn/tnn1247pdf/ks1247.pdf
// Rows are bottom depth (m), Vp and Vs (m/s). The last logged material
// starts at 234 m and is continued as a half-space to launch the pulse.
const layers = [
  [3, 240, 110],
  [15, 380, 240],
  [33, 1180, 500],
  [41, 1180, 400],
  [69, 1950, 760],
  [101, 2300, 820],
  [133, 2800, 1470],
  [143, 2800, 700],
  [169, 2800, 1380],
  [201, 2300, 840],
  [234, 2300, 1470],
  [Infinity, 4800, 2700],
];
// Fukutake et al. Eq. (1), unit weight divided by 9.8 m/s², kg/m³.
const densityOf = (speed) => 1000 * (1.4 + 0.67 * Math.sqrt(speed / 1000));
// An illustrative loss sensitivity, fixed before computing either output.
// The dimensionless 2.5% ratio is mapped to rate at a fixed 4 Hz. The code
// also runs the lossless control. No station-specific attenuation is fitted.
const dampingOf = (damped, bottom) => (damped && Number.isFinite(bottom) ? 8 * Math.PI * 0.025 : 0);

// Held out: Esfahani, Cotton & Bonilla, Temporal variations of the ‘in-situ’
// nonlinear behaviour of shallow sediments during the 2016 Kumamoto
// Earthquake sequence (2024), doi:10.1093/gji/ggae222, Fig. 2(b) and §3.1.
// 3.4 Hz is a prominent feature of the smoothed pre-2016 low-motion measured
// surface/downhole ratio. 0.377 s is the reference E–W shear impulse response
// lag from 107 weak events. Retain the paper's 6% pre-event IRF variability as
// descriptive scatter, not a confidence interval. Peak frequency is reported
// to 0.1 Hz, without a published location uncertainty.
const boreDepth = 252;
const measuredPeakHz = 3.4;
const measuredLag = 0.377;
const reportedIRFVariability = 0.06;

const sampleRate = 120;
const halfSpace = layers.at(-1);
const motionScale = 0.001;
const sourceDepth = 930;
const horizontalSpacing = 60_000;
const width = 3;
const centreColumn = 1;
const precision = (x) => Number(x.toFixed(6));
const frequencies = Array.from({ length: 553 }, (_, i) => (i + 8) * 0.025);

let startDepth = 0;
let loggingLag = 0;
for (const [bottom, , shearSpeed] of layers) {
  loggingLag += (Math.min(bottom, boreDepth) - startDepth) / shearSpeed;
  if (bottom >= boreDepth) break;
  startDepth = bottom;
}

// This x-uniform horizontal packet is a normally incident transverse test in
// the sense of Virieux (1986), doi:10.1190/1.1442147. It launches an up/down
// split in bedrock. The edges are beyond the fastest propagation distance
// for the observation window, and a distant graded buffer absorbs the
// downward pulse. Hold the packet, buffer and time fixed for the grid refinement.
// Both synthetic records include all reflected arrivals. The denominator is
// total motion at 252 m, not the incident packet or a measured acceleration.
async function records({ dz, seconds, sigma, damped, spongeStart, spongeWidth }) {
  const ground = await SeismicGround.load();
  const depth = Math.ceil((spongeStart + spongeWidth) / dz);
  const world = new PhysicsWorld({ rate: { num: sampleRate, den: 1 } }).add(ground, {
    width,
    depth,
    spacing: [horizontalSpacing, dz],
    absorbingCells: 0,
    material(_x, z) {
      const [bottom, compressionalSpeed, shearSpeed] = layers.find(([bottom]) => z < bottom);
      const edge = Math.max(0, (z - spongeStart) / spongeWidth);
      // The buffer's integrated amplitude exponent exceeds 7 in bedrock.
      return {
        compressionalSpeed,
        shearSpeed,
        density: densityOf(shearSpeed),
        damping: dampingOf(damped, bottom) + (32 * shearSpeed * edge ** 3) / spongeWidth,
      };
    },
    initialVelocity(_x, z) {
      const u = (z - sourceDepth) / sigma;
      return [motionScale * (1 - u * u) * Math.exp(-0.5 * u * u), 0];
    },
  });
  const down = new Float64Array(seconds * sampleRate);
  const up = new Float64Array(down.length);
  const row = Math.floor(boreDepth / dz - 0.5);
  const fraction = boreDepth / dz - 0.5 - row;
  for (let i = 0; i < down.length; ++i) {
    world.advance(i + 1);
    up[i] = ground.motion(centreColumn).velocity[0];
    const atDepth = (column) =>
      (1 - fraction) * ground.velocity(column, row)[0] + fraction * ground.velocity(column, row + 1)[0];
    down[i] = 0.5 * (atDepth(centreColumn - 1) + atDepth(centreColumn));
  }
  return { up, down };
}

function spectralTransfer(up, down) {
  const spectrum = [];
  for (const frequency of frequencies) {
    const angle = (2 * Math.PI * frequency) / sampleRate;
    let upRe = 0;
    let upIm = 0;
    let downRe = 0;
    let downIm = 0;
    for (let i = 0; i < up.length; ++i) {
      const sine = Math.sin(angle * i);
      const cosine = Math.cos(angle * i);
      const taper = Math.min(1, (up.length - 1 - i) / sampleRate);
      const window = 0.5 - 0.5 * Math.cos(Math.PI * taper);
      upRe += up[i] * cosine * window;
      upIm += up[i] * sine * window;
      downRe += down[i] * cosine * window;
      downIm += down[i] * sine * window;
    }
    spectrum.push({ frequency, numerator: Math.hypot(upRe, upIm), denominator: Math.hypot(downRe, downIm) });
  }
  const maxBore = Math.max(...spectrum.map((row) => row.denominator));
  const floor = maxBore * 1e-5;
  assert.ok(maxBore > 0 && floor > 0, 'missing borehole signal');
  let minima = 0;
  for (const row of spectrum) {
    if (row.denominator < floor) ++minima;
    row.ratio = row.numerator / Math.max(floor, row.denominator);
  }
  return { ...summarizeSpectrum(spectrum), borehole_floor_bins: minima };
}

function summarizeSpectrum(spectrum) {
  // Konno–Ohmachi 1998, doi:10.1785/BSSA0880010228, b = 40 as in Esfahani.
  // With a common frequency derivative at both receivers, velocity and
  // acceleration amplitude ratios are the same in the unwindowed limit.
  const smoothed = (f) => {
    let weighted = 0;
    let weights = 0;
    for (const row of spectrum) {
      const q = 40 * Math.log10(row.frequency / f);
      const weight = q === 0 ? 1 : (Math.sin(q) / q) ** 4;
      weighted += weight * row.ratio;
      weights += weight;
    }
    return weighted / weights;
  };
  const local = spectrum.filter(({ frequency }) => frequency >= 2.75 && frequency <= 4.5);
  const response = local.map(({ frequency }) => ({ frequency, gain: smoothed(frequency) }));
  const localPeaks = response.filter((row, i) => row.gain > response[i - 1]?.gain && row.gain > response[i + 1]?.gain);
  const peak = localPeaks.sort((a, b) => b.gain - a.gain)[0] ?? null;
  return {
    peak_Hz: peak && precision(peak.frequency),
    peak_gain: peak && precision(peak.gain),
    difference_Hz: peak && precision(peak.frequency - measuredPeakHz),
    predicted_gain_at_3_4_Hz: precision(smoothed(measuredPeakHz)),
  };
}

// Independent continuum reference. In each layer solve the time-harmonic
// 1D velocity–stress equations with zero surface stress and unit surface
// velocity, then transmit [v, stress] continuously into the next layer.
// This follows the layer propagator of Haskell (1960), doi:10.1029/JZ065i012p04147.
// The resulting v at 252 m is the reciprocal of the desired complex transfer.
function continuumRatio(frequency, damped) {
  let velocity = [1, 0];
  let stress = [0, 0];
  let top = 0;
  for (const [bottom, , speed] of layers) {
    const thickness = Math.min(bottom, boreDepth) - top;
    const attenuation = (dampingOf(damped, bottom) * thickness) / speed;
    const phase = (-2 * Math.PI * frequency * thickness) / speed;
    const cosine = [Math.cosh(attenuation) * Math.cos(phase), Math.sinh(attenuation) * Math.sin(phase)];
    const sine = [Math.sinh(attenuation) * Math.cos(phase), Math.cosh(attenuation) * Math.sin(phase)];
    const impedance = densityOf(speed) * speed;
    const mix = (a, b, scale) => [
      cosine[0] * a[0] - cosine[1] * a[1] + scale * (sine[0] * b[0] - sine[1] * b[1]),
      cosine[0] * a[1] + cosine[1] * a[0] + scale * (sine[0] * b[1] + sine[1] * b[0]),
    ];
    [velocity, stress] = [mix(velocity, stress, 1 / impedance), mix(stress, velocity, impedance)];
    if (bottom >= boreDepth) break;
    top = bottom;
  }
  return 1 / Math.hypot(...velocity);
}

function firstPacketLag(up, down, sigma) {
  // Direct-packet peak separation (an IRF-lag comparator, not the paper's
  // stacked multitaper deconvolution). Gate before the first large returns.
  const travel = (sourceDepth - boreDepth) / halfSpace[2];
  const search = (line, mid) => {
    const halfWidth = (2 * sigma) / halfSpace[2];
    const low = Math.floor((mid - halfWidth) * sampleRate);
    const high = Math.ceil((mid + halfWidth) * sampleRate);
    let peak = low;
    for (let i = low + 1; i <= high; ++i) if (line[i] > line[peak]) peak = i;
    assert.ok(peak > low && peak < high && line[peak] > 0, 'direct packet peak missing');
    const left = line[peak - 1];
    const top = line[peak];
    const right = line[peak + 1];
    return (peak + (0.5 * (left - right)) / (left - 2 * top + right) + 1) / sampleRate;
  };
  const lag = search(up, travel + loggingLag) - search(down, travel);
  return { lag_s: precision(lag), difference_s: precision(lag - measuredLag) };
}

const spectralCases = [
  { dz: 1.5, seconds: 8, sigma: 100, damped: true, spongeStart: 1650, spongeWidth: 2700 },
  { dz: 0.75, seconds: 8, sigma: 100, damped: true, spongeStart: 1650, spongeWidth: 2700 },
];
const continuum = [true, false].map((damped) => ({
  damped,
  ...summarizeSpectrum(frequencies.map((frequency) => ({ frequency, ratio: continuumRatio(frequency, damped) }))),
}));
const frequency = [];
if (process.argv.includes('--spectrum')) {
  for (const settings of spectralCases) {
    const result = await records(settings);
    frequency.push({ ...settings, ...spectralTransfer(result.up, result.down) });
  }
}

const transit = [];
for (const dz of [1.5, 0.75]) {
  for (const sigma of [26, 36]) {
    const result = await records({ dz, seconds: 1, sigma, damped: false, spongeStart: 1650, spongeWidth: 850 });
    transit.push({ dz, sigma, ...firstPacketLag(result.up, result.down, sigma) });
  }
}

console.log(
  JSON.stringify(
    {
      station: 'NIED KiK-net KMMH16',
      measured: { boreDepth, measuredPeakHz, measuredLag, reportedIRFVariability },
      loggingProfileRayLag_s: precision(loggingLag),
      continuum,
      frequency,
      transit,
    },
    null,
    2,
  ),
);
