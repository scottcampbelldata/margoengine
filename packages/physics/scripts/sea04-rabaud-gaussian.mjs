// node scripts/run-with-timeout.mjs --max=4 -- node packages/physics/scripts/sea04-rabaud-gaussian.mjs
// Use --analytic-only for the outgoing-pole control or --marker=6/28 to select one case.
// Use --fine for 10 points per L. The high-Fr fine production grid exceeded a 5-minute local timeout.
import assert from 'node:assert/strict';
import { RealFft2 } from '@margoengine/math/fft';
import { WakeSolver } from '../dist/sea.js';
import { PhysicsWorld, regionWords, worldMemory } from '../dist/world.js';

const paper = 'https://arxiv.org/abs/1304.2653v1';
// The original carried-over Fig. 2 vector markers and the reported ±1°.
// Reproduce the extraction with sea04-measured-rabaud.py.
const cases = [
  { marker: 28, froude: 0.41644066336897173, observedDegrees: 19.849462361003617, precedingDiskDegrees: 12.5 },
  { marker: 6, froude: 1.033166426757314, observedDegrees: 9.000812946895383, precedingDiskDegrees: 11.75 },
];
const observationUncertaintyDegrees = 1;
const degreesPerRadian = 180 / Math.PI;
const turn = 2 * Math.PI;
const gravity = 9.81;
const density = 1025;
const rate = 60;
const pressureHeadPerLength = 0.001;
const angleStepDegrees = 0.25;
const maxDegrees = 26;
const stationCentres = [2, 3, 4];
const stations = Array.from({ length: 121 }, (_, i) => 1.5 + i / 40);
const travelOverWavelength = [10, 12, 14];
const argumentsUsed = process.argv.slice(2);
const cellsPerLength = argumentsUsed.includes('--fine') ? 10 : 8;
const analyticOnly = argumentsUsed.includes('--analytic-only');
const marker = argumentsUsed.find((arg) => arg.startsWith('--marker='));
assert.ok(
  argumentsUsed.every((arg) => arg === '--analytic-only' || arg === '--fine' || /^--marker=(6|28)$/.test(arg)),
  'Use --analytic-only to omit production, --fine for 10 points per L or --marker=6/28 to select a case.',
);

function perpendicularPeak(envelope, station, angleStep) {
  // Apply the same angle search at each downstream station. Turn the ray
  // angle into a transverse distance before fitting the paper's crest line.
  const step = angleStep / degreesPerRadian;
  const count = maxDegrees / angleStep;
  const amplitudes = Array.from({ length: count + 1 }, (_, i) => envelope(station * Math.tan(i * step)));
  const peak = Math.max(...amplitudes);
  const best = amplitudes.indexOf(peak);
  return { x: station, z: station * Math.tan(best * step), peak, searchEdge: best === 0 || best === count };
}

function fit(points) {
  const average = (read) => points.reduce((sum, point) => sum + read(point), 0) / points.length;
  const x = average((point) => point.x);
  const z = average((point) => point.z);
  const slope = average((point) => (point.x - x) * (point.z - z)) / average((point) => (point.x - x) ** 2);
  return {
    degrees: Math.atan(slope) * degreesPerRadian,
    interceptOverWavelength: z - slope * x,
    edgeStations: points.filter((point) => point.searchEdge).length,
  };
}

function assess(makeEnvelope, angleStep = angleStepDegrees) {
  const points = stations.map((station) => perpendicularPeak(makeEnvelope(station), station, angleStep));
  return {
    ...fit(points),
    windows: stationCentres.map((centre) => ({
      centre,
      ...fit(points.filter(({ x }) => Math.abs(x - centre) <= 0.5)),
    })),
    peaks: points.map(({ peak }) => peak),
  };
}

