// Runtime pose mirroring (@margoengine/animator/mirror): one clip serves both sides. The whole skeleton's pose reflects
// across the plane of symmetry however each bone's local axes lie, mirroring twice gives the clip back, the rest pose is
// untouched, root motion travels mirrored, and the last tests run Fox.glb and RiggedFigure.glb, real files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMirror, mirrorPairs } from '../packages/animator/dist/mirror.js';
import { addRootMotion } from '../packages/animator/dist/index.js';
import { multiplyQuaternions, rotateByQuaternion } from '../packages/math/dist/quat.js';
import {
  animatorDocument,
  animatorGLB,
  animatorRun,
  axisAngle,
  BIPED,
  FOX,
  RIGGED_FIGURE,
} from './support/animator-rig.js';

const CLIPS = {
  Still: { duration: 1, tracks: { 'Hips.translation': () => [0, 1, 0] } },
  Wave: {
    duration: 2,
    tracks: {
      'Hips.translation': (t) => [0.1 * t, 1 - 0.05 * t, 0.02 * t],
      'Hips.rotation': (t) => axisAngle([0, 1, 0], 0.3 * t),
      'Spine.rotation': (t) => axisAngle([0, 0, 1], 0.2 * t),
      'LeftArm.rotation': (t) => axisAngle([0, 0, 1], 0.8 * t),
      'LeftForeArm.rotation': (t) => axisAngle([0, 1, 0], 0.5 * t),
      'RightUpLeg.rotation': (t) => axisAngle([1, 0, 0], 0.4 * t),
    },
  },
  Drift: {
    duration: 1,
    tracks: {
      'Hips.translation': (t) => [t, 1, 0.5 * t],
      'Hips.rotation': (t) => axisAngle([0, 1, 0], 0.4 * t),
    },
  },
};
const STATES = { still: 'Still', wave: 'Wave', drift: 'Drift' };
const NAMES = Object.keys(BIPED);
const partner = (name) => (name.startsWith('Left') ? `Right${name.slice(4)}` : name.startsWith('Right') ? `Left${name.slice(5)}` : name);
const reflected = ([x, y, z]) => [-x, y, z];
const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const run = (initial = 'wave', document = animatorDocument(BIPED, CLIPS)) => animatorRun(document, { initial, states: STATES });

/** The biped with its right arm's bones on other local axes, the skeleton in the same place. */
function twisted() {
  const document = animatorDocument(BIPED, CLIPS),
    { doc, index } = document,
    turn = axisAngle([0.6, 0, 0.8], 1.3),
    back = [-turn[0], -turn[1], -turn[2], turn[3]];
  doc.nodes[index.get('RightArm')].rotation = turn;
  for (const name of ['RightForeArm', 'RightHand']) {
    const node = doc.nodes[index.get(name)];
    node.translation = rotateByQuaternion(node.translation, back);
  }
  return document;
}

test('names pair left and right however they are written', () => {
  const pairs = (names) => Array.from(mirrorPairs(names));
  assert.deepEqual(pairs(['Hips', 'LeftArm', 'RightArm']), [0, 2, 1]);
  assert.deepEqual(pairs(['arm.L', 'arm.R', 'arm_l', 'arm_r']), [1, 0, 3, 2]);
  assert.deepEqual(pairs(['leg_joint_L_1', 'leg_joint_R_1', 'L_Foot', 'R_Foot']), [1, 0, 3, 2]);
  assert.deepEqual(pairs(['mixamorig:LeftHand', 'mixamorig:RightHand']), [1, 0]);
  assert.deepEqual(pairs(['b_LeftArm_09', 'b_RightArm_06']), [1, 0], 'ids at the end differ');
  assert.deepEqual(pairs(['Clavicle', 'Right', 'Leftover', 'Tail_R']), [0, 1, 2, 3], 'no partner is its own');
  assert.deepEqual(pairs(['Finger_L_1', 'Finger_L_2', 'Finger_R_1', 'Finger_R_2']), [2, 3, 0, 1], 'ids that pair are kept');
});

