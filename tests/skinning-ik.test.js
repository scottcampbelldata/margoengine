import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import {
  solveArm,
  rotateWorld,
  worldPosition,
  localPoint,
  gripPosition,
  holdObjectAtGrip,
} from '../examples/skinning-ik/rig-ik.ts';

const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
const close = (a, b, tolerance = 3e-5) =>
  assert.ok(distance(a, b) < tolerance, `${JSON.stringify(a)} differs from ${JSON.stringify(b)}`);
const position = (mesh) => [mesh.position.x, mesh.position.y, mesh.position.z];
const quaternion = (mesh) => {
  const t = mesh.engine.store.transforms,
    id = mesh.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
};

async function rig() {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 256, height: 256, clientWidth: 256, clientHeight: 256 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    root = engine.createMesh(),
    shoulder = engine.createMesh().setParent(root).setPosition([0, 0.2, 0]),
    elbow = engine.createMesh().setParent(shoulder).setPosition([1, 0, 0]),
    wrist = engine.createMesh().setParent(elbow).setPosition([0.8, 0, 0]);
  store.tick(false);
  return { engine, store, root, shoulder, elbow, wrist };
}

test('arm IK reaches a world-space target under translated, rotated and scaled ancestors', async () => {
  const r = await rig();
  try {
    r.root.setPosition([3, 1, -2]).setRotation([0.35, -0.7, 0.4]).setScale([1.7, 1.7, 1.7]);
    r.shoulder.setRotation([-0.2, 0.3, -0.4]).setScale([0.9, 0.9, 0.9]);
    r.elbow.setRotation([0.15, -0.25, 0.3]);
    r.wrist.setRotation([0.1, 0.2, -0.1]);
    r.store.tick(false);
    const initial = [r.shoulder, r.elbow, r.wrist].map(worldPosition),
      lengths = [distance(initial[0], initial[1]), distance(initial[1], initial[2])],
      localPositions = [r.shoulder, r.elbow, r.wrist].map(position),
      wristRotation = quaternion(r.wrist),
      target = initial[0].map((value, axis) => value + [1.1, 0.85, -0.25][axis]),
      pole = initial[0].map((value, axis) => value + [-1, 1.4, 2][axis]),
      result = solveArm({ ...r, target, pole });
    close(result.wrist, target);
    close([distance(worldPosition(r.shoulder), result.elbow), distance(result.elbow, result.wrist)], lengths);
    assert.deepEqual([r.shoulder, r.elbow, r.wrist].map(position), localPositions);
    assert.deepEqual(quaternion(r.wrist), wristRotation, 'the solver must preserve the wrist local orientation');
    assert.ok(result.residual < 3e-5);
  } finally {
    r.engine.dispose();
  }
});

test('arm IK clamps distant and coincident targets without stretching or non-finite poses', async () => {
  for (const offset of [
    [100, -30, 20],
    [0, 0, 0],
    [-1e-7, 0, 0],
    [1.799999, 0, 0],
  ]) {
    const r = await rig();
    try {
      const shoulder = worldPosition(r.shoulder),
        target = shoulder.map((value, axis) => value + offset[axis]),
        result = solveArm({ ...r, target, pole: [0, 2, 0] });
      close([distance(shoulder, result.elbow), distance(result.elbow, result.wrist)], [1, 0.8]);
      assert.ok([...result.elbow, ...result.wrist, result.residual].every(Number.isFinite));
      assert.ok(distance(shoulder, result.wrist) <= 1.80003);
      assert.ok(distance(shoulder, result.wrist) >= 0.19997);
      if (Math.hypot(...offset) > 10) assert.ok(result.residual > 100);
    } finally {
      r.engine.dispose();
    }
  }
});

test('solving an unchanged target repeatedly does not drift a paused pose', async () => {
  const r = await rig();
  try {
    r.root.setPosition([-2, 0.5, 3]).setRotation([0.4, -0.2, 0.6]).setScale([1.3, 1.3, 1.3]);
    const options = { ...r, target: [-1.2, 1.1, 3.5], pole: [-3, 2, 4] },
      first = solveArm(options),
      translations = [r.shoulder, r.elbow, r.wrist].map(position);
    for (let frame = 0; frame < 300; frame++) {
      const result = solveArm(options);
      close(result.elbow, first.elbow);
      close(result.wrist, first.wrist);
      assert.ok(result.residual < 3e-5);
    }
    assert.deepEqual([r.shoulder, r.elbow, r.wrist].map(position), translations);
  } finally {
    r.engine.dispose();
  }
});

