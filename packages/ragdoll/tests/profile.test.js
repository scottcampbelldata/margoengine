// @margoengine/ragdoll/profile: a tuned ragdoll saved as JSON and rebuilt on a fresh copy of the real rig, and the humanoid
// preset on real rigs in a stepping solver world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ragdoll } from '../dist/index.js';
import { fitRagdollShapes } from '../dist/hulls.js';
import { humanoidProfile, ragdollOptions, saveRagdollProfile } from '../dist/profile.js';
import { realRig } from './rig.js';

const rtest = (name, fn) => test(name, { timeout: 60_000 }, fn);
const KNIGHT = 'kaykit/adventurers/characters/Knight.glb';
const kaykit = (rig) => ({
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
async function knight() {
  const rig = await realRig(KNIGHT);
  rig.frames(1);
  return rig;
}

rtest('a tuned ragdoll comes back the same on a fresh rig through JSON, and two loads fall the same to the last bit', async () => {
  const first = await knight(),
    tuned = Ragdoll.attach(first.physics, {
      ...ragdollOptions(humanoidProfile(first.model.nodes, { bones: kaykit(first), mass: 82 }), first.model.nodes),
      friction: 0.9,
      linearDamping: 0.1,
      angularDamping: 1.2,
      limitStiffness: 0.3,
    });
  fitRagdollShapes(tuned, first.model);
  tuned.setShape(first.node('foot.l'), {
    type: 'box',
    center: [0, 0.05, 0],
    halfExtents: [0.05, 0.1, 0.04],
    rotation: [0, 0, 0, 1],
  });
  const saved = JSON.stringify(saveRagdollProfile(tuned)),
    second = await knight(),
    third = await knight(),
    again = Ragdoll.attach(second.physics, ragdollOptions(JSON.parse(saved), second.model.nodes)),
    twin = Ragdoll.attach(third.physics, ragdollOptions(JSON.parse(saved), third.model.nodes));
  assert.deepEqual(again.settings, tuned.settings);
  assert.equal(again.bones.length, tuned.bones.length);
  tuned.bones.forEach((part, i) => {
    const copy = again.bones[i];
    assert.equal(copy.node.name, part.node.name);
    assert.deepEqual(copy.spec, part.spec);
    for (const key of ['length', 'radius', 'mass', 'parent']) assert.equal(copy[key], part[key], `${part.node.name} ${key}`);
    assert.equal(copy.shape.type, part.shape.type);
    assert.ok(Math.abs(copy.body.mass - part.body.mass) < 1e-6);
  });
  // Two loads of one profile are the same ragdoll. The tuned one is not compared: it swapped colliders while live, so
  // The solver holds them under other handles and solves its contacts in another order.
  for (const [rig, ragdoll] of [
    [third, twin],
    [second, again],
  ]) {
    ragdoll.activate();
    ragdoll.part(rig.node('chest')).body.applyImpulse([0, 0, -30]);
    rig.frames(120);
  }
  twin.bones.forEach((part, i) => assert.deepEqual(again.bones[i].body.position, part.body.position, part.node.name));
  first.dispose();
  second.dispose();
  third.dispose();
});

rtest('the humanoid preset weighs what was asked, by published shares, with every bone of the body', async () => {
  const rig = await knight(),
    profile = humanoidProfile(rig.model.nodes, { bones: kaykit(rig), mass: 80 }),
    mass = (name) => profile.bones.find((bone) => bone.name === name).mass;
  assert.ok(Math.abs(profile.bones.reduce((sum, bone) => sum + bone.mass, 0) - 80) < 1e-9);
  // de Leva 1996: thigh 14.16%, shank 4.33%, head 6.94%.
  assert.ok(Math.abs(mass('upperleg.l') - 80 * 0.1416) < 1e-9);
  assert.ok(Math.abs(mass('lowerleg.r') - 80 * 0.0433) < 1e-9);
  assert.ok(Math.abs(mass('head') - 80 * 0.0694) < 1e-9);
  // wrist is no humanoid bone, but the hand hangs from it, so it joins the hand's share.
  assert.ok(Math.abs(mass('wrist.l') + mass('hand.l') - 80 * 0.0061) < 1e-9);
  const ragdoll = Ragdoll.attach(rig.physics, ragdollOptions(profile, rig.model.nodes));
  assert.deepEqual(
    ragdoll.bones.map((part) => part.node.name).sort(),
    profile.bones.map((bone) => bone.name).sort(),
  );
  assert.ok(ragdoll.part(rig.node('head')), 'a head with no child bone is a bone here');
  rig.dispose();
});

/** The angle of `part` from its rest pose about its hinge. */
function hingeAngle(ragdoll, part) {
  const up = ragdoll.bones[part.parent].body.rotation,
    now = part.body.rotation,
    conj = (q) => [-q[0], -q[1], -q[2], q[3]],
    mul = (a, b) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ],
    d = mul(conj(mul(up, [...part.rest])), now),
    a = part.spec.axis,
    along = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
  return 2 * Math.atan2(along, d[3]);
}

for (const [bone, label, push] of [
  ['lowerleg.l', 'a knee', [0, 0, -3]],
  ['lowerarm.r', 'an elbow', [0, 0, 3]],
])
  rtest(`${label} bends the way a body does and not the other way`, async () => {
    // The forearm or shin alone is limp, hanging from a limb that holds its pose, so only this joint can move.
    for (const [sign, bends] of [
      [1, true],
      [-1, false],
    ]) {
      const rig = await realRig(KNIGHT, { gravity: [0, 0, 0] });
      rig.frames(1);
      const ragdoll = Ragdoll.attach(rig.physics, ragdollOptions(humanoidProfile(rig.model.nodes, { bones: kaykit(rig) }), rig.model.nodes)),
        part = ragdoll.part(rig.node(bone));
      assert.equal(part.spec.type, 'hinge');
      rig.frames(5);
      ragdoll.activate(part);
      const body = part.body,
        tip = [0, 0, 0],
        mass = body.mass;
      assert.deepEqual(tip, [0, 0, 0]);
      body.applyImpulse(push.map((v) => v * sign * mass));
      rig.frames(30);
      const angle = hingeAngle(ragdoll, part);
      if (bends) assert.ok(angle > 0.3, `${bone} bent to ${angle} rad`);
      else assert.ok(angle < 0.1, `${bone} stayed straight (${angle} rad)`);
      rig.frames(120);
      assert.ok(hingeAngle(ragdoll, part) <= part.spec.limits[1] + 0.1, 'and stops at its range');
      rig.dispose();
    }
  });

rtest('the preset lies down on the floor with its knees and elbows inside their ranges', async () => {
  const rig = await knight(),
    ragdoll = Ragdoll.attach(rig.physics, ragdollOptions(humanoidProfile(rig.model.nodes, { bones: kaykit(rig) }), rig.model.nodes));
  fitRagdollShapes(ragdoll, rig.model);
  ragdoll.activate();
  ragdoll.part(rig.node('chest')).body.applyImpulse([0, 0, -300]);
  rig.frames(600);
  for (const part of ragdoll.bones) {
    assert.ok(part.body.position.every(Number.isFinite));
    assert.ok(part.body.position[1] > -0.05 && part.body.position[1] < 1, `${part.node.name} is on the floor`);
    if (part.spec?.type === 'hinge') {
      const angle = hingeAngle(ragdoll, part);
      assert.ok(angle > -0.15 && angle < part.spec.limits[1] + 0.15, `${part.node.name} inside its range (${angle})`);
    }
  }
  rig.dispose();
});

rtest('names a preset knows need no map', async () => {
  // Stand-in names: the real Knight rig with its bones renamed the way Mixamo names them.
  const names = {
      hips: 'Hips',
      spine: 'Spine',
      chest: 'Spine1',
      head: 'Head',
      ...Object.fromEntries(
        [
          ['l', 'Left'],
          ['r', 'Right'],
        ].flatMap(([s, Side]) => [
          [`upperarm.${s}`, `${Side}Arm`],
          [`lowerarm.${s}`, `${Side}ForeArm`],
          [`hand.${s}`, `${Side}Hand`],
          [`upperleg.${s}`, `${Side}UpLeg`],
          [`lowerleg.${s}`, `${Side}Leg`],
          [`foot.${s}`, `${Side}Foot`],
        ]),
      ),
    },
    rig = await realRig(KNIGHT, {
      edit(asset) {
        for (const node of asset.doc.nodes) if (names[node.name]) node.name = `mixamorig:${names[node.name]}`;
      },
    });
  rig.frames(1);
  const profile = humanoidProfile(rig.model.nodes),
    ragdoll = Ragdoll.attach(rig.physics, ragdollOptions(profile, rig.model.nodes));
  assert.equal(ragdoll.part(rig.node('mixamorig:LeftLeg')).spec.type, 'hinge');
  assert.equal(ragdoll.bones.length, 18, 'every named bone, and the wrists between');
  rig.dispose();
});

rtest('bad profiles are refused with what to do', async () => {
  const rig = await knight(),
    { nodes } = rig.model,
    good = humanoidProfile(nodes, { bones: kaykit(rig) });
  assert.throws(() => ragdollOptions(null, nodes), { name: 'TypeError' });
  assert.throws(() => ragdollOptions(good, null), { name: 'TypeError' });
  assert.throws(() => ragdollOptions({ ...good, format: 'other' }, nodes), { name: 'RangeError', message: /format/ });
  assert.throws(() => ragdollOptions({ ...good, version: 2 }, nodes), { name: 'RangeError', message: /version 2/ });
  assert.throws(() => ragdollOptions({ ...good, bones: [] }, nodes), { name: 'RangeError' });
  assert.throws(() => ragdollOptions({ ...good, bones: [{ name: 'tail' }] }, nodes), {
    name: 'RangeError',
    message: /"tail"/,
  });
  assert.throws(() => humanoidProfile(nodes), { name: 'RangeError', message: /options\.bones/ });
  assert.throws(() => humanoidProfile(nodes, { bones: kaykit(rig), mass: 0 }), { name: 'RangeError' });
  assert.throws(() => humanoidProfile(null), { name: 'TypeError' });
  assert.throws(() => saveRagdollProfile({}), { name: 'TypeError' });
  rig.dispose();
});
