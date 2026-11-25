// The sea's waves (SEA-01, ST4 by default): linear dispersion and group velocity at any depth; a wind sea that grows with fetch as JONSWAP
// found and with duration toward the fully developed sea; swell that runs in from the open sea at its group velocity; waves
// limited by shallow water; a lake's fresh water; the spectrum published for the sea surface; the same bits every time.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FRESH_WATER_DENSITY,
  groupVelocity,
  jonswap,
  peakFrequency,
  significantHeight,
  WAVE_SPECTRUM_FIELD,
  WaveSolver,
  wavenumber,
} from '../dist/waves.js';
import { PhysicsWorld } from '../dist/world.js';

const g = 9.81;

/** A steady wind of `speed` m/s toward +x. */
const steady = (speed) => ({
  medium: 'air',
  cell: [0, 0, 0],
  sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 1.225, temperature: 288 }) {
    out.velocity[0] = speed;
    out.velocity[1] = 0;
    out.velocity[2] = 0;
    return out;
  },
});

/** A world with a wave solver of `params`; one world step of 1/60 s is `interval` seconds of sea time. */
function sea(params) {
  const waves = new WaveSolver(),
    interval = params.interval ?? 60,
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(waves, { timeScale: 60 * interval, ...params });
  return { waves, world };
}

test('waves keep the linear dispersion relation at any depth, and their group velocity its limits', () => {
  for (const [f, d] of [
    [0.1, Infinity],
    [0.1, 20],
    [0.25, 3],
    [0.05, 1000],
  ]) {
    const k = wavenumber(f, d),
      sigma = 2 * Math.PI * f,
      t = Number.isFinite(d) ? Math.tanh(k * d) : 1;
    assert.ok(Math.abs((g * k * t) / (sigma * sigma) - 1) < 1e-12, `f ${f}, d ${d}`);
  }
  // Deep water: c_g = c / 2 = g / (2 sigma); shallow: c_g = c = sqrt(g d).
  assert.ok(Math.abs(groupVelocity(0.1, Infinity) / (g / (2 * 2 * Math.PI * 0.1)) - 1) < 1e-12);
  assert.ok(Math.abs(groupVelocity(0.02, 1) / Math.sqrt(g * 1) - 1) < 1e-3);
});

test('a JONSWAP sea built on the grid has the height and peak asked for', () => {
  const nf = 40,
    frequencies = Float64Array.from({ length: nf }, (_, i) => 0.03 * (1 / 0.03) ** (i / (nf - 1))),
    out = {
      frequencies,
      directions: Float64Array.from({ length: 24 }, (_, j) => (2 * Math.PI * j) / 24),
      energy: new Float64Array(nf * 24),
      depth: Infinity,
      density: 1025,
    };
  jonswap({ height: 3, period: 9, direction: 0 }, out);
  assert.ok(Math.abs(significantHeight(out) - 3) < 1e-12);
  assert.ok(Math.abs(1 / peakFrequency(out) - 9) / 9 < 0.05);
});

test('a wind sea grows with fetch as JONSWAP found (gale off a coast, 10 m/s), with ST4 and with WAM Cycle 3', () => {
  // Land up the wind of the grid's west edge; the sea goes on north and south (periodic in z).
  const U = 10;
  for (const physics of ['st4', 'wam3']) {
    const { waves } = sea({
      cells: [30, 1],
      cellSize: 2000,
      centre: [30000, 0],
      wind: steady(U),
      periodic: ['z'],
      warmUp: 12 * 3600,
      physics,
    });
    for (const fetch of [31000, 59000]) {
      const chi = (g * fetch) / (U * U),
        // JONSWAP (Hasselmann et al. 1973): g^2 E / U^4 = 1.6e-7 chi, omega_p = 22 (g / U) chi^(-1/3).
        height = 4 * Math.sqrt(1.6e-7 * chi) * ((U * U) / g),
        period = (2 * Math.PI) / (22 * (g / U) * chi ** (-1 / 3)),
        hs = waves.significantHeight(fetch, 0),
        tp = waves.peakPeriod(fetch, 0);
      // Measured: ST4 +8 and -4 percent in height, WAM Cycle 3 +16 and 0; both -7 and -9 percent in period (docs/limits.md).
      assert.ok(Math.abs(hs / height - 1) < 0.25, `${physics}, fetch ${fetch / 1000} km: Hs ${hs} against ${height}`);
      assert.ok(Math.abs(tp / period - 1) < 0.15, `${physics}, fetch ${fetch / 1000} km: Tp ${tp} against ${period}`);
    }
    assert.ok(waves.significantHeight(59000, 0) > waves.significantHeight(5000, 0), `${physics}: higher with fetch`);
  }
});

test('a gale of 20 m/s grows the sea as Kahma and Calkoen measured, not faster (KB-SEA-GROWTH1)', () => {
  // Kahma and Calkoen's composite (as Hwang 2006 tabulates it): g^2 E / U^4 = 5.2e-7 chi^0.9. First-order propagation and
  // WAM Cycle 3's u*-scaled input grew this sea 40 to 130 percent too high; the third-order scheme and ST4 keep it within 20
  // percent in height (measured +16 and -5 percent).
  const U = 20,
    n = 24,
    dx = (1.2e4 * U * U) / g / n,
    { waves } = sea({
      cells: [n, 1],
      cellSize: dx,
      centre: [(n * dx) / 2, 0],
      wind: steady(U),
      periodic: ['z'],
      interval: 180,
      warmUp: 36 * 3600,
      frequencies: { min: 0.03, max: 1, count: 30 },
    });
  for (const cell of [5, 19]) {
    const fetch = (cell + 0.5) * dx,
      chi = (g * fetch) / (U * U),
      kahma = 4 * Math.sqrt(5.2e-7 * chi ** 0.9) * ((U * U) / g),
      hs = waves.significantHeight(fetch, 0);
    assert.ok(Math.abs(hs / kahma - 1) < 0.2, `chi ${chi.toFixed(0)}: Hs ${hs} m against ${kahma} m`);
  }
});

