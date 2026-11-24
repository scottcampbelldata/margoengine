// The joint settings of the solver, behaviourally: how much of a joint's error closes a substep (jointShare where the solve is
// exact, jointLooseShare where joints meet in a ring) and the fastest a joint pushes it shut (jointMaxPush).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();
const sphere = { shape: 'sphere', radius: 0.1, mass: 1 };

/** A fixed anchor and a body 1 m off it, joined at their centres: an error of 1 m to close. */
const pair = (solver) => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.setSolver(solver);
  const anchor = physics.addBody(null, { type: 'fixed', colliders: { shape: 'sphere', radius: 0.1 } });
  const body = physics.addBody(null, { position: [1, 0, 0], canSleep: false, colliders: sphere });
  physics.addJoint(anchor, body, { type: 'spherical', anchorA: [0, 0, 0], anchorB: [0, 0, 0] });
  return { physics, gap: () => Math.hypot(...body.position) };
};
const run = (world, seconds) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) world.physics.step();
  return world.gap();
};

test('jointMaxPush is the fastest a joint pushes an error shut, in metres a second', () => {
  const slow = run(pair({ jointMaxPush: 0.5 }), 0.4),
    fast = run(pair({ jointMaxPush: 3 }), 0.4);
  // 0.4 s at 0.5 m/s closes at most 0.2 m, with a little room for the velocity the push leaves.
  assert.ok(slow > 1 - 0.5 * 0.4 * 1.25, `closed to ${slow} m at 0.5 m/s`);
  assert.ok(slow < 0.95, `and it does close: ${slow}`);
  assert.ok(fast < 0.5, `3 m/s closes far more in the same time: ${fast}`);
  assert.ok(fast < slow - 0.3, 'a bigger cap closes faster');
});

test('jointShare is the share of an exact joint closed a substep: 0 leaves the error, 1 closes it, between is between', () => {
  const none = run(pair({ jointShare: 0 }), 1),
    some = run(pair({ jointShare: 0.05, jointMaxPush: 1000 }), 0.1),
    all = run(pair({ jointShare: 1, jointMaxPush: 1000 }), 0.1);
  assert.ok(none > 0.9, `a share of 0 leaves ${none} m`);
  assert.ok(all < 0.05, `a share of 1 closes it in 0.1 s: ${all}`);
  // Each substep closes the share of what is left: after 0.1 s of substeps, (1 - share) to that power.
  const substeps = pair({}).physics.substeps,
    left = 0.95 ** (6 * substeps);
  assert.ok(Math.abs(some - left) < 0.01, `a share of 0.05 leaves ${left} of the metre, not ${some}`);
});

/** A ring of four bodies joined end to end, one joint 0.5 m longer than the others: an error for the ring to share out. */
const ring = (solver) => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.setSolver({ jointMaxPush: 1000, ...solver });
  const spots = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  const bodies = spots.map((position, i) => physics.addBody(null, { position, canSleep: false, colliders: sphere }));
  bodies.forEach((body, i) => {
    const next = bodies[(i + 1) % 4];
    physics.addJoint(body, next, {
      type: 'spherical',
      anchorA: [0, 0, 0],
      anchorB: i === 3 ? [0.5, 0, 0] : [0, 0, 0],
    });
  });
  // The error the ring still holds: the sum of its joints' gaps, in metres.
  const residual = () =>
    bodies.reduce((sum, body, i) => {
      const next = bodies[(i + 1) % 4],
        offset = i === 3 ? 0.5 : 0;
      return (
        sum +
        Math.hypot(
          body.position[0] - (next.position[0] + offset),
          body.position[1] - next.position[1],
          body.position[2] - next.position[2],
        )
      );
    }, 0);
  return { physics, gap: residual };
};

test('jointLooseShare is the share a ring of joints closes a substep: 0 leaves the ring as it is, the default closes it, and a pair ignores it', () => {
  const start = ring({}).gap(),
    none = run(ring({ jointLooseShare: 0 }), 0.5),
    some = run(ring({ jointLooseShare: 0.2 }), 0.5);
  assert.ok(none > start * 0.9, `a share of 0 leaves the ring's error: ${none} of ${start}`);
  assert.ok(some < none * 0.8, `0.2 closes it: ${some} against ${none}`);
  // An exact pair is closed by jointShare alone.
  const a = run(pair({ jointLooseShare: 0.02 }), 0.2),
    b = run(pair({ jointLooseShare: 0.9 }), 0.2);
  assert.ok(Math.abs(a - b) < 1e-6, `a pair does not read jointLooseShare: ${a} and ${b}`);
});
