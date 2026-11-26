// Tides, storm surge and currents (SEA-07): a lake under a still pressure dome stands at the inverse barometer to rounding,
// and water left flat settles there; a steady wind sets the water up on the slope tau / (rho g (h + eta)); a seiche rings at
// Merian's period; the Earth's rotation turns a current through an inertial circle and keeps a Kelvin wave against its
// coast; a moving low makes Proudman's forced wave; a tide driven at a channel's mouth grows to 1 / cos(kL) at its head; the
// world's Sun and Moon tilt a small deep sea by the equilibrium tide; and Lake Superior's storm of 10 November 1975 piles the
// lake up at its eastern end and leaves it ringing at its own period.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../dist/earth.js';
import { ShallowWaterSolver } from '../dist/hydro.js';
import { CelestialSolver } from '../dist/celestial.js';
import { SurgeSolver, TIDAL_CONSTITUENTS, inverseBarometer, tidalLevel } from '../dist/surge.js';
import { PhysicsWorld } from '../dist/world.js';

const g = -new PhysicsWorld().gravity[1];

/** A bed of `columns` by `rows` cells over `width` by `depth` m with its corner at the origin, elevations from f(x, z). */
function ground(columns, rows, width, depth, f) {
  const shape = { columns, rows, width, depth, centre: [width / 2, depth / 2] },
    elevations = new Float64Array((columns + 1) * (rows + 1));
  for (let c = 0; c <= columns; c++)
    for (let r = 0; r <= rows; r++) elevations[r + (rows + 1) * c] = f((width * c) / columns, (depth * r) / rows);
  return bedSurface(shape, elevations);
}

/**
 * A wind field of a velocity [u, w] m/s at 10 m, a function of the water's time: a field is read at the world's time, which
 * runs `scale` times slower than the water's.
 */
function windOf(velocity, scale) {
  return {
    medium: 'air',
    cell: [0, 0, 0],
    sample: (x, _y, z, t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
      const [u, w] = velocity(x, z, t * scale);
      out.velocity[0] = u;
      out.velocity[1] = 0;
      out.velocity[2] = w;
      out.density = 1.2;
      out.temperature = 283;
      return out;
    },
  };
}

/**
 * A world of a shallow water (and a surge before it when `surge` is given), the water and the sky running `scale` of their
 * seconds each second of the world's, so hours of surge take a few thousand world steps. `until(t)` advances to the frame
 * nearest the water's time t and `run(s)` by s more; both return the water's time reached.
 */
function sea({ water: params, surge: surgeParams, scale = 1, tide = false, celestial }) {
  const water = new ShallowWaterSolver(),
    world = new PhysicsWorld();
  let surge;
  if (celestial) world.add(new CelestialSolver(), { timeScale: scale, ...celestial });
  world.add(water, { timeScale: scale, ...params });
  if (surgeParams) {
    surge = new SurgeSolver('surge', { tide });
    world.add(surge, { water, ...surgeParams }).couple(['surge', 'water'], 'staggered');
  }
  const fps = world.rate.num / world.rate.den,
    until = (seconds) => {
      world.advance(Math.round((seconds / scale) * fps));
      return world.time * scale;
    };
  return { water, surge, world, until, run: (seconds) => until(world.time * scale + seconds) };
}

