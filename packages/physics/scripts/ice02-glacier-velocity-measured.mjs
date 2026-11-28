// Charles F. Raymond (1971), Flow in a Transverse Section of Athabasca Glacier, Alberta, Canada,
// Journal of Glaciology 10, 55–84, https://doi.org/10.3189/S0022143000012995. Fig. 3a and Table I give
// independent local slope and drilling depth. The centerline depth mean is a separate measured result
// from Fig. 10a and the text on p. 73. Sparse facts only, with no redistributed figure or data file.
// Nathan Maier, Neil Humphrey, Joel Harper and Toby Meierbachtol (2019), Sliding dominates slow-flowing
// margin regions, Greenland Ice Sheet, Science Advances 5, eaaw5406, https://doi.org/10.1126/sciadv.aaw5406.
// Published measurement summaries from Methods (drill thickness and DEM slope) and Results (held-out
// winter GPS speed and independent borehole estimate of deformation). No archive download is required.
// Run node scripts/run-with-timeout.mjs --max=2 -- node packages/physics/scripts/ice02-glacier-velocity-measured.mjs

import assert from 'node:assert/strict';
import { GlacierSolver } from '../dist/glacier.js';
import { PhysicsWorld, worldMemory } from '../dist/world.js';

const hz = 60;
const gravity = 9.81;
const annualSeconds = 365.25 * 86400;
const rate = { num: hz, den: 1 };
const radians = Math.PI / 180;
const stepSeconds = 3600;
const halfLengthM = 600;

async function run(thicknessM, slopeDeg, iceDensity, dx) {
  const middle = halfLengthM / dx;
  const nx = 2 * middle + 1;
  const slope = Math.tan(slopeDeg * radians);
  const bed = Float64Array.from({ length: nx }, (_, index) => (middle - index) * dx * slope);
  const ice = await GlacierSolver.load();
  const world = new PhysicsWorld({ rate, gravity: [0, -gravity, 0], memory: worldMemory(false) }).add(ice, {
    nx,
    nz: 1,
    dx,
    thickness: new Float64Array(nx).fill(thicknessM),
    bed,
    iceDensity,
    timeScale: hz * stepSeconds,
  });
  const initialCentre = ice.sample(middle, 0);
  const initialVolume = ice.budget.ice;
  world.advance(1);
  const state = ice.sample(middle, 0);
  assert.ok(
    state.velocity[0] > 0 && state.velocity[1] === 0,
    'The local strip must move along its surveyed fall line.',
  );
  const volumeResidual = ice.budget.ice - initialVolume;
  assert.ok(Math.abs(volumeResidual) < 1e-9 * initialVolume, 'The closed strip must conserve its total volume.');
  const depthMeanMPerYear = state.velocity[0] * annualSeconds;
  return {
    dx,
    depthMeanMPerYear,
    // For no-slip n=3 with depth-independent A, u(z) ∝ 1-(1-z/H)^4 at height z above bed.
    // Its depth average is four fifths of the surface deformation rate. This proxy contains no basal plug motion.
    surfaceDeformationMPerYear: 1.25 * depthMeanMPerYear,
    simulatedHourVelocityChangeMPerYear: (state.velocity[0] - initialCentre.velocity[0]) * annualSeconds,
    volumeResidualM3: volumeResidual,
  };
}

async function sites(thicknessM, slopeDeg, iceDensity, hRange, slopeRange) {
  const nominal = await run(thicknessM, slopeDeg, iceDensity, 75);
  const refined = await run(thicknessM, slopeDeg, iceDensity, 37.5);
  const lower = await run(hRange[0], slopeRange[0], iceDensity, 37.5);
  const upper = await run(hRange[1], slopeRange[1], iceDensity, 37.5);
  return {
    inputs: { thicknessM, slopeDeg, iceDensity, hRange, slopeRange },
    nominal,
    refined,
    depthMeanGeometryRangeMPerYear: [lower.depthMeanMPerYear, upper.depthMeanMPerYear],
    surfaceDeformationGeometryRangeMPerYear: [lower.surfaceDeformationMPerYear, upper.surfaceDeformationMPerYear],
  };
}

// Section A, borehole 1A. July 1966 drilling reached 311 m. The ±6 m allowance covers the reported
// deepest recovery differences from Table I and is a geometry sensitivity. Read transverse Fig. 3a
// at the center mark, with Fig. 4b a check. At 180 dpi, 0–6° occupy about 74 px. Use ±0.2° to cover
// several pixels and the centerline readings in both panels. Ice density is the engine default.
// Raymond's velocity errors at center are approximately 0.22 m/yr at the surface and 0.46 m/yr at
// 300 m. Allow ±0.5 m/yr as a local velocity-error scale. The reported depth mean has no separate
// confidence interval. The reported 81% basal share describes centerline surface speed.
const athabasca = await sites(311, 4.1, 917, [305, 317], [3.9, 4.3]);
console.log(
  JSON.stringify({
    site: 'Athabasca Glacier, Section A, 1966–1967',
    ...athabasca,
    measuredDepthMeanMPerYear: 49.6,
    measurementErrorScaleMPerYear: 0.5,
    depthMeanBiasMPerYear: athabasca.refined.depthMeanMPerYear - 49.6,
    measuredBasalShareOfSurface: 0.81,
  }),
);

// Insunnguata Sermia winter, west Greenland. The drill thickness and DEM slope ranges are spatial,
// measured independently of the GPS and inclinometers. The reference geometry uses the mean H and
// the midpoint of the published slope range. Uniform temperate A=2.4e-24 is the engine default. It
// is a soft baseline within that constitutive law; measured colder temperatures are unresolved here.
// The reported 0.4–10.8 m/yr is the borehole deformation uncertainty range. The total GPS reference
// is reported to 0.1 m/yr and includes basal motion. Only its published precision is used here.
const greenland = await sites(668, 0.89, 900, [640, 688], [0.74, 1.04]);
console.log(
  JSON.stringify({
    site: 'Insunnguata Sermia, Greenland winter 2015–2016',
    ...greenland,
    measuredSurfaceMPerYear: 114.8,
    measuredDeformationMPerYear: 4.6,
    measuredDeformationBoundsMPerYear: [0.4, 10.8],
    deformationBiasMPerYear: greenland.refined.surfaceDeformationMPerYear - 4.6,
    totalVelocityBiasMPerYear: greenland.refined.surfaceDeformationMPerYear - 114.8,
    inferredBasalMPerYear: 110.2,
  }),
);
