// IK that obeys anatomy: reaches all around the body for an arm and a leg, on the same body in a T pose, an A pose and
// arms down, with rolled bone axes and mirrored. Guards the fault Scott saw in the human demos (elbows bent backwards,
// "the elbows are closest to the body"): before this, a chain bent whichever way its pole or its pose said, a straight
// limb had no side at all, and no IK solver read a joint range unless the caller built one by hand.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampTurn, jointOf, jointTurn, limitRotation, solveLimbIK, turnRotation } from '@margoengine/animator/ik';
import { clampPose, fitAnatomy, jointAngles, poseFromAngles, readJointAngles } from '@margoengine/rigging/anatomy';
import { human } from '@margoengine/rigging/anatomy/human';
import { anatomyOf, setAnatomy, solvePoseIK, solveSkeletonIK } from '@margoengine/rigging/ik';
import { add, bodyRig, dot, forward, mul, random, rolled, sub, unit } from './anatomy-fixtures.js';

/** A body, its fit and the bone indices of one arm and one leg. `seed` rolls every bone's axes. */
function fitted(options = {}, seed = 0) {
  const joints = bodyRig({ fingers: false, ...options }),
    rig = seed
      ? rolled(joints, seed)
      : {
          names: joints.map((joint) => joint.name),
          parents: joints.map((joint) => joint.parent),
          rest: rolled(joints, 1).rest.map(() => 0),
        };
  if (!seed) {
    // Plain axes: every bone's rotation is the identity and its translation is its offset from its parent.
    joints.forEach((joint, i) => {
      const from = joint.parent < 0 ? [0, 0, 0] : joints[joint.parent].position;
      rig.rest.set([...sub(joint.position, from), 0, 0, 0, 1, 1, 1, 1], i * 10);
    });
  }
  const body = fitAnatomy(rig, { species: human }),
    bone = (name) => rig.names.indexOf(name);
  return {
    rig,
    body,
    arm: ['LeftArm', 'LeftForeArm', 'LeftHand'].map(bone),
    leg: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'].map(bone),
    // Joints keep the ids their bones are named for, also on a mirrored rig (only their side flips).
    armIds: ['l_shoulder', 'l_elbow'],
    legIds: ['l_hip', 'l_knee'],
  };
}

const BODIES = [
  ['T pose', { arms: 90 }, 0],
  ['A pose', { arms: 45 }, 0],
  ['arms down', { arms: 0 }, 0],
  ['T pose, rolled axes', { arms: 90 }, 11],
  ['arms down, rolled axes', { arms: 0 }, 23],
  ['A pose, mirrored', { arms: 45, mirror: true }, 0],
  ['arms down, mirrored and rolled', { arms: 0, mirror: true }, 37],
];

/** A point in a ball of `radius` about `centre`. */
function around(rnd, centre, radius) {
  for (;;) {
    const p = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    if (dot(p, p) <= 1 && dot(p, p) > 1e-4) return add(centre, mul(p, radius));
  }
}