test('a lake under a still pressure dome stands at the inverse barometer to rounding, over bumps and a dry island', () => {
  const bed = ground(
      30,
      20,
      30000,
      20000,
      (x, z) => -20 + 8 * Math.exp(-((x - 15000) ** 2 + (z - 10000) ** 2) / 2e7) + 3 * Math.sin(x / 3000),
    ),
    pressure = (x, z) => 101325 - 2500 * Math.exp(-((x - 12000) ** 2 + (z - 9000) ** 2) / 4e7),
    { water, run } = sea({
      water: { bed, level: (x, z) => -(pressure(x, z) - 101325) / (1000 * g), roughness: 0.03 },
      surge: { pressure, reference: 101325 },
      scale: 600,
    });
  run(600);
  for (let i = 0; i < 30; i++)
    for (let j = 0; j < 20; j++) {
      const x = (i + 0.5) * 1000,
        z = (j + 0.5) * 1000,
        s = water.sample(x, z);
      if (s.depth > 0) {
        assert.ok(Math.abs(s.surface + (pressure(x, z) - 101325) / (1000 * g)) < 1e-12, `${s.surface} at ${x}, ${z}`);
        assert.ok(Math.hypot(...s.velocity) < 1e-12);
      }
    }
  // 25 hPa low: 25.5 cm in fresh water, 1 cm a hectopascal.
  assert.ok(Math.abs(inverseBarometer(2500, 1000, g) - 0.2548) < 1e-3);
});

test('water left flat under a low settles at the inverse barometer, keeping its volume', () => {
  const bed = ground(40, 1, 40000, 1000, () => -10),
    pressure = (x) => 101325 - 2000 * Math.exp(-((x - 20000) ** 2) / 2e7),
    { water, surge, run, until } = sea({
      water: { bed, level: 0, roughness: 0.05 },
      surge: { pressure, ramp: 21600 },
      scale: 600,
    }),
    before = water.volume();
  run(40000);
  // The mean pressure over the lake is the reference: the water rises under the low and falls round it. A tanh ramp starts
  // with a slope, which rings the lake's seiches by a millimetre or two, and Manning's friction hardly damps them at
  // millimetres a second, so the level is the mean over the lake's longest period, 2L / sqrt(g h).
  const xs = [5500, 20500, 35500],
    mean = [0, 0, 0],
    period = (2 * 40000) / Math.sqrt(g * 10),
    samples = 100;
  for (let i = 1; i <= samples; i++) {
    until(40000 + (i * period) / samples);
    xs.forEach((x, k) => {
      mean[k] += water.sample(x, 500).surface / samples;
    });
  }
  xs.forEach((x, k) => {
    const want = -surge.potentialAt(x, 500);
    assert.ok(Math.abs(mean[k] - want) < 0.01 * 0.2, `${mean[k]} against ${want}`);
  });
  assert.ok(water.sample(20500, 500).surface > 0.15);
  assert.ok(Math.abs(water.volume() / before - 1) < 1e-12);
});

test('a steady wind sets a closed basin up on the slope tau / (rho g (h + eta)), the water still', () => {
  // 20 km of 10 m water, 20 m/s along it grown over two hours: tau = rho_a C_D U^2 with C_D = (0.75 + 0.067 U) 1e-3.
  const bed = ground(80, 1, 20000, 250, () => -10),
    speed = 20,
    { water, run } = sea({
      water: {
        bed,
        level: 0,
        roughness: 0.03,
        wind: windOf((_x, _z, t) => [speed * Math.tanh(t / 7200), 0], 300),
      },
      scale: 300,
    });
  run(60000);
  const tau = 1.2 * (0.75 + 0.067 * speed) * 1e-3 * speed * speed;
  for (const x of [4000, 10000, 16000]) {
    const a = water.sample(x - 500, 125),
      b = water.sample(x + 500, 125),
      slope = (b.surface - a.surface) / 1000,
      depth = 10 + (a.surface + b.surface) / 2;
    assert.ok(Math.abs(slope / (tau / (1000 * g * depth)) - 1) < 0.01, `slope ${slope} at ${x}`);
    assert.ok(Math.abs(water.sample(x, 125).velocity[0]) < 1e-3);
  }
});

test("a seiche rings at Merian's period 2L / sqrt(g h)", () => {
  const L = 100000,
    h = 50,
    bed = ground(100, 1, L, 1000, () => -h),
    { water, until } = sea({
      water: { bed, level: (x) => 0.1 * Math.cos((Math.PI * x) / L), roughness: 0 },
      scale: 600,
    }),
    crossings = [];
  let last = water.sample(500, 500).surface,
    before = 0;
  for (let s = 10; s <= 30000; s += 10) {
    const t = until(s),
      now = water.sample(500, 500).surface;
    if (last > 0 && now <= 0) crossings.push(t - ((t - before) * now) / (now - last));
    last = now;
    before = t;
  }
  const period = (crossings.at(-1) - crossings[0]) / (crossings.length - 1),
    merian = (2 * L) / Math.sqrt(g * h);
  assert.ok(Math.abs(period / merian - 1) < 0.01, `${period} against ${merian}`);
});

