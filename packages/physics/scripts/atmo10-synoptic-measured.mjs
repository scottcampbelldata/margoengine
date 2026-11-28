// Build Physics, then run from the repository root with the original public 3DEP service:
// node scripts/run-with-timeout.mjs --max=1 -- node packages/physics/scripts/atmo10-synoptic-measured.mjs
// Optionally pass a local copy of the exact GeoTIFF returned by DEM_URL to avoid network access.
//
// OLYMPEX warm sector began at 13:00 UTC on 2015-12-08 (Tierney & Durran 2024 Table 1,
// https://doi.org/10.1175/JAS-D-23-0177.1). Use the first four hours to bound the
// frozen upstream sounding assumption. The gauges and source sounding are
// independent. Neither observed rainfall nor a rain-fitted wind direction enters the solve.
//
// Input: NOAA NCEI IGRA v2.2 Quillayute Airport USM00072797, nominal 2015-12-08 12 UTC,
// released at 11:05 UTC. See records matching '#USM00072797 2015 12 08 12' in
// https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/access/data-por/USM00072797-data.txt.zip
// Ground: USGS The National Map, 3DEP Elevation ImageServer. DEM_URL is a public option
// recorded with its exact response SHA256. No third-party file is packaged.
// Gauge metadata, source files, reporting clocks and derived totals are below.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SynopticWeather } from '../dist/synoptic.js';
import { PhysicsWorld } from '../dist/world.js';

const DEM_URL =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=-125,46.5,-122,48.8&bboxSR=4326&size=90,69&imageSR=4326&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image';
const DEM_BOUNDS = [-125, 46.5, -122, 48.8];
const DEM_SIZE = [90, 69];
const XY_ORIGIN_DEGREES = [-123.9, 47.65];
const GRAVITY = 9.80665;
const DRY_AIR_GAS = 287.05;
const VAPOUR_AIR_RATIO = 0.622;
const DEFAULT_LAPSE = 0.0065;
const DOMAIN_METRES = 1_024_000;
const WORLD_FPS = 60;
const SECONDS_PER_STEP = 300;
const WARMUP_TICKS = 23; // 11:05 to 13:00 UTC.
const TICKS_PER_HOUR = 3600 / SECONDS_PER_STEP;

// Complete thermo/wind rows through 35.91 kPa (~8 km). Original units:
// Pa, geopotential m, tenths °C, tenths percent RH, wind-from degrees, tenths m/s.
const RAW_SOUNDING = [
  [99779, 57, 111, 929, 165, 77],
  [98983, 124, 111, 923, 160, 117],
  [92500, 686, 76, 985, 171, 220],
  [89905, 920, 65, 984, 179, 235],
  [87737, 1121, 72, 982, 195, 289],
  [85000, 1382, 57, 985, 202, 263],
  [82518, 1624, 46, 991, 210, 296],
  [79429, 1936, 51, 974, 229, 335],
  [75174, 2384, 29, 986, 240, 336],
  [74030, 2509, 16, 980, 239, 341],
  [72562, 2670, 7, 830, 242, 336],
  [71539, 2784, 0, 845, 243, 346],
  [70000, 2958, -14, 880, 243, 341],
  [67620, 3233, -30, 897, 241, 391],
  [56570, 4629, -104, 944, 239, 268],
  [51933, 5284, -133, 878, 237, 253],
  [50000, 5572, -153, 874, 247, 249],
  [49139, 5703, -163, 872, 253, 260],
  [44418, 6458, -195, 802, 255, 296],
  [40000, 7228, -250, 740, 254, 331],
  [35910, 8003, -309, 665, 257, 374],
];

