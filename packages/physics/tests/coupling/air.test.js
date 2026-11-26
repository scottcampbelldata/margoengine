// The air solver's coupling checks (docs/physics-framework.md, section 10): `AirSolver` and `RigidSolver` coupled air before
// rigid, a box in a gusty wind and a drone on a rotor, held to the harness: the same state at 24, 30 and 60 frames a second,
// and a seek equal to a continuous run.
import test from 'node:test';
import { Physics, WindForce } from '../../dist/index.js';
import { AirSolver, RotorForce } from '../../dist/flight.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

function scene() {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    box = physics.addBody(null, {
      position: [0, 2, 0],
      colliders: { shape: 'box', halfExtents: [0.3, 0.2, 0.25], mass: 0.5 },
    }),
    drone = physics.addBody(null, {
      position: [3, 6, 0],
      colliders: { shape: 'box', halfExtents: [0.3, 0.05, 0.3], mass: 2 },
    });
  void box;
  new WindForce(physics, { velocity: (p, t) => [5 + 2 * Math.sin(t + p[2]), 0, Math.cos(1.3 * t)] });
  new RotorForce(physics, drone, { radius: 0.3, blades: 2, chord: 0.03, pitch: 0.2, speed: 400 });
  return physics;
}

const make = (rate = { num: 24, den: 1 }) => {
  const physics = scene();
  return new PhysicsWorld({ rate })
    .add(new RigidSolver(), { physics })
    .add(new AirSolver(), { physics })
    .couple(['air', 'rigid'], 'staggered');
};

test('AirSolver: the same wind and rotor loads at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('AirSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
