import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { HeadAim } from '../examples/skinning-ik/head-aim.ts';
import { cowlingHull } from '../examples/skinning-ik/head-aim-shape.ts';

const optical = [0, 0.19, -0.232];
const localQuaternion = (head) => {
  const t = head.engine.store.transforms,
    id = head.id;
  return [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
};
const close = (a, b, epsilon = 2e-6) => {
  assert.ok(Math.hypot(...a.map((value, i) => value - b[i])) < epsilon, `${a} differs from ${b}`);
};
async function fixture() {
  const store = await TransformStore.create(16),
    engine = new Engine({ width: 256, height: 256, clientWidth: 256, clientHeight: 256 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    });
  const root = engine.createMesh(),
    body = engine.createMesh().setParent(root),
    head = engine.createMesh().setParent(body).setPosition([0, 1.15, 0]);
  store.tick(false);
  return { engine, store, root, body, head };
}
const transformPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

test('optical ray meets the actual Home orb and ordinary front targets', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const aim = new HeadAim(f.head, optical);
  for (const target of [
    [-0.48, 1.17, -0.23],
    [-0.3, 1.05, -0.48],
    [0.28, 1.2, -0.45],
    [0, 1.34, -0.8],
  ]) {
    aim.update(target);
    assert.equal(aim.limited, false, `Unexpected clamp at ${target}`);
    assert.ok(aim.rayDistance < 2e-6, `Optical ray misses ${target} by ${aim.rayDistance}`);
    assert.ok(aim.rayError < 2e-5);
    close(aim.origin, transformPoint(f.head.matrix, optical));
    assert.ok(Math.abs(Math.hypot(...aim.forward) - 1) < 1e-12);
  }
});

test('absolute aiming follows transformed uniformly scaled parents and a rotated rest head', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  f.root.setPosition([2, -0.4, 1]).setRotation([0.25, -0.6, 0.15]).setScale([1.7, 1.7, 1.7]);
  f.body.setRotation([-0.1, 0.3, 0.12]).setScale([0.8, 0.8, 0.8]);
  f.head.setRotation([0.08, -0.1, 0.05]).setScale([0.9, 0.9, 0.9]);
  f.store.tick(false);
  const target = transformPoint(f.head.matrix, [-0.25, 0.02, -0.7]),
    aim = new HeadAim(f.head, optical);
  aim.update(target);
  assert.equal(aim.limited, false);
  assert.ok(aim.rayDistance < 4e-6);
  assert.ok(aim.rayError < 2e-5);
  f.root.setRotation([-0.15, 0.25, -0.12]);
  f.store.tick(false);
  // A changed parent must be read on the next update, rather than cached as a
  // world rest rotation at construction.
  aim.update(target);
  assert.ok(Number.isFinite(aim.rayError));
  assert.ok(aim.angle <= 1.3);
});

test('repeated target and probe updates are idempotent and reset restores rest', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const rest = localQuaternion(f.head),
    aim = new HeadAim(f.head, optical),
    target = [-0.48, 1.17, -0.23];
  aim.update(target);
  const expected = localQuaternion(f.head),
    origin = [...aim.origin];
  let writes = 0;
  const original = f.head.setQuaternion;
  f.head.setQuaternion = function (value) {
    writes++;
    return original.call(this, value);
  };
  for (let i = 0; i < 120; i++) aim.update(target);
  assert.deepEqual(localQuaternion(f.head), expected);
  assert.deepEqual(aim.origin, origin);
  assert.equal(writes, 0, 'Unchanged probe poses need no quaternion rewrite');
  f.head.setRotation([0, 0.02, 0]);
  aim.update(target);
  assert.deepEqual(localQuaternion(f.head), expected, 'An animator base-pose write must not defeat the absolute aim');
  aim.reset();
  close(localQuaternion(f.head), rest);
  assert.equal(aim.limited, false);
  assert.equal(aim.angle, 0);
  aim.update(target);
  assert.deepEqual(localQuaternion(f.head), expected);
});