// NOAA USCRN WBAN 04237, P_CALC hourly mm ending 14:00..17:00 UTC in the UTC columns:
// https://www.ncei.noaa.gov/pub/data/uscrn/products/hourly02/2015/CRNH0203-2015-WA_Quinault_4_NE.txt
// USDA NRCS SNOTEL 1107 Buckinghorse, water-year PREC in inches, state PST UTC-08:00:
// https://wcc.sc.egov.usda.gov/reportGenerator/view_csv/customSingleStationReport/hourly/1107:WA:SNTL%7Cid=%22%22%7Cname/2015-12-07,2015-12-09/PREC::value
// Derive hourly totals by differences between 05:00 and 09:00 PST. This is liquid water
// equivalent; phase and wind undercatch are not independently measured by the readout.
// Station elevations listed in feet, converted to metres. Positions from NOAA normals
// station metadata (USW00004237) and the USDA NWCC AWDB station service (1107:WA:SNTL).
const BUCKINGHORSE_INCHES = [52.2, 52.4, 52.7, 53.1, 53.6];
const GAUGES = [
  {
    name: 'Quinault 4 NE',
    lon: -123.812,
    lat: 47.5139,
    siteElevation: 286 * 0.3048,
    hourly: [10.6, 7.1, 4.1, 10.8],
    totalReadout: 0.2,
  },
  {
    name: 'Buckinghorse',
    lon: -123.45747,
    lat: 47.7086,
    siteElevation: 4850 * 0.3048,
    hourly: BUCKINGHORSE_INCHES.slice(1).map((value, i) => 25.4 * (value - BUCKINGHORSE_INCHES[i])),
    totalReadout: 2.54,
  },
];

function forcing() {
  const levels = RAW_SOUNDING.map(([pressure, altitude, temperatureTenths, humidityTenths, from, speedTenths]) => {
    const temperature = temperatureTenths / 10;
    // Bolton (1980), Eq. 10, over liquid water. Use the reported RH convention.
    const saturation = 611.2 * Math.exp((17.67 * temperature) / (temperature + 243.5));
    const vapourPressure = (humidityTenths / 1000) * saturation;
    const q = (VAPOUR_AIR_RATIO * vapourPressure) / (pressure - (1 - VAPOUR_AIR_RATIO) * vapourPressure);
    const angle = (from * Math.PI) / 180;
    return {
      pressure,
      altitude,
      temperature,
      q,
      east: (-speedTenths * Math.sin(angle)) / 10,
      north: (-speedTenths * Math.cos(angle)) / 10,
    };
  });
  let vapour = 0;
  let integratedEast = 0;
  let integratedNorth = 0;
  // Hydrostatic trapezoidal integration of q dp/g and q V dp/g. Tierney–Durran
  // Eq. 1 expresses the equivalent height integral. Projection uses east/north.
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1];
    const b = levels[i];
    const halfMass = (a.pressure - b.pressure) / (2 * GRAVITY);
    vapour += halfMass * (a.q + b.q);
    integratedEast += halfMass * (a.q * a.east + b.q * b.east);
    integratedNorth += halfMass * (a.q * a.north + b.q * b.north);
  }
  const surface = levels[0];
  const profileTop = levels.at(-1);
  const endpoint = levels.find(({ altitude }) => altitude === 2384);
  return {
    vapour,
    pressure:
      surface.pressure * Math.exp((GRAVITY * surface.altitude) / (DRY_AIR_GAS * (273.15 + surface.temperature))),
    stationAltitude: surface.altitude,
    stationTemperature: surface.temperature + 273.15,
    measuredLowerLapse: (surface.temperature - endpoint.temperature) / (endpoint.altitude - surface.altitude),
    wind: [integratedEast / vapour, integratedNorth / vapour],
    truncatedColumnIVT: [integratedEast, integratedNorth],
    conditionalUnsampledVapourMax: (profileTop.q * profileTop.pressure) / GRAVITY,
  };
}

