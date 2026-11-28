// Vera et al. (2022), Corrosion Behavior of Copper Exposed in Marine Tropical Atmosphere
// in Rapa Nui (Easter Island) Chile 20 Years after MICAT, https://doi.org/10.3390/met12122082.
// CC BY 4.0. Rapa Nui, 500 m inland, April 2010–April 2013: Figure 3 weather, Table 1
// deposition, and §3.2 / Figure 6 triplicate coupon loss. The new coupons postdate the
// original ISO 9223 dose-response fit (Mikhailov et al. 2004, DOI 10.1023/B:PROM.0000049517.14101.68).
// Paterlini, Brenna, Ceriani, Gamba, Ormellese & Bolzoni (2024), Atmospheric Corrosion
// of Different Steel Types in Urban and Marine Exposure, https://doi.org/10.3390/ma17246211.
// CC BY 4.0. Milan, May 2022 start: Tables 6 and 9 report climate and independent coupon loss.
// No coupon losses, site-fitted exponents or fitted coefficients are used as inputs.
// Run: node scripts/run-with-timeout.mjs --max=1 -- node packages/physics/scripts/bio04-ageing-measured.mjs

import assert from 'node:assert/strict';
import { AGEING_EXPOSURE_WORDS, AGEING_YEAR, MaterialAgeingSolver, writeAgeingExposure } from '../dist/ageing.js';
import { PhysicsWorld, regionWords, worldMemory } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const stepsPerYear = 12;
const micrometresPerMetre = 1e6;
const cell = [0, 0, 0];

const climate = (celsius, humidityPercent, sulphurDioxide, chloride) => ({
  temperature: celsius + 273.15,
  relativeHumidity: humidityPercent / 100,
  sulphurDioxide,
  chloride,
  submerged: 0,
});

// T and RH are day-weighted means of twelve square-marker centers for each May–April
// measured year in Figure 3. Read the 550 px figure at x = 103 + 12 i. The T axis has
// y = 142 at 0 °C and y = 21 at 40 °C, and the RH axis y = 252 at 0%, y = 153 at 90%.
// Rounding and roughly two raster pixels of registration give ±0.7 °C and ±2 RH pp.
// SO₂ and chloride are measured annual deposition in mg/(m² day), from Table 1.
const rapa = [climate(20.7, 71.5, 1.89, 53.04), climate(20.8, 73.7, 5.41, 51.13), climate(20.5, 73.9, 3.3, 48.37)];
const copperMonths = [12, 36];
// Figure 6A reports the average annualized loss, confirmed by cumulative Figure 6B.
// Rounding the published penetration alone permits ±0.005 µm/yr, separate from specimen spread.
const copperObserved = [2.1, 3.75];

// May 2022–May 2023 averages. Table 6 reports 2.3 µg/m³ SO₂ concentration, converted
// by ISO 9223 Table 3's Pd ≈ 0.8 Pc. The paper treats urban chloride as absent.
const milan = [climate(17.2, 63, 0.8 * 2.3, 0)];
const steelMonths = [10];
const steelObservedRate = 8.3; // µm/yr, cumulative gravimetric penetration divided by coupon exposure.
const steelObserved = [(steelObservedRate * 10) / 12];

class AnnualWeather {
  constructor(field, years, steps) {
    this.field = field;
    this.years = years;
    this.steps = steps;
  }

  describe() {
    return { id: 'annual-weather', rate: 0, stableRate: () => 0, fields: [{ field: this.field, access: 'write' }] };
  }

  init(host) {
    this.memory = host.memory;
    this.data = host.allocate('weather', AGEING_EXPOSURE_WORDS * 8, 'f64', 1);
    writeAgeingExposure(regionWords(this.memory, this.data), this.years[0]);
  }

  step({ tick }) {
    const studyYear = Math.floor(tick / this.steps);
    writeAgeingExposure(regionWords(this.memory, this.data), this.years[studyYear]);
  }

  exportPorts(tick) {
    return [{ field: this.field.name, region: this.data, tick, cell }];
  }

  importPorts() {}

  stateRegions() {
    return [this.data];
  }

  extraState() {
    return [];
  }
}

function forecast(material, thickness, years, months, refinement = 1) {
  const steps = stepsPerYear * refinement;
  const solver = new MaterialAgeingSolver({ readExposure: true });
  const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
  world.add(new AnnualWeather(solver.exposureField, years, steps), {});
  world.add(solver, { patches: [{ material, thickness }], timeScale: (AGEING_YEAR * rate.num) / steps });
  return months.map((month) => {
    world.advance(month * refinement);
    const state = solver.read(0);
    assert.ok(Math.abs(state.exposureSeconds / AGEING_YEAR - month / 12) < 256 * Number.EPSILON);
    assert.ok(state.consumedThickness > 0 && state.remainingThickness > 0);
    return state.consumedThickness * micrometresPerMetre;
  });
}

function compare(material, thickness, years, months, observed, readoutError) {
  const baseline = forecast(material, thickness, years, months);
  const refined = forecast(material, thickness, years, months, 4);
  return months.map((month, i) => ({
    months: month,
    observedLossUm: observed[i],
    observedRoundingUm: (readoutError * month) / 12,
    predictedLossUm: refined[i],
    predictedMeanRateUmPerYear: refined[i] / (month / 12),
    residualUm: refined[i] - observed[i],
    refinementChangeUm: Math.abs(refined[i] - baseline[i]),
  }));
}

const copper = compare('copper', 0.004, rapa, copperMonths, copperObserved, 0.005);
const copperCorners = [-0.7, 0.7].flatMap((deltaT) =>
  [-0.02, 0.02].map((deltaHumidity) => {
    const perturbed = rapa.map((weather) => ({
      ...weather,
      temperature: weather.temperature + deltaT,
      relativeHumidity: weather.relativeHumidity + deltaHumidity,
    }));
    return forecast('copper', 0.004, perturbed, copperMonths);
  }),
);
const steel = compare('steel', 0.002, milan, steelMonths, steelObserved, 0.05);
const [steelLowChloride] = forecast('steel', 0.002, [{ ...milan[0], chloride: 0.4 }], steelMonths);

console.log(
  JSON.stringify(
    {
      scope: 'Open-air metal penetration. No immersion, pitting, oxide thickness or appearance score.',
      rapaNui: {
        climate: rapa,
        results: copper.map((row, i) => ({
          ...row,
          digitizedClimateSensitivityUm: [
            Math.min(...copperCorners.map((c) => c[i])),
            Math.max(...copperCorners.map((c) => c[i])),
          ],
        })),
        limits:
          'Rounding of published coupon rates does not quantify experimental spread. The raw monthly weather records and coupon replicates are unavailable.',
      },
      milan: {
        climate: milan,
        observedMeanRateUmPerYear: steelObservedRate,
        results: steel,
        predictedLossUmWith0_4Chloride: steelLowChloride,
        limits:
          'First-year average forcing is a proxy for the first ten months. The chloride alternative is the low end of the ISO fit range, without a local detection-limit or field-uncertainty claim.',
      },
    },
    null,
    2,
  ),
);
