// The air's loads as a framework solver: coupled air before rigid, a world steps a gusty wind on loose boxes, a drone on four
// rotors, a glider and a balloon to the bits Physics gives stepped alone; the loads go through the `bodyForces` port and
// hold for one step only, and nothing of them is left on a body after it, alone or in a world.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, WindForce } from '../dist/index.js';
import { AirSolver, LiftingGas, RotorForce, WingForce } from '../dist/flight.js';
import { SailForce, SoftBodies, SoftBodyDesc } from '../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../dist/world.js';

await Physics.load();

/** A gust that swings and swirls: a function of the point and the time. */
const gust = (p, t) => [6 + 3 * Math.sin(2.3 * t + 0.4 * p[2]), 0.5 * Math.cos(1.7 * t), 2 * Math.sin(0.9 * t + p[0])];

/** Boxes in a gusty wind, a drone on four rotors (two of them on one body), a glider and a helium balloon. */
function scene() {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    boxes = [0, 1, 2].map((i) =>
      physics.addBody(null, {
        position: [i * 1.5, 2 + i, 0],
        rotation: [0, Math.sin(0.2 * i), 0, Math.cos(0.2 * i)],
        colliders: { shape: 'box', halfExtents: [0.3, 0.2, 0.25], mass: 0.4 + i },
      }),
    ),
    drone = physics.addBody(null, {
      position: [0, 20, 5],
      colliders: { shape: 'box', halfExtents: [0.3, 0.05, 0.3], mass: 2 },
    }),
    glider = physics.addBody(null, {
      position: [0, 40, -10],
      linearVelocity: [0, 0, 12],
      colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.6], mass: 1.5 },
    }),
    balloon = physics.addBody(null, { position: [5, 3, 5], colliders: { shape: 'sphere', radius: 0.5, mass: 0.05 } }),
    wind = new WindForce(physics, { velocity: gust, region: { min: [-5, -5, -5], max: [10, 15, 10] } });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
  });
  const rotors = [
    [0.4, 0.4, 1],
    [-0.4, 0.4, -1],
    [0.4, -0.4, -1],
    [-0.4, -0.4, 1],
  ].map(
    ([x, z, turn]) =>
      new RotorForce(physics, drone, {
        hub: [x, 0.06, z],
        radius: 0.18,
        blades: 2,
        chord: 0.03,
        pitch: 0.22,
        speed: (t) => turn * (330 + 20 * Math.sin(3 * t)),
        wind: gust,
      }),
  );
  const wing = new WingForce(physics, glider, {
      sections: [
        { leadingEdge: [0, 0, 0], chord: 0.25, twist: 0.08 },
        { leadingEdge: [1, 0, 0], chord: 0.2, twist: 0.05 },
      ],
      forward: [0, 0, 1],
      mirror: true,
      panels: [2, 4],
      wind: gust,
    }),
    gas = new LiftingGas(physics, balloon, { volume: 0.4 });
  return { physics, boxes, drone, glider, balloon, wind, rotors, wing, gas };
}

/** A world of the scene's rigid solver and its air loads, air stepping before rigid. */
function world(s) {
  return new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(new RigidSolver(), { physics: s.physics })
    .add(new AirSolver(), { physics: s.physics })
    .couple(['air', 'rigid'], 'staggered');
}

/** The six force and torque words of `body`'s columns. */
const held = (s, body) => {
  const c = s.physics.kernel.columns,
    r = body.row;
  return [c.forceX[r], c.forceY[r], c.forceZ[r], c.torqueX[r], c.torqueY[r], c.torqueZ[r]];
};

test('coupled air before rigid, a world steps wind, rotors, a wing and lifting gas to the bits Physics gives alone', () => {
  const alone = scene(),
    inWorld = scene();
  for (let i = 0; i < 150; i++) alone.physics.step();
  world(inWorld).advance(150);
  assert.equal(inWorld.physics.stepCount, 150);
  assert.equal(inWorld.physics.kernel.hash, alone.physics.kernel.hash);
  for (const key of ['drone', 'glider', 'balloon']) assert.deepEqual(inWorld[key].position, alone[key].position, key);
  assert.deepEqual(inWorld.rotors[0].thrust, alone.rotors[0].thrust);
  // The loads did their work: the wind moved the boxes, the rotors held the drone up, the balloon rose.
  assert.ok(alone.boxes[0].position[0] > 0.05, `the wind pushed the box: ${alone.boxes[0].position[0]}`);
  assert.ok(alone.drone.position[1] > 15, `the rotors carried the drone: ${alone.drone.position[1]}`);
  assert.ok(alone.balloon.position[1] > 3.2, `the balloon rose: ${alone.balloon.position[1]}`);
});

