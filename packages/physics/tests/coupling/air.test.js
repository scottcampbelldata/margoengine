import assert from 'node:assert/strict';
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

test('WindForce samples each panel in the wind cell and preserves replay in a far rigid cell', () => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 });
  physics.gravity = [0, 0, 0];
  const plate = physics.addBody(null, {
    position: [1, 2, 3],
    colliders: { shape: 'box', halfExtents: [0.125, 0.5, 0.5], mass: 20 },
  });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize: 512 })
    .add(new RigidSolver(), { physics })
    .add(new AirSolver(), { physics })
    .couple(['air', 'rigid'], 'staggered');
  const wide = [-524287, 400001, 524272];
  const nearby = [-524288, 400002, 524270];
  world.setCell('rigid', wide);
  const sampled = [];
  new WindForce(physics, {
    frame: {
      cellSize: world.cellSize,
      get cell() {
        return world.cellOf('rigid');
      },
    },
    velocity: {
      medium: 'air',
      cell: nearby,
      sample(x, y, z, time, out) {
        sampled.push([x, y, z, time]);
        out.velocity = [8 + (y + 510) * 0.5, 0, 0];
        out.density = 1.2;
        out.temperature = 288;
        return out;
      },
    },
  });
  const zero = world.takeSnapshot();
  world.advance(1);
  assert.deepEqual(sampled[0].slice(0, 3), [513, -510, 1027]);
  assert.ok(sampled.some((value) => value[1] !== -510));
  assert.ok(plate.linearVelocity[0] > 0.03);
  world.advance(4);
  const accepted = world.takeSnapshot();
  world.restoreSnapshot(zero.bytes);
  sampled.length = 0;
  world.advance(4);
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  const localPosition = plate.position;
  world.shiftOrigin([1, -1, 2]);
  sampled.length = 0;
  world.advance(5);
  assert.deepEqual(world.cellOf('rigid'), nearby);
  assert.deepEqual(sampled[0].slice(0, 3), localPosition);
});
