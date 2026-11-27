// The blast in a world (FIRE-04 reading FIRE-05): a charge in the ExplosionSolver's explosions field loads a rigid box with
// the reflected positive-phase impulse over its face, at any frame rate and through a snapshot, and gives the overpressure
// at a point for sound and camera shake.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BlastSolver,
  blastAt,
  chargeEnergy,
  ExplosionSolver,
  energyBudget,
  freeAirEquivalent,
  impulseSoFar,
  overpressureAt,
} from '../../dist/explosive.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();
const zero = [0, 0, 0];
const charge = { position: [0, 0, 0], time: 0.05, mass: 1 };

function make({ rate = { num: 60, den: 1 }, breakables, mass = 100 } = {}) {
  const physics = new Physics(null, { gravity: zero, fixedTimestep: 1 / 60 });
  const box = physics.addBody(null, {
    position: [20, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 1, 1], mass },
  });
  const source = new ExplosionSolver('charge');
  const blast = new BlastSolver(source.explosionsField);
  const world = new PhysicsWorld({ rate, gravity: zero })
    .add(new RigidSolver(), { physics })
    .add(source, { charges: [charge] })
    .add(blast, { physics, breakables })
    .couple(['blast', 'rigid'], 'staggered');
  return { box, blast, world, physics };
}

test('the box takes the reflected impulse over its face, all of it, along the line from the charge', () => {
  const loads = [];
  // A box heavy enough not to move during the positive phase, so the impulse is the law's at 20 m.
  const { box, blast, world } = make({ mass: 1e4, breakables: { applyImpact: (_p, j) => loads.push(j) } });
  // Read it just after the positive phase (0.1 s), before a body this slow falls asleep.
  world.advance(9);
  const energy = freeAirEquivalent(energyBudget(chargeEnergy(1), 0));
  const point = blastAt(energy, 19.5 + 0.5);
  // The box's face toward the charge is 2 m by 2 m.
  const expected = impulseSoFar(point, Infinity, true) * 4;
  const v = box.linearVelocity;
  assert.ok(Math.abs(v[0] * 1e4 - expected) < 1e-5 * expected, `box ${v[0] * 1e4} N s against ${expected}`);
  assert.ok(Math.abs(v[1]) < 1e-9 && Math.abs(v[2]) < 1e-9);
  assert.ok(Math.abs(blast.counts.impulse - expected) < 1e-5 * expected);
  assert.ok(blast.counts.loads >= 1);
  const pushed = loads.reduce((a, j) => a + j[0], 0);
  assert.ok(Math.abs(pushed - blast.counts.impulse) < 1e-9 * expected, 'the breakable target took the same impulse');
  // The overpressure at a point: zero before the shock, the Friedlander value after.
  const at = [0, 0, 30];
  const p30 = blastAt(energy, 30);
  assert.equal(blast.pressureAt(at, 0.05 + p30.arrival * 0.99), 0);
  const t = 0.05 + p30.arrival + 0.3 * p30.duration;
  assert.ok(Math.abs(blast.pressureAt(at, t) - overpressureAt(p30, 0.3 * p30.duration)) < 1e-9 * p30.overpressure);
});

test('a light box that moves away during the pulse gets the whole impulse once: its front is never counted twice', () => {
  const { box, world } = make({ mass: 100 });
  world.advance(60);
  const energy = freeAirEquivalent(energyBudget(chargeEnergy(1), 0));
  const full = impulseSoFar(blastAt(energy, 20), Infinity, true) * 4;
  const got = box.linearVelocity[0] * 100;
  // A little under the full 20 m impulse (it moved off a few centimetres), never over it.
  assert.ok(got < full && got > 0.999 * full, `${got} against ${full}`);
});

test('the blast steps the same at 24, 30 and 60 frames a second, and a snapshot re-runs it bit for bit', () => {
  frameRateIndependent((rate) => make({ rate }).world, { seconds: 1 });
  seekEqualsContinuous(() => make({ rate: { num: 24, den: 1 } }).world);
});

test('a blast solver needs the explosions field and the Physics, and says so', () => {
  const coded = (error) => error?.code === 'unsupported' && error.message.includes('errors#explosives');
  assert.throws(() => new BlastSolver({ name: 'x', kind: 'particleSet' }), coded);
  const source = new ExplosionSolver('c2');
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(source, { charges: [charge] });
  assert.throws(() => world.add(new BlastSolver(source.explosionsField, 'b2'), {}), coded);
});
