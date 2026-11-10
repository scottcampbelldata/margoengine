import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solveBodyPose,
  solveHandPose,
  PoseTracker,
  readPoseTrackingFrame,
  addPoseTracking,
} from '../dist/pose-tracking.js';
import { rotateByQuaternion, multiplyQuaternions, axisAngleToQuaternion } from '../../math/dist/quat.js';
import { bodyPoints, handPoints } from './pose-tracking-fixture.js';
import { readFileSync } from 'node:fs';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset } from '../../gltf-pro/dist/asset-entry.js';
import { PBRModel } from '../../gltf-pro/dist/model-entry.js';
import { Animation } from '../../animation/dist/index.js';
import { readVRM } from '../dist/vrm.js';
import { glbChunks, GLB_JSON, GLB_BIN } from '../../shared/glb.js';
const options = { coordinateSpace: 'margo' };
const close = (a, b, epsilon = 1e-9) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${a} != ${b}`));
const sameRotation = (a, b) =>
  close(
    a,
    b.map((v) => v * (a.reduce((s, v, i) => s + v * b[i], 0) < 0 ? -1 : 1)),
  );
const unit = (p) => {
  const length = Math.hypot(...p);
  return p.map((v) => v / length);
};
function transformed(points, q) {
  return points.map((p) => {
    const v = rotateByQuaternion([p.x, p.y, p.z], q);
    return { x: v[0], y: v[1], z: v[2] };
  });
}
test('canonical full body has neutral unit rotations, centred hips and every limb/wrist output', () => {
  const pose = solveBodyPose(bodyPoints(), options);
  assert.equal(Object.keys(pose.rotations).length, 20);
  for (const q of Object.values(pose.rotations)) sameRotation(q, [0, 0, 0, 1]);
  close(pose.position, [0, 1, 0]);
});
test('straight vertical arms and horizontal side kicks retain observable swing at pole singularities', () => {
  const points = bodyPoints();
  points[13] = { x: 0.2, y: 1.9, z: 0 };
  points[15] = { x: 0.2, y: 2.2, z: 0 };
  points[25] = { x: 0.55, y: 1, z: 0 };
  points[27] = { x: 0.9, y: 1, z: 0 };
  const pose = solveBodyPose(points, options);
  for (const bone of ['leftUpperArm', 'leftLowerArm'])
    close(rotateByQuaternion([1, 0, 0], pose.worldRotations[bone]), [0, 1, 0]);
  for (const bone of ['leftUpperLeg', 'leftLowerLeg'])
    close(rotateByQuaternion([0, -1, 0], pose.worldRotations[bone]), [1, 0, 0]);
});
test('right-angle finger curls and palm-plane spreads preserve every joint direction', () => {
  for (const side of ['left', 'right'])
    for (const direction of [
      [0, -0.025, 0],
      [0, 0, 0.025],
    ]) {
      const points = handPoints(side);
      for (const start of [1, 5, 9, 13, 17])
        for (const j of [2, 3]) {
          points[start + j] = {
            x: points[start + j - 1].x + direction[0],
            y: points[start + j - 1].y + direction[1],
            z: points[start + j - 1].z + direction[2],
          };
        }
      const pose = solveHandPose(points, side, options);
      assert.equal(Object.keys(pose.rotations).length, 16);
      close(
        rotateByQuaternion([side === 'left' ? 1 : -1, 0, 0], pose.worldRotations[`${side}IndexIntermediate`]),
        unit(direction),
      );
    }
});
test('hand frame construction is scale invariant at palm poles and right-angle curls', () => {
  const points = handPoints();
  points[7] = { ...points[6], y: -0.025 };
  points[8] = { ...points[7], y: -0.05 };
  const rest = solveHandPose(points, 'left', options);
  for (const scale of [0.001, 0.01, 0.1, 10, 100]) {
    const scaled = solveHandPose(
      points.map((p) => ({ x: p.x * scale, y: p.y * scale, z: p.z * scale })),
      'left',
      options,
    );
    assert.equal(Object.keys(scaled.rotations).length, 16);
    for (const name of Object.keys(rest.rotations)) sameRotation(scaled.rotations[name], rest.rotations[name]);
  }
});
for (const side of ['left', 'right'])
  test(`all 15 ${side} finger joints plus wrist, curls reconstruct measured segment direction`, () => {
    const p = handPoints(side),
      rest = solveHandPose(p, side, options);
    assert.equal(Object.keys(rest.rotations).length, 16);
    for (const q of Object.values(rest.rotations)) sameRotation(q, [0, 0, 0, 1]);
    p[7].y -= 0.025;
    p[8].y -= 0.05;
    const pose = solveHandPose(p, side, options),
      q = pose.worldRotations[`${side}IndexIntermediate`],
      d = [p[7].x - p[6].x, p[7].y - p[6].y, p[7].z - p[6].z];
    close(rotateByQuaternion([side === 'left' ? 1 : -1, 0, 0], q), unit(d));
    assert.ok(Math.abs(pose.rotations[`${side}IndexIntermediate`][2]) > 0.3);
  });
test('body segment swing follows arbitrary lifted arm and bent knee with local/world consistency', () => {
  const p = bodyPoints();
  p[13] = { x: 0.3, y: 1.9, z: 0.2 };
  p[15] = { x: 0.5, y: 2.1, z: 0.3 };
  p[25].z = 0.3;
  const pose = solveBodyPose(p, options);
  close(rotateByQuaternion([1, 0, 0], pose.worldRotations.leftUpperArm), unit([0.1, 0.3, 0.2]));
  close(rotateByQuaternion([0, -1, 0], pose.worldRotations.leftUpperLeg), unit([0, -0.45, 0.3]));
  sameRotation(
    multiplyQuaternions(pose.worldRotations.leftUpperArm, pose.rotations.leftLowerArm),
    pose.worldRotations.leftLowerArm,
  );
});
test('whole-body rotations and palm rotations are equivariant under arbitrary camera rotation', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const q = axisAngleToQuaternion(unit([seed, seed + 2, (seed % 3) + 1]), seed * 0.17);
    const body = solveBodyPose(transformed(bodyPoints(), q), options),
      hand = solveHandPose(transformed(handPoints(), q), 'left', options);
    sameRotation(body.worldRotations.hips, q);
    sameRotation(body.worldRotations.head, q);
    sameRotation(body.worldRotations.leftUpperArm, q);
    sameRotation(hand.worldRotations.leftHand, q);
    for (const v of [...Object.values(body.worldRotations), ...Object.values(hand.worldRotations)])
      close([Math.hypot(...v)], [1]);
  }
});
test('MediaPipe conversion, mirror handedness and image aspect preserve bone directions', () => {
  const p = bodyPoints(),
    media = p.map((v) => ({ x: v.x / 2, y: -v.y, z: -v.z / 2 }));
  const converted = solveBodyPose(media, { aspect: 2 });
  close(converted.position, [0, 1, 0]);
  for (const q of Object.values(converted.rotations)) sameRotation(q, [0, 0, 0, 1]);
  const hand = solveHandPose(handPoints(), 'left', { ...options, mirror: true });
  assert.ok(hand.rotations.rightHand);
  assert.equal(hand.rotations.leftHand, undefined);
  for (const q of Object.values(hand.rotations)) sameRotation(q, [0, 0, 0, 1]);
});
test('confidence, collapsed segments and upper-body-only never create nonfinite fabricated rotations', () => {
  const p = bodyPoints();
  p[13].visibility = 0.1;
  const pose = solveBodyPose(p, options);
  assert.equal(pose.rotations.leftUpperArm, undefined);
  assert.ok(pose.rotations.rightUpperArm);
  assert.equal(solveBodyPose(bodyPoints(), { ...options, upperBodyOnly: true }).rotations.leftUpperLeg, undefined);
  assert.deepEqual(
    solveHandPose(
      Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })),
      'left',
      options,
    ).rotations,
    {},
  );
});
test('tracker calibrates arbitrary camera rest, follows movement, holds loss then fades to neutral', () => {
  const q = axisAngleToQuaternion([0, 0, 1], 0.7),
    rotated = transformed(bodyPoints(), q),
    tracker = new PoseTracker({ ...options, smoothing: 0, hold: 0.2 });
  tracker.push({ poseWorldLandmarks: rotated }).calibrate();
  for (const v of Object.values(tracker.update(0.1).worldRotations)) sameRotation(v, [0, 0, 0, 1]);
  tracker.clearCalibration();
  tracker.push({ poseWorldLandmarks: rotated });
  const pose = tracker.update(0.1);
  sameRotation(pose.worldRotations.hips, q);
  tracker.push(null);
  sameRotation(tracker.update(0.1).worldRotations.hips, q);
  sameRotation(tracker.update(0.11).worldRotations.hips, [0, 0, 0, 1]);
  tracker.push({ leftHandLandmarks: handPoints() });
  assert.ok(tracker.update(0).rotations.leftIndexDistal);
});
test('exponential smoothing composes across frame rates and returned results are independent', () => {
  const frame = { poseWorldLandmarks: transformed(bodyPoints(), axisAngleToQuaternion([0, 1, 0], 1)) },
    a = new PoseTracker(options),
    b = new PoseTracker(options);
  a.push(frame);
  b.push(frame);
  const full = a.update(0.1);
  b.update(0.04);
  const split = b.update(0.06);
  sameRotation(full.worldRotations.hips, split.worldRotations.hips);
  close(full.position, split.position);
  full.worldRotations.hips[0] = 999;
  assert.ok(Math.abs(a.update(0).worldRotations.hips[0]) < 1);
});
test('Tasks adapter selects first body and best labelled hands, carries confidence and owns hand snapshots', () => {
  const hand = handPoints(),
    result = readPoseTrackingFrame({
      pose: { worldLandmarks: [bodyPoints()] },
      hands: {
        worldLandmarks: [hand, hand],
        handedness: [[{ categoryName: 'Left', score: 0.4 }], [{ categoryName: 'Left', score: 0.9 }]],
      },
    });
  assert.equal(result.poseWorldLandmarks.length, 33);
  assert.equal(result.leftHandWorldLandmarks[0].presence, 0.9);
  assert.equal(result.rightHandLandmarks, undefined);
  result.leftHandWorldLandmarks[0].x = 100;
  assert.equal(hand[0].x, 0);
  assert.throws(
    () => readPoseTrackingFrame({ hands: { handedness: [[{ categoryName: 'unknown', score: 1 }]] } }),
    RangeError,
  );
});
test('bad options, coordinates, confidence and time fail before replacing a valid goal', () => {
  for (const option of [
    { aspect: 0 },
    { minConfidence: NaN },
    { smoothing: -1 },
    { hold: Infinity },
    { coordinateSpace: 'invalid' },
  ])
    assert.throws(() => new PoseTracker(option), RangeError);
  const tracker = new PoseTracker({ ...options, smoothing: 0 });
  tracker.push({ poseWorldLandmarks: bodyPoints() });
  const p = bodyPoints();
  p[0].x = NaN;
  assert.throws(() => tracker.push({ poseWorldLandmarks: p }), RangeError);
  assert.ok(tracker.update(0.1).rotations.hips);
  assert.throws(() => tracker.update(-1), RangeError);
  assert.throws(() => solveHandPose([], 'left'), TypeError);
});
test('native binder rejects malformed avatar mapping before attachment', async () => {
  await assert.rejects(addPoseTracking({ model: null }, { humanoid: { humanBones: {} } }));
  await assert.rejects(addPoseTracking(null, null, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
test('pinned public Kalidokit reference has the same tested index-bend magnitudes after coordinate conversion', () => {
  const reference = JSON.parse(
    readFileSync(new URL('../../../docs/whitepaper/results/batch213-pose-public-values.json', import.meta.url)),
  );
  for (const row of reference.rows)
    for (const [side, title] of [
      ['left', 'Left'],
      ['right', 'Right'],
    ]) {
      const points = handPoints(side);
      for (const start of [1, 5, 9, 13, 17]) {
        points[start + 2].y -= row.curl;
        points[start + 3].y -= row.curl * 2;
      }
      const actual = solveHandPose(points, side, options).rotations[`${side}IndexIntermediate`],
        expected = row.reference[side][`${title}IndexIntermediate`];
      assert.ok(Math.abs(2 * Math.atan2(Math.abs(actual[2]), actual[3]) - Math.abs(expected.z)) < 1e-12);
      sameRotation(actual, row.margo[side].rotations[`${side}IndexIntermediate`]);
      assert.equal(
        Object.keys(row.reference[side]).length,
        Object.keys(solveHandPose(points, side, options).rotations).length,
      );
    }
});
test('Tasks world hand landmarks ignore image aspect, while normalized hands use it', () => {
  const input = handPoints();
  input[7].z += 0.01;
  const frame = readPoseTrackingFrame({
    hands: { worldLandmarks: [input], handedness: [[{ categoryName: 'Left', score: 1 }]] },
  });
  const a = new PoseTracker({ ...options, aspect: 2, smoothing: 0 }).push(frame).update(0),
    b = new PoseTracker({ ...options, smoothing: 0 }).push(frame).update(0);
  sameRotation(a.rotations.leftIndexIntermediate, b.rotations.leftIndexIntermediate);
});
test('native binder preserves bone lengths, restores touched transforms and detaches on model disposal', async (t) => {
  const chunks = glbChunks(
      new Uint8Array(readFileSync(new URL('../../../examples/assets/vrm/Seed-san.vrm', import.meta.url))),
    ),
    doc = JSON.parse(new TextDecoder().decode(chunks.find((c) => c.type === GLB_JSON).data)),
    store = await TransformStore.create(512),
    engine = new Engine({ width: 16, height: 16, clientWidth: 16, clientHeight: 16 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    model = new PBRModel(engine, new GLTFAsset(doc, [chunks.find((c) => c.type === GLB_BIN).data])),
    animation = new Animation(model),
    avatar = readVRM(doc);
  t.after(() => {
    animation.dispose();
    model.dispose();
    engine.dispose();
  });
  const node = model.nodes[avatar.humanoid.humanBones.leftLowerArm.node],
    id = node.id,
    tr = store.transforms;
  const rotation = () => [tr.qx[id], tr.qy[id], tr.qz[id], tr.qw[id]],
    position = () => [tr.x[id], tr.y[id], tr.z[id]],
    original = rotation(),
    length = position();
  const handle = await addPoseTracking(animation, avatar, { ...options, smoothing: 0, autoUpdate: false }),
    frame = { poseWorldLandmarks: bodyPoints() };
  handle.push(frame);
  handle.tracker.calibrate();
  handle.update(0);
  sameRotation(rotation(), original);
  frame.poseWorldLandmarks[15].z += 0.3;
  handle.push(frame);
  handle.update(0.1);
  assert.ok(rotation().some((v, i) => Math.abs(v - original[i]) > 0.1));
  close(position(), length);
  handle.dispose();
  handle.dispose();
  close(rotation(), original);
  close(position(), length);
  assert.throws(() => handle.push(null), { code: 'disposed' });
  const second = await addPoseTracking(animation, avatar, { ...options, autoUpdate: true });
  second.push(frame);
  model.dispose();
  assert.doesNotThrow(() => second.dispose());
  assert.throws(() => second.update(0.1), { code: 'disposed' });
});
