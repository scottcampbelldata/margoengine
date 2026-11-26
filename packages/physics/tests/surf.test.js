// Nearshore waves and the surf zone (SEA-05): waves shoal by their energy flux and refract by Snell's law; the water sets down
// before the breakers as Longuet-Higgins and Stewart's radiation stress says and sets up inside them on Bowen's slope; the
// undertow carries back what the waves and the roller bring; an oblique sea drives a longshore current held by the bed's
// friction; a channel in a bar draws a rip; wave groups make the water surge up the beach and leave the sand wet; the same
// sea gives the same bits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../dist/earth.js';
import { ShallowWaterSolver } from '../dist/hydro.js';
import { SurfSolver } from '../dist/surf.js';
import { groupVelocity, wavenumber } from '../dist/waves.js';
import { PhysicsWorld } from '../dist/world.js';

const g = -new PhysicsWorld().gravity[1];

/** A beach: `nx` by `nz` cells of dx by dz m, the bed from f(x, z), water to 0, the sea at minX. */
function beach({
  nx,
  nz = 1,
  dx = 1,
  dz = 1,
  f,
  incident,
  periodic = false,
  groups = false,
  breaking,
  roller,
  n = 0.02,
}) {
  const shape = { columns: nx, rows: nz, width: nx * dx, depth: nz * dz, centre: [(nx * dx) / 2, (nz * dz) / 2] },
    elevations = new Float64Array((nx + 1) * (nz + 1));
  for (let c = 0; c <= nx; c++) for (let r = 0; r <= nz; r++) elevations[r + (nz + 1) * c] = f(c * dx, r * dz);
  const water = new ShallowWaterSolver(),
    surf = new SurfSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(water, {
        bed: bedSurface(shape, elevations),
        level: 0,
        roughness: n,
        sides: { minX: { sea: 0 }, ...(periodic ? { minZ: 'periodic', maxZ: 'periodic' } : {}) },
      })
      .add(surf, { water, incident, groups, breaking, roller, alongshore: periodic ? 'periodic' : 'open' })
      .couple(['surf', 'water'], 'staggered');
  return { water, surf, world, run: (seconds) => world.advance(world.tick / 128 + seconds * 60) };
}

const plane = (h0, slope) => (x) => -h0 + slope * x;

test('waves shoal as their energy flux is kept, H / H0 = sqrt(c_g0 / c_g), until they break', () => {
  const { surf, run } = beach({
    nx: 160,
    f: plane(2, 0.02),
    incident: { height: 0.5, period: 8 },
    breaking: { gamma: 2 },
  });
  run(120);
  const period = 1 / surf.meanFrequency,
    h = (x) => 2 - 0.02 * x,
    H0 = surf.waveHeight(0.5, 0.5);
  for (const x of [25, 50, 70]) {
    const expected = H0 * Math.sqrt(groupVelocity(1 / period, h(0.5), g) / groupVelocity(1 / period, h(x + 0.5), g));
    assert.ok(
      Math.abs(surf.waveHeight(x + 0.5, 0.5) / expected - 1) < 0.02,
      `x ${x}: ${surf.waveHeight(x + 0.5, 0.5)} against ${expected}`,
    );
  }
});

test("waves turn toward the shore as Snell's law says: sin(theta) / c stays the same", () => {
  const { surf, run } = beach({
    nx: 100,
    nz: 2,
    dz: 4,
    f: plane(2, 0.015),
    incident: { height: 0.2, period: 8, direction: (30 * Math.PI) / 180, spreading: 200 },
    periodic: true,
  });
  run(80);
  const period = 1 / surf.meanFrequency,
    c = (x) => (2 * Math.PI) / period / wavenumber(1 / period, 2 - 0.015 * x, g),
    theta0 = surf.waveDirection(2.5, 2);
  for (const x of [40, 80]) {
    const snell = Math.asin((Math.sin(theta0) * c(x + 0.5)) / c(2.5));
    assert.ok(
      Math.abs(surf.waveDirection(x + 0.5, 2) - snell) < (1.5 * Math.PI) / 180,
      `x ${x}: ${surf.waveDirection(x + 0.5, 2)} against ${snell}`,
    );
  }
});

