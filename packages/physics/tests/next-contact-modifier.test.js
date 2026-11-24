// The contact modifier (Rapier's MODIFY_SOLVER_CONTACTS hook): a one-way platform, a friction override, and the guards.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { RapierPhysics } from './oracle.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

test('a one-way platform lets a ball rise through it from below and holds it from above', () => {
  const physics = new Physics(null, {
    contactModifier: (contact) =>
      contact.oneWay(contact.first.body.type === 'fixed' ? contact.first : contact.second, [0, 1, 0]),
  });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, 3, 0],
    colliders: { shape: 'box', halfExtents: [3, 0.1, 3], modifyContacts: true },
  });
  const ball = physics.addBody(null, {
    position: [0, 1, 0],
    linearVelocity: [0, 12, 0],
    colliders: { shape: 'sphere', radius: 0.3 },
  });
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    physics.step();
    peak = Math.max(peak, ball.position[1]);
  }
  assert.ok(peak > 5, `rose through to ${peak}`);
  for (let i = 0; i < 240; i++) physics.step();
  // Fell back onto the top: rests on the platform's top face, 3.1 + 0.3.
  assert.ok(Math.abs(ball.position[1] - 3.4) < 0.02, `rests at ${ball.position[1]}`);
  physics.dispose();
});

test('a collider that did not ask is not shown, and the modifier can set friction', () => {
  const shown = [];
  const run = (friction) => {
    const physics = new Physics(null, {
      contactModifier: (contact) => {
        shown.push(contact.contactCount);
        if (friction !== undefined) contact.friction = friction;
      },
    });
    const angle = 0.3;
    physics.addBody(null, {
      type: 'fixed',
      rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
      colliders: { shape: 'box', halfExtents: [20, 0.5, 5], friction: 0.9, modifyContacts: friction !== undefined },
    });
    const crate = physics.addBody(null, {
      position: [-Math.sin(angle) * 0.5 - 0.0, Math.cos(angle) * 1.01, 0],
      rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], friction: 0.9 },
    });
    for (let i = 0; i < 120; i++) physics.step();
    const moved = Math.hypot(crate.position[0] + Math.sin(angle) * 0.5, crate.position[1] - Math.cos(angle) * 1.01);
    physics.dispose();
    return moved;
  };
  assert.ok(run(undefined) < 0.2, 'friction 0.9 holds a 0.3 rad slope');
  assert.equal(shown.length, 0, 'no collider asked for the modifier');
  assert.ok(run(0) > 1, 'friction 0 from the modifier lets it slide');
  assert.ok(shown.length > 0 && shown.every((n) => n > 0));
});

test('modifyContacts needs a modifier, and Rapier has none', () => {
  const physics = new Physics(null);
  assert.throws(
    () => physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 1, 1], modifyContacts: true } }),
    /contactModifier/,
  );
  physics.dispose();
  const rapier = new RapierPhysics(null);
  assert.throws(
    () => rapier.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 1, 1], modifyContacts: true } }),
    /own solver/,
  );
  rapier.dispose();
});

test('a surface velocity carries a box along a belt, and stops when the modifier stops', () => {
  const belt = (speed) => {
    const physics = new Physics(null, {
      contactModifier: (contact) => {
        // The belt is the pair's fixed collider; the box is the other, whichever of the two comes first.
        const beltFirst = contact.first.body.type === 'fixed';
        contact.surfaceVelocity = beltFirst ? [speed, 0, 0] : [-speed, 0, 0];
      },
    });
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [40, 0.5, 5], friction: 1, modifyContacts: true },
    });
    const crate = physics.addBody(null, {
      position: [0, 0.5, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], friction: 1 },
    });
    for (let i = 0; i < 120; i++) physics.step();
    const result = { x: crate.position[0], speed: crate.linearVelocity?.[0] ?? crate.getLinearVelocity?.()[0] };
    physics.dispose();
    return result;
  };
  const moving = belt(3);
  assert.ok(moving.x > 4 && moving.x < 6.5, `carried to ${moving.x}`);
  assert.ok(Math.abs(belt(0).x) < 0.05, 'a belt at rest holds it');
  assert.ok(belt(-3).x < -4, 'the other way');
});

/** A ball dropped on a floor of the given material; the modifier sees the pair when `modify` is set. */
function dropped(modifier, floorOptions = {}, ballOptions = {}) {
  const physics = new Physics(null, { contactModifier: modifier });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10], modifyContacts: true, ...floorOptions },
  });
  const ball = physics.addBody(null, {
    position: [0, 1.5, 0],
    canSleep: false,
    colliders: { shape: 'sphere', radius: 0.5, ...ballOptions },
  });
  return { physics, ball };
}

