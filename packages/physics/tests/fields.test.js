// An explosion, a wind and the continuous fields (gravity field, updraft, vortex) on rigid bodies.
import assert from 'node:assert/strict';
import test from 'node:test';
import { explosion, GravityField, Physics, Updraft, Vortex, WindField, WindForce } from '../dist/index.js';
import { standardDensity } from '../../math/dist/atmosphere.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
await Physics.load();
// Bad input to a field is a coded MargoError linking the fields' help entry.
const coded = (pattern) => (error) =>
  error.name === 'MargoError' &&
  error.code === 'unsupported' &&
  pattern.test(error.message) &&
  error.message.includes('margoengine.com/errors#physics-fields');

const ball = (physics, position, mass = 1) =>
  physics.addBody(null, {
    position,
    colliders: { shape: 'sphere', radius: 0.25, mass },
  });

test('an explosion pushes bodies away from its centre, less with distance, and leaves what is out of reach', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const near1 = ball(physics, [1, 0, 0]),
    far = ball(physics, [3, 0, 0]),
    out = ball(physics, [6, 0, 0]),
    wall = physics.addBody(null, {
      type: 'fixed',
      position: [2, 0, 1],
      colliders: { shape: 'sphere', radius: 0.2 },
    });
  const pushed = explosion(physics, [0, 0, 0], { impulse: 10, radius: 5 });
  assert.ok(pushed.includes(near1) && pushed.includes(far));
  assert.ok(!pushed.includes(out) && !pushed.includes(wall));
  physics.step();
  near(near1.linearVelocity[0], 10 * (1 - 1 / 5), 0.05, 'a metre out: four fifths of the impulse');
  near(far.linearVelocity[0], 10 * (1 - 3 / 5), 0.05, 'three metres out: two fifths');
  assert.equal(out.linearVelocity[0], 0);
  const lifted = ball(physics, [0, 0, 1.5]);
  explosion(physics, [0, 0, 0], {
    impulse: 10,
    radius: 5,
    falloff: 'none',
    lift: 0.5,
  });
  physics.step();
  assert.ok(lifted.linearVelocity[1] > 4, `lift adds an upward share: ${lifted.linearVelocity[1]}`);
  assert.throws(() => explosion(physics, [0, 0, 0], { impulse: 0, radius: 1 }), coded(/impulse/));
  assert.throws(() => explosion(physics, [0, 0, 0], { impulse: 1, radius: 1, falloff: 'x' }), coded(/falloff/));
});

test('a wind drags bodies toward its speed, a light one faster, and only inside its region', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const light = ball(physics, [0, 0, 0], 0.2),
    heavy = ball(physics, [0, 2, 0], 20),
    outside = ball(physics, [0, 0, 30], 0.2);
  const wind = new WindForce(physics, {
    velocity: [10, 0, 0],
    region: { min: [-5, -5, -5], max: [5, 5, 5] },
  });
  for (let i = 0; i < 180; i++) physics.step();
  assert.ok(
    light.linearVelocity[0] > 5 && light.linearVelocity[0] < 10.01,
    `the light body nears the wind: ${light.linearVelocity[0]}`,
  );
  assert.ok(
    heavy.linearVelocity[0] > 0 && heavy.linearVelocity[0] < light.linearVelocity[0],
    'the heavy one is slower',
  );
  assert.equal(outside.linearVelocity[0], 0, 'out of the region it is calm');
  wind.remove();
  const before = light.linearVelocity[0];
  for (let i = 0; i < 30; i++) physics.step();
  near(light.linearVelocity[0], before, 1e-6, 'a stopped wind blows no more');
});

test('a wind may be a function of the point and the time, and is checked', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const leaf = ball(physics, [0, 0, 0], 0.1);
  new WindForce(physics, {
    velocity: (_point, time) => [0, time < 0.5 ? 0 : 8, 0],
  });
  for (let i = 0; i < 20; i++) physics.step();
  assert.equal(leaf.linearVelocity[1], 0, 'calm before the gust');
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(leaf.linearVelocity[1] > 3, `the gust carries it: ${leaf.linearVelocity[1]}`);
  assert.throws(() => new WindForce(physics, { velocity: [1, 0, 0], density: 0 }), coded(/density/));
  assert.throws(() => new WindForce(physics, { velocity: [1, 0] }), coded(/Wind velocity/));
});

test('the old name WindField is the same class, kept for old code', () => {
  assert.equal(WindField, WindForce);
});

