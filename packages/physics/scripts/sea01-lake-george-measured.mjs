// Build Physics, then run: node packages/physics/scripts/sea01-lake-george-measured.mjs
// I. R. Young & L. A. Verhagen (1996), The growth of fetch limited waves in water of finite depth.
// Part 1. Total energy and peak frequency, Coastal Engineering 29, 47–78,
// https://doi.org/10.1016/S0378-3839(96)00006-3. Sparse published measurement facts from
// V. S. Gruijthuijsen (1996), Validation of the wave prediction model SWAN using field data from
// Lake George, Australia, TU Delft, Chapter 4 and Appendix I, https://resolver.tudelft.nl/uuid:a8a1face-a0ef-4307-85cf-7931c92bb6eb.
// We transcribe field measurements from the thesis and do not distribute its figures or data files.
import assert from 'node:assert/strict';
import { FRESH_WATER_DENSITY, WaveSolver, peakFrequency, significantHeight } from '../dist/waves.js';
import { PhysicsWorld } from '../dist/world.js';

const fetches = [1170, 2160, 3570, 5110, 6530, 7970, 11700, 15100];
const end = 16800;
const regimes = [
  {
    name: 'B',
    windFrom: 342,
    anemometerU10: 10.81,
    // Upstream station 1 is a separate measurement when used as a boundary.
    upstream: { height: 0.218, frequency: 0.538 },
    depths: [1.79, 1.92, 1.85, 1.91, 2.0, 2.12, 2.14, 2.11],
    winds: [9.08, 9.68, 10.1, 10.4, 10.6, 10.81, 11.1, 11.3],
    // [station (one based), observed Hs m, observed fp Hz, digitized Hs 95% interval m].
    targets: [
      [2, 0.31, 0.459, [0.29, 0.332]],
      [4, 0.367, 0.41, [0.341, 0.398]],
      [6, 0.414, 0.384, [0.382, 0.453]],
      [8, 0.416, 0.358, [0.386, 0.453]],
    ],
    digitizationM: 0.005,
  },
  {
    name: 'C',
    windFrom: 341,
    anemometerU10: 15.22,
    upstream: { height: 0.092, frequency: 0.584 },
    depths: [1.78, 1.9, 1.85, 1.88, 1.99, 2.03, 2.13, 2.11],
    winds: [13, 13.8, 14.4, 14.8, 15, 15.22, 15.6, 15.8],
    targets: [
      [2, 0.289, 0.467, [0.263, 0.325]],
      [4, 0.486, 0.395, [0.449, 0.53]],
      [6, 0.543, 0.355, [0.498, 0.599]],
      [8, 0.583, 0.326, [0.536, 0.643]],
    ],
    digitizationM: 0.007,
  },
];

// Figure 4.2, printed p. 23: crosses/triangles are 95% limits. On the 2x scan (1191×1684),
// B spans y=953.5..703 at x=375 for 0..0.60 m; C spans y=1304.5..1054 at x=378 for 0..0.80 m.
// The chart axis rises about 0.004 pixels per x pixel. Use the marker center, or at C2 (touching
// markers) the outer extent. Two pixels of additional readout allowance round up to 0.005/0.007 m.
// fp is printed to 0.001 Hz. Its per-station sampling variance is unavailable here, so report
// frequency residual and numerical spread without giving the printed precision a pass/fail meaning.

function interpolate(x, points, values) {
  const last = points.length - 1;
  if (x >= points[last]) return values[last];
  if (x <= points[0]) return values[0];
  const upper = points.findIndex((point) => point >= x);
  const ratio = (x - points[upper - 1]) / (points[upper] - points[upper - 1]);
  return values[upper - 1] + ratio * (values[upper] - values[upper - 1]);
}

function run(regime, boundary, cellSize, interval, count, directions) {
  const start = boundary === 'station-1' ? fetches[0] : 0;
  const cells = Math.ceil((end - start) / cellSize);
  const direction = ((360 - regime.windFrom) * Math.PI) / 180;
  // +X is toward the south along the gauge fetch transect, +Z east. Extrapolate the first measured
  // depth to the open north edge and the last depth to the south edge. Lateral boundaries are periodic.
  // Appendix I U10 is Taylor–Lee's independent wind-only estimate, anchored at station 6.
  const winds = [0.65 * regime.anemometerU10, ...regime.winds];
  const locations = [0, ...fetches];
  const wind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample(x, _y, _z, _time, out) {
      const speed = interpolate(x, locations, winds);
      out.velocity[0] = speed * Math.cos(direction);
      out.velocity[1] = 0;
      out.velocity[2] = speed * Math.sin(direction);
      out.density = 1.225;
      out.temperature = 288.15;
      return out;
    },
  };
  const waves = new WaveSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] }).add(waves, {
    cells: [cells, 1],
    cellSize,
    centre: [start + (cells * cellSize) / 2, 0],
    depth: (x) => interpolate(x, fetches, regime.depths),
    density: FRESH_WATER_DENSITY,
    wind,
    frequencies: { min: 0.09, max: 1.5, count },
    directions,
    ...(boundary === 'station-1'
      ? { swell: { height: regime.upstream.height, period: 1 / regime.upstream.frequency, direction } }
      : {}),
    interval,
    timeScale: interval * 60,
    periodic: ['z'],
  });
  const read = () =>
    regime.targets.map(([station]) => {
      const spectrum = waves.field.sample(fetches[station - 1], 0);
      const height = significantHeight(spectrum);
      const frequency = peakFrequency(spectrum);
      assert.ok(Number.isFinite(height + frequency) && height > 0 && frequency > 0);
      return { height, frequency };
    });
  world.advance((6 * 3600) / interval);
  const initial = read();
  world.advance((9 * 3600) / interval);
  return { initial, final: read() };
}

for (const regime of regimes) {
  for (const boundary of ['station-1', 'north-shore']) {
    const coarse = run(regime, boundary, 700, 120, 26, 12);
    const fine = run(regime, boundary, 350, 60, 36, 20);
    const stations = regime.targets.map(([station, observedHeight, observedFrequency, interval], index) => {
      const { height, frequency } = fine.final[index];
      const heightNumericalSpread =
        Math.abs(height - coarse.final[index].height) + Math.abs(height - fine.initial[index].height);
      const frequencyNumericalSpread =
        Math.abs(frequency - coarse.final[index].frequency) + Math.abs(frequency - fine.initial[index].frequency);
      const heightReadout = [interval[0] - regime.digitizationM, interval[1] + regime.digitizationM];
      return {
        station,
        fetch: fetches[station - 1],
        predictedHeight: height,
        observedHeight,
        heightReadout,
        heightResidual: height - observedHeight,
        heightNumericalSpread,
        heightBandsOverlap:
          height + heightNumericalSpread >= heightReadout[0] && height - heightNumericalSpread <= heightReadout[1],
        predictedFrequency: frequency,
        observedFrequency,
        frequencyResidual: frequency - observedFrequency,
        frequencyNumericalSpread,
      };
    });
    console.log(JSON.stringify({ regime: regime.name, boundary, station6U10: regime.anemometerU10, stations }));
  }
}
