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
