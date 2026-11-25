// Aerodynamic loads from shape (AERO-01): every collider's surface as outward panels of the right area, a flat plate's
// drag and its inclined normal force, a moment only where the loads are uneven, spin slowed by skin friction, and the
// accepted drag of a sphere.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, WindForce } from '../dist/index.js';

await Physics.load();

const RHO = 1.2;

/** The force a wind of `velocity` puts on a body with `collider` held at the origin with `rotation`, from one step. */
function windLoad(collider, velocity, rotation = [0, 0, 0, 1], options = {}) {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const mass = 1000,
    body = physics.addBody(null, { position: [0, 0, 0], rotation, colliders: { ...collider, mass } });
  new WindForce(physics, { velocity, density: RHO, ...options });
  physics.step();
  const dt = physics.fixedTimestep;
  return { force: body.linearVelocity.map((v) => (v * mass) / dt), spin: body.angularVelocity, body };
}

test('a flat plate square to the wind takes C_N90 times the dynamic pressure on its area', () => {
  // A 2 m square plate 1 cm thick, face on to 10 m/s.
  const { force } = windLoad({ shape: 'box', halfExtents: [0.005, 1, 1] }, [10, 0, 0]),
    expected = 0.5 * RHO * 100 * 4 * 1.17;
  assert.ok(Math.abs(force[0] - expected) / expected < 0.01, `drag ${force[0]} against ${expected}`);
  assert.ok(Math.abs(force[1]) < 1e-6 * expected && Math.abs(force[2]) < 1e-6 * expected, 'no side force face on');
});

test('an inclined plate takes the sin-law normal force: lift across the wind as well as drag', () => {
  // The plate turned 45 degrees about z: its normal is (cos 45, sin 45, 0).
  const s = Math.SQRT1_2,
    { force } = windLoad(
      { shape: 'box', halfExtents: [0.005, 1, 1] },
      [10, 0, 0],
      [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)],
    ),
    normal = 0.5 * RHO * 100 * 4 * 1.17 * s;
  // The windward face's normal is -(cos 45, sin 45, 0): the force on it is up and downwind, half drag and half lift.
  assert.ok(Math.abs(force[0] - normal * s) / (normal * s) < 0.02, `drag ${force[0]} against ${normal * s}`);
  assert.ok(Math.abs(force[1] - normal * s) / (normal * s) < 0.02, `lift ${force[1]} against ${normal * s}`);
});

test('a uniform wind on a symmetric body turns it not at all; a wind stronger at the top does', () => {
  const box = { shape: 'box', halfExtents: [0.5, 0.5, 0.5] };
  const even = windLoad(box, [8, 0, 0]);
  for (const w of even.spin) assert.ok(Math.abs(w) < 1e-9, `spin ${even.spin}`);
  const sheared = windLoad(box, (point) => [8 + 4 * point[1], 0, 0]);
  // More push above the centre than below: a turn about -z (top downwind).
  assert.ok(sheared.spin[2] < -1e-6, `spin ${sheared.spin}`);
});

test('a spinning body in still air slows by its skin friction', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 0.1, 1], mass: 1 } });
  body.setAngularVelocity([0, 20, 0]);
  new WindForce(physics, { velocity: [0, 0, 0], density: RHO, drag: 0 });
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(body.angularVelocity[1] < 20 && body.angularVelocity[1] > 0, `spin ${body.angularVelocity[1]}`);
});

test("every shape's panels face out and cover its area", () => {
  const physics = new Physics(null),
    cases = [
      [{ shape: 'box', halfExtents: [1, 2, 3] }, 2 * (2 * 4 + 2 * 6 + 4 * 6), 1e-12],
      [{ shape: 'sphere', radius: 2 }, 4 * Math.PI * 4, 0.02],
      [{ shape: 'cylinder', radius: 1, halfHeight: 2 }, 2 * Math.PI * 4 + 2 * Math.PI, 0.03],
      [{ shape: 'capsule', radius: 1, halfHeight: 1 }, 2 * Math.PI * 2 + 4 * Math.PI, 0.03],
      [{ shape: 'cone', radius: 1, halfHeight: 1 }, Math.PI * Math.sqrt(5) + Math.PI, 0.03],
    ];
  for (const [collider, area, tolerance] of cases) {
    const body = physics.addBody(null, { colliders: collider }),
      force = new WindForce(physics, { velocity: [0, 0, 0] }),
      surface = force.surfaceOf(body);
    let total = 0;
    for (let i = 0; i < surface.areas.length; i++) {
      total += surface.areas[i];
      const out =
        surface.normals[3 * i] * surface.centres[3 * i] +
        surface.normals[3 * i + 1] * surface.centres[3 * i + 1] +
        surface.normals[3 * i + 2] * surface.centres[3 * i + 2];
      assert.ok(out > 0, `${collider.shape}: panel ${i} faces in`);
    }
    assert.ok(Math.abs(total - area) / area <= tolerance, `${collider.shape}: area ${total} against ${area}`);
    force.remove();
  }
});

test("a sphere's drag coefficient is the accepted 0.78 of the panel law (0.47 measured, recorded in limits)", () => {
  const r = 0.5,
    { force } = windLoad({ shape: 'sphere', radius: r }, [10, 0, 0], [0, 0, 0, 1], { friction: 0 }),
    cd = force[0] / (0.5 * RHO * 100 * Math.PI * r * r);
  assert.ok(Math.abs(cd - 0.78) < 0.02, `Cd ${cd}`);
});
