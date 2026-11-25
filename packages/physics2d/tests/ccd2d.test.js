// Continuous collision impacts a step, through the facade: one stops a fast ball where it touches, more answer each touch and carry
// the ball on, 0 turns it off. The kernel's own proof is kernel/tests/ccd.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

/** A ball fired along a corridor between two thin walls at 1000 m/s: a step takes it 16.67 m, 5.7 m a leg. */
function corridor(substeps) {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  if (substeps !== undefined) physics.setSolver({ maxCcdSubsteps: substeps });
  for (const x of [-3, 3])
    physics.addBody(null, {
      type: 'fixed',
      position: [x, 0],
      colliders: { shape: 'box', width: 0.1, height: 10, restitution: 1, friction: 0 },
    });
  const ball = physics.addBody(null, {
    ccd: true,
    canSleep: false,
    linearVelocity: [1000, 0],
    colliders: { shape: 'circle', radius: 0.1, restitution: 1, friction: 0 },
  });
  return { physics, ball };
}

test('the limit reads back, defaults to 1, and takes only whole numbers from 0 to 65535', () => {
  const { physics } = corridor();
  assert.equal(physics.solver.maxCcdSubsteps, 1);
  physics.setSolver({ maxCcdSubsteps: 4 });
  assert.equal(physics.solver.maxCcdSubsteps, 4);
  for (const bad of [-1, 1.5, Number.NaN, 65536])
    assert.throws(() => physics.setSolver({ maxCcdSubsteps: bad }), RangeError);
  assert.equal(physics.solver.maxCcdSubsteps, 4, 'a refused value changes nothing');
  const bytes = physics.snapshot();
  physics.setSolver({ maxCcdSubsteps: 0 });
  physics.restore(bytes);
  assert.equal(physics.solver.maxCcdSubsteps, 4, 'a snapshot carries it');
});

test('more impacts a step carry a ball on between two walls: 0 goes through, 1 stops at the first, 4 comes back', () => {
  const x = (substeps) => {
    const { physics, ball } = corridor(substeps);
    physics.step();
    return [ball.position[0], ball.linearVelocity[0]];
  };
  const [off, offV] = x(0);
  assert.ok(Math.abs(off - 16.667) < 0.02 && Math.abs(offV - 1000) < 1, `off: ${off}`);
  const [one, oneV] = x(1);
  assert.ok(Math.abs(one - 2.85) < 0.01 && Math.abs(oneV - 1000) < 1, `1: ${one}`);
  // Three impacts answered (the third at the first wall again) and a fourth sweep that meets nothing: 0.433 m, going left.
  const [four, fourV] = x(4);
  assert.ok(Math.abs(four - 0.433) < 0.05 && Math.abs(fourV + 1000) < 1, `4: ${four}, ${fourV}`);
});