test("the solvers' joint angles are the anatomy's own, on random poses of every joint", () => {
  const { rig, body } = fitted({ arms: 45, fingers: true }, 5),
    rnd = random(77),
    v = [0, 0, 0],
    out = [0, 0, 0, 1];
  for (let round = 0; round < 40; round++) {
    const pose = rig.rest.slice();
    for (let b = 0; b < rig.names.length; b++) {
      const q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, (rnd() - 0.2) * 3],
        l = Math.hypot(...q);
      pose.set(
        q.map((x) => x / l),
        b * 10 + 3,
      );
    }
    const theirs = readJointAngles(body, pose),
      world = forward(rig.parents, pose).rot;
    body.joints.forEach((joint, k) => {
      if (!joint.limited) return;
      const reference = joint.reference < 0 ? [0, 0, 0, 1] : world[joint.reference];
      jointTurn(joint, reference, world[joint.bone], v);
      for (let s = 0; s < 3; s++)
        assert.ok(Math.abs(v[s] - theirs[k * 3 + s]) < 1e-6, `${joint.id} angle ${s}: ${v[s]} vs ${theirs[k * 3 + s]}`);
      // The angles turn back into the same rotation, and a joint held at its range reads inside it.
      turnRotation(joint, v, out);
      const again = [0, 0, 0];
      jointTurn(joint, [0, 0, 0, 1], out, again);
      for (let s = 0; s < 3; s++) assert.ok(Math.abs(again[s] - v[s]) < 1e-6 || Math.abs(v[0]) + Math.abs(v[1]) > 175);
      if (limitRotation(joint, reference, world[joint.bone], out)) {
        jointTurn(joint, reference, out, again);
        assert.equal(clampTurn(joint, again.slice()), false, `${joint.id} is inside its range once held`);
      }
    });
  }
  // The same pose brought inside by the anatomy's own clamp reads as inside here too.
  const pose = poseFromAngles(body, { l_elbow: { flexion: -40 }, r_knee: { flexion: 170 } });
  clampPose(body, pose);
  const world = forward(rig.parents, pose).rot;
  for (const id of ['l_elbow', 'r_knee']) {
    const joint = body.joints[body.index.get(id)];
    jointTurn(joint, world[joint.reference], world[joint.bone], v);
    assert.equal(clampTurn(joint, v), false);
  }
});

test('a pose brought inside its ranges once is inside: a second clampPose changes nothing', () => {
  // Regression (KB-RIG-GATEORDER1): a knee's twist range opens with its flexion, and the gate was read before the
  // swing was brought inside its ellipse, so a second clamp narrowed the twist again by up to half a degree.
  const { rig, body } = fitted({ arms: 45, fingers: true }, 5),
    rnd = random(31);
  for (let round = 0; round < 60; round++) {
    const pose = rig.rest.slice();
    for (let b = 0; b < rig.names.length; b++) {
      const q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() * 2],
        l = Math.hypot(...q);
      pose.set(
        q.map((x) => x / l),
        b * 10 + 3,
      );
    }
    clampPose(body, pose);
    const issues = [];
    clampPose(body, pose, { issues });
    const joints = issues.filter((issue) => issue.bone >= 0 && Math.abs(issue.value - issue.limit) > 1e-6);
    assert.deepEqual(
      joints,
      [],
      `round ${round}: ${joints.map((issue) => `${issue.joint} ${issue.motion} ${issue.value} to ${issue.limit}`)}`,
    );
  }
  const knee = body.joints[body.index.get('l_knee')],
    v = [78.7, 44.2, 63.1];
  clampTurn(knee, v);
  assert.equal(clampTurn(knee, v.slice()), false);
});