test("the water sets down before the breakers (Longuet-Higgins and Stewart) and up inside them on Bowen's slope", () => {
  const slope = 0.02,
    { water, surf, run } = beach({ nx: 160, f: plane(2, slope), incident: { height: 0.5, period: 8 } });
  run(240);
  const period = 1 / surf.meanFrequency,
    setDown = (x) => {
      const s = water.sample(x, 0.5),
        H = surf.waveHeight(x, 0.5),
        k = wavenumber(1 / period, s.depth, g);
      return -(k * H * H) / (8 * Math.sinh(2 * k * s.depth));
    };
  // Between two points outside the breakers: eta changes as -(1/8) k H^2 / sinh(2 k h) does (measured within 4 percent).
  const measured = water.sample(50.5, 0.5).surface - water.sample(20.5, 0.5).surface,
    theory = setDown(50.5) - setDown(20.5);
  assert.ok(Math.abs(measured / theory - 1) < 0.1, `set-down ${measured} against ${theory}`);
  // Inside: d eta / dx = K tan(alpha), K = (3 gamma^2 / 8) / (1 + 3 gamma^2 / 8), gamma = H / h there (measured 0 to 15 percent low).
  for (const [a, b] of [
    [80.5, 90.5],
    [85.5, 95.5],
  ]) {
    const sa = water.sample(a, 0.5),
      sb = water.sample(b, 0.5),
      gamma = (surf.waveHeight(a, 0.5) / sa.depth + surf.waveHeight(b, 0.5) / sb.depth) / 2,
      K = (3 * gamma * gamma) / 8 / (1 + (3 * gamma * gamma) / 8),
      ratio = (sb.surface - sa.surface) / (b - a) / slope;
    assert.ok(ratio > 0.8 * K && ratio < 1.1 * K, `${a} to ${b}: slope ratio ${ratio} against K ${K}`);
  }
});

test('the undertow carries back what the waves and the roller bring: -(E_w + 2 E_r) / (rho h c) where the water stands', () => {
  const { water, surf, run } = beach({ nx: 160, f: plane(2, 0.02), incident: { height: 0.5, period: 8 } });
  run(240);
  for (const x of [80.5, 90.5]) {
    const [stokes] = surf.stokesDrift(x, 0.5),
      [under] = surf.undertow(x, 0.5);
    assert.ok(Math.abs(water.sample(x, 0.5).velocity[0]) < 1e-3, 'no net flow on a closed beach');
    assert.ok(stokes > 0.05 && Math.abs(under / -stokes - 1) < 0.01, `x ${x}: undertow ${under} against ${-stokes}`);
  }
  assert.ok(surf.rollerEnergy(90.5, 0.5) > 0, 'the roller carries broken water');
});

test("an oblique sea drives a longshore current that the bed's friction holds: the balance F_y = g n^2 |u| V / h^(1/3), cell by cell", () => {
  const n = 0.02,
    { water, surf, run } = beach({
      nx: 120,
      nz: 2,
      dz: 4,
      f: plane(1.6, 0.02),
      incident: { height: 0.4, period: 7, direction: (20 * Math.PI) / 180 },
      periodic: true,
      n,
    });
  run(300);
  let peak = 0;
  for (const x of [55.5, 60.5, 65.5]) {
    const s = water.sample(x, 2),
      { force, stokes, orbital } = surf.forcing(x, 2),
      ue = s.velocity[0] - stokes[0];
    let lo = -5,
      hi = 5;
    for (let it = 0; it < 80; it++) {
      const V = (lo + hi) / 2;
      if ((g * n * n * Math.sqrt(ue * ue + V * V + (1.16 * orbital) ** 2) * V) / Math.cbrt(s.depth) > force[1]) hi = V;
      else lo = V;
    }
    const balance = (lo + hi) / 2;
    assert.ok(Math.abs(s.velocity[1] / balance - 1) < 0.1, `x ${x}: V ${s.velocity[1]} against ${balance}`);
    peak = Math.max(peak, s.velocity[1]);
  }
  assert.ok(peak > 0.3, `the current runs along the shore at ${peak} m/s`);
  assert.ok(Math.abs(water.sample(20.5, 2).velocity[1]) < 0.05, 'little current outside the breakers');
});

test('a channel through a bar draws a rip current seaward through it', () => {
  // A bar 1 m under water across the beach, cut by a channel 16 m wide: the waves break on the bar, set up behind it, and the
  // water returns through the channel.
  const bed = (x, z) => {
      const base = -2 + 0.025 * x,
        bar = 0.7 * Math.exp(-(((x - 40) / 6) ** 2)),
        channel = Math.abs(z - 40) < 8 ? 0 : 1;
      return base + bar * channel;
    },
    { water, run } = beach({
      nx: 40,
      nz: 10,
      dx: 2,
      dz: 8,
      f: bed,
      incident: { height: 0.6, period: 7 },
      periodic: true,
    });
  run(120);
  const inChannel = water.sample(41, 44).velocity[0],
    onBar = water.sample(41, 4).velocity[0];
  assert.ok(inChannel < -0.1, `seaward in the channel: ${inChannel} m/s`);
  assert.ok(inChannel < onBar - 0.1, `faster seaward than over the bar (${onBar} m/s)`);
});

