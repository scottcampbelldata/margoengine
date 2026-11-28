// Boers, M. (1996), Simulation of a Surf Zone with a Barred Beach, Report 1, CommHydr9605:
// https://resolver.tudelft.nl/uuid:22dfbc0a-adf8-44cb-9659-9d0a366c88d6
// Observed gauge Hm0 and mean level only, read from the black markers in Fig. 10 of
// Moghimi et al. (2020), Development of an ESMF Based Flexible Coupling Application
// of ADCIRC and WAVEWATCH III for High Fidelity Coastal Inundation Studies,
// https://doi.org/10.3390/jmse8050308 (CC BY 4.0). Bed readings are physical
// geometry from Daly et al. (2012), Fig. 2, https://doi.org/10.1016/j.coastaleng.2011.08.001.
// Janssen, Battjes and van Dongeren (2003), Sec. 2.1 and Table 1,
// https://doi.org/10.1029/2002JC001515, documents the profile datum, smooth concrete,
// case forcing at x=0, and typically 30 min of measurements sampled at 20 Hz.
// No original report pages, figures, raw series, or another model's outputs are distributed.
// Run: node scripts/run-with-timeout.mjs --max=2 -- node packages/physics/scripts/sea05-boers-measured.mjs

import { bedSurface } from '../dist/earth.js';
import { ShallowWaterSolver } from '../dist/hydro.js';
import { SurfSolver } from '../dist/surf.js';
import { PhysicsWorld } from '../dist/world.js';

const gauges = [10, 20, 22, 25, 27];
const cases = [
  // Table 3 in Moghimi et al., independent offshore Hm0 (m) and Tp (s) at the profile toe.
  // Observed downstream Hm0 (m) and mean elevation (mm above the 0.750 m nominal datum).
  {
    name: '1A',
    height: 0.157,
    period: 2.05,
    observedHeight: [0.152, 0.132, 0.103, 0.093, 0.068],
    observedSetup: [-1.2, -1.5, 0.8, 1.8, 5.7],
  },
  {
    name: '1B',
    height: 0.206,
    period: 2.03,
    observedHeight: [0.185, 0.146, 0.112, 0.107, 0.076],
    observedSetup: [-2, -0.7, 2.6, 4, 7.5],
  },
  {
    name: '1C',
    height: 0.103,
    period: 3.33,
    observedHeight: [0.116, 0.12, 0.103, 0.094, 0.07],
    observedSetup: [-0.3, -1.4, -0.6, -0.1, 3.9],
  },
];

// x (m) from the first offshore gauge, bed elevation (m) relative to nominal SWL.
// Include closely spaced reads around the measured ~21 m outer bar and its lee.
const bedProfile = [
  [0, -0.75],
  [1, -0.686],
  [2, -0.642],
  [4, -0.55],
  [6, -0.457],
  [8, -0.411],
  [10, -0.392],
  [12, -0.362],
  [14, -0.329],
  [16, -0.305],
  [18, -0.272],
  [19, -0.25],
  [19.5, -0.231],
  [20, -0.212],
  [20.25, -0.196],
  [20.5, -0.177],
  [20.75, -0.163],
  [21, -0.163],
  [21.25, -0.174],
  [21.5, -0.19],
  [22, -0.193],
  [23, -0.19],
  [23.5, -0.182],
  [24, -0.169],
  [24.5, -0.141],
  [25, -0.114],
  [25.5, -0.101],
  [26, -0.098],
  [27, -0.084],
  [28, -0.068],
  [29, -0.033],
  [30, 0.011],
  [30.5, 0.044],
  [31, 0.06],
  [31.5, 0.071],
  [32, 0.071],
];

// Two printed-image pixels in X and three in Y at 144 dpi, rounded up.
// Gauge calibration, finite-sample uncertainty and repeatability are unquantified
// in Fig. 10. The resulting comparison is a readout/sensitivity band, not a confidence interval.
const gaugeReadout = { x: 0.21, height: 0.007, setup: 0.46 };
const flumeWidth = 0.8;
const flumeLength = 32;
const positions = gauges.flatMap((x) => [x - gaugeReadout.x, x, x + gaugeReadout.x]);

