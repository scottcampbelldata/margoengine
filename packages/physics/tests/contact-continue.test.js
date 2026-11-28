// contactcontinue (DYN-01, Babylon's COLLISION_CONTINUED): once a step for each solid pair that touched before the step
// and still touches after it, never in the step a pair starts or ends, and never for sensors.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

const world = () => {
  const physics = new Physics(null);
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const crate = physics.addBody(null, {
    position: [0, 0.6, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
  });
  const sensor = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [2, 2, 2], sensor: true },
  });
  const log = [];
  for (const type of ['contactstart', 'contactcontinue', 'contactend', 'intersectionstart'])
    physics.on(type, (event) => log.push([physics.stepCount, type, event.bodyA === crate || event.bodyB === crate]));
  return { physics, floor, crate, sensor, log };
};

test('a crate landing on a floor starts once, continues every later step it stays, and ends once when lifted', () => {
  const { physics, crate, log } = world();
  for (let i = 0; i < 60; i++) physics.step();
  const contacts = log.filter(([, type]) => type.startsWith('contact'));
  const start = contacts.findIndex(([, type]) => type === 'contactstart');
  assert.ok(start >= 0, 'the crate lands');
  const startStep = contacts[start][0];
  assert.ok(
    contacts.slice(0, start).every(([, type]) => type !== 'contactcontinue'),
    'nothing continues before it starts',
  );
  const continued = contacts.filter(([, type]) => type === 'contactcontinue');
  assert.deepEqual(
    continued.map(([step]) => step),
    Array.from({ length: 60 - startStep }, (_, i) => startStep + 1 + i),
    'one continue a step after the start, none in the start step',
  );
  assert.ok(
    continued.every(([, , mine]) => mine),
    'the pair is the crate and the floor',
  );
  crate.setPosition([0, 6, 0]).setLinearVelocity([0, 0, 0]);
  const before = log.length;
  physics.step();
  const after = log.slice(before);
  assert.deepEqual(
    after.filter(([, type]) => type.startsWith('contact')).map(([, type]) => type),
    ['contactend'],
    'lifted: it ends and does not continue',
  );
  physics.step();
  assert.ok(!log.slice(before).some(([, type]) => type === 'contactcontinue'));
});

test('a sensor overlap never continues, and with no listener nothing is gathered', () => {
  const { physics, log } = world();
  for (let i = 0; i < 30; i++) physics.step();
  assert.ok(
    log.some(([, type]) => type === 'intersectionstart'),
    'the sensor saw the crate',
  );
  const continued = log.filter(([, type]) => type === 'contactcontinue').length;
  assert.ok(continued > 0);
  // The sensor overlaps the crate and the floor all along; only the crate and the floor continue, one event a step.
  const steps = new Set(log.filter(([, type]) => type === 'contactcontinue').map(([step]) => step));
  assert.equal(steps.size, continued, 'one continue a step: the sensor pairs give none');
});

test('continue events replay the same after a snapshot and restore', () => {
  const { physics, log } = world();
  for (let i = 0; i < 10; i++) physics.step();
  const snapshot = physics.takeSnapshot(),
    run = () => {
      const from = log.length;
      for (let i = 0; i < 40; i++) physics.step();
      return log.slice(from).map(([, type, mine]) => `${type}:${mine}`);
    },
    first = run();
  physics.restoreSnapshot(snapshot);
  assert.deepEqual(run(), first);
});
