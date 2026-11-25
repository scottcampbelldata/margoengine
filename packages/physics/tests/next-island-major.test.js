// A step solved island by island gives the bits of one solved phase by phase, through `Physics`: a multibody arm with stacks
// beside it, a vehicle-like set of hinged bodies, and a kinematic platform under a stack. The state hash is compared every step.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

function scene(islandMajor, build) {
  const physics = new Physics(null);
  physics.setSolver({ islandMajor });
  build(physics);
  return physics;
}

function same(steps, build) {
  const [a, b] = [scene(false, build), scene(true, build)];
  assert.equal(a.solver.islandMajor, false);
  assert.equal(b.solver.islandMajor, true);
  for (let step = 0; step < steps; step++) {
    a.step();
    b.step();
    assert.equal(a.kernel.hash, b.kernel.hash, `the state differs after step ${step}`);
  }
  a.dispose();
  b.dispose();
}

const floor = (physics) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [40, 0.5, 40] },
  });
const crate = (physics, position) =>
  physics.addBody(null, { position, colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] }, canSleep: false });

test('island by island is the default, and a multibody arm beside stacks steps the same either way', async () => {
  await Physics.load();
  assert.equal(new Physics(null).solver.islandMajor, true);
  same(200, (physics) => {
    floor(physics);
    for (let i = 0; i < 3; i++) {
      crate(physics, [8 + i * 3, 0.5, 0]);
      crate(physics, [8 + i * 3, 1.6, 0]);
    }
    const pivot = physics.addBody(null, { type: 'fixed', position: [0, 6, 0], colliders: [] });
    const bodies = [0, 1, 2].map((i) =>
      physics.addBody(null, { position: [i + 1, 6, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } }),
    );
    physics.addMultibody(
      pivot,
      bodies.map((body) => ({
        body,
        joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: [-1, 0, 0] },
      })),
    );
  });
});

test('hinged bodies under a sweeping kinematic platform step the same either way', async () => {
  await Physics.load();
  same(240, (physics) => {
    floor(physics);
    const platform = physics.addBody(null, {
      type: 'kinematicVelocity',
      position: [0, 3, 0],
      linearVelocity: [0.5, 0, 0],
      angularVelocity: [0, 0.4, 0],
      colliders: { shape: 'box', halfExtents: [3, 0.2, 1] },
    });
    for (const x of [-1.5, 1.5]) {
      const a = crate(physics, [x, 3.7, 0]);
      const b = crate(physics, [x, 4.8, 0]);
      physics.addJoint(a, b, { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0.5, 0], anchorB: [0, -0.5, 0] });
    }
    physics.addJoint(platform, crate(physics, [4, 3, 0]), {
      type: 'spherical',
      anchorA: [4, 0, 0],
      anchorB: [0, 0, 0],
    });
  });
});

test('a multibody arm on a moving kinematic base, and one whose tip rests on a moving platform, step the same either way', async () => {
  await Physics.load();
  const arm = (physics, root, x) => {
    const bodies = [0, 1].map((i) =>
      physics.addBody(null, {
        position: [x + i + 1, 6, 0],
        colliders: { shape: 'sphere', radius: 0.3, mass: 1 },
        canSleep: false,
      }),
    );
    physics.addMultibody(
      root,
      bodies.map((body) => ({
        body,
        joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: [-1, 0, 0] },
      })),
    );
    return bodies;
  };
  same(240, (physics) => {
    floor(physics);
    const base = physics.addBody(null, {
      type: 'kinematicVelocity',
      position: [0, 6, 0],
      linearVelocity: [0.3, 0.1, 0],
      angularVelocity: [0, 0.5, 0.2],
      colliders: [],
    });
    arm(physics, base, 0);
    const wall = physics.addBody(null, { type: 'fixed', position: [20, 6, 0], colliders: [] });
    const [, tip] = arm(physics, wall, 20);
    physics.addBody(null, {
      type: 'kinematicVelocity',
      position: [tip.position[0], 4.6, 0],
      linearVelocity: [0, 0.6, 0],
      angularVelocity: [0, 0.3, 0],
      colliders: { shape: 'box', halfExtents: [1, 0.2, 1] },
    });
  });
});