test('the rest pose stays exactly the rest pose, on other local axes too', async (t) => {
  const f = await run('still', twisted()),
    plain = await run('still', twisted());
  t.after(() => {
    f.release();
    plain.release();
  });
  addMirror(f.animator);
  f.step(1 / 60);
  plain.step(1 / 60);
  for (const name of NAMES) assert.ok(gap(f.world(name), plain.world(name)) < 1e-5, name);
});

for (const [label, build] of [
  ['a rig with matching axes', () => animatorDocument(BIPED, CLIPS)],
  ['a rig whose two sides have different local axes', twisted],
])
  test(`every joint lands where its partner's reflection is, on ${label}`, async (t) => {
    const f = await run('wave', build()),
      plain = await run('wave', build());
    t.after(() => {
      f.release();
      plain.release();
    });
    addMirror(f.animator);
    for (let frame = 0; frame < 90; frame++) {
      f.step(1 / 60);
      plain.step(1 / 60);
      for (const name of NAMES) {
        const expected = reflected(plain.world(partner(name)));
        assert.ok(gap(f.world(name), expected) < 1e-4, `${name} frame ${frame}: ${f.world(name)} against ${expected}`);
      }
    }
    assert.ok(gap(plain.world('LeftHand'), reflected(plain.world('RightHand'))) > 0.2, 'the clip is not symmetric');
  });

test('mirroring twice gives the clip back', async (t) => {
  const f = await run('wave', twisted()),
    plain = await run('wave', twisted());
  t.after(() => {
    f.release();
    plain.release();
  });
  addMirror(f.animator);
  addMirror(f.animator);
  f.step(1 / 60, 60);
  plain.step(1 / 60, 60);
  for (const name of NAMES) assert.ok(gap(f.world(name), plain.world(name)) < 1e-4, name);
});

test('rotations mirror as well as places', async (t) => {
  const f = await run(),
    plain = await run();
  t.after(() => {
    f.release();
    plain.release();
  });
  addMirror(f.animator);
  f.step(1 / 60, 60);
  plain.step(1 / 60, 60);
  const q = plain.rotation('LeftArm'),
    r = f.rotation('RightArm');
  for (const [c, sign] of [[0, 1], [1, -1], [2, -1], [3, 1]]) assert.ok(Math.abs(r[c] - sign * q[c]) < 1e-5);
  assert.ok(Math.abs(multiplyQuaternions(r, [-r[0], -r[1], -r[2], r[3]])[3] - 1) < 1e-6);
});

test('a mirrored clip travels mirrored, turning the other way', async (t) => {
  const f = await run('drift'),
    plain = await run('drift');
  t.after(() => {
    f.release();
    plain.release();
  });
  addRootMotion(f.animator, { joint: f.index.get('Hips'), rotation: true });
  addRootMotion(plain.animator, { joint: plain.index.get('Hips'), rotation: true });
  addMirror(f.animator);
  f.step(1 / 60, 30);
  plain.step(1 / 60, 30);
  const a = f.world('Hips'),
    b = plain.world('Hips');
  assert.ok(Math.abs(b[0]) > 0.2, `the clip travels ${b[0]}`);
  assert.ok(gap(a, reflected(b)) < 1e-4, `${a} against ${b}`);
  const turned = f.model.root.matrix,
    plainTurned = plain.model.root.matrix;
  assert.ok(Math.abs(plainTurned[8]) > 0.1);
  assert.ok(Math.abs(turned[8] + plainTurned[8]) < 1e-5, 'the turn is opposite');
});

test('enabled and states choose when, and dispose stops it', async (t) => {
  const f = await run(),
    plain = await run();
  t.after(() => {
    f.release();
    plain.release();
  });
  const mirror = { enabled: false },
    handle = addMirror(f.animator, mirror);
  f.step(1 / 60, 30);
  plain.step(1 / 60, 30);
  const same = () => NAMES.every((name) => gap(f.world(name), plain.world(name)) < 1e-5);
  assert.ok(same(), 'off');
  mirror.enabled = true;
  f.step(1 / 60);
  plain.step(1 / 60);
  assert.ok(!same(), 'on');
  mirror.states = ['still'];
  f.step(1 / 60);
  plain.step(1 / 60);
  assert.ok(same(), 'another state');
  mirror.states = null;
  handle.dispose();
  handle.dispose();
  f.step(1 / 60);
  plain.step(1 / 60);
  assert.ok(same(), 'disposed');
});

