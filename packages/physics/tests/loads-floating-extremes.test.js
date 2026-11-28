// Floating at the extremes (SEA-12, parity bar P12 point 5): bodies from a centimetre to a hundred metres, from cork to
// lead, dropped fast into the water and left floating for an hour, with no NaN and no energy left over from the start
// (their drag takes it); and a body the step cannot resolve refused with a coded error naming the fix.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { floating, LoadSolver } from '../dist/loads.js';
import { PhysicsWorld, RigidSolver } from '../dist/world.js';

await Physics.load();
const RHO = 1000,
  G = 9.81;
const water = () => ({
  cell: [0, 0, 0],
  density: RHO,
  elevation: () => 0,
  water: {
    medium: 'water',
    cell: [0, 0, 0],
    sample: (_x, y, _z, _t, o = { velocity: [0, 0, 0], density: 0, temperature: 288 }) => {
      o.velocity[0] = o.velocity[1] = o.velocity[2] = 0;
      o.density = y <= 0 ? RHO : 0;
      return o;
    },
  },
});

/** A sphere of `radius` and `density`, let go at `y`, in a world of `rate` steps a second (Loads at that rate). */
async function drop({ radius, density, y, rate = 60, level = 0, options = {} }) {
  const physics = new Physics(null, { fixedTimestep: 1 / rate, gravity: [0, -G, 0] }),
    body = physics.addBody(null, {
      position: [0, y, 0],
      colliders: { shape: 'sphere', radius, density },
      linearDamping: 0,
      angularDamping: 0,
    }),
    sea = water(),
    loads = new LoadSolver(),
    world = new PhysicsWorld({ rate: { num: rate, den: 1 }, gravity: [0, -G, 0] })
      .add(new RigidSolver(), { physics })
      .add(loads, { sea, bodies: await floating(physics, body, { sea, radiation: 'none', ...options }), level })
      .couple(['loads', 'rigid'], 'staggered');
  return { physics, body, loads, world };
}

/**
 * The sphere's energy: its kinetic energy and the water's it carries (Lamb's half of the displaced volume, the
 * LoadSolver's added mass), its weight's, and the buoyancy's potential (rho g times the displaced volume's integral).
 */
function energy(body, radius, mass) {
  const v = body.linearVelocity,
    y = body.position[1],
    d = radius - y,
    under = d <= 0 ? 0 : d >= 2 * radius ? (4 / 3) * Math.PI * radius ** 3 : (Math.PI * d * d * (3 * radius - d)) / 3,
    // The displaced volume's potential: rho g times the integral of the submerged volume over the height, a cap's.
    cap = (d) =>
      d <= 0
        ? 0
        : d >= 2 * radius
          ? (4 / 3) * Math.PI * radius ** 3 * (d - radius)
          : (Math.PI * d ** 3 * (4 * radius - d)) / 12,
    depth = radius - y;
  return 0.5 * (mass + 0.5 * RHO * under) * (v[0] ** 2 + v[1] ** 2 + v[2] ** 2) + mass * G * y + RHO * G * cap(depth);
}

test('SEA-12 extremes: spheres from 1 cm to 100 m and from cork to lead float or sink with no NaN and end below their energy at the start', async () => {
  for (const radius of [0.01, 0.1, 1, 10, 100])
    for (const density of [120, 500, 990, 1500, 11340]) {
      // The step resolves the heave of all but the smallest light bodies at 60 Hz: those run at 480 (level 3).
      const level = radius < 0.05 ? 3 : 0,
        rate = 60 * 2 ** level,
        run = await drop({ radius, density, y: radius * 0.6, rate, level }),
        mass = run.body.mass,
        start = energy(run.body, radius, mass);
      for (let f = 1; f <= rate * 20; f++) run.world.advance(f);
      assert.ok(
        run.body.position.every(Number.isFinite) && run.body.linearVelocity.every(Number.isFinite),
        `${radius} m, ${density}`,
      );
      // With its drag the body ends with less energy than it started with (the carried water's energy swings within a
      // cycle while its added mass changes with the draft, KB-LOADS-ADDEDRATE1, so only the end is held to the start).
      const end = energy(run.body, radius, mass);
      // A body let go near its rest (cork at 0.6 r sits 0.07 r from it) keeps a little of that swing: 1e-3 m g r.
      assert.ok(
        end <= start + 1e-3 * mass * G * radius,
        `${radius} m at ${density} kg/m³ ended ${(end - start) / (mass * G * radius)} m g r above its start`,
      );
      // A light body stays at the surface, a heavy one sinks; at 0.99 of the water's density the drop carries it down
      // many radii (1 % of its weight brings it back), so it is only checked for its energy.
      if (density < 0.9 * RHO) assert.ok(run.body.position[1] > -radius, `${radius} m, ${density} afloat`);
      else if (density > RHO) assert.ok(run.body.position[1] < -radius, `${radius} m, ${density} sank`);
      run.physics[Symbol.dispose]();
    }
});

