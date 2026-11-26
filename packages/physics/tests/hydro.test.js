// Rivers, floods and dam breaks (HYDRO-01): a lake at rest stays at rest over any bed, water is accounted for to rounding,
// a dam breaks as Ritter's and Stoker's solutions say, a river on a slope runs at Manning's normal depth, a wave runs up a
// beach and leaves it dry again, the world's terrain bed is the ground it runs on, and the same flood gives the same bits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface, TerrainBed } from '../dist/earth.js';
import { ShallowWaterSolver } from '../dist/hydro.js';
import { PhysicsWorld } from '../dist/world.js';

const g = -new PhysicsWorld().gravity[1];

/** A bed of `columns` by `rows` cells over `width` by `depth` m with its corner at the origin, elevations from f(x, z). */
function ground(columns, rows, width, depth, f) {
  const shape = { columns, rows, width, depth, centre: [width / 2, depth / 2] },
    elevations = new Float64Array((columns + 1) * (rows + 1));
  for (let c = 0; c <= columns; c++)
    for (let r = 0; r <= rows; r++) elevations[r + (rows + 1) * c] = f((width * c) / columns, (depth * r) / rows);
  return { shape, bed: bedSurface(shape, elevations), elevations };
}

/** A world of one shallow water at `rate` ticks a second over `params`. */
function flood(params, rate = 60) {
  const water = new ShallowWaterSolver(),
    world = new PhysicsWorld({ rate: { num: rate, den: 1 } }).add(water, params);
  return { water, world, run: (seconds) => world.advance(world.tick / 128 + seconds * rate) };
}

/** Each cell's depth along x (row 0) and its discharge. */
function profile(water, nx, dx) {
  const out = [];
  for (let i = 0; i < nx; i++) {
    const s = water.sample((i + 0.5) * dx, 0.5);
    out.push({ x: (i + 0.5) * dx, h: s.depth, u: s.velocity[0] });
  }
  return out;
}

test('a lake at rest over bumps, steps and a dry island stays at rest to rounding (well-balanced)', () => {
  const { bed } = ground(
      40,
      30,
      40,
      30,
      (x, z) =>
        Math.max(0, 1.5 - 0.02 * ((x - 20) ** 2 + (z - 15) ** 2)) +
        0.3 * Math.sin(x) * Math.cos(z) +
        (x > 30 ? 0.4 : 0),
    ),
    { water, run } = flood({ bed, level: 1, roughness: 0.03 });
  const before = water.volume();
  run(20);
  let fastest = 0;
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 30; j++) {
      const s = water.sample(i + 0.5, j + 0.5);
      fastest = Math.max(fastest, Math.hypot(...s.velocity));
      if (s.depth > 0) assert.ok(Math.abs(s.surface - 1) < 1e-12, `surface ${s.surface} at ${i}, ${j}`);
    }
  assert.ok(fastest < 1e-12, `the water moves at ${fastest} m/s`);
  assert.equal(water.volume(), before);
});

test("a dam breaks onto a dry bed as Ritter's solution says: 4/9 of its depth at the dam, flowing at 2/3 sqrt(g h0)", () => {
  const h0 = 1,
    x0 = 50,
    T = 6,
    nx = 400,
    dx = 100 / nx,
    c = Math.sqrt(g * h0),
    { bed } = ground(nx, 1, 100, dx, () => 0),
    { water, run } = flood({ bed, depth: (x) => (x < x0 ? h0 : 0), roughness: 0 }, 120);
  run(T);
  const cells = profile(water, nx, dx),
    at = cells[nx / 2 - 1],
    next = cells[nx / 2];
  assert.ok(Math.abs((at.h + next.h) / 2 / ((4 / 9) * h0) - 1) < 0.03, `depth at the dam ${(at.h + next.h) / 2}`);
  assert.ok(Math.abs((at.u + next.u) / 2 / ((2 / 3) * c) - 1) < 0.03, `speed at the dam ${(at.u + next.u) / 2}`);
  // The front cannot outrun 2 sqrt(g h0) t, and the dry tip lags it by under 15 percent at this resolution.
  let front = 0;
  for (const cell of cells) if (cell.h > 1e-4) front = cell.x;
  assert.ok(front <= x0 + 2 * c * T && front - x0 > 0.85 * 2 * c * T, `front at ${front}`);
});

