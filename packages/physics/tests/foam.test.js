// Whitecaps, foam and spray (SEA-13): the sea's own breakers give the whitecap coverage the observations do; drawn as
// events they cover the sea on average as Leckler et al.'s law says, active and residual in Reul and Chapron's shares; the
// foam fades at its bubbles' lifetime, drifts with the surface, is stretched by shear and gathered into windrows; a ship
// leaves a trail of it; the spray follows Gong's flux by the whitecap method; the same sea gives the same bits.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bagBreakups,
  breakingStatistics,
  FoamSolver,
  SALT_FOAM_DECAY,
  sprayFlux,
  sprayPerWhitecap,
} from '../dist/foam.js';
import { WaveSolver } from '../dist/waves.js';
import { PhysicsWorld } from '../dist/world.js';

const g = -new PhysicsWorld().gravity[1];

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

/** The developed sea of a steady wind of U m/s after `hours`, as ST4 grows it: its spectrum, as a field that is the same everywhere. */
const seas = new Map();
function developed(U, hours = 48) {
  const key = `${U}:${hours}`;
  if (!seas.has(key)) {
    const waves = new WaveSolver();
    new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(waves, {
      cells: [1, 1],
      cellSize: 1e7,
      wind: steady(U),
      periodic: ['x', 'z'],
      warmUp: hours * 3600,
      frequencies: { min: 0.03, max: 1, count: 34 },
    });
    const spectrum = waves.field.sample(0, 0);
    seas.set(key, {
      cell: [0, 0, 0],
      sample(_x, _z, out) {
        const s = out ?? { ...spectrum, energy: new Float64Array(spectrum.energy.length) };
        s.energy.set(spectrum.energy);
        s.depth = spectrum.depth;
        s.density = spectrum.density;
        return s;
      },
    });
  }
  return seas.get(key);
}

/** A world of one foam solver over `params`. */
function foam(params) {
  const solver = new FoamSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, params);
  return { solver, world, run: (seconds) => world.advance(world.tick / 128 + seconds * 60) };
}

test("the sea's own breakers give the whitecap coverage Monahan and Woolf measured, within a factor of 1.5", () => {
  // Leckler et al. (2013) tuned kappa = 0.30 against Monahan and Woolf (1989), W = 1.95e-5 U10^2.55. Measured on ST4's
  // developed seas: 1.41, 0.98 and 0.74 of it at 7, 10 and 13 m/s, flatter with the wind, as satellites see above 15 m/s.
  let last = 0;
  for (const U of [7, 10, 13]) {
    const s = breakingStatistics(developed(U).sample(0, 0), g),
      measured = 1.95e-5 * U ** 2.55;
    assert.ok(
      s.coverage > measured / 1.5 && s.coverage < measured * 1.5,
      `${U} m/s: W ${s.coverage} against ${measured}`,
    );
    assert.ok(s.coverage > last, 'more whitecaps in a stronger wind');
    assert.ok(Math.abs(s.active / s.coverage - 0.16) < 1e-12, 'the active share is 0.8 / 5');
    last = s.coverage;
  }
});

test('the surface Stokes drift of a narrow swell is sigma k a^2', () => {
  // One bin of a deep-water swell of amplitude a: u_s = sigma k a^2 along its direction.
  const frequencies = new Float64Array([0.08, 0.1, 0.125]),
    directions = new Float64Array([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]),
    energy = new Float64Array(12),
    a = 0.5,
    // The middle bin's width on this grid, from the midpoints to its neighbours.
    width = 0.1125 - 0.09,
    dtheta = Math.PI / 2;
  energy[1 * 4 + 1] = (a * a) / 2 / (width * dtheta);
  const s = breakingStatistics({ frequencies, directions, energy, depth: Infinity, density: 1025 }, g),
    sigma = 2 * Math.PI * 0.1,
    k = (sigma * sigma) / g;
  assert.ok(Math.abs(s.stokes[1] / (sigma * k * a * a) - 1) < 1e-9, `${s.stokes[1]} against ${sigma * k * a * a}`);
  assert.ok(Math.abs(s.stokes[0]) < 1e-12);
  assert.equal(s.coverage, 0, 'a gentle swell does not break');
});

test("breakers drawn as events cover the sea on average as Leckler et al.'s law says, active and residual in Reul and Chapron's shares", () => {
  const sea = developed(10),
    { solver, run } = foam({ waves: sea, cells: [96, 96], cellSize: 2, windrows: false });
  run(30);
  let total = 0,
    active = 0,
    samples = 0;
  for (let s = 0; s < 60; s++) {
    run(1);
    total += solver.meanCoverage();
    let a = 0;
    for (let i = 0; i < 96; i++) for (let j = 0; j < 96; j++) a += solver.activeCoverage(-95 + 2 * i, -95 + 2 * j);
    active += a / (96 * 96);
    samples++;
  }
  const expected = solver.expectedCoverage(0, 0);
  // Measured: 1.03 of W, 0.167 of it active (the last step of a breaker's life rounds up).
  assert.ok(Math.abs(total / samples / expected - 1) < 0.1, `mean ${total / samples} against ${expected}`);
  assert.ok(
    Math.abs(active / samples / expected / 0.16 - 1) < 0.15,
    `active ${active / samples} against ${0.16 * expected}`,
  );
  assert.ok(solver.breakerCount > 100, `${solver.breakerCount} breakers alive`);
});

