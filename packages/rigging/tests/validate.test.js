// The pose checker (`@margoengine/rigging/validate`) on the anatomy tests' body in every rest shape: a clean pose
// passes, and each fault Scott has had to find by eye in the human demos (an elbow folded back, a knee bent sideways, a
// bone that grew, a foot through the floor, an arm through the chest, a planted foot sliding, a capture pop, an arm too
// long for its body) is named with its joint, how far it is past its limit, the limit's source and the help link.
// The limits these tests expect are the published ones, read here from the table's own source rows (CDC 2011 for the
// elbow and knee), not from the checker.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poseFromAngles } from '../dist/anatomy.js';
import { fitHuman } from '../dist/anatomy-human.js';
import {
  POSE_HELP,
  assertClip,
  assertPose,
  checkClip,
  checkPose,
  checkProportions,
  formatPoseReport,
} from '../dist/validate.js';
import { bodyRig, qaxis, qmul, rolled } from './anatomy-fixtures.js';

const SHAPES = {
  'T pose': () => bodyRig({ arms: 90 }),
  'A pose': () => bodyRig({ arms: 45 }),
  'arms down': () => bodyRig({ arms: 0 }),
  mirrored: () => bodyRig({ arms: 45, mirror: true }),
  'rolled axes': () => rolled(bodyRig({ arms: 45 }), 7),
};
const a = () => fitHuman(rolled(bodyRig({ arms: 45 }), 3));
const codes = (report) => report.issues.map((issue) => `${issue.code} ${issue.joint}`);
const find = (report, code, joint) => report.issues.find((issue) => issue.code === code && issue.joint === joint);

test('the rest and neutral poses of every rest shape pass, standing on the ground', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    const body = fitHuman(make());
    for (const pose of [body.rest, body.neutral]) {
      const report = checkPose(body, pose, { ground: 0 });
      assert.deepEqual(codes(report), [], `${name}: ${formatPoseReport(report)}`);
      assert.equal(report.passed, true);
    }
    assert.deepEqual(checkProportions(body), [], name);
  }
});

test('an elbow folded back is an error past the stop and a warning past straight inside it', () => {
  const body = a(),
    elbow = body.joints[body.index.get('l_elbow')];
  // CDC 2011 (Soucie et al.) elbow extension is the first row of the table's clinical bound; the stop is 5 past straight.
  const back = elbow.spec.dofs[0].min,
    folded = checkPose(body, poseFromAngles(body, { l_elbow: { flexion: -30 } })),
    issue = find(folded, 'hinge-reversed', 'l_elbow');
  assert.equal(back.rows[0].source, 'cdc2011');
  assert.equal(issue.severity, 'error');
  assert.equal(issue.tier, 'structural');
  assert.ok(Math.abs(issue.value + 30) < 1e-6 && Math.abs(issue.limit + back.structural) < 1e-6, JSON.stringify(issue));
  assert.ok(Math.abs(issue.excess - (30 - back.structural)) < 1e-6);
  assert.equal(issue.source, 'cdc2011');
  assert.equal(issue.help, POSE_HELP);
  assert.equal(issue.bone, 'LeftForeArm');
  assert.equal(folded.passed, false);
  assert.equal(folded.issues.filter((found) => found.joint === 'l_elbow').length, 1, 'one issue per motion');
  // 3 degrees past straight is inside CDC's clinical extension of about 4.7 but reads as a locked-back elbow.
  const locked = find(checkPose(body, poseFromAngles(body, { l_elbow: { flexion: -3 } })), 'hinge-reversed', 'l_elbow');
  assert.equal(locked.severity, 'warning');
  assert.ok(Math.abs(locked.value + 3) < 1e-6);
  assert.equal(
    checkPose(body, poseFromAngles(body, { l_elbow: { flexion: -3 } }), { tier: 'structural' }).issues.length,
    0,
  );
  assert.equal(checkPose(body, poseFromAngles(body, { l_elbow: { flexion: 90 } })).issues.length, 0);
});

test('a knee bent sideways, a forearm twisted past its range and a shoulder past its reach are named', () => {
  const body = a(),
    report = checkPose(
      body,
      poseFromAngles(body, {
        r_knee: { flexion: 30, abduction: 14 },
        l_elbow: { flexion: 90, rotation: 120 },
        r_shoulder: { flexion: -90 },
      }),
    );
  assert.equal(find(report, 'hinge-sideways', 'r_knee').severity, 'error');
  // The stop is 10 degrees each way at a straight knee; bent 30, the nearest point of the reach ellipse is a little less.
  const sideways = Math.abs(find(report, 'hinge-sideways', 'r_knee').limit);
  assert.ok(sideways > 8 && sideways <= 10 + 1e-6, `${sideways}`);
  assert.equal(find(report, 'twist-out-of-range', 'l_elbow').severity, 'error');
  const shoulder = find(report, 'out-of-range', 'r_shoulder');
  assert.equal(shoulder.motion, 'extension');
  assert.ok(shoulder.excess > 10, JSON.stringify(shoulder));
});

