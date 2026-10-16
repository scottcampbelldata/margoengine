import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { gripPosition, localPoint, solveArm, worldPosition } from '../examples/skinning-ik/rig-ik.ts';

mkdirSync(resolve('test-results'), { recursive: true });
const temporary = mkdtempSync(resolve('test-results/ik-collision-cache-')),
  modulePath = join(temporary, 'body.mjs');
const bundle = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: {
    write: false,
    target: 'es2022',
    minify: false,
    lib: { entry: resolve('examples/skinning-ik/body-ik.ts'), formats: ['es'] },
    rollupOptions: { external: (id) => id.startsWith('@margoengine/') },
  },
});
writeFileSync(modulePath, bundle[0].output[0].code);
const { BodyIK } = await import(pathToFileURL(modulePath).href);
unlinkSync(modulePath);
rmdirSync(temporary);

const bytes = readFileSync(new URL('../examples/assets/skinning-ik.glb', import.meta.url));
const doc = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
async function robot(extraClearance, checkHead = false) {
  const store = await TransformStore.create(doc.nodes.length + 1),
    engine = new Engine({ width: 256, height: 256, clientWidth: 256, clientHeight: 256 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    frame = engine.createMesh();
  const nodes = doc.nodes.map((node) =>
    engine
      .createMesh()
      .setParent(frame)
      .setPosition(node.translation ?? [0, 0, 0])
      .setQuaternion(node.rotation ?? [0, 0, 0, 1])
      .setScale(node.scale ?? [1, 1, 1]),
  );
  doc.nodes.forEach((node, i) => node.children?.forEach((child) => nodes[child].setParent(nodes[i])));
  store.tick(false);
  const named = (name) => nodes[doc.nodes.findIndex((node) => node.name === name)],
    shoulder = named('UpperArm'),
    elbow = named('Forearm'),
    wrist = named('Hand'),
    head = named('Head'),
    start = worldPosition(wrist),
    localGrip = localPoint(wrist, [start[0], start[1] + 0.13, start[2]]),
    solver = new BodyIK({
      frame,
      shoulder,
      elbow,
      wrist,
      localGrip,
      head: checkHead ? head : undefined,
      extraClearance,
    });
  return { engine, store, frame, shoulder, elbow, wrist, head, localGrip, solver };
}
function querySnapshot(solver) {
  solver.poseQuery();
  return { collision: solver.poseCollision, distance: solver.poseDistance[0] };
}

test('caller-owned result storage stays separate from held poses, target history and fresh default results', async () => {
  const rig = await robot();
  try {
    const out = { safe: false, limited: false, blocked: false, orb: [0, 0, 0], collision: null },
      orbBuffer = out.orb;
    assert.strictEqual(rig.solver.solve([-0.4, 1.2, -0.2], 1 / 60, out), out);
    assert.strictEqual(out.orb, orbBuffer);
    const checked = structuredClone(out);
    out.orb[0] = 1000;
    out.safe = false;
    assert.deepEqual(
      rig.solver.solve([-0.4, 1.2, -0.2], 1 / 60, out),
      checked,
      'caller writes must not mutate the private checked-result cache',
    );
    const retained = rig.solver.solve([-0.45, 1.1, -0.25]),
      snapshot = structuredClone(retained);
    for (let i = 0; i < 120; i++) rig.solver.solve([-0.3 + 0.2 * Math.sin(i * 0.04), 1.2, -0.2], 1 / 60, out);
    assert.deepEqual(retained, snapshot, 'default returned result and orb have the original fresh lifetime');
    assert.strictEqual(rig.solver.enforce(out), out);
    assert.strictEqual(out.orb, orbBuffer);
  } finally {
    rig.engine.dispose();
  }
});

test('unchanged collision and enforcement queries reuse the complete clearance result', async (t) => {
  const rig = await robot();
  try {
    const first = querySnapshot(rig.solver),
      buffer = rig.solver.poseDistance,
      compute = t.mock.method(rig.solver, 'computePoseQuery');
    assert.equal(first.collision, null);
    assert.ok(first.distance > 0);
    for (let i = 0; i < 300; i++) {
      assert.equal(rig.solver.collision(), null);
      assert.equal(rig.solver.enforce().safe, true);
      assert.deepEqual(querySnapshot(rig.solver), first, 'distance and contact must come from the same checked pose');
      assert.strictEqual(rig.solver.poseDistance, buffer);
    }
    assert.equal(compute.mock.callCount(), 0, 'held and reflection poses must not rebuild GJK geometry');
  } finally {
    rig.engine.dispose();
  }
});

test('external joint and ancestor changes invalidate clearance using current matrix values', async (t) => {
  const rig = await robot();
  try {
    const uncached = rig.solver.computePoseQuery,
      compute = t.mock.method(rig.solver, 'computePoseQuery');
    const changes = [
      () => rig.shoulder.setRotation([0.1, -0.2, 0.3]),
      () => rig.elbow.setRotation([-0.2, 0.15, -0.1]),
      () => rig.wrist.setRotation([0.25, -0.15, 0.2]),
      () => rig.wrist.position.set(rig.wrist.position.x + 0.02, rig.wrist.position.y, rig.wrist.position.z),
      () => rig.elbow.setScale([1.05, 1.05, 1.05]),
      () => rig.frame.setPosition([3, -0.5, 2]).setRotation([0.25, -0.6, 0.15]).setScale([1.7, 1.7, 1.7]),
      () => rig.frame.setParent(rig.engine.createMesh().setPosition([-2, 1, 0.5]).setRotation([0.1, 0.2, 0.3])),
      () => rig.shoulder.setParent(rig.frame),
    ];
    for (const change of changes) {
      const before = compute.mock.callCount();
      change();
      const result = querySnapshot(rig.solver);
      assert.equal(compute.mock.callCount(), before + 1);
      uncached.call(rig.solver);
      assert.deepEqual(
        result,
        { collision: rig.solver.computedCollision, distance: rig.solver.computedDistance[0] },
        'cache must agree with the full posed-surface oracle',
      );
      assert.deepEqual(querySnapshot(rig.solver), result);
      assert.equal(compute.mock.callCount(), before + 1);
    }
  } finally {
    rig.engine.dispose();
  }
});

test('external unsafe animation is rejected and restored clearance is checked before reuse', async (t) => {
  const rig = await robot();
  try {
    const safe = gripPosition(rig.wrist, rig.localGrip),
      compute = t.mock.method(rig.solver, 'computePoseQuery');
    solveArm({ ...rig, target: [0, 1, 0], pole: [0, 1, 1] });
    assert.ok(rig.solver.collision());
    assert.equal(compute.mock.callCount(), 1);
    const result = rig.solver.enforce();
    assert.equal(result.safe, true);
    assert.equal(result.blocked, true);
    assert.ok(Math.hypot(...result.orb.map((value, i) => value - safe[i])) < 2e-6);
    assert.equal(compute.mock.callCount(), 2, 'restoring a safe pose must replace the unsafe cached query');
    assert.equal(rig.solver.enforce().safe, true);
    assert.equal(rig.solver.collision(), null);
    assert.equal(compute.mock.callCount(), 2);
  } finally {
    rig.engine.dispose();
  }
});

test('an unchanged torso-only target cannot reuse success after a joint translation enters the body', async () => {
  const rig = await robot();
  try {
    const target = gripPosition(rig.wrist, rig.localGrip);
    assert.equal(rig.solver.solve(target, 1 / 60).safe, true);
    rig.wrist.setPosition(localPoint(rig.elbow, [0, 1, 0]));
    rig.store.tick(false);
    assert.equal(rig.solver.collision(), 'hand / body', 'the translated hand must exercise actual torso contact');
    const result = rig.solver.solve(target, 1 / 60);
    assert.ok(
      !result.safe || rig.solver.collision() === null,
      'cached success must recheck the currently presented pose',
    );
  } finally {
    rig.engine.dispose();
  }
});

test('transform store growth does not retain detached matrix views', async (t) => {
  const rig = await robot();
  try {
    const matrix = rig.wrist.matrix,
      first = querySnapshot(rig.solver),
      compute = t.mock.method(rig.solver, 'computePoseQuery');
    rig.engine.createMesh();
    assert.notStrictEqual(rig.wrist.matrix, matrix, 'fixture must grow the full transform store');
    assert.deepEqual(querySnapshot(rig.solver), first, 'equal matrix values remain reusable after growth');
    assert.equal(compute.mock.callCount(), 0);
    rig.wrist.position.x += 0.01;
    rig.solver.poseQuery();
    assert.equal(compute.mock.callCount(), 1, 'the replacement matrix view must participate in invalidation');
  } finally {
    rig.engine.dispose();
  }
});

test('failed queries cannot publish a cache entry and cached poses still validate disposed meshes', async (t) => {
  const rig = await robot();
  try {
    const original = rig.solver.computePoseQuery;
    let attempts = 0;
    t.mock.method(rig.solver, 'computePoseQuery', function () {
      if (++attempts === 1) throw new Error('incomplete collision query');
      return original.call(this);
    });
    rig.wrist.position.x += 0.01;
    assert.throws(() => rig.solver.collision(), /incomplete collision query/);
    rig.solver.collision();
    assert.equal(attempts, 2, 'the same changed pose must be recomputed after a failed query');
    rig.solver.collision();
    assert.equal(attempts, 2);
    rig.wrist.dispose();
    assert.throws(() => rig.solver.collision(), /Mesh disposed/);
  } finally {
    rig.engine.dispose();
  }
});

test('reused posed supports agree with independently transformed hull vertices', async () => {
  const rig = await robot();
  try {
    rig.frame.setPosition([2, -0.5, 3]).setRotation([0.2, -0.6, 0.15]).setScale([1.7, 1.7, 1.7]);
    rig.shoulder.setRotation([0.15, -0.25, 0.35]);
    rig.elbow.setRotation([-0.2, 0.1, 0.15]);
    rig.wrist.setRotation([0.25, 0.1, -0.2]);
    rig.solver.poseQuery();
    const inverse = new Float64Array(16);
    assert.ok(invertMatrixStable(rig.frame.matrix, inverse));
    const transform = (m, p) => [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      ],
      dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const hulls = [
      ...rig.solver.upperPieces.map((points) => ({ joint: rig.shoulder, points })),
      { joint: rig.elbow, points: rig.solver.forearmPoints },
      { joint: rig.wrist, points: rig.solver.handCorners },
    ];
    const directions = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (let i = 1; i <= 96; i++) directions.push([Math.sin(i * 1.7), Math.cos(i * 2.1), Math.sin(i * 0.37)]);
    for (let index = 0; index < hulls.length; index++) {
      const { joint, points } = hulls[index],
        support = rig.solver.poseShapes[index][1],
        output = support(directions[0]);
      // Transform vertices through world space separately from the optimized
      // support's combined matrix, then independently maximize each projection.
      const vertices = points.map((point) => transform(inverse, transform(joint.matrix, point)));
      for (const direction of directions) {
        const actual = support(direction);
        assert.strictEqual(actual, output, 'each support owns one reusable output');
        const expected = Math.max(...vertices.map((point) => dot(point, direction))) + 0.003 * Math.hypot(...direction);
        assert.ok(
          Math.abs(dot(actual, direction) - expected) < 1e-10,
          'posed support must preserve the full hull and padding',
        );
      }
    }
    const sphere = rig.solver.poseShapes[6][1],
      center = localPoint(rig.frame, gripPosition(rig.wrist, rig.localGrip));
    for (const direction of directions) {
      const expected = dot(center, direction) + (0.10465342044830322 + 0.003) * Math.hypot(...direction);
      assert.ok(Math.abs(dot(sphere(direction), direction) - expected) < 1e-10);
    }
  } finally {
    rig.engine.dispose();
  }
});

test('grip support scratch stays private across queries and independent rigs', async () => {
  const first = await robot(),
    second = await robot();
  try {
    const center = [-0.3, 0.9, -0.3],
      other = [0.2, 1.2, 0.3],
      query = new Float64Array(5),
      next = new Float64Array(5);
    first.solver.gripQuery(center, query);
    const retained = [...query],
      sphereOutput = first.solver.gripSphere([1, 0, 0]),
      handOutput = first.solver.gripHand([1, 0, 0]),
      dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.notStrictEqual(sphereOutput, handOutput);
    for (const direction of [
      [1, 2, 3],
      [-3, 2, -1],
      [0, -1, 0],
    ]) {
      assert.strictEqual(first.solver.gripSphere(direction), sphereOutput);
      assert.strictEqual(first.solver.gripHand(direction), handOutput);
      const length = Math.hypot(...direction),
        sphereExpected = dot(center, direction) + (0.10465342044830322 + 0.003) * length,
        handExpected =
          dot(center, direction) + Math.max(...first.solver.gripCorners.map((p) => dot(p, direction))) + 0.003 * length;
      assert.ok(Math.abs(dot(sphereOutput, direction) - sphereExpected) < 1e-12);
      assert.ok(Math.abs(dot(handOutput, direction) - handExpected) < 1e-12);
    }
    second.solver.gripQuery(other, next);
    first.solver.gripQuery(center, next);
    assert.deepEqual([...next], retained, 'another rig must not overwrite private scratch');
    first.solver.gripQuery(other, next);
    assert.deepEqual([...query], retained, 'retained GJK normals must not alias support outputs');
  } finally {
    first.engine.dispose();
    second.engine.dispose();
  }
});

test('extra head clearance runs outside the torso cache and cannot bless an invalid held pose', async (t) => {
  let blocked = false,
    calls = 0;
  const rig = await robot((_orb, out) => {
    calls++;
    out[0] = blocked ? -0.01 : 0.03;
  });
  try {
    const compute = t.mock.method(rig.solver, 'computePoseQuery');
    assert.equal(rig.solver.collision(), null);
    blocked = true;
    assert.equal(rig.solver.collision(), 'orb / head');
    assert.equal(rig.solver.enforce().safe, false, 'a historically safe pose may no longer clear the head');
    assert.equal(compute.mock.callCount(), 0, 'head/look changes must not rely on the torso matrix cache');
    const home = gripPosition(rig.wrist, rig.localGrip);
    assert.equal(rig.solver.solve(home, 1 / 60).safe, false);
    const blockedCalls = calls;
    blocked = false;
    assert.equal(rig.solver.solve(home, 1 / 60).safe, true);
    assert.ok(calls > blockedCalls, 'cached target and pose must not skip the external head oracle');
    assert.equal(rig.solver.collision(), null);
  } finally {
    rig.engine.dispose();
  }
});

test('extra clearance joins candidate search and preserves a safe fallback rather than clipping the head', async () => {
  const rig = await robot((orb, out) => {
    out[0] = -orb[0] - 0.3;
  });
  try {
    const requested = [-0.1, 1.3, -0.3],
      result = rig.solver.solve(requested, 1 / 60);
    assert.equal(result.safe, true);
    assert.equal(result.limited, true);
    assert.equal(result.blocked, true);
    assert.equal(result.collision, 'orb / head');
    assert.ok(result.orb[0] <= -0.3, 'the actual held orb must satisfy the added clearance');
    assert.equal(rig.solver.collision(), null);
  } finally {
    rig.engine.dispose();
  }
});

test('extra clearance rejects missing and nonfinite outputs instead of reusing a previous positive result', async () => {
  const rig = await robot((_orb, out) => {
    out[0] = 1;
  });
  try {
    for (const extra of [
      () => {},
      (_orb, out) => {
        out[0] = NaN;
      },
      (_orb, out) => {
        out[0] = Infinity;
      },
    ]) {
      rig.solver.options.extraClearance = extra;
      assert.throws(() => rig.solver.collision(), /extra clearance must be finite/);
    }
    rig.solver.options.extraClearance = (_orb, out) => {
      out[0] = 1;
    };
    assert.equal(rig.solver.collision(), null);
  } finally {
    rig.engine.dispose();
  }
});

test('posed Head hull invalidates independently of the torso cache and cached IK target', async (t) => {
  const rig = await robot(undefined, true);
  try {
    const target = gripPosition(rig.wrist, rig.localGrip);
    assert.equal(rig.solver.solve(target).safe, true);
    const torsoCompute = t.mock.method(rig.solver, 'computePoseQuery'),
      headQuery = t.mock.method(rig.solver.headKernel, 'query'),
      rest = [rig.head.position.x, rig.head.position.y, rig.head.position.z];
    assert.equal(rig.solver.collision(), null);
    assert.equal(headQuery.mock.callCount(), 0);
    rig.head.setPosition([rest[0] - 0.4, rest[1] - 0.12, rest[2] - 0.1]);
    assert.match(rig.solver.collision(), /\/ head$/);
    assert.equal(torsoCompute.mock.callCount(), 0, 'head motion alone must not recompute torso geometry');
    const checked = headQuery.mock.callCount();
    assert.ok(checked > 0);
    assert.match(rig.solver.collision(), /\/ head$/);
    assert.equal(headQuery.mock.callCount(), checked, 'the exact presented head pose may be cached');
    const result = rig.solver.solve(target);
    assert.ok(result.limited || !result.safe, 'the old cached success must not bypass the moved head');
    rig.head.setPosition(rest);
    assert.equal(rig.solver.enforce().safe, true);
    assert.equal(rig.solver.collision(), null);
  } finally {
    rig.engine.dispose();
  }
});
