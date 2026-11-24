// Linear damping and the gravity scale on the own solver, each held to a closed form and to Rapier's (`tests/oracle.js`, as a
// black box): damping takes the same implicit factor a step as angular damping, and a scaled gravity is a scaled free fall.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const DT = 1 / 60;
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);
const steps = (physics, count) => {
  for (let i = 0; i < count; i++) physics.step();
};
const worlds = (build, options) =>
  [new Physics(null, options), new RapierPhysics(null, options)].map((physics) => ({ physics, ...build(physics) }));
const dispose = (list) => list.forEach(({ physics }) => physics.dispose());
const ball = { shape: 'sphere', radius: 0.5, mass: 2 };

test('linear damping decays the speed by the implicit factor, towards exp(-c t), as Rapier does', () => {
  const c = 1.5,
    v0 = 6,
    list = worlds(
      (physics) => ({
        damped: physics.addBody(null, { linearDamping: c, linearVelocity: [v0, 0, 0], colliders: ball }),
        free: physics.addBody(null, { position: [0, 5, 0], linearVelocity: [v0, 0, 0], colliders: ball }),
        spinning: physics.addBody(null, {
          position: [0, 10, 0],
          linearDamping: c,
          angularVelocity: [0, 3, 0],
          colliders: ball,
        }),
      }),
      { gravity: [0, 0, 0] },
    );
  for (const { physics } of list) steps(physics, 60);
  const [own, rapier] = list;
  // Rapier takes one implicit step of dt; the own solver takes eight substeps of dt / 8, each the same form.
  near(rapier.damped.linearVelocity[0], v0 * (1 + c * DT) ** -60, 1e-3, 'Rapier follows its own factor');
  near(
    own.damped.linearVelocity[0],
    v0 * (1 + (c * DT) / 8) ** -480,
    1e-3,
    'the own solver follows its substeps factor',
  );
  near(own.damped.linearVelocity[0], v0 * Math.exp(-c), v0 * 0.03, 'and sits near exp(-c t)');
  near(own.damped.linearVelocity[0], rapier.damped.linearVelocity[0], v0 * 0.03, 'within a few per cent of Rapier');
  near(own.free.linearVelocity[0], v0, 1e-6, 'no damping, no loss');
  near(own.spinning.angularVelocity[1], 3, 1e-6, 'linear damping leaves the spin alone');
  // Distance: v0 (1 - e^-c) / c = 3.108 m; the own solver's substeps sit within 0.01 of it, Rapier's single implicit step a little further.
  near(own.damped.position[0], (v0 * (1 - Math.exp(-c))) / c, 0.03, 'the distance travelled is the closed form');
  near(own.damped.position[0], rapier.damped.position[0], 0.1, 'and agrees with Rapier within its coarser step');
  dispose(list);
});

test('damping and gravity act together as the implicit step of both: the speed of a falling body settles near g / c', () => {
  const c = 4,
    list = worlds((physics) => ({ body: physics.addBody(null, { linearDamping: c, colliders: ball }) }), {
      gravity: [0, -10, 0],
    });
  for (const { physics } of list) steps(physics, 300);
  const [own, rapier] = list;
  near(own.body.linearVelocity[1], -10 / c, 0.05, 'terminal speed g / c');
  near(own.body.linearVelocity[1], rapier.body.linearVelocity[1], 0.05, 'as Rapier');
  dispose(list);
});

for (const scale of [0.5, 2, -1]) {
  test(`a gravity scale of ${scale} makes ${scale} times the free fall, as Rapier does`, () => {
    const list = worlds(
      (physics) => ({ body: physics.addBody(null, { gravityScale: scale, position: [0, 100, 0], colliders: ball }) }),
      { gravity: [0, -10, 0] },
    );
    for (const { physics } of list) steps(physics, 30);
    const [own, rapier] = list;
    const t = 30 * DT;
    near(own.body.linearVelocity[1], -10 * scale * t, 0.05, 'v = g s t');
    near(own.body.linearVelocity[1], rapier.body.linearVelocity[1], 0.05, 'the speed agrees with Rapier');
    near(own.body.position[1] - 100, rapier.body.position[1] - 100, 0.05, 'and the fall agrees with Rapier');
    near(own.body.position[1] - 100, -0.5 * 10 * scale * t * t, 0.1, 'and sits near the closed form');
    dispose(list);
  });
}

test('the gravity scale can change at any time, and a body of scale 0 floats while another falls', () => {
  const list = worlds(
    (physics) => ({
      still: physics.addBody(null, { gravityScale: 0, canSleep: false, position: [0, 10, 0], colliders: ball }),
      falls: physics.addBody(null, { position: [3, 10, 0], colliders: ball }),
    }),
    { gravity: [0, -10, 0] },
  );
  for (const { physics } of list) steps(physics, 30);
  const [own, rapier] = list;
  near(own.still.linearVelocity[1], 0, 1e-6, 'scale 0 floats');
  own.still.gravityScale = 1;
  rapier.still.gravityScale = 1;
  steps(own.physics, 30);
  steps(rapier.physics, 30);
  near(own.still.linearVelocity[1], rapier.still.linearVelocity[1], 0.05, 'a scale set later falls as Rapier does');
  assert.ok(own.still.linearVelocity[1] < -4, 'it falls after the scale is restored');
  dispose(list);
});
