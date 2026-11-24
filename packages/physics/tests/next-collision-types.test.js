// Active collision types and contact-force thresholds on the own solver. The kernel's side is in kernel/tests/collision_types.rs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const box = (extra = {}) => ({ shape: 'box', halfExtents: [0.5, 0.5, 0.5], ...extra });

test('two kinematic bodies start and end a contact only when both colliders name kinematicKinematic', () => {
  const run = (a, b) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const mover = physics.addBody(null, {
      type: 'kinematicVelocity',
      position: [-3, 0, 0],
      linearVelocity: [3, 0, 0],
      colliders: box(a),
    });
    physics.addBody(null, { type: 'kinematicPosition', position: [0, 0, 0], colliders: box(b) });
    const seen = [];
    physics.on('contactstart', () => seen.push('start'));
    physics.on('contactend', () => seen.push('end'));
    for (let i = 0; i < 180; i++) physics.step();
    physics.dispose();
    return { seen, mover };
  };
  const kinds = { activeCollisionTypes: ['kinematicKinematic'] };
  assert.deepEqual(run({}, {}).seen, []);
  assert.deepEqual(run(kinds, {}).seen, [], 'one side alone is not enough');
  assert.deepEqual(run(kinds, kinds).seen, ['start', 'end']);
});

test('leaving out dynamicFixed lets a box fall through a floor, and adding it back stops the fall', () => {
  const physics = new Physics(null);
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: box({ halfExtents: [5, 0.5, 5], activeCollisionTypes: ['dynamicDynamic'] }),
  });
  const body = physics.addBody(null, { position: [0, 3, 0], colliders: box() });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(body.position[1] < -1, `fell through ${body.position[1]}`);
  assert.deepEqual(floor.colliders[0].activeCollisionTypes(), ['dynamicDynamic']);
  floor.colliders[0].setActiveCollisionTypes(['dynamicFixed']);
  const second = physics.addBody(null, { position: [0, 3, 0], colliders: box() });
  for (let i = 0; i < 240; i++) physics.step();
  assert.ok(Math.abs(second.position[1] - 0.5) < 0.02, `rests ${second.position[1]}`);
  physics.dispose();
});

test('a sensor sees every kind of body pair', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.addBody(null, { type: 'fixed', colliders: box({ sensor: true }) });
  physics.addBody(null, { type: 'kinematicPosition', position: [0.5, 0, 0], colliders: box() });
  let started = 0;
  physics.on('intersectionstart', () => started++);
  for (let i = 0; i < 5; i++) physics.step();
  assert.equal(started, 1);
  physics.dispose();
});

test('an unknown pair kind is refused with the kinds to use', () => {
  const physics = new Physics(null);
  assert.throws(() => physics.addBody(null, { colliders: box({ activeCollisionTypes: ['wall'] }) }), /dynamicDynamic/);
  physics.dispose();
});

test('a contact-force event needs the force to pass the larger threshold, and a collider can opt out', () => {
  const run = (floorOptions, boxOptions) => {
    const physics = new Physics(null);
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: box({ halfExtents: [5, 0.5, 5], ...floorOptions }),
    });
    physics.addBody(null, { position: [0, 3, 0], colliders: box({ mass: 3, ...boxOptions }) });
    let hardest = 0,
      count = 0;
    physics.on('contactforce', ({ force }) => {
      count++;
      hardest = Math.max(hardest, force);
    });
    for (let i = 0; i < 120; i++) physics.step();
    physics.dispose();
    return { hardest, count };
  };
  const open = run({}, {});
  assert.ok(open.count > 1 && open.hardest > 29.43, `${open.count} ${open.hardest}`);
  // Resting presses with its weight, 29.43 N: a threshold above that leaves the landing alone.
  const high = run({}, { contactForceThreshold: 60 });
  assert.ok(high.count >= 1 && high.count < open.count, `${high.count} of ${open.count}`);
  const huge = run({ contactForceThreshold: 1e9 }, {});
  assert.equal(huge.count, 0);
  assert.equal(run({ contactForceEvents: false }, { contactForceEvents: false }).count, 0);
  assert.throws(() => run({ contactForceThreshold: -1 }, {}), /threshold/);
});