test('wave groups make the water surge up the beach: the run-up passes the set-up, and the sand above stays wet a while', () => {
  const calm = beach({ nx: 160, f: plane(2, 0.02), incident: { height: 0.5, period: 8 } }),
    grouped = beach({ nx: 160, f: plane(2, 0.02), incident: { height: 0.5, period: 8 }, groups: true });
  calm.run(200);
  grouped.run(200);
  const shoreline = (water) => {
      let level = -Infinity;
      for (let i = 0; i < 160; i++) {
        const s = water.sample(i + 0.5, 0.5);
        if (s.depth > 0.01) level = s.surface;
      }
      return level;
    },
    setUp = shoreline(calm.water);
  assert.ok(grouped.surf.runUp() > setUp + 0.03, `run-up ${grouped.surf.runUp()} m against a set-up of ${setUp} m`);
  // The wet sand: cells above the steady shoreline that the swash reached.
  let wetAbove = 0;
  for (let i = 0; i < 160; i++) {
    const x = i + 0.5,
      bedLevel = -2 + 0.02 * x;
    if (bedLevel > setUp && grouped.surf.wetSand(x, 0.5)) wetAbove++;
  }
  assert.ok(wetAbove >= 2, `${wetAbove} m of wet sand above the steady shoreline`);
});

test('waves against a current keep their action flux (c_g + U) E / sigma and their absolute frequency', () => {
  // A channel shoaling from 4 m to 2 m carries 1 m^2/s seaward, so the current against the waves grows from 0.25 to 0.5 m/s.
  const run = (currents) => {
    const nx = 100,
      dx = 2,
      depth = (x) => 4 - 2 * Math.min(1, Math.max(0, (x - 40) / 100)),
      shape = { columns: nx, rows: 1, width: nx * dx, depth: dx, centre: [(nx * dx) / 2, dx / 2] },
      elevations = new Float64Array((nx + 1) * 2);
    for (let c = 0; c <= nx; c++) for (let r = 0; r <= 1; r++) elevations[r + 2 * c] = -depth(c * dx);
    const water = new ShallowWaterSolver(),
      surf = new SurfSolver(),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
        .add(water, {
          bed: bedSurface(shape, elevations),
          level: 0,
          velocity: (x) => [-1 / depth(x), 0],
          roughness: 0,
          sides: { minX: 'open', maxX: 'open' },
        })
        .add(surf, {
          water,
          incident: { height: 0.15, period: 4, spreading: 500 },
          groups: false,
          currents,
          breaking: { gamma: 2 },
        })
        .couple(['surf', 'water'], 'staggered');
    world.advance(100 * 60);
    return { water, surf };
  };
  const { water, surf } = run(true),
    omega = 2 * Math.PI * surf.meanFrequency,
    // The Doppler relation omega = sigma + k U solved for the intrinsic frequency and the group velocity.
    solve = (h, U) => {
      let k = (omega * omega) / g;
      for (let i = 0; i < 60; i++) {
        const s = Math.sqrt(g * k * Math.tanh(k * h)),
          cg = (s / k) * (0.5 + (k * h) / Math.sinh(2 * k * h));
        k -= (s + k * U - omega) / (cg + U);
      }
      const s = Math.sqrt(g * k * Math.tanh(k * h));
      return ((s / k) * (0.5 + (k * h) / Math.sinh(2 * k * h))) / s + U / s;
    },
    flux = (x) => {
      const st = water.sample(x, 1);
      return solve(st.depth, st.velocity[0]);
    },
    expected = surf.waveHeight(11, 1) * Math.sqrt(flux(11) / flux(151)),
    still = run(false).surf.waveHeight(151, 1);
  // Measured: to 4 figures (0.1207 m); ignoring the current gives the still-water shoaling, 0.1064 m.
  assert.ok(Math.abs(surf.waveHeight(151, 1) / expected - 1) < 0.02, `${surf.waveHeight(151, 1)} against ${expected}`);
  assert.ok(expected / still > 1.08, `the opposing current steepens them: ${expected} against ${still} without it`);
});

