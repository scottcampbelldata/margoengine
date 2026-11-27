// A gun on a rigid carrier (FIRE-05 with DYN-01, two-way): the carrier's mass is the recoiling mass of the gun's ballistics,
// the recoil goes into the carrier through bodyImpulses at the breech, the shot flies from the muzzle and the muzzle blast
// is published as an explosion. Frame-rate independent and seekable.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ExplosionSolver, FRAGMENT_WORDS, fireGun } from '../../dist/explosive.js';
import { Physics } from '../../dist/index.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();
const IN = 0.0254,
  LB = 0.45359237;
const sixInch = {
  bore: 6 * IN,
  travel: (6100 / (Math.PI * 9)) * IN,
  chamber: 730 * IN ** 3,
  shotMass: 100 * LB,
  charge: 13.25 * LB,
  web: 0.15 * IN,
};

function make({ rate = { num: 60, den: 1 }, breech = [0, 0, 0], mass = 7000, shotDrag = 0 } = {}) {
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
  const carrier = physics.addBody(null, {
    position: [0, 0, 0],
    colliders: { shape: 'box', halfExtents: [2, 1, 1], mass },
  });
  const solver = new ExplosionSolver('battery', { carriers: true });
  const world = new PhysicsWorld({ rate, gravity: [0, 0, 0] })
    .add(new RigidSolver(), { physics })
    .add(solver, { guns: [{ ...sixInch, time: 0.05, body: carrier.row, breech, axis: [1, 0, 0], shotDrag }] })
    .couple(['battery', 'rigid'], 'staggered');
  return { physics, carrier, solver, world };
}

test('the carrier recoils with the momentum its own mass gives the ballistics, and the shot leaves at the muzzle speed', () => {
  const { carrier, solver, world } = make();
  world.advance(30);
  const gun = solver.gun(0);
  assert.ok(gun.fired && gun.time === 0.05);
  // Two-way: the ballistics took the carrier's 7000 kg as the recoiling mass.
  const free = fireGun({ ...sixInch, recoilMass: 7000 });
  assert.ok(Math.abs(gun.recoilMomentum - free.recoilMomentum) < 1e-9 * free.recoilMomentum);
  const v = carrier.linearVelocity;
  assert.ok(
    Math.abs(-v[0] * 7000 - free.recoilMomentum) < 1e-3 * free.recoilMomentum,
    `carrier momentum ${-v[0] * 7000} against ${free.recoilMomentum}`,
  );
  assert.ok(Math.abs(v[1]) < 1e-6 && Math.abs(v[2]) < 1e-6, 'straight back along the bore');
  const shot = solver.fragments().slice(0, FRAGMENT_WORDS);
  assert.equal(shot[7], 1, 'the shot is in flight');
  assert.ok(Math.abs(shot[3] - free.shotVelocity) < 1e-6 * free.shotVelocity, `shot ${shot[3]}`);
  assert.ok(shot[0] > sixInch.travel, 'downrange of the muzzle');
  // A heavier carrier recoils slower and drives the shot a little slower relative to it.
  const heavy = make({ mass: 70000 });
  heavy.world.advance(30);
  assert.ok(-heavy.carrier.linearVelocity[0] < -v[0] / 5);
});

test('a gun mounted above the centre of mass pitches its carrier, and the muzzle blast is published when the shot leaves', () => {
  const { carrier, solver, world } = make({ breech: [0, 1, 0] });
  world.advance(2);
  assert.equal(solver.gun(0).fired, false, 'nothing before 0.05 s');
  assert.equal(solver.muzzleBlast(0).time, Infinity);
  world.advance(30);
  const w = carrier.angularVelocity;
  // J = -x I at r = +y: the torque y x (-x I) = +z I.
  assert.ok(w[2] > 0 && Math.abs(w[0]) < 1e-6 && Math.abs(w[1]) < 1e-6, `spin ${w}`);
  const blast = solver.muzzleBlast(0),
    free = fireGun({ ...sixInch, recoilMass: 7000 });
  assert.ok(blast.detonated && Math.abs(blast.time - (0.05 + free.muzzleTime)) < 1e-12, `blast at ${blast.time}`);
  assert.ok(Math.abs(blast.energy - free.muzzleGasEnergy) < 1e-9 * blast.energy);
  // The muzzle is the bore's travel ahead of the breech, which is 1 m above the carrier's centre.
  assert.ok(Math.abs(blast.position[0] - sixInch.travel) < 1e-6 && Math.abs(blast.position[1] - 1) < 1e-6);
});

test('the guns step the same at 24, 30 and 60 frames a second', () => {
  frameRateIndependent((rate) => make({ rate }).world, { seconds: 1 });
});

test('a snapshot and restore re-runs the firing bit for bit', () => {
  seekEqualsContinuous(() => make().world);
});

test('a gun on a body needs a solver made for carriers', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: 1 / 60 });
  const body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 1, 1], mass: 10 } });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics });
  assert.throws(
    () =>
      world.add(new ExplosionSolver(), { guns: [{ ...sixInch, body: body.row, breech: [0, 0, 0], axis: [1, 0, 0] }] }),
    /carriers: true/,
  );
  assert.throws(
    () =>
      world.add(new ExplosionSolver('b', { carriers: true }), {
        guns: [{ ...sixInch, body: 100000, breech: [0, 0, 0], axis: [1, 0, 0] }],
      }),
    /body must be a rigid body row/,
  );
  assert.throws(
    () => world.add(new ExplosionSolver('c'), { guns: [{ ...sixInch, breech: [0, 0, 0], axis: [0, 0, 0] }] }),
    /must not be zero/,
  );
});