test("the Earth's rotation turns a current round an inertial circle at 2 pi / f, keeping its speed, rightward in the north", () => {
  const latitude = (47.5 * Math.PI) / 180,
    f = 2 * 7.292115e-5 * Math.sin(latitude),
    bed = ground(4, 4, 4000, 4000, () => -20),
    { water, until } = sea({
      water: {
        bed,
        level: 0,
        roughness: 0,
        velocity: () => [0.5, 0],
        coriolis: f,
        sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
      },
      scale: 600,
    }),
    period = (2 * Math.PI) / f,
    reached = until(period / 4);
  const quarter = water.sample(2000, 2000).velocity,
    turned = (f * reached) % (2 * Math.PI);
  // Facing east in the north, the water turns to its right: south, +z.
  assert.ok(
    Math.abs(quarter[0] - 0.5 * Math.cos(turned)) < 1e-9 && Math.abs(quarter[1] - 0.5 * Math.sin(turned)) < 1e-9,
  );
  assert.ok(quarter[1] > 0.49);
  until(period);
  assert.ok(Math.abs(Math.hypot(...water.sample(2000, 2000).velocity) - 0.5) < 1e-12);
});

test('a Kelvin wave runs along its coast at sqrt(g h), the coast on its right, falling off over sqrt(g h) / f', () => {
  // A periodic channel one wavelength long, 40 m deep, its southern (+z) side the coast; f = 1e-4.
  const h = 40,
    f = 1e-4,
    c = Math.sqrt(g * h),
    radius = c / f,
    L = 400000,
    W = 4 * radius,
    nx = 80,
    nz = 64,
    bed = ground(nx, nz, L, W, () => -h),
    k = (2 * Math.PI) / L,
    a = 0.1,
    eta = (x, z) => a * Math.exp(-(W - z) / radius) * Math.cos(k * x),
    { water, until } = sea({
      water: {
        bed,
        level: eta,
        velocity: (x, z) => [(g / c) * eta(x, z), 0],
        roughness: 0,
        coriolis: f,
        sides: { minX: 'periodic', maxX: 'periodic' },
      },
      scale: 3600,
    }),
    period = L / c;
  // A quarter period on, the crest has moved a quarter wavelength east (+x).
  const t = until(period / 4),
    along = (x) => water.sample(x, W - W / nz / 2).surface;
  let best = 0,
    at = 0;
  for (let i = 0; i < nx; i++) {
    const x = (i + 0.5) * (L / nx);
    if (along(x) > best) [best, at] = [along(x), x];
  }
  const expected = (c * t) % L;
  assert.ok(Math.abs(at - expected) <= L / nx, `crest at ${at}, expected ${expected}`);
  // Across: e-folding over the deformation radius.
  const near = water.sample(at, W - 0.5 * (W / nz)).surface,
    far = water.sample(at, W - 0.5 * (W / nz) - radius).surface;
  assert.ok(Math.abs(Math.log(near / far) - 1) < 0.08, `${near} ${far}`);
});

