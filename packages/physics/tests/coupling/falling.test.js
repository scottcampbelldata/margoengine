import assert from 'node:assert/strict';
import test from 'node:test';
import { FALLING_BODY_WORDS, FallingSolver, fallingBoundaryFromPhysics } from '../../dist/falling.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, rateOf, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const gravity = 9.80665;
const temperature = 288.15;

function wind(density, velocity = [0, 0, 0], cell = [0, 0, 0]) {
  return {
    medium: 'air',
    cell,
    sample(_x, _y, _z, _t, out) {
      out.density = density;
      out.temperature = temperature;
      out.velocity[0] = velocity[0];
      out.velocity[1] = velocity[1];
      out.velocity[2] = velocity[2];
      return out;
    },
  };
}

function near(actual, expected, bound) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} versus ${expected} (bound ${bound})`);
}

test('FallingSolver preserves the vacuum trajectory and rotates the fixed flight plane into world axes', async () => {
  const falling = await FallingSolver.load();
  const spanDirection = [1, 0, 0];
  const world = new PhysicsWorld({ rate }).add(falling, {
    bodies: [
      {
        kind: 'plate',
        mass: 0.01,
        chord: 0.1,
        position: [1, 3, 2],
        velocity: [0.75, 1, 3],
        angularVelocity: 2,
        spanDirection,
      },
    ],
    wind: wind(0),
  });
  world.advance(60);
  const pose = falling.pose(0);
  const dt = 1 / rateOf(world.levelOf(falling.id));
  // Every RK4 arithmetic chain is a fixed sum here. Bound accumulated
  // roundoff by 32 rounded operations per tick at the largest state magnitude.
  const bound = (32 * Number.EPSILON * 10) / dt;
  near(pose.position[0], 1.75, bound);
  near(pose.position[1], 4 - gravity / 2, bound);
  near(pose.position[2], 5, bound);
  near(pose.angularVelocity[0], 2, bound);
  near(pose.angularVelocity[1], 0, bound);
  near(pose.angularVelocity[2], 0, bound);
  const worldRotation = [
    Math.sin(1) / Math.SQRT2,
    Math.cos(1) / Math.SQRT2,
    Math.sin(1) / Math.SQRT2,
    Math.cos(1) / Math.SQRT2,
  ];
  for (let index = 0; index < 4; index++) near(pose.rotation[index], worldRotation[index], bound);
  const port = world.fields.port(falling.poseField.name);
  assert.equal(port.region.layout, 1);
  assert.equal(port.region.byteLength, FALLING_BODY_WORDS * 8);
  assert.deepEqual(
    [...regionWords(world.arena.memory, port.region)],
    [...pose.position, ...pose.rotation, ...pose.velocity, ...pose.angularVelocity],
  );
});

test('FallingSolver reaches the closed-form broadside and edge-on plate speeds in relative wind', async () => {
  const falling = await FallingSolver.load();
  const density = 1;
  const a = 0.05;
  const b = 0.002;
  const span = 0.2;
  const mass = 0.01;
  const verticalWind = 0.3;
  const world = new PhysicsWorld({ rate }).add(falling, {
    bodies: [0, Math.PI / 2].map((angle) => {
      const volume = Math.PI * a * b * span;
      const drag = angle === 0 ? 2.4 : 0.4;
      const speed = Math.sqrt(((mass - density * volume) * gravity) / (density * a * span * drag));
      return {
        kind: 'plate',
        mass,
        span,
        chord: 2 * a,
        thickness: 2 * b,
        angle,
        // Set rotation coupling to zero because cos(pi/2) is rounded. This
        // leaves an exact equilibrium in translation rather than a tilt seed.
        rotationalLift: 0,
        translationalLift: 0,
        pitchInertia: 1,
        velocity: [0, verticalWind - speed, 0],
      };
    }),
    wind: wind(density, [0, verticalWind, 0]),
  });
  const initial = [falling.pose(0), falling.pose(1)];
  world.advance(60);
  for (let i = 0; i < 2; i++) {
    const out = falling.pose(i);
    near(out.velocity[1], initial[i].velocity[1], 32 * Number.EPSILON * 240);
    near(out.position[1], initial[i].velocity[1], 32 * Number.EPSILON * 240);
  }
  assert.ok(initial[1].velocity[1] < initial[0].velocity[1]);
});

test('FallingSolver reproduces APW Figure 3 flutter and period-one tumbling without a motion switch', async () => {
  const falling = await FallingSolver.load();
  const a = 0.05;
  const span = 0.25;
  const massUnit = Math.PI * a * a * span;
  const world = new PhysicsWorld({ rate }).add(falling, {
    bodies: [1.1, 1.4].map((inertia) => ({
      kind: 'plate',
      chord: 2 * a,
      span,
      mass: inertia * massUnit,
      angle: 0.18,
    })),
    wind: wind(1),
  });
  // The paper labels two modes by bounded rocking or net full turns,
  // independent of exact phase. Sample above the paper's timescale a/U
  // and omit the first 2 seconds (more than 30 of those time units).
  const turns = [0, 0];
  const reversals = [0, 0];
  const previous = [0, 0];
  for (let frame = 1; frame <= 720; frame++) {
    world.advance(frame);
    for (let body = 0; body < 2; body++) {
      const spin = falling.pose(body).angularVelocity[2];
      if (frame > 120) {
        turns[body] += (previous[body] + spin) / (120 * 2 * Math.PI);
        if (previous[body] * spin < 0) reversals[body]++;
      }
      previous[body] = spin;
    }
  }
  assert.ok(Math.abs(turns[0]) < 1 && reversals[0] >= 4);
  assert.ok(Math.abs(turns[1]) >= 2 && reversals[1] === 0);
});

test('FallingSolver matches a quadratic grain fall from rest in a moving air mass', async () => {
  const falling = await FallingSolver.load();
  const windSpeed = 2.5;
  const airDensity = 1.225;
  const diameters = [0.012, 0.047];
  const drag = 0.47;
  const solidDensity = 900;
  const bodies = diameters.map((diameter) => {
    const mass = (Math.PI * solidDensity * diameter ** 3) / 6;
    return { kind: 'sphere', diameter, mass, drag, velocity: [windSpeed, 0, 0] };
  });
  const world = new PhysicsWorld({ rate }).add(falling, { bodies, wind: wind(airDensity, [windSpeed, 0, 0]) });
  const t = 2;
  world.advance(t * 60);
  const dt = 1 / rateOf(world.levelOf(falling.id));
  for (let i = 0; i < bodies.length; i++) {
    const effectiveGravity = gravity * (1 - airDensity / solidDensity);
    const k = (0.5 * airDensity * drag * ((Math.PI * diameters[i] ** 2) / 4)) / bodies[i].mass;
    const terminal = Math.sqrt(effectiveGravity / k);
    const q = (effectiveGravity * t) / terminal;
    const result = falling.pose(i);
    const expectedVelocity = -terminal * Math.tanh(q);
    const expectedHeight = -Math.log(Math.cosh(q)) / k;
    // The velocity equation is contractive for a falling grain. The local
    // step-doubling target is 1e-8 of the state scale. Position integrates the
    // bounded velocity error over t in addition to its own local errors.
    const velocityError = (t / dt) * 1e-8 * Math.max(1, terminal);
    near(result.velocity[1], expectedVelocity, velocityError);
    near(result.position[1], expectedHeight, t * velocityError + (t / dt) * 1e-8 * Math.abs(expectedHeight));
    near(result.position[0], t * windSpeed, (32 * Number.EPSILON * t * windSpeed) / dt);
  }
  assert.ok(falling.pose(1).velocity[1] < falling.pose(0).velocity[1]);
});

test('FallingSolver samples the world clock and origin cells and replays across frame rates and memory types', async () => {
  const fallers = await Promise.all(Array.from({ length: 9 }, () => FallingSolver.load()));
  const bodies = [{ kind: 'plate', chord: 0.1, mass: 0.006, angle: 0.18, position: [2, 20, 3] }];
  const cellSize = 1024;
  const cell = [3, 1, 4];
  const windCell = [2, 0, 4];
  const samples = [];
  const air = {
    medium: 'air',
    cell: windCell,
    sample(x, y, z, time, out) {
      if (samples.length === 0) samples.push([x, y, z, time]);
      out.velocity[0] = 0.3 + x / 10000 + 0.11 * time;
      out.velocity[1] = 0;
      out.velocity[2] = z / 100;
      out.density = 1 + y / 10000;
      out.temperature = temperature;
      return out;
    },
  };
  let used = 0;
  const make = (fps, shared = false) => {
    const fall = fallers[used++];
    return new PhysicsWorld({ rate: fps, cellSize, memory: worldMemory(shared) }).add(
      fall,
      { bodies, wind: air, cellSize },
      cell,
    );
  };
  frameRateIndependent(make, { seconds: 2 });
  assert.deepEqual(samples[0], [1026, 1044, 3, 1 / 480]);
  seekEqualsContinuous(() => make({ num: 24, den: 1 }), { at: 0, frames: 48 });
  const plain = make(rate);
  const shared = make(rate, true);
  plain.advance(60);
  shared.advance(60);
  assert.equal(plain.hash(), shared.hash());
});

test('FallingSolver reproduces PA-32 scene impacts against a rigid wall, keeping tangential motion', async () => {
  await Physics.load();
  using scene = new Physics(null);
  scene.addBody(null, {
    type: 'fixed',
    position: [0, 2, 0],
    colliders: { shape: 'box', halfExtents: [0.25, 4, 2] },
  });
  const diameter = 0.2;
  const start = [-1, 2, 0];
  const velocity = [20, 2, 0];
  const restitution = 0.5;
  const falling = await FallingSolver.load();
  const world = new PhysicsWorld({ rate, gravity: [0, 0, 0] }).add(falling, {
    bodies: [{ kind: 'sphere', diameter, mass: 1, position: start, velocity, restitution }],
    wind: wind(0),
    boundary: fallingBoundaryFromPhysics(scene),
  });
  const time = 6 / 60;
  const wall = -0.25 - diameter / 2;
  const impact = (wall - start[0]) / velocity[0];
  world.advance(6);
  const pose = falling.pose(0);
  // The rigid query represents the metre-scale swept geometry in f32.
  // Eight rounding units cover the position, support point and sweep TOI.
  const tolerance = 8 * 2 ** -23;
  near(pose.position[0], wall - restitution * velocity[0] * (time - impact), tolerance);
  near(pose.position[1], start[1] + velocity[1] * time, tolerance);
  near(pose.velocity[0], -restitution * velocity[0], tolerance);
  near(pose.velocity[1], velocity[1], tolerance);
});

test('FallingSolver rests at one sphere radius above an arbitrary static boundary', async () => {
  await Physics.load();
  using scene = new Physics(null);
  scene.addBody(null, {
    type: 'fixed',
    position: [2, 3, -4],
    colliders: { shape: 'box', halfExtents: [1.25, 0.3, 2] },
  });
  const falling = await FallingSolver.load();
  const world = new PhysicsWorld({ rate }).add(falling, {
    bodies: [{ kind: 'sphere', diameter: 0.06, mass: 0.1, position: [2, 4, -4] }],
    wind: wind(0),
    boundary: fallingBoundaryFromPhysics(scene),
  });
  const snapshot = world.takeSnapshot();
  world.advance(60);
  const pose = falling.pose(0);
  near(pose.position[1], 3 + 0.3 + 0.03, 8 * 4 * 2 ** -23);
  near(pose.velocity[1], 0, 32 * Number.EPSILON);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(60);
  assert.equal(world.hash(), hash);
});

test('FallingSolver integrates the exact quadratic spin damping of two opposed blade sections', async () => {
  const falling = await FallingSolver.load();
  const end = 0.3;
  const chord = 0.06;
  const angularVelocity = 8;
  const spinInertia = 0.01;
  const profileDrag = 0.5;
  const density = 1;
  const world = new PhysicsWorld({ rate, gravity: [0, 0, 0] }).add(falling, {
    bodies: [
      {
        kind: 'samara',
        mass: 0.4,
        axis: [0, 0, 1],
        sections: [0, Math.PI].map((azimuth) => ({ start: 0, end, chord, pitch: 0, azimuth })),
        angularVelocity,
        spinInertia,
        potentialLift: 0,
        vortexLift: 0,
        profileDrag,
      },
    ],
    wind: wind(density),
  });
  const t = 2;
  world.advance(t * 60);
  // Opposed tangential forces cancel, while moments add. Each moment
  // contains the exact third radial moment of the strip, end^4 / 4.
  const k = (density * profileDrag * chord * end ** 4) / (4 * spinInertia);
  const expected = angularVelocity / (1 + k * angularVelocity * t);
  const angle = Math.log1p(k * angularVelocity * t) / k;
  const actual = falling.pose(0);
  const dt = 1 / rateOf(world.levelOf(falling.id));
  const bound = (t / dt) * 1e-8 * angularVelocity;
  near(actual.angularVelocity[2], expected, bound);
  assert.ok(actual.velocity.every((value) => Math.abs(value) < (32 * Number.EPSILON * t) / dt));
  // The quaternion cover may change sign when the stored angle wraps.
  const alignment = actual.rotation[2] * Math.sin(angle / 2) + actual.rotation[3] * Math.cos(angle / 2);
  near(Math.abs(alignment), 1, (t * bound) ** 2 / 8 + 32 * Number.EPSILON);
});

test('FallingSolver derives samara autorotation and reverses it when the blade pitch is mirrored', async () => {
  const falling = await FallingSolver.load();
  // Table 1's mass, radius and chord from Rezgui et al.; use its mid-air
  // wind-tunnel pitch range endpoint for the handedness pair.
  const end = 0.0368;
  const chord = 0.0084;
  const mass = 0.0001;
  const spinInertia = (mass * end * end) / 10;
  const world = new PhysicsWorld({ rate }).add(falling, {
    bodies: [1, -1].map((hand) => ({
      kind: 'samara',
      mass,
      spinInertia,
      position: [0, 8, 0],
      sections: Array.from({ length: 8 }, (_, i) => ({
        start: (end * i) / 8,
        end: (end * (i + 1)) / 8,
        chord,
        pitch: (-hand * 7 * Math.PI) / 180,
      })),
    })),
  });
  const frame = 360;
  world.advance(frame);
  const [left, right] = [falling.pose(0), falling.pose(1)];
  assert.ok(left.angularVelocity[1] > 0 && right.angularVelocity[1] < 0);
  const dt = 1 / rateOf(world.levelOf(falling.id));
  const bound = (32 * Number.EPSILON * frame) / (60 * dt);
  near(left.angularVelocity[1], -right.angularVelocity[1], bound * Math.abs(left.angularVelocity[1]));
  near(left.velocity[1], right.velocity[1], bound);
  near(left.position[2], -right.position[2], bound);
  // Figure 12's tape line goes from roughly 600 rpm at 0.5 m/s to
  // 2600 rpm at 1.9 m/s. A half plot division in rpm at the high-speed
  // endpoint makes 1500 an outer bound on rpm per m/s.
  const rpmPerDescent = (left.angularVelocity[1] * 60) / (2 * Math.PI * -left.velocity[1]);
  assert.ok(rpmPerDescent >= 1200 && rpmPerDescent <= 1500, `observed slope ${rpmPerDescent}`);
});
