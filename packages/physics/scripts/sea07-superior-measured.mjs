// Lake Superior storm, 9–11 November 1975. The scored water levels are NOAA CO-OPS
// verified hourly_height in metres above Lake Superior LWD, with GMT timestamps.
// https://api.tidesandcurrents.noaa.gov/api/dev/
// Atmospheric forcing is hourly ERA5 10 m wind and mean sea-level pressure,
// Copernicus Climate Change Service (ECMWF), CC BY 4.0, retrieved via Open-Meteo
// without elevation downscaling. https://doi.org/10.24381/cds.adbb2d47
// https://open-meteo.com/en/docs/historical-weather-api
// Geometry is NOAA NCEI Lake Superior 3-arcsecond bathymetry, Lake Superior LWD,
// a draft public-domain survey grid. https://www.ncei.noaa.gov/products/great-lakes-bathymetry
// No predictions or scored water levels enter the model. Downloaded inputs are cached outside the repo.
// Run: node scripts/run-with-timeout.mjs --max=5 -- node packages/physics/scripts/sea07-superior-measured.mjs

import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { bedSurface } from '../dist/earth.js';
import { ShallowWaterSolver } from '../dist/hydro.js';
import { SurgeSolver } from '../dist/surge.js';
import { PhysicsWorld } from '../dist/world.js';

