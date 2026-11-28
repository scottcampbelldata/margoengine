// ATMO-09 diagnostic. Run after building Weather and Physics:
// node packages/weather/scripts/atmo09-col-de-porte-measured.mjs <TSV folder>
// For each of 774240, 774238, 774237 and 774219, download the unmodified
// https://doi.pangaea.de/10.1594/PANGAEA.<id>?format=textfile to atmo09-<id>.tsv.
//
// Morin, Lejeune, Lesaffre, Panel, Poncet, David & Sudul (2012), Col de Porte:
// https://doi.org/10.5194/essd-4-13-2012 and https://doi.org/10.1594/PANGAEA.774249.
// Data: CC BY 3.0, https://creativecommons.org/licenses/by/3.0/. No data are embedded.
// §§2.2.1–2.2.5 describe the forcing and quality control. The record can contain
// gap-fills without a row-level flag. We use dry January episodes to avoid the
// reconstruction of incoming shortwave during snowfall. Direct + diffuse is
// the downwelling horizontal shortwave. Soil at 0.5 m and the previous day's
// integrated albedo and cosmic-ray SWE initialize the patch. PANGAEA labels
// albedo as %, but the published numeric values are fractions (e.g. 0.82).
//
// §2.3.4 uses emissivity 1 to convert outgoing longwave to snow surface
// temperature and describes a lower-of-two sensor product: hourly integrated
// pyrgeometer and instantaneous narrow IR. The 774238 metadata identifies
// the pyrgeometer; there is no row-level sensor flag. We compare to both the
// modelled hourly effective radiometric temperature and the end-of-hour
// value. With production emissivity .97, outgoing longwave includes reflected
// sky radiation. We invert the start observation with the start LWD for this
// gray surface, and compare both forward projections. The independent
// emissivity-1 sensitivity uses the authors' retrieval assumption, no fit.
//
// The later station release explicitly says timestamps are UTC:
// https://doi.org/10.5194/essd-11-71-2019 §2. The original TSV does not name
// the side of the hourly averaging window. We use end-labelled forcing as
// in the ESM-SnowMIP reference-site conventions and show left labels as a
// separate timing sensitivity. No timing selection by agreement.
// https://www.geos.ed.ac.uk/~ressery/ESM-SnowMIP/ESMSnowMIP_Reference_sites.pdf §2.
//
// The 10% outgoing-radiation range is an order-of-magnitude instrument
// sensitivity from §§2.2.3 and 2.3.4, mapped by the fourth root. It is not a
// confidence or acceptance interval; it excludes forcing, representativeness,
// sampling and initialization errors. No scored temperature, flux, albedo,
// melt or runoff is used for any setting. Keep the default effective heat
// storage, ground conductance and resistances; wind is listed for context
// because this run has no wind-to-resistance closure. This is a single-site
// diagnostic, with no independent flux or melt claim.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PhysicsWorld, regionWords } from '@margoengine/physics/world';
import { SurfaceEnergySolver } from '../dist/surface-energy.js';

const freezing = 273.15;
const stefanBoltzmann = 5.670374419e-8;
const framesPerSecond = 60;
const framesPerHour = 3600 * framesPerSecond;
const emissivities = [0.97, 1];
const hours = 3;
const initialStarts = [
  { regime: 'weak-wind nocturnal longwave loss', stamp: '2010-01-07T00:00' },
  { regime: 'high incoming shortwave over snow', stamp: '2010-01-31T11:00' },
];
const sourceHashes = {
  774240: '6623eab36ef9e7abb104dd67100d83cdc8504fdde327da043417ecb7d4da5259',
  774238: 'a81f7ea9bec08cdcea33a3c6bcf38d5fbc311368a27997a873a9a4f116b3ff31',
  774237: '254ba50cc5a255e9b4e43de4adfccc55f32d5ada728f11983d30039ce29e7e2a',
  774219: 'd355ef5093ea4a52a9a81acc014dedfea75ca00969028982e3c68ef46c50b76a',
};

function number(value, label) {
  assert.ok(value?.trim(), `Missing ${label}`);
  const parsed = Number(value);
  assert.ok(Number.isFinite(parsed), `Invalid ${label}`);
  return parsed;
}

