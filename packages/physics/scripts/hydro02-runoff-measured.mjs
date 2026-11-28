// Zhuk et al. (2024), https://doi.org/10.1016/j.heliyon.2024.e24734, Fig. 2.
// Run after building Physics:
// node packages/physics/scripts/hydro02-runoff-measured.mjs [coarseCells] [fineCells]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RainfallRunoff } from '../dist/runoff.js';
import { PhysicsWorld } from '../dist/world.js';

const fixture = await readFile(new URL('./fixtures/hydro02-zhuk-2024.json', import.meta.url), 'utf8');
const { source, inputs, observations } = JSON.parse(fixture);
const rate = { num: 60, den: 1 };
const [coarseCells = 24, fineCells = 48] = process.argv.slice(2).map(Number);
assert.ok(
  Number.isSafeInteger(coarseCells) && coarseCells >= 1 && Number.isSafeInteger(fineCells) && fineCells > coarseCells,
  'Pass positive integer cell counts, with the fine count greater than the coarse count.',
);
const metresPerMmPerHour = 1 / 3.6e6;
const litresPerM3 = 1000;
const rainfallArea = inputs.lengthM * inputs.widthM;
const markers = observations.timeSAndCurveYPixels;
const artifacts = ['runoff.js', 'runoff-kernel.wasm'];
const artifactHashes = Object.fromEntries(
  await Promise.all(
    artifacts.map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(new URL(`../dist/${name}`, import.meta.url)))
        .digest('hex'),
    ]),
  ),
);

async function run(cells, { rainMmPerHour, manning, slope }) {
  const dx = inputs.lengthM / cells;
  const runoff = await RainfallRunoff.load();
  const world = new PhysicsWorld({ rate }).add(runoff, {
    nx: cells,
    nz: 1,
    dx,
    dz: inputs.widthM,
    width: inputs.widthM,
    downstream: Int32Array.from({ length: cells }, (_, i) => (i + 1 === cells ? -1 : i + 1)),
    elevation: Float64Array.from({ length: cells }, (_, i) => (inputs.lengthM - (i + 0.5) * dx) * slope),
    slope,
    roughness: manning,
    conductivity: inputs.conductivityMPerS,
    initialDepth: inputs.initialDepthM,
    soilCapacity: 0,
    drainage: 0,
    precipitation: {
      sample: (_x, _y, _z, seconds) => ({
        rain: { rate: seconds < inputs.rainDurationS ? rainMmPerHour : 0 },
      }),
    },
  });
  return markers.map(([seconds]) => {
    const frames = rate.num * seconds;
    world.advance(frames);
    const { rain, outflow } = runoff.budget;
    const expectedRain = Math.min(seconds, inputs.rainDurationS) * rainMmPerHour * metresPerMmPerHour * rainfallArea;
    let stored = 0;
    for (let i = 0; i < cells; i++) stored += runoff.read(i, 0).depth * dx * inputs.widthM;
    // Bound accumulated positive f64 additions by their count times unit roundoff, with
    // margin for the two budget reductions and the implicit route's local subtraction.
    const roundoffM3 = 8 * (frames * cells + cells) * Number.EPSILON * expectedRain;
    assert.ok(Math.abs(rain - expectedRain) <= roundoffM3, 'Rain intensity or stop time changed.');
    assert.ok(Math.abs(rain - outflow - stored) <= roundoffM3, 'The water budget does not close.');
    return {
      outflowL: outflow * litresPerM3,
      residualM3: rain - outflow - stored,
    };
  });
}

const low = {
  rainMmPerHour: inputs.rainMmPerHour * (1 - inputs.rainRelativeError),
  manning: inputs.manning + inputs.manningAbsoluteError,
  slope: inputs.slope * (1 - inputs.slopeRelativeError),
};
const high = {
  rainMmPerHour: inputs.rainMmPerHour * (1 + inputs.rainRelativeError),
  manning: inputs.manning - inputs.manningAbsoluteError,
  slope: inputs.slope * (1 + inputs.slopeRelativeError),
};
const coarse = await run(coarseCells, inputs);
const fine = await run(fineCells, inputs);
const lower = await run(fineCells, low);
const upper = await run(fineCells, high);
const pixels = observations.plotPixels;
const litresPerPixel = 35 / (pixels.yAt0L - pixels.yAt35L);
const secondsPerPixel = 80 / (pixels.xAt80S - pixels.xAt0S);
// Scale sensitivity, one horizontal pixel and half sample interval (converted
// conservatively at measured high rain supply), and half the plotted stroke.
const observationEnvelopeL =
  observations.scaleResolutionL +
  (secondsPerPixel + observations.samplingIntervalS / 2) *
    (high.rainMmPerHour * metresPerMmPerHour * rainfallArea * litresPerM3) +
  pixels.strokeHalfWidth * litresPerPixel;