test('behind, opposite, coincident and inside-orbit targets stay finite and neck bounded', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const aim = new HeadAim(f.head, optical);
  for (const target of [
    [0, 1.15, 0.8],
    [0, 1.15, 0],
    [0, 1.2, -0.02],
    [0, 0.96, 0.232],
  ]) {
    aim.update(target);
    assert.equal(aim.limited, true);
    assert.ok(aim.angle <= 1.3);
    assert.ok(
      [...localQuaternion(f.head), ...aim.origin, ...aim.forward, aim.rayError, aim.rayDistance].every(Number.isFinite),
    );
    const q = localQuaternion(f.head);
    assert.ok(2 * Math.acos(Math.min(1, Math.abs(q[3]))) <= 1.3 + 2e-6);
    for (let i = 0; i < 10; i++) aim.update(target);
    assert.deepEqual(localQuaternion(f.head), q);
  }
});

test('head guards reject invalid targets, travel and ancestor scales before rotation changes', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  assert.throws(() => new HeadAim(f.head, [0, NaN, 0]));
  for (const angle of [-1, Infinity, NaN, Math.PI + 0.1]) assert.throws(() => new HeadAim(f.head, optical, angle));
  const aim = new HeadAim(f.head, optical),
    before = localQuaternion(f.head);
  for (const target of [
    [0, Infinity, 0],
    [NaN, 0, 0],
    [0, 0],
    ['1', 0, 0],
    [null, 0, 0],
    [1e40, 0, 0],
  ]) {
    assert.throws(() => aim.update(target));
    assert.deepEqual(localQuaternion(f.head), before);
  }
  for (const scale of [
    [1, 2, 1],
    [-1, -1, -1],
  ]) {
    f.root.setScale(scale);
    assert.throws(() => aim.update([0, 1.2, -0.6]), /positive uniform/);
    assert.deepEqual(localQuaternion(f.head), before);
  }
});

test('inside-orbit fallback reports the closest optical-origin distance and copies its offset', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const offset = [...optical],
    aim = new HeadAim(f.head, offset, Math.PI);
  offset.fill(0);
  const target = [0, f.head.matrix[13], -0.1];
  aim.update(target);
  assert.equal(aim.limited, true);
  assert.ok(Math.abs(aim.rayDistance - (Math.hypot(...optical) - 0.1)) < 2e-6);
  assert.ok(aim.rayError > Math.PI / 2, 'Target lies behind the presented ray origin');
  close(aim.origin, transformPoint(f.head.matrix, optical));
});

test('opposite directions remain deterministic and zero neck travel preserves rotated rest', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const aim = new HeadAim(f.head, [0, 0, 0], Math.PI);
  for (const x of [0, 1e-10, -1e-10]) {
    aim.update([x, f.head.matrix[13], 1]);
    assert.equal(aim.limited, false);
    assert.ok(aim.rayError < 1e-6);
    assert.ok(localQuaternion(f.head).every(Number.isFinite));
  }
  f.head.setRotation([0.15, -0.2, 0.1]);
  const rest = localQuaternion(f.head),
    locked = new HeadAim(f.head, optical, 0);
  locked.update([-0.48, 1.17, -0.23]);
  close(localQuaternion(f.head), rest);
  assert.equal(locked.limited, true);
  assert.equal(locked.angle, 0);
  f.head.setRotation([0.3, 0.1, -0.2]);
  locked.reset();
  close(localQuaternion(f.head), rest);
});

test('optional physical head bounds keep close orbs clear and honestly report impossible targets', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const guard = {
      min: [-0.194, -0.039, -0.236],
      max: [0.194, 0.307, 0.134],
      targetRadius: 0.10465342044830322,
      margin: 0.003,
    },
    aim = new HeadAim(f.head, optical, 1.3, guard);
  guard.min.fill(0);
  guard.max.fill(0);
  for (const target of [
    [-0.48, 1.17, -0.23],
    [-0.15, 1.16, -0.3],
    [0, 1.16, -0.3],
    [0.235, 1.16, -0.3],
  ]) {
    aim.update(target);
    assert.equal(aim.clearanceResolved, true, `Unresolved guard at ${target}`);
    assert.ok(aim.headClearance >= 0);
    assert.ok(aim.angle <= 1.3);
    const q = localQuaternion(f.head),
      clearance = aim.headClearance;
    for (let i = 0; i < 10; i++) aim.update(target);
    assert.deepEqual(localQuaternion(f.head), q);
    assert.equal(aim.headClearance, clearance);
  }
  aim.update([0, f.head.matrix[13], 0]);
  assert.equal(aim.clearanceResolved, false);
  assert.equal(aim.limited, true);
  assert.ok(aim.headClearance < 0);
  assert.ok(localQuaternion(f.head).every(Number.isFinite));
  const before = localQuaternion(f.head),
    angle = aim.angle;
  assert.equal(aim.checkClearance([0, f.head.matrix[13], 0]), false);
  assert.deepEqual(localQuaternion(f.head), before);
  assert.equal(aim.angle, angle);
  assert.throws(() => aim.checkClearance([0, Infinity, 0]));
  assert.deepEqual(localQuaternion(f.head), before);
  aim.reset([0, f.head.matrix[13], 0]);
  assert.equal(aim.clearanceResolved, false, 'Look-off rest must still expose physical overlap');
  aim.reset([-0.48, 1.17, -0.23]);
  assert.equal(aim.clearanceResolved, true);
  assert.ok(aim.headClearance > 0);
  aim.reset();
  assert.equal(aim.clearanceResolved, true);
  assert.equal(aim.headClearance, Infinity);
});