async function load(folder, id, use = () => true) {
  const bytes = await readFile(join(folder, `atmo09-${id}.tsv`));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sourceHashes[id], `PANGAEA ${id} version`);
  const text = bytes.toString('utf8');
  const commentEnd = text.indexOf('*/');
  assert.ok(commentEnd >= 0, `Missing PANGAEA ${id} metadata`);
  const [header, ...body] = text
    .slice(commentEnd + 2)
    .trimStart()
    .split(/\r?\n/);
  assert.ok(header.startsWith('Date/Time\t'), `Unexpected PANGAEA ${id} schema`);
  return new Map(
    body
      .filter((line) => line)
      .map((line) => line.split('\t'))
      .filter(use)
      .map(([time, ...row]) => [time, row]),
  );
}

function shift(stamp, byHours) {
  return new Date(Date.parse(`${stamp}Z`) + byHours * 3600000).toISOString().slice(0, 16);
}

function openWeather(data, stamp) {
  const row = data.get(stamp);
  assert.ok(row, `Missing hourly weather at ${stamp}`);
  const [celsius, humidityGrams, wind, rain, snow, longwave, direct, diffuse, hPa] = row.map((value, i) =>
    number(value, `774240 ${stamp} column ${i + 2}`),
  );
  assert.equal(rain + snow, 0, `The ${stamp} dry-weather source was revised`);
  const pressure = hPa * 100;
  const q = humidityGrams / 1000;
  // Invert q = .622 e/(p - .378 e), then use the model's FAO-56 Eq. 11
  // saturation convention so the reported q is what the closure receives.
  // https://www.fao.org/4/X0490E/x0490e07.htm
  const humidity = (q * pressure) / ((0.622 + 0.378 * q) * 610.8 * Math.exp((17.27 * celsius) / (celsius + 237.3)));
  assert.ok(humidity >= 0 && humidity <= 1, `Specific humidity at ${stamp} is outside the solver's RH domain`);
  return { airTemperature: celsius + freezing, humidity, longwave, pressure, shortwave: direct + diffuse, wind };
}

const forcingFields = [
  ['airTemperature', 'temperature', 'K'],
  ['humidity', 'relativeHumidity', '1'],
  ['longwave', 'heatFlux', 'W/m^2'],
  ['pressure', 'pressure', 'Pa'],
  ['shortwave', 'heatFlux', 'W/m^2'],
].map(([key, quantity, unit]) => [key, { name: `cdp:${key}`, kind: 'scalarSeries', quantity, unit, centring: 'cell' }]);

function weatherPublisher(hourly) {
  let host;
  let regions;
  function set(sample) {
    forcingFields.forEach(([key], index) => {
      regionWords(host.memory, regions[index])[0] = sample[key];
    });
  }
  return {
    describe: () => ({
      id: 'cdp-hourly',
      fields: forcingFields.map(([, field]) => ({ field, access: 'write' })),
      rate: 0,
      stableRate: () => 0,
    }),
    init(h) {
      host = h;
      regions = forcingFields.map(([, field]) => host.allocate(field.name, 8, 'f64', 1));
      set(hourly[0]);
    },
    step({ tick }) {
      if (tick % framesPerHour === 0) set(hourly[tick / framesPerHour]);
    },
    exportPorts: (tick) =>
      forcingFields.map(([, field], index) => ({
        field: field.name,
        region: regions[index],
        tick,
        cell: host.cell,
      })),
    importPorts() {},
    stateRegions: () => regions,
    extraState: () => [],
  };
}

function radiometricFourth(temperature, emissivity, downLongwave) {
  return emissivity * temperature ** 4 + ((1 - emissivity) * downLongwave) / stefanBoltzmann;
}

