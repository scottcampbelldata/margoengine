// The anatomy core on real rig shapes: the same body in a T pose, an A pose and arms down, with rolled bone axes, mirrored,
// and with a bent elbow modelled in, must read the same clinical angles and bend every hinge the anatomical way.
// Guards the faults Scott saw in the human demos (elbows bent backwards, KB-RIG-ARMS2): before this entry nothing in the
// engine knew which way a straight elbow bends, and limits were opt in per rig ("Omitted joints are free").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addAnatomyLimits,
  bound,
  clampPose,
  defineSpecies,
  fitAnatomy,
  hingeRolls,
  ikLimits,
  jointAngles,
  kinematicsLimits,
  mirrorJoint,
  poseFromAngles,
  poseLimits,
  ragdollJoints,
  readJointAngles,
  regionAngles,
} from '../dist/anatomy.js';
import { fitHuman, human } from '../dist/anatomy-human.js';
import { PoseJointLimits } from '../dist/joint-limits.js';
import {
  addHand,
  bodyRig,
  forward,
  qaxis,
  qconj,
  qmul,
  qrot,
  random,
  rolled,
  stickRig,
  sub,
  unit,
  dot,
  cross,
} from './anatomy-fixtures.js';

const RAD = Math.PI / 180;
const close = (a, b, tolerance, what) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} is not within ${tolerance} of ${b}`);
const boneAt = (body, pose, name) => forward(body.parents, pose).pos[body.names.indexOf(name)];
const heading = (body, pose, from, to) => unit(sub(boneAt(body, pose, to), boneAt(body, pose, from)));

// Every shape of the one body. In each, +z is the way the feet point.
const SHAPES = {
  'T pose': () => bodyRig({ arms: 90 }),
  'A pose': () => bodyRig({ arms: 45 }),
  'arms down': () => bodyRig({ arms: 0 }),
  'T pose, rolled bone axes': () => rolled(bodyRig({ arms: 90 }), 11),
  'A pose, rolled bone axes': () => rolled(bodyRig({ arms: 45 }), 12),
  'T pose, mirrored': () => bodyRig({ arms: 90, mirror: true }),
  'arms down, mirrored and rolled': () => rolled(bodyRig({ arms: 0, mirror: true }), 13),
  'A pose, elbows modelled bent 46 degrees': () => bodyRig({ arms: 45, elbow: 46 }),
  'T pose, knees modelled bent 12 degrees': () => bodyRig({ arms: 90, knee: 12 }),
};

test('the fit reads the facing, the rest pose and the stature from joint positions', () => {
  const t = fitHuman(bodyRig({ arms: 90 }));
  assert.equal(t.preset, 'segments');
  assert.equal(t.restPose, 'T');
  assert.equal(t.mirrored, false);
  assert.equal(t.limits, true);
  assert.deepEqual(
    t.frame.left.map((v) => Math.round(v * 1e9) / 1e9 + 0),
    [1, 0, 0],
  );
  assert.deepEqual(
    t.frame.forward.map((v) => Math.round(v * 1e9) / 1e9 + 0),
    [0, 0, 1],
  );
  // Hip 0.90 m above the floor and ankle 0.07 m: the survey's leg share gives a body near 1.75 m.
  close(t.stature, 1.745, 0.03, 'stature');
  close(t.joints[t.index.get('l_shoulder')].rest.abduction, 90, 1e-6, 'T pose arm abduction');
  assert.equal(fitHuman(bodyRig({ arms: 45 })).restPose, 'A');
  assert.equal(fitHuman(bodyRig({ arms: 0 })).restPose, 'arms-down');
  const mirrored = fitHuman(bodyRig({ arms: 90, mirror: true }));
  assert.equal(mirrored.mirrored, true);
  assert.deepEqual(
    mirrored.frame.forward.map((v) => Math.round(v * 1e9) / 1e9 + 0),
    [0, 0, 1],
  );
  assert.equal(mirrored.joints[mirrored.index.get('l_elbow')].side, 'right');
  // One spine bone stands for every vertebra nearest to it; the head bone for both upper neck joints.
  assert.deepEqual(t.joints[t.index.get('vl3')].covers, ['vl5', 'vl4', 'vl3', 'vl2', 'vl1']);
  assert.deepEqual(t.joints[t.index.get('skullbase')].covers, ['vc1', 'skullbase']);
  assert.equal(
    t.joints[t.index.get('l_shoulder')].reference,
    t.names.indexOf('Spine2'),
    'the arm is measured against the chest',
  );
  // A modelled bend is read as a bend, not taken for straight.
  const elias = fitHuman(bodyRig({ arms: 45, elbow: 46 }));
  close(elias.joints[elias.index.get('r_elbow')].rest.flexion, 46, 1e-6, 'modelled elbow bend');
  close(elias.joints[elias.index.get('r_elbow')].rest.abduction, 0, 1e-6, 'modelled elbow bend is pure flexion');
});

for (const [shape, make] of Object.entries(SHAPES)) {
  test(`hinges bend the anatomical way: ${shape}`, () => {
    const body = fitHuman(make()),
      inward = (pose, bone) => [-Math.sign(boneAt(body, pose, bone)[0]), 0, 0];
    for (const side of ['Left', 'Right']) {
      const s = body.joints.find((joint) => joint.bone === body.names.indexOf(`${side}ForeArm`)).id[0];
      // From anatomical zero (arms hanging): an elbow brings the forearm forward, a knee takes the shank back.
      let pose = poseFromAngles(
        body,
        { [`${s}_elbow`]: { flexion: 90 }, [`${s}_knee`]: { flexion: 90 } },
        body.neutral,
      );
      assert.ok(heading(body, pose, `${side}ForeArm`, `${side}Hand`)[2] > 0.999, `${side} elbow flexes forward`);
      assert.ok(heading(body, pose, `${side}Leg`, `${side}Foot`)[2] < -0.999, `${side} knee flexes backward`);
      // From the rig's own rest pose too: in a T pose the hand comes forward, never up, down or back.
      pose = poseFromAngles(body, { [`${s}_elbow`]: { flexion: 90 }, [`${s}_knee`]: { flexion: 90 } });
      const upper = heading(body, body.rest, `${side}Arm`, `${side}ForeArm`),
        fore = heading(body, pose, `${side}ForeArm`, `${side}Hand`);
      close(dot(upper, fore), 0, 1e-6, `${side} forearm at a right angle to the upper arm`);
      assert.ok(fore[2] > 0.7, `${side} elbow flexes toward the front from the rest pose (z ${fore[2]})`);
      assert.ok(
        heading(body, pose, `${side}Leg`, `${side}Foot`)[2] < -0.9,
        `${side} knee flexes backward from the rest pose`,
      );
      // Fingers curl toward the palm, which at anatomical zero faces the thigh.
      pose = poseFromAngles(
        body,
        {
          [`${s}_carpal_proximal_interphalangeal_2`]: { flexion: 90 },
          [`${s}_metacarpophalangeal_3`]: { flexion: 90 },
          [`${s}_carpal_interphalangeal_1`]: { flexion: 60 },
        },
        body.neutral,
      );
      assert.ok(
        dot(heading(body, pose, `${side}HandIndex2`, `${side}HandIndex3`), inward(pose, `${side}Hand`)) > 0.95,
        `${side} index curls palmward`,
      );
      assert.ok(
        dot(heading(body, pose, `${side}HandMiddle1`, `${side}HandMiddle2`), inward(pose, `${side}Hand`)) > 0.95,
        `${side} knuckle curls palmward`,
      );
      // An ankle lifts the toes, a hip brings the knee forward and out, a shoulder brings the elbow out.
      pose = poseFromAngles(
        body,
        { [`${s}_talocrural`]: { flexion: 20 }, [`${s}_hip`]: { flexion: 60 } },
        body.neutral,
      );
      assert.ok(
        boneAt(body, pose, `${side}UpLeg`)[2] < boneAt(body, pose, `${side}Leg`)[2] - 0.3,
        `${side} hip flexes forward`,
      );
      const ankle = poseFromAngles(body, { [`${s}_talocrural`]: { flexion: 20 } }, body.neutral);
      assert.ok(
        boneAt(body, ankle, `${side}ToeBase`)[1] > boneAt(body, body.neutral, `${side}ToeBase`)[1] + 0.03,
        `${side} ankle dorsiflexion lifts the toes`,
      );
      pose = poseFromAngles(
        body,
        { [`${s}_hip`]: { abduction: 30 }, [`${s}_shoulder`]: { abduction: 60 } },
        body.neutral,
      );
      assert.ok(
        dot(heading(body, pose, `${side}UpLeg`, `${side}Leg`), inward(pose, `${side}UpLeg`)) < -0.45,
        `${side} hip abducts outward`,
      );
      assert.ok(
        dot(heading(body, pose, `${side}Arm`, `${side}ForeArm`), inward(pose, `${side}Arm`)) < -0.85,
        `${side} shoulder abducts outward`,
      );
      // Internal rotation with a bent elbow swings the hand across the body; pronation turns the thumb side inward.
      pose = poseFromAngles(
        body,
        { [`${s}_elbow`]: { flexion: 90 }, [`${s}_shoulder`]: { rotation: 45 } },
        body.neutral,
      );
      assert.ok(
        dot(heading(body, pose, `${side}ForeArm`, `${side}Hand`), inward(pose, `${side}Arm`)) > 0.69,
        `${side} shoulder rotates the hand inward`,
      );
      pose = poseFromAngles(body, { [`${s}_elbow`]: { rotation: 80 } }, body.neutral);
      assert.ok(
        dot(heading(body, pose, `${side}HandPinky1`, `${side}HandIndex1`), inward(pose, `${side}Hand`)) > 0.9,
        `${side} pronation turns the palm back`,
      );
    }
    // The spine bends the head forward, and turning left takes the left shoulder back.
    let pose = poseFromAngles(body, { vl3: { flexion: 30 } }, body.neutral);
    assert.ok(boneAt(body, pose, 'Head')[2] > 0.25, 'trunk flexion bends forward');
    pose = poseFromAngles(body, { vt6: { rotation: 30 } }, body.neutral);
    const leftArm = ['LeftArm', 'RightArm']
      .map((name) => body.names.indexOf(name))
      .find((bone) => forward(body.parents, body.neutral).pos[bone][0] > 0);
    assert.ok(forward(body.parents, pose).pos[leftArm][2] < -0.05, 'left rotation takes the left shoulder back');
  });
}

test('one posture gives one set of angles and one skeleton, whatever the rest pose or bone axes', () => {
  const bodies = Object.entries(SHAPES)
    .filter(([shape]) => !shape.includes('mirrored') && !shape.includes('knees'))
    .map(([shape, make]) => [shape, fitHuman(make())]);
  const rnd = random(5),
    [, first] = bodies[0],
    angles = {};
  for (const joint of first.joints) {
    if (!joint.limited) continue;
    const r = joint.normal;
    angles[joint.id] = {
      flexion: (r[0] + (r[1] - r[0]) * rnd()) * 0.5,
      abduction: (r[2] + (r[3] - r[2]) * rnd()) * 0.5,
      rotation: (r[4] + (r[5] - r[4]) * rnd()) * 0.5,
    };
  }
  const reference = forward(first.parents, poseFromAngles(first, angles)).pos;
  for (const [shape, body] of bodies) {
    const pose = poseFromAngles(body, angles),
      read = jointAngles(body, pose),
      { pos } = forward(body.parents, pose);
    for (const [id, want] of Object.entries(angles))
      for (const motion of ['flexion', 'abduction', 'rotation'])
        close(read[id][motion], want[motion], 1e-6, `${shape} ${id} ${motion}`);
    // A bone of the shape with a modelled elbow bend sits elsewhere at rest but in the same place once posed. (The shape
    // with modelled knee bends is left out: an ankle's zero is the rig's own rest pose, and its feet rest differently.)
    body.names.forEach((name, i) => {
      for (let k = 0; k < 3; k++) close(pos[i][k], reference[i][k], 1e-9, `${shape} ${name} position`);
    });
  }
});

test('every joint of the human table round trips angles to pose to angles, and turns about its own axes', () => {
  const rig = stickRig(human),
    body = fitHuman(rig),
    rnd = random(7),
    angles = {};
  assert.equal(body.preset, 'hanim');
  assert.equal(body.joints.length, 139);
  assert.equal(body.joints.filter((joint) => joint.limited).length, 137);
  for (const joint of body.joints) {
    if (!joint.limited) continue;
    assert.deepEqual(joint.covers, [joint.id], 'a full rig lumps nothing');
    const r = joint.normal,
      v = {
        flexion: r[0] + (r[1] - r[0]) * rnd(),
        abduction: r[2] + (r[3] - r[2]) * rnd(),
        rotation: r[4] + (r[5] - r[4]) * rnd(),
      },
      swing = Math.hypot(v.flexion, v.abduction);
    if (swing > 170) {
      v.flexion *= 170 / swing;
      v.abduction *= 170 / swing;
    }
    angles[joint.id] = v;
  }
  const pose = poseFromAngles(body, angles),
    read = jointAngles(body, pose),
    flat = readJointAngles(body, pose);
  body.joints.forEach((joint, k) => {
    if (!joint.limited) return assert.deepEqual([...flat.subarray(k * 3, k * 3 + 3)], [0, 0, 0]);
    for (const [s, motion] of ['flexion', 'abduction', 'rotation'].entries()) {
      close(read[joint.id][motion], angles[joint.id][motion], 1e-6, `${joint.id} ${motion}`);
      close(flat[k * 3 + s], angles[joint.id][motion], 1e-6, `${joint.id} ${motion} (flat)`);
    }
  });
  // From zero, each motion turns the bone about its table axis, right-handed: this is the hinge side of every joint.
  // The stick rig stands in the body frame (x left, y up, z forward) with no bone rotation, so table axes are world axes.
  const zero = forward(body.parents, body.neutral).rot;
  for (const joint of body.joints) {
    if (!joint.limited) continue;
    joint.spec.dofs.forEach((dof, s) => {
      const motion = ['flexion', 'abduction', 'rotation'][s],
        turned = forward(body.parents, poseFromAngles(body, { [joint.id]: { [motion]: 20 } }, body.neutral)).rot[
          joint.bone
        ],
        delta = qmul(turned, qconj(zero[joint.bone])),
        want = qaxis(dof.axis, 20 * RAD);
      close(
        Math.abs(delta[0] * want[0] + delta[1] * want[1] + delta[2] * want[2] + delta[3] * want[3]),
        1,
        1e-9,
        `${joint.id} ${dof.positive} turns about its axis`,
      );
    });
  }
  assert.throws(() => poseFromAngles(body, { l_elbo: { flexion: 10 } }), /not a limited joint/);
  assert.throws(() => poseFromAngles(body, { humanoid_root: { flexion: 10 } }), /not a limited joint/);
  assert.throws(() => jointAngles(body, new Float64Array(3)), /10 numbers per bone/);
});

test('limits are on by default and stop a hinge at its structural limit (KB-RIG-ARMS2)', () => {
  const body = fitHuman(bodyRig({ arms: 90 })),
    n = body.names.length;
  // An elbow 30 degrees past straight: the old default (no limits unless a rig supplied them) lets it through.
  const broken = poseFromAngles(body, { l_elbow: { flexion: -30 }, r_knee: { flexion: -20 } }),
    untouched = broken.slice();
  new PoseJointLimits(n, []).apply(untouched);
  assert.deepEqual(untouched, broken, 'with no profile the old limits change nothing: the defect');
  const issues = [];
  assert.equal(clampPose(body, broken, { issues }), 2);
  let after = jointAngles(body, broken);
  close(after.l_elbow.flexion, -5, 1e-6, 'elbow stops 5 degrees past straight');
  close(after.r_knee.flexion, -5, 1e-6, 'knee stops 5 degrees past straight');
  assert.deepEqual(
    issues.map((issue) => [
      issue.joint,
      issue.motion,
      Math.round(issue.value),
      Math.round(issue.limit),
      issue.tier,
      issue.source,
    ]),
    [
      ['r_knee', 'hyperextension', -20, -5, 'structural', 'cdc2011'],
      ['l_elbow', 'hyperextension', -30, -5, 'structural', 'cdc2011'],
    ],
  );
  // The capture of KB-RIG-ARMS2 held its elbows 3 to 6.5 degrees past straight: 3 passes, 6.5 is held at 5.
  const three = poseFromAngles(body, { l_elbow: { flexion: -3 }, r_elbow: { flexion: -6.5 } }),
    before = three.slice();
  assert.equal(clampPose(body, three), 1);
  after = jointAngles(body, three);
  close(after.l_elbow.flexion, -3, 1e-9, 'three degrees past straight is inside the stop');
  close(after.r_elbow.flexion, -5, 1e-6, 'six and a half is held at five');
  const left = body.names.indexOf('LeftForeArm') * 10;
  assert.deepEqual(
    three.slice(left, left + 10),
    before.slice(left, left + 10),
    'a joint inside its range is not rewritten',
  );
  // A pose inside every range is returned bit for bit.
  const fine = poseFromAngles(body, {
      l_elbow: { flexion: 120 },
      r_knee: { flexion: 100 },
      l_shoulder: { flexion: 150 },
    }),
    same = fine.slice();
  assert.equal(clampPose(body, fine), 0);
  assert.deepEqual(fine, same);
  // The two tiers: the clinical range warns earlier than the stop.
  const deep = poseFromAngles(body, { l_elbow: { flexion: 158 }, l_knee: { flexion: 165 } }),
    clinical = deep.slice();
  assert.equal(clampPose(body, deep), 1);
  close(jointAngles(body, deep).l_knee.flexion, 160, 1e-6, 'knee stop');
  close(jointAngles(body, deep).l_elbow.flexion, 158, 1e-6, 'elbow inside its stop');
  assert.equal(clampPose(body, clinical, { tier: 'normal' }), 2);
  close(jointAngles(body, clinical).l_elbow.flexion, 150, 1e-6, 'clinical elbow flexion, CDC women 20 to 44');
  close(jointAngles(body, clinical).l_knee.flexion, 141.9, 1e-6, 'clinical knee flexion, CDC women 20 to 44');
  // Off by name.
  const off = fitHuman(bodyRig({ arms: 90 }), { limits: false }),
    wild = poseFromAngles(off, { l_elbow: { flexion: -30 } }),
    kept = wild.slice();
  assert.equal(off.limits, false);
  assert.equal(clampPose(off, wild), 0);
  assert.deepEqual(wild, kept);
  assert.equal(clampPose(off, wild, { force: true }), 1);
  assert.throws(() => clampPose(body, Array.from(fine)), /Float64Array/);
});

test('reach limits differ by direction, keep a hinge bent, open with the pose and share a region', () => {
  const body = fitHuman(bodyRig({ arms: 45 }));
  const clamped = (angles, options) => {
    const pose = poseFromAngles(body, angles, body.neutral);
    clampPose(body, pose, options);
    return [jointAngles(body, pose), regionAngles(body, pose), pose];
  };
  // A shoulder reaches 180 forward and only 75 back; a hip 150 forward and 45 back.
  let [a] = clamped({
    l_shoulder: { flexion: -100 },
    r_shoulder: { flexion: 170 },
    l_hip: { flexion: -60 },
    r_hip: { flexion: 140 },
  });
  close(a.l_shoulder.flexion, -75, 1e-6, 'shoulder extension stop');
  close(a.r_shoulder.flexion, 170, 1e-6, 'shoulder flexion inside');
  close(a.l_hip.flexion, -45, 1e-6, 'hip extension stop');
  close(a.r_hip.flexion, 140, 1e-6, 'hip flexion inside');
  // A knee bent 100 degrees with 20 degrees of sideways noise loses the noise and keeps its bend.
  [a] = clamped({ l_knee: { flexion: 100, abduction: 20 } });
  close(a.l_knee.flexion, 100, 1.5, 'the bend survives');
  assert.ok(
    a.l_knee.abduction <= 10 + 1e-6 && a.l_knee.abduction > 5,
    `sideways play is held near its 10 degrees (${a.l_knee.abduction})`,
  );
  // A straight knee does not twist; a bent one does.
  [a] = clamped({ l_knee: { flexion: 0, rotation: 30 }, r_knee: { flexion: 90, rotation: 30 } });
  close(a.l_knee.rotation, 5, 1e-6, 'straight knee keeps 5 degrees of play');
  close(a.r_knee.rotation, 30, 1e-6, 'knee bent 90 degrees rotates freely within its range');
  [a] = clamped({ l_knee: { flexion: 45, rotation: 30 } });
  close(a.l_knee.rotation, 20, 1e-6, 'half bent, half open');
  // A hand twisted on its forearm: the twist moves into the forearm and the hand stays where it was.
  const twisted = poseFromAngles(body, { l_radiocarpal: { rotation: 60, flexion: 20 } }, body.neutral),
    hand = body.names.indexOf('LeftHand'),
    was = forward(body.parents, twisted),
    issues = [];
  assert.equal(clampPose(body, twisted, { issues }), 1);
  a = jointAngles(body, twisted);
  close(a.l_radiocarpal.rotation, 15, 1e-6, 'wrist keeps its own small twist');
  close(a.l_elbow.rotation, 45, 1e-6, 'the forearm takes the rest');
  close(
    Math.hypot(a.l_radiocarpal.flexion, a.l_radiocarpal.abduction),
    20,
    1e-6,
    'the wrist keeps its bend, now read against the turned forearm',
  );
  const now = forward(body.parents, twisted);
  close(
    Math.abs(now.rot[hand].reduce((sum, v, i) => sum + v * was.rot[hand][i], 0)),
    1,
    1e-12,
    'the hand keeps its world rotation',
  );
  for (let k = 0; k < 3; k++) close(now.pos[hand][k], was.pos[hand][k], 1e-12, 'the hand keeps its place');
  assert.deepEqual(
    [issues[0].joint, issues[0].motion, Math.round(issues[0].value), Math.round(issues[0].limit)],
    ['l_radiocarpal', 'pronation', 60, 15],
  );
  // A neck of two bones: any split of the turn is fine while the head stays within the neck's range.
  let regions;
  [a, regions] = clamped({ vc1: { rotation: 70 } });
  close(a.vc1.rotation, 70, 1e-6, 'the head bone may take the whole turn');
  [a, regions] = clamped({ vc1: { rotation: 80 }, vc7: { rotation: 60 } });
  close(regions.neck.rotation, 95, 1e-6, 'the head turns no further than the neck allows');
  close(a.vc1.rotation / a.vc7.rotation, 80 / 60, 1e-6, 'every bone of the run eases by the same share');
  // A trunk bent 45 degrees back over three bones is past the 40 degree stop of the whole trunk.
  [a, regions] = clamped({ vl3: { flexion: -15 }, vt12: { flexion: -15 }, vt6: { flexion: -15 } });
  close(regions.trunk.flexion, -40, 1e-6, 'trunk extension stop');
  [a, regions] = clamped({ vl3: { flexion: -15 }, vt12: { flexion: -15 }, vt6: { flexion: -15 } }, { tier: 'normal' });
  close(regions.trunk.flexion, -25, 1e-6, 'trunk extension, clinical');
});

test('the limits convert to the hinge and cone forms the older solvers hold', () => {
  const body = fitHuman(rolled(bodyRig({ arms: 90 }), 3)),
    n = body.names.length,
    limits = poseLimits(body);
  assert.equal(limits.length, body.joints.filter((joint) => joint.limited).length);
  const elbow = limits.find((limit) => limit.joint === body.names.indexOf('LeftForeArm'));
  assert.equal(elbow.limit.type, 'hinge');
  close(elbow.limit.min, -5 * RAD, 1e-12, 'hinge minimum');
  close(elbow.limit.max, 160 * RAD, 1e-12, 'hinge maximum');
  // The old projector, fed these limits, stops the same elbow at the same angle.
  const old = new PoseJointLimits(
      n,
      limits.filter((limit) => limit.limit.type === 'hinge'),
    ),
    pose = poseFromAngles(body, { l_elbow: { flexion: -30 }, r_knee: { flexion: 170 }, l_knee: { flexion: 80 } });
  old.apply(pose);
  const a = jointAngles(body, pose);
  close(a.l_elbow.flexion, -5, 1e-4, 'old projector, elbow');
  close(a.r_knee.flexion, 160, 1e-4, 'old projector, knee');
  close(a.l_knee.flexion, 80, 1e-4, 'old projector leaves a legal bend');
  const shoulder = limits.find((limit) => limit.joint === body.names.indexOf('LeftArm'));
  assert.equal(shoulder.limit.type, 'cone');
  close(shoulder.limit.angle, 127.5 * RAD, 1e-9, 'cone as wide as the wider half of the reach');
  // A chain, in its order, with null for a bone that has no joint.
  const chain = ikLimits(body, ['LeftArm', 'LeftForeArm', body.names.indexOf('LeftHand'), 'Hips']);
  assert.deepEqual(
    chain.map((limit) => limit?.limit.type ?? null),
    ['cone', 'hinge', 'cone', null],
  );
  assert.throws(() => ikLimits(body, ['Nope']), /no bone Nope/);
  // Ragdoll hinges, relative to the rest pose, turn the right way about their axis in the bone's own frame.
  const rest = forward(body.parents, body.rest),
    ragdoll = ragdollJoints(body);
  for (const [bone, tip, z] of [
    ['LeftForeArm', 'LeftHand', 1],
    ['RightForeArm', 'RightHand', 1],
    ['LeftLeg', 'LeftFoot', -1],
    ['RightLeg', 'RightFoot', -1],
  ]) {
    const i = body.names.indexOf(bone),
      { joint } = ragdoll.find((entry) => entry.bone === i);
    assert.equal(joint.type, 'hinge');
    close(joint.limits[0], -5 * RAD, 1e-9, `${bone} lower limit from a straight rest pose`);
    const axis = qrot(rest.rot[i], joint.axis),
      along = unit(sub(rest.pos[body.names.indexOf(tip)], rest.pos[i]));
    assert.ok(
      cross(axis, along)[2] * z > 0.99,
      `${bone} bends ${z > 0 ? 'forward' : 'backward'} about its ragdoll axis`,
    );
  }
  const kinematics = kinematicsLimits(body);
  assert.equal(kinematics.length, body.joints.length);
  assert.equal(kinematics[body.index.get('humanoid_root')], null);
  assert.deepEqual(kinematicsLimits(body, ['LeftLeg'])[0].type, 'hinge');
});

test('a species table is checked, and any species fits the same way', () => {
  const src = { book: { cite: 'A printed anatomy of the creature' } },
    measured = (value, what) => ({ source: 'book', value, what, provenance: 'print' }),
    ball = (max, min) => ({ max: bound(15, measured(max, 'forward')), min: bound(15, measured(min, 'back')) }),
    hip = {
      id: 'r_hip',
      parent: 'pelvis',
      segment: 'r_thigh',
      kind: 'ball',
      side: 'right',
      mirror: 'l_hip',
      neutral: 'body',
      long: [0, -1, 0],
      distal: ['r_stifle'],
      dofs: [
        { axis: [-1, 0, 0], positive: 'flexion', negative: 'extension', ...ball(100, 20) },
        { axis: [0, 0, -1], positive: 'abduction', negative: 'adduction', ...ball(30, 20) },
        { axis: [0, 1, 0], positive: 'internal rotation', negative: 'external rotation', ...ball(20, 20) },
      ],
    },
    stifle = {
      id: 'r_stifle',
      parent: 'r_hip',
      segment: 'r_gaskin',
      kind: 'hinge',
      side: 'right',
      mirror: 'l_stifle',
      neutral: 'straight',
      long: [0, -1, 0],
      dofs: [
        {
          axis: [1, 0, 0],
          positive: 'flexion',
          negative: 'hyperextension',
          max: bound(10, measured(140, 'stifle flexion')),
          min: bound(0, measured(3, 'stifle past straight')),
        },
        { axis: [0, 0, -1], positive: 'valgus', negative: 'varus', max: bound(5), min: bound(5) },
        { axis: [0, 1, 0], positive: 'internal rotation', negative: 'external rotation', max: bound(5), min: bound(5) },
      ],
    },
    other = (id) => (id.startsWith('r_') ? `l_${id.slice(2)}` : id.startsWith('l_') ? `r_${id.slice(2)}` : id),
    table = (joints) => ({
      id: 'creature',
      standard: 'test',
      joints,
      regions: [],
      frame: { pairs: [['l_hip', 'r_hip']], top: [], bottom: ['l_stifle', 'r_stifle'], ahead: [], up: [0, 1, 0] },
      stature: [{ from: 'l_stifle', to: 'l_hip', share: 0.25 }],
      proportions: [],
      segments: [],
      couplings: [],
      sources: src,
    }),
    pelvis = {
      id: 'pelvis',
      parent: null,
      segment: 'pelvis',
      kind: 'free',
      side: 'centre',
      neutral: 'rest',
      long: [0, 1, 0],
    },
    creature = defineSpecies(table([pelvis, hip, stifle, mirrorJoint(hip, other), mirrorJoint(stifle, other)]));
  assert.ok(Object.isFrozen(creature));
  assert.deepEqual(creature.joints[3].dofs[1].axis, [0, 0, 1], 'the mirrored abduction axis turns the other way');
  assert.equal(stifle.dofs[0].max.structural, 150);
  assert.equal(stifle.dofs[0].min.structural, 5);
  const rig = [
    { name: 'root', parent: -1, position: [0, 1, 0] },
    { name: 'thighL', parent: 0, position: [0.2, 1, 0] },
    { name: 'shinL', parent: 1, position: [0.2, 0.5, 0] },
    { name: 'thighR', parent: 0, position: [-0.2, 1, 0] },
    { name: 'shinR', parent: 3, position: [-0.2, 0.5, 0] },
  ];
  const map = { pelvis: 'root', l_hip: 'thighL', l_stifle: 'shinL', r_hip: 'thighR', r_stifle: 4 },
    body = fitAnatomy(rig, { species: creature, map });
  assert.equal(body.preset, null);
  assert.equal(body.stature, 2);
  const pose = poseFromAngles(body, { l_hip: { flexion: 90 }, r_hip: { flexion: -90 } });
  assert.ok(heading(body, pose, 'thighL', 'shinL')[2] > 0.999, 'hip flexion swings the thigh forward');
  assert.ok(heading(body, pose, 'thighR', 'shinR')[2] < -0.999, 'hip extension swings it back');
  clampPose(body, pose);
  close(jointAngles(body, pose).r_hip.flexion, -35, 1e-6, 'the creature stops where its own table says');
  // The facing can be given when there are no feet to read it from.
  assert.equal(fitAnatomy(rig, { species: creature, map, forward: [0, 0, -1] }).mirrored, true);
  // What the checks refuse.
  assert.throws(
    () => defineSpecies(table([pelvis, { ...hip, parent: 'r_stifle' }])),
    /parent "r_stifle" must come before/,
  );
  assert.throws(() => defineSpecies(table([pelvis, hip, { ...hip }])), /used twice/);
  assert.throws(() => defineSpecies(table([pelvis, { ...hip, long: [0, -2, 0] }])), /unit vector/);
  assert.throws(
    () =>
      defineSpecies(
        table([pelvis, { ...hip, dofs: [hip.dofs[0], { ...hip.dofs[1], axis: [-1, 0, 0] }, hip.dofs[2]] }]),
      ),
    /right angles/,
  );
  assert.throws(
    () =>
      defineSpecies(
        table([
          pelvis,
          {
            ...hip,
            dofs: [{ ...hip.dofs[0], max: { ...hip.dofs[0].max, structural: 170 } }, hip.dofs[1], hip.dofs[2]],
          },
        ]),
      ),
    /does not follow from its rows/,
  );
  assert.throws(
    () =>
      defineSpecies(
        table([
          pelvis,
          {
            ...hip,
            dofs: [
              { ...hip.dofs[0], max: bound(15, { source: 'nowhere', value: 90, what: 'x', provenance: 'online' }) },
              hip.dofs[1],
              hip.dofs[2],
            ],
          },
        ]),
      ),
    /names the source "nowhere"/,
  );
  assert.throws(
    () =>
      defineSpecies(
        table([
          pelvis,
          {
            ...hip,
            dofs: [
              { ...hip.dofs[0], max: bound(15, { source: 'book', value: 90, what: 'x', provenance: 'dataset' }) },
              hip.dofs[1],
              hip.dofs[2],
            ],
          },
        ]),
      ),
    /must name its data file/,
  );
  assert.throws(
    () =>
      defineSpecies({
        ...table([pelvis, { ...hip, mirror: undefined }, { ...stifle, mirror: undefined }]),
        regions: [{ id: 'leg', joints: ['r_hip', 'r_stifle'], shared: false }],
      }),
    /must exist, have motions and name this region/,
  );
  assert.throws(() => fitAnatomy(rig, { species: creature }), /no bone for pelvis/);
  assert.throws(() => fitAnatomy(rig, { species: creature, map: { ...map, r_stifle: 'thighR' } }), /mapped to both/);
  assert.throws(
    () => fitAnatomy(rig, { species: creature, map: { ...map, tail: 'root' } }),
    /not a joint of the creature table/,
  );
  assert.throws(() => fitAnatomy(rig, { species: creature, map: { ...map, l_hip: 'nope' } }), /no bone nope/);
  assert.throws(
    () => fitAnatomy(rig, { species: creature, map: { pelvis: 'root', l_hip: 'thighL' } }),
    /a left and a right joint/,
  );
  assert.throws(() => fitAnatomy(rig, {}), /species table/);
  assert.throws(
    () => fitAnatomy({ names: ['a'], parents: [-1], rest: [0] }, { species: creature }),
    /10 rest numbers per bone/,
  );
  assert.throws(() => jointAngles({ names: [] }), /fitAnatomy/);
});

test('a hand with no finger bones, and a palm turned forward, are read from what the rig has', () => {
  // No fingers: the hand follows the forearm, and the arm still knows which way it bends.
  const bare = fitHuman(bodyRig({ arms: 90, fingers: false })),
    pose = poseFromAngles(bare, { l_elbow: { flexion: 90 } });
  assert.ok(heading(bare, pose, 'LeftForeArm', 'LeftHand')[2] > 0.999);
  close(bare.joints[bare.index.get('l_elbow')].rest.rotation, 0, 1e-9, 'no knuckles, no roll read');
  // A T pose with the palms forward is a forearm supinated 90 degrees, read from the knuckles.
  const supine = fitHuman(addHand(bodyRig({ arms: 90, fingers: false }), 90));
  close(supine.joints[supine.index.get('l_elbow')].rest.rotation, -90, 1e-6, 'left forearm supinated');
  close(supine.joints[supine.index.get('r_elbow')].rest.rotation, -90, 1e-6, 'right forearm supinated');
  const bent = poseFromAngles(supine, { l_elbow: { flexion: 90 }, r_elbow: { flexion: 90 } });
  assert.ok(heading(supine, bent, 'LeftForeArm', 'LeftHand')[2] > 0.999, 'and the elbow still flexes forward');
  assert.ok(heading(supine, bent, 'RightForeArm', 'RightHand')[2] > 0.999);
  // A thumb base with no bone beyond it: nothing shows where the thumb points at rest, so it is not limited by a guess.
  const lone = bodyRig({ arms: 90, fingers: false });
  lone.push({
    name: 'LeftHandThumb1',
    parent: lone.findIndex((joint) => joint.name === 'LeftHand'),
    position: [0.74, 1.44, 0.03],
  });
  const thumb = fitHuman(lone);
  assert.equal(thumb.joints[thumb.index.get('l_carpometacarpal_1')].limited, false);
  assert.equal(jointAngles(thumb).l_carpometacarpal_1, undefined);
  // A reader that knows how a straight arm is rolled says so: the elbow then bends about the rolled axis.
  const known = fitHuman(bodyRig({ arms: 90 }), { roll: { l_shoulder: 30 } }),
    fore = heading(known, poseFromAngles(known, { l_elbow: { flexion: 90 } }), 'LeftForeArm', 'LeftHand');
  close(fore[2], Math.cos(30 * RAD), 1e-9, 'rolled elbow, forward part');
  close(Math.abs(fore[1]), Math.sin(30 * RAD), 1e-9, 'rolled elbow, vertical part');
  assert.throws(() => fitHuman(bodyRig({ arms: 90 }), { roll: { l_sholder: 30 } }), /options.roll/);
});

test('motion shows how a straight limb is rolled', () => {
  // A motion capture skeleton: straight arms, no knuckles, and upper arms and a thigh rolled in the rest pose. Its
  // elbows and knee bend about the rolled axes, which the joint positions alone cannot show.
  const rig = bodyRig({ arms: 90, fingers: false }),
    truth = fitHuman(rig, { roll: { l_shoulder: -25, r_shoulder: 25, l_hip: 10 } }),
    frames = [];
  for (let bend = 5; bend <= 120; bend += 5)
    frames.push(
      poseFromAngles(truth, {
        l_elbow: { flexion: bend },
        r_elbow: { flexion: bend * 0.9 },
        l_knee: { flexion: bend * 0.7 },
        r_knee: { flexion: 12 },
      }),
    );
  const unaware = fitHuman(rig),
    sideways = (body) => Math.max(...frames.map((pose) => Math.abs(jointAngles(body, pose).l_elbow.abduction)));
  assert.ok(sideways(unaware) > 45, 'read against an unrolled arm, the elbow seems to bend sideways');
  const rolls = hingeRolls(unaware, frames);
  assert.deepEqual(
    Object.keys(rolls).sort(),
    ['l_hip', 'l_shoulder', 'r_shoulder'],
    'a knee that barely moved says nothing about its thigh',
  );
  close(rolls.l_shoulder, -25, 1e-6, 'left upper arm roll');
  close(rolls.r_shoulder, 25, 1e-6, 'right upper arm roll');
  close(rolls.l_hip, 10, 1e-6, 'left thigh roll');
  const aware = fitHuman(rig, { roll: rolls });
  close(sideways(aware), 0, 1e-6, 'fitted with the roll the motion shows, the elbow is a hinge again');
  close(jointAngles(aware, frames.at(-1)).l_elbow.flexion, 120, 1e-6, 'and reads its full bend');
  // A body whose roll the landmarks already show has nothing to add.
  const seen = fitHuman(bodyRig({ arms: 45, elbow: 46 })),
    bends = [20, 60, 100].map((bend) => poseFromAngles(seen, { l_elbow: { flexion: bend } }));
  close(hingeRolls(seen, bends).l_shoulder, 0, 1e-6, 'no roll left to find');
  assert.throws(() => hingeRolls(unaware, [new Float64Array(4)]), /10 numbers per bone/);
});

test('the Animator hook holds the live pose inside the body every frame', () => {
  const body = fitHuman(bodyRig({ arms: 90 })),
    n = body.names.length,
    nodes = body.names.map((name, id) => ({ id, name })),
    transforms = { qx: new Float64Array(n), qy: new Float64Array(n), qz: new Float64Array(n), qw: new Float64Array(n) },
    load = (pose) => {
      for (let i = 0; i < n; i++) {
        transforms.qx[i] = pose[i * 10 + 3];
        transforms.qy[i] = pose[i * 10 + 4];
        transforms.qz[i] = pose[i * 10 + 5];
        transforms.qw[i] = pose[i * 10 + 6];
      }
    };
  let step,
    ticks = 0;
  const written = new Map(),
    animator = {
      animation: { model: { nodes, root: { engine: { store: { transforms, tick: () => ticks++ } } } } },
      addSolver(solver) {
        step = solver;
        return () => {
          step = undefined;
        };
      },
      writeNodeRotation(node, rotation) {
        written.set(node.name, [...rotation]);
        transforms.qx[node.id] = rotation[0];
        transforms.qy[node.id] = rotation[1];
        transforms.qz[node.id] = rotation[2];
        transforms.qw[node.id] = rotation[3];
      },
    };
  const seen = [],
    remove = addAnatomyLimits(animator, body, {
      onClamp: (issues) => seen.push(...issues.map((issue) => issue.joint + ' ' + issue.motion)),
    });
  // A frame inside every range writes nothing.
  load(poseFromAngles(body, { l_elbow: { flexion: 100 } }));
  step();
  assert.equal(written.size, 0);
  assert.equal(ticks, 0);
  // A frame with the elbow folded back writes that one bone, at its stop.
  const broken = poseFromAngles(body, { l_elbow: { flexion: -30 } });
  load(broken);
  step();
  assert.deepEqual([...written.keys()], ['LeftForeArm']);
  assert.equal(ticks, 1);
  assert.deepEqual(seen, ['l_elbow hyperextension']);
  const fixed = broken.slice();
  fixed.set(written.get('LeftForeArm'), body.names.indexOf('LeftForeArm') * 10 + 3);
  close(jointAngles(body, fixed).l_elbow.flexion, -5, 1e-6, 'the live elbow stops 5 degrees past straight');
  // The stricter tier, and a body with its limits off.
  written.clear();
  remove();
  assert.equal(step, undefined);
  addAnatomyLimits(animator, body, { tier: 'normal' });
  load(poseFromAngles(body, { r_knee: { flexion: 150 } }));
  step();
  assert.deepEqual([...written.keys()], ['RightLeg']);
  written.clear();
  addAnatomyLimits(animator, fitHuman(bodyRig({ arms: 90 }), { limits: false }));
  load(broken);
  step();
  assert.equal(written.size, 0);
  assert.throws(
    () =>
      addAnatomyLimits(
        { ...animator, animation: { model: { nodes: nodes.slice(1), root: animator.animation.model.root } } },
        body,
      ),
    /fit the body to that model/,
  );
});
