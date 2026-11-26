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

test('a gale of 20 m/s grows the sea along its fetch as Kahma and Calkoen measured, in friction-velocity scaling (KB-SEA-GROWTH1)', () => {
  // Kahma and Calkoen's stable fetch law, e* = g^2 E / u*^4 = 2.1e-3 chi*^0.79 with chi* = g x / u*^2 (as Liu et al. 2019 state
  // it, valid for chi* 3e4 to 4e6), on a grid that resolves the coast: cells of g dx / U^2 = 62.5. A coarser grid smears the
  // young waves' fast growth over too long a fetch and flattens the law (chi*^0.68 at twice the cell); WAM Cycle 3 grows this
  // sea 60 percent too high. Measured: e* at 1.17, 1.12 and 1.07 of the law at chi 500, 1,000 and 3,500, and a slope of 0.74.
  const U = 20,
    n = 64,
    dx = (4000 * U * U) / g / n,
    { waves } = sea({
      cells: [n, 1],
      cellSize: dx,
      centre: [(n * dx) / 2, 0],
      wind: steady(U),
      periodic: ['z'],
      interval: 120,
      warmUp: 12 * 3600,
      frequencies: { min: 0.03, max: 1, count: 30 },
    }),
    points = [500, 1000, 3500].map((chi) => {
      const x = (Math.round((chi * U * U) / g / dx - 0.5) + 0.5) * dx,
        ustar = waves.frictionVelocity(x, 0),
        energy = (waves.significantHeight(x, 0) / 4) ** 2;
      return { chiStar: (g * x) / (ustar * ustar), eStar: (g * g * energy) / ustar ** 4 };
    });
  for (const { chiStar, eStar } of points) {
    const law = 2.1e-3 * chiStar ** 0.79;
    assert.ok(eStar > 0.85 * law && eStar < 1.25 * law, `chi* ${chiStar.toFixed(0)}: e* ${eStar} against ${law}`);
  }
  const first = points[0],
    last = points[points.length - 1],
    slope = Math.log(last.eStar / first.eStar) / Math.log(last.chiStar / first.chiStar);
  assert.ok(slope > 0.7 && slope < 0.9, `e* grows as chi*^${slope.toFixed(2)}, against 0.79`);
});

test("the wind's friction velocity comes from the waves with ST4 and from the drag fit with WAM Cycle 3", () => {
  const U = 20,
    make = (physics) =>
      sea({
        cells: [8, 1],
        cellSize: 4000,
        centre: [16000, 0],
        wind: steady(U),
        periodic: ['z'],
        warmUp: 6 * 3600,
        frequencies: { min: 0.04, max: 1, count: 24 },
        physics,
      }).waves,
    st4 = make('st4'),
    wam3 = make('wam3'),
    ut = U / 31.5;
  // WAM Cycle 3: U*^2 = C_D U10^2, C_D = (0.55 + 2.97 U~ - 1.49 U~^2) 1e-3 exactly.
  assert.ok(
    Math.abs(wam3.frictionVelocity(10000, 0) / (U * Math.sqrt((0.55 + 2.97 * ut - 1.49 * ut * ut) * 1e-3)) - 1) < 1e-12,
  );
  // ST4: the young sea's own roughness, a drag of 2 to 3 per mille at 20 m/s (measured 2.2e-3), higher where the waves are younger.
  const drag = (x) => (st4.frictionVelocity(x, 0) / U) ** 2;
  assert.ok(drag(30000) > 1.8e-3 && drag(30000) < 3e-3, `C_D ${drag(30000)}`);
  assert.ok(drag(2000) > drag(30000), 'a younger sea drags harder');
});

test('with unlimited fetch the sea grows to the fully developed sea Alves, Banner and Young measured (KB-SEA-FULLDEV1)', () => {
  // Alves, Banner and Young (2003): H_s = 0.254 U10^2 / g (95 percent band 0.233 to 0.272) and f_p = 0.123 g / U10, with no
  // trend with the wind over 9.5 to 21.6 m/s. Pierson and Moskowitz's 0.21 is in the wind at 19.5 m, 0.241 in U10. Each wind
  // runs to the same g t / U10 = 2.5e5. ST4's input scales with u*, so the developed sea rises with the wind (measured
  // 0.221 at 10 m/s, 0.281 at 20, a ratio of 1.27 against the data's 1.02 and pure u* scaling's 1.30 to 1.45), and ST4
  // has no true full development (Ardhuin et al. 2010): it keeps growing slowly.
  const developed = (U, hours) => {
      const { waves } = sea({
        cells: [1, 1],
        cellSize: 1e7,
        wind: steady(U),
        periodic: ['x', 'z'],
        warmUp: hours * 3600,
        frequencies: { min: 0.02, max: 1, count: 42 },
      });
      return { height: (waves.significantHeight(0, 0) * g) / (U * U), peak: U / (waves.peakPeriod(0, 0) * g) };
    },
    young = developed(10, 12),
    ten = developed(10, (2.5e5 * 10) / g / 3600),
    twenty = developed(20, (2.5e5 * 20) / g / 3600);
  assert.ok(young.height < ten.height, 'growing');
  for (const [U, s] of [
    [10, ten],
    [20, twenty],
  ]) {
    assert.ok(Math.abs(s.height / 0.254 - 1) < 0.15, `${U} m/s: H_s ${s.height} U^2/g against 0.254`);
    assert.ok(Math.abs(s.peak / 0.123 - 1) < 0.1, `${U} m/s: f_p ${s.peak} g/U against 0.123`);
  }
  const trend = twenty.height / ten.height;
  assert.ok(trend > 1 && trend < 1.35, `20 m/s against 10 m/s: ${trend}`);
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
