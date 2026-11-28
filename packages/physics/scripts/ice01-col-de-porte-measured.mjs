// Morin, Lejeune, Lesaffre, Panel, Poncet, David and Sudul (2012), Col de Porte snow and meteorological
// dataset, https://doi.org/10.5194/essd-4-13-2012 and https://doi.org/10.1594/PANGAEA.774249.
// External CC BY 3.0 PANGAEA tables 774240 (weather), 774237 (daily SWE/albedo) and 774238 (hourly depths).
// https://creativecommons.org/licenses/by/3.0/
// The optional argument is the local data cache directory. All three tables are pinned and fetched as needed.
// Run: node scripts/run-with-timeout.mjs --max=2 -- node packages/physics/scripts/ice01-col-de-porte-measured.mjs
//
// Morin §2.2.4 uses depth/albedo to help partition precip phase. Both forecast windows are precipitation-free,
// chosen by duration and weather. No stored snow depth or SWE after forecast start drives a model input.
// A single initial depth anchor uses the start-noon scanner. Prior-day cosmic-ray SWE and albedo are already
// available before the forecast. An unresolved initial profile uses uniform density, four layers, no liquid
// and conditional initial temperature from the preceding 24-hour mean air temperature, capped at freezing.
// Basal heat and vapor mass/latent heat are left zero, so this is a limited compaction/ablation comparison.
// Morin §§2.3.1–2.3.2 give about 1 cm scanner accuracy and about 10% cosmic-ray SWE uncertainty.
// The later site-scale survey estimates RMS variability of 0.10 m depth and 25 kg/m² SWE
// (Lejeune et al. 2019, https://doi.org/10.5194/essd-11-71-2019). These characterize station variability.
// Cosmic-ray SWE integrates 24 h; this comparison assumes the preceding 24 h ending at 12 UTC.
// Instantaneous model SWE is also reported because the table does not state the exact integration anchor.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Snowpack } from '../dist/snowpack.js';
import { PhysicsWorld, regionWords, worldMemory } from '../dist/world.js';

const freeze = 273.15;
const framesPerSecond = 60;
const hours = 6 * 24;
const hourMs = 3_600_000;
const stefanBoltzmann = 5.670374419e-8;
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const windows = [
  { regime: 'cold dry column', start: '2011-01-19T12:00' },
  { regime: 'warm dry ablation', start: '2009-04-08T12:00' },
];
const forcingHash = '6623eab36ef9e7abb104dd67100d83cdc8504fdde327da043417ecb7d4da5259';
const dailyHash = '254ba50cc5a255e9b4e43de4adfccc55f32d5ada728f11983d30039ce29e7e2a';
const depthHash = 'a81f7ea9bec08cdcea33a3c6bcf38d5fbc311368a27997a873a9a4f116b3ff31';

async function load(folder, id, hash) {
  // Reuse the verbatim source tables from the earlier ATMO-09 study when they are already cached.
  const path = join(folder, `atmo09-${id}.tsv`);
  let bytes;
  let downloaded = false;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://doi.pangaea.de/10.1594/PANGAEA.${id}?format=textfile`, {
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `PANGAEA ${id} HTTP ${response.status}; download from its DOI page.`);
    bytes = Buffer.from(await response.arrayBuffer());
    downloaded = true;
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `PANGAEA ${id} version`);
  if (downloaded) await writeFile(path, bytes);
  const text = bytes.toString('utf8');
  const metadataEnd = text.indexOf('*/');
  assert.ok(metadataEnd >= 0, `Missing PANGAEA ${id} metadata.`);
  const [header, ...rows] = text
    .slice(metadataEnd + 2)
    .trim()
    .split(/\r?\n/);
  assert.ok(header.startsWith('Date/Time\t'), `Unexpected PANGAEA ${id} header.`);
  return new Map(
    rows.map((line) => {
      const [date, ...values] = line.split('\t');
      return [date, values];
    }),
  );
}

function weatherOf(row) {
  assert.ok(row?.length === 9 && row.every((value) => value.trim() && Number.isFinite(Number(value))));
  const [airC, , wind, rain, snowfall, longwave, direct, diffuse, hPa] = row.map(Number);
  assert.equal(rain + snowfall, 0, 'The prespecified dry forecast window contains precipitation.');
  const kelvin = airC + freeze;
  return { kelvin, wind, longwave, shortwave: direct + diffuse, density: (100 * hPa) / (287.05 * kelvin) };
}

