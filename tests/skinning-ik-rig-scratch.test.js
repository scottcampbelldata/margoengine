import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { solveArm, rotateWorld, worldRotation, worldPosition } from '../examples/skinning-ik/rig-ik.ts';
import { RigScratch } from '../examples/skinning-ik/rig-scratch.ts';

async function rig() {
  const store = await TransformStore.create(8),
    engine = new Engine({ width: 1, height: 1, clientWidth: 1, clientHeight: 1 }, store, {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    }),
    root = engine.createMesh(),
    shoulder = engine.createMesh().setParent(root).setPosition([0, 0.2, 0]),
    elbow = engine.createMesh().setParent(shoulder).setPosition([0.7, 0, 0]),
    wrist = engine.createMesh().setParent(elbow).setPosition([0.43, 0, 0]);
  store.tick(false);
  return { engine, store, root, shoulder, elbow, wrist };
}
function snapshot(r) {
  const t = r.store.transforms;
  return [r.root, r.shoulder, r.elbow, r.wrist].map((m) => [
    t.qx[m.id],
    t.qy[m.id],
    t.qz[m.id],
    t.qw[m.id],
    ...m.euler,
    ...m.matrix,
    t.x[m.id],
    t.y[m.id],
    t.z[m.id],
    t.sx[m.id],
    t.sy[m.id],
    t.sz[m.id],
  ]);
}
test('per-controller scratch matches analytic rig poses and Euler state exactly through transformed and singular requests', async () => {
  const a = await rig(),
    b = await rig(),
    scratch = new RigScratch();
  try {
    for (let i = 0; i < 240; i++) {
      if (i % 24 === 0)
        for (const r of [a, b]) {
          r.root
            .setPosition([1.2, -0.5, 2])
            .setRotation([i * 0.003, -0.4, 0.3])
            .setScale([1.7, 1.7, 1.7]);
          r.shoulder.setRotation([-0.2, 0.3, -0.4]).setScale([0.9, 0.9, 0.9]);
          r.elbow.setRotation([0.15, -0.25, 0.3]);
          r.wrist.setRotation([0.1, 0.2, -0.1]);
          r.store.tick(false);
        }
      const root = worldPosition(a.shoulder),
        target =
          i % 17 === 0
            ? [...root]
            : root.map(
                (v, axis) => v + [1.8 * Math.sin(i * 0.17), 1.6 * Math.cos(i * 0.13), 1.5 * Math.sin(i * 0.07)][axis],
              ),
        pole = root.map((v, axis) => v + [-0.7, 1.1, 0.8][axis]);
      solveArm({ ...a, target, pole });
      scratch.solve(b.shoulder, b.elbow, b.wrist, target, pole);
      assert.deepEqual(snapshot(b), snapshot(a), `pose ${i}`);
    }
    const out = [0, 0, 0, 0];
    scratch.worldRotation(b.wrist, out);
    assert.deepEqual(out, worldRotation(a.wrist));
  } finally {
    a.engine.dispose();
    b.engine.dispose();
  }
});
test('scratch quaternion operations preserve aliasing, guard-before-mutation and refreshed transform-store views', async () => {
  const a = await rig(),
    b = await rig(),
    scratch = new RigScratch();
  try {
    const q = [0.2, -0.1, 0.4, 0.7];
    a.wrist.setQuaternion(q);
    scratch.setQuaternion(b.wrist, q);
    const delta = [0.3, -0.2, 0.1, 0.8];
    rotateWorld(a.wrist, delta);
    scratch.rotateWorld(b.wrist, delta);
    a.store.tick(false);
    b.store.tick(false);
    assert.deepEqual(snapshot(b), snapshot(a));
    const product = [...q];
    scratch.multiply(product, delta, product);
    const separate = [0, 0, 0, 0];
    scratch.multiply(q, delta, separate);
    assert.deepEqual(product, separate);
    for (let i = 0; i < 40; i++) {
      a.engine.createMesh();
      b.engine.createMesh();
    }
    a.wrist.setQuaternion(q);
    scratch.setQuaternion(b.wrist, q);
    a.store.tick(false);
    b.store.tick(false);
    assert.deepEqual(snapshot(b), snapshot(a));
    for (const invalid of [
      [0, 0, 0, 0],
      [NaN, 0, 0, 1],
      [Infinity, 0, 0, 1],
      [1e40, 0, 0, 1],
      [0, 0, 1],
    ]) {
      const before = snapshot(b);
      assert.throws(() => scratch.setQuaternion(b.wrist, invalid));
      assert.deepEqual(snapshot(b), before);
    }
    b.root.setScale([1, 1.1, 1]);
    const before = snapshot(b);
    assert.throws(() => scratch.solve(b.shoulder, b.elbow, b.wrist, [1, 1, 1], [0, 2, 0]), /uniform/);
    assert.deepEqual(snapshot(b), before);
  } finally {
    a.engine.dispose();
    b.engine.dispose();
  }
});
test('independent controllers keep private rig scratch while interleaving solves', async () => {
  const a = await rig(),
    b = await rig(),
    aa = await rig(),
    bb = await rig(),
    sa = new RigScratch(),
    sb = new RigScratch();
  try {
    for (let i = 0; i < 80; i++) {
      const targetA = [Math.sin(i * 0.1), 0.5, 0.4],
        targetB = [-0.7, Math.cos(i * 0.13), -0.2];
      sa.solve(a.shoulder, a.elbow, a.wrist, targetA, [0, 2, 0]);
      sb.solve(b.shoulder, b.elbow, b.wrist, targetB, [0, -1, 2]);
      solveArm({ ...aa, target: targetA, pole: [0, 2, 0] });
      solveArm({ ...bb, target: targetB, pole: [0, -1, 2] });
      assert.deepEqual(snapshot(a), snapshot(aa));
      assert.deepEqual(snapshot(b), snapshot(bb));
    }
  } finally {
    for (const r of [a, b, aa, bb]) r.engine.dispose();
  }
});