function elevation(x) {
  const high = bedProfile.findIndex(([metres]) => metres > x);
  if (high < 0) return bedProfile.at(-1)[1];
  const [a, lowZ] = bedProfile[high - 1];
  const [b, highZ] = bedProfile[high];
  return lowZ + ((x - a) / (b - a)) * (highZ - lowZ);
}

function simulate({ height, period }, dx, rate, directions) {
  const columns = flumeLength / dx;
  const bed = bedSurface(
    { columns, rows: 1, width: flumeLength, depth: flumeWidth, centre: [flumeLength / 2, flumeWidth / 2] },
    Float64Array.from({ length: 2 * (columns + 1) }, (_, i) => elevation(Math.floor(i / 2) * dx)),
  );
  const water = new ShallowWaterSolver();
  const surf = new SurfSolver();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 } })
    .add(water, {
      bed,
      level: 0,
      sides: { minX: { sea: 0 }, minZ: 'periodic', maxZ: 'periodic' },
      // FHWA Hydraulic Design Series 3, Table 1, smooth lined concrete design value.
      // https://www.fhwa.dot.gov/engineering/hydraulics/pubs/hds3.pdf
      roughness: 0.012,
    })
    .add(surf, {
      water,
      incident: { height, period, direction: 0, spreading: 200 },
      density: 1000,
      groups: false,
      alongshore: 'periodic',
      directions,
    })
    .couple(['surf', 'water'], 'staggered');
  const z = flumeWidth / 2;
  world.advance(60 * rate);
  function average(firstSecond, lastSecond) {
    const heightSquares = new Float64Array(positions.length);
    const setUp = new Float64Array(positions.length);
    for (let second = firstSecond; second <= lastSecond; second++) {
      world.advance(second * rate);
      for (const [i, x] of positions.entries()) {
        heightSquares[i] += surf.waveHeight(x, z) ** 2;
        setUp[i] += 1000 * water.sample(x, z).surface;
      }
    }
    const count = lastSecond - firstSecond + 1;
    return {
      height: heightSquares.map((value) => Math.sqrt((2 * value) / count)),
      setup: setUp.map((value) => value / count),
    };
  }
  return { early: average(61, 120), late: average(121, 180) };
}

function comparison(quantity, gauge, observed, coarse, fine) {
  const i = 3 * gauge + 1;
  const predicted = fine.late[quantity][i];
  const residual = predicted - observed;
  if (!Number.isFinite(residual))
    throw new Error(`Nonfinite ${quantity} at gauge x=${gauges[gauge]}; inspect both coupled steps.`);
  const refinement = Math.abs(predicted - coarse.late[quantity][i]);
  const drift = Math.abs(predicted - fine.early[quantity][i]);
  const placement = Math.max(
    Math.abs(predicted - fine.late[quantity][i - 1]),
    Math.abs(predicted - fine.late[quantity][i + 1]),
  );
  const digitization = gaugeReadout[quantity];
  return {
    observed,
    predicted,
    residual,
    refinement,
    drift,
    placement,
    digitization,
    withinReadoutAndSensitivity: Math.abs(residual) <= refinement + drift + placement + digitization,
  };
}

// The steady envelope uses measured Hm0 and Tp and keeps the production breaking/roller closure unchanged.
// The test addresses mean elevation and bulk wave height. The laboratory's exact repeat-cycle phases,
// the low-frequency contribution to measured Hm0 and side drag are unavailable to this comparison.
for (const conditions of cases) {
  const coarse = simulate(conditions, 0.4, 20, 9);
  const fine = simulate(conditions, 0.2, 40, 17);
  console.log(
    JSON.stringify({
      case: conditions.name,
      incidentHeight: conditions.height,
      incidentPeriod: conditions.period,
      gauges: gauges.map((x, i) => ({
        x,
        heightMetres: comparison('height', i, conditions.observedHeight[i], coarse, fine),
        setupMillimetres: comparison('setup', i, conditions.observedSetup[i], coarse, fine),
      })),
    }),
  );
}