function outgoingPole(froude, intervals) {
  // Dimensionless (Kx,Kz)=k/kg; resonance sqrt(|K|)=Kx gives
  // Kx²=(1+sqrt(1+4 Kz²))/2. Integrating over Kx on the outgoing side gives
  // the pressure-dipole weight Kx*exp(−(kL)²/(8π²)) / (1−1/(2Kx²)).
  // This isolates the radiating pole. It omits the local non-wave field.
  const mu = 1 / (froude * froude);
  const spacing = 64 / (mu * intervals);
  const modes = Array.from({ length: intervals + 1 }, (_, i) => {
    const kz = i * spacing;
    const kx2 = (1 + Math.sqrt(1 + 4 * kz * kz)) / 2;
    const kx = Math.sqrt(kx2);
    const sampleWeight = i === 0 || i === intervals ? 1 : i % 2 === 0 ? 2 : 4;
    const pressure = Math.exp(-((mu * kx2) ** 2) / (8 * Math.PI ** 2));
    const weight = (sampleWeight * kx * pressure * spacing) / ((1 - 0.5 / kx2) * 3);
    return { kx, kz, weight };
  });
  return (distance) => {
    const real = Float64Array.from(modes, ({ kx, weight }) => weight * Math.cos(-turn * distance * kx));
    const imaginary = Float64Array.from(modes, ({ kx, weight }) => weight * Math.sin(-turn * distance * kx));
    const lateral = Float64Array.from(modes, ({ kz }) => turn * kz);
    return (offset) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < lateral.length; i++) {
        const coefficient = Math.cos(lateral[i] * offset);
        re += coefficient * real[i];
        im += coefficient * imaginary[i];
      }
      return Math.hypot(re, im);
    };
  };
}

function analytic(froude) {
  const coarse = assess(outgoingPole(froude, 2048));
  const fine = assess(outgoingPole(froude, 4096));
  const angleRefined = assess(outgoingPole(froude, 4096), angleStepDegrees / 2);
  const maxRelativeQuadratureDifference = Math.max(
    ...fine.peaks.map((value, i) => Math.abs(value - coarse.peaks[i]) / value),
  );
  assert.ok(maxRelativeQuadratureDifference < 0.002);
  const { peaks, ...result } = fine;
  return {
    ...result,
    quadratureAngleChange: fine.degrees - coarse.degrees,
    maxRelativeQuadratureDifference,
    halfAngleSearchStepDegrees: angleRefined.degrees,
  };
}

function mixedLength(wanted) {
  for (let n = 2 * Math.ceil(wanted / 2); n <= 4096; n += 2) {
    let residual = n;
    for (const factor of [2, 3, 5]) while (residual % factor === 0) residual /= factor;
    if (residual === 1) return n;
  }
  assert.fail('Use a domain with an even, smooth FFT length within the supported size.');
}

function sourceRows([x, z], length, spacing) {
  const sigma = length / turn;
  const reach = Math.ceil((6 * sigma) / spacing);
  const rows = [];
  // Eq. below Fig. 4 in Rabaud–Moisy. The simulated input is the signed
  // height kick −U dt ∂x P, with P the Gaussian expressed as pressure head.
  // U dt = spacing. Deposit these exact grid values as signed volumes.
  for (let j = -reach; j <= reach; j++) {
    for (let i = 1; i <= reach; i++) {
      const radiusSquared = spacing ** 2 * (i * i + j * j);
      if (radiusSquared > 36 * sigma ** 2) continue;
      const pressureHead = pressureHeadPerLength * length * Math.exp(-radiusSquared / (2 * sigma ** 2));
      const volume = (i * spacing ** 4 * pressureHead) / sigma ** 2;
      rows.push({ x: x + i * spacing, z: z + j * spacing, radius: spacing / 2, pressure: 0, volume });
      rows.push({ x: x - i * spacing, z: z + j * spacing, radius: spacing / 2, pressure: 0, volume: -volume });
    }
  }
  assert.equal(
    rows.reduce((sum, point) => sum + point.volume, 0),
    0,
  );
  return rows;
}

function wakeEnvelope(wake, world, fft, [x, z], wavelength) {
  const {
    cells: [nx, nz],
    cellSize: spacing,
    origin,
  } = wake.grid;
  const height = wake.heights();
  const potential = regionWords(world.memory, wake.stateRegions()[1]);
  const spectrum = fft.forward(potential);
  const half = nx / 2 + 1;
  for (let j = 0; j < nz; j++) {
    const kz = (turn * (j <= nz / 2 ? j : j - nz)) / (nz * spacing);
    for (let i = 0; i < half; i++) {
      const kx = (turn * i) / (nx * spacing);
      const at = 2 * (j * half + i);
      // ζ=η+iKφ/ω evolves as exp[−i(ω−Ukx)dt]. Complex conjugating
      // the intrinsic phase convention leaves the paper's modulus unchanged.
      const scale = Math.sqrt(Math.hypot(kx, kz) / gravity);
      spectrum[at] *= scale;
      spectrum[at + 1] *= scale;
    }
  }
  const quadrature = fft.inverse(spectrum);
  function heightAt(field, px, pz) {
    const u = (px - origin[0]) / spacing - 0.5;
    const v = (pz - origin[1]) / spacing - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const a = u - i;
    const b = v - j;
    const at = i + j * nx;
    return (
      (1 - b) * ((1 - a) * field[at] + a * field[at + 1]) + b * ((1 - a) * field[at + nx] + a * field[at + nx + 1])
    );
  }
  return (station) => (offset) => {
    const px = x - station * wavelength;
    const envelope = (pz) => Math.hypot(heightAt(height, px, pz), heightAt(quadrature, px, pz));
    return (envelope(z + offset * wavelength) + envelope(z - offset * wavelength)) / 2;
  };
}

