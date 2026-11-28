// Nonlinear and rogue waves (SEA-03): a single wave gets Stokes's second harmonic in deep and finite water; two waves get
// Longuet-Higgins's sum and difference waves, and close ones the bound long wave of Longuet-Higgins and Stewart; a random sea's
// skewness is the one its kernels give; the statistics keep the Rayleigh limits and the ECMWF fit's shape; a rogue wave stands
// at its crest where it is placed and leaves the sea outside its window untouched; focusing seas draw rogues and crossing seas
// do not; the sea reads as a SeaSurface; the same seed gives the same bits.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NonlinearSea,
  crestChance,
  expectedMaximum,
  heightChance,
  kurtosisFactor,
  pairKernels,
  seaStatistics,
} from '../dist/rogue.js';
import { groupVelocity, jonswap, wavenumber } from '../dist/waves.js';
import { PhysicsWorld } from '../dist/world.js';

const g = -new PhysicsWorld().gravity[1];
const ND = 36;

/** A spectrum grid: `nf` log-spaced frequencies from f0 to f1 Hz, ND directions, deep water. */
function grid(nf = 40, f0 = 0.03, f1 = 0.6, depth = Number.POSITIVE_INFINITY) {
  const frequencies = new Float64Array(nf),
    directions = new Float64Array(ND);
  for (let i = 0; i < nf; i++) frequencies[i] = f0 * (f1 / f0) ** (i / (nf - 1));
  for (let j = 0; j < ND; j++) directions[j] = -Math.PI + ((j + 0.5) * 2 * Math.PI) / ND;
  return { frequencies, directions, energy: new Float64Array(nf * ND), depth, density: 1025 };
}

/** One wave of amplitude a and frequency f toward +x: a bin a millionth wide holding a^2 / 2. */
function oneWave(a, f, depth = Number.POSITIVE_INFINITY) {
  const s = grid(3, f, f, depth);
  s.frequencies = new Float64Array([f * (1 - 1e-7), f, f * (1 + 1e-7)]);
  s.energy = new Float64Array(3 * ND);
  s.energy[ND + ND / 2] = (a * a) / 2 / (f * 1e-7 * ((2 * Math.PI) / ND));
  return s;
}

/** A JONSWAP sea toward +x, spread cos^2 (or all in one direction when `longCrested`). */
function storm({ height, period, peakedness = 3.3, longCrested = false }) {
  const s = jonswap({ height, period, direction: 0, peakedness }, grid(), g);
  if (longCrested)
    for (let i = 0; i < s.frequencies.length; i++) {
      let sum = 0;
      for (let j = 0; j < ND; j++) {
        sum += s.energy[i * ND + j];
        s.energy[i * ND + j] = 0;
      }
      s.energy[i * ND + ND / 2] = sum;
    }
  return s;
}

test("one wave gets Stokes's second harmonic, (1/2) k a^2 cos 2 psi in deep water and its finite-depth form", () => {
  for (const depth of [Number.POSITIVE_INFINITY, 20, 8]) {
    const f = 0.1,
      sea = new NonlinearSea({ spectrum: oneWave(0.5, f, depth), components: 1, rogues: false, gravity: g }),
      k = wavenumber(f, depth, g),
      a = Math.sqrt(2 * sea.variance),
      kd = k * depth,
      // Stokes (1847) to second order: eta_2 = B a^2 cos 2 psi, B = k cosh(kd) (2 + cosh 2kd) / (4 sinh^3 kd), k / 2 deep.
      b = Number.isFinite(depth) ? (k * Math.cosh(kd) * (2 + Math.cosh(2 * kd))) / (4 * Math.sinh(kd) ** 3) : k / 2;
    for (let t = 0; t < 10; t += 0.37) {
      const linear = sea.linearElevation(3, 0, t),
        c = linear / a,
        second = sea.elevation(3, 0, t) - linear;
      assert.ok(Math.abs(second - b * a * a * (2 * c * c - 1)) < 1e-6 * b * a * a, `depth ${depth} t ${t}`);
    }
  }
});