test('morph targets trade by name', async (t) => {
  const document = animatorDocument(BIPED, {
      Smile: { duration: 1, tracks: { 'Root.weights': (t) => [t, 0.25] } },
    }),
    primitive = document.doc.meshes[0].primitives[0];
  primitive.targets = [{ POSITION: primitive.attributes.POSITION }, { POSITION: primitive.attributes.POSITION }];
  document.doc.meshes[0].extras = { targetNames: ['smile_L', 'smile_R'] };
  const f = await animatorRun(document, { initial: 'smile', states: { smile: 'Smile' } });
  t.after(() => f.release());
  addMirror(f.animator);
  f.step(0.5);
  const weights = f.model.primitives.find((item) => item.weights.length).weights;
  assert.ok(Math.abs(weights[0] - 0.25) < 1e-6, `left ${weights[0]}`);
  assert.ok(Math.abs(weights[1] - 0.5) < 1e-6, `right ${weights[1]}`);
});

test('axis y and z reflect across other planes', async (t) => {
  const f = await run(),
    plain = await run();
  t.after(() => {
    f.release();
    plain.release();
  });
  const self = Int32Array.from(NAMES, (_, i) => i);
  addMirror(f.animator, { axis: 'z', pairs: self });
  f.step(1 / 60, 30);
  plain.step(1 / 60, 30);
  const [x, y, z] = plain.world('Head');
  assert.ok(gap(f.world('Head'), [x, y, -z]) < 1e-4);
});

test('bad settings name the fix', async (t) => {
  const f = await run();
  t.after(() => f.release());
  const count = NAMES.length,
    self = () => Array.from({ length: count }, (_, i) => i),
    i = (name) => f.index.get(name);
  assert.throws(() => addMirror(f.animator, { axis: 'w' }), /axis/);
  assert.throws(() => addMirror(f.animator, { pairs: [0] }), /each of the model/);
  const oneWay = self();
  oneWay[1] = 2;
  assert.throws(() => addMirror(f.animator, { pairs: oneWay }), /both ways/);
  const strange = self();
  strange[i('LeftHand')] = i('RightArm');
  strange[i('RightArm')] = i('LeftHand');
  assert.throws(() => addMirror(f.animator, { pairs: strange }), /built alike/);
});

for (const [label, url, clip] of [
  ['Fox.glb', FOX, 'Walk'],
  ['RiggedFigure.glb', RIGGED_FIGURE, 'Animation 0'],
])
  test(`${label}: its real clip plays on the other side`, async (t) => {
    const load = () => animatorRun(animatorGLB(url), { initial: 'a', states: { a: clip } }),
      f = await load(),
      plain = await load(),
      handle = addMirror(f.animator),
      names = [...f.index.keys()].filter((name) => name !== undefined),
      pairs = handle.pairs,
      other = (name) => names[pairs[f.index.get(name)]];
    t.after(() => {
      f.release();
      plain.release();
    });
    const paired = Array.from(pairs).filter((partnerIndex, i) => partnerIndex !== i).length;
    assert.ok(paired >= 10, `${paired} bones paired`);
    // How far the file's own rest pose is from symmetric bounds how far the mirrored pose can land from its reflection.
    let asymmetry = 0,
      size = 0;
    for (const name of names) {
      asymmetry = Math.max(asymmetry, gap(plain.world(name), reflected(plain.world(other(name)))));
      size = Math.max(size, Math.hypot(...plain.world(name)));
    }
    plain.animator.playing = true;
    f.step(0.1, 5);
    plain.step(0.1, 5);
    let worst = 0;
    for (const name of names) worst = Math.max(worst, gap(f.world(name), reflected(plain.world(other(name)))));
    assert.ok(size > 0);
    assert.ok(worst <= 2 * asymmetry + size * 1e-3, `off by ${worst}, the rest pose by ${asymmetry}, size ${size}`);
  });