test("the open sea brings in the groups' bound long wave: the water sinks under each group as Longuet-Higgins and Stewart say", () => {
  const rho = 1025,
    h = 3,
    nx = 150,
    dx = 2,
    shape = { columns: nx, rows: 1, width: nx * dx, depth: dx, centre: [(nx * dx) / 2, dx / 2] },
    elevations = new Float64Array((nx + 1) * 2).fill(-h),
    surf = new SurfSolver(),
    water = new ShallowWaterSolver(),
    world = new PhysicsWorld({ rate: { num: 30, den: 1 } })
      .add(water, {
        bed: bedSurface(shape, elevations),
        level: 0,
        roughness: 0,
        sides: { minX: { sea: 0, incoming: (t, x, z) => surf.boundWave(t, x, z) }, maxX: { sea: 0 } },
      })
      .add(surf, { water, incident: { height: 0.6, period: 7, spreading: 200 }, breaking: { gamma: 2 } })
      .couple(['surf', 'water'], 'staggered');
  let frame = 60 * 30;
  world.advance(frame);
  const energy = [],
    surface = [];
  for (let s = 0; s < 600; s++) {
    frame += 15;
    world.advance(frame);
    const H = surf.waveHeight(61, 1);
    energy.push((rho * g * H * H) / 8);
    surface.push(water.sample(61, 1).surface);
  }
  const k = wavenumber(surf.meanFrequency, h, g),
    n = 0.5 + (k * h) / Math.sinh(2 * k * h),
    cg = ((2 * Math.PI * surf.meanFrequency) / k) * n,
    theory = (2 * n - 0.5) / (rho * (cg * cg - g * h)),
    me = energy.reduce((a, b) => a + b) / energy.length,
    mz = surface.reduce((a, b) => a + b) / surface.length;
  let covariance = 0,
    variance = 0,
    residual = 0,
    total = 0;
  for (let i = 0; i < energy.length; i++) {
    covariance += (energy[i] - me) * (surface[i] - mz);
    variance += (energy[i] - me) ** 2;
  }
  const slope = covariance / variance;
  for (let i = 0; i < energy.length; i++) {
    residual += (surface[i] - mz - slope * (energy[i] - me)) ** 2;
    total += (surface[i] - mz) ** 2;
  }
  // Measured: 1.08 of the theory's slope, R^2 0.86 (fed without the bound wave: 0.25 and 0.11).
  assert.ok(Math.abs(slope / theory - 1) < 0.25, `slope ${slope} against ${theory}`);
  assert.ok(1 - residual / total > 0.6, `R^2 ${1 - residual / total}`);
});

test("the run-up exceeded by 2 percent of the swash matches Stockdon et al.'s field law within 25 percent", () => {
  // R2 = 1.1 (<eta> + sqrt(S_inc^2 + S_IG^2) / 2): set-up and infragravity swash from the water, the short waves' uprush from
  // Stockdon's S_inc. Measured: 0.277 m against 0.307 on 1:50, 0.387 against 0.381 on 1:25.
  for (const slope of [0.02, 0.04]) {
    const surf = new SurfSolver(),
      nx = 160,
      shape = { columns: nx, rows: 1, width: nx, depth: 1, centre: [nx / 2, 0.5] },
      elevations = new Float64Array((nx + 1) * 2);
    for (let c = 0; c <= nx; c++) for (let r = 0; r <= 1; r++) elevations[r + 2 * c] = -2 + slope * c;
    const water = new ShallowWaterSolver(),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
        .add(water, {
          bed: bedSurface(shape, elevations),
          level: 0,
          sides: { minX: { sea: 0, incoming: (t, x, z) => surf.boundWave(t, x, z) } },
        })
        .add(surf, { water, incident: { height: 0.5, period: 8 } })
        .couple(['surf', 'water'], 'staggered');
    world.advance(600 * 60);
    const L0 = (g * 64) / (2 * Math.PI),
      root = Math.sqrt(0.5 * L0),
      stockdon = 1.1 * (0.35 * slope * root + 0.5 * Math.sqrt(0.5 * L0 * (0.563 * slope * slope + 0.004)));
    assert.ok(Math.abs(surf.runUp2() / stockdon - 1) < 0.25, `1:${1 / slope}: R2 ${surf.runUp2()} against ${stockdon}`);
  }
});

test('the same sea gives the same bits', () => {
  const make = () => beach({ nx: 40, f: plane(1, 0.04), incident: { height: 0.3, period: 6 }, groups: true }),
    a = make(),
    b = make();
  a.run(10);
  b.run(10);
  assert.equal(a.world.hash(), b.world.hash());
});

test('settings out of range are refused with what to pass', () => {
  const add = (params) => {
    const shape = { columns: 4, rows: 1, width: 4, depth: 1, centre: [2, 0.5] },
      water = new ShallowWaterSolver(),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(water, {
        bed: bedSurface(shape, new Float64Array(10).fill(-1)),
        level: 0,
      });
    return world.add(new SurfSolver(), { water, ...params });
  };
  assert.throws(() => add({ incident: { height: 0.5, period: 8 }, water: undefined }), /shallow water/);
  assert.throws(() => add({}), /waves coming in/);
  assert.throws(() => add({ incident: { height: 0, period: 8 } }), /height and a period/);
  assert.throws(() => add({ incident: { height: 1, period: 8 }, side: 'top' }), /'minX'/);
  assert.throws(() => add({ incident: { height: 1, period: 8 }, breaking: { gamma: 3 } }), /gamma/);
  assert.throws(() => add({ incident: { height: 1, period: 8 }, alongshore: 'round' }), /'open' or 'periodic'/);
  assert.throws(() => add({ incident: { height: 1, period: 8 }, level: Number.NaN }), /still water level/);
});