test('two waves in line in deep water: the sum wave (k1 + k2)/2 and the difference wave -|k1 - k2|/2 (Longuet-Higgins)', () => {
  const k1 = wavenumber(0.08, Number.POSITIVE_INFINITY, g),
    k2 = wavenumber(0.12, Number.POSITIVE_INFINITY, g),
    { sum, difference } = pairKernels(
      { frequency: 0.08, direction: 0 },
      { frequency: 0.12, direction: 0 },
      Infinity,
      g,
    );
  assert.ok(Math.abs(sum - (k1 + k2) / 2) < 1e-12);
  assert.ok(Math.abs(difference + (k2 - k1) / 2) < 1e-12);
});

test("two close waves in finite water bind Longuet-Higgins and Stewart's long wave: -(2n - 1/2) g / (g h - cg^2)", () => {
  for (const depth of [5, 10, 20, 40]) {
    const f = 0.1,
      k = wavenumber(f, depth, g),
      cg = groupVelocity(f, depth, g),
      n = cg / ((2 * Math.PI * f) / k),
      bound = (-(2 * n - 0.5) * g) / (g * depth - cg * cg),
      { difference } = pairKernels({ frequency: f, direction: 0 }, { frequency: f * 1.0005, direction: 0 }, depth, g);
    // 0.05 percent apart, from the 0.05 percent frequency gap (measured 0.9995 at every depth).
    assert.ok(Math.abs(difference / bound - 1) < 1e-3, `depth ${depth}: ${difference} against ${bound}`);
  }
});

test("a random sea's skewness is the one its kernels give, and spreading lowers it", () => {
  const skew = (spectrum) => {
    let m2 = 0,
      m3 = 0,
      count = 0;
    for (let seed = 0; seed < 4; seed++) {
      const sea = new NonlinearSea({ spectrum, components: 100, seed, rogues: false, gravity: g });
      for (let t = 0; t < 40000; t += 1.3) {
        const e = sea.elevation(37 * seed, 0, t);
        m2 += e * e;
        m3 += e * e * e;
        count++;
      }
    }
    m2 /= count;
    return m3 / count / m2 ** 1.5;
  };
  const long = storm({ height: 8, period: 12, longCrested: true }),
    short = storm({ height: 8, period: 12 }),
    longStats = seaStatistics(long, { gravity: g }),
    shortStats = seaStatistics(short, { gravity: g });
  // Measured 0.1726 against 0.1726 and 0.1461 against 0.1497 over 123,000 samples.
  assert.ok(Math.abs(skew(long) / longStats.skewness - 1) < 0.05);
  assert.ok(Math.abs(skew(short) / shortStats.skewness - 1) < 0.05);
  assert.ok(shortStats.skewness < 0.9 * longStats.skewness);
  // A narrow long-crested deep sea: 3 k sigma (Tayfun 1980).
  const one = oneWave(1, 0.1),
    narrow = seaStatistics(one, { gravity: g }),
    sigma = Math.sqrt(0.5);
  assert.ok(Math.abs(narrow.skewness / (3 * wavenumber(0.1, Infinity, g) * sigma) - 1) < 1e-6);
});

test('the statistics keep the Rayleigh limits, the ECMWF fit of J(R) and the expected largest wave', () => {
  const linear = { kurtosis: 0, skewness: 0 };
  // Rayleigh: a height above 2 H_s once in 2981 waves, a crest above 1.25 H_s once in 268,000.
  assert.ok(Math.abs(heightChance(2, linear) - Math.exp(-8)) < 1e-15);
  assert.ok(Math.abs(crestChance(1.25, linear) - Math.exp(-12.5)) < 1e-15);
  // J(0) = pi Gamma / (3 sqrt 3), Gamma 0.9; J(1) = 0 where crossing seas stop focusing; negative beyond.
  assert.ok(Math.abs(kurtosisFactor(0) - (Math.PI * 0.9) / (3 * Math.sqrt(3))) < 1e-15);
  assert.ok(Math.abs(kurtosisFactor(1)) < 1e-15);
  assert.ok(kurtosisFactor(2) < 0 && kurtosisFactor(0.5) > 0);
  for (let r = 0.05; r < 1; r += 0.05) assert.ok(kurtosisFactor(r) < kurtosisFactor(r - 0.05) + 1e-15);
  // Rayleigh's largest of N: sqrt(ln(N) / 2 + gamma / 2) to leading order (Mori and Janssen's <z> with C4 = 0); 0.4 percent
  // at N = 1000 (1.928 against 1.935); kurtosis raises it.
  const n = 1000,
    asymptotic = Math.sqrt(0.5 * Math.log(n) + 0.5772156649 / 2);
  assert.ok(Math.abs(expectedMaximum(n, linear) / asymptotic - 1) < 0.005);
  assert.ok(expectedMaximum(n, { kurtosis: 0.1 }) > expectedMaximum(n, linear) * 1.02);
  // A long-crested narrow storm focuses (Janssen 2003): BFI above 0.5, dynamic kurtosis about 0.18, rogues ten times as
  // likely as Rayleigh's; the same storm spread cos^2 does not focus (R above 1).
  const focused = seaStatistics(storm({ height: 12, period: 14, peakedness: 7, longCrested: true }), { gravity: g }),
    spread = seaStatistics(storm({ height: 12, period: 14, peakedness: 7 }), { gravity: g });
  assert.equal(focused.directionality, 0);
  assert.ok(focused.benjaminFeir > 0.5 && focused.dynamicKurtosis > 0.15, JSON.stringify(focused));
  assert.ok(focused.rogueHeightChance > 5 * Math.exp(-8));
  assert.ok(spread.directionality > 1 && spread.dynamicKurtosis <= 0);
  assert.ok(Math.abs(focused.significantHeight - 12) < 1e-9);
});