/** Runs `count` seeded reaches of a limb on a body and returns what was seen. */
function sweep(name, options, seed, limb, count, { limits = true, poles = true } = {}) {
  const made = fitted(options, seed),
    { rig, body } = made,
    chain = made[limb],
    [ballId, hingeId] = made[`${limb}Ids`],
    hinge = body.joints[body.index.get(hingeId)],
    rest = forward(rig.parents, rig.rest).pos,
    root = rest[chain[0]],
    length = Math.hypot(...sub(rest[chain[1]], root)) + Math.hypot(...sub(rest[chain[2]], rest[chain[1]])),
    rnd = random(1000 + seed * 7 + (limb === 'arm' ? 1 : 2)),
    seen = { reached: 0, held: 0, least: Infinity, most: -Infinity, reversed: 0 };
  for (let i = 0; i < count; i++) {
    const target = around(rnd, root, length * 1.15),
      pole = poles && rnd() < 0.5 ? around(rnd, root, length) : null,
      pose = { parents: rig.parents, local: rig.rest.slice(), body },
      result = solvePoseIK(pose, { joints: chain, target, pole, limits, tolerance: 1e-6 }),
      angles = jointAngles(body, pose.local),
      flexion = angles[hingeId].flexion,
      where = `${name} ${limb} reach ${i} to [${target.map((x) => x.toFixed(3))}]${pole ? ' with a pole' : ''}`;
    seen.least = Math.min(seen.least, flexion);
    seen.most = Math.max(seen.most, flexion);
    if (flexion < -1e-6) seen.reversed++;
    if (result.reached) seen.reached++;
    if (result.held) seen.held++;
    if (!limits) continue;
    // The hinge: never past straight, never past its stop, and no bend to either side.
    assert.ok(flexion >= -1e-6, `${where}: the hinge is ${-flexion} degrees past straight`);
    assert.ok(flexion <= hinge.structural[1] + 1e-6, `${where}: the hinge is flexed ${flexion}, past its stop`);
    assert.ok(Math.abs(angles[hingeId].abduction) <= Math.max(-hinge.structural[2], hinge.structural[3]) + 1e-6, where);
    // Nothing in the limb is outside the stops no body passes.
    const issues = [];
    clampPose(body, pose.local.slice(), { issues });
    const ours = issues.filter((issue) => issue.joint === ballId || issue.joint === hingeId);
    assert.deepEqual(ours, [], `${where}: ${ours.map((issue) => `${issue.joint} ${issue.motion} ${issue.value}`)}`);
    // Bones keep their lengths, and a miss is a held joint or a target out of reach.
    const now = forward(rig.parents, pose.local).pos,
      far = Math.hypot(...sub(target, root));
    assert.ok(
      Math.abs(Math.hypot(...sub(now[chain[2]], now[chain[1]])) - Math.hypot(...sub(rest[chain[2]], rest[chain[1]]))) <
        1e-9,
    );
    if (!result.reached)
      assert.ok(result.held || far > length - 1e-6, `${where}: missed by ${result.distance} with nothing held`);
    else assert.ok(Math.hypot(...sub(now[chain[2]], target)) <= 1e-6, where);
  }
  return seen;
}

for (const limb of ['arm', 'leg'])
  test(`10,000 reaches all around the body: the ${limb}'s hinge never reverses and no joint passes its stop`, () => {
    let reached = 0,
      total = 0;
    for (const [name, options, seed] of BODIES) {
      const count = Math.ceil(10_000 / BODIES.length),
        seen = sweep(name, options, seed, limb, count);
      assert.equal(seen.reversed, 0);
      assert.ok(seen.most > 100, `${name}: the ${limb} folds (most flexion seen ${seen.most})`);
      reached += seen.reached;
      total += count;
    }
    // Most of a ball around a shoulder or hip is in reach of a body that keeps its ranges.
    assert.ok(reached > total * 0.3, `${reached} of ${total} reached`);
  });

test('without the body the same reaches fold elbows and knees backwards: the fault this guards', () => {
  for (const limb of ['arm', 'leg']) {
    const seen = sweep('arms down', { arms: 0 }, 0, limb, 600, { limits: false });
    assert.ok(seen.reversed > 50, `${limb}: ${seen.reversed} of 600 reversed`);
    assert.ok(seen.least < -30, `${limb}: worst hinge ${seen.least}`);
  }
});

test('a straight limb bends the anatomical way, by positions alone: knee forward, elbow back and down', () => {
  for (const [name, options, seed] of BODIES) {
    const { rig, body, arm, leg } = fitted(options, seed),
      rest = forward(rig.parents, rig.rest).pos,
      // The body's own directions from where its joints are: up the spine, and forward along the feet.
      toe = rig.names.indexOf('LeftToeBase'),
      ahead = unit([0, 0, sub(rest[toe], rest[leg[2]])[2]]),
      up = [0, 1, 0];
    assert.deepEqual(ahead, [0, 0, 1]);
    // The leg: the foot lifted straight up toward the hip by 12 cm. The knee goes forward.
    const legPose = { parents: rig.parents, local: rig.rest.slice(), body },
      ankle = rest[leg[2]],
      lifted = add(ankle, [0, 0.12, 0]);
    assert.ok(solvePoseIK(legPose, { joints: leg, target: lifted }).reached, `${name}: foot lift`);
    const legNow = forward(rig.parents, legPose.local).pos;
    assert.ok(legNow[leg[1]][2] - rest[leg[0]][2] > 0.1, `${name}: the knee moved ${legNow[leg[1]][2]} forward`);
    // The arm: the hand in front of the chest at shoulder height, 0.4 m out. The elbow hangs below the line from the
    // shoulder to the hand, and is never above it or folded in across the chest.
    const armPose = { parents: rig.parents, local: rig.rest.slice(), body },
      shoulder = rest[arm[0]],
      target = add(shoulder, mul(ahead, 0.4));
    assert.ok(solvePoseIK(armPose, { joints: arm, target }).reached, `${name}: hand forward`);
    const armNow = forward(rig.parents, armPose.local).pos,
      elbow = sub(armNow[arm[1]], shoulder);
    assert.ok(dot(elbow, up) < -0.05, `${name}: the elbow is ${-dot(elbow, up)} m below the shoulder`);
    assert.ok(Math.abs(elbow[0]) < 0.12, `${name}: the elbow is ${elbow[0]} m to the side`);
  }
});

