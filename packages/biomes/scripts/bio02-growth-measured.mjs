// Kurt W. Gottschalk (1985), Effects of shading on growth and development of northern red oak,
// black oak, black cherry, and red maple seedlings. I. Height, diameter, and root/shoot ratio.
// Fifth Central Hardwood Forest Conference, pp. 189–195, https://research.fs.usda.gov/treesearch/47682.
// Sparse US Forest Service measurements transcribed from Tables 2 and 4. The light column is forcing;
// the two red maple height columns are held-out treatment means. Red maple germinated under the tents.
// Run: node scripts/run-with-timeout.mjs --max=1 -- node packages/biomes/scripts/bio02-growth-measured.mjs

import assert from 'node:assert/strict';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';
import { PlantGrowth } from '../dist/growth.js';

const lightFractions = [0.08, 0.2, 0.27, 0.37, 0.45, 0.57, 0.7, 0.94];
const observedHeightCm = [
  [2.8, 4.8, 5.4, 6.0, 7.0, 7.2, 5.1, 7.3],
  [9.3, 26.3, 28.7, 25.0, 27.0, 33.7, 22.7, 24.0],
];

// The pre-claim Biomes README's authored species is used without a measurement fit. The paper
// supplies no species-specific internode, bud or extension inputs for this model.
const species = {
  productiveSeasons: 3,
  seasonalExtension: 2,
  minimumExtension: 0.05,
  internodeLength: 0.4,
  tipRadius: 0.02,
};
const ticksPerSeason = 60;
const footMetres = 0.3048;
const tentWidthFeet = 8;
const tentHeightFeet = 6;
const nominalVoxelsPerFoot = 4;
const seed = [0, 0, 0];

async function grow(skyExposure, voxelsPerFoot, fallbackWater) {
  const size = footMetres / voxelsPerFoot;
  const columns = tentWidthFeet * voxelsPerFoot;
  const layers = tentHeightFeet * voxelsPerFoot + 1;
  const halfWidth = (tentWidthFeet * footMetres) / 2;
  const growth = await PlantGrowth.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  world.add(growth, {
    plants: [{ position: seed, species }],
    voxels: { origin: [-halfWidth, -size, -halfWidth], dimensions: [columns, layers, columns], size },
    ticksPerSeason,
    skyExposure,
    fallbackWater,
  });
  return [1, 2].map((season) => {
    world.advance(season * ticksPerSeason);
    assert.equal(growth.season, season);
    const internodes = growth.internodes();
    const height = internodes.reduce((y, stem) => Math.max(y, stem.end[1]), seed[1]) - seed[1];
    assert.ok(Number.isFinite(height) && height >= 0 && height < tentHeightFeet * footMetres);
    return { cm: height * 100, internodes: internodes.length };
  });
}

const treatments = [];
for (const [column, light] of lightFractions.entries()) {
  // Abundant seasonal rain supports a no-water-limitation baseline but no actual SMC-to-vigour
  // calibration is available. The 0.75 case is prescribed sensitivity, without a field-water claim.
  const baseline = await grow(light, nominalVoxelsPerFoot, 1);
  const fine = await grow(light, 2 * nominalVoxelsPerFoot, 1);
  const limitedWater = await grow(light, nominalVoxelsPerFoot, 0.75);
  treatments.push({
    light,
    seasons: baseline.map(({ cm, internodes }, i) => ({
      season: i + 1,
      observedCm: observedHeightCm[i][column],
      modeledCm: cm,
      residualCm: cm - observedHeightCm[i][column],
      internodes,
      halfVoxelSizeCm: fine[i].cm,
      reducedWaterCm: limitedWater[i].cm,
    })),
  });
}

const summaries = [0, 1].map((i) => {
  const rows = treatments.map((treatment) => treatment.seasons[i]);
  const absMax = (key) => Math.max(...rows.map((row) => Math.abs(row.modeledCm - row[key])));
  const lowest = rows[0];
  const brightest = rows.at(-1);
  const midLight = rows[lightFractions.indexOf(0.57)];
  return {
    season: i + 1,
    maxAbsResidualCm: absMax('observedCm'),
    maxHalfVoxelChangeCm: absMax('halfVoxelSizeCm'),
    maxReducedWaterChangeCm: absMax('reducedWaterCm'),
    lowestToBrightestHeightRatio: {
      observed: lowest.observedCm / brightest.observedCm,
      modeled: lowest.modeledCm / brightest.modeledCm,
    },
    riseFrom8To57PercentLightCm: {
      observed: midLight.observedCm - lowest.observedCm,
      modeled: midLight.modeledCm - lowest.modeledCm,
    },
  };
});

console.log(
  JSON.stringify(
    {
      source: 'https://research.fs.usda.gov/treesearch/47682',
      scope: 'Red maple seedling tip height after one and two growing seasons under eight shade-tent treatments.',
      protocol:
        'One isolated seed at a fixed height under each reported light fraction, with generic unchanged README species settings. Height is the tallest solver tip above the seed.',
      limits:
        'Three plot replicates per fraction. Height table rounding is ±0.05 cm; the paper gives no per-treatment height dispersion or total uncertainty. Its year-two 8%/57% height contrast is significant (Tukey 0.05). Survival, crowding, seasonal light/soil variability and species calibration are not represented.',
      sensitivity:
        'Nominal voxel size 7.62 cm, refined 3.81 cm. Fallback water 1 for baseline and refinement; 0.75 is an unmeasured stress sensitivity.',
      summaries,
      treatments,
    },
    null,
    2,
  ),
);
