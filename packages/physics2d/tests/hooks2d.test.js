// Pair hooks through the facade: the contact filter is asked of pairs of solids, the intersection filter of pairs with a sensor in
// them (Rapier's `FILTER_CONTACT_PAIRS` and `FILTER_INTERSECTION_PAIRS`), and a collider can change what it asks later.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

/** A sensor zone with two balls dropped through it, one beside the other, and a floor under them. */
function scene() {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 10] });
  const hooks = { filterPair: true, filterIntersection: true };
  const zone = physics.addBody(null, {
    type: 'fixed',
    position: [0, 20],
    colliders: { shape: 'box', width: 100, height: 4, sensor: true, hooks },
  });
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, 60],
    colliders: { shape: 'box', width: 100, height: 4, hooks },
  });
  const mk = (x) => physics.addBody(null, { position: [x, 0], colliders: { shape: 'circle', radius: 1, hooks } });
  return { physics, zone, floor, left: mk(-20), right: mk(20) };
}

test('the intersection filter is asked of sensor pairs, the contact filter of solid pairs, and a veto stops the events', () => {
  const { physics, zone, left, right } = scene();
  const asked = { pair: [], intersection: [] };
  physics.hooks = {
    filterPair: (a, b) => (asked.pair.push([a.body, b.body]), true),
    // The zone does not sense the left ball.
    filterIntersection: (a, b) => (asked.intersection.push([a.body, b.body]), a.body !== left && b.body !== left),
  };
  const started = [];
  physics.on('intersectionstart', (e) => started.push(e.bodyA === left || e.bodyB === left ? 'left' : 'right'));
  for (let i = 0; i < 300; i++) physics.step();
  assert.deepEqual([...new Set(started)], ['right'], 'only the pair the filter allowed intersects');
  assert.ok(
    asked.intersection.length > 0 && asked.intersection.every(([a, b]) => a === zone || b === zone),
    'asked of the sensor pairs only',
  );
  assert.ok(
    asked.pair.length > 0 && asked.pair.every(([a, b]) => a !== zone && b !== zone),
    'the contact filter is never asked of a sensor pair',
  );
  assert.ok(right.position[1] < 60 && left.position[1] < 60, 'both balls land on the floor');
  physics.dispose();
});

test('a collider changes what it asks the hooks and reads it back; one that asks nothing is never asked', () => {
  const { physics, zone, floor, left, right } = scene();
  const sensor = zone.colliders[0];
  assert.deepEqual(sensor.activeHooks, { filterPair: true, filterIntersection: true, modifyContact: false });
  sensor.setActiveHooks({ filterIntersection: false, modifyContact: true });
  assert.deepEqual(sensor.activeHooks, { filterPair: false, filterIntersection: false, modifyContact: true });
  // Hooks that veto everything: while a collider asks, they are asked and the veto holds.
  let asked = 0;
  physics.hooks = {
    filterPair: () => (asked++, false),
    filterIntersection: () => (asked++, false),
  };
  const started = [];
  physics.on('intersectionstart', (e) => started.push(e));
  for (let i = 0; i < 150; i++) physics.step();
  assert.ok(asked > 0, 'the balls and the floor still ask');
  assert.equal(started.length, 0, 'and the veto holds');
  // Every collider stops asking: the veto is never put. The balls, which the veto let through the floor, are put back above it.
  for (const [ball, x] of [
    [left, -20],
    [right, 20],
  ]) {
    ball.teleport([x, 0]);
    ball.linearVelocity = [0, 0];
  }
  for (const body of [zone, floor, left, right]) body.colliders[0].setActiveHooks({});
  asked = 0;
  for (let i = 0; i < 300; i++) physics.step();
  assert.equal(asked, 0, 'a collider that asks nothing is never asked');
  assert.ok(started.length > 0, 'the zone senses the balls');
  assert.ok(
    left.position[1] < 60 && right.position[1] < 60 && left.position[1] > 40,
    `the balls rest on the floor: ${left.position[1]}`,
  );
  physics.dispose();
});
