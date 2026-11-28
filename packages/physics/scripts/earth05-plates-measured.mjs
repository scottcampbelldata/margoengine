import assert from 'node:assert/strict';
import { TerrainBed } from '@margoengine/physics/earth';
import { soilPatchField, Terramechanics } from '@margoengine/physics/terramechanics';
import { PhysicsWorld, regionWords } from '@margoengine/physics/world';

// Run from the repo root after building Physics:
// node packages/physics/scripts/earth05-plates-measured.mjs
//
// M. Apfelbeck, S. Kuß, B. Rebele and B. Schäfer, A systematic approach to reliably
// characterize soils based on Bevameter testing (2011), doi:10.1016/j.jterra.2011.04.001.
// https://elib.dlr.de/69724/1/Apfelbeck_BevameterTest_JTerra2011.pdf
// Table 5 Soil01 at 4.8 mm/s supplies the circular-plate calibration in SI.
// The same-speed rectangular measurements in Fig. 8 are held out. At two
// fixed pressures, interpolate the plotted marker centres. For each bound
// interpolate the monotone curve through corresponding adverse pressure and
// depth whisker ends (lower depth/upper pressure and vice versa). Include 0.2
// kPa and 0.1 mm readout allowance (roughly one pixel per axis on a 5× PDF
// crop) and round out to 0.1 mm. These are spreads from the figure, with no
// inferred confidence level or allowance for uncertainty in the circular fit.
const quartz = {
  cohesiveModulus: -9800,
  frictionalModulus: 1_200_000,
  exponent: 0.82,
  density: 1564,
  compaction: 1,
  dustFraction: 0,
};
const roundPlateArea = Math.PI * 0.05 ** 2;
const rectangles = [
  { aspect: 3, pressure: 22_000, measured: 9.48, range: [7.6, 13.9] },
  { aspect: 5, pressure: 22_000, measured: 12.8, range: [10.2, 15.2] },
  { aspect: 7, pressure: 22_000, measured: 14.2, range: [9.9, 18.5] },
  { aspect: 3, pressure: 48_000, measured: 26.06, range: [23.4, 29.4] },
  { aspect: 5, pressure: 48_000, measured: 36.9, range: [32.7, 41.1] },
  { aspect: 7, pressure: 48_000, measured: 39.49, range: [35.5, 43.3] },
];

// M. Rashidi and M. Gholami, Non-linear modeling of soil sinkage by multiple
// loadings using the finite element method (2011), pp. 73–81, Fig. 7.
// https://www.arpnjournals.com/jabs/research_papers/rp_2011/jabs_0311_255.pdf
// Only sparse factual readings of the red laboratory markers (mean of three
// replicates). ±1.5 mm covers approximately half the plotted marker height
// and rounding; replicate scatter is unavailable. The test protocol reports
// measurements after each cycle. The loaded-plate ratio is also printed to
// check sensitivity to the interpretation of the plotted sampling phase.
const cycleMeasurements = [
  { cycle: 1, depth: 57 },
  { cycle: 3, depth: 83 },
  { cycle: 10, depth: 98 },
];
const cycleReadout = 1.5;
const cyclePlate = { length: 0.06, width: 0.04 };
const firstCyclePressure = [40_000, 80_000, 120_000, 160_000, 200_000, 0];
const repeatedPressure = [200_000, 0];
const cyclicPressures = [...firstCyclePressure];
for (let cycle = 2; cycle <= 10; ++cycle) cyclicPressures.push(...repeatedPressure);

const tiers = ['mean', 'resolved'];
const rate = { num: 60, den: 1 };
const fixed = (value) => Number(value.toFixed(5));

function grid(cells, span) {
  return { columns: cells, rows: cells, width: span, depth: span, centre: [0, 0] };
}

async function singlePlate(tier, cells, test) {
  const terrain = grid(cells, 0.32);
  const length = Math.sqrt(roundPlateArea * test.aspect);
  const width = Math.sqrt(roundPlateArea / test.aspect);
  const load = test.pressure * length * width;
  const soil = await Terramechanics.load({ tier });
  const bed = new TerrainBed();
  const world = new PhysicsWorld({ rate })
    .add(bed, { ...terrain, elevations: () => 0 })
    .add(soil, {
      terrain,
      material: quartz,
      patches: [{ x: 0, z: 0, length, width, load }],
    })
    .couple(['terramechanics', 'bed'], 'staggered');
  world.advance(1);
  const { normalForce, sinkage } = soil.read(0);
  assert.ok(Math.abs(normalForce - load) < 1e-10, 'footprint must support the commanded force');
  assert.equal(bed.refusedVolume(), 0);
  return sinkage * 1000;
}