test("a dam breaks onto still water as Stoker's solution says: the middle depth and the bore's speed within 2 percent", () => {
  const hl = 1,
    hr = 0.1,
    x0 = 50,
    T = 5,
    nx = 500,
    dx = 100 / nx,
    { bed } = ground(nx, 1, 100, dx, () => 0),
    { water, run } = flood({ bed, depth: (x) => (x < x0 ? hl : hr), roughness: 0 }, 120);
  run(T);
  // Stoker: the middle state h_m, u_m joins the rarefaction (u_m = 2 (sqrt(g hl) - sqrt(g hm))) to the bore (mass and
  // momentum across it, speed s = hm um / (hm - hr)); solved by bisection on hm.
  let lo = hr,
    hi = hl;
  for (let i = 0; i < 200; i++) {
    const hm = (lo + hi) / 2,
      um = 2 * (Math.sqrt(g * hl) - Math.sqrt(g * hm)),
      // Momentum across the bore in its own frame: hm (um - s)^2 + g hm^2 / 2 = hr s^2 + g hr^2 / 2 with s from mass.
      s = (hm * um) / (hm - hr),
      residual = hm * (um - s) ** 2 + 0.5 * g * hm * hm - (hr * s * s + 0.5 * g * hr * hr);
    if (residual > 0) hi = hm;
    else lo = hm;
  }
  const hm = (lo + hi) / 2,
    um = 2 * (Math.sqrt(g * hl) - Math.sqrt(g * hm)),
    s = (hm * um) / (hm - hr),
    cells = profile(water, nx, dx),
    // The middle state between the rarefaction's foot (x0 + (um - sqrt(g hm)) T) and the bore (x0 + s T).
    middle = cells.find((cell) => cell.x > x0 + (um - Math.sqrt(g * hm)) * T + 2 && cell.x < x0 + s * T - 2);
  assert.ok(Math.abs(middle.h / hm - 1) < 0.02, `middle depth ${middle.h} against ${hm}`);
  let shock = 0;
  for (const cell of cells) if (cell.h > (hm + hr) / 2) shock = cell.x;
  assert.ok(Math.abs((shock - x0) / (s * T) - 1) < 0.02, `bore at ${shock} against ${x0 + s * T}`);
});

test("a river on a slope runs at Manning's normal depth (Chow 1959), out through an open side: within 1 percent", () => {
  const S = 0.001,
    n = 0.03,
    width = 5,
    discharge = 10,
    nx = 200,
    length = 2000,
    dx = length / nx,
    q = discharge / width,
    normal = ((q * n) / Math.sqrt(S)) ** 0.6,
    { bed } = ground(nx, 1, length, width, (x) => -S * x),
    { water, run } = flood({
      bed,
      depth: normal,
      velocity: () => [q / normal, 0],
      roughness: n,
      inflows: [{ position: [dx / 2, width / 2], discharge }],
      sides: { maxX: 'open' },
    });
  run(1800);
  // Measured: 0.1 percent everywhere, the outlet too (an open side carries the bed's slope on, so the river is not held back).
  for (const x of [length / 2, length - dx]) {
    const at = water.sample(x, width / 2);
    assert.ok(Math.abs(at.depth / normal - 1) < 0.01, `depth ${at.depth} against ${normal} at ${x} m`);
    assert.ok(Math.abs((at.depth * at.velocity[0]) / q - 1) < 0.01, `discharge ${at.depth * at.velocity[0]} at ${x} m`);
  }
});

test("water sloshing in a round bowl wets and dries its shore as Thacker's exact solution says (SWASHES 4.2.2): 3 periods", () => {
  // A planar surface tilting round a paraboloid: z = -h0 (1 - r^2 / a^2), the water's centre orbiting at radius eta.
  const a = 1,
    h0 = 0.1,
    eta = 0.5,
    L = 4,
    N = 80,
    d = L / N,
    omega = Math.sqrt(2 * g * h0) / a,
    period = (2 * Math.PI) / omega,
    z = (x, y) => -h0 * (1 - ((x - L / 2) ** 2 + (y - L / 2) ** 2) / (a * a)),
    exact = (x, y, t) =>
      Math.max(
        0,
        ((eta * h0) / (a * a)) * (2 * (x - L / 2) * Math.cos(omega * t) + 2 * (y - L / 2) * Math.sin(omega * t) - eta) -
          z(x, y),
      ),
    { bed } = ground(N, N, L, L, z),
    { water, world } = flood({ bed, depth: (x, y) => exact(x, y, 0), velocity: () => [0, eta * omega], roughness: 0 });
  world.advance(Math.round(3 * period * 60));
  const t = world.tick / 128 / 60;
  let cx = 0,
    cy = 0,
    mass = 0,
    ex = 0,
    ey = 0,
    exactMass = 0,
    error = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const x = (i + 0.5) * d,
        y = (j + 0.5) * d,
        h = water.sample(x, y).depth,
        e = exact(x, y, t);
      assert.ok(h >= 0, 'no depth below 0');
      cx += h * x;
      cy += h * y;
      mass += h;
      ex += e * x;
      ey += e * y;
      exactMass += e;
      error += Math.abs(h - e);
    }
  // Measured: the orbit keeps 96.5 percent of its radius, its phase within 0.05 rad, and the depth's L1 error is 5 percent
  // of the volume.
  const radius = Math.hypot(cx / mass - L / 2, cy / mass - L / 2),
    phase =
      Math.atan2(cy / mass - L / 2, cx / mass - L / 2) - Math.atan2(ey / exactMass - L / 2, ex / exactMass - L / 2);
  assert.ok(radius > 0.95 * eta && radius < 1.01 * eta, `orbit radius ${radius} against ${eta}`);
  assert.ok(Math.abs(phase) < 0.06, `phase ${phase}`);
  assert.ok(error / exactMass < 0.06, `L1 ${error / exactMass}`);
});

