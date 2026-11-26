// Tracers and slicks (SEA-15): a dye cloud spreads as the diffusion equation says and drifts with the current; grains settle
// at Ferguson and Church's speed and lie on the bed; a slick floats and drifts with the water and 3 percent of the wind; a
// breach in a moving hull leaves a red plume of iron ore along its track; mass is accounted for exactly.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as tracersEntry from '../dist/tracers.js';
import { PhysicsWorld } from '../dist/world.js';

const { settlingVelocity, TRACER_MATERIALS, TracerSolver } = tracersEntry;
const DT = 1 / 60;

/** A world with one tracer solver. */
function tracers(params) {
  const solver = new TracerSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, params);
  return { solver, world, run: (steps) => world.advance(world.tick / 128 + steps) };
}

/** A uniform flow of water. */
const current = (u, w = 0) => ({
  medium: 'water',
  cell: [0, 0, 0],
  sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 1025, temperature: 285 }) {
    out.velocity[0] = u;
    out.velocity[1] = 0;
    out.velocity[2] = w;
    return out;
  },
});

/** Mean and variance of the live particles' coordinate `axis`. */
function moments(solver, axis, state = 'water') {
  let n = 0,
    sum = 0,
    squares = 0;
  for (const p of solver.particlesOf())
    if (p.state === state) {
      n++;
      sum += p.position[axis];
      squares += p.position[axis] ** 2;
    }
  const mean = sum / n;
  return { n, mean, variance: squares / n - mean * mean };
}

/** Ten thousand particles of `material` released in the first step at `at`. */
const burst = (material, at) => ({ material, position: at, rate: 10000 / DT, start: 0, stop: DT });

test('submerged jet wall stress matches independent downstream electrochemical observations', () => {
  // Alekseenko & Markovich's H/D=2 triangles in Phares et al. (2000), Figure 10.
  // The plotted marker supplies ±8 x and ±10 y pixels on the 4x render. Propagate both through the log axes.
  const reynolds = 42600;
  const jet = { height: 0.2, diameter: 0.1, viscosity: 1e-6, density: 1000, speed: (reynolds * 1e-6) / 0.1 };
  const fromX = (x) => 10 ** (-2 + (3 * (x - 103)) / 735);
  const fromY = (y) => 10 ** (2 - (3 * (y - 36)) / 824);
  const normalizer = (Math.sqrt(reynolds) * 4) / (jet.density * jet.speed ** 2);
  assert.equal(typeof tracersEntry.submergedJetWallShear, 'function');
  const scaled = (x) => normalizer * tracersEntry.submergedJetWallShear(jet, jet.height * fromX(x));
  for (const [x, y] of [
    [649, 608],
    [663, 646],
    [676, 680],
    [698, 737],
  ]) {
    assert.ok(scaled(x + 8) <= fromY(y - 10) && scaled(x - 8) >= fromY(y + 10), `marker (${x}, ${y})`);
  }
  assert.equal(tracersEntry.submergedJetWallShear(jet, 0), 0);

  // Phares Eq. 2.33 gives the independent exact high-clearance maximum and its radial position.
  const deep = { ...jet, height: 0.8 };
  const wallStress = (r) => tracersEntry.submergedJetWallShear(deep, deep.height * r);
  const peak = (44.6 * deep.density * deep.speed ** 2) / (Math.sqrt(reynolds) * 64);
  assert.ok(Math.abs(wallStress(0.09) - peak) <= 8 * Number.EPSILON * peak);
  assert.ok(wallStress(0.05) < peak && wallStress(0.18) < peak);
});

test('a dye cloud spreads as the diffusion equation says: variance 2 K t on each axis', () => {
  const { solver, run } = tracers({
    sources: [burst('dye', [0, -15, 0])],
    horizontalDiffusivity: 0.5,
    verticalDiffusivity: 0.01,
  });
  run(600);
  const t = 600 * DT;
  for (const [axis, k] of [
    [0, 0.5],
    [2, 0.5],
    [1, 0.01],
  ]) {
    const { n, variance } = moments(solver, axis);
    assert.equal(n, 10000);
    // A sample variance of 10,000 normal values is within 6 percent (over 4 standard errors) of the true one.
    assert.ok(Math.abs(variance / (2 * k * t) - 1) < 0.06, `axis ${axis}: ${variance} against ${2 * k * t}`);
  }
});

test('the cloud drifts with the current', () => {
  const { solver, run } = tracers({
      sources: [burst('dye', [0, -10, 0])],
      water: current(0.5, -0.2),
      horizontalDiffusivity: 0.2,
    }),
    t = 300 * DT;
  run(300);
  const x = moments(solver, 0),
    z = moments(solver, 2),
    spread = Math.sqrt((2 * 0.2 * t) / 10000);
  assert.ok(Math.abs(x.mean - 0.5 * t) < 5 * spread && Math.abs(z.mean + 0.2 * t) < 5 * spread, `${x.mean}, ${z.mean}`);
});

