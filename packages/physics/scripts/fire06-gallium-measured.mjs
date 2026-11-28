import { HeatConduction } from '@margoengine/physics/thermal';
import { PhysicsWorld } from '@margoengine/physics/world';

// Run after building Physics:
// node packages/physics/scripts/fire06-gallium-measured.mjs
//
// C. Gau and R. Viskanta, Melting and Solidification of a Pure Metal on a
// Vertical Wall (1986), doi:10.1115/1.3246884, Fig. 2(a), A = H/L = 0.714.
// Left copper wall at 38 °C; the right wall holds the initial uniform solid
// temperature. The paper describes 1–2 K initial subcooling without a separate
// value for each traced profile. Use the midpoint and run both endpoints.
// The horizontal distance between plates is 88.9 mm; the heated face is
// 63.5 × 38.1 mm. Those directions follow the stated aspect ratio and the
// dimensioned geometry in S. Meyer, A Fluid Dynamics Approach for Solid-Liquid
// Phase Change in Binary and Elemental Melts (2016), §5.2 and Figs. 5.7–5.8.
// https://publikationen.bibliothek.kit.edu/1000058183/3880102
const length = 0.0889;
const height = 0.0635;
const depth = 0.0381;
const hotKelvin = 311.15;
const meltKelvin = 302.93;
const frameRate = 60;

// Distances from the hot wall at 10%, 50% and 90% height above the floor.
// These are sparse numerical readings of the original measured pour-out
// traces as reproduced by Meyer, Fig. 5.8 (black dashed traces only), with an
// estimated 0.7 mm figure-reading allowance based on stroke width, scale
// and rounding. The paper does not provide instrument or trial error bars.
const heights = [0.1, 0.5, 0.9];
const measured = [
  { minutes: 3, frontMm: [11.9, 13.2, 15.3] },
  { minutes: 10, frontMm: [20.6, 31.1, 44] },
  { minutes: 17, frontMm: [23.7, 59.7, 70.3] },
];
const readoutMm = 0.7;

// The solid reference volume uses 5904 kg/m³ from NBS SP 481, The Gallium
// Melting-Point Standard (1977), p. 2. NIST-JANAF (Chase 1998, Ga, 1254–1256)
// gives 5.59 kJ/mol latent heat and near-melt 26.15/28.46 J/(mol K) heat
// capacities. Divide by 0.069723 kg/mol, then multiply by the fixed density.
// Assael et al. (2017), Reference Correlations for the Thermal Conductivity
// of Liquid Copper, Gallium, Indium, Iron, Lead, Nickel and Tin, Eq. (2) and
// Table 8, gives 28.403 + 0.071896(T - 302.914) at the liquid temperatures in
// the experiment. Use the film midpoint without tuning. The solver has one
// scalar conductivity for either phase, so solid anisotropy, melt advection
// and phase volume change are outside this representation.
// https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nbsspecialpublication481.pdf
// https://janaf.nist.gov/pdf/JANAF-FourthEd-1998-Gallium.pdf
// https://pmc.ncbi.nlm.nih.gov/articles/PMC5772911/
const massPerMole = 0.069723;
const molesPerVolume = 5904 / massPerMole;
const filmKelvin = (meltKelvin + hotKelvin) / 2;
const conductivity = 28.403 + 0.071896 * (filmKelvin - 302.914);
const material = {
  conductivity,
  heatCapacity: 26.15 * molesPerVolume,
  phaseChange: {
    temperature: meltKelvin,
    latentHeat: 5590 * molesPerVolume,
    liquidHeatCapacity: 28.46 * molesPerVolume,
  },
};

async function run(nx, ny, subcoolingK) {
  const solver = await HeatConduction.load();
  const coldKelvin = meltKelvin - subcoolingK;
  const dx = length / nx;
  const world = new PhysicsWorld({ rate: { num: frameRate, den: 1 } }).add(solver, {
    dimensions: [nx, ny, 1],
    cellSize: [dx, height / ny, depth],
    initialTemperature: coldKelvin,
    materials: material,
    boundaries: {
      xMin: { kind: 'temperature', kelvin: hotKelvin },
      xMax: { kind: 'temperature', kelvin: coldKelvin },
    },
  });

  return measured.map(({ minutes }) => {
    world.advance(minutes * 60 * frameRate);
    const phase = solver.readLiquidFraction();
    const rowFronts = Array.from({ length: ny }, (_, y) => {
      let melt = 0;
      for (let x = 0; x < nx; ++x) melt += phase[y * nx + x];
      return melt * dx * 1000;
    });
    // Integrate the finite-volume melt fraction along each row to compare
    // with the sharp front when each row contains a single connected melt.
    return heights.map((relativeHeight) => {
      const y = Math.min(ny - 1, Math.max(0, relativeHeight * ny - 0.5));
      const lower = Math.floor(y);
      const upper = Math.min(ny - 1, lower + 1);
      return rowFronts[lower] + (y - lower) * (rowFronts[upper] - rowFronts[lower]);
    });
  });
}

const round = (value) => Number(value.toFixed(4));
const coarse = await run(48, 12, 1.5);
const fine = await run(96, 24, 1.5);
// The imposed side-wall temperatures and all material fields are uniform in
// height; the expected planar solution reduces to one row for sensitivity.
const warm = await run(96, 1, 1);
const cold = await run(96, 1, 2);

const profiles = measured.map(({ minutes, frontMm }, time) => ({
  minutes,
  observed_span_mm: round(frontMm[2] - frontMm[0]),
  predicted_span_mm: round(fine[time][2] - fine[time][0]),
  observations: frontMm.map((observedMm, row) => {
    const predicted = fine[time][row];
    const gridShift = Math.abs(coarse[time][row] - predicted);
    const range = [Math.min(warm[time][row], cold[time][row]), Math.max(warm[time][row], cold[time][row])];
    const overlap = range[1] + gridShift + readoutMm >= observedMm && range[0] - gridShift - readoutMm <= observedMm;
    return {
      height_fraction: heights[row],
      observed_mm: observedMm,
      predicted_mm: round(predicted),
      difference_mm: round(predicted - observedMm),
      grid_shift_mm: round(gridShift),
      cold_wall_sensitivity_mm: range.map(round),
      readout_and_sensitivity_overlap: overlap,
    };
  }),
}));
console.log(JSON.stringify({ figure_readout_mm: readoutMm, conductivity, profiles }, null, 2));
