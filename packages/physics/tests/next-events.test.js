// Events, sensors, groups, the filter, dominance and disabling through the names of the own entry, on the numbers
// tests/physics.test.js holds the root entry to. The mechanics are proved in kernel/tests/events.rs; here each option has to
// reach the kernel and mean what packages/physics/README.md says.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, collisionGroups } from '../dist/next.js';

await Physics.load();

const near = (got, want, within, what) => assert.ok(Math.abs(got - want) <= within, `${what}: ${got} against ${want}`);
const ground = (physics, options = {}) =>
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [20, 0.5, 20], ...options } });
const run = (physics, seconds) => {
  for (let i = 0; i < seconds * 60; i++) physics.step();
};
const TYPES = ['intersectionstart', 'intersectionend', 'contactstart', 'contactend'];
const listen = (physics) => {
  const log = [];
  for (const type of TYPES) physics.on(type, (event) => log.push(event));
  return log;
};

test('sensors fire intersection start and end events and push nothing', () => {
  const physics = new Physics(null),
    trigger = physics.addBody(null, {
      type: 'fixed',
      position: [0, 3, 0],
      colliders: { shape: 'box', halfExtents: [2, 0.25, 2], sensor: true },
    }),
    ball = physics.addBody(null, { position: [0, 6, 0], colliders: { shape: 'sphere', radius: 0.3 } }),
    log = listen(physics);
  ground(physics);
  assert.equal(trigger.colliders[0].isSensor(), true);
  run(physics, 2.5);
  assert.deepEqual(
    log.filter((event) => event.sensor).map((event) => event.type),
    ['intersectionstart', 'intersectionend'],
  );
  const enter = log.find((event) => event.type === 'intersectionstart'),
    contact = log.find((event) => event.type === 'contactstart');
  assert.ok(enter.sensor && !contact.sensor);
  assert.deepEqual(new Set([enter.bodyA, enter.bodyB]), new Set([trigger, ball]));
  assert.ok(enter.colliderA.body === enter.bodyA && enter.meshA === null);
  assert.deepEqual(physics.contactPoints(trigger), [], 'a sensor has no contact points');
  assert.equal(physics.touching(trigger, ball), false);
  physics.dispose();
});

test('sensors also fire for kinematic bodies such as characters', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [3, 1, 0], colliders: { shape: 'box', halfExtents: [0.5, 1, 1], sensor: true } });
  const character = physics.addBody(null, {
      type: 'kinematicPosition',
      position: [0, 1, 0],
      colliders: { shape: 'capsule', halfHeight: 0.4, radius: 0.3 },
    }),
    events = [];
  physics.on('intersectionstart', () => events.push('enter'));
  physics.on('intersectionend', () => events.push('exit'));
  for (let i = 0; i < 120; i++) {
    character.setNextPosition([character.position[0] + 0.1, 1, 0]);
    physics.step();
  }
  assert.deepEqual(events, ['enter', 'exit']);
  physics.dispose();
});