test('a dam breaks into a town: no water enters a building, it piles up against the first row, and none is lost', () => {
  // Three rows of blocks downstream of a dam (in the spirit of Soares-Frazao and Zech 2008): the flood goes round them.
  const buildings = [];
  for (const x of [40, 52, 64])
    for (const z of [4, 16, 28]) buildings.push({ min: [x, z], max: [x + 6, z + 6], height: 5 });
  const { bed } = ground(50, 20, 100, 40, () => 0),
    { water, run } = flood({ bed, depth: (x) => (x < 25 ? 2 : 0), buildings, roughness: 0.01 }, 120);
  const start = water.volume();
  run(12);
  for (const b of buildings)
    for (const [x, z] of [
      [b.min[0] + 1, b.min[1] + 1],
      [b.max[0] - 1, b.max[1] - 1],
    ])
      assert.equal(water.sample(x, z).depth, 0, `inside the building at ${x}, ${z}`);
  // In front of the first row's middle block against the open street beside it.
  const front = water.sample(39, 19).depth,
    street = water.sample(39, 13).depth;
  assert.ok(front > street, `piled ${front} m in front, ${street} m in the street`);
  assert.ok(water.sample(80, 20).depth > 0, 'the flood came through the streets');
  assert.ok(Math.abs(water.volume() - start) < 1e-12 * start, `${water.volume()} against ${start}`);
});

test('every cubic metre is accounted for: start + inflow + rain - out, to rounding', () => {
  const { bed } = ground(30, 20, 300, 200, (x, z) => 0.002 * (300 - x) + 0.3 * Math.sin(z / 30)),
    rain = {
      cell: [0, 0, 0],
      sample: (_x, _y, _z, _t, out) => ({ ...out, rain: { rate: 50 } }),
    },
    { water, run } = flood({
      bed,
      depth: (x) => (x < 60 ? 0.8 : 0),
      inflows: [{ position: [10, 100], discharge: (t) => 3 + Math.sin(t) }],
      rain,
      sides: { maxX: 'open', minZ: { level: 0.2 } },
    });
  const start = water.volume();
  run(120);
  const { inflow, rain: fell, out } = water.budget;
  assert.ok(inflow > 300 && fell > 0 && out !== 0, `in ${inflow}, rain ${fell}, out ${out}`);
  const expected = start + inflow + fell - out;
  assert.ok(Math.abs(water.volume() - expected) < 1e-9 * expected, `${water.volume()} against ${expected}`);
});

test("the world's terrain bed is the ground it runs on: the same flood as on a bed of its own, bit for bit", () => {
  const f = (x, z) => 0.01 * x + 0.2 * Math.cos(z / 5),
    { shape, elevations } = ground(24, 12, 48, 24, f),
    // The terrain publishes its elevations rounded once to f32: the same numbers in a bed of the water's own.
    alone = flood({ bed: bedSurface(shape, Float32Array.from(elevations)), depth: (x) => (x < 12 ? 1 : 0) }),
    terrain = new TerrainBed(),
    water = new ShallowWaterSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(terrain, { ...shape, elevations });
  world.add(water, { bed: terrain.bed, depth: (x) => (x < 12 ? 1 : 0) });
  alone.run(10);
  world.advance(600);
  for (let i = 0; i < 24; i++)
    for (let j = 0; j < 12; j++)
      assert.deepEqual(water.sample(2 * i + 1, 2 * j + 1), alone.water.sample(2 * i + 1, 2 * j + 1), `cell ${i}, ${j}`);
  assert.ok(alone.water.sample(30, 12).depth > 0, 'the water ran up the slope');
});

test('the same flood gives the same bits', () => {
  const make = () =>
      flood({
        bed: ground(20, 20, 40, 40, (x, z) => 0.05 * Math.hypot(x - 20, z - 20)).bed,
        depth: (x, z) => (Math.hypot(x - 10, z - 10) < 5 ? 2 : 0),
        inflows: [{ position: [35, 35], discharge: 1.5 }],
      }),
    a = make(),
    b = make();
  a.run(5);
  b.run(5);
  assert.equal(a.world.hash(), b.world.hash());
});

