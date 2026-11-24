// The pair filter's third answer: 'noForces' finds a pair's contacts and fires its events but pushes nothing, as Rapier's
// contact hook answering with no solver flags. false still lets the pair pass and keeps its events quiet.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

function drop(World, answer) {
  const physics = new World(null, { gravity: [0, -10, 0], contactFilter: () => answer });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [5, 0.5, 5] },
  });
  const ball = physics.addBody(null, { position: [0, 0.7, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  let started = 0;
  physics.on('contactstart', () => started++);
  for (let i = 0; i < 90; i++) physics.step();
  return { y: ball.position[1], started };
}

for (const World of [Physics, RapierPhysics]) {
  const name = World === Physics ? 'own kernel' : 'Rapier';
  test(`${name}: noForces lets a ball sink through the floor but fires contactstart`, () => {
    const { y, started } = drop(World, 'noForces');
    assert.ok(y < -1, `${name} fell through: y ${y}`);
    assert.equal(started, 1, `${name} contactstart events`);
  });
  test(`${name}: false lets it through and keeps events quiet; true rests it`, () => {
    const passed = drop(World, false);
    assert.ok(passed.y < -1 && passed.started === 0, `${name} false: ${JSON.stringify(passed)}`);
    const solved = drop(World, true);
    assert.ok(Math.abs(solved.y - 0.5) < 0.05 && solved.started === 1, `${name} true: ${JSON.stringify(solved)}`);
  });
}