test("a low crossing a channel makes Proudman's forced wave, 1 / (1 - Fr^2) the inverse barometer, growing at resonance", () => {
  const h = 50,
    c = Math.sqrt(g * h),
    L = 800000,
    bed = ground(400, 1, L, 2000, () => -h),
    dip = 300,
    width = 20000,
    run = (froude, seconds) => {
      const speed = froude * c,
        { water, run: go } = sea({
          scale: 1200,
          water: { bed, level: 0, roughness: 0, sides: { minX: { sea: 0 }, maxX: { sea: 0 } } },
          surge: {
            pressure: (x, _z, t) => 101325 - dip * Math.exp(-(((x - 200000 - speed * t) / width) ** 2)),
            reference: 101325,
          },
        });
      go(seconds);
      let top = 0;
      for (let i = 0; i < 400; i++) top = Math.max(top, water.sample((i + 0.5) * 2000, 1000).surface);
      return top;
    },
    barometer = dip / (1000 * g);
  // Fr = 0.3, four hours on: the forced wave under the low, away from the free waves it shed.
  assert.ok(Math.abs(run(0.3, 14400) / (barometer / (1 - 0.09)) - 1) < 0.03);
  // Fr = 1: the forced wave grows with the distance the low has run (Williams et al. 2020, eq. 3). Linear long waves
  // forced by P = -B f(x - c t) from rest: eta = (c t / 2) B f'(xi) + (B / 4) f(xi) - (B / 4) f(x + c t), the last a free
  // trough running away, so the forced crest is the largest of (c t / 2) B f' + (B / 4) f over xi = x - c t.
  const resonant = (seconds) => {
    let top = 0;
    for (let xi = -5 * width; xi <= 5 * width; xi += 10) {
      const f = Math.exp(-((xi / width) ** 2));
      top = Math.max(top, ((c * seconds) / 2) * barometer * ((-2 * xi) / width ** 2) * f + (barometer / 4) * f);
    }
    return top;
  };
  for (const seconds of [3000, 6000]) {
    const top = run(1, seconds);
    assert.ok(Math.abs(top / resonant(seconds) - 1) < 0.01, `${top} against ${resonant(seconds)} at ${seconds} s`);
  }
});

test("a tide at a channel's mouth grows to 1 / cos(kL) at its closed head (the quarter-wave co-oscillating tide)", () => {
  const h = 20,
    L = 100000,
    omega = (2 * Math.PI) / TIDAL_CONSTITUENTS.M2,
    k = omega / Math.sqrt(g * h),
    bed = ground(100, 1, L, 1000, () => -h),
    level = tidalLevel([{ amplitude: 0.5, speed: 'M2' }], { ramp: 12 * 3600 }),
    { water, until } = sea({
      water: { bed, level: 0, roughness: 0, sides: { minX: { level } } },
      scale: 600,
    });
  // The co-oscillating tide is the M2 part of the head's level, by harmonic analysis over eight periods once the ramp is done:
  // a frictionless channel keeps the free quarter-wave seiche its start rang, and the shallow channel's overtides skew
  // crest against trough, so neither the highest nor the lowest water is the tide. The held level stands at the outer
  // ghost cell's centre, half a cell outside the mouth (+1.5 percent here).
  let cosine = 0,
    sine = 0,
    count = 0;
  for (let s = 4 * TIDAL_CONSTITUENTS.M2; s < 12 * TIDAL_CONSTITUENTS.M2; s += 60) {
    const t = until(s),
      level = water.sample(L - 500, 500).surface;
    cosine += level * Math.cos(omega * t);
    sine += level * Math.sin(omega * t);
    count++;
  }
  const m2 = (2 * Math.hypot(cosine, sine)) / count,
    want = 0.5 / Math.cos(k * (L - 500));
  assert.ok(Math.abs(m2 / want - 1) < 0.03, `${m2} against ${want}`);
  assert.throws(() => tidalLevel([{ amplitude: 1, speed: 'Z9' }]), /constituent/);
});