test('a wind force takes a shared flow field: velocity and density at each body, on the world clock', () => {
  const run = (density) => {
    const physics = new Physics(null);
    physics.gravity = [0, 0, 0];
    // Heavy, so the step barely changes its motion and the load it takes is the wind's at the start (the load is held
    // implicitly, so a light body's step takes the drag of the speed it ends with).
    const leaf = ball(physics, [0, 3, 0], 1e4),
      seen = [];
    // Twenty steps in before the wind arrives: it is sampled at the world's time, not the time since it was made.
    for (let i = 0; i < 20; i++) physics.step();
    const wind = {
      medium: 'air',
      cell: [0, 0, 0],
      sample(x, y, z, t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
        seen.push([x, y, z, t]);
        out.velocity = [4, 0, 0];
        out.density = density;
        out.temperature = 288.15;
        return out;
      },
    };
    new WindForce(physics, { velocity: wind });
    physics.step();
    return { push: leaf.linearVelocity[0], seen };
  };
  const air = run(1.2),
    water = run(2.4);
  assert.deepEqual(air.seen[0], [0, 3, 0, 20 / 60], "sampled at the body's centre and the world's time");
  near(water.push, 2 * air.push, 1e-9, "the drag follows the field's density");
  assert.throws(
    () =>
      new WindForce(new Physics(null), {
        velocity: { ...wind0(), cell: [1, 0, 0] },
      }),
    /cell is \[0, 0, 0\]/,
  );
  const bad = new Physics(null);
  ball(bad, [0, 0, 0], 0.1);
  new WindForce(bad, {
    velocity: {
      ...wind0(),
      sample: (_x, _y, _z, _t, out) => Object.assign(out, { velocity: [1, 0, 0], density: 0 }),
    },
  });
  assert.throws(() => bad.step(), /density of 0/);
});

function wind0() {
  return {
    medium: 'air',
    cell: [0, 0, 0],
    sample: (_x, _y, _z, _t, out) => out,
  };
}

test("a wind force without a density takes the standard atmosphere's at each body's height", () => {
  const push = (y, options = {}) => {
    const physics = new Physics(null);
    physics.gravity = [0, 0, 0];
    // Heavy, as above, so the load is the wind's at the start of the step.
    const leaf = ball(physics, [0, y, 0], 1e4);
    new WindForce(physics, { velocity: [5, 0, 0], ...options });
    physics.step();
    return leaf.linearVelocity[0];
  };
  // ISO 2533: 1.225 kg/m3 at sea level, 0.73612 at 5 km.
  near(push(0), push(0, { density: standardDensity(0) }), 1e-15, 'sea level');
  near(standardDensity(0), 1.225, 1e-6, "the standard atmosphere's sea-level density");
  near(push(5000) / push(0), 0.73612 / 1.225, 1e-4, 'thinner air pushes less');
});

// One step of a field from rest with no gravity: v = F dt / m, the force each field's docs give, to float32 precision.
const oneStep = (place, makeField) => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const bodies = place.map(([position, mass]) => ball(physics, position, mass));
  const field = makeField(physics);
  physics.step();
  return {
    physics,
    field,
    bodies,
    dt: physics.fixedTimestep,
    v: bodies.map((b) => b.linearVelocity),
  };
};

test('a gravity field pulls every mass toward its centre at its acceleration, scaled by the falloff', () => {
  const { v, dt, physics, field } = oneStep(
    [
      [[2, 0, 0], 1],
      [[0, 0, -2], 5],
      [[0, 6, 0], 1],
    ],
    (p) =>
      new GravityField(p, {
        center: [0, 0, 0],
        radius: 4,
        acceleration: 3,
        falloff: 'none',
      }),
  );
  near(v[0][0], -3 * dt, 1e-6, 'a light body falls in at 3 m/s²');
  near(v[1][2], 3 * dt, 1e-6, 'a heavy one at the same 3 m/s²');
  assert.deepEqual(v[2], [0, 0, 0], 'out of reach');
  const linear = oneStep(
    [[[2, 0, 0], 1]],
    (p) => new GravityField(p, { center: [0, 0, 0], radius: 4, acceleration: 3 }),
  );
  near(linear.v[0][0], -3 * 0.5 * linear.dt, 1e-6, 'halfway out, half the pull (linear falloff)');
  field.enabled = false;
  const before = physics.getBodies()[0].linearVelocity[0];
  physics.step();
  assert.equal(physics.getBodies()[0].linearVelocity[0], before, 'a disabled field pushes nothing');
  field.remove();
  field.remove();
  assert.throws(
    () =>
      new GravityField(physics, {
        center: [0, 0, 0],
        radius: 0,
        acceleration: 1,
      }),
    coded(/radius/),
  );
  assert.throws(() => new GravityField(physics, { center: [0, 0], radius: 1, acceleration: 1 }), coded(/center/));
  assert.throws(
    () =>
      new GravityField(physics, {
        center: [0, 0, 0],
        radius: 1,
        acceleration: -1,
      }),
    coded(/acceleration/),
  );
  assert.throws(
    () =>
      new GravityField(physics, {
        center: [0, 0, 0],
        radius: 1,
        acceleration: 1,
        falloff: 'cubic',
      }),
    coded(/falloff/),
  );
});