test("grains settle at Ferguson and Church's speed: Stokes's for silt, the drag limit for gravel", () => {
  const nu = 1e-6,
    g = 9.81,
    r = (2650 - 1025) / 1025,
    fine = { density: 2650, diameter: 1e-5, colour: [0.4, 0.3, 0.2] },
    stokes = (d) => (r * g * d * d) / (18 * nu);
  // Fine silt: Stokes's speed, the turbulent term under 1 percent of the viscous one.
  assert.ok(Math.abs(settlingVelocity(fine, 1025, nu, g) / stokes(1e-5) - 1) < 0.01);
  // 40 micrometres: Stokes's speed over 1 + sqrt(0.75 C2 R g D^3) / (18 nu), exactly.
  const silt = settlingVelocity(TRACER_MATERIALS.silt, 1025, nu, g),
    share = Math.sqrt(0.75 * r * g * 4e-5 ** 3) / (18 * nu);
  assert.ok(Math.abs(silt / (stokes(4e-5) / (1 + share)) - 1) < 1e-12, `${silt}`);
  // A 2 cm stone: the turbulent limit sqrt(4 R g D / (3 C2)).
  const stone = { density: 2650, diameter: 0.02, colour: [0.5, 0.5, 0.5] },
    limit = Math.sqrt((4 * r * g * 0.02) / 3);
  assert.ok(Math.abs(settlingVelocity(stone, 1025, nu, g) / limit - 1) < 0.05);
  // Oil droplets rise.
  assert.ok(settlingVelocity({ density: 870, diameter: 1e-4, colour: [0, 0, 0] }) < 0);
});

test('an ore plume sinks at its settling speed and comes to rest on the bed; every kilogram is accounted for', () => {
  const { solver, run } = tracers({
      sources: [burst('ironOre', [0, -5, 0])],
      bed: 8,
      horizontalDiffusivity: 0.05,
      verticalDiffusivity: 0,
    }),
    // At the world's gravity.
    w = settlingVelocity(TRACER_MATERIALS.ironOre, 1025, 1e-6, -new PhysicsWorld().gravity[1]),
    t = 120 * DT;
  run(120);
  const sinking = moments(solver, 1);
  assert.ok(Math.abs(sinking.mean - (-5 - w * t)) < 1e-9, `${sinking.mean} against ${-5 - w * t}`);
  // Long enough to reach the bed 3 m below: all of it lies there.
  run(Math.ceil(4 / w / DT));
  const budget = solver.budget;
  assert.equal(budget.released, 10000);
  assert.equal(budget.bed, 10000);
  assert.equal(budget.water + budget.surface, 0);
  for (const p of solver.particlesOf()) assert.equal(p.position[1], -8);
});

test('a slick floats and drifts with the water and 3 percent of the wind', () => {
  const wind = {
      medium: 'air',
      cell: [0, 0, 0],
      sample(_x, _y, _z, _t, out = { velocity: [0, 0, 0], density: 1.2, temperature: 285 }) {
        out.velocity[0] = 0;
        out.velocity[1] = 0;
        out.velocity[2] = 15;
        return out;
      },
    },
    { solver, run } = tracers({
      sources: [burst('oil', [0, -3, 0])],
      water: current(0.3),
      wind,
      horizontalDiffusivity: 0.1,
    }),
    t = 600 * DT;
  run(600);
  const x = moments(solver, 0, 'surface'),
    z = moments(solver, 2, 'surface'),
    spread = Math.sqrt((2 * 0.1 * t) / 10000);
  assert.equal(x.n, 10000, 'all on the surface');
  assert.ok(
    Math.abs(x.mean - 0.3 * t) < 5 * spread && Math.abs(z.mean - 0.03 * 15 * t) < 5 * spread,
    `${x.mean}, ${z.mean}`,
  );
  assert.equal(moments(solver, 1, 'surface').variance, 0, 'on the surface, not in the water');
});

test("a breach in a moving hull leaves a red plume along the ship's track, at the rate it leaks", () => {
  // The hull moves at 4 m/s along x; its breach leaks iron ore at 20 kg/s, then less as the hold empties.
  const breach = (t) => [4 * t, -6, 0],
    rate = (t) => 20 * Math.exp(-t / 30),
    { solver, run } = tracers({ sources: [{ material: 'ironOre', position: breach, rate }], particleMass: 0.5 });
  run(600);
  // Released: the integral of the rate over ten seconds, to within one particle.
  const expected = 20 * 30 * (1 - Math.exp(-10 / 30));
  assert.ok(Math.abs(solver.budget.released - expected) <= 0.5, `${solver.budget.released} kg against ${expected}`);
  const { mass, colour } = solver.concentration([-5, -12, -5], [45, 0, 5], [10, 6, 2]);
  let first = -1,
    last = -1;
  for (let i = 0; i < 10; i++) {
    let column = 0;
    for (let j = 0; j < 6; j++) for (let k = 0; k < 2; k++) column += mass[i + 10 * (j + 6 * k)];
    if (column > 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  assert.ok(first <= 1 && last >= 8, `a trail along the track: cells ${first} to ${last}`);
  const red = colour.findIndex((_, i) => i % 3 === 0 && mass[i / 3] > 0);
  assert.deepEqual(
    Array.from(colour.slice(red, red + 3)).map((v) => +v.toFixed(2)),
    [0.55, 0.12, 0.06],
    'iron-ore red',
  );
});

test('the same release gives the same bits', () => {
  const make = () =>
      tracers({
        sources: [burst('silt', [0, -4, 0]), { material: 'oil', position: [1, 0, 1], rate: 60 }],
        water: current(0.2),
      }),
    a = make(),
    b = make();
  a.run(90);
  b.run(90);
  assert.equal(a.world.hash(), b.world.hash());
});

test('settings out of range are refused with what to pass', () => {
  const world = () => new PhysicsWorld({ rate: { num: 60, den: 1 } });
  assert.throws(
    () => world().add(new TracerSolver(), { sources: [{ material: 'mud', position: [0, 0, 0], rate: 1 }] }),
    /not one of/,
  );
  assert.throws(() => world().add(new TracerSolver(), { horizontalDiffusivity: -1 }), /0 or more/);
  assert.throws(() => world().add(new TracerSolver(), { capacity: 0 }), /whole particles/);
});