const cache = join(tmpdir(), 'margo-sea07-superior');
const start = Date.UTC(1975, 10, 8);
const hourMs = 3_600_000;
const hours = 120;
const stamp = (hour) => new Date(start + hour * hourMs).toISOString().slice(0, 16);
const bathymetryHash = '8b98a754d657965ed5fcb0d68b794bb0b8870d6d3609d57500e64b8fe0a65eed';
const observationIds = [9099064, 9099044, 9099004];
const datumId = 9099090; // Grand Marais (MN), pre-event day only, also excluded from the downstream score.
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function cached(name, url) {
  const path = join(cache, name);
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok)
    throw new Error(`${response.status} retrieving ${url}; check the source response or supply a verified cache.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path, bytes);
  return bytes;
}

async function gauge(id) {
  const url = new URL('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter');
  url.search = new URLSearchParams({
    station: String(id),
    begin_date: '19751108',
    end_date: '19751112',
    product: 'hourly_height',
    datum: 'LWD',
    units: 'metric',
    time_zone: 'gmt',
    format: 'json',
    application: 'margoengine-sea07-validation',
  });
  const { metadata, data } = JSON.parse(await cached(`coops-${id}-19751108-12.json`, url));
  if (metadata?.id !== String(id) || data?.length !== hours)
    throw new Error(`Expected ${hours} verified NOAA records from station ${id}; check the cached response.`);
  const samples = data.map(({ t, v, f }, hour) => {
    if (t.replace(' ', 'T') !== stamp(hour))
      throw new Error(`Unexpected NOAA timestamp ${t} at station ${id}; check the cached response.`);
    if (!v && f === '1,1') return null; // The verified NOAA series marks these hours as missing.
    if (!v || !Number.isFinite(+v) || f !== '0,0')
      throw new Error(`Invalid NOAA observation at station ${id}, ${stamp(hour)}; check the source and its flags.`);
    return +v;
  });
  return { id, name: metadata.name, lat: +metadata.lat, lon: +metadata.lon, samples };
}

const sourceLats = Array.from({ length: 8 }, (_, i) => 46 + i / 2);
const sourceLons = Array.from({ length: 19 }, (_, i) => -92.5 + i / 2);
async function meteorology() {
  const fetchRow = async (lat) => {
    const url = new URL('https://archive-api.open-meteo.com/v1/archive');
    url.search = new URLSearchParams({
      latitude: sourceLons.map(() => lat).join(','),
      longitude: sourceLons.join(','),
      elevation: sourceLons.map(() => 'nan').join(','),
      start_date: '1975-11-08',
      end_date: '1975-11-12',
      hourly: 'pressure_msl,wind_speed_10m,wind_direction_10m',
      wind_speed_unit: 'ms',
      models: 'era5',
      cell_selection: 'nearest',
      timezone: 'GMT',
    });
    const row = JSON.parse(await cached(`era5-19751108-12-lat${lat}.json`, url));
    return sourceLons.map((lon, i) => {
      const series = row[i];
      if (
        series?.latitude !== lat ||
        series.longitude !== lon ||
        series.utc_offset_seconds !== 0 ||
        series.hourly_units?.pressure_msl !== 'hPa' ||
        series.hourly_units?.wind_speed_10m !== 'm/s' ||
        series.hourly?.time.length !== hours
      )
        throw new Error(
          `Unexpected ERA5 coordinates, units or record count at (${lat}, ${lon}); inspect the request and cache.`,
        );
      const { time, pressure_msl: pressure, wind_speed_10m: speed, wind_direction_10m: direction } = series.hourly;
      return time.map((timeStamp, j) => {
        if (timeStamp !== stamp(j) || ![pressure[j], speed[j], direction[j]].every(Number.isFinite))
          throw new Error(`Missing ERA5 observation at (${lat}, ${lon}), ${stamp(j)}; inspect the request and cache.`);
        const from = (direction[j] * Math.PI) / 180;
        return [100 * pressure[j], -speed[j] * Math.sin(from), speed[j] * Math.cos(from)]; // Pa, +east, +south
      });
    });
  };
  const grid = [];
  for (const lat of sourceLats) grid.push(await fetchRow(lat));
  return grid;
}

async function bathymetry() {
  const compressed = await cached(
    'superior_lld.grd.gz',
    'https://www.ngdc.noaa.gov/mgg/greatlakes/superior/data/netcdf/superior_lld.grd.gz',
  );
  if (sha(compressed) !== bathymetryHash)
    throw new Error('The NCEI Lake Superior grid hash changed; verify its new datum and layout before using it.');
  // Verified NetCDF classic header: z is the final 4201×9841 big-endian f32 array.
  const data = gunzipSync(compressed);
  const columns = 9841;
  const rows = 4201;
  const offset = data.length - 4 * columns * rows;
  return (lat, lon) => {
    const x = Math.round(1200 * (lon + 92.2));
    const z = Math.round(1200 * (lat - 46));
    if (x < 0 || x >= columns || z < 0 || z >= rows) return 100; // Outside NOAA's domain, dry margin.
    const value = data.readFloatBE(offset + 4 * (x + z * columns));
    return Number.isFinite(value) ? value : 100;
  };
}

const metresPerDegree = (6371008.8 * Math.PI) / 180;
const referenceLat = 47.75;
const referenceRad = (referenceLat * Math.PI) / 180;
const metresPerLon = metresPerDegree * Math.cos(referenceRad);
const north = 49.75;
const west = -92.5;
const width = 640_000;
const length = 448_000;

function weatherField(source, columns, rows, dx) {
  const cellCount = columns * rows;
  const samples = new Float64Array(hours * cellCount * 3);
  const interval = (degrees, minimum, count) => {
    const coordinate = Math.min(count - 1, Math.max(0, 2 * (degrees - minimum)));
    const index = Math.min(Math.floor(coordinate), count - 2);
    return [index, coordinate - index];
  };
  for (let j = 0; j < rows; j++) {
    const [lat, v] = interval(north - ((j + 0.5) * dx) / metresPerDegree, sourceLats[0], sourceLats.length);
    for (let i = 0; i < columns; i++) {
      const [lon, u] = interval(west + ((i + 0.5) * dx) / metresPerLon, sourceLons[0], sourceLons.length);
      const corners = [source[lat][lon], source[lat][lon + 1], source[lat + 1][lon], source[lat + 1][lon + 1]];
      const weight = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
      for (let h = 0; h < hours; h++) {
        const offset = 3 * (h * cellCount + j * columns + i);
        for (let component = 0; component < 3; component++)
          samples[offset + component] = corners.reduce((sum, series, k) => sum + weight[k] * series[h][component], 0);
      }
    }
  }
  return (x, z, elapsedSeconds, component) => {
    const h = Math.min(hours - 2, Math.max(0, Math.floor(elapsedSeconds / 3600)));
    const fraction = Math.min(1, Math.max(0, elapsedSeconds / 3600 - h));
    const offset = 3 * (h * cellCount + Math.floor(z / dx) * columns + Math.floor(x / dx)) + component;
    return samples[offset] + fraction * (samples[offset + 3 * cellCount] - samples[offset]);
  };
}

// Interpolating a continental DEM onto a coarse water grid can leave isolated
// coastal wet cells. Only cells connected to the central basin can represent a lake gauge.
function connectedLake(water, centre, columns, rows, dx) {
  const seedX = Math.floor(((-88 - west) * metresPerLon) / dx);
  const seedZ = Math.floor(((north - 47.65) * metresPerDegree) / dx);
  const seed = seedX + columns * seedZ;
  const wet = Float64Array.from({ length: columns * rows }, (_, i) => {
    const [x, z] = centre(i % columns, Math.floor(i / columns));
    return water.sample(x, z).depth;
  });
  const minDepth = 0.02;
  if (!(wet[seed] > minDepth)) throw new Error('The central Lake Superior cell is dry; check the bathymetry datum.');
  const todo = [seed];
  const lake = new Set(todo);
  for (let at = 0; at < todo.length; at++) {
    const i = todo[at];
    const x = i % columns;
    const neighbours = [x > 0 ? i - 1 : -1, x + 1 < columns ? i + 1 : -1, i - columns, i + columns];
    for (const j of neighbours) {
      if (wet[j] > minDepth && !lake.has(j)) {
        lake.add(j);
        todo.push(j);
      }
    }
  }
  return lake;
}

function simulate(topography, source, observed, level, dx, physicalStep) {
  const columns = width / dx;
  const rows = length / dx;
  const grid = { columns, rows, width, depth: length, centre: [width / 2, length / 2] };
  const centre = (i, j) => [(i + 0.5) * dx, (j + 0.5) * dx];
  const elevations = new Float64Array((columns + 1) * (rows + 1));
  for (let i = 0; i <= columns; i++)
    for (let j = 0; j <= rows; j++)
      elevations[i * (rows + 1) + j] = topography(north - (j * dx) / metresPerDegree, west + (i * dx) / metresPerLon);
  const bed = bedSurface(grid, elevations);
  const localWeather = weatherField(source, columns, rows, dx);
  const timeScale = physicalStep * 60;
  const water = new ShallowWaterSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(water, {
      bed,
      level,
      timeScale,
      coriolis: { latitude: referenceRad },
      wind: {
        medium: 'air',
        cell: [0, 0, 0],
        timeScale,
        sample(x, _height, z, time, out) {
          const elapsed = time * timeScale;
          out.velocity[0] = localWeather(x, z, elapsed, 1);
          out.velocity[1] = 0;
          out.velocity[2] = localWeather(x, z, elapsed, 2);
          out.density = 1.225;
          out.temperature = 283;
          return out;
        },
      },
    })
    .add(new SurgeSolver(), { water, pressure: (x, z, t) => localWeather(x, z, t, 0) })
    .couple(['surge', 'water'], 'staggered');

  const lake = connectedLake(water, centre, columns, rows, dx);
  const stations = observed.map(({ lat, lon }) => {
    const target = [(lon - west) * metresPerLon, (north - lat) * metresPerDegree];
    // Report the offset of the nearest lake-connected cell centre from the actual harbour gauge.
    let best = { offset: Infinity };
    for (const i of lake) {
      const [x, z] = centre(i % columns, Math.floor(i / columns));
      const offset = Math.hypot(x - target[0], z - target[1]);
      if (offset < best.offset) best = { offset, x, z, levels: [] };
    }
    if (!(best.offset <= 2 * dx))
      throw new Error(`No wet model cell near the gauge at (${lat}, ${lon}); inspect coastal resolution.`);
    return best;
  });
  const first = 24;
  const stop = 96;
  for (let h = first; h < stop; h++) {
    world.advance((h * 3600) / physicalStep);
    for (const { x, z, levels } of stations) {
      const sample = water.sample(x, z);
      if (!(sample.depth > 0 && Number.isFinite(sample.surface)))
        throw new Error(
          `Gauge proxy dried or became nonfinite at (${x}, ${z}), ${stamp(h)}; inspect the coastal grid.`,
        );
      levels.push(sample.surface);
    }
  }
  return stations;
}

// Score the complete 72 h and the independently specified UTC date of the storm maximum.
// The reported peak is an hourly sample. Historical instrument accuracy
// is unverified; the NOAA returned precision here is 1 mm. Neither is an event confidence interval.
function score(gaugeData, station) {
  const target = gaugeData.samples.slice(24, 96);
  const paired = target.flatMap((observed, i) =>
    observed === null ? [] : [{ observed, predicted: station.levels[i], hour: i + 24 }],
  );
  const residual = paired.map(({ observed, predicted }) => predicted - observed);
  const event = paired.filter(({ hour }) => hour >= 48 && hour < 72);
  const peak = (key) => event.reduce((best, row) => (row[key] > best[key] ? row : best));
  const observedPeak = peak('observed');
  const predictedPeak = peak('predicted');
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    station: gaugeData.name,
    id: gaugeData.id,
    offsetMetres: station.offset,
    hours: paired.length,
    missingHours: target.length - paired.length,
    bias: mean(residual),
    rmse: Math.sqrt(mean(residual.map((value) => value ** 2))),
    observedPeak: { height: observedPeak.observed, time: stamp(observedPeak.hour) },
    predictedPeak: { height: predictedPeak.predicted, time: stamp(predictedPeak.hour) },
    heightResidualAtObservedPeak: observedPeak.predicted - observedPeak.observed,
    peakTimeResidualHours: predictedPeak.hour - observedPeak.hour,
  };
}

await mkdir(cache, { recursive: true });
const [topography, source, datumGauge, ...observed] = await Promise.all([
  bathymetry(),
  meteorology(),
  gauge(datumId),
  ...observationIds.map(gauge),
]);
const preStorm = datumGauge.samples.slice(0, 24);
if (preStorm.includes(null))
  throw new Error('Missing reference level before the score window; check the pre-storm gauge.');
const level = preStorm.reduce((sum, value) => sum + value, 0) / preStorm.length;
console.log(
  JSON.stringify({
    initialLevelLwd: level,
    datumStation: datumGauge.id,
    inputHash: sha(JSON.stringify({ source, datumGauge, observed })),
    bathymetryHash,
  }),
);
const coarse = simulate(topography, source, observed, level, 16_000, 120);
console.log(
  JSON.stringify({
    cellMetres: 16_000,
    pressureStepSeconds: 120,
    scores: observed.map((data, i) => score(data, coarse[i])),
  }),
);
const fine = simulate(topography, source, observed, level, 8_000, 60);
console.log(
  JSON.stringify({
    cellMetres: 8_000,
    pressureStepSeconds: 60,
    scores: observed.map((data, i) => ({
      ...score(data, fine[i]),
      maxGridTimeAndPlacementSpread: Math.max(
        ...fine[i].levels.map((value, j) => Math.abs(value - coarse[i].levels[j])),
      ),
    })),
  }),
);
