import { GroundwaterSolver } from '@margoengine/physics/groundwater';
import { PhysicsWorld } from '@margoengine/physics/world';

// Guérin, Devauchelle & Lajeunesse, "Response of a laboratory aquifer to rainfall", JFM 759, R1 (2014).
// https://doi.org/10.1017/jfm.2014.590
// Original author figure vectors and numerical readout: https://www.ipgp.fr/~devauchelle/Download/jfm_storm_flow.pdf
// Sections 2 and 4 supply the dimensions, independent Darcy-column conductivity and measured packing porosity.
// The experiment took that porosity as its drainable fraction, with a cited possible 10–15% decrease.
const length = 1.43;
const width = 0.05;
const bedDepth = 0.4;
const mL = 1e-6;
const worldHz = 60;
const rechargeField = {
  name: 'lab-rain',
  kind: 'uniformGrid',
  quantity: 'groundwaterRecharge',
  unit: 'm/s',
  centring: 'cell',
};

// Fig. 2 upper panel: digitized metered rainfall, plateau median over plot times 60–170 s and rounded edges.
// Fig. 2 lower panel: separate bucket discharge at 1 Hz. Reported precision 0.1 g/s (~0.1 mL/s).
// The lower axis spans 1000 s across 216.86 PDF points and 2 mL/s across 31.27 points.
// Allow 1 s for sample phase and plot readout, and 0.2 mL/s for instrument precision plus figure readout.
// Fig. 3 left: three externally imposed rain rates, and blue observed polylines at 10, 20 and 30 s.
// Those authors' curves already use elapsed time from discharge onset. Compare only the outlet-aligned rise.
// The absolute delay from rain to saturated recharge is unobserved in these panels.
const cases = [
  {
    label: '1 mm, Fig. 2 absolute clock',
    porosity: 0.4,
    conductivity: [0.0097, 0.0006],
    rain: { from: 48, until: 198, rate: 16.59 },
    observations: [
      [75, 0.1],
      [100, 1.9],
      [150, 5.37],
      [195, 7.5],
      [250, 4.73],
      [400, 2.22],
      [600, 1.22],
      [1000, 0.57],
    ],
    observedCrossing: { threshold: 0.5, nearTime: 80 },
  },
  ...[
    [8.3, 0.7, 1.47, 2.22],
    [16.8, 1.93, 3.68, 5.28],
    [36.7, 4.52, 9.72, 15.28],
  ].map(([rate, q10, q20, q30]) => ({
    label: '4 mm, Fig. 3 outlet-aligned, ' + rate + ' mL/s rain',
    porosity: 0.24,
    conductivity: [0.057, 0.01],
    rain: { from: 0, until: 30, rate },
    observations: [
      [10, q10],
      [20, q20],
      [30, q30],
    ],
  })),
];

class LabRain {
  constructor(columns, rain, secondsPerStep) {
    this.columns = columns;
    this.rain = rain;
    this.secondsPerStep = secondsPerStep;
  }

  describe() {
    return { id: 'lab-rain', fields: [{ field: rechargeField, access: 'write' }], rate: 0, stableRate: () => 0 };
  }

  init(host) {
    this.host = host;
    this.region = host.allocate('lab-rain', this.columns * Float64Array.BYTES_PER_ELEMENT, 'f64', 1);
  }

  step({ tick }) {
    const midpoint = (tick + 0.5) * this.secondsPerStep;
    const { from, until, rate } = this.rain;
    const source = midpoint >= from && midpoint < until ? (rate * mL) / (length * width) : 0;
    new Float64Array(this.host.memory.buffer, this.region.byteOffset, this.columns).fill(source);
  }

  exportPorts(tick) {
    return [{ field: rechargeField.name, region: this.region, tick, cell: this.host.cell }];
  }

  importPorts() {}

  stateRegions() {
    return [this.region];
  }

  extraState() {
    return [];
  }
}

async function run(trial, columns, secondsPerStep, sensitivity = 0) {
  const aquifer = await GroundwaterSolver.load({ rechargeField });
  const [conductivity, measuredSpread] = trial.conductivity;
  const rain = { ...trial.rain, rate: trial.rain.rate * (1 + 0.02 * sensitivity) };
  const world = new PhysicsWorld({ rate: { num: worldHz, den: 1 } })
    .add(new LabRain(columns, rain, secondsPerStep))
    .add(aquifer, {
      grid: { width: length, depth: width, columns, rows: 1, centre: [length / 2, 0] },
      bottom: 0,
      surface: bedDepth,
      initialHead: 0,
      conductivity: conductivity + sensitivity * measuredSpread,
      specificYield: sensitivity > 0 ? 0.85 * trial.porosity : trial.porosity,
      sideHeads: { minX: 0 },
      secondsPerSecond: secondsPerStep * worldHz,
    });
  const duration = trial.observations.at(-1)[0];
  let previous = 0;
  let crossed = null;
  const flows = new Float64Array(duration + 1);
  for (let second = 1; second <= duration; second++) {
    world.advance(second / secondsPerStep);
    const totalOut = aquifer.budget.boundaryOut;
    flows[second] = (totalOut - previous) / mL;
    previous = totalOut;
    if (trial.observedCrossing && crossed === null && flows[second] >= trial.observedCrossing.threshold)
      crossed = second;
  }
  const { storage, recharge, boundaryIn, boundaryOut, seepage, spring } = aquifer.budget;
  const expectedRecharge = (rain.until - rain.from) * rain.rate * mL;
  world.remove(aquifer.id);
  aquifer[Symbol.dispose]?.();
  return {
    crossed,
    flows,
    volumeResidualM3: storage + boundaryOut + seepage + spring - recharge - boundaryIn,
    appliedRainResidualM3: recharge - expectedRecharge,
  };
}

const results = [];
for (const trial of cases) {
  const coarse = await run(trial, 96, 1);
  const fine = await run(trial, 192, 0.5);
  const lowInput = await run(trial, 192, 0.5, -1);
  const highInput = await run(trial, 192, 0.5, 1);
  results.push({
    label: trial.label,
    setup: { porosity: trial.porosity, conductivityMps: trial.conductivity, rain: trial.rain },
    residualsM3: { waterBudget: fine.volumeResidualM3, appliedRain: fine.appliedRainResidualM3 },
    timing: trial.observedCrossing && {
      measuredPlotTimeS: trial.observedCrossing.nearTime,
      thresholdMLps: trial.observedCrossing.threshold,
      coarseTimeS: coarse.crossed,
      fineTimeS: fine.crossed,
    },
    samples: trial.observations.map(([t, observed]) => ({
      timeS: t,
      observed,
      modeled: fine.flows[t],
      difference: fine.flows[t] - observed,
      discretizationDifference: Math.abs(fine.flows[t] - coarse.flows[t]),
      inputSensitivity: [lowInput.flows[t], highInput.flows[t]],
    })),
  });
}

console.log(
  JSON.stringify(
    {
      units: 'mL/s, seconds, m³ water balance',
      numericalRefinement: '96 → 192 cells, 1 → 0.5 physical seconds per world tick',
      hydrographReadout: { rateMLps: 0.2, sampleTimeS: 1 },
      inputSensitivity:
        'published K spread and ±2% rain meter precision; larger-input case uses 15% less drainable fraction',
      verticalTransit: 'The aquifer is recharged directly; these runs use no transit-time correction.',
      results,
    },
    null,
    2,
  ),
);
