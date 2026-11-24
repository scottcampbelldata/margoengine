// A shape cast whose shape turns (Rapier's `cast_shape_nonlinear`), by conservative advancement: the time it touches is a closed
// form, and a straight cast gives the same time as the straight one. The mechanics are proved in kernel/tests/cast.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MargoError } from '@margoengine/math/errors';
import { Physics } from '../dist/index.js';

await Physics.load();

test('a rod turning about its middle touches a ball above it when the closed form says', () => {
  const physics = new Physics(null);
  const ball = physics.addBody(null, {
    type: 'fixed',
    position: [0, 1.5, 0],
    colliders: { shape: 'sphere', radius: 0.25 },
  });
  physics.step();
  const rod = { shape: 'box', halfExtents: [2, 0.05, 0.05] };
  const spin = { linearVelocity: [0, 0, 0], angularVelocity: [0, 0, Math.PI] };
  const hit = physics.shapeCastNonlinear(rod, [0, 0, 0], [0, 0, 0, 1], spin, 1);
  assert.ok(hit && hit.body === ball, 'the turn reaches the ball');
  const wanted = Math.acos(0.3 / 1.5) / Math.PI;
  assert.ok(Math.abs(hit.distance - wanted) < 1e-3, `at ${hit.distance} s against ${wanted}`);
  assert.equal(
    physics.shapeCastNonlinear(rod, [0, 0, 0], [0, 0, 0, 1], spin, 0.4),
    null,
    'a turn that ends before it misses',
  );
  assert.equal(
    physics.shapeCastNonlinear(
      rod,
      [0, 0, 0],
      [0, 0, 0, 1],
      { linearVelocity: [3, 0, 0], angularVelocity: [0, 0, 0] },
      2,
    ),
    null,
    'a rod only sliding along x passes under the ball',
  );
  physics.dispose();
});

test('without a turn it gives the straight cast, as a time', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: { shape: 'box', halfExtents: [1, 1, 1] } });
  physics.step();
  const ball = { shape: 'sphere', radius: 0.5 };
  const straight = physics.shapeCast(ball, [-5, 0, 0], [0, 0, 0, 1], [1, 0, 0]);
  const timed = physics.shapeCastNonlinear(
    ball,
    [-5, 0, 0],
    [0, 0, 0, 1],
    { linearVelocity: [10, 0, 0], angularVelocity: [0, 0, 0] },
    1,
  );
  assert.ok(
    Math.abs(timed.distance - straight.distance / 10) < 1e-4,
    `${timed.distance} s against ${straight.distance} m`,
  );
  assert.deepEqual(
    timed.normal.map((v) => Math.round(v)),
    straight.normal.map((v) => Math.round(v)),
  );
  assert.throws(
    () =>
      physics.shapeCastNonlinear(
        ball,
        [0, 0, 0],
        [0, 0, 0, 1],
        { linearVelocity: [1, 0, 0], angularVelocity: [0, 0, 0] },
        -1,
      ),
    /0 or more seconds/,
  );
  assert.throws(
    () =>
      physics.shapeCastNonlinear(
        { shape: 'compound', parts: [{ shape: 'sphere', radius: 0.1 }] },
        [0, 0, 0],
        [0, 0, 0, 1],
        { linearVelocity: [1, 0, 0], angularVelocity: [0, 0, 0] },
        1,
      ),
    (error) => error instanceof MargoError && error.code === 'unsupported',
  );
  physics.dispose();
});
