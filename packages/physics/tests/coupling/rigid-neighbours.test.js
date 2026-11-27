// DYN-01 point 4: the rigid world against its neighbours, both ways, with the conserved quantity accounted. Each scene has
// no external force along the measured axis, so the total linear momentum must stay where it was while it moves between
// the two sides. The ragdoll's own case is in packages/ragdoll/tests/ragdoll.test.js; fluids, buoyancy, terrain, the deck,
// recoil and fracture are listed with their tests in docs/physics-parity-bar.md (P1 status).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, Vehicle } from '../../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../../dist/soft.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

test('SOFT-02 to DYN-01: a rope thrown at a free box hands it momentum, and rope plus box keep the total', async () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const soft = await SoftBodies.attach(physics),
    n = 12,
    m = 0.05,
    rope = soft.create(SoftBodyDesc.rope([1, 0, -0.55], [1, 0, 0.55], n).setParticleMass(m).setAirDrag(false));
  for (let i = 0; i < n; i++) rope.setParticleVelocity(i, [-3, 0, 0]);
  const box = physics.addBody(null, {
    colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass: 1, friction: 0 },
  });
  const momentum = () => {
    const v = rope.particleVelocities(),
      total = box.linearVelocity.map((value) => value * box.mass);
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) total[a] += m * v[3 * i + a];
    return total;
  };
  const before = momentum();
  for (let i = 0; i < 60; i++) physics.step();
  const after = momentum();
  assert.ok(box.linearVelocity[0] < -0.5, `the box was pushed (${box.linearVelocity[0]} m/s)`);
  // f32 particle speeds summed over the rope: a few parts in 1e5 of the 1.8 kg m/s.
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(after[a] - before[a]) < 1e-4, `momentum ${a}: ${after[a]} against ${before[a]}`);
});

test('DYN-04 to DYN-01: a car driving off on a free deck pushes the deck back, car plus deck keeping zero momentum', () => {
  const physics = new Physics(null);
  // The floor holds the deck up but takes no push along it.
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [200, 0.5, 200], friction: 0, frictionCombine: 'min' },
  });
  const deck = physics.addBody(null, {
    position: [0, 0.25, 0],
    colliders: { shape: 'box', halfExtents: [20, 0.25, 20], mass: 20000, friction: 1 },
  });
  const chassis = physics.addBody(null, {
    position: [0, 1.3, 0],
    colliders: { shape: 'box', halfExtents: [0.9, 0.3, 2], mass: 1200 },
  });
  const car = Vehicle.car(physics, chassis, { groundReaction: true });
  physics.on('beforestep', () => car.setInput({ throttle: 1 }));
  for (let i = 0; i < 120; i++) physics.step();
  const along = chassis.mass * chassis.linearVelocity[2] + deck.mass * deck.linearVelocity[2];
  assert.ok(chassis.linearVelocity[2] > 5, `the car drove off (${chassis.linearVelocity[2]} m/s)`);
  assert.ok(deck.linearVelocity[2] < -0.3, `the deck went back (${deck.linearVelocity[2]} m/s)`);
  // Against the 8,700 kg m/s each side carries, the sum is zero to f32 rounding.
  assert.ok(Math.abs(along) < 0.1, `car plus deck: ${along} kg m/s`);
});
