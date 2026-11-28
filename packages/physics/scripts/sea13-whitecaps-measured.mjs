// Run after building Physics:
// node packages/physics/scripts/sea13-whitecaps-measured.mjs
//
// A. Callaghan, G. de Leeuw, L. Cohen & C. D. O'Dowd (2008),
// Relationship of oceanic whitecap coverage to wind speed and wind history,
// https://doi.org/10.1029/2008GL036165. The June 2006 Marine Aerosol
// Production campaign imaged the North Atlantic from R/V Celtic Explorer.
// The target is the half-hour camera-derived total whitecap area, including
// active breakers and residual foam. The original fitted curves supply no inputs.
//
// A. H. Callaghan, J.-R. Bidlot, G. de Leeuw & C. D. O'Dowd (2025),
// Comparing estimates of whitecap coverage from a spectral wave model with
// oceanic observations, https://doi.org/10.1029/2024GL112996. The archived
// data are CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/):
// https://doi.org/10.6084/m9.figshare.25460128.v1
// https://ndownloader.figshare.com/files/51547391 (fig1Data.mat).
// SHA256 5b5f817b3fc3ba457f28463f571c39539539a8a761c4bd0420803d1d85c1332a.
// This selection reproduces nine source rows. In each published wave-age
// class (age <1, 1 through 1.2, >1.2), order by u10N_ECMWF and take
// first, lower middle and last. The original array contains respectively
// 26, 30, and 51 records in those classes. The class and the order use
// only external environmental data. `Map_W` is in percent. Its adjacent
// ECMWF neutral wind and wave age were reconstructed, not observed by the
// ship. The archive provides no separate ship wind or uncertainty column.
// The authors' `Model_W` is neither an input nor a scored observation.
//
// A. H. Callaghan & M. White (2009), Automated processing of sea surface
// images for the determination of whitecap coverage, JTECH 26, 383–394,
// https://doi.org/10.1175/2008JTECHO634.1, §3f and Table 1. Perturbing the
// intensity threshold by one resolution unit can understate W by ~10%
// or overstate W by ~20%. The resulting sensitivity interval for the
// unknown true W is [observed/1.20, observed/0.90]. It covers the threshold
// operation only, independent of uncertainties from finite averaging,
// environment reconstruction, or physical model. §3f estimates sample
// variability separately from three other half-hour examples.
//
// Model setup is the existing foam.test.js wind-only ST4 spin-up, fixed
// 48 hours in homogeneous periodic deep water, 34 bins from .03 to 1 Hz
// and default 24 directions, followed by an actual FoamSolver world step.
// The predicted expected coverage includes the full Leckler et al. (2013)
// statistical foam closure. Its kappa=.30 was calibrated against the
// Monahan & Woolf (1989) fit and Anguelova et al. (2009) WindSat coverage
// from March 2006, independent of this June 2006 ship campaign.
// https://doi.org/10.1016/j.ocemod.2013.03.007 (Eqs. 14–15).
// Instantaneous f32 foam is stochastic. We compare expected total area
// to the half-hour camera means. Setup has no actual wind history, swell
// partition, water temperature or surfactant observations. The young
// and swell-dominated bins are out-of-setup wind-only comparisons. This
// tests the coupled wind→spectrum→foam prediction, not the whitecap
// closure under each observed spectrum.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FoamSolver } from '../dist/foam.js';
import { peakFrequency, significantHeight, WaveSolver } from '../dist/waves.js';
import { PhysicsWorld } from '../dist/world.js';

// Exact numeric columns [one-based archive row, neutral wind m/s, wave age, measured coverage %].
const groups = [
  {
    seaState: 'young',
    points: [
      [107, 11.744905, 0.9379687185259262, 1.29711],
      [23, 16.318388, 0.6340535018688721, 1.88775],
      [48, 20.501122, 0.9704821556748633, 6.48299],
    ],
  },
  {
    seaState: 'developed',
    points: [
      [100, 11.69586, 1.1293575192288356, 1.35517],
      [64, 16.718418, 1.0972153362084849, 2.93335],
      [44, 19.953255, 1.010002931220645, 7.06183],
    ],
  },
  {
    seaState: 'swell-dominated',
    points: [
      [78, 4.898307, 2.6104544289328193, 0.00172],
      [3, 8.427754, 1.8103052623381999, 0.08142],
      [52, 16.058838, 1.2271945469966412, 2.97556],
    ],
  },
];

function predict(neutralWind) {
  const wind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample(_x, _y, _z, _time, out) {
      out.velocity[0] = neutralWind;
      out.velocity[1] = 0;
      out.velocity[2] = 0;
      out.density = 1.225;
      out.temperature = 288;
      return out;
    },
  };
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
  const waves = new WaveSolver();
  world.add(waves, {
    cells: [1, 1],
    cellSize: 1e7,
    wind,
    periodic: ['x', 'z'],
    warmUp: 48 * 3600,
    frequencies: { min: 0.03, max: 1, count: 34 },
  });
  const foam = new FoamSolver();
  world.add(foam, { waves, cells: [1, 1], wind });
  world.advance(1);
  const coverage = foam.expectedCoverage(0, 0);
  assert.ok(Number.isFinite(coverage) && coverage > 0 && coverage <= 1);
  const spectrum = waves.field.sample(0, 0);
  const peakHz = peakFrequency(spectrum);
  return {
    expectedPercent: coverage * 100,
    modeledSignificantHeightMetres: significantHeight(spectrum),
    modeledPeakHz: peakHz,
    modeledWaveAge: Math.abs(world.gravity[1]) / (2 * Math.PI * peakHz * neutralWind),
  };
}

const results = groups.map(({ seaState, points }) => {
  const rows = points.map(([archiveRow, neutralWind, sourceWaveAge, measuredPercent]) => {
    const prediction = predict(neutralWind);
    const [low, high] = [measuredPercent / 1.2, measuredPercent / 0.9];
    return {
      archiveRow,
      neutralWind,
      sourceWaveAge,
      measuredPercent,
      aweThresholdSensitivityPercent: [low, high],
      ...prediction,
      differencePercentagePoints: prediction.expectedPercent - measuredPercent,
      predictedToMeasuredRatio: prediction.expectedPercent / measuredPercent,
      withinThresholdSensitivity: prediction.expectedPercent >= low && prediction.expectedPercent <= high,
    };
  });
  return {
    seaState,
    biasPercentagePoints: rows.reduce((sum, row) => sum + row.differencePercentagePoints, 0) / rows.length,
    rmsePercentagePoints: Math.sqrt(
      rows.reduce((sum, row) => sum + row.differencePercentagePoints ** 2, 0) / rows.length,
    ),
    withinThresholdSensitivity: rows.filter((row) => row.withinThresholdSensitivity).length,
    rows,
  };
});

const artifact = async (name) => {
  const entry = await readFile(new URL(`../dist/${name}.js`, import.meta.url));
  const sha256 = (data) => createHash('sha256').update(data).digest('hex');
  const match = new RegExp(`from ["'](\\./${name}-[^"']+\\.js)["']`).exec(entry.toString());
  return {
    entrySha256: sha256(entry),
    ...(match && { linkedSha256: sha256(await readFile(new URL(`../dist/${match[1]}`, import.meta.url))) }),
  };
};
const [foamArtifact, waveArtifact] = await Promise.all([artifact('foam'), artifact('waves')]);
console.log(
  JSON.stringify(
    {
      data: 'Callaghan et al. (2025) Fig. 1 archive, camera Map_W paired to ECMWF U10N',
      foamArtifact,
      waveArtifact,
      results,
    },
    null,
    2,
  ),
);