// Woolhiser & Liggett (1967), https://doi.org/10.1029/WR003i003p00753.
// Characteristics of h_t + (alpha h^m)_x = rain from a dry uniform plane
// give Q/Qeq = (t/te)^m until rain from the upstream boundary reaches the
// outlet. Integrate this limb, then integrate the equilibrium discharge up
// to shutoff. No observations enter the characteristic calculation.
const rainMPerS = inputs.rainMmPerHour * metresPerMmPerHour;
const alpha = Math.sqrt(inputs.slope) / inputs.manning;
const manningPower = 5 / 3;
const equilibriumTimeS = (inputs.lengthM / (alpha * rainMPerS ** (manningPower - 1))) ** (1 / manningPower);
const equilibriumDischargeLPerS = rainfallArea * rainMPerS * litresPerM3;
function analyticVolumeL(seconds) {
  const rise = Math.min(seconds, equilibriumTimeS);
  const riseIntegral = ((rise / equilibriumTimeS) ** manningPower * rise) / (manningPower + 1);
  return equilibriumDischargeLPerS * (riseIntegral + Math.max(0, seconds - equilibriumTimeS));
}

const rows = markers.map(([seconds, y], i) => {
  const measuredL = (pixels.yAt0L - y) * litresPerPixel;
  const fineL = fine[i].outflowL;
  const coarseL = coarse[i].outflowL;
  const errorL = fineL - measuredL;
  const inputBoundsL = [lower[i].outflowL, upper[i].outflowL];
  assert.ok(
    inputBoundsL[0] <= fineL && fineL <= inputBoundsL[1],
    'The declared forcing variants must bracket the uncalibrated prediction.',
  );
  return {
    seconds,
    measuredL,
    coarseL,
    fineL,
    errorL,
    refinementL: Math.abs(fineL - coarseL),
    inputBoundsL,
    within: inputBoundsL[0] <= measuredL + observationEnvelopeL && inputBoundsL[1] >= measuredL - observationEnvelopeL,
  };
});
const analyticChecks = rows
  .filter(({ seconds }) => seconds <= inputs.rainDurationS)
  .map(({ seconds, fineL }) => {
    const exactL = analyticVolumeL(seconds);
    return { seconds, exactL, fineL, errorL: fineL - exactL };
  });
console.log(
  JSON.stringify(
    {
      experiment: source.doi,
      manningProvenance: source.manningProvenance,
      initialDepthProvenance: source.initialDepthProvenance,
      artifacts: artifactHashes,
      cells: [coarseCells, fineCells],
      nominalRainVolumeL: inputs.rainDurationS * inputs.rainMmPerHour * metresPerMmPerHour * rainfallArea * litresPerM3,
      observationEnvelopeL,
      within: rows.filter(({ within }) => within).length,
      meanAbsoluteErrorL: rows.reduce((sum, row) => sum + Math.abs(row.errorL), 0) / rows.length,
      maxAbsoluteErrorL: Math.max(...rows.map((row) => Math.abs(row.errorL))),
      maxRefinementL: Math.max(...rows.map((row) => row.refinementL)),
      maxWaterResidualM3: Math.max(...[coarse, fine, lower, upper].flat().map((row) => Math.abs(row.residualM3))),
      analyticRisingLimb: {
        reference: 'https://doi.org/10.1029/WR003i003p00753',
        equilibriumTimeS,
        equilibriumDischargeLPerS,
        maxAbsoluteErrorL: Math.max(...analyticChecks.map(({ errorL }) => Math.abs(errorL))),
        checks: analyticChecks,
      },
      rows,
    },
    null,
    2,
  ),
);
