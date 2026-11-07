// `Physics.load()`: the solver is got ready once per app, then `new Physics(engine)` stays synchronous. This file runs in
// its own process, so nothing has loaded when it starts. The sharing and the retry are in tests/load-once.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';

test('Physics.load readies the solver, and a world then needs nothing else', async (t) => {
  t.mock.method(console, 'warn', () => {}); // the solver's own notice about its init arguments
  assert.throws(() => new Physics(null), { name: 'MargoError', code: 'state' });
  await assert.rejects(Physics.load({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.throws(() => new Physics(null), { name: 'MargoError', code: 'state' }, 'an aborted call loads nothing');

  await Physics.load();
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, -10, 0], interpolate: false }),
    body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  for (let i = 0; i < 60; i++) physics.step();
  // One second of free fall at 10 m/s² is 5 m; a first-order step of 1/60 s is off by at most g t dt / 2, 0.0834 m.
  assert.ok(Math.abs(body.position[1] + 5) < 0.0834, `fell to ${body.position[1]}`);
  const other = Physics.attach(null);
  assert.equal(other.bodyCount, 0, 'another world from the same load');
  other.dispose();
  physics.dispose();
});