test('a placed rogue stands at its crest, stills there, and leaves the sea outside its window untouched', () => {
  // The Draupner wave (1 January 1995): H_s 11.9 m, a crest of 18.5 m.
  const spectrum = storm({ height: 11.9, period: 15 }),
    event = { position: [200, -100], time: 500, crest: 18.5 },
    sea = new NonlinearSea({ spectrum, gravity: g, rogues: [event] }),
    plain = new NonlinearSea({ spectrum, gravity: g, rogues: false });
  assert.ok(Math.abs(sea.elevation(200, -100, 500) - 18.5) < 1e-6);
  // The highest point of the record about it is the crest.
  let top = Number.NEGATIVE_INFINITY,
    at = 0;
  for (let dt = -20; dt <= 20; dt += 0.05) {
    const e = sea.elevation(200, -100, 500 + dt);
    if (e > top) [top, at] = [e, dt];
  }
  assert.ok(Math.abs(top - 18.5) < 0.02 && Math.abs(at) < 0.2, `${top} at ${at}`);
  // The second order lifts it: about 2 m of the 18.5 (Adcock and Taylor's Draupner hindcasts put it near 15 to 16 m
  // linear).
  const rise = 18.5 - sea.linearElevation(200, -100, 500);
  assert.ok(rise > 1 && rise < 3.5, `rise ${rise}`);
  // Outside its window (8 zero-crossing periods, 8 zero-crossing wavelengths) the sea is the same sea, bit for bit.
  for (const [x, z, t] of [
    [200, -100, 0],
    [200, -100, 1000],
    [5200, -100, 500],
    [200, 4900, 500],
  ])
    assert.equal(sea.elevation(x, z, t), plain.elevation(x, z, t));
});

test('focusing seas draw their rogues, crossing seas none, and the same seed draws the same ones', () => {
  const focused = storm({ height: 12, period: 14, peakedness: 7, longCrested: true }),
    a = new NonlinearSea({ spectrum: focused, gravity: g, seed: 3 }),
    b = new NonlinearSea({ spectrum: focused, gravity: g, seed: 3 }),
    c = new NonlinearSea({ spectrum: focused, gravity: g, seed: 4 });
  assert.ok(a.rogues.length > 0);
  assert.deepEqual(a.rogues, b.rogues);
  assert.notDeepEqual(a.rogues, c.rogues);
  const hs = a.statistics.significantHeight;
  for (const r of a.rogues) {
    assert.ok(r.crest > 1.25 * hs && r.time >= 0 && r.time <= 3600);
    assert.ok(Math.abs(r.position[0]) <= 1000 && Math.abs(r.position[1]) <= 1000);
    assert.ok(Math.abs(a.elevation(r.position[0], r.position[1], r.time) / r.crest - 1) < 1e-8);
  }
  assert.equal(a.elevation(17, 31, 77.7), b.elevation(17, 31, 77.7));
  const spread = new NonlinearSea({ spectrum: storm({ height: 12, period: 14, peakedness: 7 }), gravity: g });
  assert.equal(spread.rogues.length, 0);
});

