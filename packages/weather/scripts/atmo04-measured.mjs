// Rain: Gires, Tchiguirinskaia and Schertzer, Two months of disdrometer data in the Paris area (2018),
// https://doi.org/10.5194/essd-10-941-2018; source archives https://doi.org/10.5281/zenodo.1240168 (CC BY 4.0).
// Published PWS100 rain rate and PWS100 CS215 temperature are forcing only. Independent Parsivel2
// occlusion counts score size and arrival speed; raw speed bins are not selected around a terminal-speed law.
// This is a natural-rain optical disdrometer comparison; the NASA IFloodS 2DVD granules require Earthdata access.
// Snow: Locatelli and Hobbs, Fall speeds and masses of solid precipitation particles (1974),
// https://doi.org/10.1029/JC079i015p02185, Fig. 20, p. 2192. Sparse measured points only, no fitted curves.
// This snow comparison has shared lineage: the Brown–Francis mass law traces to a different
// Locatelli–Hobbs aggregate habit, and Heymsfield–Westbrook used the study for field assessment
// (their drag coefficients were fitted to analogue tank data, https://doi.org/10.1175/2010JAS3379.1).
// Fig. 20 does not constitute strict validation against a separate field campaign.
// Independent snow: Kuhn and Vázquez-Martín, Kiruna D-ICI field measurements, v1 (2021),
// https://doi.org/10.5878/dgak-p185 (CC BY 4.0), analyzed in https://doi.org/10.5194/acp-21-7545-2021.
// Only optical sizes, shape codes and airport weather enter the model, with imaged speeds held out.
// Run: node scripts/run-with-timeout.mjs --max=2 -- node packages/weather/scripts/atmo04-measured.mjs

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { airDensity, standardAtmosphere } from '@margoengine/math/atmosphere';
import { PrecipitationField, rainFallSpeed, snowFallSpeed } from '../dist/precipitation.js';

const cache = join(tmpdir(), 'margo-atmo04-measured');
async function pinnedDownload(url, local, hash) {
  const path = join(cache, local);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(url, { signal: AbortSignal.timeout(35_000) });
    if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status}); check the source record.`);
    bytes = Buffer.from(await response.arrayBuffer());
    checkHash(bytes, local, hash);
    await writeFile(path, bytes);
    return bytes;
  }
  checkHash(bytes, local, hash);
  return bytes;
}

function checkHash(bytes, local, hash) {
  if (createHash('sha256').update(bytes).digest('hex') !== hash) {
    throw new Error(`The source file ${local} changed; verify the data release before accepting the change.`);
  }
}

async function archive(name, local, hash) {
  const zip = await pinnedDownload(`https://zenodo.org/api/records/1240168/files/${name}/content`, local, hash);
  // Both pinned archives use the ordinary ZIP central directory and Deflate.
  const footer = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (footer < 0) throw new Error(`Missing central directory in ${name}; verify the ZIP download.`);
  const count = zip.readUInt16LE(footer + 10);
  const entries = new Map();
  let at = zip.readUInt32LE(footer + 16);
  for (let i = 0; i < count; i++) {
    const length = zip.readUInt16LE(at + 28);
    const member = zip.toString('utf8', at + 46, at + 46 + length);
    entries.set(member, {
      method: zip.readUInt16LE(at + 10),
      packed: zip.readUInt32LE(at + 20),
      header: zip.readUInt32LE(at + 42),
    });
    at += 46 + length + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return (member) => {
    const entry = entries.get(member);
    if (!entry) throw new Error(`Missing source member ${member}; verify the snapshot of ${name}.`);
    const { method, packed, header } = entry;
    const start = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28);
    const bytes = zip.subarray(start, start + packed);
    if (method === 0) return bytes.toString('utf8');
    if (method === 8) return inflateRawSync(bytes).toString('utf8');
    throw new Error(`Unsupported ZIP compression for ${member}; use the pinned release of ${name}.`);
  };
}