function cycleDriver(field) {
  const id = 'lab-plate';
  let region;
  let memory;
  const { length, width } = cyclePlate;
  return {
    describe: () => ({
      id,
      rate: 0,
      stableRate: () => 0,
      fields: [{ field, access: 'write' }],
    }),
    init(host) {
      memory = host.memory;
      region = host.allocate(id, 10 * Float64Array.BYTES_PER_ELEMENT, 'f64', 1);
    },
    step({ tick }) {
      const load = cyclicPressures[tick] * length * width;
      assert.ok(Number.isFinite(load), 'unexpected plate tick');
      regionWords(memory, region).set([0, 0, 0, 1, length, width, load, 0, 0, 0]);
    },
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

async function runCycles(tier, cells, frictionalModulus) {
  const terrain = grid(cells, 0.25);
  const floor = -0.2;
  const input = soilPatchField();
  const soil = await Terramechanics.load({ tier, input });
  const bed = new TerrainBed();
  // The source gives FEM elasticity and plasticity, which do not specify a
  // Bekker or unloading fit. Independently vary illustrative model stiffness
  // at fixed measured geometry/load and compare within-run depth ratios.
  const material = {
    cohesiveModulus: 0,
    frictionalModulus,
    exponent: 1,
    compaction: 1,
    dustFraction: 0,
    density: 1700,
    unloading: { stiffness: 2 * frictionalModulus },
  };
  const world = new PhysicsWorld({ rate })
    .add(cycleDriver(input))
    .add(soil, { terrain, inputRows: 1, material, floor })
    .add(bed, { ...terrain, elevations: () => 0, bedrock: () => floor })
    .couple(['lab-plate', 'terramechanics', 'bed'], 'staggered');

  const cycles = [];
  const centre = (cells / 2) * (cells + 2);
  let peak;
  for (const [i, pressure] of cyclicPressures.entries()) {
    world.advance(i + 1);
    const sinkage = -bed.elevations()[centre];
    assert.ok(sinkage > 0 && sinkage < -floor, 'the bed floor must stay inactive');
    if (pressure === 200_000) {
      peak = sinkage;
      assert.ok(Math.abs(soil.read(0).normalForce - pressure * cyclePlate.length * cyclePlate.width) < 1e-10);
    }
    if (pressure === 0) cycles.push({ peak, residual: sinkage });
  }
  assert.equal(bed.refusedVolume(), 0);
  assert.equal(cycles.length, 10);
  return cycles;
}

const plateResults = [];
for (const test of rectangles) {
  for (const tier of tiers) {
    const coarse = await singlePlate(tier, 128, test);
    const fine = await singlePlate(tier, 256, test);
    const gridShift = Math.abs(fine - coarse);
    const overlap = fine + gridShift >= test.range[0] && fine - gridShift <= test.range[1];
    plateResults.push({
      aspect: `1:${test.aspect}`,
      load_kPa: test.pressure / 1000,
      tier,
      observed_mm: test.measured,
      whisker_range_mm: test.range,
      predicted_mm: fixed(fine),
      difference_mm: fixed(fine - test.measured),
      grid_shift_mm: fixed(gridShift),
      overlap,
    });
  }
}

const cycleResults = [];
for (const tier of tiers) {
  for (const modulus of [4e6, 8e6]) {
    const coarse = await runCycles(tier, 100, modulus);
    const fine = await runCycles(tier, 200, modulus);
    const firstDepth = cycleMeasurements[0].depth;
    for (const { cycle, depth } of cycleMeasurements.slice(1)) {
      const ratio = fine[cycle - 1].residual / fine[0].residual;
      const peakRatio = fine[cycle - 1].peak / fine[0].peak;
      const coarseRatio = coarse[cycle - 1].residual / coarse[0].residual;
      const gridShift = Math.abs(ratio - coarseRatio);
      const low = (depth - cycleReadout) / (firstDepth + cycleReadout);
      const high = (depth + cycleReadout) / (firstDepth - cycleReadout);
      cycleResults.push({
        cycle,
        tier,
        illustrative_modulus_Pa_per_m: modulus,
        observed_ratio_to_first: fixed(depth / firstDepth),
        readout_range: [fixed(low), fixed(high)],
        predicted_residual_ratio: fixed(ratio),
        predicted_peak_ratio: fixed(peakRatio),
        grid_shift: fixed(gridShift),
        overlap: ratio + gridShift >= low && ratio - gridShift <= high,
      });
    }
  }
}

console.log(JSON.stringify({ plateResults, cycleResults }, null, 2));
