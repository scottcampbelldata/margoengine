// WebXR body tracking against a fake session with the Body Tracking Module's shapes: the joint list, feature
// detection that fails softly, all-or-nothing reads, emulated positions and the humanoid bone mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyTracking, BODY_JOINT_NAMES, BODY_JOINT_TO_HUMANOID, humanoidPose } from '../dist/body.js';

const ref = { reference: true };
const pose = (x, y, z, emulatedPosition = false) => ({
  transform: {
    position: { x, y, z, w: 1 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    matrix: new Float32Array(16),
    inverse: { matrix: new Float32Array(16) },
  },
  emulatedPosition,
});
const session = (features) => Object.assign(new EventTarget(), { enabledFeatures: features, inputSources: [] });
const body = () => {
  const spaces = new Map(BODY_JOINT_NAMES.map((n, i) => [n, { joint: n, i }]));
  return { size: 83, get: (n) => spaces.get(n) };
};
const frameOf = (s, b, poses = (sp) => pose(sp.i, sp.i * 2, 3)) => ({
  session: s,
  body: b,
  getPose: (space, base) => (base === ref && space.joint ? poses(space) : null),
});

test('83 joints in spec order, names unique', () => {
  assert.equal(BODY_JOINT_NAMES.length, 83);
  assert.equal(new Set(BODY_JOINT_NAMES).size, 83);
  assert.deepEqual(BODY_JOINT_NAMES.slice(0, 7), [
    'hips',
    'spine-lower',
    'spine-middle',
    'spine-upper',
    'chest',
    'neck',
    'head',
  ]);
  assert.ok(BODY_JOINT_NAMES.includes('left-hand-middle-phalanx-metacarpal'));
  assert.ok(BODY_JOINT_NAMES.includes('right-foot-ball'));
});

test('reads every joint as a pose in the reference space', () => {
  const s = session(['local', 'body-tracking']);
  const bt = BodyTracking.create({ session: s, referenceSpace: ref });
  assert.equal(bt.available, true);
  const p = bt.read(frameOf(s, body()));
  assert.deepEqual([...p.position('head')], [6, 12, 3]);
  assert.deepEqual([...p.rotation('hips')], [0, 0, 0, 1]);
  assert.equal(p.position('nope'), undefined);
  assert.equal(p.emulated, false);
});

test('a joint without a pose, no body, or another session gives null', () => {
  const s = session(['body-tracking']);
  const bt = BodyTracking.create({ session: s, referenceSpace: ref });
  assert.equal(bt.read(frameOf(s, body(), (sp) => (sp.i === 40 ? null : pose(0, 0, 0)))), null);
  assert.equal(bt.read(frameOf(s, null)), null);
  assert.equal(bt.read(frameOf(session([]), body())), null);
});

test('emulated positions are flagged', () => {
  const s = session(['body-tracking']);
  const bt = BodyTracking.create({ session: s, referenceSpace: ref });
  assert.equal(bt.read(frameOf(s, body(), (sp) => pose(0, 0, 0, sp.i === 3)))?.emulated, true);
});

test('missing feature fails softly, or with a coded error when required', () => {
  const s = session(['local']);
  const bt = BodyTracking.create({ session: s, referenceSpace: ref });
  assert.equal(bt.available, false);
  assert.equal(bt.read(frameOf(s, body())), null);
  assert.throws(() => BodyTracking.create({ session: s, referenceSpace: ref }, { required: true }), {
    code: 'unsupported',
  });
  assert.throws(() => BodyTracking.create({ session: null, referenceSpace: ref }), { code: 'state' });
});

test('humanoid mapping names real bones once each', () => {
  const bones = Object.values(BODY_JOINT_TO_HUMANOID);
  assert.equal(new Set(bones).size, bones.length);
  assert.equal(BODY_JOINT_TO_HUMANOID['left-arm-upper'], 'leftUpperArm');
  assert.equal(BODY_JOINT_TO_HUMANOID['right-hand-wrist'], 'rightHand');
  assert.equal(BODY_JOINT_TO_HUMANOID['left-hand-thumb-metacarpal'], 'leftThumbMetacarpal');
  assert.equal(BODY_JOINT_TO_HUMANOID['left-hand-ring-phalanx-intermediate'], 'leftRingIntermediate');
  assert.equal(BODY_JOINT_TO_HUMANOID['left-hand-middle-phalanx-metacarpal'], undefined);
  const s = session(['body-tracking']);
  const p = BodyTracking.create({ session: s, referenceSpace: ref }).read(frameOf(s, body()));
  const h = humanoidPose(p);
  assert.deepEqual(h.get('hips').position, [0, 0, 3]);
  assert.equal(h.get('leftFoot').rotation[3], 1);
});
