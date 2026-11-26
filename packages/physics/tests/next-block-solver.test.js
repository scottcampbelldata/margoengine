// The block solver of a manifold's normal rows through `Physics`: on by default, a setting that reads back, and a stack that
// stands the same whichever way its contacts are solved.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const stand = (blockSolver) => {
  const physics = new Physics(null);
  if (blockSolver !== undefined) physics.setSolver({ blockSolver });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
  });
  const boxes = [0, 1, 2].map((i) =>
    physics.addBody(null, {
      position: [0, 0.5 + i, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
      canSleep: false,
    }),
  );
  for (let i = 0; i < 300; i++) physics.step();
  const out = boxes.map((b) => [...b.position]);
  const speed = Math.max(...boxes.map((b) => Math.hypot(...b.linearVelocity)));
  physics.dispose();
  return { out, speed };
};

test('the block solver is on by default, reads back, and takes a boolean only', async () => {
  await Physics.load();
  const physics = new Physics(null);
  assert.equal(physics.solver.blockSolver, true);
  physics.setSolver({ blockSolver: false });
  assert.equal(physics.solver.blockSolver, false);
  physics.setSolver({ blockSolver: true });
  assert.equal(physics.solver.blockSolver, true);
  physics.dispose();
});

test('a stack of three boxes stands where the sweeps leave it when its contacts are solved in blocks', async () => {
  await Physics.load();
  const sweeps = stand(false);
  const blocks = stand();
  assert.ok(blocks.speed < 1e-3, `still moving at ${blocks.speed} m/s`);
  sweeps.out.forEach((at, i) => {
    for (let k = 0; k < 3; k++)
      assert.ok(Math.abs(at[k] - blocks.out[i][k]) < 1e-3, `box ${i}: ${at} against ${blocks.out[i]}`);
  });
});
