import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryLayerWind } from '@margoengine/weather/boundary-layer';
import { BoundaryLayerSolver } from '../../dist/boundary-layer.js';
import { AirSolver } from '../../dist/flight.js';
import { Physics, WindForce } from '../../dist/index.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../../dist/world.js';

test('PA-26: the live boundary layer applies local height-dependent forces through AirSolver', async () => {
  await Physics.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, 0, 0], memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity: [0, 0, 0] });
  const air = new AirSolver();
  using wind = await BoundaryLayerSolver.load();
  try {
    const profile = new BoundaryLayerWind({ speed: 12, roughness: 0.03, turbulence: false, obukhovLength: 60 });
    world.add(wind, { profile: profile.profile, grid: { cells: [3, 3, 2], origin: [0, 0, 0], spacing: [2, 10, 3] } });
    function probe(height) {
      return physics.addBody(null, {
        position: [0, height, 0],
        colliders: { shape: 'box', halfExtents: [0.3, 0.00001, 0.25], mass: 3 },
      });
    }
    const below = probe(-1);
    const middle = probe(10);
    const top = probe(20);
    new WindForce(physics, { velocity: wind, drag: 0.001, friction: 0 });
    world.add(new RigidSolver(), { physics }).add(air, { physics }).couple([air.id, 'rigid'], 'staggered');
    world.advance(1);
    const lowAir = wind.sample(0, 10, 0, 0);
    const highAir = wind.sample(0, 20, 0, 0);
    const expected = (highAir.density * highAir.velocity[0] ** 2) / (lowAir.density * lowAir.velocity[0] ** 2);
    const ratio = top.linearVelocity[0] / middle.linearVelocity[0];
    assert.ok(middle.linearVelocity[0] > 0 && top.linearVelocity[0] > middle.linearVelocity[0]);
    assert.equal(below.linearVelocity[0], 0);
    // A thin plate has negligible panel height variation. Identical geometry, step and mass cancel in the ratio.
    assert.ok(Math.abs(ratio - expected) <= 32 * 2 ** -23 * expected, `${ratio} vs ${expected}`);
    const saved = world.takeSnapshot();
    world.advance(8);
    const final = world.hash();
    world.restoreSnapshot(saved.bytes);
    world.advance(8);
    assert.equal(world.hash(), final);
  } finally {
    physics.dispose();
  }
});
