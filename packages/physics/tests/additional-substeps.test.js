// Extra substeps for one island (`body.additionalSubsteps`, Rapier's `additional_solver_iterations`): the island steps at the
// world's substeps plus the most any of its bodies asks for, and the rest of the world as it would anyway.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
// Bad input to a body, collider, shape, query or mesh is a coded MargoError linking its help entry (Part 1, item 3).
const rigidCoded = (error) =>
  error?.name === 'MargoError' &&
  error.code === 'unsupported' &&
  /See https:..margoengine.com.errors#physics-(bodies|meshes)$/.test(error.message);

await Physics.load();

/** A double pendulum hung at `x` and a box dropped on a floor beside it; returns the bodies to read. */
function scene(physics, x) {
  const pivot = physics.addBody(null, { type: 'fixed', position: [x, 4, 0] }),
    upper = physics.addBody(null, {
      position: [x + 1, 4, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.05, 0.05], density: 500 },
    }),
    lower = physics.addBody(null, {
      position: [x + 2, 4, 0],
      colliders: { shape: 'sphere', radius: 0.15, density: 2000 },
    });
  physics.addJoint(pivot, upper, { type: 'spherical', anchorA: [0, 0, 0], anchorB: [-1, 0, 0] });
  physics.addJoint(upper, lower, { type: 'spherical', anchorA: [0.5, 0, 0], anchorB: [-0.5, 0, 0] });
  physics.addBody(null, {
    type: 'fixed',
    position: [x, -0.5, 3],
    colliders: { shape: 'box', halfExtents: [2, 0.5, 2] },
  });
  const box = physics.addBody(null, {
    position: [x, 1, 3],
    rotation: [0.1, 0.2, 0, 0.9747],
    colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3] },
  });
  return [upper, lower, box];
}
const state = (bodies) =>
  bodies.flatMap((b) => [...b.position, ...b.rotation, ...b.linearVelocity, ...b.angularVelocity]);

test('an island that asks extra substeps steps as a world of that many substeps, and the rest of the world as before', () => {
  for (const adaptiveSubsteps of [false, true]) {
    const run = (substeps, extra) => {
      const physics = new Physics(null);
      physics.substeps = substeps;
      physics.setSolver({ adaptiveSubsteps });
      const fine = scene(physics, 0),
        plain = scene(physics, 50);
      for (const body of fine) body.additionalSubsteps = extra;
      for (let i = 0; i < 240; i++) physics.step();
      const out = { fine: state(fine), plain: state(plain) };
      physics.dispose();
      return out;
    };
    const base = run(4, 0),
      four = run(8, 0),
      mixed = run(4, 4);
    // The island that asked for 4 more is the world of 8 substeps bit for bit; the one beside it the world of 4.
    assert.deepEqual(mixed.fine, four.fine, `adaptive ${adaptiveSubsteps}: the fine island is the world of 8 substeps`);
    assert.deepEqual(mixed.plain, base.plain, `adaptive ${adaptiveSubsteps}: the other island is the world of 4`);
    // And it is a different motion: the pendulum's chaos shows the substeps.
    assert.notDeepEqual(base.fine, four.fine);
  }
});

test('stepped phase by phase, all islands at once, the whole world takes the most extra substeps any island asks', () => {
  const run = (substeps, extra) => {
    const physics = new Physics(null);
    physics.substeps = substeps;
    physics.setSolver({ islandMajor: false, adaptiveSubsteps: false });
    const fine = scene(physics, 0),
      plain = scene(physics, 50);
    for (const body of fine) body.additionalSubsteps = extra;
    for (let i = 0; i < 240; i++) physics.step();
    const out = [...state(fine), ...state(plain)];
    physics.dispose();
    return out;
  };
  assert.deepEqual(run(4, 4), run(8, 0));
});

test('the extra substeps of an island are the most its bodies ask, and they are checked', () => {
  const physics = new Physics(null),
    [upper, lower] = scene(physics, 0);
  upper.additionalSubsteps = 1;
  lower.additionalSubsteps = 3;
  assert.equal(lower.additionalSubsteps, 3);
  assert.throws(() => (upper.additionalSubsteps = -1), rigidCoded);
  assert.throws(() => (upper.additionalSubsteps = 1.5), rigidCoded);
  physics.step();
  physics.dispose();
});