async function fetchElevation(path) {
  if (path) return readFile(path);
  const response = await fetch(DEM_URL, { signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `3DEP returned status ${response.status}. Pass the saved original GeoTIFF as the argument.`);
  return Buffer.from(await response.arrayBuffer());
}

function terrain(tiff) {
  // Read the single uncompressed 128 x 128 tile returned by this exact 3DEP request.
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const get16 = (at) => view.getUint16(at, true);
  const get32 = (at) => view.getUint32(at, true);
  assert.equal(get32(0), 0x002a4949, 'Expected the requested little-endian GeoTIFF.');
  const directory = get32(4);
  const tags = new Map();
  for (let i = 0; i < get16(directory); i++) {
    const at = directory + 2 + 12 * i;
    tags.set(get16(at), at);
  }
  const required = (tag) => {
    const at = tags.get(tag);
    assert.equal(get32(at + 4), 1);
    return get16(at + 2) === 3 ? get16(at + 8) : get32(at + 8);
  };
  const doubles = (tag, count) => {
    const at = tags.get(tag);
    assert.equal(get16(at + 2), 12);
    assert.equal(get32(at + 4), count);
    const start = get32(at + 8);
    return Array.from({ length: count }, (_, i) => view.getFloat64(start + 8 * i, true));
  };
  const [columns, rows] = DEM_SIZE;
  const [west, south, east, north] = DEM_BOUNDS;
  assert.deepEqual(doubles(33922, 6), [0, 0, 0, west, north, 0]);
  const [lonStep, latStep] = doubles(33550, 3);
  assert.ok(Math.abs(lonStep * columns - (east - west)) < 1e-9 && Math.abs(latStep * rows - (north - south)) < 1e-9);
  assert.deepEqual(
    [required(256), required(257), required(258), required(259), required(339)],
    [columns, rows, 32, 1, 3],
  );
  const stride = required(322);
  const bytes = required(325);
  const offset = required(324);
  assert.ok(stride >= columns && required(323) >= rows && bytes >= 4 * stride * rows && offset + bytes <= tiff.length);
  const tile = new Float64Array(columns * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const h = view.getFloat32(offset + 4 * (x + stride * y), true);
      assert.ok(Number.isFinite(h) && h >= -10 && h < 3000);
      tile[x + columns * y] = Math.max(0, h);
    }
  }
  return tile;
}

const scaleNorth = (6_371_000 * Math.PI) / 180;
const scaleEast = scaleNorth * Math.cos((XY_ORIGIN_DEGREES[1] * Math.PI) / 180);
const project = (lon, lat) => [(lon - XY_ORIGIN_DEGREES[0]) * scaleEast, (lat - XY_ORIGIN_DEGREES[1]) * scaleNorth];

function sampledBed(dem) {
  const [west, south, east, north] = DEM_BOUNDS;
  const [columns, rows] = DEM_SIZE;
  const lonStep = (east - west) / columns;
  const latStep = (north - south) / rows;
  const at = (column, row) => dem[column + columns * row];
  return {
    cell: [0, 0, 0],
    sample(x, z) {
      const lon = XY_ORIGIN_DEGREES[0] + x / scaleEast;
      const lat = XY_ORIGIN_DEGREES[1] + z / scaleNorth;
      const i = (lon - west) / lonStep - 0.5;
      const j = (north - lat) / latStep - 0.5;
      let elevation = 0;
      if (i >= 0 && i < columns - 1 && j >= 0 && j < rows - 1) {
        const left = Math.floor(i);
        const top = Math.floor(j);
        const u = i - left;
        const v = j - top;
        // Taper ~15 km at the source edges before the surrounding level buffer.
        const edge = Math.min(1, i / 5, (columns - 1 - i) / 5, j / 5, (rows - 1 - j) / 5);
        const one = (1 - u) * at(left, top) + u * at(left + 1, top);
        const two = (1 - u) * at(left, top + 1) + u * at(left + 1, top + 1);
        elevation = edge * edge * (3 - 2 * edge) * ((1 - v) * one + v * two);
      }
      return { elevation, normal: [0, 1, 0] }; // SynopticWeather uses elevation for its own derivatives.
    },
  };
}

