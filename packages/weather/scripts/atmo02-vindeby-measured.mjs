// Run after building Weather:
// node packages/weather/scripts/atmo02-vindeby-measured.mjs [base|refined]
//
// Putri, Cheynet, Obhrai & Jakobsen (2022), Turbulence in a coastal
// environment: the case of Vindeby, Wind Energy Science 7, 1693–1710.
// https://doi.org/10.5194/wes-7-1693-2022 (CC BY 4.0).
// Fig. 11, https://wes.copernicus.org/articles/7/1693/2022/wes-7-1693-2022-f11-high-res.pdf
// SHA256 6b9fd43792063976a358677f2f9d9a82b744a29bd0b49842905d31adbc59a59f.
// contains the measured near-neutral (|z/L_MO| <= 0.1) marker centres. Read
// the vector centres, with gamma plotted on a linear axis and k*dz on a log
// axis. The labelled k*dz=1 tick and adjacent 0.1 minor tick (horizontal
// scale also checked against the separately identified dashed IEC curve,
// Eq. 16) define the abscissa. Extract the nearest markers to 0.15, 0.35,
// 0.70 and 1.05 in each column. No fitted curve is used as a comparison
// target. Numbers are derived from the figure, rounded to five decimals.
// The underlying measurements are Hansen, Vasiljevic & Sørensen (2021),
// https://doi.org/10.11583/DTU.14387480.v1 (CC BY 4.0).
//
// The original Kansas spectra (Kaimal et al. 1972,
// https://doi.org/10.1002/qj.49709841707) and the calibration experiments
// in Mann (1994), https://doi.org/10.1017/S0022112094001886, predate these
// measurements. No length, shear or amplitude is fitted to Vindeby.
// Mode sums use the engine's field in the homogeneous arrays, with the
// default L=33.6 m and Gamma=3.9; sigma cancels in coherence. The authors'
// per-window mean wind speeds already enter their k*dz values via Taylor's
// hypothesis. §4 gives 30 minute records with eight half-overlapping Welch
// segments. Fig. 11 omits per-marker error bars and the effective sample sizes
// after windowing and ensemble selection. The descriptive high-k scatter
// below cannot stand in for a field confidence interval at the score bands.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Fft3 } from '@margoengine/math/fft';
import { MannBox } from '../dist/turbulence.js';

// Each row is [k*dz, gamma_u, gamma_v, gamma_w] from the published markers.
const observations = [
  {
    heights: [6, 18],
    rows: [
      [0.1371, 0.60839, 0.46301, 0.48134],
      [0.34273, 0.28633, 0.14017, 0.3407],
      [0.68545, 0.08076, -0.05363, 0.25194],
      [1.06243, 0.01508, -0.11158, 0.22894],
    ],
  },
  {
    heights: [18, 45],
    rows: [
      [0.13682, 0.61607, 0.463, 0.50234],
      [0.34205, 0.34128, 0.22516, 0.40105],
      [0.68409, 0.1534, 0.05475, 0.31345],
      [1.02611, 0.04731, -0.02386, 0.26352],
    ],
  },
  {
    heights: [6, 45],
    rows: [
      [0.10525, 0.64311, 0.56783, 0.2158],
      [0.31576, 0.18644, 0.01741, 0.15592],
      [0.73675, 0.01792, -0.14017, 0.08459],
      [1.05249, -0.00583, -0.13633, 0.07745],
    ],
  },
];