test('bones stretched or scaled from rest are errors', () => {
  const body = a(),
    pose = Float64Array.from(body.rest),
    bone = body.names.indexOf('LeftForeArm');
  for (let c = 0; c < 3; c++) pose[bone * 10 + c] *= 1.1;
  pose[body.names.indexOf('RightLeg') * 10 + 8] = 1.2;
  const report = checkPose(body, pose);
  const stretched = report.issues.filter((issue) => issue.code === 'bone-stretch');
  assert.deepEqual(stretched.map((issue) => `${issue.joint} ${issue.motion}`).sort(), ['l_elbow null', 'r_knee scale']);
  assert.ok(/10\.0 percent longer/.test(stretched.find((issue) => issue.joint === 'l_elbow').message));
});

test('the ground: joints and skin below it, and supports held above it', () => {
  const body = a(),
    sunk = Float64Array.from(body.rest);
  sunk[1] -= 0.2;
  const report = checkPose(body, sunk, { ground: 0 }),
    deep = report.issues.find((issue) => issue.code === 'ground-penetration');
  assert.ok(deep && /_metatarsophalangeal_|talocrural/.test(deep.joint), formatPoseReport(report));
  assert.ok(Math.abs(deep.value * body.stature + 0.2 - 0.07 * 0) < 0.2, JSON.stringify(deep));
  const skin = checkPose(body, body.rest, { ground: 0, points: [0, 1, 0, 0.1, -0.03, 0.1] });
  assert.equal(find(skin, 'ground-penetration', 'point 1').severity, 'error');
  const raised = Float64Array.from(body.rest);
  raised[1] += 0.3;
  const floating = checkPose(body, raised, { ground: 0, supports: ['l_talocrural'] });
  assert.equal(find(floating, 'floating', 'l_talocrural').severity, 'error');
  assert.equal(checkPose(body, body.rest, { ground: 0, supports: ['l_talocrural', 'r_talocrural'] }).passed, true);
  assert.throws(() => checkPose(body, body.rest, { ground: 0, supports: ['tail'] }), RangeError);
});

test('an arm swung through the chest is one limb through another; crossed arms and a hand on the hip are not', () => {
  const body = a(),
    through = checkPose(body, poseFromAngles(body, { l_shoulder: { abduction: -60 } }));
  assert.ok(find(through, 'self-penetration', 'l_upperArm + trunk'), formatPoseReport(through));
  assert.equal(find(through, 'self-penetration', 'l_upperArm + trunk').source, 'ansur2');
  const folded = checkPose(
    body,
    poseFromAngles(body, {
      l_shoulder: { flexion: 60, abduction: -20 },
      r_shoulder: { flexion: 60, abduction: -20 },
      l_elbow: { flexion: 110 },
      r_elbow: { flexion: 110 },
    }),
  );
  assert.equal(folded.issues.filter((issue) => issue.code === 'self-penetration').length, 0, formatPoseReport(folded));
  assert.equal(checkPose(body, body.neutral, { volumes: false }).issues.length, 0);
});

test('proportions: an upper arm 60 percent too long is an error naming the measure; one long arm is lopsided', () => {
  const joints = bodyRig({ arms: 45 }),
    grow = (name, k) => {
      const i = joints.findIndex((joint) => joint.name === name),
        parent = joints[joints[i].parent].position,
        offset = joints[i].position.map((v, c) => (v - parent[c]) * (k - 1));
      // Move the joint and everything below it.
      const below = (j) => j === i || (joints[j].parent >= 0 && below(joints[j].parent));
      joints.forEach((joint, j) => {
        if (below(j)) joint.position = joint.position.map((v, c) => v + offset[c]);
      });
    };
  grow('LeftForeArm', 1.6);
  const issues = checkProportions(fitHuman(joints));
  const upper = issues.find((issue) => issue.code === 'proportion' && issue.joint === 'upperArmLength');
  assert.ok(upper && upper.severity === 'error' && upper.value > upper.limit, JSON.stringify(issues, null, 1));
  assert.equal(upper.source, 'ansur2');
  assert.ok(issues.some((issue) => issue.code === 'asymmetry' && issue.joint === 'upperArmLength'));
  assert.ok(!issues.some((issue) => issue.joint === 'upperArmLength (mirror)'), 'the right arm is fine');
  // A body given its real height reads its shares against it.
  assert.ok(checkProportions(fitHuman(bodyRig({ arms: 45 })), { stature: 2.6 }).length > 0);
});