test('an updraft lifts what is inside its cylinder by its force, straight up or away from its base', () => {
  const { v, dt } = oneStep(
    [
      [[0.5, 1, 0], 2],
      [[0, 5, 0], 2],
      [[2, 1, 0], 2],
      [[0, -0.5, 0], 2],
    ],
    (p) =>
      new Updraft(p, {
        center: [0, 0, 0],
        radius: 1,
        height: 3,
        strength: 10,
        falloff: 'none',
      }),
  );
  near(v[0][1], (10 / 2) * dt, 1e-6, 'F / m up the axis');
  near(v[0][0], 0, 1e-12, 'perpendicular mode pushes straight up');
  for (const i of [1, 2, 3]) assert.deepEqual(v[i], [0, 0, 0], `body ${i} is above, beside or below the cylinder`);
  const fountain = oneStep(
    [[[0.5, 0.5, 0], 1]],
    (p) =>
      new Updraft(p, {
        center: [0, 0, 0],
        radius: 1,
        height: 3,
        strength: 4,
        mode: 'center',
      }),
  );
  // Linear falloff at half the radius: half of 4 N, along (1, 1, 0) / sqrt 2.
  near(fountain.v[0][0], (2 / Math.SQRT2) * fountain.dt, 1e-6, 'centre mode: outward');
  near(fountain.v[0][1], (2 / Math.SQRT2) * fountain.dt, 1e-6, 'centre mode: up');
  const physics = new Physics(null);
  assert.throws(
    () =>
      new Updraft(physics, {
        center: [0, 0, 0],
        radius: 1,
        height: 0,
        strength: 1,
      }),
    coded(/height/),
  );
  assert.throws(
    () =>
      new Updraft(physics, {
        center: [0, 0, 0],
        radius: 1,
        height: 1,
        strength: 1,
        mode: 'side',
      }),
    coded(/mode/),
  );
});

test('a vortex turns bodies counter-clockwise seen from above, pulls them in and lifts them, by its shares', () => {
  const { v, dt } = oneStep(
    [
      [[1, 0.5, 0], 1],
      [[0, 0.5, 2], 2],
    ],
    (p) =>
      new Vortex(p, {
        center: [0, 0, 0],
        radius: 3,
        height: 2,
        strength: 4,
        falloff: 'none',
      }),
  );
  // At +x: around is -z, in is -x, up is +y; F = 4 (-0.3, 0.1, -1).
  near(v[0][0], -1.2 * dt, 1e-6, 'pulled in');
  near(v[0][1], 0.4 * dt, 1e-6, 'lifted');
  near(v[0][2], -4 * dt, 1e-6, 'turned');
  // At +z, mass 2: around is +x, in is -z.
  near(v[1][0], 2 * dt, 1e-6, 'turned, half as fast for twice the mass');
  near(v[1][2], -0.6 * dt, 1e-6, 'pulled in');
  const physics = new Physics(null);
  assert.throws(
    () =>
      new Vortex(physics, {
        center: [0, 0, 0],
        radius: 1,
        height: 1,
        strength: 1,
        centripetal: -1,
      }),
    coded(/centripetal/),
  );
  assert.throws(
    () =>
      new Vortex(physics, {
        center: [0, 0, 0],
        radius: 1,
        height: 1,
        strength: 0,
      }),
    coded(/strength/),
  );
});

test('the fields replay bit for bit after a snapshot and restore', () => {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  for (let i = 0; i < 12; i++) ball(physics, [((i * 7) % 5) - 2, 0.3 + (i % 3) * 0.6, ((i * 3) % 5) - 2], 1 + (i % 4));
  new GravityField(physics, {
    center: [0, 3, 0],
    radius: 4,
    acceleration: 5,
    falloff: 'inverse-square',
  });
  new Updraft(physics, {
    center: [1, 0, 1],
    radius: 1.5,
    height: 4,
    strength: 30,
  });
  new Vortex(physics, {
    center: [-1, 0, -1],
    radius: 2,
    height: 3,
    strength: 20,
  });
  for (let i = 0; i < 20; i++) physics.step();
  const snapshot = physics.takeSnapshot(),
    run = () => {
      for (let i = 0; i < 40; i++) physics.step();
      return physics.getBodies().flatMap((b) => [...b.position, ...b.rotation]);
    },
    first = run();
  physics.restoreSnapshot(snapshot);
  assert.deepEqual(run(), first);
  assert.ok(first.every(Number.isFinite));
});