test('contact events name both sides, and a collider with events off stays quiet alone', () => {
  const physics = new Physics(null),
    floor = ground(physics),
    box = physics.addBody(null, { position: [0, 0.6, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }),
    log = listen(physics);
  run(physics, 0.5);
  assert.deepEqual(log.map((event) => event.type), ['contactstart']);
  assert.deepEqual(new Set([log[0].bodyA, log[0].bodyB]), new Set([floor, box]));
  box.setPosition([0, 5, 0]);
  physics.step();
  assert.deepEqual(log.map((event) => event.type), ['contactstart', 'contactend']);
  physics.dispose();

  const quiet = new Physics(null),
    calm = [];
  ground(quiet, { events: false });
  quiet.addBody(null, { position: [0, 0.6, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], events: false } });
  quiet.addBody(null, { position: [3, 0.6, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  quiet.on('contactstart', (event) => calm.push(event));
  run(quiet, 0.5);
  assert.equal(calm.length, 1, 'the pair with one side asking says so; the pair with neither does not');
  quiet.dispose();
});

test('a listener may step: each step gathers into its own list', () => {
  const physics = new Physics(null);
  ground(physics);
  physics.addBody(null, { position: [0, 0.5, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  const types = [];
  physics.on('contactstart', (event) => {
    types.push(event.type);
    physics.step();
  });
  run(physics, 0.25);
  assert.deepEqual(types, ['contactstart']);
  physics.dispose();
});

test('collision groups decide who collides, solver groups who is solved', () => {
  const physics = new Physics(null);
  ground(physics, { collisionGroups: collisionGroups([0], [0, 1]), solverGroups: collisionGroups([0], [0]) });
  const ghost = physics.addBody(null, {
      position: [-3, 1, 0],
      colliders: { shape: 'sphere', radius: 0.5, collisionGroups: collisionGroups([2], [2]) },
    }),
    heavy = physics.addBody(null, {
      position: [0, 1, 0],
      colliders: { shape: 'sphere', radius: 0.5, collisionGroups: collisionGroups([1], [0]) },
    }),
    unsolved = physics.addBody(null, {
      position: [3, 1, 0],
      colliders: { shape: 'sphere', radius: 0.5, solverGroups: collisionGroups([3], [3]) },
    }),
    log = listen(physics);
  run(physics, 1);
  assert.ok(ghost.position[1] < -1, 'group-filtered body falls through the ground');
  near(heavy.position[1], 0.5, 0.01, 'grouped body rests');
  assert.ok(unsolved.position[1] < -1, 'a pair not solved does not hold');
  assert.ok(log.some((event) => event.type === 'contactstart' && (event.bodyA === unsolved || event.bodyB === unsolved)), 'it says so');
  assert.ok(!log.some((event) => event.bodyA === ghost || event.bodyB === ghost));
  const collider = heavy.colliders[0],
    groups = collisionGroups(1, 2);
  assert.equal(collider.setCollisionGroups(groups).collisionGroups(), groups);
  assert.equal(collider.setSolverGroups(groups).solverGroups(), groups);
  run(physics, 1);
  assert.ok(heavy.position[1] < -1, 'groups set later reach the pair: it falls');
  physics.dispose();
});

test('a contact filter decides pair by pair', () => {
  let filtered = 0;
  const physics = new Physics(null, {
    contactFilter: (a, b) => {
      filtered++;
      return !(a.userData === 'ghost' || b.userData === 'ghost');
    },
  });
  ground(physics);
  const passer = physics.addBody(null, { position: [0, 1, 0], userData: 'ghost', colliders: { shape: 'sphere', radius: 0.5 } }),
    lander = physics.addBody(null, { position: [2, 1, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  run(physics, 1);
  assert.ok(filtered > 0 && passer.position[1] < -1 && Math.abs(lander.position[1] - 0.5) < 0.02, 'contact filter lets the ghost through');
  physics.dispose();
});

test('a filter sees true bodies though the step grew the world, and may not step', () => {
  const seen = new Set(),
    physics = new Physics(null, {
      contactFilter: (a, b) => {
        seen.add(a.position[1]);
        seen.add(b.position[1]);
        return true;
      },
    });
  ground(physics);
  for (let i = 0; i < 40; i++) physics.addBody(null, { position: [i % 8, 1 + (i >> 3), 0], colliders: { shape: 'sphere', radius: 0.5 } });
  run(physics, 0.5);
  assert.ok(seen.size > 4, 'it read poses in the step');
  physics.dispose();

  const hasty = new Physics(null, {
    contactFilter: () => {
      hasty.step();
      return true;
    },
  });
  ground(hasty);
  hasty.addBody(null, { position: [0, 0.4, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  assert.throws(() => hasty.step(), { code: 'state', message: /may only read/ });
  hasty.dispose();
});

test('a higher dominance is a wall to a lower one, and nothing to a floor', () => {
  const physics = new Physics(null),
    pair = (dominance) => {
      physics.gravity = [0, 0, 0];
      const left = physics.addBody(null, {
          position: [-2, 10 * dominance, 0],
          linearVelocity: [2, 0, 0],
          dominance,
          colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
        }),
        right = physics.addBody(null, {
          position: [2, 10 * dominance, 0],
          linearVelocity: [-2, 0, 0],
          colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
        });
      return { left, right };
    },
    even = pair(0),
    ruling = pair(1);
  run(physics, 1.5);
  near(even.left.linearVelocity[0], 0, 0.02, 'equal: head on, they stop');
  near(ruling.left.linearVelocity[0], 2, 0.02, 'the higher keeps its speed');
  near(ruling.right.linearVelocity[0], 2, 0.02, 'the lower leaves with the wall');
  physics.dispose();

  const standing = new Physics(null);
  ground(standing);
  const box = standing.addBody(null, { position: [0, 0.5, 0], dominance: 5, colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  run(standing, 1);
  near(box.position[1], 0.5, 0.01, 'the floor still holds it');
  standing.dispose();
});

test('a disabled body leaves the world and comes back; a disabled collider touches nothing', () => {
  const physics = new Physics(null),
    floor = ground(physics),
    lower = physics.addBody(null, { position: [0, 0.5, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }),
    upper = physics.addBody(null, { position: [0, 1.5, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }),
    log = listen(physics);
  run(physics, 1);
  assert.equal(lower.enabled, true);
  log.length = 0;
  lower.enabled = false;
  assert.equal(lower.enabled, false);
  physics.step();
  assert.deepEqual(log.map((event) => event.type), ['contactend', 'contactend']);
  const held = lower.position;
  run(physics, 1);
  assert.deepEqual(lower.position, held, 'it stays');
  near(upper.position[1], 0.5, 0.01, 'what stood on it came down to the floor');
  upper.setPosition([0, 3, 0]);
  lower.enabled = true;
  run(physics, 2);
  near(upper.position[1], 1.5, 0.02, 'and it holds again');
  const collider = lower.colliders[0];
  assert.equal(collider.setEnabled(false).isEnabled(), false);
  run(physics, 1);
  assert.ok(lower.position[1] < -1, 'with no collider it falls through the floor');
  near(upper.position[1], 0.5, 0.02, 'and what it held comes down');
  assert.equal(collider.setEnabled(true).isEnabled(), true);
  assert.equal(floor.colliders[0].setSensor(true).isSensor(), true);
  run(physics, 1);
  assert.ok(upper.position[1] < 0, 'a floor made a sensor holds nothing');
  physics.dispose();
  assert.throws(() => collider.isEnabled(), { code: 'state' });
  assert.throws(() => lower.enabled, { code: 'state' });
});

test('a collider made enabled: false joins switched off', () => {
  const physics = new Physics(null),
    body = physics.addBody(null, { position: [0, 1, 0], colliders: { shape: 'sphere', radius: 0.5, enabled: false } });
  ground(physics);
  assert.equal(body.colliders[0].isEnabled(), false);
  run(physics, 1);
  assert.ok(body.position[1] < -1);
  physics.dispose();
});
