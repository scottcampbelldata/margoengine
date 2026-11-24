// Oracle: Rapier's multibody joints and the own solver's, on the same pendulums, over the first second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Physics } from '../dist/index.js';

const dir = process.env.MARGOENGINE_RAPIER
  ? resolve(process.env.MARGOENGINE_RAPIER)
  : fileURLToPath(new URL('../../../node_modules/@dimforge/rapier3d-compat/', import.meta.url));
const entry = resolve(dir, 'dist/rapier.mjs');
let R = null;
if (existsSync(entry)) {
  R = (await import(pathToFileURL(entry).href)).default;
  const warn = console.warn;
  console.warn = () => {};
  await R.init();
  console.warn = warn;
}
const skip = R ? false : 'Rapier not found';

const TILT = 0.6;
const rooted = [0, 0, Math.sin(TILT / 2), Math.cos(TILT / 2)];

/** Rapier poses a multibody from its joint coordinates and reads no starting speed, so both chains start straight along a root tilted by TILT, at rest. */
function rapierChain(count) {
  const world = new R.World({ x: 0, y: -9.81, z: 0 });
  let parent = world.createRigidBody(
    R.RigidBodyDesc.fixed().setRotation({ x: rooted[0], y: rooted[1], z: rooted[2], w: rooted[3] }),
  );
  const balls = [];
  for (let i = 0; i < count; i++) {
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, -(i + 1), 0));
    world.createCollider(R.ColliderDesc.ball(0.05).setMass(1), body);
    world.createMultibodyJoint(
      R.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }),
      parent,
      body,
      true,
    );
    balls.push(body);
    parent = body;
  }
  return { world, balls };
}

function ownChain(count) {
  const physics = new Physics(null);
  const pivot = physics.addBody(null, { type: 'fixed', rotation: rooted, colliders: [] });
  const links = [];
  const bodies = [];
  for (let i = 0; i < count; i++) {
    const body = physics.addBody(null, {
      position: [0, -(i + 1), 0],
      colliders: { shape: 'sphere', radius: 0.05, mass: 1 },
    });
    bodies.push(body);
    links.push({ body, joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: [0, 1, 0] } });
  }
  const multibody = physics.addMultibody(pivot, links);
  multibody.setCoordinates(new Array(count).fill(0));
  return { physics, bodies };
}

test("a multibody pendulum and a double pendulum follow Rapier's multibody for a second", { skip }, async () => {
  await Physics.load();
  for (const count of [1, 2]) {
    const oracle = rapierChain(count);
    const own = ownChain(count);
    for (let i = 0; i < 60; i++) {
      oracle.world.step();
      own.physics.step();
    }
    for (let i = 0; i < count; i++) {
      const a = oracle.balls[i].translation(),
        b = own.bodies[i].position;
      const gap = Math.hypot(a.x - b[0], a.y - b[1], a.z - b[2]);
      assert.ok(gap < 0.05, `link ${i} of ${count} differs by ${gap} m`);
    }
    own.physics.dispose();
    oracle.world.free();
  }
});