// Table 2, Gires et al. Bin edges derive from the documented widths, not from rounded displayed centres.
function bins(ranges) {
  let lo = 0;
  return ranges.flatMap(([count, width]) =>
    Array.from({ length: count }, () => {
      const hi = lo + width;
      const bin = { lo, hi, mid: lo + width / 2 };
      lo = hi;
      return bin;
    }),
  );
}
const diameters = bins([
  [10, 0.125],
  [5, 0.25],
  [5, 0.5],
  [5, 1],
  [5, 2],
  [2, 3],
]);
const speeds = bins([
  [10, 0.1],
  [5, 0.2],
  [5, 0.4],
  [5, 0.8],
  [5, 1.6],
  [2, 3.2],
]);
const groupEdges = [0.5, 1, 1.5, 2, 3.5];
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sum = (values) => values.reduce((total, value) => total + value, 0);
const within = (x, min, max) => x >= min - 1e-12 && x <= max + 1e-12;
const diameterIndices = diameters.flatMap(({ lo, hi }, i) => (lo >= 0.5 && hi <= 3.5 ? [i] : []));
// Slow/zero-bin detections do not define a stable sampled volume. The bound is fixed, independent of drop size.
const minimumSpeed = 0.5;
const rowsPerWindow = 10; // 30 s samples in nonoverlapping 5 min windows.
const dailyMember = (name, day) => `Daily_data_csv/${name}/${name}_daily_data_${day.replaceAll('_', '')}.csv`;
const pressure = standardAtmosphere(100)[1]; // nominal local pressure; no source barometer was used in this diagnostic.

function modelRain(rate, temperature) {
  const air = { temperature, density: airDensity(temperature, pressure) };
  const wind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample: () => ({ velocity: [0, 0, 0], ...air }),
  };
  const { rain } = new PrecipitationField({ rate, base: 1, wind }).sample(0, 0, 0, 0);
  return {
    air,
    concentration: (lo, hi) =>
      (rain.intercept / rain.slope) * (Math.exp(-rain.slope * lo * 0.001) - Math.exp(-rain.slope * hi * 0.001)),
  };
}

function qualifiedWindows(matrices, calendars, { day, low, high }) {
  const rates = calendars(`Calendars/Data_30_sec/R_30_sec_Carnot_1_${day}_00_00_00__${day}_23_59_30.csv`)
    .trim()
    .split(/\r?\n/)
    .map((row) => Number(row.split(';')[0]));
  const source = matrices(dailyMember('PWS', day)).trim().split(/\r?\n/);
  const targets = ['Pars1', 'Pars2'].map((name) => matrices(dailyMember(name, day)).trim().split(/\r?\n/));
  if ([source, rates, ...targets].some((rows) => rows.length !== 2880))
    throw new Error(`Expected a complete set of timestamps for ${day}; verify the source archive.`);
  const windows = [];
  for (let start = 0; start < source.length; start += rowsPerWindow) {
    const end = start + rowsPerWindow;
    const temperatures = source.slice(start, end).map((row) => +row.split(';')[2]);
    const rate = mean(rates.slice(start, end));
    if (!(rate >= low && rate < high && temperatures.every((t) => t >= 4))) continue;
    const counts = targets.map(() => new Float64Array(32 * 32));
    let complete = true;
    for (let k = start; k < end; k++) {
      for (const [sensor, rows] of targets.entries()) {
        const [time, matrix] = rows[k].split(';');
        if (time !== source[k].split(';')[0])
          throw new Error(`Misaligned Parsivel2 and PWS100 timestamp ${time}; inspect the source records.`);
        const recorded = matrix.replace(/,$/, '').split(',').map(Number);
        if (
          recorded.length !== counts[sensor].length ||
          recorded.some((value) => !Number.isFinite(value) || value < 0)
        ) {
          complete = false;
          continue;
        }
        for (const [i, value] of recorded.entries()) counts[sensor][i] += value;
      }
    }
    if (complete) windows.push({ counts, rate, temperature: mean(temperatures) + 273.15 });
  }
  if (!windows.length)
    throw new Error(`No complete ${low}–${high} mm/h warm windows on ${day}; check the source files.`);
  return windows;
}

function observedSize(matrix, i, exposure) {
  // Eq. 2 integrated over the diameter bin. Seff = 180(30-D/2) mm². Propagate
  // each speed bin's two edges into the sampling-volume correction independently of the prediction.
  const area = 1e-6 * 180 * (30 - diameters[i].mid / 2);
  const concentration = [0, 0, 0];
  for (const [j, { lo, mid, hi }] of speeds.entries()) {
    if (lo < minimumSpeed - 1e-12) continue;
    const count = matrix[32 * i + j];
    concentration[0] += count / hi;
    concentration[1] += count / mid;
    concentration[2] += count / lo;
  }
  return concentration.map((value) => value / (area * exposure));
}

function speedQuantile(matrix, i, fraction) {
  const row = matrix.subarray(i * 32, (i + 1) * 32);
  const threshold = sum(row) * fraction;
  let cumulative = 0;
  for (const [j, count] of row.entries()) {
    cumulative += count;
    if (cumulative >= threshold) return speeds[j];
  }
  throw new Error('Invalid disdrometer velocity bin walk; check the recorded counts.');
}