/** A walk-like clip: the left elbow swings, the right foot stays planted, with optional faults. */
function clip(body, { pop = false, skate = false, fast = false } = {}) {
  const elbow = body.names.indexOf('LeftForeArm'),
    base = (t) => poseFromAngles(body, { l_elbow: { flexion: 40 + 30 * Math.sin(t * 4) } });
  return (time, out) => {
    out.set(base(time));
    const frame = Math.round(time * 30);
    if (pop && frame === 12) {
      // The capture's elbow flips half a turn for one frame.
      const o = elbow * 10 + 3,
        q = qmul([out[o], out[o + 1], out[o + 2], out[o + 3]], qaxis([1, 0, 0], Math.PI * 0.9));
      out.set(q, o);
    }
    if (fast && frame === 20) {
      const o = elbow * 10 + 3;
      out.set(qmul([out[o], out[o + 1], out[o + 2], out[o + 3]], qaxis([0, 1, 0], 2.5)), o);
    }
    if (skate) out[0] += time * 0.6; // the whole body glides while its feet stay down
  };
}

test('a clip: pops and planted feet that slide are found with their times, and the summary has one row each', () => {
  const body = a(),
    clean = checkClip(body, clip(body), { duration: 1, fps: 30, ground: 0 });
  assert.equal(clean.frames, 31);
  assert.equal(clean.passed, true, formatPoseReport(clean));
  const popped = checkClip(body, clip(body, { pop: true }), { duration: 1, fps: 30 });
  const pop = popped.summary.find((row) => row.code === 'pop' && row.joint === 'l_elbow');
  assert.ok(pop, formatPoseReport(popped));
  assert.ok(Math.abs(pop.first - 12 / 30) < 1e-9, `first at ${pop.first}`);
  assert.equal(pop.worst.unit, 'deg/s');
  const skating = checkClip(body, clip(body, { skate: true }), { duration: 1, fps: 30 });
  const slide = skating.summary.find((row) => row.code === 'foot-slide');
  assert.ok(slide && slide.frames >= 20, formatPoseReport(skating));
  // The same glide is a walk when the clip is played in place and the body is said to move backwards to match it.
  const inPlace = checkClip(body, clip(body, { skate: true }), { duration: 1, fps: 30, velocity: [-0.6, 0, 0] });
  assert.equal(inPlace.summary.filter((row) => row.code === 'foot-slide').length, 0, formatPoseReport(inPlace));
  // A frame list works as well as a sampler, and an error throws with its report.
  const frames = [body.rest, poseFromAngles(body, { r_knee: { flexion: -40 } }), body.rest];
  const error = (() => {
    try {
      assertClip(body, frames, { fps: 10 });
    } catch (caught) {
      return caught;
    }
  })();
  assert.equal(error?.name, 'MargoError');
  assert.equal(error.code, 'failed');
  assert.equal(error.report.summary[0].joint, 'r_knee');
  assert.equal(error.report.summary[0].worst.time, 0.1);
  assert.ok(error.message.includes(POSE_HELP));
  assert.doesNotThrow(() => assertPose(body, body.rest));
  assert.throws(() => checkClip(body, clip(body), {}), TypeError);
});

test('a joint turning faster than any body, held over frames, is a pop past the measured maximum', () => {
  const body = a(),
    spin = body.names.indexOf('LeftForeArm');
  // 300 degrees a frame of forearm roll at 30 fps, every frame: 9,000 deg/s is three standard deviations past the
  // fastest mean Fleisig et al. 2017 measured (shoulder internal rotation, 6,756).
  const frames = Array.from({ length: 8 }, (_, i) => {
    const pose = Float64Array.from(body.rest),
      o = spin * 10 + 3;
    pose.set(qmul([pose[o], pose[o + 1], pose[o + 2], pose[o + 3]], qaxis([0, 1, 0], (i * 175 * Math.PI) / 180)), o);
    return pose;
  });
  const report = checkClip(body, frames, { fps: 60, volumes: false, tier: 'structural' });
  const pop = report.summary.find((row) => row.code === 'pop');
  assert.ok(pop && pop.worst.value > 9000 && pop.worst.limit === 9000, formatPoseReport(report));
});

test('the checker refuses what is not a fitted body or a pose', () => {
  const body = a();
  assert.throws(() => checkPose({}, body.rest), TypeError);
  assert.throws(() => checkPose(body, new Float64Array(3)), TypeError);
  assert.throws(() => checkClip(body, clip(body), { duration: 1, fps: 0 }), RangeError);
});