test('the loads go through the bodyForces port and hold for one step: none is left on a body between ticks', () => {
  const s = scene(),
    air = new AirSolver(),
    w = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics: s.physics })
      .add(air, { physics: s.physics })
      .couple(['air', 'rigid'], 'staggered');
  w.advance(60);
  const [port] = air.exportPorts(60),
    words = new Float64Array(
      port.region.memory?.buffer ?? w.memory.buffer,
      port.region.byteOffset,
      port.region.byteLength / 8,
    ),
    up = words[s.drone.row * 6 + 1];
  // Four rotors at about 330 rad/s carry most of the 2 kg drone's weight.
  assert.ok(up > 10, `the rotors' summed thrust in the port: ${up} N`);
  for (const body of [...s.boxes, s.drone, s.glider, s.balloon]) assert.deepEqual(held(s, body), [0, 0, 0, 0, 0, 0]);
});

test('stepped alone, an air load comes off exactly when it stops: a body keeps its own force to the bit', () => {
  // A held load changed by its difference each step re-rounded the running sum into the f32 columns, so when the wind
  // stopped it left a stray force of that rounding behind, a push that never ended.
  const s = scene(),
    own = [0.3, 0, -0.17];
  for (const body of s.boxes) body.addForce(own, undefined, false);
  const expected = s.boxes.map((body) => held(s, body));
  for (let i = 0; i < 90; i++) {
    s.physics.step();
    for (const [k, body] of s.boxes.entries()) assert.deepEqual(held(s, body), expected[k], `step ${i}, box ${k}`);
  }
  s.wind.remove();
  for (const r of s.rotors) r.remove();
  s.wing.remove();
  s.gas.remove();
  s.physics.step();
  for (const [k, body] of s.boxes.entries())
    assert.deepEqual(held(s, body), expected[k], `box ${k} after the wind stopped`);
  for (const body of [s.drone, s.glider, s.balloon]) assert.deepEqual(held(s, body), [0, 0, 0, 0, 0, 0]);
});

test("a sail loads its cloth's particles, never a body: in a world the soft solver steps it to the bits it has alone", async () => {
  // The sail's load reaches the mast through the cloth's links, which the soft solver hands to the rigid one through
  // bodyImpulses and bodyForces; nothing of the sail goes through the air solver.
  const make = async () => {
      const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
        soft = await SoftBodies.attach(physics),
        mast = physics.addBody(null, {
          position: [0, 1, 0],
          colliders: { shape: 'box', halfExtents: [0.05, 1, 0.05], mass: 5 },
        }),
        sail = soft.create(
          SoftBodyDesc.cloth([0.06, 0.2, -0.3], [0, 0.15, 0], [0, 0, 0.1], 5, 7).setParticleMass(0.01),
        );
      for (let i = 0; i < 5; i++) sail.attachParticle(i * 7, mast);
      new SailForce(physics, sail, { wind: [8, 0, 3], grid: [5, 7], chord: 'v', density: 1.2 });
      return { physics, soft, mast };
    },
    alone = await make(),
    inWorld = await make();
  for (let i = 0; i < 60; i++) alone.physics.step();
  new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(new RigidSolver(), { physics: inWorld.physics })
    .add(new SoftSolver(), { soft: inWorld.soft })
    .add(new AirSolver(), { physics: inWorld.physics })
    .couple(['soft', 'air', 'rigid'], 'staggered')
    .advance(60);
  assert.equal(inWorld.soft.hash(), alone.soft.hash());
  assert.equal(inWorld.physics.kernel.hash, alone.physics.kernel.hash);
  assert.ok(Math.hypot(...alone.mast.linearVelocity) > 0, 'the wind in the sail moved the mast');
});

test('an AirSolver is made from a Physics', () => {
  assert.throws(() => new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new AirSolver(), {}), /Physics/);
});
