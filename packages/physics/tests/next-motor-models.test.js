// A joint motor's two models, per axis: 'acceleration' turns the gains into an acceleration, so a heavy body and a light one
// follow it alike, and 'force' turns them into a force, so the heavy one is slower by its mass. A velocity motor of damping c
// toward v on a body of mass (or inertia) m gives dv/dt = (c / m or c) (v_target - v), so after t the speed is
// v_target (1 - e^-(rate t)); held on the hinge and the slide of the root entry and on the axes of a generic joint, each
// against Rapier (`tests/oracle.js`, as a black box) where it has the same joint.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);
const TARGET = 4,
  DAMPING = 2,
  SECONDS = 0.3;
const LIGHT = 1,
  HEAVY = 4;

/** A body of `mass` kg joined to a fixed one by `joint`, with a velocity motor of the given model; its speed after SECONDS. */
function speedAfter(World, joint, model, mass, read) {
  const physics = new World(null, { gravity: [0, 0, 0] });
  const anchor = physics.addBody(null, { type: 'fixed', colliders: [] });
  const body = physics.addBody(null, {
    canSleep: false,
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass },
  });
  physics.addJoint(anchor, body, joint({ targetVelocity: TARGET, damping: DAMPING, model }));
  for (let i = 0; i < Math.round(SECONDS * 60); i++) physics.step();
  const speed = read(body);
  physics.dispose();
  return speed;
}
// A cube of mass m has inertia m (1 + 1) / 12 = m / 6 about any axis through its centre.
const inertia = (mass) => mass / 6;

const hinge = (motor) => ({ type: 'revolute', axis: [0, 0, 1], motor });
const slide = (motor) => ({ type: 'prismatic', axis: [1, 0, 0], motor });

for (const [name, joint, read, scale] of [
  ['a hinge', hinge, (body) => body.angularVelocity[2], inertia],
  ['a prismatic joint', slide, (body) => body.linearVelocity[0], (mass) => mass],
]) {
  test(`${name}: the acceleration model follows its target alike for a light and a heavy body, the force model does not, as Rapier's`, () => {
    for (const World of [Physics, RapierPhysics]) {
      const label = World === Physics ? 'own' : 'Rapier';
      const [lightA, heavyA] = [LIGHT, HEAVY].map((m) => speedAfter(World, joint, 'acceleration', m, read));
      const [lightF, heavyF] = [LIGHT, HEAVY].map((m) => speedAfter(World, joint, 'force', m, read));
      near(lightA, heavyA, 0.05 * TARGET, `${label}: acceleration, mass makes no difference`);
      assert.ok(lightA > 0.3 * TARGET && lightA < 0.9 * TARGET, `${label}: it is on its way to the target (${lightA})`);
      assert.ok(lightF > heavyF * 1.5, `${label}: force, the heavy body lags (${lightF} against ${heavyF})`);
      // The rate is damping over the mass (or inertia) in the force model: v = target (1 - e^-(c t / m)).
      const expected = (m) => TARGET * (1 - Math.exp(-(DAMPING * SECONDS) / scale(m)));
      near(lightF, expected(LIGHT), 0.12 * TARGET, `${label}: the force model follows c / m`);
      near(heavyF, expected(HEAVY), 0.12 * TARGET, `${label}: and the heavy one too`);
    }
    const own = [LIGHT, HEAVY].map((m) => speedAfter(Physics, joint, 'force', m, read)),
      rapier = [LIGHT, HEAVY].map((m) => speedAfter(RapierPhysics, joint, 'force', m, read));
    near(own[0], rapier[0], 0.15 * TARGET, 'the light body agrees with Rapier');
    near(own[1], rapier[1], 0.15 * TARGET, 'the heavy body agrees with Rapier');
  });
}

test('a generic joint takes a model per axis: a sliding axis and a turning axis of one joint each follow their own', () => {
  const generic = (linModel, angModel) => (extra) => ({
    type: 'generic',
    locked: ['linY', 'linZ', 'angX', 'angY'],
    motors: {
      linX: { ...extra, model: linModel },
      angZ: { ...extra, model: angModel },
    },
  });
  const read = (body) => [body.linearVelocity[0], body.angularVelocity[2]];
  const run = (linModel, angModel, mass) => speedAfter(Physics, generic(linModel, angModel), linModel, mass, read);
  const [lightLin, lightAng] = run('acceleration', 'force', LIGHT),
    [heavyLin, heavyAng] = run('acceleration', 'force', HEAVY);
  near(lightLin, heavyLin, 0.05 * TARGET, 'the sliding axis on the acceleration model ignores the mass');
  assert.ok(
    lightAng > heavyAng * 1.5,
    `while the turning axis on the force model lags with it (${lightAng} against ${heavyAng})`,
  );
  const [lightSwapLin, lightSwapAng] = run('force', 'acceleration', LIGHT),
    [heavySwapLin, heavySwapAng] = run('force', 'acceleration', HEAVY);
  near(lightSwapAng, heavySwapAng, 0.05 * TARGET, 'swapped, the turn ignores the mass');
  assert.ok(lightSwapLin > heavySwapLin * 1.5, 'and the slide now lags');
});
