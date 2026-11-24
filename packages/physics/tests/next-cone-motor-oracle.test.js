// Oracle: the own solver's cone rotation motor, inside its cone, follows the same spring as Rapier's spherical joint motor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Physics as Own } from '../dist/index.js';
import { Physics as Rapier } from './oracle/dist/index.js';

const dir = process.env.MARGOENGINE_RAPIER
  ? resolve(process.env.MARGOENGINE_RAPIER)
  : fileURLToPath(new URL('../../../node_modules/@dimforge/rapier3d-compat/', import.meta.url));
const entry = resolve(dir, 'dist/rapier.mjs');
let RAPIER = null;
if (existsSync(entry)) {
  RAPIER = (await import(pathToFileURL(entry).href)).default;
  const warn = console.warn;
  console.warn = () => {};
  await RAPIER.init();
  console.warn = warn;
}
const skip = RAPIER ? false : 'Rapier not found';
const about = (axis, angle) => [...axis.map((v) => v * Math.sin(angle / 2)), Math.cos(angle / 2)];
const between = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

function build(Physics, options, joint) {
  const physics = new Physics(null, { gravity: [0, 0, 0], ...options });
  const anchor = physics.addBody(null, { type: 'fixed', colliders: [] }),
    rod = physics.addBody(null, {
      colliders: { shape: 'box', halfExtents: [0.5, 0.05, 0.05], offset: [0.5, 0, 0], mass: 2 },
    });
  return { physics, rod, joint: physics.addJoint(anchor, rod, joint) };
}

test("a cone motor inside its cone turns as Rapier's spherical motor does", { skip }, async () => {
  await Own.load();
  const target = about([0, 0, 1], 0.4),
    inertia = 2 / 3,
    w = 2 * Math.PI * 2,
    gains = { model: 'force', stiffness: inertia * w * w, damping: 2 * inertia * w };
  const oracle = build(Rapier, { rapier: RAPIER }, { type: 'spherical' }),
    own = build(Own, {}, { type: 'cone', axis: [1, 0, 0], swing: 1.2 });
  oracle.joint.setRotationMotor(target, gains);
  own.joint.setRotationMotor(target, gains);
  for (const steps of [10, 19, 40]) {
    while (oracle.physics.stepCount < steps) oracle.physics.step();
    while (own.physics.stepCount < steps) own.physics.step();
    const gap = between(oracle.rod.rotation, own.rod.rotation);
    assert.ok(gap < 0.03, `after ${steps} steps the rods differ by ${gap} rad`);
  }
  oracle.physics.dispose();
  own.physics.dispose();
});

test('a motored rod sags under its weight by the closed form, and as far as Rapier\'s spherical motor with the same gains and cap', { skip }, async () => {
  await Own.load();
  const mass = 2;
  const sag = (kind, stiffness, damping, cap) => {
    if (kind === 'rapier') {
      const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
      const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
        rod = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
      world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.05, 0.05).setTranslation(0.5, 0, 0).setMass(mass), rod);
      const made = world.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), fixed, rod, true),
        joint = new RAPIER.SphericalImpulseJoint(made.rawSet, made.bodySet, made.handle);
      for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
        joint.configureMotorModel(axis, RAPIER.MotorModel.ForceBased);
        joint.setMotorMaxForce(axis, cap);
        joint.configureMotor(axis, 0, 0, stiffness, damping);
      }
      for (let i = 0; i < 240; i++) world.step();
      const q = rod.rotation();
      world.free();
      return -2 * Math.atan2(q.z, q.w);
    }
    const physics = new Own(null);
    const fixed = physics.addBody(null, { type: 'fixed', colliders: [] }),
      rod = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 0.05, 0.05], offset: [0.5, 0, 0], mass } });
    const joint = kind === 'cone' ? physics.addJoint(fixed, rod, { type: 'cone', axis: [1, 0, 0], swing: 1.5 }) : physics.addJoint(fixed, rod, { type: 'spherical' });
    joint.setRotationMotor([0, 0, 0, 1], { model: 'force', stiffness, damping, maxForce: cap });
    for (let i = 0; i < 240; i++) physics.step();
    const q = rod.rotation;
    physics.dispose();
    return -2 * Math.atan2(q[2], q[3]);
  };
  for (const [stiffness, damping, cap] of [[200, 20, 1e6], [2000, 60, 1e6], [200, 20, 8]]) {
    const own = sag('spherical', stiffness, damping, cap),
      cone = sag('cone', stiffness, damping, cap),
      rapier = sag('rapier', stiffness, damping, cap);
    // Closed form with no cap: the weight's torque m g L / 2 over the spring (the rod's sag is small).
    if (cap > 100) assert.ok(Math.abs(own - (mass * 9.81 * 0.5) / stiffness) < 0.03 * own + 1e-3, `spherical k ${stiffness}: ${own}`);
    assert.ok(Math.abs(cone - own) < 1e-3, `cone ${cone} against spherical ${own}`);
    assert.ok(Math.abs(own - rapier) < 0.15 * Math.abs(rapier) + 0.01, `k ${stiffness} cap ${cap}: own ${own} against Rapier ${rapier}`);
  }
});