test('actual cowling support preserves Home gaze and limits neck tilt before crossing the chest plane', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  const points = new Float64Array(cowlingHull),
    aim = new HeadAim(f.head, optical, 1.3, {
      min: [-0.194, -0.039, -0.236],
      max: [0.194, 0.307, 0.134],
      targetRadius: 0.10465342044830322,
      margin: 0.003,
      chestFloor: -0.032,
      chestPoints: points,
    });
  points.fill(0);
  aim.update([-0.48, 1.17, -0.23]);
  assert.equal(aim.limited, false);
  assert.ok(aim.rayError < 2e-5);
  for (const target of [
    [-0.36, 0.66, -0.02],
    [-0.24, 1.69, 0],
  ]) {
    aim.update(target);
    assert.equal(aim.limited, true);
    assert.equal(aim.clearanceResolved, true);
    const m = f.head.matrix;
    for (let i = 0; i < cowlingHull.length; i += 3) {
      const y = m[1] * cowlingHull[i] + m[5] * cowlingHull[i + 1] + m[9] * cowlingHull[i + 2] + m[13];
      assert.ok(y >= 1.118, `Actual cowling crosses the chest plane at ${y}`);
    }
  }
});

test('posed-joint guard searches without changing the scene, invalidates cached gaze, and checks look-off', async (t) => {
  const f = await fixture();
  t.after(() => f.engine.dispose());
  let maximum = 0.5,
    calls = 0;
  const observed = [];
  const guard = {
    min: [-0.194, -0.039, -0.236],
    max: [0.194, 0.307, 0.134],
    targetRadius: 0.10465342044830322,
    margin: 0.003,
    rotationClearance(rotation, out) {
      calls++;
      observed.push(localQuaternion(f.head));
      out[0] = maximum - 2 * Math.acos(Math.min(1, Math.abs(rotation[3])));
    },
  };
  const aim = new HeadAim(f.head, optical, 1.3, guard),
    target = [-0.48, 1.17, -0.23];
  const firstPose = localQuaternion(f.head);
  aim.update(target);
  assert.ok(observed.length > 2);
  for (const pose of observed.slice(0, -1))
    assert.deepEqual(pose, firstPose, 'Candidate checks must not write the head');
  assert.deepEqual(observed.at(-1), localQuaternion(f.head), 'Final diagnostic checks the presented pose');
  assert.equal(aim.clearanceResolved, true);
  assert.ok(aim.angle <= maximum && aim.angle > 0.45);
  assert.equal(aim.limited, true);
  const previousCalls = calls;
  maximum = 0.25;
  aim.update(target);
  assert.ok(calls > previousCalls && aim.angle <= maximum, 'Changed posed joints must invalidate the gaze-only cache');
  const held = localQuaternion(f.head);
  maximum = -0.01;
  assert.equal(aim.checkClearance(target), false);
  assert.deepEqual(localQuaternion(f.head), held);
  aim.reset(target);
  assert.equal(aim.clearanceResolved, false, 'Look-off rest retains the joint guard');
  guard.rotationClearance = () => {};
  const invalid = new HeadAim(f.head, optical, 1.3, guard);
  assert.throws(() => invalid.update(target), /finite distance/);
});