test('the sea reads as a SeaSurface: slope, orbital motion and pressure agree with its surface', () => {
  const sea = new NonlinearSea({ spectrum: storm({ height: 6, period: 10 }), gravity: g, components: 80 }),
    out = sea.sample(12, -7, 40),
    h = sea.elevation(12, -7, 40),
    d = 0.01,
    sx = (sea.elevation(12 + d, -7, 40) - sea.elevation(12 - d, -7, 40)) / (2 * d),
    sz = (sea.elevation(12, -7 + d, 40) - sea.elevation(12, -7 - d, 40)) / (2 * d);
  assert.equal(out.height, h);
  assert.ok(
    Math.abs(-out.normal[0] / out.normal[1] - sx) < 1e-6 && Math.abs(-out.normal[2] / out.normal[1] - sz) < 1e-6,
  );
  assert.equal(sea.pressure(12, h + 0.01, -7, 40), 0);
  assert.ok(Math.abs(sea.pressure(12, h - 1e-6, -7, 40)) < 0.1);
  assert.ok(sea.pressure(12, -30, -7, 40) > 1025 * g * 25);
  assert.equal(sea.water.sample(12, h + 1, -7, 40).density, 0);
  assert.equal(sea.water.sample(12, h - 1, -7, 40).density, 1025);
  // The surface rises as fast as the water at it moves up there (the kinematic condition, to first order in slope).
  const dt = 0.001,
    rate = (sea.elevation(12, -7, 40 + dt) - sea.elevation(12, -7, 40 - dt)) / (2 * dt),
    [u, v, w] = out.velocity;
  assert.ok(Math.abs(v - u * sx - w * sz - rate) < 0.25 * Math.abs(rate) + 0.1, `${v} ${rate}`);
  // Deep linear theory below one wave: u = a w e^(k y) cos psi.
  const one = new NonlinearSea({ spectrum: oneWave(0.2, 0.15), components: 1, rogues: false, gravity: g }),
    k = wavenumber(0.15, Infinity, g),
    a = Math.sqrt(2 * one.variance),
    eta = one.elevation(0, 0, 3),
    [u1, , w1] = one.velocity(0, -4, 0, 3),
    cosPsi = one.linearElevation(0, 0, 3) / a,
    along = a * 2 * Math.PI * 0.15 * Math.exp(k * (-4 - eta)) * cosPsi;
  // Its direction falls anywhere in its 10-degree bin, so the speed along it is the one to hold; its frequency anywhere in
  // its bin a ten-millionth wide (measured 1.3e-8 apart).
  assert.ok(Math.abs(Math.sign(u1) * Math.hypot(u1, w1) - along) < 1e-6 * Math.abs(along));
});

test('a nonlinear sea refuses what it cannot be made from, naming the fix', () => {
  const spectrum = storm({ height: 4, period: 8 });
  assert.throws(() => new NonlinearSea({}), /pass \{spectrum\} or \{waves\}/);
  assert.throws(() => new NonlinearSea({ spectrum, components: 0 }), /1 to 4096 components/);
  assert.throws(() => new NonlinearSea({ spectrum, cutoff: 1 }), /cutoff/);
  assert.throws(() => new NonlinearSea({ spectrum, seed: -1 }), /seed/);
  assert.throws(() => new NonlinearSea({ spectrum: grid() }), /no energy/);
  assert.throws(
    () => new NonlinearSea({ spectrum, rogues: [{ position: [0, 0], time: 0, crest: -1 }] }),
    /crest in metres/,
  );
  assert.throws(() => new NonlinearSea({ spectrum, rogues: { min: [0, 0], max: [-1, 1] } }), /rogue region/);
  assert.throws(
    () =>
      new NonlinearSea({
        spectrum,
        rogues: [
          { position: [0, 0], time: 0, crest: 8 },
          { position: [0, 0], time: 0, crest: 9 },
        ],
      }),
    /too close/,
  );
  assert.throws(() => pairKernels({ frequency: 0, direction: 0 }, { frequency: 0.1, direction: 0 }), /frequency in Hz/);
});