test('a pole only picks the swivel inside the shoulder: asked to fold the elbow backwards, it does not', () => {
  const { rig, body, arm } = fitted({ arms: 0 }),
    rest = forward(rig.parents, rig.rest).pos,
    shoulder = rest[arm[0]],
    target = add(shoulder, [0, -0.1, 0.35]);
  for (const pole of [
    [0, 5, 5],
    [5, 0, 0],
    [-5, 0, 0],
    [0, 5, -5],
    [0, -5, -5],
  ]) {
    const pose = { parents: rig.parents, local: rig.rest.slice() };
    setAnatomy(pose, body);
    assert.equal(anatomyOf(pose), body);
    const result = solvePoseIK(pose, { joints: arm, target, pole: add(shoulder, pole) });
    assert.ok(result.reached, `pole ${pole}`);
    const { l_elbow, l_shoulder } = jointAngles(body, pose.local);
    assert.ok(l_elbow.flexion > 20 && l_elbow.flexion < 150, `pole ${pole}: elbow ${l_elbow.flexion}`);
    const shoulderJoint = body.joints[body.index.get('l_shoulder')];
    assert.ok(
      l_shoulder.rotation >= shoulderJoint.structural[4] - 1e-6 &&
        l_shoulder.rotation <= shoulderJoint.structural[5] + 1e-6,
    );
  }
  // Two poles on opposite sides the shoulder allows give two different elbows.
  const elbowAt = (pole) => {
    const pose = { parents: rig.parents, local: rig.rest.slice(), body };
    solvePoseIK(pose, { joints: arm, target, pole: add(shoulder, pole) });
    return forward(rig.parents, pose.local).pos[arm[1]];
  };
  assert.ok(Math.hypot(...sub(elbowAt([5, -2, 0]), elbowAt([0, -5, -1]))) > 0.05);
});

test('a soft reach eases the limb in before full stretch, and limits: false gives the old solve', () => {
  const { rig, body, leg } = fitted({ arms: 0 }),
    rest = forward(rig.parents, rig.rest).pos,
    hip = rest[leg[0]],
    length = 0.83,
    knee = (soft, far) => {
      const pose = { parents: rig.parents, local: rig.rest.slice(), body };
      solvePoseIK(pose, { joints: leg, target: add(hip, [0, -far, 0.0001]), soft });
      return jointAngles(body, pose.local).l_knee.flexion;
    };
  assert.ok(knee(0, length * 0.999) < 6);
  assert.ok(knee(0.05, length * 0.999) > knee(0, length * 0.999) + 5, 'the knee keeps a bend near full stretch');
  assert.ok(knee(0.05, length * 0.6) - knee(0, length * 0.6) < 1e-6, 'well inside the reach nothing changes');
  assert.throws(
    () => solvePoseIK({ parents: rig.parents, local: rig.rest.slice(), body }, { joints: leg, target: hip, soft: 2 }),
    RangeError,
  );
  const free = { parents: rig.parents, local: rig.rest.slice(), body },
    plain = { parents: rig.parents, local: rig.rest.slice() },
    chain = { joints: leg, target: add(hip, [0, -0.5, -0.3]), pole: add(hip, [0, -0.4, -3]) };
  solvePoseIK(free, { ...chain, limits: false });
  solvePoseIK(plain, chain);
  assert.deepEqual(Array.from(free.local), Array.from(plain.local));
  assert.ok(jointAngles(body, plain.local).l_knee.flexion < -20, 'a pole behind the leg folds a free knee backwards');
});

