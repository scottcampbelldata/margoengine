// @margoengine/ragdoll/balance: a powered ragdoll on the real Knight rig, on a floor in a stepping Rapier world, pushed by
// setting the upper body moving. The controller is an assist, and these tests read what it gave.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ragdoll } from '../dist/index.js';
import { addRagdollBalance } from '../dist/balance.js';
import { fitRagdollShapes } from '../dist/hulls.js';
import { addRagdollMotors } from '../dist/powered.js';
import { humanoidProfile, ragdollOptions } from '../dist/profile.js';
import { realRig, skip } from './rig.js';

const rtest = (name, fn) => test(name, { skip, timeout: 60_000 }, fn);
const bones = (rig) => ({
  hips: rig.node('hips'),
  spine: rig.node('spine'),
  chest: rig.node('chest'),
  head: rig.node('head'),
  ...Object.fromEntries(
    [
      ['left', 'l'],
      ['right', 'r'],
    ].flatMap(([side, s]) => [
      [`${side}UpperArm`, rig.node(`upperarm.${s}`)],
      [`${side}LowerArm`, rig.node(`lowerarm.${s}`)],
      [`${side}Hand`, rig.node(`hand.${s}`)],
      [`${side}UpperLeg`, rig.node(`upperleg.${s}`)],
      [`${side}LowerLeg`, rig.node(`lowerleg.${s}`)],
      [`${side}Foot`, rig.node(`foot.${s}`)],
    ]),
  ),
});

async function standing({ balance = true, ...options } = {}) {
  const rig = await realRig('kaykit/adventurers/characters/Knight.glb');
  rig.frames(1);
  const ragdoll = Ragdoll.attach(
    rig.physics,
    ragdollOptions(humanoidProfile(rig.model.nodes, { bones: bones(rig), mass: 30 }), rig.model.nodes),
  );
  fitRagdollShapes(ragdoll, rig.model);
  const motors = addRagdollMotors(ragdoll, { frequency: 8 }),
    feet = [rig.node('foot.l'), rig.node('foot.r')],
    keeper = balance ? addRagdollBalance(ragdoll, motors, { feet, ...options }) : null,
    hips = ragdoll.bones[0].body,
    height = hips.position[1],
    upper = ragdoll.bones.filter((part) => !/leg|foot|toes/.test(part.node.name));
  ragdoll.activate();
  const push = (x, z) => {
    for (const { body } of upper) {
      const v = body.linearVelocity;
      body.setLinearVelocity([v[0] + x, v[1], v[2] + z]);
    }
  };
  return { rig, ragdoll, motors, keeper, hips, height, push, feet };
}

rtest('without it the character folds up; with it the same character settles, stands and takes no more steps', async () => {
  const limp = await standing({ balance: false });
  limp.rig.frames(180);
  assert.ok(limp.hips.position[1] < limp.height * 0.85, `motors alone sink (${limp.hips.position[1]} of ${limp.height})`);
  limp.rig.dispose();

  const { rig, keeper, hips, height } = await standing();
  // Letting go of a straight-legged pose sags and takes a few steps (docs/limits.md); after that nothing moves.
  rig.frames(120);
  const start = [...hips.position],
    settled = keeper.steps;
  rig.frames(240);
  assert.equal(keeper.state, 'standing');
  assert.ok(hips.position[1] > height * 0.8, `standing (${hips.position[1]} of ${height})`);
  assert.ok(keeper.tilt < 0.15, `upright (${keeper.tilt} rad)`);
  assert.ok(Math.hypot(hips.position[0] - start[0], hips.position[2] - start[2]) < 0.1, 'and stays where it was');
  assert.equal(keeper.steps, settled, 'no step unasked');
  rig.dispose();
});

for (const [label, x, z] of [
  ['forward', 0, 1.5],
  ['backward', 0, -1.5],
  ['to its left', 1.5, 0],
  ['to its right', -1.5, 0],
])
  rtest(`pushed ${label} it steps that way, catches itself and stands`, async () => {
    const { rig, ragdoll, keeper, hips, height, push, feet } = await standing();
    rig.frames(120);
    const before = keeper.steps,
      was = hips.position,
      bodies = feet.map((foot) => ragdoll.part(foot).body),
      feetWere = bodies.map((body) => [...body.position]);
    const along = (a, b) => ((a[0] - b[0]) * x + (a[2] - b[2]) * z) / Math.hypot(x, z);
    let went = 0,
      moved = 0;
    push(x, z);
    rig.frames(240, 1 / 60, () => {
      went = Math.max(went, along(hips.position, was));
      bodies.forEach((body, i) => (moved = Math.max(moved, along(body.position, feetWere[i]))));
    });
    assert.notEqual(keeper.state, 'fallen');
    assert.ok(keeper.steps > before, 'it stepped');
    assert.ok(hips.position[1] > height * 0.8, `still up (${hips.position[1]} of ${height})`);
    assert.ok(keeper.tilt < 0.3, `upright (${keeper.tilt} rad)`);
    assert.ok(went > 0.02, `the body went with the push (${went} m)`);
    assert.ok(moved > 0.02, `and a foot went that way (${moved} m)`);
    rig.frames(120);
    const speed = Math.hypot(...hips.linearVelocity);
    assert.ok(speed < 0.5, `and it has stopped (${speed} m/s)`);
    rig.dispose();
  });

rtest('a harder blow than the caps hold knocks it over, the assist stops, and reset stands it again', async () => {
  const { rig, keeper, push, ragdoll } = await standing({ maxUpright: 10 });
  rig.frames(120);
  push(0, 6);
  rig.frames(180);
  assert.equal(keeper.state, 'fallen');
  assert.equal(keeper.carried, 0, 'no help is given once down');
  assert.ok(keeper.tilt > 1, `down (${keeper.tilt} rad)`);
  assert.equal(ragdoll.active, true);
  keeper.reset();
  assert.equal(keeper.state, 'standing');
  rig.dispose();
});

rtest('the help it gives is capped and reported', async () => {
  const { rig, keeper } = await standing({ carry: 0.5 });
  let most = 0;
  rig.frames(240, 1 / 60, () => (most = Math.max(most, keeper.carried)));
  // At most 1.5 times the carried share of the upper body's weight: the upper body is about 0.6 of the mass.
  assert.ok(most > 0.1 && most <= 0.5 * 1.5, `carried ${most} of the body's weight at most`);
  rig.dispose();
});

rtest('options and rigs are checked, and dispose hands the legs back', async () => {
  const { rig, ragdoll, motors, keeper, feet } = await standing();
  assert.throws(() => addRagdollBalance(null, motors, { feet }), { name: 'TypeError' });
  assert.throws(() => addRagdollBalance(ragdoll, {}, { feet }), { name: 'TypeError' });
  assert.throws(() => addRagdollBalance(ragdoll, motors, {}), { name: 'TypeError' });
  assert.throws(() => addRagdollBalance(ragdoll, motors, { feet: [rig.engine.createMesh(), feet[1]] }), {
    name: 'RangeError',
    message: /not a bone/,
  });
  assert.throws(() => addRagdollBalance(ragdoll, motors, { feet: [rig.node('head'), feet[1]] }), {
    name: 'RangeError',
    message: /knee hinge/,
  });
  assert.throws(() => addRagdollBalance(ragdoll, motors, { feet, carry: 2 }), { name: 'RangeError' });
  keeper.dispose();
  keeper.dispose();
  assert.throws(() => keeper.reset(), { code: 'disposed' });
  rig.frames(120);
  assert.equal(keeper.steps, 0, 'nothing runs after dispose');
  rig.dispose();
});
