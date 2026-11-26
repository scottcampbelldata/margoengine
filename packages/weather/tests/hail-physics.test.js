import assert from 'node:assert/strict';
import test from 'node:test';
import { STANDARD_GRAVITY } from '@margoengine/math/gravity';
import { FallingSolver } from '@margoengine/physics/falling';
import { PhysicsWorld } from '@margoengine/physics/world';
import { Hail } from '../dist/hail.js';
import { hailFromFalling, hailSphere } from '../dist/hail-physics.js';
import { hailFallSpeed } from '../dist/precipitation.js';

test('PA-32: coincident hailstones retain distinct terminal velocities and publish their geometry to Hail', async () => {
  const falling = await FallingSolver.load();
  const air = { density: 0.97, temperature: 263.15, gravity: STANDARD_GRAVITY };
  const diameters = [0.009, 0.046];
  const velocities = diameters.map((diameter) => hailFallSpeed(diameter, air));
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -air.gravity, 0] }).add(falling, {
    bodies: diameters.map((diameter, index) =>
      hailSphere({
        diameter,
        position: [0, 40, 0],
        velocity: [0, -velocities[index], 0],
      }),
    ),
    wind: { medium: 'air', cell: [0, 0, 0], sample: () => ({ ...air, velocity: [0, 0, 0] }) },
  });
  const source = hailFromFalling(falling, [3, 0, -1]);
  using hail = new Hail({ source, intensity: 1, fadeSeconds: 0, particles: 6000 });
  hail.update(0);
  assert.equal(hail.count, diameters.length);
  world.advance(60);
  const draw = new Float32Array(16);
  source.write(draw);
  for (let index = 0; index < diameters.length; index++) {
    const pose = falling.pose(index);
    const speed = velocities[index];
    // A terminal state is a fixed point of the drag/buoyancy ODE. Allow 32
    // f64 rounding operations per each of the 240 steps at this state scale.
    const bound = 32 * 240 * Number.EPSILON * 40;
    assert.ok(Math.abs(pose.velocity[1] + speed) <= bound);
    assert.ok(Math.abs(pose.position[1] - (40 - speed)) <= bound);
    assert.deepEqual(
      [...draw.subarray(index * 8, index * 8 + 8)],
      [3, Math.fround(pose.position[1]), -1, Math.fround(diameters[index] / 2), 0, Math.fround(-speed), 0, 0],
    );
  }
  assert.ok(velocities[1] > velocities[0]);
});