const field = { name: 'cdp-surface-heat', kind: 'scalarSeries', quantity: 'heatFlux', unit: 'W/m^2', centring: 'cell' };
function heatForcing(pack, forcing, albedo, framesPerHour) {
  let host;
  let region;
  return {
    describe: () => ({ id: 'cdp-energy', fields: [{ field, access: 'write' }], rate: 0, stableRate: () => 0 }),
    init(solverHost) {
      host = solverHost;
      region = host.allocate(field.name, 8, 'f64', 1);
    },
    importPorts() {},
    step({ tick }) {
      const snow = pack.read(0, 0);
      const w = forcing[Math.floor(tick / framesPerHour)];
      // Vionnet et al. (2012) §3.7, https://doi.org/10.5194/gmd-5-773-2012, neutral limit. The
      // reference roughness lengths are 1 mm for momentum and 0.1 mm for heat (Lafaysse et al. 2017,
      // https://doi.org/10.5194/tc-11-1173-2017). Use the fixed 10 m mast minus solved snow depth.
      const z = 10 - snow.depth;
      const ch = 0.4 ** 2 / (Math.log(z / 0.001) * Math.log(1.5 / 0.0001));
      const temperature = Math.min(snow.temperature, freeze);
      const sensible = w.density * 1005 * ch * w.wind * (w.kelvin - temperature);
      const radiation = (1 - albedo) * w.shortwave + 0.97 * (w.longwave - stefanBoltzmann * temperature ** 4);
      regionWords(host.memory, region)[0] = sensible + radiation;
    },
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: host.cell }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

async function simulate(weather, initial, stepSeconds, observed) {
  const framesPerHour = 3600 / stepSeconds;
  const world = new PhysicsWorld({ rate: { num: framesPerSecond, den: 1 }, memory: worldMemory(false) });
  const pack = await Snowpack.load({ inputs: { topHeat: { field } } });
  world.add(heatForcing(pack, weather, initial.albedo, framesPerHour));
  world.add(pack, {
    width: 1,
    depth: 1,
    secondsPerSecond: stepSeconds * framesPerSecond,
    layers: [0.08, 0.17, 0.25, 0.5].map((fraction) => ({
      mass: initial.swe * fraction,
      density: initial.swe / initial.depth,
      temperature: initial.temperature,
    })),
  });
  let runoff = 0;
  let previous = pack.read(0, 0);
  let meanSwe = 0;
  const differences = [];
  for (let frame = 1; frame <= hours * framesPerHour; frame++) {
    world.advance(frame);
    const state = pack.read(0, 0);
    runoff += (1000 * state.runoff) / framesPerSecond;
    meanSwe += (previous.mass + state.mass) / (2 * 24 * framesPerHour);
    previous = state;
    if (frame % (24 * framesPerHour) !== 0) continue;
    const { date, depthM, swe } = observed[differences.length];
    differences.push({
      date,
      predictedDepthM: state.depth,
      measuredDepthM: depthM,
      predictedSweDayMean: meanSwe,
      predictedSweInstant: state.mass,
      measuredSwe: swe,
      depthBiasM: state.depth - depthM,
      sweBiasKgM2: meanSwe - swe,
    });
    meanSwe = 0;
  }
  const massResidual = previous.mass + runoff - initial.swe;
  assert.ok(Math.abs(massResidual) < 1e-8, `Precipitation-free column mass residual ${massResidual} kg/m².`);
  const rms = (fieldName) => Math.sqrt(mean(differences.map((row) => row[fieldName] ** 2)));
  return {
    stepSeconds,
    runoff,
    massResidual,
    depthRmsM: rms('depthBiasM'),
    sweRmsKgM2: rms('sweBiasKgM2'),
    differences,
  };
}

function value(row, index) {
  assert.ok(
    row?.[index]?.trim() && Number.isFinite(Number(row[index])),
    `Missing source value in column ${index + 2}.`,
  );
  return Number(row[index]);
}

function differencesBetween(a, b) {
  const maxChange = (key) => Math.max(...a.map((row, i) => Math.abs(row[key] - b[i][key])));
  return { maxDepthM: maxChange('predictedDepthM'), maxSweKgM2: maxChange('predictedSweDayMean') };
}

const folder = process.argv[2] ?? join(tmpdir(), 'codex-atmo09-col-de-porte');
await mkdir(folder, { recursive: true });
const [meteorology, daily, depths] = await Promise.all([
  load(folder, 774240, forcingHash),
  load(folder, 774237, dailyHash),
  load(folder, 774238, depthHash),
]);
for (const { regime, start } of windows) {
  const startMs = Date.parse(`${start}Z`);
  const stamp = (hoursSinceStart) => new Date(startMs + hourMs * hoursSinceStart).toISOString().slice(0, 16);
  const day = (hoursSinceStart) => stamp(hoursSinceStart).slice(0, 10);
  const previousDay = daily.get(day(-24));
  const initial = {
    depth: value(depths.get(start), 0),
    swe: value(previousDay, 4),
    albedo: value(previousDay, 10),
    temperature: Math.min(
      freeze,
      freeze + mean(Array.from({ length: 24 }, (_, i) => value(meteorology.get(stamp(i - 24)), 0))),
    ),
  };
  assert.ok(initial.depth > 0 && initial.swe > 0 && initial.albedo > 0 && initial.albedo < 1);
  const observed = Array.from({ length: hours / 24 }, (_, i) => {
    const at = 24 * (i + 1);
    return { date: day(at), depthM: value(depths.get(stamp(at)), 0), swe: value(daily.get(day(at)), 4) };
  });
  // UTC follows Lejeune et al. (2019), §2. Integrated forcing uses the end label as in the ESM-SnowMIP
  // reference-site conventions, https://www.geos.ed.ac.uk/~ressery/ESM-SnowMIP/ESMSnowMIP_Reference_sites.pdf §2.
  // Repeat with left labels because the original table does not define each hourly integration alignment.
  const endLabel = Array.from({ length: hours }, (_, h) => weatherOf(meteorology.get(stamp(h + 1))));
  const leftLabel = Array.from({ length: hours }, (_, h) => weatherOf(meteorology.get(stamp(h))));
  const coarse = await simulate(endLabel, initial, 300, observed);
  const fine = await simulate(endLabel, initial, 150, observed);
  const left = await simulate(leftLabel, initial, 150, observed);
  console.log(
    JSON.stringify({
      regime,
      start,
      initial,
      forcingAirMeanC: mean(endLabel.map((w) => w.kelvin)) - freeze,
      stepRefinement: differencesBetween(coarse.differences, fine.differences),
      labelSensitivity: differencesBetween(left.differences, fine.differences),
      coarse,
      fine,
      left,
    }),
  );
}