test('the modifier can set restitution: a ball that would stay down bounces back', () => {
  const rebound = (restitution) => {
    const { physics, ball } = dropped(
      restitution === undefined ? () => {} : (contact) => (contact.restitution = restitution),
    );
    let up = 0;
    for (let i = 0; i < 90; i++) {
      physics.step();
      up = Math.max(up, ball.linearVelocity[1]);
    }
    physics.dispose();
    return up;
  };
  const dead = rebound(undefined),
    live = rebound(0.8);
  assert.ok(dead < 0.1, `no restitution, no bounce (${dead})`);
  // It fell 1 m (4.4 m/s): 80% of it comes back.
  assert.ok(Math.abs(live - 0.8 * Math.sqrt(2 * 9.81)) < 0.4, `restitution 0.8 gives back about 3.5 m/s (${live})`);
});

test('the modifier can clear a pair, and set its normal', () => {
  const cleared = dropped((contact) => contact.clear());
  for (let i = 0; i < 90; i++) cleared.physics.step();
  assert.ok(cleared.ball.position[1] < -2, `a cleared pair holds nothing (${cleared.ball.position[1]})`);
  cleared.physics.dispose();
  // A tilted normal pushes the ball along its horizontal share, as a slope would.
  const tilt = [0.6, 0.8, 0];
  const pushed = dropped(
    (contact) => (contact.normal = contact.first.body.type === 'fixed' ? tilt : [-tilt[0], -tilt[1], -tilt[2]]),
  );
  for (let i = 0; i < 60; i++) pushed.physics.step();
  assert.ok(
    Math.abs(pushed.ball.linearVelocity[0]) > 0.3,
    `the ball is pushed sideways (${pushed.ball.linearVelocity[0]})`,
  );
  pushed.physics.dispose();
});

test('the modifier keeps a word with the pair, which lasts as long as the pair does', () => {
  const seen = [];
  const physics = new Physics(null, {
    contactModifier: (contact) => {
      seen.push(contact.userData);
      contact.userData = contact.userData + 1;
    },
  });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10], modifyContacts: true },
  });
  const ball = physics.addBody(null, {
    position: [0, 0.5, 0],
    canSleep: false,
    colliders: { shape: 'sphere', radius: 0.5 },
  });
  for (let i = 0; i < 6; i++) physics.step();
  assert.deepEqual(
    seen.slice(0, 5),
    [0, 1, 2, 3, 4],
    'a new pair starts at 0 and the word counts the steps it was shown',
  );
  ball.setPosition([0, 30, 0]);
  for (let i = 0; i < 3; i++) physics.step();
  ball.setPosition([0, 0.5, 0]);
  seen.length = 0;
  for (let i = 0; i < 3; i++) physics.step();
  assert.equal(seen[0], 0, 'a pair that ended and began again starts over');
  physics.dispose();
});

test("the modifier can move a contact point's distance and anchors, and the solver follows", () => {
  const rest = (edit) => {
    const physics = new Physics(null, { contactModifier: edit });
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [10, 0.5, 10], modifyContacts: true },
    });
    const crate = physics.addBody(null, {
      position: [0, 0.5, 0],
      canSleep: false,
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    });
    let spin = 0;
    for (let i = 0; i < 120; i++) {
      physics.step();
      spin = Math.max(spin, Math.hypot(...crate.angularVelocity));
    }
    const out = { y: crate.position[1], spin };
    physics.dispose();
    return out;
  };
  const plain = rest(() => {}),
    sunk = rest((contact) => {
      for (let k = 0; k < contact.contactCount; k++) contact.point(k).distance += 0.1;
    }),
    shifted = rest((contact) => {
      for (let k = 0; k < contact.contactCount; k++) {
        const point = contact.point(k);
        const [, y, z] = point.anchorB;
        // Every point moved off the crate's side: the floor can only press where the crate is not, so it tips the crate over.
        point.anchorB = [0.6, y, z];
      }
    });
  assert.ok(Math.abs(plain.y - 0.5) < 0.01, `rests on its floor (${plain.y})`);
  assert.ok(plain.y - sunk.y > 0.05, `a contact that reads 0.1 m further apart lets the crate sink (${sunk.y})`);
  assert.ok(
    shifted.spin > plain.spin + 0.5,
    `anchors moved off its side press where it is not and turn it (${shifted.spin} against ${plain.spin})`,
  );
  const physics = new Physics(null, {
    contactModifier: (contact) => {
      assert.throws(() => contact.point(9), /contact points/);
      assert.throws(() => (contact.userData = -1), /whole number/);
      assert.throws(() => (contact.point(0).distance = Number.NaN), /finite/);
    },
  });
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [5, 0.5, 5], modifyContacts: true } });
  physics.addBody(null, { position: [0, 0.99, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  for (let i = 0; i < 3; i++) physics.step();
  physics.dispose();
});