test('residual foam fades with its bubbles: e-folding 3.8 s in sea water, 2.5 s in fresh', () => {
  for (const [density, decay] of [
    [1025, 3.8],
    [1000, 2.5],
  ]) {
    const calm = developed(2),
      water = { cell: [0, 0, 0], sample: (x, z, out) => Object.assign(calm.sample(x, z, out), { density }) },
      { solver, run } = foam({ waves: water, cells: [20, 20], cellSize: 2, windrows: false, windDrift: 0 });
    solver.addFoam([-6, -6], [6, 6], 0.8);
    run(1 / 60);
    const start = solver.coverage(0, 0);
    run(decay);
    assert.ok(
      Math.abs(solver.coverage(0, 0) / start - Math.exp(-1)) < 0.01,
      `${density} kg/m^3: ${solver.coverage(0, 0) / start}`,
    );
  }
  assert.equal(SALT_FOAM_DECAY, 3.8);
});

test('foam drifts with the surface: the current, the Stokes drift and 0.6 percent of the wind', () => {
  const calm = developed(2),
    current = {
      medium: 'water',
      cell: [0, 0, 0],
      sample: (_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 1025, temperature: 288 }) => {
        out.velocity[0] = 0.3;
        out.velocity[1] = 0;
        out.velocity[2] = 0;
        return out;
      },
    },
    { solver, run } = foam({ waves: calm, cells: [100, 20], cellSize: 1, current, wind: steady(10), windrows: false });
  solver.addFoam([-42, -3], [-38, 3], 1, 1e6);
  run(1 / 60);
  const centroid = () => {
    let m = 0,
      x = 0;
    for (let i = 0; i < 100; i++) {
      const c = solver.coverage(-49.5 + i, 0);
      m += c;
      x += c * (-49.5 + i);
    }
    return x / m;
  };
  const before = centroid();
  run(40);
  const stokes = breakingStatistics(calm.sample(0, 0), g).stokes[0],
    expected = (0.3 + stokes + 0.006 * 10) * 40,
    moved = centroid() - before;
  assert.ok(Math.abs(moved / expected - 1) < 0.05, `moved ${moved} m against ${expected}`);
});

test('a shear current stretches a foam patch into a streak, and the foam is conserved as it is carried', () => {
  const calm = developed(2),
    shear = {
      medium: 'water',
      cell: [0, 0, 0],
      sample: (_x, _y, z, _t, out = { velocity: [0, 0, 0], density: 1025, temperature: 288 }) => {
        out.velocity[0] = 0.05 * z;
        out.velocity[1] = 0;
        out.velocity[2] = 0;
        return out;
      },
    },
    { solver, run } = foam({
      waves: calm,
      cells: [120, 40],
      cellSize: 1,
      current: shear,
      windDrift: 0,
      windrows: false,
    });
  solver.addFoam([-4, -4], [4, 4], 1, 1e6);
  run(1 / 60);
  const extent = () => {
    let lo = Infinity,
      hi = -Infinity,
      mass = 0;
    for (let i = 0; i < 120; i++)
      for (let j = 0; j < 40; j++) {
        const x = -59.5 + i,
          c = solver.coverage(x, -19.5 + j);
        mass += c;
        if (c > 0.2) {
          lo = Math.min(lo, x);
          hi = Math.max(hi, x);
        }
      }
    return { length: hi - lo, mass };
  };
  const before = extent();
  run(100);
  const after = extent();
  // Across the patch's 8 m the shear moves its edges 0.05 x 8 x 100 = 40 m apart.
  assert.ok(after.length > before.length + 30, `length ${before.length} -> ${after.length} m`);
  // Carried, it fades only as it does standing still: e^(-t / tau), tau = 1e6 s here.
  const kept = Math.exp(-(100 + 1 / 60) / 1e6) / Math.exp(-(1 / 60) / 1e6);
  assert.ok(Math.abs(after.mass / before.mass / kept - 1) < 1e-6, `foam ${before.mass} -> ${after.mass}`);
});