test('placed-wave normals differentiate the complete spatial envelope in both axes', () => {
  const spectrum = storm({ height: 4, period: 10 }),
    event = { position: [-78, 55], time: 80, crest: 6 },
    sea = new NonlinearSea({ spectrum, components: 39, seed: 17, rogues: [event] }),
    x = 55,
    z = -35,
    time = 89,
    { normal } = sea.sample(x, z, time);
  const slope = (axis, h) =>
    axis === 0
      ? (sea.elevation(x + h, z, time) - sea.elevation(x - h, z, time)) / (2 * h)
      : (sea.elevation(x, z + h, time) - sea.elevation(x, z - h, time)) / (2 * h);
  for (const axis of [0, 1]) {
    const coarse = slope(axis, 0.04),
      fine = slope(axis, 0.02),
      predicted = -normal[axis === 0 ? 0 : 2] / normal[1];
    // Twice the central difference truncation estimate at the fine step, plus subtraction roundoff.
    assert.ok(
      Math.abs(predicted - fine) <= (2 * Math.abs(fine - coarse)) / 3 + 1e-10,
      `slope ${axis}: ${predicted} vs ${fine}`,
    );
  }
});

test('finite-depth pressure and flow exclude the bed, and invalid input preserves caller samples', () => {
  const spectrum = oneWave(0.2, 0.15, 8),
    cell = [-3, 1, -7],
    waves = { cell, sample: () => spectrum };
  let valid = true;
  const current = {
    cell,
    medium: 'water',
    sample() {
      return { velocity: valid ? [0.3, 0, -0.12] : [0, Infinity, 0], density: 1025, temperature: 286 };
    },
  };
  const sea = new NonlinearSea({ waves, current, components: 1, rogues: false });
  assert.deepEqual(sea.cell, [-3, 1, -7]);
  assert.equal(sea.pressure(-8, -9, 13, -1), 0);
  assert.deepEqual(sea.velocity(-8, -9, 13, -1), [0, 0, 0]);
  assert.equal(sea.water.sample(-8, -9, 13, -1).density, 0);
  assert.ok(sea.pressure(-8, -8, 13, -1) > 0);
  const surface = sea.sample(-8, 13, -1),
    water = sea.water.sample(-8, -1, 13, -1),
    expectedSurface = structuredClone(surface),
    expectedWater = structuredClone(water),
    hasFix = (error) =>
      error.code === 'unsupported' && error.message.includes('https://margoengine.com/errors#nonlinear-sea');
  assert.deepEqual(surface.current, [0.3, 0, -0.12]);
  assert.equal(water.temperature, 286);
  valid = false;
  assert.throws(() => sea.sample(0, 5, 4, surface), hasFix);
  assert.throws(() => sea.water.sample(0, -1, 5, 4, water), hasFix);
  assert.throws(() => sea.sample(NaN, 0, 0, surface), hasFix);
  assert.throws(() => sea.pressure(0, NaN, 0, 0), hasFix);
  assert.deepEqual(surface, expectedSurface);
  assert.deepEqual(water, expectedWater);
  valid = true;
  sea.sample(-8, 13, -1, surface);
  sea.water.sample(-8, -1, 13, -1, water);
  assert.deepEqual(surface, expectedSurface);
  assert.deepEqual(water, expectedWater);
  assert.throws(() => new NonlinearSea({ waves, current: { ...current, cell: [0, 0, 0] } }), hasFix);
});

test('invalid grids, dry depth and non-finite gravity fail with codes before wave construction', () => {
  const spectrum = oneWave(0.2, 0.15, 8);
  const hasCode = (error) => error.code === 'unsupported' && error.message.includes('errors#nonlinear-sea');
  assert.throws(() => new NonlinearSea({ spectrum: { ...spectrum, energy: new Float64Array(1) } }), hasCode);
  assert.throws(() => new NonlinearSea({ spectrum: { ...spectrum, depth: 0 } }), hasCode);
  assert.throws(() => new NonlinearSea({ spectrum, gravity: Infinity }), hasCode);
  assert.throws(() => seaStatistics({ ...spectrum, frequencies: Float64Array.of(0.1, 0.2, 0.19) }), hasCode);
  assert.throws(() => pairKernels({ frequency: Infinity, direction: 0 }, { frequency: 0.2, direction: 1 }), hasCode);
});
