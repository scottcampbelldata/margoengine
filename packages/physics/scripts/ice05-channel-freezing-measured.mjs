import { ICE_FIELD_LAYOUT, ICE_TEMPERATURE_FIELD, IceSolver } from '@margoengine/physics/ice';
import { PhysicsWorld, regionWords } from '@margoengine/physics/world';

// Run after building Physics:
// node packages/physics/scripts/ice05-channel-freezing-measured.mjs
//
// Bouke Johannes Kaaks, Danny Lathouwers, Jan-Leen Kloosterman and Martin Rohde,
// Transient freezing of water in a square channel: An experimental investigation
// (2025), doi:10.1016/j.expthermflusci.2025.111417. CC BY 4.0.
// Eq. (21) and Table 2 fit the independent cold-plate thermocouple measurements.
// Only the nominal −10 °C trials are used, with the time measured from the
// authors' thermocouple-detected nucleation. The flow is initially ice-free.
// Fig. 7 green curve marker centres were mapped from the vector PDF against
// each axes' 0–25 mm scale. The optical thickness values are held out.
// The reported error bars are 0.2 mm (one SD from five Re=474 repeats,
// applied by the authors to the other Reynolds regime); allow another
// 0.05 mm for reading the plotted centres. This is not a confidence bound.
const trials = [
  {
    reynolds: 474,
    temperatureCoefficients: [7.04, 6.363, 0.791, -0.401, -8.215],
    flowLitresPerSecond: 0.034,
    inletC: 4.68,
    outletC: 4.1,
    inletIceMm: [9.09, 11.76, 12.85, 13.47],
    centreIceMm: [10.48, 15.42, 18.48, 20.69],
  },
  {
    reynolds: 1118,
    temperatureCoefficients: [1.006, 0.452, -6.329, 4.139, -2.763],
    flowLitresPerSecond: 0.085,
    inletC: 4.8,
    outletC: 4.4,
    inletIceMm: [7.52, 9.0, 9.32, 9.68],
    centreIceMm: [10.04, 14.43, 17.27, 19.08],
  },
];
const timesMinutes = [30, 60, 90, 120];
const labThicknessMm = 0.25;
const thermocoupleK = 0.25;
const floorArea = 0.05 * 1.45;
const icePoint = 273.15;
const rate = 60;
const channelHeight = 0.05;
const precision = (value) => Number(value.toFixed(4));

function plateC(trial, seconds) {
  const [a, b, c, d, e] = trial.temperatureCoefficients;
  const hours = seconds / 3600;
  return a * Math.exp(-b * hours) + c * Math.tanh(d * hours) + e;
}

function averageWaterFlux(trial) {
  // Independent fluid calorimetry from Table 2 and the nominal channel floor.
  // At 1000 kg/m³ the L/s numeric value equals kg/s. The measured bulk
  // temperature difference is small and rounded. The estimate is applied
  // uniformly for sensitivity only. It does not recover the local flux or
  // distinguish fluid storage and other losses from heat reaching the front.
  return (trial.flowLitresPerSecond * 4200 * (trial.inletC - trial.outletC)) / floorArea;
}

const variants = [
  { label: 'slab', shiftK: 0 },
  { label: 'plate +0.25 K', shiftK: thermocoupleK },
  { label: 'plate −0.25 K', shiftK: -thermocoupleK },
  // The 2.10 cm by k=140 W/(m K) aluminium plate is a small steady thermal
  // resistance in series. Reuse the solver's optional insulating layer as
  // that resistance for this sensitivity, with Table 1 ice conductivity.
  {
    label: 'paper conductivity and passive plate resistance',
    shiftK: 0,
    site: { conductivity: 2.16, snowThickness: 0.021, snowConductivity: 140 },
  },
  { label: 'uniform bulk water heat sensitivity', shiftK: 0, flux: averageWaterFlux },
];
const states = trials.flatMap((trial) => variants.map((variant) => ({ trial, variant })));

function plateForcing() {
  const id = 'laboratory-cold-plate';
  let memory;
  let region;
  return {
    describe: () => ({
      id,
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: ICE_TEMPERATURE_FIELD, access: 'write' }],
    }),
    init(host) {
      memory = host.memory;
      region = host.allocate(id, states.length * Float64Array.BYTES_PER_ELEMENT, 'f64', ICE_FIELD_LAYOUT);
    },
    step({ tick }) {
      const temperatures = regionWords(memory, region);
      const middleSeconds = (tick + 0.5) / rate;
      for (let index = 0; index < states.length; ++index) {
        const { trial, variant } = states[index];
        temperatures[index] = icePoint + plateC(trial, middleSeconds) + variant.shiftK;
      }
    },
    exportPorts: (tick) => [{ field: ICE_TEMPERATURE_FIELD.name, region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

const ice = new IceSolver({ readTemperature: true });
const world = new PhysicsWorld({ rate: { num: rate, den: 1 } })
  .add(plateForcing())
  .add(ice, {
    sites: states.map(({ trial, variant }) => ({
      kind: 'sheet',
      temperature: icePoint + plateC(trial, 0) + variant.shiftK,
      waterHeatFlux: variant.flux?.(trial) ?? 0,
      ...variant.site,
    })),
  })
  .couple(['laboratory-cold-plate', 'ice-thermodynamics'], 'staggered');

const rows = [];
for (const [timeIndex, minutes] of timesMinutes.entries()) {
  world.advance(minutes * 60 * rate);
  for (const [index, { trial, variant }] of states.entries()) {
    const predicted = ice.sample(index).thickness * 1000;
    for (const [x, observed] of [
      [5, trial.inletIceMm[timeIndex]],
      [75, trial.centreIceMm[timeIndex]],
    ]) {
      const error = predicted - observed;
      rows.push({
        Re: trial.reynolds,
        x_cm: x,
        minutes,
        model: variant.label,
        mean_water_heat_W_m2: precision(variant.flux?.(trial) ?? 0),
        plate_C: precision(plateC(trial, minutes * 60) + variant.shiftK),
        measured_mm: observed,
        predicted_mm: precision(predicted),
        difference_mm: precision(error),
        outside_plot_band: Math.abs(error) > labThicknessMm,
        beyond_channel_height: predicted > channelHeight * 1000,
      });
    }
  }
}
console.log(JSON.stringify({ measured_plot_band_mm: labThicknessMm, rows }, null, 2));
