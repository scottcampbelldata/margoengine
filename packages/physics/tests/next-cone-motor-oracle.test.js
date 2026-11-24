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