test("the world's Sun and Moon tilt a small deep sea by the equilibrium tide, 0.693 of the potential's", () => {
  // A 400 km square sea 4 km deep on the equator: its own period, 2L / sqrt(g h) = 2,000 s, is far below the tide's.
  const L = 400000,
    bed = ground(20, 20, L, L, () => -4000),
    { water, surge, until } = sea({
      water: { bed, level: 0, roughness: 0.01 },
      surge: { site: { latitude: 0, longitude: 0 }, ramp: 3 * 3600 },
      tide: true,
      celestial: {},
      scale: 1200,
    });
  let worst = 0,
    largest = 0;
  for (let hour = 9; hour <= 15; hour++) {
    until(hour * 3600);
    const a = water.sample(10000, 10000).surface - water.sample(390000, 390000).surface,
      b = -surge.potentialAt(10000, 10000) + surge.potentialAt(390000, 390000);
    worst = Math.max(worst, Math.abs(a - b));
    largest = Math.max(largest, Math.abs(b));
  }
  assert.ok(largest > 0.005, `the tilt ${largest} m`);
  assert.ok(worst < 0.05 * largest, `${worst} of ${largest}`);
});

test('Lake Superior, 10 November 1975: a 50-knot westerly piles the lake up at its eastern end, then it rings at about 8 hours', () => {
  // The lake as a flat-bottomed box 563 km by 160 km and 147 m deep at 47.5 N, the low of 982 hPa crossing it with the wind.
  const L = 563000,
    W = 160000,
    h = 147,
    bed = ground(56, 16, L, W, () => -h),
    knots = 0.514444,
    wind = (t) => (t < 10 * 3600 ? 50 * knots * Math.tanh(t / 7200) : 0),
    { water, until } = sea({
      water: {
        bed,
        level: 0,
        roughness: 0.025,
        coriolis: { latitude: (47.5 * Math.PI) / 180 },
        wind: windOf((_x, _z, t) => [wind(t), 0], 3600),
      },
      surge: {
        pressure: (x, z, t) => {
          const cx = -100000 + 25 * t,
            r2 = ((x - cx) ** 2 + (z - W / 2) ** 2) / 300000 ** 2;
          return 101325 - 3125 * Math.exp(-r2);
        },
      },
      scale: 3600,
    }),
    east = () => water.sample(L - 5000, W / 2).surface,
    west = () => water.sample(5000, W / 2).surface;
  until(10 * 3600);
  const tilt = east() - west(),
    speed = 50 * knots,
    tau = 1.2 * Math.min((0.75 + 0.067 * speed) * 1e-3, 2.5e-3) * speed * speed,
    steady = (tau * L) / (1000 * g * h);
  // Order 0.8 m end to end on a flat lake (the closed form 0.78 m); the low's own pressure adds a few centimetres.
  assert.ok(tilt > 0.6 * steady && tilt < 1.4 * steady, `tilt ${tilt} against ${steady}`);
  // The wind drops: the lake rings at Merian's period, 8.2 h for the flat lake (7.9 h with its real bed).
  const times = [];
  let last = east(),
    before = 10 * 3600;
  for (let s = 10 * 3600 + 60; s <= 40 * 3600; s += 60) {
    const reached = until(s),
      now = east();
    if (last > 0 && now <= 0) times.push(reached - ((reached - before) * now) / (now - last));
    last = now;
    before = reached;
  }
  const period = (times.at(-1) - times[0]) / (times.length - 1);
  assert.ok(Math.abs(period / ((2 * L) / Math.sqrt(g * h)) - 1) < 0.05, `${period / 3600} h`);
});

test('a surge and a tide refuse what they cannot be made from, naming the fix', () => {
  const bed = ground(4, 1, 400, 100, () => -5);
  assert.throws(() => sea({ water: { bed, level: 0 }, surge: { water: undefined } }), /pass \{water\}/);
  assert.throws(() => sea({ water: { bed, level: 0 }, surge: { pressure: 3 } }), /function of \(x, z, time\)/);
  assert.throws(() => sea({ water: { bed, level: 0 }, surge: { reference: -1 } }), /reference pressure/);
  assert.throws(() => sea({ water: { bed, level: 0 }, surge: {}, tide: true, celestial: {} }), /site/);
  assert.throws(() => sea({ water: { bed, level: 0, coriolis: { latitude: 3 } } }), /latitude/);
  assert.throws(() => sea({ water: { bed, level: 0, timeScale: 0 } }), /time scale/);
  assert.throws(() => tidalLevel([]), /at least one/);
});