function reportRain(windows, condition) {
  const model = windows.map(({ rate, temperature }) => modelRain(rate, temperature));
  const aggregated = [0, 1].map((sensor) => {
    const result = new Float64Array(32 * 32);
    for (const { counts } of windows) for (const [i, count] of counts[sensor].entries()) result[i] += count;
    return result;
  });
  const exposure = windows.length * rowsPerWindow * 30;
  const bySize = groupEdges.slice(1).map((hi, group) => {
    const lo = groupEdges[group];
    const predicted = mean(model.map((day) => day.concentration(lo, hi)));
    const indices = diameterIndices.filter((i) => within(diameters[i].lo, lo, hi) && within(diameters[i].hi, lo, hi));
    const observed = aggregated.map((counts) => {
      const byBin = indices.map((i) => observedSize(counts, i, exposure));
      return [0, 1, 2].map((k) => sum(byBin.map((value) => value[k])));
    });
    const band = [Math.min(...observed.map((row) => row[0])), Math.max(...observed.map((row) => row[2]))];
    return {
      diameterMm: [lo, hi],
      predicted,
      observed: observed.map((row) => row[1]),
      band,
      withinSpeedBinAndReplicateSpread: within(predicted, ...band),
    };
  });
  const velocity = [8, 11, 13, 16].flatMap((i) => {
    const counts = aggregated.map((matrix) => sum(matrix.subarray(i * 32, (i + 1) * 32)));
    if (counts.some((n) => n < 30)) return [{ diameterMm: diameters[i].mid, positions: counts, insufficient: true }];
    const medians = aggregated.map((matrix) => speedQuantile(matrix, i, 0.5));
    const band = [
      Math.min(...aggregated.map((matrix) => speedQuantile(matrix, i, 0.1).lo)),
      Math.max(...aggregated.map((matrix) => speedQuantile(matrix, i, 0.9).hi)),
    ];
    const predict = (d) => mean(model.map(({ air }) => rainFallSpeed(d * 0.001, air)));
    const { lo, mid, hi } = diameters[i];
    const prediction = [predict(lo), predict(hi)];
    return [
      {
        diameterMm: mid,
        drops: counts,
        median: medians.map((bin) => bin.mid),
        band,
        predicted: predict(mid),
        prediction,
        withinMeasuredP10P90: prediction[1] >= band[0] && prediction[0] <= band[1],
      },
    ];
  });
  return {
    label: condition.day,
    rateBandMmPerHour: [condition.low, condition.high],
    windows: windows.length,
    forcingMeanMmPerHour: mean(windows.map(({ rate }) => rate)),
    temperatureC: mean(windows.map(({ temperature }) => temperature - 273.15)),
    ignoredSlowCounts: aggregated.map((counts) =>
      sum(diameterIndices.map((i) => sum(counts.subarray(i * 32, i * 32 + 5)))),
    ),
    bySize,
    velocity,
  };
}

function reportSnow() {
  // Isolated open squares/circles in Fig. 20, actual unrimed aggregate observations.
  // Axis calibration at 200 dpi gives 0.020 mm/pixel and 0.004 m/s/pixel. Rounded allowance
  // ±0.10 mm and ±0.03 m/s covers marker-centre reads. Larger post-capture diameters are a known unquantified bias.
  const observations = [
    [1.4, 0.55],
    [1.4, 1.28],
    [2.0, 0.82],
    [2.8, 1.08],
    [3.1, 0.71],
    [4.1, 0.72],
    [4.7, 1.16],
    [5.1, 0.75],
    [6.0, 0.82],
    [6.0, 0.88],
    [6.1, 1.02],
    [6.1, 1.15],
    [7.0, 1.03],
    [7.0, 1.23],
    [8.1, 0.98],
    [8.1, 1.38],
    [9.1, 0.87],
    [9.1, 1.26],
    [10.1, 0.92],
    [10.1, 1.14],
    [14.1, 0.81],
  ];
  const bands = [
    [1, 4],
    [4, 8],
    [8, 15],
  ];
  const predicted = (diameter, altitude, temperature) =>
    snowFallSpeed(diameter * 0.001, { temperature, density: airDensity(temperature, standardAtmosphere(altitude)[1]) });
  return bands.map(([lo, hi]) => {
    const selected = observations.filter(([d]) => d >= lo && d < hi);
    const residuals = selected.map(([d, measured]) => predicted(d, 1125, 268.15) - measured);
    const observed = selected.map(([, measured]) => measured);
    const scatter = [Math.min(...observed) - 0.03, Math.max(...observed) + 0.03];
    const sensitivity = selected.flatMap(([d]) =>
      [750, 1500].flatMap((altitude) =>
        [263.15, 273.15].flatMap((temperature) =>
          [-0.1, 0.1].map((delta) => predicted(d + delta, altitude, temperature)),
        ),
      ),
    );
    return {
      diameterMm: [lo, hi],
      points: selected.length,
      observedMean: mean(observed),
      observedScatter: scatter,
      meanBias: mean(residuals),
      rmse: Math.sqrt(mean(residuals.map((value) => value ** 2))),
      predictedSensitivity: [Math.min(...sensitivity), Math.max(...sensitivity)],
    };
  });
}