test('an open sea side lets a long wave leave; a set level reflects it', () => {
  // A hump of water 0.2 m high on 5 m of still water runs out over the minX side.
  const reflected = (side) => {
    const nx = 200,
      dx = 2,
      { bed } = ground(nx, 1, nx * dx, dx, () => -5),
      { water, run } = flood(
        {
          bed,
          level: (x) => 0.2 * Math.exp(-(((x - 200) / 20) ** 2)),
          roughness: 0,
          sides: { minX: side, maxX: { sea: 0 } },
        },
        60,
      );
    // Long enough to reach the side and come back to the middle: c = sqrt(g h) = 7 m/s, 200 m out and 100 back.
    run(43);
    let highest = 0;
    for (let i = 0; i < 100; i++) highest = Math.max(highest, Math.abs(water.sample(i * dx + 1, 1).surface));
    return highest;
  };
  const sea = reflected({ sea: 0 }),
    level = reflected({ level: 0 });
  // Each half of the hump is 0.1 m high: a level side sends it back whole (inverted), the sea side a few millimetres.
  assert.ok(level > 0.07, `a set level reflects ${level} m`);
  assert.ok(sea < 0.15 * level, `the open sea reflects ${sea} m`);
});

test('a periodic channel keeps its water exactly while a current runs round it', () => {
  // A wind-free, frictionless flow round a periodic box: the volume does not change, and nothing piles at the ends.
  const { bed } = ground(
      40,
      8,
      80,
      16,
      (x, z) => -2 + 0.3 * Math.sin((2 * Math.PI * x) / 80) * Math.cos((2 * Math.PI * z) / 16),
    ),
    { water, run } = flood({
      bed,
      level: 0,
      velocity: () => [0.8, 0.3],
      roughness: 0,
      sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
    });
  const start = water.volume();
  run(60);
  assert.ok(Math.abs(water.volume() / start - 1) < 1e-12, `${water.volume()} against ${start}`);
  assert.equal(water.budget.out, 0);
  assert.ok(Math.abs(water.sample(79, 8).velocity[0]) > 0.3, 'the current still runs at the far end');
});

test("a storm wind's drag levels off at Donelan's 2.5e-3: 40 m/s drives the water at rho_a 2.5e-3 U^2 / rho, not Garratt's 3.4e-3", () => {
  // A periodic channel of still water 10 m deep, no friction: the wind's stress is all the water feels.
  const { bed } = ground(8, 1, 80, 10, () => -10),
    wind = (speed) => ({
      medium: 'air',
      cell: [0, 0, 0],
      sample: (_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
        out.velocity[0] = speed;
        out.velocity[1] = out.velocity[2] = 0;
        out.density = 1.2;
        out.temperature = 288.15;
        return out;
      },
    }),
    run = (speed, extra = {}) => {
      const { water, run: go } = flood({
        bed,
        level: 0,
        roughness: 0,
        sides: { minX: 'periodic', maxX: 'periodic' },
        wind: wind(speed),
        ...extra,
      });
      go(1);
      return water.sample(40, 5).velocity[0] * 10;
    };
  // Momentum per area after 1 s: rho_a C_D U^2 / rho_w.
  assert.ok(Math.abs(run(40) / ((1.2 * 2.5e-3 * 1600) / 1000) - 1) < 1e-9, `${run(40)}`);
  // Below 26 m/s Garratt's law holds as it was: 15 m/s gives (0.75 + 0.067 * 15) 1e-3.
  assert.ok(Math.abs(run(15) / ((1.2 * (0.75 + 0.067 * 15) * 1e-3 * 225) / 1000) - 1) < 1e-9);
  // Powell et al.'s 2.6e-3, asked for.
  assert.ok(Math.abs(run(40, { windDragLimit: 2.6e-3 }) / ((1.2 * 2.6e-3 * 1600) / 1000) - 1) < 1e-9);
  assert.throws(() => run(40, { windDragLimit: 0 }), /drag coefficient limit/);
});

test('settings out of range are refused with what to pass', () => {
  const { bed } = ground(4, 4, 4, 4, () => 0),
    add = (params) => new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new ShallowWaterSolver(), params);
  assert.throws(() => add({}), /bed/);
  assert.throws(() => add({ bed, courant: 0.8 }), /0\.5/);
  assert.throws(() => add({ bed, roughness: -1 }), /Manning/);
  assert.throws(() => add({ bed, inflows: [{ position: [40, 0], discharge: 1 }] }), /off the water/);
  assert.throws(() => add({ bed, sides: { minX: 'sea' } }), /'wall', 'open'/);
  assert.throws(() => add({ bed, sides: { minX: 'periodic' } }), /periodic together/);
  assert.throws(() => add({ bed, buildings: [{ min: [1, 1], max: [0, 2], height: 3 }] }), /min below max/);
  assert.throws(() => add({ bed, buildings: [{ min: [0, 0], max: [1, 1], height: 0 }] }), /height/);
});
