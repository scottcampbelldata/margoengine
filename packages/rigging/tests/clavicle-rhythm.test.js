// The collarbone's zero on a rig that rests with its arms raised (KB-RIG-CLAVICLE1). A raised arm lifts and draws back
// the collarbone (Ludewig et al. 2009: 5.9 up and 19.2 back at the side, 11 to 17 up and 23 to 39 back from 30 to 120
// degrees of arm elevation), so an A pose rest is not the collarbone's anatomical zero. The fit reads the rig's own rest
// collarbone against the direction at the side, never past the rhythm for the rest arm's lift, as one swing; a rig whose
// collarbone does not rise with its arm keeps its rest as zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAnatomy, jointAngles, poseFromAngles, rhythmDrops } from '@margoengine/rigging/anatomy';
import { human } from '@margoengine/rigging/anatomy/human';
import { bodyRig, sub } from './anatomy-fixtures.js';

const rawRig = (options) => {
  const joints = bodyRig({ fingers: false, ...options }),
    rig = { names: joints.map((j) => j.name), parents: joints.map((j) => j.parent), rest: new Float64Array(joints.length * 10) };
  joints.forEach((j, i) => rig.rest.set([...sub(j.position, j.parent < 0 ? [0, 0, 0] : joints[j.parent].position), 0, 0, 0, 1, 1, 1, 1], i * 10));
  return rig;
};
const rigOf = (options, fit = {}) => fitAnatomy(rawRig(options), { species: human, ...fit });
// The rhythm between Ludewig's rows: elevation and retraction at a lift of 0, 30 or 120 degrees and straight between.
const ludewig = (lift) =>
  lift <= 30 ? [5.9 + (lift / 30) * 5.1, 19.2 + (lift / 30) * 3.8] : [11 + ((lift - 30) / 90) * 6, 23 + ((lift - 30) / 90) * 16];
const reads = (body) => {
  const a = jointAngles(body, body.rest);
  return ['l', 'r'].map((s) => a[`${s}_sternoclavicular`]);
};
const near = (got, want, what) => assert.ok(Math.abs(got - want) < 0.05, `${what}: ${got.toFixed(3)}, want ${want.toFixed(3)}`);

test('an A pose rest whose collarbone rose with the arm reads that rise, with no twist', () => {
  const [e, r] = ludewig(45),
    body = rigOf({ arms: 45, clavicle: [e, r] });
  for (const sc of reads(body)) {
    near(sc.flexion, e - 5.9, 'elevation');
    near(sc.abduction, -(r - 19.2), 'protraction');
    near(sc.rotation, 0, 'twist');
  }
});

test('a collarbone raised past the rhythm reads only the rhythm, and a rest at the side reads zero', () => {
  const [e, r] = ludewig(45);
  for (const sc of reads(rigOf({ arms: 45, clavicle: [25, 45] }))) {
    near(sc.flexion, e - 5.9, 'elevation');
    near(sc.abduction, -(r - 19.2), 'protraction');
    near(sc.rotation, 0, 'twist');
  }
  for (const sc of reads(rigOf({ arms: 0, clavicle: [12, 30] }))) for (const v of [sc.flexion, sc.abduction, sc.rotation]) near(v, 0, 'at the side');
});

test('a rig whose collarbone does not rise with its arm keeps its rest as zero, T pose or A pose', () => {
  for (const arms of [0, 45, 90])
    for (const sc of reads(rigOf({ arms }))) for (const v of [sc.flexion, sc.abduction, sc.rotation]) near(v, 0, `${arms} degree arms`);
});

test('the same collarbone posture reads the same whichever pose the rig rests in', () => {
  // The A pose rig's collarbone, read on the T pose rig fitted from the same body: the same angles both ways.
  const [e45, r45] = ludewig(45),
    [e90, r90] = ludewig(90);
  const a = reads(rigOf({ arms: 45, clavicle: [e45, r45] }))[0],
    t = reads(rigOf({ arms: 90, clavicle: [e90, r90] }))[0];
  near(t.flexion - a.flexion, e90 - e45, 'elevation between the rests');
  near(-(t.abduction - a.abduction), r90 - r45, 'retraction between the rests');
});

// A Character Creator clavicle bone aims at the shoulder joint's centre, below the collarbone, so an A pose rest whose
// collarbone is raised reads below the direction at the side and the fit kept the rest as zero: the old man's walk then
// read the collarbone 13 to 15 degrees depressed (KB-RIG-CLAVICLE1). The rig's own clips show the drop where they hang
// the arm, and the fit takes the zero back by it, never past the rhythm.
const hanging = (body, lift, drop, back) =>
  poseFromAngles(
    body,
    Object.fromEntries(
      ['l', 'r'].flatMap((s) => [
        [`${s}_shoulder`, { flexion: 0, abduction: lift, rotation: 0 }],
        [`${s}_sternoclavicular`, { flexion: -drop, abduction: back, rotation: 0 }],
      ]),
    ),
  );

test('the clips show how far a collarbone drops from an A pose rest where they hang the arm', () => {
  const body = rigOf({ arms: 60 }),
    [e10, r10] = ludewig(10),
    drops = rhythmDrops(body, [hanging(body, 10, 6, 4), hanging(body, 10, 6, 4), hanging(body, 60, 0, 0)]);
  for (const s of ['l', 'r']) {
    near(drops[`${s}_sternoclavicular`][0], 6 + (e10 - 5.9), `${s} elevation dropped`);
    near(drops[`${s}_sternoclavicular`][1], 4 + (r10 - 19.2), `${s} retraction dropped`);
  }
  assert.deepEqual(rhythmDrops(body, [hanging(body, 60, 0, 0)]), {}, 'no pose hangs the arm');
});

test('a rest whose clips drop the collarbone takes its zero back by the drop, never past the rhythm', () => {
  const [e60, r60] = ludewig(60);
  // Without the clips' drop the rest is the zero: this was the bug.
  for (const sc of reads(rigOf({ arms: 60 }))) for (const v of [sc.flexion, sc.abduction]) near(v, 0, 'no drop');
  for (const sc of reads(rigOf({ arms: 60 }, { drop: { l_sternoclavicular: [3, 2], r_sternoclavicular: [3, 2] } }))) {
    near(sc.flexion, 3, 'elevation within the rhythm');
    near(sc.abduction, -2, 'retraction within the rhythm');
    near(sc.rotation, 0, 'twist');
  }
  for (const sc of reads(rigOf({ arms: 60 }, { drop: { l_sternoclavicular: [30, 30], r_sternoclavicular: [30, 30] } }))) {
    near(sc.flexion, e60 - 5.9, 'elevation capped by the rhythm');
    near(sc.abduction, -(r60 - 19.2), 'retraction capped by the rhythm');
  }
  // A rest with the arm at the side has no rhythm to give back, and a clip that raises the collarbone gives nothing.
  for (const sc of reads(rigOf({ arms: 0 }, { drop: { l_sternoclavicular: [8, 8], r_sternoclavicular: [8, 8] } })))
    for (const v of [sc.flexion, sc.abduction]) near(v, 0, 'at the side');
  for (const sc of reads(rigOf({ arms: 60 }, { drop: { l_sternoclavicular: [-5, -5], r_sternoclavicular: [-5, -5] } })))
    for (const v of [sc.flexion, sc.abduction]) near(v, 0, 'raised in the clips');
  assert.throws(() => rigOf({ arms: 60 }, { drop: { l_shoulder: [1, 1] } }), /options\.drop: "l_shoulder"/);
});
