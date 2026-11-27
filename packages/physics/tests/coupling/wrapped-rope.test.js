// The wrapped rope coupled both ways to rigid bodies (`WrappedRopeSolver`, SOFT-02 item 3): a winch's drum that turns and
// heaves with a deck against the capstan law on a slipping drum, momentum and angular momentum passed whole between rope
// and free bodies, and the framework's frame-rate and seek properties.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { WrappedRopeSolver } from '../../dist/wrapped-rope.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

const g = 9.81,
  R = 0.2,
  mu = 0.3,
  mA = 2,
  mB = 1,
  heave = 0.5,
  spin = -25;

/**
 * A winch drum of radius R on a deck heaving up at `heave`, turning clockwise (its top running from A's side to B's) at
 * `spin` rad/s, a rope over its top with a mass hung each side, both rising with the deck at the start.
 */
function winch(rate = { num: 60, den: 1 }) {
  const physics = new Physics(null, {
    gravity: [0, -g, 0],
    fixedTimestep: 1 / 60,
  });
  const drum = physics.addBody(null, {
    type: 'kinematicVelocity',
    position: [0, 0, 0],
    linearVelocity: [0, heave, 0],
    angularVelocity: [0, 0, spin],
    colliders: [],
  });
  const rope = new WrappedRopeSolver();
  const world = new PhysicsWorld({ rate, gravity: [0, -g, 0] })
    .add(new RigidSolver(), { physics })
    .add(rope, {
      nodes: [
        { position: [-R, -1, 0], mass: mA, velocity: [0, heave, 0] },
        { position: [R, -1, 0], mass: mB, velocity: [0, heave, 0] },
      ],
      wraps: [
        {
          body: drum.row,
          center: [0, 0, 0],
          axis: [0, 0, 1],
          radius: R,
          friction: mu,
          turn: -1,
        },
      ],
    })
    .couple(['wrappedRope', 'rigid'], 'staggered');
  return { world, rope, drum };
}

test('a winch drum turning on a heaving deck slips under the rope at the capstan ratio, the masses at the closed form', () => {
  // The drum's surface runs past the rope from A's side toward B's, so friction pulls the rope toward B and A's side is the
  // tight one: T_A = k T_B, k = e^(mu pi). Then m_A a = T_A - m_A g and m_B a = m_B g - T_B give A rising, against the deck,
  // at a = g (k m_B - m_A) / (m_A + k m_B), whatever the drum's speed while it slips and whatever the deck's steady speed.
  // The constraints are linear in the speeds, so each step's speeds are the closed form's but for the drum's pose, which the
  // kernel keeps in f32: its centre is off the f64 nodes' frame by up to about 1e-7 m, a stretch the constraint's correction
  // takes out over the next steps, so the error stays bounded and does not grow. Measured within 3.4e-6 m/s and 2.1e-4 N
  // over 0.5 s, held to 1e-5 m/s and 1e-3 N. The wrap angle, read through the drum's f32 rotation, is off pi by up to
  // about 1.5e-7 rad; the slide keeps the tensions at the ratio of the angle it has, k to 1.2e-7 measured, held to 1e-6.
  const { world, rope, drum } = winch(),
    k = Math.exp(mu * Math.PI),
    a = (g * (k * mB - mA)) / (mA + k * mB);
  for (let f = 1; f <= 30; f++) {
    world.advance(f);
    const t = f / 60;
    assert.ok(Math.abs(rope.read(0).velocity[1] - (heave + a * t)) < 1e-5, `A at ${t} s: ${rope.read(0).velocity[1]}`);
    assert.ok(Math.abs(rope.read(1).velocity[1] - (heave - a * t)) < 1e-5, `B at ${t} s: ${rope.read(1).velocity[1]}`);
    const [tA, tB] = rope.tension(0);
    assert.equal(rope.holding(0), false);
    assert.ok(Math.abs(tA / tB - k) < 1e-6, `the tensions ${tA} and ${tB} keep the ratio ${k}`);
    assert.ok(Math.abs(tB - mB * (g - a)) < 1e-3, `B's side carries ${tB} N`);
  }
  assert.ok(
    Math.abs(drum.position[1] - heave * 0.5) < 1e-6,
    'the deck heaved on, a kinematic body the rope cannot move',
  );
});

