// `Physics2D.load()`: the solver is got ready once per app, then `new Physics2D(engine)` stays synchronous. This file runs
// in its own process, so nothing has loaded when it starts. The sharing and the retry are in tests/load-once.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

test('Physics2D.load readies the solver, and a world then needs nothing else', async (t) => {
  assert.throws(() => new Physics2D(null), { name: 'MargoError', code: 'state', message: /await Physics2D\.load\(\)/ });
  await assert.rejects(Physics2D.load({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.throws(() => Physics2D.attach(null), { name: 'MargoError', code: 'state' }, 'an aborted call loads nothing');
  assert.throws(() => new Physics2D(null, { rapier: {} }), { name: 'TypeError', message: /initialized module/ });

  await Physics2D.load();
  await Physics2D.load();
  // Y is down in 2D, and one metre is one unit here.
  const physics = new Physics2D(null, { gravity: [0, 10], pixelsPerMeter: 1, interpolate: false }),
    body = physics.addBody(null, { colliders: { shape: 'circle', radius: 1 } });
  for (let i = 0; i < 60; i++) physics.step();
  // One second of free fall at 10 m/s² is 5 m; a first-order step of 1/60 s is off by at most g t dt / 2, 0.0834 m.
  assert.ok(Math.abs(body.position[1] - 5) < 0.0834, `fell to ${body.position[1]}`);
  physics.dispose();
});