test('SEA-12 extremes: a sphere dropped from 50 m (31 m/s at the water) enters, rebounds lower and floats', async () => {
  const radius = 0.5,
    run = await drop({ radius, density: 400, y: 50, rate: 240, level: 2 }),
    mass = run.body.mass,
    start = energy(run.body, radius, mass);
  let entered = 0,
    rebound = -Infinity;
  for (let f = 1; f <= 240 * 60; f++) {
    run.world.advance(f);
    const y = run.body.position[1];
    if (y < radius && !entered) entered = f;
    if (entered && f > 240 * 5) rebound = Math.max(rebound, y);
  }
  assert.ok(entered && run.body.position.every(Number.isFinite));
  // A minute on, its drag has taken energy: it ends below the energy it had in the air.
  assert.ok(energy(run.body, radius, mass) < start, `energy ${energy(run.body, radius, mass)} against ${start} J`);
  assert.ok(rebound < 50, `rebounded to ${rebound} m`);
  // Afloat after a minute, partly under.
  const wet = run.loads.bodyLoad(0).wet;
  assert.ok(wet > 0 && wet < 1, `wet ${wet}`);
  run.physics[Symbol.dispose]();
});

test('SEA-12 extremes: a box floats an hour on still water without drifting, and replays its last minute bit for bit', async () => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -G, 0] }),
    body = physics.addBody(null, {
      position: [0, 0.05, 0],
      rotation: [0.05, 0, 0, Math.sqrt(1 - 0.0025)],
      colliders: { shape: 'box', halfExtents: [1, 0.25, 0.5], density: 500 },
    }),
    sea = water(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -G, 0] })
      .add(new RigidSolver(), { physics })
      .add(new LoadSolver(), { sea, bodies: await floating(physics, body, { sea, radiation: 'none' }) })
      .couple(['loads', 'rigid'], 'staggered');
  for (let f = 1; f <= 60 * 3540; f++) world.advance(f);
  const saved = world.takeSnapshot();
  world.advance(60 * 3600);
  const end = world.hash(),
    [x, y, z] = body.position;
  world.restoreSnapshot(saved.bytes).advance(60 * 3600);
  assert.equal(world.hash(), end);
  // It floats at its draft (its centre at the water at half the water's density) and has not run off: the drag of its
  // decaying roll pumps it sideways by centimetres an hour (11 measured), no more.
  assert.ok(Math.abs(y) <= 1e-3 && Math.hypot(x, z) <= 0.5, `after an hour at ${x}, ${y}, ${z}`);
  physics[Symbol.dispose]();
});

test('SEA-12 extremes: a body whose heave the step cannot resolve is refused, naming the fix', async () => {
  // A 4 mm cork at 60 steps a second: sqrt(rho g A / m) dt is 1.4, past the 0.9 the held buoyancy keeps stable.
  const run = await drop({ radius: 0.004, density: 240, y: 0 });
  assert.throws(() => run.world.advance(1), {
    code: 'unsupported',
    message: /heaves too fast for the step.+raise the Loads level/,
  });
  run.physics[Symbol.dispose]();
  // The same body at 480 steps a second (level 3) floats.
  const fine = await drop({ radius: 0.004, density: 240, y: 0, rate: 480, level: 3 });
  fine.world.advance(480);
  assert.ok(fine.body.position.every(Number.isFinite));
  fine.physics[Symbol.dispose]();
});