async function run(atmosphere, bed, resolution, lapse) {
  const synoptic = await SynopticWeather.load();
  const spacing = DOMAIN_METRES / resolution;
  const stations = GAUGES.map(({ lon, lat }) => project(lon, lat));
  const hourly = stations.map(() => [0, 0, 0, 0]);
  const world = new PhysicsWorld({ rate: { num: WORLD_FPS, den: 1 } }).add(synoptic, {
    cells: [resolution, resolution],
    spacing: [spacing, spacing],
    origin: [-DOMAIN_METRES / 2, -DOMAIN_METRES / 2],
    latitude: (XY_ORIGIN_DEGREES[1] * Math.PI) / 180,
    timeScale: SECONDS_PER_STEP * WORLD_FPS,
    streamfunction: 0,
    meanWind: atmosphere.wind,
    temperature: atmosphere.stationTemperature + lapse * atmosphere.stationAltitude,
    pressure: atmosphere.pressure,
    density: atmosphere.pressure / (DRY_AIR_GAS * atmosphere.stationTemperature),
    vapour: atmosphere.vapour,
    lapseRate: lapse,
    bed,
  });
  world.advance(WARMUP_TICKS);
  for (let tick = 1; tick <= 4 * TICKS_PER_HOUR; tick++) {
    world.advance(WARMUP_TICKS + tick);
    for (const [i, [x, z]] of stations.entries()) {
      // Column precipitation mass per area converts numerically to liquid mm at 1000 kg/m³.
      hourly[i][Math.floor((tick - 1) / TICKS_PER_HOUR)] += synoptic.sample(x, z).precipitation * SECONDS_PER_STEP;
    }
  }
  const budget = synoptic.budget;
  return {
    hourly,
    waterResidualKg: budget.initial + budget.evaporation - budget.airborne - budget.precipitation,
  };
}

const tiff = await fetchElevation(process.argv[2]);
const dem = terrain(tiff);
const bed = sampledBed(dem);
const atmosphere = forcing();
assert.ok(Math.max(...atmosphere.wind.map(Math.abs)) * (WARMUP_TICKS * SECONDS_PER_STEP + 4 * 3600) < DOMAIN_METRES);
const coarse = await run(atmosphere, bed, 128, DEFAULT_LAPSE);
const fine = await run(atmosphere, bed, 256, DEFAULT_LAPSE);
const measuredLapse = await run(atmosphere, bed, 128, atmosphere.measuredLowerLapse);
const digest = createHash('sha256').update(tiff).digest('hex');
console.log(
  JSON.stringify({
    period: '2015-12-08T13:00Z/2015-12-08T17:00Z',
    terrainSha256: digest,
    upstream: atmosphere,
    waterResidualKg: [coarse.waterResidualKg, fine.waterResidualKg, measuredLapse.waterResidualKg],
  }),
);
const sum = (values) => values.reduce((a, b) => a + b, 0);
for (const [row, gauge] of GAUGES.entries()) {
  const measured = sum(gauge.hourly);
  const observed = sum(fine.hourly[row]);
  console.log(
    JSON.stringify({
      station: gauge.name,
      officialGaugeElevationMetres: gauge.siteElevation,
      gaugeElevationInSampledTerrainMetres: bed.sample(...project(gauge.lon, gauge.lat)).elevation,
      hourlyMeasuredMillimetres: gauge.hourly,
      hourlyModel4kmMillimetres: fine.hourly[row],
      measuredFourHourMillimetres: measured,
      measuredQuantizationOnlyMillimetres: gauge.totalReadout,
      modeledFourHourMillimetres: observed,
      modelMinusGaugeMillimetres: observed - measured,
      finerGridDeltaMillimetres: observed - sum(coarse.hourly[row]),
      measuredLapseDeltaAt8kmMillimetres: sum(measuredLapse.hourly[row]) - sum(coarse.hourly[row]),
    }),
  );
}