test('a longer chain keeps every joint in range and ends in the anatomical limb', () => {
  const { rig, body, arm } = fitted({ arms: 45 }, 3),
    chain = [rig.names.indexOf('LeftShoulder'), ...arm],
    rest = forward(rig.parents, rig.rest).pos,
    rnd = random(9);
  let reached = 0;
  for (let i = 0; i < 400; i++) {
    const pose = { parents: rig.parents, local: rig.rest.slice(), body },
      target = around(rnd, rest[arm[0]], 0.6),
      result = solvePoseIK(pose, { joints: chain, target, weight: i % 5 === 4 ? 0.5 : 1 });
    if (result.reached) reached++;
    const issues = [];
    clampPose(body, pose.local.slice(), { issues });
    const ours = issues.filter((issue) => /^l_(sternoclavicular|acromioclavicular|shoulder|elbow)$/.test(issue.joint));
    assert.deepEqual(ours, [], `reach ${i}: ${ours.map((issue) => `${issue.joint} ${issue.motion} ${issue.value}`)}`);
    assert.ok(jointAngles(body, pose.local).l_elbow.flexion >= -1e-6);
  }
  assert.ok(reached > 100, `${reached} of 400 reached`);
});

test('solveSkeletonIK and solveLimbIK obey the body, and bad input is refused', () => {
  const { rig, body, leg } = fitted({ arms: 0 }, 41),
    pose = rig.rest.slice(),
    skeleton = {
      parents: rig.parents,
      names: rig.names,
      getPose: (b) => ({
        translation: pose.subarray(b * 10, b * 10 + 3),
        rotation: pose.subarray(b * 10 + 3, b * 10 + 7),
        scale: pose.subarray(b * 10 + 7, b * 10 + 10),
      }),
      setPose: (b, { rotation }) => pose.set(rotation, b * 10 + 3),
    },
    rest = forward(rig.parents, rig.rest),
    hip = rest.pos[leg[0]];
  setAnatomy(skeleton, body);
  // A pole straight behind the leg: without the body this is the backwards knee.
  const result = solveSkeletonIK(skeleton, {
    joints: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'],
    target: add(hip, [0, -0.6, 0.1]),
    pole: add(hip, [0, -0.4, -3]),
  });
  assert.ok(result.reached);
  assert.ok(jointAngles(body, pose).l_knee.flexion > 30);
  setAnatomy(skeleton, null);
  assert.equal(anatomyOf(skeleton), null);
  assert.throws(() => setAnatomy(null, body), TypeError);
  assert.throws(() => setAnatomy(skeleton, {}), TypeError);
  const knee = jointOf(body, leg[1]),
    limb = {
      root: hip,
      mid: rest.pos[leg[1]],
      end: rest.pos[leg[2]],
      upperRotation: rest.rot[leg[0]],
      lowerRotation: rest.rot[leg[1]],
      target: add(hip, [0, -0.5, 0.2]),
      hinge: knee,
      ball: jointOf(body, leg[0]),
      reference: rest.rot[body.joints[body.index.get('l_hip')].reference],
    },
    solved = solveLimbIK(limb);
  assert.ok(solved.reached && solved.flexion > 40 && !solved.held);
  assert.ok(Math.hypot(...sub(solved.end, limb.target)) < 1e-6);
  // Too near the hip for a knee that stops at its range: held at full flexion, short of the target.
  const folded = solveLimbIK({ ...limb, target: add(hip, [0, -0.02, 0.01]) });
  assert.ok(folded.held && !folded.reached && Math.abs(folded.flexion - knee.structural[1]) < 1e-6);
  assert.throws(() => solveLimbIK({ ...limb, mid: hip }), RangeError);
  assert.throws(() => solveLimbIK({ ...limb, hinge: { ...knee, limited: false } }), RangeError);
  assert.throws(() => solveLimbIK({ ...limb, target: [0, Number.NaN, 0] }), TypeError);
});
