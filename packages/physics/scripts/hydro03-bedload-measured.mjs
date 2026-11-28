// HYDRO-03. Run after building Physics:
// node packages/physics/scripts/hydro03-bedload-measured.mjs
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TerrainBed } from '../dist/earth.js';
import { SURFACE_WATER_FIELD } from '../dist/hydro.js';
import { SedimentTransport } from '../dist/sediment.js';
import { PhysicsWorld, regionWords } from '../dist/world.js';

const measurement = {
  authors: 'Hasan Eslami and Alessio Radice',
  article: 'https://doi.org/10.5194/esurf-13-437-2025',
  source: 'https://doi.org/10.5281/zenodo.14883164',
  workbook: 'https://zenodo.org/records/14883164/files/Key_Parameters.xlsx',
  sha256: '526ed8e345f75e20f67f6fcfb1c93ad33d68e0b59eebc9d9a72c970c2a27a1e3',
  licence: 'https://creativecommons.org/licenses/by/4.0/',
  selection: 'First workbook row for every distinct nominal initial slope and water discharge.',
};
// Transcribe column F (decimal slope in the workbook despite its percent cell
// format), G (water discharge, m³/s) and I (initial solid capacity, m³/s).
// The capacity is measured in the collector and cross-checked by solid-volume
// balance (article §4.1). The reported roughness comes from separate preliminary experiments.
const flumeCases = [
  ['AE1', 9, 0.0137, 0.003, 6.24518744643116e-5],
  ['AE3', 11, 0.0137, 0.004, 8.047491620983123e-5],
  ['AE6', 14, 0.0137, 0.005, 9.593424113749155e-5],
  ['AE10', 18, 0.0137, 0.006, 0.00011974514059376791],
  ['AE14', 22, 0.0137, 0.007, 0.0001328157571666101],
  ['AE17', 25, 0.0137, 0.008, 0.00016006051396154735],
  ['AE21', 29, 0.0137, 0.009, 0.00018662297556695808],
  ['AE23', 31, 0.022, 0.004, 0.0001432027323521129],
  ['AE24', 32, 0.022, 0.005, 0.00018264456819096792],
  ['AE25', 33, 0.022, 0.006, 0.00021313850313753153],
  ['AE26', 34, 0.022, 0.007, 0.00025050810848632586],
];
const aggradation = {
  runId: 'AE16',
  source: 'https://doi.org/10.5281/zenodo.10641001',
  workbook: 'Supplemental _raw data of experiment.xlsx',
  sha256: '231af35ea81c43097edd3a7dc3c9087a1db233249892dfea7d7ac7149c694713',
  attribution:
    'Hasan Eslami, Erfan Poursoleymanzadeh, Mojtaba Hiteh, Keivan Tavakoli, Melika Yavari Nia, Ehsan Zadehali, Reihaneh Zarrabi and Alessio Radice',
  licence: 'https://creativecommons.org/licenses/by/4.0/',
  scope:
    'Observed bed levels only. The native solver has no inflowing sediment boundary, so a measured-feed morphology replay is unavailable. Workbook values in cm from Raw data_Bed, time rows 6 and 196. The paper reports a 2 mm RMS difference between camera and ruler bed readings, with no formal uncertainty on these elevation increments.',
  bedRise: [
    [119, 150.0108158220025, -0.731770051786982, 4.96578658943432],
    [1188, 250.039616810878, -0.486025291423279, 3.22286796303084],
    [2256, 349.97484548825696, -0.302324709228263, 1.98752992037566],
    [3325, 450.003646477132, -0.241162252612431, 0.576761399233313],
  ].map(([workbookColumn, xCm, bedAt0Cm, bedAt190Cm]) => ({
    workbookColumn,
    xM: xCm / 100,
    observedElevationIncreaseM: (bedAt190Cm - bedAt0Cm) / 100,
  })),
};
const width = 0.3;
const initialBedThickness = 0.15;
const grainDiameter = 0.0038;
const grainDensity = 1443;
const porosity = 0.45;
const roughness = 0.015;
const gravity = 9.80665;
const grid = { columns: 1, rows: 1, width: 5.2, depth: width, centre: [0, 0] };

function heldWater(depth, discharge) {
  let port;
  return {
    describe: () => ({
      id: 'held-flume-water',
      fields: [{ field: SURFACE_WATER_FIELD, access: 'write' }],
      rate: 0,
      stableRate: () => 0,
    }),
    init(host) {
      const region = host.allocate('flume-water', 3 * Float32Array.BYTES_PER_ELEMENT, 'f32', 1);
      regionWords(host.memory, region).set([depth, discharge, 0]);
      port = { field: SURFACE_WATER_FIELD.name, region, cell: [0, 0, 0] };
    },
    step() {},
    importPorts() {},
    exportPorts: (tick) => [{ ...port, tick }],
    stateRegions: () => [port.region],
    extraState: () => [],
  };
}

async function run([runId, workbookRow, slope, waterDischargeM3S, measuredSolidCapacityM3S]) {
  const discharge = waterDischargeM3S / width;
  // Rectangular Gauckler–Strickler normal flow (article Table 1).
  // This gives 0.03312 m and 0.70452 m/s at the AE16 water discharge.
  let low = 0;
  let high = 0.45; // Bank height in §4.1, above the normal depth in every run.
  for (let i = 0; i < 54; ++i) {
    const depth = (low + high) / 2;
    const radius = (width * depth) / (width + 2 * depth);
    const uniformSpecificDischarge = (depth * radius ** (2 / 3) * Math.sqrt(slope)) / roughness;
    if (uniformSpecificDischarge < discharge) low = depth;
    else high = depth;
  }
  const depth = (low + high) / 2;
  const solver = await SedimentTransport.load();
  const bed = new TerrainBed();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -gravity, 0] })
    .add(bed, {
      ...grid,
      elevations: (x) => -slope * x,
      bedrock: (x) => -slope * x - initialBedThickness,
    })
    .add(heldWater(depth, discharge), {})
    .add(solver, { grid, grainDiameter, grainDensity, porosity, roughness, mobileDepth: initialBedThickness });
  world.advance(1);
  const sample = solver.read(0, 0);
  const modeledSolidCapacityM3S = width * sample.bedload;
  return {
    runId,
    workbookRow,
    slope,
    waterDischargeM3S,
    referenceDepthM: depth,
    referenceFroude: discharge / (depth * Math.sqrt(gravity * depth)),
    computedBedShearPa: sample.shearStress,
    measuredSolidCapacityM3S,
    modeledSolidCapacityM3S,
    ratio: modeledSolidCapacityM3S / measuredSolidCapacityM3S,
  };
}

const asset = await readFile(new URL('../dist/sediment-kernel.wasm', import.meta.url));
const results = [];
for (const labRun of flumeCases) results.push(await run(labRun));
console.log(
  JSON.stringify(
    {
      measurement,
      aggradation,
      wasmSha256: createHash('sha256').update(asset).digest('hex'),
      inputs: { width, initialBedThickness, grainDiameter, grainDensity, porosity, roughness, gravity },
      scope:
        'Initial bedload capacity only. The actual SedimentTransport kernel reads a held rectangular-channel normal flow derived from nominal slope, reported discharge and Manning n from separate preliminary tests. The measured solid rates are held out. The solver uses depth-based shear and has no separate sidewall shear. These runs use one material and supercritical flow at two slopes. The workbook reports no per-capacity uncertainty.',
      results,
    },
    null,
    2,
  ),
);