// Figure 11 marker residual standard deviation about a line in k*dz from
// 2.5 to 3.8. This quantifies local plotted scatter only. The entries are
// metres of separation, number of markers, then dimensionless u/v/w scatter.
const highWavenumberObservedScatter = [
  [12, 38, 0.007, 0.00607, 0.00684],
  [27, 19, 0.00513, 0.0073, 0.00699],
  [39, 13, 0.00498, 0.00703, 0.00941],
];
const entry = new URL('../dist/turbulence.js', import.meta.url);
const entryBytes = await readFile(entry);
const linkedName = /from ["'](\.\/turbulence-[^"']+\.js)["']/.exec(entryBytes.toString())?.[1];
const artifacts = {
  entrySha256: createHash('sha256').update(entryBytes).digest('hex'),
  ...(linkedName && {
    linkedBundleSha256: createHash('sha256')
      .update(await readFile(new URL(linkedName, entry)))
      .digest('hex'),
  }),
};
const setups = {
  base: { cells: [1024, 24, 32], size: [8192, 288, 96] },
  refined: { cells: [1024, 32, 64], size: [8192, 288, 192] },
};
const stage = process.argv[2] ?? 'base';
assert.ok(Object.hasOwn(setups, stage), 'Choose base or refined Mann box resolution.');
const setup = setups[stage];
const seeds = [14, 31, 64, 93];
const components = ['u', 'v', 'w'];
const [nx, ny, nz] = setup.cells;
const [sx, , sz] = setup.size;
const dz = sz / nz;
const requests = observations.flatMap(({ heights, rows }) => {
  const separation = heights[1] - heights[0];
  const offset = separation / dz;
  assert.ok(Number.isInteger(offset) && offset <= nz / 2);
  return rows.map(([reducedWavenumber, ...measured]) => {
    const bin = (reducedWavenumber * sx) / (2 * Math.PI * separation);
    return { heights, separation, offset, reducedWavenumber, measured, bin };
  });
});
const wantedBins = [...new Set(requests.flatMap(({ bin }) => [Math.floor(bin), Math.ceil(bin)]))].sort((a, b) => a - b);
const frequencyIndex = new Map(wantedBins.map((bin, i) => [bin, i]));
assert.ok(wantedBins[0] > 0 && wantedBins.at(-1) < nx / 2);
const fft = new Fft3(nx, 1, 1);

function spectra(values) {
  const paired = new Float64Array(2 * wantedBins.length * ny * nz);
  const row = new Float64Array(2 * nx);
  for (let i = 0; i < ny * nz; i++) {
    row.fill(0);
    for (let x = 0; x < nx; x++) row[2 * x] = values[x + nx * i];
    fft.transform(row);
    for (const [j, bin] of wantedBins.entries()) {
      const at = 2 * (j + wantedBins.length * i);
      paired[at] = row[2 * bin];
      paired[at + 1] = row[2 * bin + 1];
    }
  }
  return paired;
}

function coCoherence(values, offset, bin) {
  const j = frequencyIndex.get(bin);
  let cross = 0;
  let auto = 0;
  for (let z = 0; z < nz; z++) {
    const shifted = (z + offset) % nz;
    for (let y = 0; y < ny; y++) {
      const left = 2 * (j + wantedBins.length * (y + ny * z));
      const right = 2 * (j + wantedBins.length * (y + ny * shifted));
      cross += values[left] * values[right] + values[left + 1] * values[right + 1];
      auto += values[left] ** 2 + values[left + 1] ** 2;
    }
  }
  // This is Re(S12)/sqrt(S11*S22). The two auto sums are identical because
  // both legs cover the same periodically translated set of row origins.
  return cross / auto;
}

const ensemble = seeds.map((seed) => {
  const box = new MannBox({ ...setup, lengthScale: 33.6, shear: 3.9, sigma: 1, seed });
  return components.map((component) => {
    const modes = spectra(box[component]);
    return requests.map(({ offset, bin }) => {
      const lower = Math.floor(bin);
      const low = coCoherence(modes, offset, lower);
      const high = coCoherence(modes, offset, Math.ceil(bin));
      const estimate = low + (bin - lower) * (high - low);
      assert.ok(Number.isFinite(estimate) && Math.abs(estimate) <= 1);
      return estimate;
    });
  });
});

const results = requests.map(({ heights, reducedWavenumber, measured }, index) => ({
  heightsMetres: heights,
  reducedWavenumber,
  comparison: components.map((component, i) => {
    const samples = ensemble.map((box) => box[i][index]);
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const sampleVariance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);
    return {
      component,
      observed: measured[i],
      predicted: mean,
      predictedMinusObserved: mean - measured[i],
      modelSeedStandardDeviation: Math.sqrt(sampleVariance),
      // A 95% t half-width (3 degrees of freedom) describes approximately
      // normal independent seed means, not field/digitization uncertainty.
      modelSeed95HalfWidth: 3.182 * Math.sqrt(sampleVariance / samples.length),
    };
  }),
}));
console.log(
  JSON.stringify(
    {
      stage,
      setup,
      seeds,
      artifacts,
      highWavenumberObservedScatter,
      results,
    },
    null,
    2,
  ),
);