async function production(froude) {
  // Deep-gravity scaling preserves Fr and all lengths in hull units.
  // Choose the physical L so the fixed 60 Hz clock translates one grid cell
  // per tick, exactly as in the paper, with the fixed samples per L.
  const length = gravity * ((cellsPerLength * froude) / rate) ** 2;
  const spacing = length / cellsPerLength;
  const speed = rate * spacing;
  const wavelength = (turn * speed * speed) / gravity;
  assert.ok(Math.abs(speed / Math.sqrt(gravity * length) - froude) < 1e-12);
  // Keep the original comparison's downstream windows. Enlarge the long
  // dimension beyond the elapsed resonant-zone group travel before wrap.
  // A transverse group has |c_g,z| <= U/4 on the resonant locus.
  const cells = [
    mixedLength(Math.max(35 * length, 16 * wavelength) / spacing),
    mixedLength(Math.max(12 * length, 8 * wavelength) / spacing),
  ];
  const sponge = Math.ceil((0.6 * wavelength) / spacing);
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    gravity: [0, -gravity, 0],
    memory: worldMemory(false),
  });
  const wake = await WakeSolver.load({ signal: AbortSignal.timeout(10_000) });
  const [nx, nz] = cells;
  const source = [(Math.floor((3 * nx) / 4) + 0.5 - nx / 2) * spacing, spacing / 2];
  const rows = sourceRows(source, length, spacing);
  world.add(wake, {
    cells,
    cellSize: spacing,
    depth: Infinity,
    density,
    current: [-speed, 0],
    sponge,
    sources: () => rows,
  });
  const furthest = stations.at(-1) * wavelength;
  assert.ok(source[0] - furthest > (sponge - nx / 2 + 2) * spacing);
  assert.ok(source[1] + furthest * Math.tan(maxDegrees / degreesPerRadian) < (nz / 2 - sponge - 2) * spacing);
  const fft = new RealFft2(nx, nz);
  const frames = [];
  for (const travel of travelOverWavelength) {
    const ticks = Math.round((travel * wavelength) / spacing);
    world.advance(ticks);
    const report = assess(wakeEnvelope(wake, world, fft, source, wavelength));
    frames.push({ ticks, travelOverWavelength: (ticks * spacing) / wavelength, ...report });
  }
  const last = frames.at(-1);
  const previous = frames.at(-2);
  const rmsPeakChange = Math.sqrt(
    last.peaks.reduce((sum, value, i) => sum + (value - previous.peaks[i]) ** 2, 0) /
      last.peaks.reduce((sum, value) => sum + value ** 2, 0),
  );
  return {
    modelHullLengthMetres: length,
    cellsPerLength,
    spacing,
    speed,
    wavelength,
    cells,
    sponge,
    sourceRows: rows.length,
    samples: frames.map(({ peaks, ...report }) => report),
    rmsPeakChange,
    settledWithinDiagnosticBar: rmsPeakChange < 0.05 && Math.abs(last.degrees - previous.degrees) < 0.5,
  };
}

function score(degrees, observedDegrees) {
  const error = degrees - observedDegrees;
  return { errorDegrees: error, withinReportedUncertainty: Math.abs(error) <= observationUncertaintyDegrees };
}

const predictions = cases
  .filter((test) => marker === undefined || marker === `--marker=${test.marker}`)
  .map((test) => {
    const control = analytic(test.froude);
    return { ...test, analytic: { ...control, ...score(control.degrees, test.observedDegrees) } };
  });
console.log(JSON.stringify({ paper, observationUncertaintyDegrees, stationCentres, angleStepDegrees, predictions }));
if (!analyticOnly) {
  for (const test of predictions) {
    const modeled = await production(test.froude);
    console.log(
      JSON.stringify({
        marker: test.marker,
        ...modeled,
        ...score(modeled.samples.at(-1).degrees, test.observedDegrees),
      }),
    );
  }
}