test('equal-length arms stay stable at a fully folded coincident target', async () => {
  const r = await rig();
  try {
    r.wrist.setPosition([1, 0, 0]);
    r.root.setPosition([2.1, -0.7, 3.2]).setRotation([0.3, -0.2, 0.5]).setScale([1.2, 1.2, 1.2]);
    r.store.tick(false);
    const target = worldPosition(r.shoulder),
      options = { ...r, target, pole: [target[0], target[1] + 2, target[2]] },
      first = solveArm(options);
    for (let frame = 0; frame < 300; frame++) {
      const result = solveArm(options);
      close(result.elbow, first.elbow);
      close(result.wrist, target);
      assert.ok([...quaternion(r.shoulder), ...quaternion(r.elbow)].every(Number.isFinite));
    }
  } finally {
    r.engine.dispose();
  }
});

test('world rotation deltas respect a rotated parent without changing local translations', async () => {
  const r = await rig();
  try {
    r.root.setRotation([0, 0, Math.PI / 2]);
    r.store.tick(false);
    const local = position(r.elbow),
      start = worldPosition(r.shoulder);
    rotateWorld(r.shoulder, [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)]);
    r.store.tick(false);
    close(worldPosition(r.elbow), [start[0] - 1, start[1], start[2]]);
    assert.deepEqual(position(r.elbow), local);
  } finally {
    r.engine.dispose();
  }
});

test('arm IK rejects unsupported chains, scales and invalid input before rotating joints', async () => {
  const r = await rig();
  try {
    const options = { ...r, target: [1, 1, 0], pole: [0, 2, 0] },
      original = quaternion(r.shoulder);
    r.root.setScale([1, 2, 1]);
    assert.throws(() => solveArm(options), /positive uniform/);
    r.root.setScale([-1, -1, -1]);
    assert.throws(() => solveArm(options), /positive uniform/);
    r.root.setScale([1, 1, 1]);
    r.wrist.setScale([1, 1, 2]);
    assert.throws(() => solveArm(options), /positive uniform/);
    r.wrist.setScale([1, 1, 1]);
    r.wrist.setParent(r.shoulder);
    assert.throws(() => solveArm(options), /direct shoulder/);
    r.wrist.setParent(r.elbow);
    assert.throws(() => solveArm({ ...options, target: [NaN, 0, 0] }), /IK point/);
    assert.throws(() => rotateWorld(r.shoulder, [0, 0, 0, 0]), /Invalid arm IK rotation/);
    r.elbow.setPosition([0, 0, 0]);
    assert.throws(() => solveArm(options), /zero length/);
    assert.deepEqual(quaternion(r.shoulder), original);
  } finally {
    r.engine.dispose();
  }
});

test('the visible orb stays in its palm grip with IK off, a held pose, and unreachable requests', async () => {
  const r = await rig();
  try {
    const orb = r.engine.createMesh(),
      start = worldPosition(r.wrist),
      localGrip = localPoint(r.wrist, [start[0], start[1] + 0.13, start[2]]),
      desired = r.engine.createMesh().setPosition([100, 50, -30]);
    const checkHeld = () => {
      // DragControls briefly writes the requested point; the callback restores the visible object before rendering.
      orb.setPosition(position(desired));
      const held = holdObjectAtGrip(orb, r.wrist, localGrip);
      close(held, gripPosition(r.wrist, localGrip), 1e-6);
      assert.ok(distance(held, position(desired)) > 10, 'the desired target must not place the visible orb');
      assert.deepEqual(position(desired), [100, 50, -30], 'attachment must not move the independent target');
      return held;
    };
    checkHeld(); // IK off: base pose still holds the orb.
    solveArm({ ...r, target: position(desired), pole: [0, 2, 1] });
    const limited = checkHeld(); // Unreachable: clamped arm still holds it.
    for (let frame = 0; frame < 30; frame++) close(checkHeld(), limited); // Automatic updates off: held pose.
    r.shoulder.setQuaternion([0, 0, 0, 1]);
    r.elbow.setQuaternion([0, 0, 0, 1]);
    checkHeld(); // Turning IK off resamples the base pose, while the orb returns with the hand.
  } finally {
    r.engine.dispose();
  }
});

test('palm attachment follows joint rotation and model scale with a separately parented orb', async () => {
  const r = await rig();
  try {
    const orbParent = r.engine.createMesh().setPosition([-3, 2, 1]).setRotation([0.2, 0.7, -0.1]).setScale([2, 2, 2]),
      orb = r.engine.createMesh().setParent(orbParent),
      start = worldPosition(r.wrist),
      localGrip = localPoint(r.wrist, [start[0], start[1] + 0.13, start[2]]);
    r.root.setPosition([4, -1, 2]).setRotation([0.3, -0.5, 0.6]).setScale([1.8, 1.8, 1.8]);
    r.wrist.setRotation([0.8, -0.2, 0.3]);
    const held = holdObjectAtGrip(orb, r.wrist, localGrip);
    close(held, gripPosition(r.wrist, localGrip), 2e-6);
    assert.ok(Math.abs(distance(held, worldPosition(r.wrist)) - 0.13 * 1.8) < 2e-6);
    close(localPoint(r.wrist, held), localGrip, 2e-6);
  } finally {
    r.engine.dispose();
  }
});
