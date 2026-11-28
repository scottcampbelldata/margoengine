// Slesak, Agne, Harrington & Powers (2025), Long-term effects of tree spacing during
// reforestation on survival and growth of three important tree species in the Pacific Northwest,
// USA, https://doi.org/10.1016/j.foreco.2025.122724. Sparse survival readouts from measured
// Douglas-fir cohorts in Figure 1c, and the exact reported means/intervals in §3.1 (years from planting).
// Curtis, Bansal & Harrington (2016), USDA PNW-RP-607, https://pubs.usgs.gov/publication/70173842,
// Study Area and Table 1, supply independent planting age (two-year-old stock), spacing and layout.
// Run: node scripts/run-with-timeout.mjs --max=1 -- node packages/biomes/scripts/bio03-forest-measured.mjs

import assert from 'node:assert/strict';
import { PhysicsWorld, worldMemory } from '@margoengine/physics/world';
import { ForestEcosystemSolver } from '../dist/forest.js';

const measuredYears = [16, 32, 40];
const treatmentAreaM2 = 4000;
const plantingAge = 2;
const modelSeeds = [0, 1, 2, 3, 4, 5, 6, 7];
const nominalInitialRadius = 0.05;
const alternativeInitialRadius = 0.1;
// Generic pre-claim README fir crown ceiling. Leave growth, lifespan and shade at solver defaults.
// No recruitment is modeled so all modeled deaths refer to the placed cohort. Real ingrowth and
// early replacements affected treatment density and could influence the tracked cohort's survival.
const species = { id: 'fir', radius: 3, seeds: 0 };

// Half the Figure 1c marker height is about 4.5 px at 170 dpi with 249 px per fractional unit.
// Allow 0.025 for marker, axis registration and rounding to 0.01. This is a readout bound only.
const graphHalfWidth = 0.025;
const graph = (mean) => ({ mean, graphicReadout: [mean - graphHalfWidth, mean + graphHalfWidth] });
const reported = (mean, lower, upper) => ({ mean, reported95PercentCI: [lower, upper] });
const treatments = [
  { spacing: 1, sample: [20, 10], observed: [graph(0.8), graph(0.44), graph(0.13)] },
  { spacing: 2, sample: [20, 10], observed: [graph(0.91), graph(0.73), graph(0.4)] },
  { spacing: 3, sample: [14, 14], observed: [null, null, reported(0.68, 0.6, 0.74)] },
  { spacing: 4, sample: [10, 10], observed: [null, null, reported(0.81, 0.74, 0.87)] },
  { spacing: 5, sample: [8, 8], observed: [null, null, reported(0.83, 0.75, 0.89)] },
  { spacing: 6, sample: [7, 7], observed: [graph(0.97), graph(0.93), reported(0.9, 0.83, 0.94)] },
];

function planting(spacing, [sampleColumns, sampleRows], radius) {
  // Use a full measured-area treatment with an ideal square lattice. The exact tag coordinates
  // aren't public. Place the measurement samples centrally; the 1–2 m samples each have two
  // adjacent 10×10 groups. Trees outside the tagged area still compete with tagged stems.
  const side = Math.sqrt(treatmentAreaM2);
  const halfSide = side / 2;
  const count = Math.floor(side / spacing);
  const firstColumn = Math.floor((count - sampleColumns) / 2);
  const firstRow = Math.floor((count - sampleRows) / 2);
  const plants = [];
  const tagged = [];
  for (let z = 0; z < count; z++) {
    for (let x = 0; x < count; x++) {
      plants.push({
        species: species.id,
        age: plantingAge,
        radius,
        x: (x - (count - 1) / 2) * spacing,
        z: (z - (count - 1) / 2) * spacing,
      });
      tagged.push(x >= firstColumn && x < firstColumn + sampleColumns && z >= firstRow && z < firstRow + sampleRows);
    }
  }
  return { bounds: [-halfSide, -halfSide, halfSide, halfSide], plants, tagged };
}

async function sampleTreatment({ spacing, sample }, radius, seed) {
  const { bounds, plants, tagged } = planting(spacing, sample, radius);
  const forest = await ForestEcosystemSolver.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  world.add(forest, {
    bounds,
    species: [species],
    plants,
    ticksPerYear: 1,
    seed,
    limit: plants.length,
  });
  const initialTrees = forest.trees();
  const ids = new Set(initialTrees.filter((_, index) => tagged[index]).map((tree) => tree.id));
  assert.equal(initialTrees.length, plants.length);
  assert.equal(ids.size, sample[0] * sample[1]);
  return measuredYears.map((year) => {
    world.advance(year);
    assert.equal(forest.year.year, year);
    assert.equal(forest.year.born, 0);
    assert.equal(forest.year.crowded, 0);
    const survivors = forest.trees().filter((tree) => ids.has(tree.id) && tree.died === undefined).length;
    return survivors / ids.size;
  });
}

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const rows = [];
for (const treatment of treatments) {
  const baseline = [];
  const largerStock = [];
  for (const seed of modelSeeds) {
    baseline.push(await sampleTreatment(treatment, nominalInitialRadius, seed));
    largerStock.push(await sampleTreatment(treatment, alternativeInitialRadius, seed));
  }
  for (const [i, observed] of treatment.observed.entries()) {
    if (!observed) continue;
    const results = baseline.map((cohort) => cohort[i]);
    const modeled = average(results);
    rows.push({
      spacingM: treatment.spacing,
      afterPlantingYears: measuredYears[i],
      observed,
      modeled,
      residual: modeled - observed.mean,
      modelSeedRange: [Math.min(...results), Math.max(...results)],
      simulatedLargerStock: average(largerStock.map((cohort) => cohort[i])),
    });
  }
}
console.log(
  JSON.stringify(
    {
      study: 'https://doi.org/10.1016/j.foreco.2025.122724',
      protocol:
        'Tracked fraction of originally placed model trees alive at the reported field ages. Only planting spacing, plot size and two-year planting age are taken from the experiment.',
      model:
        'Generic fir parameters and no site fit, ingress, early replacement, pests, ice-storm breakage or environmental forcing.',
      sensitivity:
        'Eight fixed model seeds and 5 versus 10 cm initial crown radius. Seed ranges describe model variability. Printed field intervals apply only to the four reported year-40 means.',
      rows,
    },
    null,
    2,
  ),
);