test('between a free drum, a boat and a hanging mass, the rope passes momentum and angular momentum whole', () => {
  // No gravity: a free drum, a boat the rope's first end is made fast to, and a mass on its other end moving off. Every pull
  // on a node is met by its reaction on the drum where the rope leaves it, and the two lie on one line, so the linear and
  // angular momentum (about the origin, about z: the motion stays in the plane) are kept to the kernel's f32 records:
  // measured within 4e-7 of the start, held to 1e-5 of the momentum moving.
  const physics = new Physics(null, {
    gravity: [0, 0, 0],
    fixedTimestep: 1 / 60,
  });
  const drum = physics.addBody(null, {
    position: [0, 0, 0],
    colliders: { shape: 'sphere', radius: R, mass: 10 },
    canSleep: false,
  });
  const boat = physics.addBody(null, {
    position: [-R, -2, 0],
    colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3], mass: 50 },
    canSleep: false,
  });
  const rope = new WrappedRopeSolver();
  const m = 2,
    v0 = [0.5, -3, 0];
  const world = new PhysicsWorld({
    rate: { num: 60, den: 1 },
    gravity: [0, 0, 0],
  })
    .add(new RigidSolver(), { physics })
    .add(rope, {
      nodes: [{ body: boat.row }, { position: [R, -1, 0], mass: m, velocity: v0 }],
      wraps: [
        {
          body: drum.row,
          center: [0, 0, 0],
          axis: [0, 0, 1],
          radius: R,
          friction: mu,
          turn: -1,
        },
      ],
    })
    .couple(['wrappedRope', 'rigid'], 'staggered');
  const inertia = {
    drum: 0.4 * 10 * R * R,
    boat: (50 * (0.6 * 0.6 + 0.6 * 0.6)) / 12,
  };
  const momentum = () => {
    const node = rope.read(1),
      p = [0, 1].map((k) => m * node.velocity[k] + 10 * drum.linearVelocity[k] + 50 * boat.linearVelocity[k]);
    const lz = (r, v, mass) => mass * (r[0] * v[1] - r[1] * v[0]);
    return [
      ...p,
      lz(node.position, node.velocity, m) +
        lz(drum.position, drum.linearVelocity, 10) +
        inertia.drum * drum.angularVelocity[2] +
        lz(boat.position, boat.linearVelocity, 50) +
        inertia.boat * boat.angularVelocity[2],
    ];
  };
  const start = [m * v0[0], m * v0[1], m * (R * v0[1] - -1 * v0[0])],
    scale = Math.hypot(m * v0[0], m * v0[1]);
  let pulled = 0;
  for (let f = 1; f <= 30; f++) {
    world.advance(f);
    const now = momentum();
    for (let k = 0; k < 3; k++)
      assert.ok(
        Math.abs(now[k] - start[k]) < 1e-5 * scale,
        `momentum ${k} at frame ${f}: ${now[k]} against ${start[k]}`,
      );
    pulled = Math.max(pulled, rope.tension(0)[1]);
  }
  assert.ok(pulled > 10, `the rope pulled (${pulled} N)`);
  assert.ok(Math.abs(drum.angularVelocity[2]) > 1e-3, 'the drum was turned by the rope on it');
  assert.ok(boat.linearVelocity[1] > 0.01, 'the boat was hauled toward the drum');
});

test('a coupled wrapped rope gives the same state at 24, 30 and 60 frames a second, and a seek replays it to the bit', () => {
  frameRateIndependent((rate) => winch(rate).world);
  seekEqualsContinuous(() => winch({ num: 24, den: 1 }).world);
});

test('a coupled wrapped rope refuses what it cannot be made of, naming the fix', () => {
  const refused = (message) => ({
    name: 'MargoError',
    code: 'unsupported',
    message: new RegExp(`${message}.+#rods`),
  });
  const build = (params) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    physics.addBody(null, { type: 'fixed', colliders: [] });
    return new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(new WrappedRopeSolver(), params);
  };
  assert.throws(() => build({ nodes: [{ position: [0, 0, 0], mass: 1 }] }), refused('two or more nodes'));
  assert.throws(
    () =>
      build({
        nodes: [{ position: [0, 0, 0], mass: 1 }, { body: 4096 * 64 }],
      }),
    refused('body row'),
  );
  assert.throws(
    () =>
      build({
        nodes: [
          { position: [0, 0, 0], mass: 0 },
          { position: [1, 0, 0], mass: 1 },
        ],
      }),
    refused('mass above 0'),
  );
  assert.throws(
    () =>
      build({
        nodes: [
          { position: [0, 0, 0], mass: 1 },
          { position: [1, 0, 0], mass: 1 },
        ],
        wraps: [{ center: [0, 0, 0], axis: [0, 0, 0], radius: 0.1, turn: 1 }],
      }),
    refused('an axis'),
  );
});
