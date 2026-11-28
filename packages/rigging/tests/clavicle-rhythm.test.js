// The collarbone's zero on a rig that rests with its arms raised (KB-RIG-CLAVICLE1). A raised arm lifts and draws back
// the collarbone (Ludewig et al. 2009: 5.9 up and 19.2 back at the side, 11 to 17 up and 23 to 39 back from 30 to 120
// degrees of arm elevation), so an A pose rest is not the collarbone's anatomical zero. The fit reads the rig's own rest
// collarbone against the direction at the side, never past the rhythm for the rest arm's lift, as one swing; a rig whose
// collarbone does not rise with its arm keeps its rest as zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitAnatomy, jointAngles } from '@margoengine/rigging/anatomy';
import { human } from '@margoengine/rigging/anatomy/human';
import { bodyRig, sub } from './anatomy-fixtures.js';

const rigOf = (options) => {
  const joints = bodyRig({ fingers: false, ...options }),
    rig = { names: joints.map((j) => j.name), parents: joints.map((j) => j.parent), rest: new Float64Array(joints.length * 10) };
  joints.forEach((j, i) => rig.rest.set([...sub(j.position, j.parent < 0 ? [0, 0, 0] : joints[j.parent].position), 0, 0, 0, 1, 1, 1, 1], i * 10));
  return fitAnatomy(rig, { species: human });
};
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