function reportKiruna(source) {
  // v1 Shapes.txt maps 97 to explicit aggregate A; other irregulars in the published group 14 are excluded.
  // The paper gives approximately 400 m elevation. Reduce airport MSL pressure by the standard-atmosphere ratio.
  const pressureRatio = standardAtmosphere(400)[1] / standardAtmosphere(0)[1];
  const aggregates = [];
  for (const line of source.trim().split(/\r?\n/).slice(1)) {
    const columns = line.split('\t');
    if (columns[6] !== '97' || Number(columns[10]) > 3) continue;
    const diameter = Number(columns[1]);
    const speed = Number(columns[5]);
    const temperature = Number(columns[8]) + 273.15;
    const pressure = Number(columns[12]) * 100 * pressureRatio;
    const air = { temperature, density: airDensity(temperature, pressure) };
    aggregates.push({ diameter, speed, air });
  }
  // Kuhn and Vázquez-Martín (2020) §§3.2–3.3, https://doi.org/10.5194/amt-13-1273-2020.
  // ±10 μm sizing and rounded 9% speed allowance (7% tumbling, 1% point selection and <1% clock).
  // These are approximate instrument allowances; empirical scatter is not a confidence interval.
  const bands = [
    [0.25, 0.5],
    [0.5, 1],
    [1, 2],
    [2, 4],
  ];
  return bands.map(([lo, hi]) => {
    const selected = aggregates.filter(({ diameter }) => diameter * 1000 >= lo && diameter * 1000 < hi);
    const speeds = selected.map(({ speed }) => speed).sort((a, b) => a - b);
    const model = selected.map(({ diameter, air }) => snowFallSpeed(diameter, air));
    const residuals = model.map((speed, index) => speed - selected[index].speed);
    const inInstrumentBand = selected.filter(
      ({ diameter, speed, air }) =>
        snowFallSpeed(diameter - 0.00001, air) <= speed * 1.09 &&
        snowFallSpeed(diameter + 0.00001, air) >= speed * 0.91,
    ).length;
    const percentile = (p) => {
      const at = (speeds.length - 1) * p;
      const lower = Math.floor(at);
      return speeds[lower] + (at - lower) * (speeds[Math.ceil(at)] - speeds[lower]);
    };
    return {
      diameterMm: [lo, hi],
      points: selected.length,
      observedP16P50P84: [percentile(0.16), percentile(0.5), percentile(0.84)],
      observedMean: mean(speeds),
      predictedMean: mean(model),
      bias: mean(residuals),
      rmse: Math.sqrt(mean(residuals.map((value) => value ** 2))),
      inInstrumentBand,
    };
  });
}

console.log(JSON.stringify({ snow: reportSnow() }));
await mkdir(cache, { recursive: true });
const [matrixArchive, calendarArchive, kiruna] = await Promise.all([
  archive('Daily_data_csv.zip', 'paris-csv.zip', 'ea596fe83be63ea03f303d2811e8477c32e803908e5c1564002cf5336684827e'),
  archive('Calendars.zip', 'paris-calendars.zip', '26704adf015eeaee3778cc260c293902ed3d74c8d49bad30391ece760a148fca'),
  pinnedDownload(
    'https://api.researchdata.se/dataset/2021-125-1/1/file/data/Particle_data.txt',
    'dici-particle.txt',
    '0355b3f21a66c58cbff714e484d7fc19784d8a680370f7a639fe3c0338bf27c8',
  ),
]);
console.log(JSON.stringify({ independentSnow: reportKiruna(kiruna.toString('utf8')) }));
const conditions = [
  { day: '2016_01_10', low: 0.5, high: 2 },
  { day: '2016_02_09', low: 4, high: 15 },
];
for (const condition of conditions) {
  console.log(
    JSON.stringify({ rain: reportRain(qualifiedWindows(matrixArchive, calendarArchive, condition), condition) }),
  );
}