function simulate(hourly, initial) {
  const world = new PhysicsWorld({ rate: { num: framesPerSecond, den: 1 } });
  world.add(weatherPublisher(hourly));
  const inputs = Object.fromEntries(forcingFields.map(([key, field]) => [key, { field }]));
  const solvers = emissivities.map((emissivity, index) => {
    const solver = new SurfaceEnergySolver({ id: `cdp-surface-${index}`, inputs });
    world.add(solver, {
      emissivity,
      albedo: initial.albedo,
      deepTemperature: initial.deepTemperature,
      initialSnow: initial.swe,
      initialTemperature:
        ((initial.radiometricK ** 4 - ((1 - emissivity) * initial.longwave) / stefanBoltzmann) / emissivity) ** 0.25,
    });
    return solver;
  });
  const startK = solvers.map((solver) => solver.read().temperature);
  const steps = [];
  for (const [hour, weather] of hourly.entries()) {
    const power = emissivities.map(
      (emissivity, index) => radiometricFourth(solvers[index].read().temperature, emissivity, weather.longwave) / 2,
    );
    for (let minute = 1; minute <= 60; minute++) {
      world.advance(hour * framesPerHour + minute * 60 * framesPerSecond);
      emissivities.forEach((emissivity, index) => {
        const state = solvers[index].read();
        power[index] += radiometricFourth(state.temperature, emissivity, weather.longwave) / (minute === 60 ? 2 : 1);
      });
    }
    steps.push(
      emissivities.map((emissivity, index) => {
        const state = solvers[index].read();
        return {
          meanRadiometricK: (power[index] / 60) ** 0.25,
          endRadiometricK: radiometricFourth(state.temperature, emissivity, weather.longwave) ** 0.25,
          endPhysicalK: state.temperature,
          endGroundWm2: state.ground,
          endSnowKgM2: state.snow,
        };
      }),
    );
  }
  return { startsPhysicalK: startK, steps };
}

function stats(errors) {
  return {
    biasK: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    rmseK: Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length),
    maxAbsK: Math.max(...errors.map(Math.abs)),
  };
}

const folder = process.argv[2];
assert.ok(folder, 'Pass the folder holding the four cited atmo09-<id>.tsv PANGAEA tables.');
const [weatherTable, irTable, dayTable, soilTable] = await Promise.all([
  load(folder, 774240),
  load(folder, 774238),
  load(folder, 774237),
  load(folder, 774219, (row) => Number(row[1]) === 0.5),
]);
const skinC = (stamp) => number(irTable.get(stamp)?.[1], `774238 skin temperature at ${stamp}`);

const results = initialStarts.map(({ regime, stamp }) => {
  const prevDay = shift(stamp, -24).slice(0, 10);
  const priorSnow = dayTable.get(prevDay);
  const initial = {
    stamp,
    prevDay,
    radiometricK: skinC(stamp) + freezing,
    longwave: openWeather(weatherTable, stamp).longwave,
    swe: number(priorSnow?.[4], `774237 SWE at ${prevDay}`),
    albedo: number(priorSnow?.[10], `774237 albedo at ${prevDay}`),
    deepTemperature: number(soilTable.get(stamp)?.[1], `774219 0.5m soil temperature at ${stamp}`) + freezing,
  };
  assert.ok(initial.swe > 0 && initial.albedo > 0 && initial.albedo <= 1, 'Expected snow and fractional daily albedo');
  const labels = Array.from({ length: hours + 1 }, (_, hour) => shift(stamp, hour));
  const weather = labels.map((label) => ({ stamp: label, ...openWeather(weatherTable, label) }));
  const observations = labels.slice(1).map((label) => ({ stamp: label, radiometricK: skinC(label) + freezing }));
  return {
    regime,
    initial,
    weather,
    observations,
    timing: ['end-labelled', 'start-labelled'].map((convention, offset) => {
      const first = 1 - offset;
      const simulation = simulate(weather.slice(first, first + hours), initial);
      return {
        convention,
        emissivities: emissivities.map((emissivity, index) => {
          const samples = observations.map(({ stamp: at, radiometricK }, hour) => {
            const step = simulation.steps[hour][index];
            return {
              stamp: at,
              observedK: radiometricK,
              outgoing10PercentRangeK: [radiometricK * 0.9 ** 0.25, radiometricK * 1.1 ** 0.25],
              ...step,
              meanErrorK: step.meanRadiometricK - radiometricK,
              endErrorK: step.endRadiometricK - radiometricK,
            };
          });
          return {
            emissivity,
            initialPhysicalK: simulation.startsPhysicalK[index],
            mean: stats(samples.map((sample) => sample.meanErrorK)),
            endpoint: stats(samples.map((sample) => sample.endErrorK)),
            samples,
          };
        }),
      };
    }),
  };
});

const entry = await readFile(new URL('../dist/surface-energy.js', import.meta.url));
const linkedName = /from ["'](\.\/surface-energy-[^"']+\.js)["']/.exec(entry.toString())?.[1];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
console.log(
  JSON.stringify(
    {
      entrySha256: sha256(entry),
      ...(linkedName && { linkedSha256: sha256(await readFile(new URL(`../dist/${linkedName}`, import.meta.url))) }),
      sourceSha256: sourceHashes,
      framesPerHour,
      results,
    },
    null,
    2,
  ),
);