test('with unlimited fetch the sea grows with duration toward the fully developed sea', () => {
  const U = 10,
    heights = [3, 12, 48].map((hours) => {
      const { waves } = sea({
        cells: [1, 1],
        cellSize: 1e7,
        wind: steady(U),
        periodic: ['x', 'z'],
        warmUp: hours * 3600,
        frequencies: { min: 0.03, max: 1, count: 40 },
      });
      return [waves.significantHeight(0, 0), waves.peakPeriod(0, 0)];
    }),
    // Pierson-Moskowitz: H_s = 0.21 U^2 / g, f_p = 0.13 g / U.
    pmHeight = (0.21 * U * U) / g,
    pmPeriod = U / (0.13 * g);
  assert.ok(heights[0][0] < heights[1][0] && heights[1][0] < heights[2][0], 'growing');
  assert.ok(
    heights[2][0] > 0.85 * pmHeight && heights[2][0] < 1.05 * pmHeight,
    `after two days ${heights[2][0]} m against ${pmHeight}`,
  );
  assert.ok(
    heights[2][1] > 0.85 * pmPeriod && heights[2][1] < 1.05 * pmPeriod,
    `period ${heights[2][1]} s against ${pmPeriod}`,
  );
});

test('swell from the open sea runs in at its group velocity (RITS-1, OO-2, BS-6)', () => {
  // A 12 s swell coming in over the west edge of still, deep water: its front reaches 100 km in about 100 km / c_g.
  const period = 12,
    cg = groupVelocity(1 / period, Infinity),
    { waves, world } = sea({
      cells: [50, 1],
      cellSize: 2000,
      centre: [50000, 0],
      swell: { height: 2, period, direction: 0 },
      periodic: ['z'],
    }),
    arrival = 100000 / cg,
    // One world step is a minute of sea time.
    heightAt = (seconds) => {
      world.advance(Math.round(seconds / 60));
      return waves.significantHeight(99000, 0);
    };
  const early = heightAt(0.6 * arrival),
    late = heightAt(1.6 * arrival);
  assert.ok(early < 0.5, `not there yet at 0.6 of the travel time: ${early} m`);
  assert.ok(late > 1.6, `arrived by 1.6 times it, hardly decayed: ${late} m`);
  assert.ok(Math.abs(waves.peakPeriod(99000, 0) / period - 1) < 0.1, 'still a long swell');
});

test('shallow water limits the waves: they break when their height nears the depth', () => {
  const depth = 3,
    { waves } = sea({ cells: [1, 1], cellSize: 1e6, depth, wind: steady(20), periodic: ['x', 'z'], warmUp: 12 * 3600 }),
    deepSea = sea({ cells: [1, 1], cellSize: 1e6, wind: steady(20), periodic: ['x', 'z'], warmUp: 12 * 3600 }).waves,
    hs = waves.significantHeight(0, 0);
  // Battjes and Janssen: H_rms at most 0.73 d, so H_s = sqrt(2) H_rms at most 1.03 d.
  assert.ok(
    hs < Math.SQRT2 * 0.73 * depth && hs < 0.5 * deepSea.significantHeight(0, 0),
    `${hs} m in ${depth} m of water`,
  );
});

test("a lake's fresh water is published with its spectrum, and the field is the framework's", () => {
  const lake = sea({ cells: [4, 4], cellSize: 500, density: FRESH_WATER_DENSITY, wind: steady(8), warmUp: 1800 }).waves,
    s = lake.field.sample(0, 0);
  assert.equal(s.density, 1000);
  assert.equal(s.energy.length, s.frequencies.length * s.directions.length);
  assert.ok(significantHeight(s) > 0, 'a lake chop has grown');
  assert.equal(WAVE_SPECTRUM_FIELD.name, 'waveSpectrum');
  // Land: no depth, no waves.
  const coast = sea({
    cells: [4, 1],
    cellSize: 500,
    depth: (x) => (x < 0 ? -1 : 10),
    wind: steady(8),
    warmUp: 1800,
  }).waves;
  assert.equal(coast.significantHeight(-800, 0), 0);
  assert.ok(coast.significantHeight(800, 0) > 0);
});

test('the same sea from the same start, bit for bit', () => {
  const make = () =>
      sea({ cells: [6, 3], cellSize: 800, wind: steady(12), swell: { height: 1, period: 8, direction: 0.3 } }),
    a = make(),
    b = make();
  a.world.advance(20);
  b.world.advance(20);
  assert.equal(a.world.hash(), b.world.hash());
});

test('settings out of range are refused with what to pass', () => {
  const world = () => new PhysicsWorld({ rate: { num: 60, den: 1 } });
  assert.throws(() => world().add(new WaveSolver(), { cells: [0, 4] }), /1 to 1024/);
  assert.throws(() => world().add(new WaveSolver(), { frequencies: { min: 1, max: 0.5, count: 10 } }), /min < max/);
  assert.throws(() => world().add(new WaveSolver(), { periodic: ['y'] }), /'x' or 'z'/);
  assert.throws(() => world().add(new WaveSolver(), { physics: 'st6' }), /'st4' or 'wam3'/);
});