test('above 3 m/s Langmuir windrows gather persistent foam into lines along the wind, spacing apart', () => {
  // Whitecap foam fading in 3.8 s moves 0.3 m at the windrows' 8 cm/s before it is gone; persistent foam (a wake's, or in
  // water rich in surfactant) lines up. Spread evenly, it gathers at the convergences z = 0 and +-30 m in a few minutes.
  const calm = developed(2),
    { solver, run } = foam({ waves: calm, cells: [30, 90], cellSize: 1, wind: steady(8), windrows: { spacing: 30 } });
  solver.addFoam([-15, -45], [15, 45], 0.1, 1e6);
  run(400);
  const at = (z) => {
    let sum = 0;
    for (let i = 0; i < 30; i++) sum += solver.coverage(-14.5 + i, z);
    return sum / 30;
  };
  const lines = (at(-29.5) + at(0.5) + at(30.5)) / 3,
    between = (at(-14.5) + at(15.5)) / 2;
  assert.ok(lines > 10 * between, `in the lines ${lines}, between them ${between}`);
  assert.ok(lines > 0.2, `the lines are white: ${lines}`);
});

test("a ship leaves a trail of wake foam that widens aft, with its bow waves' arms beside it", () => {
  const calm = developed(2),
    U = 6,
    track = (t) => ({ position: [-80 + U * t, 0], velocity: [U, 0] }),
    { solver, run } = foam({
      waves: calm,
      cells: [200, 40],
      cellSize: 1,
      windDrift: 0,
      windrows: false,
      ships: [{ track, length: 30, beam: 8 }],
    });
  run(20);
  // The ship's centre is at 40 m: white at its stern, foam all along its track behind, none ahead or far to the side.
  assert.ok(solver.coverage(40 - 15 - 3, 0) > 0.9, 'white water at the stern');
  assert.ok(solver.coverage(-40, 0) > 0.4, 'the trail 80 m aft');
  assert.equal(solver.coverage(70, 0), 0, 'nothing ahead of the bow');
  assert.equal(solver.coverage(-40, 15), 0, 'nothing far to the side');
  // The dense stern wake widens as x^(1/5); the bow's arms leave a fainter V outside it.
  const width = (x, white) => {
    let w = 0;
    for (let j = 0; j < 40; j++) if (solver.coverage(x, -19.5 + j) > white) w++;
    return w;
  };
  assert.ok(width(40 - 15 - 28, 0.5) > width(40 - 15 - 4, 0.5), 'it widens aft');
  assert.ok(width(40 - 15 - 4, 0.05) > width(40 - 15 - 4, 0.5), "the bow waves' arms outside it");
});

test("spray follows Gong's flux by the whitecap method; bag breakup takes over at strong winds", () => {
  // Gong (2003) at r80 = 2 um and U10 = 10 m/s, written out: 1.373 U^3.41 r^-A (1 + 0.057 r^3.45) 10^(1.607 exp(-B^2)).
  const r = 2,
    A = 4.7 * (1 + 30 * r) ** (-0.017 * r ** -1.44),
    B = (0.433 - Math.log10(r)) / 0.433,
    gong = 1.373 * 10 ** 3.41 * r ** -A * (1 + 0.057 * r ** 3.45) * 10 ** (1.607 * Math.exp(-B * B)),
    coverage = 3.84e-6 * 10 ** 3.41;
  assert.ok(Math.abs(sprayFlux(coverage, r) / gong - 1) < 1e-9, `${sprayFlux(coverage, r)} against ${gong}`);
  assert.equal(sprayFlux(0, r), 0);
  assert.ok(sprayPerWhitecap(1) > sprayPerWhitecap(10), 'more small drops than large');
  // Troitskaya et al. (2017): few bags at u* = 0.5 m/s, many from u* = 0.9.
  assert.ok(bagBreakups(0.5) < 1e-3 * bagBreakups(1.2), `${bagBreakups(0.5)} against ${bagBreakups(1.2)}`);
  assert.ok(Math.abs(bagBreakups(2) - 3.73e3 * Math.exp(-1)) < 1e-9);
});

test('the same sea gives the same breakers and foam, bit for bit', () => {
  const sea = developed(10),
    make = () => foam({ waves: sea, cells: [32, 32], cellSize: 2, wind: steady(10) }),
    a = make(),
    b = make();
  a.run(5);
  b.run(5);
  assert.equal(a.world.hash(), b.world.hash());
});

test('settings out of range are refused with what to pass', () => {
  const sea = developed(2),
    add = (params) => new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new FoamSolver(), params);
  assert.throws(() => add({}), /needs a sea/);
  assert.throws(() => add({ waves: sea, cells: [0, 4] }), /1 to 4096/);
  assert.throws(() => add({ waves: sea, decay: 0 }), /decay/);
  assert.throws(() => add({ waves: sea, windrows: { spacing: -1 } }), /Windrows/);
  assert.throws(() => add({ waves: sea, ships: [{ length: 10, beam: 3 }] }), /body, length, beam/);
  assert.throws(() => foam({ waves: sea }).solver.addFoam([1, 1], [0, 2]), /min below max/);
});
